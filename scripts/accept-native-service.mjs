import assert from "node:assert/strict";
import { packagingHostProvenance } from "./acceptance-real-tools-assertions.mjs";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [imageArchive, runnerArchive, output] = process.argv.slice(2);
assert.equal(process.env.GITHUB_ACTIONS, "true", "Service acceptance runs only on an owned disposable GitHub host.");
assert.equal(process.getuid() === 0, false);
for (const value of [imageArchive, runnerArchive, output]) assert.ok(path.isAbsolute(value ?? ""));
  const image = JSON.parse(await readFile(`${imageArchive}.json`, "utf8"));
const native = JSON.parse(await readFile(`${runnerArchive}.json`, "utf8"));
assert.equal(image.revision, process.env.EXPECTED_REVISION);
assert.equal(native.revision, image.revision);
assert.equal(native.tree, image.tree);
const project = `stonehush-service-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
const temporary = await mkdtemp(path.join(tmpdir(), "stonehush-service-acceptance-"));
await chmod(temporary, 0o755);
const home = path.join(temporary, "home");
const extracted = path.join(temporary, "extracted");
const runtime = path.join(home, ".local/share/stonehush-runner");
const identityDir = path.join(home, ".config/stonehush-runner");
const stateDir = path.join(home, ".local/state/stonehush-runner");
const unit = "stonehush-runner.service";
const user = "stonehush-service-fixture";
const uid = "10002";
const origin = "http://127.0.0.1:18789";
const environment = { ...process.env, STONEHUSH_IMAGE: image.imageId, STONEHUSH_PORT: "18789", COMPOSE_PROJECT_NAME: project };
const evidence = { revision: image.revision, tree: image.tree, imageId: image.imageId, runnerArchiveSha256: native.sha256, checks: [], status: "running" };
let accountCreated = false;
let managerStarted = false;
let secret = "";
function run(executable, argv, { allowed = [0], cwd = process.cwd() } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stderr = "";
    let oversized = false;
    const collect = (isOut) => (chunk) => {
      if (stdout.length + stderr.length + chunk.length > 4 * 1024 * 1024) { oversized = true; child.kill("SIGKILL"); return; }
      if (isOut) stdout += chunk; else stderr += chunk;
    };
    child.stdout.on("data", collect(true));
    child.stderr.on("data", collect(false));
    child.once("error", reject);
    child.once("close", (code) => oversized || !allowed.includes(code) ? reject(new Error(`Service acceptance command ${path.basename(executable)} failed, exit=${code}. Private output omitted.`)) : resolve({ code, stdout, stderr }));
  });
}
const docker = (...args) => run("docker", args);
const compose = (...args) => docker("compose", "-f", "compose.yaml", ...args);
// Enter the private home only after sudo has switched to its owner.
const asUser = (argv, options) => run("/usr/bin/sudo", ["-u", user, "/usr/bin/env", `--chdir=${home}`, `HOME=${home}`, `XDG_RUNTIME_DIR=/run/user/${uid}`, `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`, ...argv], { cwd: temporary, ...options });
const systemctl = (...args) => asUser(["/usr/bin/systemctl", "--user", ...args]);
const command = (base, ...args) => asUser([path.join(base, "node"), path.join(base, "scripts/native-runner-service.mjs"), ...args]);
async function api(target, body, expected = body === undefined ? 200 : 201) {
  const response = await fetch(`${origin}${target}`, { method: body === undefined ? "GET" : "POST", headers: body === undefined ? {} : { origin, "content-type": "application/json", "idempotency-key": randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, expected, "Synthetic API status differs.");
  return response.json();
}
async function until(callback, label) {
  for (let i = 0; i < 160; i++) { if (await callback()) return; await delay(250); }
  throw new Error(`Timed out during ${label}.`);
}
try {
  Object.assign(evidence, await packagingHostProvenance(output, image.revision, image.tree));
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(runnerArchive)) hash.update(chunk);
  assert.equal(hash.digest("hex"), native.sha256);
  await mkdir(extracted, { mode: 0o755 });
  await run("tar", ["-xzf", runnerArchive, "-C", extracted]);
  const artifact = path.join(extracted, "stonehush-runner");
  const started = path.join(stateDir, "synthetic-started");
  const fake = path.join(temporary, "synthetic-nmap");
  await writeFile(fake, `#!${path.join(runtime, "node")}\nimport {writeFileSync} from 'node:fs';\nconst args=process.argv.slice(2);\nif(!args.includes('-sT')||args.includes('-sS'))process.exit(12);\nwriteFileSync(args[args.indexOf('-oX')+1],'<nmaprun><runstats><finished exit="success"/><hosts up="0" down="0" total="0"/></runstats></nmaprun>');\nprocess.stdout.write('synthetic service output\\n');\nprocess.stderr.write('synthetic service stderr\\n');\nif(args.includes('192.0.2.2')){writeFileSync(${JSON.stringify(started)},'started');setTimeout(()=>{},120000);}\n`, { mode: 0o755 });
  await run("sudo", ["chown", "root:root", temporary]);
  // These account/user-manager changes are confined to the disposable CI VM.
  // Refuse collisions rather than adopting an existing account or service.
  assert.equal((await run("getent", ["passwd", uid], { allowed: [0, 2] })).code, 2);
  assert.equal((await run("getent", ["passwd", user], { allowed: [0, 2] })).code, 2);
  await run("sudo", ["useradd", "--uid", uid, "--user-group", "--create-home", "--home-dir", home, "--shell", "/bin/bash", user]);
  accountCreated = true;
  await run("sudo", ["chmod", "0700", home]);
  await run("sudo", ["loginctl", "enable-linger", user]);
  await run("sudo", ["systemctl", "start", `user@${uid}.service`]);
  managerStarted = true;
  await command(artifact, "install", origin, path.join(temporary, "synthetic-nmap"), "Service acceptance runner");
  const before = await command(runtime, "identity");
  const identity = JSON.parse(before.stdout);
  assert.equal(identity.artifact.revision, image.revision);
  assert.equal(identity.artifact.tree, image.tree);
  assert.equal((await asUser([path.join(runtime, "node"), "--version"])).stdout.trim(), "v24.18.0");
  await compose("up", "-d", "--wait", "--wait-timeout", "90");
  const container = (await compose("ps", "-q", "control-plane")).stdout.trim();
  const inspect = JSON.parse((await docker("inspect", container)).stdout)[0];
  assert.equal(inspect.Image, image.imageId);
  const volumePath = inspect.Mounts.find((mount) => mount.Destination === "/data").Source;
  assert.equal((await asUser(["test", "-r", volumePath], { allowed: [0, 1] })).code, 1);
  // Only this job's disposable checkout is restricted. The runner starts
  // exclusively from its copied distribution and cannot traverse the source.
  await chmod(process.cwd(), 0o700);
  assert.equal((await asUser(["test", "-r", process.cwd()], { allowed: [0, 1] })).code, 1, "Service user must have no source-checkout access.");
  assert.equal((await asUser(["test", "-w", "/var/run/docker.sock"], { allowed: [0, 1] })).code, 1);
  await systemctl("daemon-reload");
  assert.equal((await asUser(["/usr/bin/systemctl", "--user", "start", unit], { allowed: [1] })).code, 1);
  await systemctl("stop", unit);
  for (const filename of ["credential.json", "enrollment-attempt.json"]) assert.equal((await asUser(["test", "-e", path.join(identityDir, filename)], { allowed: [0, 1] })).code, 1);
  await command(runtime, "enroll", "--owner-confirmed");
  // Only the CI owner reads this synthetic secret, solely to assert exclusion.
  const credentialPath = path.join(identityDir, "credential.json");
  const credentialBytes = (await run("sudo", ["cat", credentialPath])).stdout;
  const credential = JSON.parse(credentialBytes);
  const credentialDigest = createHash("sha256").update(credentialBytes).digest("hex");
  secret = credential.runnerSecret;
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(secret));
  for (const directory of [home, runtime, identityDir, stateDir, path.join(stateDir, "work")]) {
    assert.equal((await run("sudo", ["stat", "-c", "%u %a", directory])).stdout.trim(), `${uid} 700`);
  }
  assert.equal((await run("sudo", ["stat", "-c", "%u %a", credentialPath])).stdout.trim(), `${uid} 600`);
  await command(artifact, "install", origin, fake, "Service acceptance runner");
  await systemctl("daemon-reload");
  await systemctl("enable", "--now", unit);
  assert.equal((await systemctl("is-active", unit)).stdout.trim(), "active");
  const pid = (await systemctl("show", unit, "--property=MainPID", "--value")).stdout.trim();
  const processStatus = await readFile(`/proc/${pid}/status`, "utf8");
  assert.match(processStatus, /Uid:\s+10002\s+10002\s+10002\s+10002/);
  assert.match(processStatus, /NoNewPrivs:\s+1/);
  assert.match(processStatus, /CapEff:\s+0000000000000000/);
  const engagement = await api("/api/v1/engagements", { name: "Native service acceptance", kind: "lab", autoContinueWarnings: false });
  const base = `/api/v1/engagements/${engagement.id}`;
  async function queue(target) {
    const current = (await api(base)).engagement;
    let action = await api(`${base}/actions`, { expectedEngagementRevision: current.revision, expectedActiveScopeRevisionId: current.activeScopeRevisionId, targets: [target], declaredPorts: [80] });
    if (action.action.state === "paused_for_warning") action = await api(`${base}/actions/${action.action.actionId}/continue`, { expectedRevision: action.revision, snapshotVersion: 1, snapshotBinding: action.action.snapshots[0].binding }, 200);
    assert.equal(action.action.state, "queued");
    return action.action.actionId;
  }
  async function terminal(actionId) {
    let result;
    await until(async () => { result = (await api(`${base}/runs`)).runs.find((item) => item.actionId === actionId); return result?.terminalKind !== undefined && result?.terminalKind !== null; }, "terminal run");
    return result;
  }
  const succeeded = await terminal(await queue("192.0.2.1"));
  assert.equal(succeeded.terminalKind, "succeeded");
  const original = await api(`${base}/runs/${succeeded.id}/output`);
  assert.equal(original.stdout.content, "synthetic service output\n");
  assert.equal(original.stderr.content, "synthetic service stderr\n");
  const download = await fetch(`${origin}${base}/artifacts/${original.stdout.artifactId}/content`);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), original.stdout.content);
  const actionId = await queue("192.0.2.2");
  await until(async () => (await asUser(["test", "-f", started], { allowed: [0, 1] })).code === 0, "synthetic action start");
  const action = await api(`${base}/actions/${actionId}`);
  await api(`${base}/actions/${actionId}/cancel`, { expectedRevision: action.revision }, 200);
  const cancelled = await terminal(actionId);
  assert.equal(cancelled.terminalKind, "cancelled");
  const partial = await api(`${base}/runs/${cancelled.id}/output`);
  assert.equal(partial.stdout.completeness, "partial");
  assert.equal(partial.stdout.content, "synthetic service output\n");
  evidence.checks.push("artifact-only user service, pinned runtime/source pair, private modes, no source/database/evidence/socket access, explicit enrollment and accepted-handshake readiness", "real synthetic argv action, exact immutable evidence download, cancellation and truthful partial output");
  await systemctl("restart", unit);
  assert.equal((await systemctl("is-active", unit)).stdout.trim(), "active");
  assert.notEqual((await systemctl("show", unit, "--property=MainPID", "--value")).stdout.trim(), pid);
  assert.equal(createHash("sha256").update((await run("sudo", ["cat", credentialPath])).stdout).digest("hex"), credentialDigest);
  await compose("restart");
  await until(async () => { try { return (await fetch(`${origin}/health`)).ok; } catch { return false; } }, "control-plane restart");
  const afterRestart = await terminal(await queue("192.0.2.3"));
  assert.equal(afterRestart.terminalKind, "succeeded");
  assert.deepEqual(await api(`${base}/runs/${succeeded.id}/output`), original);
  const rejectedEnrollment = await asUser([path.join(runtime, "node"), path.join(runtime, "scripts/native-runner-service.mjs"), "enroll", "--owner-confirmed"], { allowed: [1] });
  assert.equal(`${rejectedEnrollment.stdout}${rejectedEnrollment.stderr}`.includes(secret), false);
  assert.equal(createHash("sha256").update((await run("sudo", ["cat", credentialPath])).stdout).digest("hex"), credentialDigest);
  const journal = await asUser(["journalctl", "--user", "-u", unit, "--no-pager"]);
  const logs = await docker("logs", container);
  assert.equal(`${journal.stdout}${journal.stderr}${logs.stdout}${logs.stderr}`.includes(secret), false);
  assert.equal((await run("ps", ["-eo", "args="])).stdout.includes(secret), false);
  assert.equal((await asUser([path.join(runtime, "node"), path.join(runtime, "scripts/native-runner-service.mjs"), "remove"], { allowed: [1] })).code, 1);
  // Stop while a synthetic child is running, then verify the dedicated
  // account has no surviving service/tool processes or false success.
  await asUser(["rm", started]);
  const interruptedId = await queue("192.0.2.2");
  await until(async () => (await asUser(["test", "-f", started], { allowed: [0, 1] })).code === 0, "stop fixture start");
  const toolPids = (await run("pgrep", ["-u", uid, "-f", fake])).stdout.trim().split("\n");
  assert.ok(toolPids.every((value) => /^[1-9]\d*$/.test(value)));
  await systemctl("stop", unit);
  assert.equal((await systemctl("show", unit, "--property=ActiveState", "--value")).stdout.trim(), "inactive");
  for (const toolPid of toolPids) {
    try { assert.match(await readFile(`/proc/${toolPid}/stat`, "utf8"), /\) Z /); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const interrupted = await terminal(interruptedId);
  assert.equal(interrupted.terminalKind, "failed");
  const interruptedOutput = await api(`${base}/runs/${interrupted.id}/output`);
  assert.equal(interruptedOutput.stdout.completeness, "partial");
  assert.equal(interruptedOutput.stdout.content, "synthetic service output\n");
  await command(runtime, "remove");
  assert.equal(createHash("sha256").update((await run("sudo", ["cat", credentialPath])).stdout).digest("hex"), credentialDigest);
  assert.equal((await asUser(["test", "-e", runtime], { allowed: [0, 1] })).code, 1);
  // Reinstall preserves the association and resumes without enrollment.
  await command(artifact, "install", origin, fake, "Service acceptance runner");
  await systemctl("daemon-reload");
  await systemctl("enable", "--now", unit);
  assert.equal((await systemctl("is-active", unit)).stdout.trim(), "active");
  assert.equal((await terminal(await queue("192.0.2.4"))).terminalKind, "succeeded");
  await systemctl("stop", unit);
  await api(`/api/v1/runners/${credential.runnerId}/revoke`, { expectedRevision: credential.runnerRevision }, 200);
  await systemctl("start", "--no-block", unit);
  await delay(1500);
  assert.equal((await systemctl("show", unit, "--property=ActiveState", "--value")).stdout.trim(), "activating", "Rejected handshake must not report ready.");
  assert.equal(createHash("sha256").update((await run("sudo", ["cat", credentialPath])).stdout).digest("hex"), credentialDigest);
  await systemctl("stop", unit);
  await command(runtime, "remove");
  evidence.checks.push("runner/control-plane restart and reinstall preserve identity and evidence without re-enrollment", "active removal refused, stop cleans a live tool and preserves truthful interrupted evidence, removal preserves credentials/state", "missing credential and revoked-credential handshake never report ready or silently enroll; logs/argv exclude credentials");
  evidence.status = "passed";
  evidence.limits = ["Recorded build/consumption Ubuntu host pair only; other build/host combinations and Kali remain unproven", "Synthetic operator-managed executable, not external-tool certification", "No owner-host installation, public release, historical migration, signing or SBOM proof"];
} catch (error) {
  evidence.status = "failed";
  evidence.failure = String(error.message).replaceAll(secret || "\0", "[redacted]").slice(0, 1000);
  throw new Error(evidence.failure);
} finally {
  if (managerStarted) {
    await systemctl("stop", unit).catch(() => {});
    await run("sudo", ["systemctl", "stop", `user@${uid}.service`]).catch(() => {});
  }
  if (accountCreated) await run("sudo", ["loginctl", "disable-linger", user]).catch(() => {});
  await compose("down", "--volumes", "--remove-orphans").catch(() => {});
  await writeFile(path.join(output, "service-acceptance.json"), `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
