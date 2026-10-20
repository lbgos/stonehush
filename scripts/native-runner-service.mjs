import { constants } from "node:fs";
import { chmod, cp, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { enrollRunner } from "./runner-enrollment.mjs";

export class ServiceError extends Error {}

export const unitName = "stonehush-runner.service";
export function locations(home) {
  return {
    home,
    runtime: path.join(home, ".local/share/stonehush-runner"),
    private: path.join(home, ".config/stonehush-runner"),
    state: path.join(home, ".local/state/stonehush-runner"),
    unit: path.join(home, ".config/systemd/user", unitName),
  };
}

export const serviceUnit = `[Unit]
Description=Stonehush native runner

[Service]
Type=notify
NotifyAccess=all
TimeoutStartSec=60
ExecStart=%h/.local/share/stonehush-runner/node %h/.local/share/stonehush-runner/scripts/native-runner-service.mjs run
WorkingDirectory=%h/.local/state/stonehush-runner/work
UMask=0077
NoNewPrivileges=yes
RestrictSUIDSGID=yes
KillMode=control-group
TimeoutStopSec=20
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;

// Never repair ownership, follow directory links or chmod existing paths.
// The installer owns only its named files in this user's private home.
export async function checkDirectory(directory, { privateMode = false, create = false } = {}) {
  if (!path.isAbsolute(directory)) throw new ServiceError("Absolute directory required.");
  for (const component of directory.split(path.sep).filter(Boolean).reduce((all, part) => [...all, path.join(all.at(-1) ?? path.sep, part)], [])) {
    let info;
    try { info = await lstat(component); } catch (error) {
      if (error.code !== "ENOENT" || !create) throw error;
      await mkdir(component, { mode: 0o700 });
      info = await lstat(component);
    }
    if (!info.isDirectory() || (info.uid !== process.getuid() && info.uid !== 0)) throw new ServiceError("Unsafe directory ownership or type.");
    if ((info.mode & 0o022) !== 0 && !(info.uid === 0 && (info.mode & 0o1000))) throw new ServiceError("Writable directory ancestor refused.");
  }
  if (privateMode) {
    const info = await lstat(directory);
    if (info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) throw new ServiceError("Private directory must be owned by this user with mode 0700.");
  }
}

export async function privateFile(filename, { value } = {}) {
  await checkDirectory(path.dirname(filename), { privateMode: true });
  const writing = value !== undefined;
  const handle = await open(filename, constants.O_NOFOLLOW | (writing ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL : constants.O_RDONLY), 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) throw new ServiceError("Private file ownership, mode or links refused.");
    if (writing) { await handle.writeFile(value); await handle.sync(); return; }
    if (info.size > 16384) throw new ServiceError("Private file exceeds limit.");
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}

export async function inventory(directory) {
  const result = [];
  const root = await realpath(directory);
  async function walk(relative = "") {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (name === "artifact.json") continue;
      const filename = path.join(root, name);
      const info = await lstat(filename);
      if (entry.isDirectory()) await walk(name);
      else if (entry.isSymbolicLink()) {
        const target = await readlink(filename);
        if (path.isAbsolute(target) || !(await realpath(filename)).startsWith(`${root}/`)) throw new ServiceError("Artifact link escapes package.");
        result.push({ path: name, link: target });
      } else if (entry.isFile() && info.nlink === 1) {
        result.push({ path: name, sha256: createHash("sha256").update(await readFile(filename)).digest("hex"), executable: Boolean(info.mode & 0o111) });
      } else throw new ServiceError("Artifact special file or hardlink refused.");
    }
  }
  await walk();
  return result.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

export async function verifyArtifact(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory()) throw new ServiceError("Artifact directory links refused.");
  const manifestInfo = await lstat(path.join(directory, "artifact.json"));
  if (!manifestInfo.isFile() || manifestInfo.nlink !== 1) throw new ServiceError("Artifact manifest links refused.");
  const manifest = JSON.parse(await readFile(path.join(directory, "artifact.json"), "utf8"));
  if (manifest.kind !== "native-runner" || manifest.node !== "v24.18.0" || manifest.pnpm !== "10.24.0" || !/^[a-f0-9]{40}$/.test(manifest.revision) || !/^[a-f0-9]{40}$/.test(manifest.tree)) throw new ServiceError("Artifact identity invalid.");
  if (JSON.stringify(await inventory(directory)) !== JSON.stringify(manifest.inventory)) throw new ServiceError("Artifact content differs from its manifest.");
  for (const required of ["node", "apps/runner/dist/runner.js", "scripts/native-runner-service.mjs", "scripts/runner-enrollment.mjs"]) {
    if (!manifest.inventory.some((item) => item.path === required && typeof item.sha256 === "string")) throw new ServiceError("Required runtime file absent.");
  }
  return manifest;
}

function validateConfiguration(config) {
  const url = new URL(config.apiBaseUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.origin !== config.apiBaseUrl) throw new ServiceError("API must be an IPv4 loopback HTTP origin.");
  if (typeof config.nmapExecutable !== "string" || !path.isAbsolute(config.nmapExecutable) || /[\x00-\x1f]/.test(config.nmapExecutable)) throw new ServiceError("Absolute Nmap executable required.");
  if (typeof config.runnerName !== "string" || !/^[A-Za-z0-9 ._-]{1,120}$/.test(config.runnerName) || config.runnerName !== config.runnerName.trim() || !/^sha256:[a-f0-9]{64}$/.test(config.fingerprint)) throw new ServiceError("Runner name or fingerprint invalid.");
  return config;
}

async function readConfiguration(paths) {
  return validateConfiguration(JSON.parse(await privateFile(path.join(paths.private, "config.json"))));
}

async function credentials(paths) {
  const value = JSON.parse(await privateFile(path.join(paths.private, "credential.json")));
  if (!/^[A-Za-z0-9_-]{43}$/.test(value.runnerSecret) || typeof value.runnerId !== "string" || !/^[A-Za-z0-9_-]{1,255}$/.test(value.runnerId) || value.runnerRevision !== 1) throw new ServiceError("Invalid saved credential. Explicit operator recovery required.");
  return value;
}

async function checkUnit(paths) {
  await checkDirectory(path.dirname(paths.unit));
  const info = await lstat(paths.unit);
  if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || await readFile(paths.unit, "utf8") !== serviceUnit) throw new ServiceError("Service unit differs; operation refused.");
}

export async function install(source, paths, config) {
  await checkDirectory(paths.home, { privateMode: true });
  validateConfiguration({ ...config, fingerprint: `sha256:${"0".repeat(64)}` });
  const manifest = await verifyArtifact(source);
  await checkDirectory(path.dirname(paths.runtime), { create: true });
  let existing = false;
  try { await lstat(paths.runtime); existing = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing) {
    await checkDirectory(paths.runtime, { privateMode: true });
    const previous = await verifyArtifact(paths.runtime);
    if (JSON.stringify(previous) !== JSON.stringify(manifest)) throw new ServiceError("Another runtime is installed. Stop and remove it explicitly before installing a different artifact.");
    const previousConfig = await readConfiguration(paths);
    for (const key of ["apiBaseUrl", "nmapExecutable", "runnerName"]) if (previousConfig[key] !== config[key]) throw new ServiceError("Installed configuration differs; refusing to overwrite.");
    await checkUnit(paths);
    return;
  }
  await checkDirectory(paths.private, { privateMode: true, create: true });
  await checkDirectory(paths.state, { privateMode: true, create: true });
  await checkDirectory(path.join(paths.state, "work"), { privateMode: true, create: true });
  await checkDirectory(path.dirname(paths.unit), { create: true });
  // Refuse any preexisting unit before copying or creating an identity.
  try { await lstat(paths.unit); throw new ServiceError("Existing service unit refused."); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const stage = `${paths.runtime}.install-${randomUUID()}`;
  try {
    await cp(source, stage, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
    await chmod(stage, 0o700);
    await verifyArtifact(stage);
    const configFile = path.join(paths.private, "config.json");
    try {
      const previous = await readConfiguration(paths);
      for (const key of ["apiBaseUrl", "nmapExecutable", "runnerName"]) if (previous[key] !== config[key]) throw new ServiceError("Preserved configuration differs; refusing to overwrite.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await privateFile(configFile, { value: `${JSON.stringify({ ...config, fingerprint: `sha256:${createHash("sha256").update(randomUUID()).digest("hex")}` })}\n` });
      await readConfiguration(paths);
    }
    await rename(stage, paths.runtime);
    const unit = await open(paths.unit, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await unit.writeFile(serviceUnit); await unit.sync(); } finally { await unit.close(); }
  } finally { await rm(stage, { recursive: true, force: true }); }
}

function systemctl(...args) {
  const result = spawnSync("/usr/bin/systemctl", ["--user", ...args], { stdio: "pipe", encoding: "utf8", shell: false, timeout: 30000 });
  if (result.error || result.status !== 0) throw new ServiceError("User service command failed. Inspect systemctl --user status stonehush-runner.service.");
  return result.stdout.trim();
}

export async function main(argv = process.argv.slice(2)) {
  if (process.platform !== "linux" || process.arch !== "x64" || process.getuid() === 0) throw new ServiceError("Use an existing unprivileged Linux x86-64 account, never root.");
  if (process.version !== "v24.18.0") throw new ServiceError("Use the packaged Node 24.18.0 executable.");
  process.umask(0o077);
  const paths = locations(homedir());
  await checkDirectory(paths.home, { privateMode: true });
  const [command, ...args] = argv;
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  if (command === "install" && args.length === 3) {
    await install(source, paths, { apiBaseUrl: args[0], nmapExecutable: args[1], runnerName: args[2] });
    console.log("Installed. Inspect identity, explicitly enroll, then enable the user service.");
    return;
  }
  if (!["identity", "enroll", "run", "remove"].includes(command) || (command === "enroll" ? args.length !== 1 || args[0] !== "--owner-confirmed" : args.length !== 0)) throw new ServiceError("Commands: install <loopback-origin> <absolute-nmap> <name>, identity, enroll --owner-confirmed, run, remove.");
  await checkDirectory(paths.private, { privateMode: true });
  const config = await readConfiguration(paths);
  if (command === "identity") {
    console.log(JSON.stringify({ name: config.runnerName, fingerprint: config.fingerprint, apiBaseUrl: config.apiBaseUrl, artifact: await verifyArtifact(paths.runtime) }, (key, value) => key === "inventory" ? undefined : value));
    return;
  }
  if (command === "enroll") {
    // Reserve before requesting a challenge. Any uncertainty remains a visible
    // lock requiring operator recovery, never an automatic second enrollment.
    try { await lstat(path.join(paths.private, "credential.json")); throw new ServiceError("Credential already exists; enrollment refused."); } catch (error) { if (error.code !== "ENOENT") throw error; }
    await privateFile(path.join(paths.private, "enrollment-attempt.json"), { value: "{\"status\":\"pending\"}\n" });
    try {
      const enrolled = await enrollRunner({ ...config, fingerprint: config.fingerprint, stop: { stopSignal: AbortSignal.timeout(30000) } });
      await privateFile(path.join(paths.private, "credential.json"), { value: `${JSON.stringify(enrolled)}\n` });
      console.log(`Enrolled runner ${enrolled.runnerId}, revision ${enrolled.runnerRevision}. Credential saved privately.`);
    } catch {
      throw new ServiceError("Enrollment incomplete. Preserve enrollment-attempt.json and inspect the API enrollment state. Explicitly recover only the matching identity; do not retry blindly.");
    }
    return;
  }
  if (command === "remove") {
    await checkUnit(paths);
    await checkDirectory(paths.runtime, { privateMode: true });
    await verifyArtifact(paths.runtime);
    const state = systemctl("show", unitName, "--property=ActiveState", "--value");
    if (!["inactive", "failed"].includes(state)) throw new ServiceError("Stop the service explicitly before removal.");
    systemctl("disable", unitName);
    await unlink(paths.unit);
    systemctl("daemon-reload");
    await rm(paths.runtime, { recursive: true });
    console.log("Service and runtime removed. Credential, configuration, state and work preserved. API identity remains enabled until explicitly revoked.");
    return;
  }
  await verifyArtifact(paths.runtime);
  await checkDirectory(paths.state, { privateMode: true });
  await checkDirectory(path.join(paths.state, "work"), { privateMode: true });
  const saved = await credentials(paths);
  const { createRunnerLoop } = await import("../apps/runner/dist/runner.js");
  let notified = false;
  const loop = createRunnerLoop({ apiBaseUrl: config.apiBaseUrl, runnerId: saved.runnerId, secret: saved.runnerSecret, sessionId: randomUUID(), installationFingerprint: config.fingerprint, dataDir: paths.state, runRoot: path.join(paths.state, "work", "runs"), executable: config.nmapExecutable }, { onHandshake() {
    if (notified) return;
    const result = spawnSync("/usr/bin/systemd-notify", ["--ready"], { stdio: "ignore", shell: false, timeout: 5000 });
    if (result.error || result.status !== 0) { process.exitCode = 1; void loop.stop(); return; }
    notified = true;
    console.log("Runner handshake accepted.");
  } });
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void loop.stop().catch(() => { process.exitCode = 1; });
  });
  loop.start();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) {
    // Raw filesystem/network errors can contain paths or response bodies.
    console.error(error instanceof ServiceError ? error.message : "Runner service operation failed. Inspect private configuration, permissions and service state.");
    process.exitCode = 1;
  }
}
