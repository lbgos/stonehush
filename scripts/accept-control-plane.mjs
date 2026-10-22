import assert from "node:assert/strict";
import { packagingHostProvenance } from "./acceptance-real-tools-assertions.mjs";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, statfs, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { screenshots } from "./acceptance-screenshots.mjs";
import { nativeEntryPreflight, nativeStderrDiagnostics } from "./acceptance-native-diagnostics.mjs";

const [archive, output] = process.argv.slice(2);
assert.ok(path.isAbsolute(archive ?? "") && path.isAbsolute(output ?? ""));
assert.equal(process.env.GITHUB_ACTIONS, "true", "Acceptance operates only on a disposable hosted runner.");
assert.equal(process.getuid() === 0, false);
const root = process.cwd();
const project = `stonehush-acceptance-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
const port = 18787;
const origin = `http://127.0.0.1:${port}`;
const metadata = JSON.parse(await readFile(`${archive}.json`, "utf8"));
assert.equal(metadata.revision, process.env.EXPECTED_REVISION);
assert.match(metadata.imageId, /^sha256:[a-f0-9]{64}$/);
const evidence = { revision: metadata.revision, tree: metadata.tree, imageId: metadata.imageId, archiveSha256: metadata.sha256, testedSource: "PR head, not GitHub merge ref", checks: [] };
const checks = evidence.checks;
const env = { ...process.env, STONEHUSH_IMAGE: metadata.imageId, STONEHUSH_PORT: String(port), COMPOSE_PROJECT_NAME: project };
let runner;
let runnerLog = "";
let runnerExit;
let runnerSpawnFailed = false;
let runnerStdinFailed = false;
let runnerClosed;
let runnerPid;
const nativeStderr = nativeStderrDiagnostics();
const nativeDiagnostics = { launcherEntered: false, stages: [], stderr: nativeStderr.result, failure: null, outcome: null };
evidence.nativeRunner = nativeDiagnostics;
let secret = "";
let container;
let volume;
const temporary = await mkdtemp(path.join(tmpdir(), "stonehush-acceptance-"));
await chmod(temporary, 0o755);
function run(executable, argv, { input, allowed = [0], commandEnv = env, cwd = root } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { env: commandEnv, cwd, stdio: ["pipe", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stderr = "";
    let oversized = false;
    const collect = (target) => (chunk) => {
      if (stdout.length + stderr.length + chunk.length > 4 * 1024 * 1024) { oversized = true; child.kill("SIGKILL"); return; }
      if (target === "out") stdout += chunk; else stderr += chunk;
    };
    child.stdout.on("data", collect("out"));
    child.stderr.on("data", collect("err"));
    child.once("error", reject);
    child.once("close", (code) => {
      if (oversized || !allowed.includes(code)) reject(new Error(`${executable} ${argv[0]} failed, exit=${code}. Captured output is private and omitted.`));
      else resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
const docker = (args, options) => run("docker", args, options);
const compose = (args) => docker(["compose", "-f", "compose.yaml", ...args]);
async function fixture(mode, ...args) {
  return JSON.parse((await docker(["exec", "-i", container, "node", "--input-type=module", "-", mode, ...args], { input: await readFile("scripts/acceptance-image-fixture.mjs") })).stdout || "null");
}
async function cli(command, directory = "/data", expectedCode = 0) {
  const result = await docker(["exec", "-e", `STONEHUSH_DATA_DIR=${directory}`, container, "stonehush", ...command], { allowed: [expectedCode] });
  return JSON.parse(result.stdout);
}
function http(target, { method = "GET", headers = {}, body, localAddress } = {}) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ hostname: "127.0.0.1", port, path: target, method, localAddress, headers: { accept: "application/json", ...(bytes === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(bytes) }), ...headers }, timeout: 5000 }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => { size += chunk.length; if (size > 4 * 1024 * 1024) res.destroy(new Error("HTTP response exceeds acceptance bound.")); else chunks.push(chunk); });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("HTTP timeout")));
    req.end(bytes);
  });
}
async function api(target, body, status = body === undefined ? 200 : 201) {
  const response = await http(target, { method: body === undefined ? "GET" : "POST", body, headers: body === undefined ? {} : { origin, "idempotency-key": randomUUID() } });
  assert.equal(response.status, status, `${target}: ${response.bytes.toString().slice(0, 200)}`);
  return JSON.parse(response.bytes);
}
async function until(callback, label, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await callback()) return;
    await delay(250);
  }
  throw new Error(`Timed out: ${label}`);
}
async function ready() {
  await until(async () => { try { return (await http("/health")).status === 200; } catch { return false; } }, "packaged health");
}
async function stopRunner() {
  if (!runner) return;
  if (runnerExit !== undefined) { runner = undefined; return; }
  if (runnerPid) await run("sudo", ["kill", "-TERM", runnerPid]);
  else runner.kill("SIGTERM");
  await Promise.race([runnerClosed, delay(10000).then(() => { throw new Error("Native runner did not stop."); })]);
  runner = undefined;
}
try {
  Object.assign(evidence, await packagingHostProvenance(output, metadata.revision, metadata.tree));
  const disk = await statfs(temporary);
  assert.ok(disk.bavail * disk.bsize > 1_610_612_736);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  assert.equal(hash.digest("hex"), metadata.sha256);
  assert.equal((await run("git", ["rev-parse", "HEAD"])).stdout.trim(), metadata.revision);
  assert.equal((await run("git", ["rev-parse", `${metadata.revision}^{tree}`])).stdout.trim(), metadata.tree);
  await docker(["image", "rm", "stonehush-acceptance:local"]);
  await docker(["image", "load", "--input", archive]);
  const image = JSON.parse((await docker(["image", "inspect", metadata.imageId])).stdout)[0];
  assert.equal(image.Id, metadata.imageId);
  assert.equal(image.Config.Labels["org.opencontainers.image.revision"], metadata.revision);
  assert.equal(image.Config.Labels["dev.stonehush.source-tree"], metadata.tree);
  checks.push("archive digest, reload and immutable source labels");
  await compose(["up", "-d", "--wait", "--wait-timeout", "90"]);
  container = (await compose(["ps", "-q", "control-plane"])).stdout.trim();
  const inspect = JSON.parse((await docker(["inspect", container])).stdout)[0];
  assert.equal(inspect.Image, metadata.imageId);
  assert.equal(inspect.Config.User, "10001:10001");
  assert.equal(inspect.HostConfig.ReadonlyRootfs, true);
  assert.equal(inspect.HostConfig.NetworkMode, "host");
  assert.deepEqual(inspect.HostConfig.CapDrop, ["ALL"]);
  assert.ok(inspect.HostConfig.SecurityOpt.includes("no-new-privileges:true"));
  assert.equal(inspect.HostConfig.Privileged, false);
  assert.equal(inspect.HostConfig.Memory, 1024 ** 3);
  assert.equal(inspect.HostConfig.NanoCpus, 2_000_000_000);
  const mounts = inspect.Mounts.filter((mount) => mount.Type === "volume");
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].Destination, "/data");
  volume = mounts[0].Name;
  await ready();
  evidence.package = await fixture("package", metadata.revision, metadata.tree);
  checks.push("slim native dependencies, package fingerprints, migrations, UID, read-only root and private data");
  const home = await http("/", { headers: { accept: "text/html" } });
  assert.equal(home.status, 200);
  assert.match(home.headers["content-type"], /^text\/html/);
  const deep = await http("/engagements/synthetic/notes", { headers: { accept: "text/html" } });
  assert.deepEqual(deep.bytes, home.bytes);
  const asset = home.bytes.toString().match(/src="(\/assets\/[^\"]+\.js)"/)?.[1];
  assert.ok(asset);
  assert.equal((await http(asset)).status, 200);
  assert.deepEqual(await api("/api/v1/engagements"), []);
  for (const target of ["/api/v1/missing", "/assets/%2e%2e/package.json", "/%252e%252e/etc/passwd", "/assets/missing.js"]) {
    const response = await http(target, { headers: { accept: "text/html" } });
    assert.equal(response.status, 404, target);
    assert.match(response.headers["content-type"], /^application\/json/);
  }
  for (const options of [{ headers: { host: "attacker.test" } }, { headers: { origin: "https://attacker.test" } }, { headers: { "sec-fetch-site": "cross-site" } }, { localAddress: "127.0.0.2", headers: { "x-forwarded-for": "127.0.0.1" } }]) assert.equal((await http("/", options)).status, 403);
  const listeners = (await run("ss", ["-ltnH"])).stdout.split("\n").filter((line) => line.includes(`:${port} `));
  assert.equal(listeners.length, 1);
  assert.match(listeners[0], new RegExp(`127\\.0\\.0\\.1:${port} `));
  const addresses = (await run("hostname", ["-I"])).stdout.trim().split(/\s+/).filter((address) => /^\d+\./.test(address) && !address.startsWith("127."));
  assert.ok(addresses.length);
  for (const address of addresses) {
    await assert.rejects(fetch(`http://${address}:${port}/health`, { signal: AbortSignal.timeout(2000) }));
  }
  checks.push("same-origin root, deep link, JS, real API, JSON misses, traversal, Host, Origin, peer and loopback-only listener");
  const nativeRoot = path.join(temporary, "native-runtime");
  await run(process.execPath, ["scripts/assemble-control-plane.mjs", nativeRoot, "native-acceptance"]);
  const engagement = await api("/api/v1/engagements", { name: "Compose acceptance", kind: "lab", autoContinueWarnings: false });
  const base = `/api/v1/engagements/${engagement.id}`;
  const fingerprint = `sha256:${"a".repeat(64)}`;
  const challenge = await api("/api/v1/runners/enrollment-challenges", { name: "Synthetic acceptance runner", installationFingerprint: fingerprint });
  const enrollment = await api(`/api/v1/runners/enrollment-challenges/${challenge.challengeId}/confirm`, { ownerConfirmed: true });
  secret = enrollment.secret;
  assert.ok(secret.length >= 22);
  const runnerState = path.join(temporary, "runner");
  await mkdir(runnerState, { mode: 0o700 });
  await run("sudo", ["chown", "10002:10002", runnerState]);
  const unprivileged = ["setpriv", "--reuid=10002", "--regid=10002", "--clear-groups", "--bounding-set=-all", "--no-new-privs"];
  assert.equal((await run("sudo", [...unprivileged, "test", "-r", mounts[0].Source], { allowed: [0, 1] })).code, 1);
  const fake = path.join(temporary, "synthetic-nmap");
  const started = path.join(runnerState, "synthetic-started");
  await writeFile(fake, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nconst args=process.argv.slice(2);\nwriteFileSync(args[args.indexOf('-oX')+1], '<nmaprun><runstats><finished exit="success"/><hosts up="0" down="0" total="0"/></runstats></nmaprun>');\nprocess.stdout.write('synthetic acceptance output\\n');\nprocess.stderr.write('synthetic stderr\\n');\nif(args.includes('192.0.2.2')){writeFileSync(${JSON.stringify(started)},'started');setTimeout(()=>{},120000);}\n`, { mode: 0o755 });
  // No credentials enter this probe, and its facts cannot satisfy native stages.
  const entryDigest = createHash("sha256").update((await run("git", ["show", `${metadata.revision}:scripts/acceptance-native-runner.mjs`])).stdout).digest("hex");
  const preflight = `console.log(JSON.stringify(await (${nativeEntryPreflight.toString()})(process.argv[1], process.argv[2])));`;
  nativeDiagnostics.preflight = JSON.parse((await run("sudo", ["systemd-run", "--scope", "--quiet", "-p", "MemoryMax=1G", "-p", "CPUQuota=200%", ...unprivileged, process.execPath, "--input-type=module", "--eval", preflight, nativeRoot, entryDigest], { cwd: nativeRoot })).stdout);
  assert.deepEqual(nativeDiagnostics.preflight, {
    runtimeMatches: true, identityMatches: true, supplementaryGroupsEmpty: true,
    capabilitiesEmpty: true, noNewPrivileges: true, cwdMatches: true,
    ancestors: "ok", ancestorSymlink: false, checkout: "ok", scripts: "ok",
    entry: "file", entryRead: "ok", digestMatches: true,
  });
  runner = spawn("sudo", ["systemd-run", "--scope", "--quiet", "-p", "MemoryMax=1G", "-p", "CPUQuota=200%", ...unprivileged, process.execPath, path.join(nativeRoot, "scripts/acceptance-native-runner.mjs")], { cwd: nativeRoot, stdio: ["pipe", "pipe", "pipe"], shell: false });
  runner.on("error", () => { runnerSpawnFailed = true; nativeDiagnostics.failure = "spawn"; });
  runner.stdin.on("error", () => { runnerStdinFailed = true; nativeDiagnostics.failure ??= "stdin-write"; });
  runnerClosed = new Promise((resolve) => runner.once("close", (code, signal) => {
    nativeStderr.finish();
    runnerExit = { code, signal: signal === null || ["SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV"].includes(signal) ? signal : "other" };
    nativeDiagnostics.outcome = runnerExit;
    resolve();
  }));
  const collect = (chunk) => {
    if (runnerLog.length + chunk.length > 1024 * 1024) {
      nativeDiagnostics.failure = "output-limit";
      runner.kill("SIGTERM");
      return false;
    }
    runnerLog += chunk;
    return true;
  };
  let lines = "";
  runner.stdout.on("data", (chunk) => {
    if (!collect(chunk)) return;
    lines += chunk;
    const complete = lines.split("\n");
    lines = complete.pop();
    for (const line of complete) {
      const pid = /^native pid ([1-9]\d{0,9})$/.exec(line)?.[1];
      if (pid) { runnerPid = pid; nativeDiagnostics.launcherEntered = true; }
      const stage = /^native stage (uid|modules|stdin|preflight)$/.exec(line)?.[1];
      if (stage && !nativeDiagnostics.stages.includes(stage)) nativeDiagnostics.stages.push(stage);
      if (line === "handshake accepted" && !nativeDiagnostics.stages.includes("handshake")) nativeDiagnostics.stages.push("handshake");
      const failure = /^native failure stage=(uid|modules|stdin|handshake) code=(\d{3}|EACCES|ENOENT|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ERR_DLOPEN_FAILED|TimeoutError|other)$/.exec(line);
      if (failure) nativeDiagnostics.failure = `${failure[1]}:${failure[2]}`;
    }
  });
  runner.stderr.on("data", (chunk) => { if (collect(chunk)) nativeStderr.append(chunk); });
  runner.stdin.end(JSON.stringify({ apiBaseUrl: origin, runnerId: enrollment.runner.id, secret, dataDir: runnerState, executable: fake, installationFingerprint: fingerprint, sessionId: randomUUID(), heartbeatIntervalMs: 1000 }));
  await until(async () => {
    if (nativeDiagnostics.failure) throw new Error(`Native runner startup failed: ${nativeDiagnostics.failure}`);
    if (runnerSpawnFailed || runnerStdinFailed || runnerExit !== undefined) {
      nativeDiagnostics.failure ??= nativeDiagnostics.launcherEntered ? "launcher-exit" : "pre-entry-exit";
      throw new Error(`Native runner exited before handshake: ${nativeDiagnostics.failure}`);
    }
    return nativeDiagnostics.stages.includes("handshake");
  }, "native runner handshake");
  assert.equal((await run("ps", ["-eo", "args="])).stdout.includes(secret), false);
  async function queue(target) {
    const current = (await api(base)).engagement;
    let planned = await api(`${base}/actions`, { expectedEngagementRevision: current.revision, expectedActiveScopeRevisionId: current.activeScopeRevisionId, targets: [target], declaredPorts: [80] });
    if (planned.action.state === "paused_for_warning") planned = await api(`${base}/actions/${planned.action.actionId}/continue`, { expectedRevision: planned.revision, snapshotVersion: 1, snapshotBinding: planned.action.snapshots[0].binding }, 200);
    assert.equal(planned.action.state, "queued");
    return planned.action.actionId;
  }
  const actionId = await queue("192.0.2.1");
  let completed;
  await until(async () => { completed = (await api(`${base}/runs`)).runs.find((run) => run.actionId === actionId); return completed?.terminalKind !== null && completed?.terminalKind !== undefined; }, "synthetic action");
  assert.equal(completed.terminalKind, "succeeded");
  const original = await api(`${base}/runs/${completed.id}/output`);
  assert.equal(original.stdout.content, "synthetic acceptance output\n");
  assert.equal(original.stderr.content, "synthetic stderr\n");
  const download = await http(`${base}/artifacts/${original.stdout.artifactId}/content`);
  assert.equal(download.bytes.toString(), original.stdout.content);
  const cancelling = await queue("192.0.2.2");
  await until(async () => (await api(`${base}/runs`)).runs.some((run) => run.actionId === cancelling && run.state === "running"), "running cancellation fixture");
  await until(async () => (await run("sudo", [...unprivileged, "test", "-f", started], { allowed: [0, 1] })).code === 0, "synthetic process emitted output");
  const current = await api(`${base}/actions/${cancelling}`);
  await api(`${base}/actions/${cancelling}/cancel`, { expectedRevision: current.revision }, 200);
  let cancelled;
  await until(async () => { cancelled = (await api(`${base}/runs`)).runs.find((run) => run.actionId === cancelling); return cancelled?.terminalKind !== null && cancelled?.terminalKind !== undefined; }, "operator cancellation");
  assert.equal(cancelled.terminalKind, "cancelled");
  const partial = await api(`${base}/runs/${cancelled.id}/output`);
  assert.equal(partial.stdout.completeness, "partial");
  assert.equal(partial.stdout.content, "synthetic acceptance output\n");
  await stopRunner();
  assert.equal(runnerLog.includes(secret), false);
  const logs = await docker(["logs", container]);
  assert.equal(`${logs.stdout}${logs.stderr}`.includes(secret), false);
  checks.push("unprivileged native runner, owner enrollment, handshake, synthetic argv action, exact evidence, operator cancellation and credential log/argv exclusion");
  await compose(["restart"]);
  await ready();
  assert.deepEqual(await api(`${base}/runs/${completed.id}/output`), original);
  checks.push("restart retains engagement, run and immutable evidence references and bytes");
  evidence.visual = await screenshots(`${origin}/engagements/${engagement.id}`, output, path.join(temporary, "chrome"));
  const doctor = await cli(["doctor"]);
  assert.equal(doctor.report.healthy, true);
  await fixture("mkdir", "/data/snapshot");
  const backup = await cli(["backup", "/data/snapshot"]);
  assert.ok(backup.artifactCount >= 6);
  await fixture("refusal-fixtures");
  const snapshot = await fixture("snapshot", "/data/snapshot");
  const restore = await cli(["restore", "/data/snapshot"], "/data/restored");
  assert.equal(restore.restoredArtifacts, backup.artifactCount);
  assert.equal((await cli(["doctor"], "/data/restored")).report.healthy, true);
  const restored = await fixture("snapshot", "/data/restored");
  assert.deepEqual(restored, snapshot);
  for (const [name, code] of [["incomplete", "backup_incomplete"], ["corrupt", "restore_consistency_mismatch"], ["newer", "restore_schema_newer"]]) assert.equal((await cli(["restore", `/data/${name}`], `/data/destination-${name}`, 1)).code, code);
  assert.equal((await cli(["restore", "/data/snapshot"], "/data/nonempty", 1)).code, "restore_destination_not_empty");
  assert.equal((await cli(["backup", "/data/nonempty"], "/data", 1)).code, "backup_destination_not_empty");
  await fixture("no-clobber");
  await fixture("newer-live");
  await compose(["stop"]);
  const refused = await docker(["run", "--rm", "--network", "none", "--read-only", "--user", "10001:10001", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "1g", "--cpus", "2", "--pids-limit", "256", "--mount", `type=volume,src=${volume},dst=/data`, "-e", "STONEHUSH_DATA_DIR=/data/newer-live", metadata.imageId], { allowed: [1] });
  assert.ok(`${refused.stdout}${refused.stderr}`.includes("Stonehush API failed to start"));
  checks.push("packaged doctor, nonempty backup/restore, exact records/bytes/references, integrity/foreign keys/private modes and corrupt/incomplete/newer/nonempty refusal without destination clobber");
  evidence.status = "passed";
  evidence.limits = ["Synthetic nmap adapter, no external targets or installed-tool/platform certification", "Current 27-migration baseline and same-version recovery only", "Three viewport captures require owner comparison with accepted UI", "Native service installer remains separate"];
} catch (error) {
  evidence.status = "failed";
  evidence.failure = String(error.message).replaceAll(secret || "\0", "[redacted]").slice(0, 1000);
  throw new Error(evidence.failure);
} finally {
  await stopRunner().catch(() => {});
  await compose(["down", "--volumes", "--remove-orphans"]).catch(() => {});
  await writeFile(path.join(output, "acceptance.json"), `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const files = await readdir(output);
  assert.ok(files.length <= 4);
  for (const name of files) {
    assert.match(name, /^(acceptance\.json|packaged-(1440x900|1000x900|390x844)\.png)$/);
    assert.ok((await stat(path.join(output, name))).size < 15 * 1024 * 1024);
  }
  // The directory and image are disposable CI state. No raw API responses,
  // credentials, database, backup or application logs enter uploaded evidence.
}
