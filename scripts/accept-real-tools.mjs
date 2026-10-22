import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertContinued, assertDownload, assertToolProcess, sha256 } from "./acceptance-real-tools-assertions.mjs";

// This entrypoint deliberately refuses shared/local hosts. Tool installation,
// account creation and user-manager operations belong only to disposable CI.
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert.equal(process.getuid() === 0, false);
assert.equal(process.platform, "linux");
assert.equal(process.arch, "x64");
assert.equal(process.version, "v24.18.0");
const [imageArchive, runnerArchive, output] = process.argv.slice(2);
for (const value of [imageArchive, runnerArchive, output]) assert.ok(path.isAbsolute(value ?? ""));
const image = JSON.parse(await readFile(`${imageArchive}.json`, "utf8"));
const native = JSON.parse(await readFile(`${runnerArchive}.json`, "utf8"));
assert.equal(image.revision, process.env.EXPECTED_REVISION);
assert.equal(native.revision, image.revision);
assert.equal(native.tree, image.tree);
const temporary = await mkdtemp(path.join(tmpdir(), "stonehush-real-tools-"));
await chmod(temporary, 0o755);
const home = path.join(temporary, "home");
const runtime = path.join(home, ".local/share/stonehush-runner");
const state = path.join(home, ".local/state/stonehush-runner");
const user = "stonehush-real-tools";
const uid = "10003";
const unit = "stonehush-runner.service";
const origin = "http://127.0.0.1:18791";
const project = `stonehush-real-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
// Never inherit a synthetic fixture's PATH, proxy or runner configuration.
const environment = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, LANG: "C.UTF-8", STONEHUSH_IMAGE: image.imageId, STONEHUSH_PORT: "18791", COMPOSE_PROJECT_NAME: project };
const receipt = { revision: image.revision, tree: image.tree, imageId: image.imageId, imageArchiveSha256: image.sha256, runnerArchiveSha256: native.sha256, commands: [], checks: [], tools: {}, runs: [], artifacts: [], cleanup: [], status: "running" };
let phase = "prerequisites";
let accountCreated = false;
let managerStarted = false;
let secret = "";
let fixture;
let fixtureOrigin;
let slowRequests = 0;
let slowClosed = 0;
const routeCounts = {};
const timers = new Set();

function run(executable, argv, { allowed = [0], cwd = process.cwd(), timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stderr = "";
    let exceeded = false;
    const timer = setTimeout(() => { exceeded = true; child.kill("SIGKILL"); }, timeout);
    const collect = (out) => (chunk) => {
      if (stdout.length + stderr.length + chunk.length > 2 * 1024 * 1024) { exceeded = true; child.kill("SIGKILL"); return; }
      if (out) stdout += chunk; else stderr += chunk;
    };
    child.stdout.on("data", collect(true));
    child.stderr.on("data", collect(false));
    child.once("error", (error) => { clearTimeout(timer); reject(new Error(`Command spawn failed: ${path.basename(executable)} ${error.code}`)); });
    child.once("close", (code) => {
      clearTimeout(timer);
      // No command output or credential/configuration bytes enter receipts.
      if (receipt.commands.length >= 2500) { reject(new Error("Command receipt bound exceeded.")); return; }
      receipt.commands.push({ executable, argv, code, exceeded });
      if (exceeded || !allowed.includes(code)) reject(new Error(`Command failed: ${path.basename(executable)} ${argv[0]}, exit=${code}, bound=${exceeded}`));
      else resolve({ code, stdout, stderr });
    });
  });
}
const docker = (...args) => run("/usr/bin/docker", args, { timeout: 100000 });
const compose = (...args) => docker("compose", "-f", "compose.yaml", ...args);
const asUser = (argv, options) => run("/usr/bin/sudo", ["-u", user, "/usr/bin/env", `--chdir=${home}`, `HOME=${home}`, "PATH=/usr/bin:/bin", `XDG_RUNTIME_DIR=/run/user/${uid}`, `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`, ...argv], { cwd: temporary, ...options });
const systemctl = (...args) => asUser(["/usr/bin/systemctl", "--user", ...args]);
const command = (base, ...args) => asUser([path.join(base, "node"), path.join(base, "scripts/native-runner-service.mjs"), ...args]);
async function until(callback, label, milliseconds = 60000) {
  const deadline = Date.now() + milliseconds;
  do { const value = await callback(); if (value) return value; await delay(100); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}
async function http(target, body, expected = body === undefined ? 200 : 201) {
  const response = await fetch(`${origin}${target}`, { method: body === undefined ? "GET" : "POST", headers: body === undefined ? {} : { origin, "content-type": "application/json", "idempotency-key": randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000), redirect: "error" });
  assert.equal(response.status, expected, `Operator HTTP status: ${target}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) { size += chunk.length; assert.ok(size <= 2 * 1024 * 1024, "Response bound exceeded."); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
const api = async (...args) => JSON.parse(await http(...args));
async function archiveHash(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}
async function processProof(tool, wordlist) {
  return until(async () => {
    const found = await run("/usr/bin/pgrep", ["-u", uid, "-x", tool], { allowed: [0, 1] });
    if (found.code === 1) return false;
    const pids = found.stdout.trim().split("\n");
    assert.equal(pids.length, 1);
    const pid = pids[0];
    assert.match(pid, /^[1-9]\d*$/);
    const executable = (await run("/usr/bin/sudo", ["readlink", `/proc/${pid}/exe`])).stdout.trim();
    const argv = (await run("/usr/bin/sudo", ["cat", `/proc/${pid}/cmdline`])).stdout.split("\0").filter(Boolean);
    assertToolProcess(tool, executable, argv, { port: Number(new URL(fixtureOrigin).port), origin: fixtureOrigin, wordlist });
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    assert.match(status, /Uid:\s+10003\s+10003\s+10003\s+10003/);
    assert.match(status, /CapEff:\s+0000000000000000/);
    const proof = { tool, pid, executable, argv, uid, observedAt: new Date().toISOString() };
    receipt.checks.push({ process: proof });
    return proof;
  }, `real ${tool} process`, 30000);
}
async function gone(pid) {
  return until(async () => {
    try { return /\) Z /.test(await readFile(`/proc/${pid}/stat`, "utf8")); } catch (error) { if (error.code === "ENOENT") return true; throw error; }
  }, "observed tool exit", 10000);
}

try {
  const os = await readFile("/etc/os-release", "utf8");
  assert.match(os, /^ID=ubuntu$/m);
  assert.match(os, /^VERSION_ID="24.04"$/m);
  receipt.host = { os, architecture: process.arch, node: process.version, pnpm: (await run("/usr/bin/env", ["pnpm", "--version"], { cwd: temporary })).stdout.trim() };
  assert.equal(receipt.host.pnpm, "10.24.0");
  for (const tool of ["nmap", "ffuf"]) {
    const executable = `/usr/bin/${tool}`;
    const ownership = (await run("/usr/bin/dpkg-query", ["-S", executable])).stdout.trim();
    assert.equal(ownership, `${tool}: ${executable}`);
    assert.equal((await run("/usr/bin/dpkg", ["--verify", tool])).stdout, "");
    const version = await run(executable, [tool === "nmap" ? "--version" : "-V"]);
    receipt.tools[tool] = { packagePolicy: (await run("/usr/bin/apt-cache", ["policy", tool])).stdout.trim().slice(0, 8192), executable, digest: `sha256:${await archiveHash(executable)}`, package: (await run("/usr/bin/dpkg-query", ["-W", "-f=${Package} ${Version} ${Architecture}\n", tool])).stdout.trim(), ownership, version: `${version.stdout}${version.stderr}`.trim().slice(0, 4096) };
  }
  assert.equal(await archiveHash(imageArchive), image.sha256);
  assert.equal(await archiveHash(runnerArchive), native.sha256);
  const extracted = path.join(temporary, "extracted");
  await mkdir(extracted, { mode: 0o755 });
  await run("/usr/bin/tar", ["-xzf", runnerArchive, "-C", extracted]);
  const artifact = path.join(extracted, "stonehush-runner");
  const manifest = JSON.parse(await readFile(path.join(artifact, "artifact.json"), "utf8"));
  receipt.inventory = { files: manifest.inventory.length, digest: sha256(JSON.stringify(manifest.inventory)) };
  assert.equal(manifest.revision, image.revision);
  assert.equal(manifest.tree, image.tree);
  await run("/usr/bin/sudo", ["chown", "root:root", temporary]);
  for (const value of [uid, user]) assert.equal((await run("/usr/bin/getent", ["passwd", value], { allowed: [0, 2] })).code, 2);
  phase = "artifact-service-install";
  await run("/usr/bin/sudo", ["useradd", "--uid", uid, "--user-group", "--create-home", "--home-dir", home, "--shell", "/bin/bash", user]);
  accountCreated = true;
  await run("/usr/bin/sudo", ["chmod", "0700", home]);
  await run("/usr/bin/sudo", ["loginctl", "enable-linger", user]);
  await run("/usr/bin/sudo", ["systemctl", "start", `user@${uid}.service`]);
  managerStarted = true;
  await command(artifact, "install", origin, "/usr/bin/nmap", "Real tool acceptance");
  const identity = JSON.parse((await command(runtime, "identity")).stdout);
  assert.equal(identity.artifact.revision, image.revision);
  assert.equal(identity.artifact.tree, image.tree);
  assert.equal((await asUser([path.join(runtime, "node"), "--version"])).stdout.trim(), "v24.18.0");
  await docker("image", "load", "--input", imageArchive);
  await compose("up", "-d", "--wait", "--wait-timeout", "90");
  const container = (await compose("ps", "-q", "control-plane")).stdout.trim();
  const inspect = JSON.parse((await docker("inspect", container)).stdout)[0];
  assert.equal(inspect.Image, image.imageId);
  const imageManifest = JSON.parse((await docker("exec", container, "cat", "/opt/stonehush/artifact.json")).stdout);
  assert.equal(imageManifest.revision, image.revision);
  assert.equal(imageManifest.tree, image.tree);
  receipt.imageInventory = { files: imageManifest.inventory.length, digest: sha256(JSON.stringify(imageManifest.inventory)) };
  assert.equal(inspect.Config.User, "10001:10001");
  assert.equal(inspect.HostConfig.ReadonlyRootfs, true);
  const volume = inspect.Mounts.find((mount) => mount.Destination === "/data").Source;
  assert.equal((await asUser(["test", "-r", volume], { allowed: [0, 1] })).code, 1);
  assert.equal((await asUser(["test", "-w", "/var/run/docker.sock"], { allowed: [0, 1] })).code, 1);
  await chmod(process.cwd(), 0o700);
  assert.equal((await asUser(["test", "-r", process.cwd()], { allowed: [0, 1] })).code, 1);
  await command(runtime, "enroll", "--owner-confirmed");
  secret = JSON.parse((await run("/usr/bin/sudo", ["cat", path.join(home, ".config/stonehush-runner/credential.json")])).stdout).runnerSecret;
  assert.equal(typeof secret, "string");
  assert.equal(secret.length, 43);
  await systemctl("daemon-reload");
  await systemctl("set-property", unit, "MemoryMax=1G", "CPUQuota=200%", "TasksMax=128");
  await systemctl("enable", "--now", unit);
  assert.equal((await systemctl("is-active", unit)).stdout.trim(), "active");

  phase = "loopback-fixture";
  const title = "Stonehush real tool fixture";
  const planted = "planted-acceptance";
  const body = "planted fixture evidence\n";
  fixture = createServer((request, response) => {
    const route = request.url;
    routeCounts[route] = (routeCounts[route] ?? 0) + 1;
    if (Object.values(routeCounts).reduce((a, b) => a + b, 0) > 100) { receipt.fixtureRequestLimitExceeded = true; response.destroy(); return; }
    const slow = route === "/slow-acceptance";
    if (slow) { slowRequests++; response.once("close", () => { slowClosed++; }); }
    const timer = setTimeout(() => {
      timers.delete(timer);
      response.writeHead(route === "/" || route === `/${planted}` || slow ? 200 : 404, { "content-type": "text/html", server: "stonehush-fixture" });
      response.end(route === "/" ? `<title>${title}</title>` : route === `/${planted}` ? body : "missing\n");
    }, slow ? 29000 : route === `/${planted}` ? 1500 : 0);
    timers.add(timer);
    response.once("close", () => { clearTimeout(timer); timers.delete(timer); });
  });
  fixture.requestTimeout = 35000;
  fixture.headersTimeout = 5000;
  fixture.maxConnections = 8;
  await new Promise((resolve, reject) => { fixture.once("error", reject); fixture.listen(0, "127.0.0.1", resolve); });
  fixtureOrigin = `http://127.0.0.1:${fixture.address().port}`;
  const port = fixture.address().port;
  receipt.fixture = { origin: fixtureOrigin, port, title, planted, wordlistEntries: 2, threads: 1, maxTimeSeconds: 45, requestTimeoutSeconds: 30, rateEnforced: false };
  const wordlist = path.join(state, "tiny-wordlist.txt");
  const slowWordlist = path.join(state, "slow-wordlist.txt");
  await asUser([path.join(runtime, "node"), "--input-type=module", "-e", "import {writeFileSync} from 'node:fs';writeFileSync(process.argv[1], 'planted-acceptance\\nmissing-acceptance\\n', {flag:'wx',mode:0o600});writeFileSync(process.argv[2], 'slow-acceptance\\n', {flag:'wx',mode:0o600});", wordlist, slowWordlist]);
  const engagement = await api("/api/v1/engagements", { name: "Packaged real tools", kind: "lab", autoContinueWarnings: false });
  const base = `/api/v1/engagements/${engagement.id}`;
  await api(`${base}/scope-revisions`, { expectedRevision: engagement.revision, rules: [{ id: "scope-fixture", kind: "ip", target: { kind: "ip", normalizationProfile: "d1-v1", family: 4, address: "192.0.2.1", zone: null } }] });
  const savedScope = (await api(base)).activeScopeRevision;
  assert.ok(savedScope && savedScope.rules.length === 1);
  async function queue(target, ffufWordlist) {
    const current = (await api(base)).engagement;
    const revisions = { expectedEngagementRevision: current.revision, expectedActiveScopeRevisionId: current.activeScopeRevisionId };
    let planned = await api(`${base}/${ffufWordlist ? "ffuf-discoveries" : "actions"}`, ffufWordlist ? { ...revisions, origin: fixtureOrigin, wordlistPath: ffufWordlist, threads: 1, rate: 1, timeoutSeconds: 30, maxTimeSeconds: 45, matchStatusCodes: [200] } : { ...revisions, targets: [target], declaredPorts: [port] });
    const original = planned;
    if (planned.action.state === "paused_for_warning") {
      planned = await api(`${base}/actions/${planned.action.actionId}/continue`, { expectedRevision: planned.revision, snapshotVersion: 1, snapshotBinding: planned.action.snapshots[0].binding }, 200);
      assertContinued(original, planned);
    } else assert.fail("Fixture action must expose its outside-scope warning.");
    assert.equal(planned.action.state, "queued");
    assert.equal(planned.action.warningInteractions, 1);
    assert.equal(planned.action.warningAcknowledgment.scopeRevisionId, savedScope.id);
    assert.ok(planned.action.warningAcknowledgment.reasonCodes.includes("outside_scope"));
    assert.deepEqual((await api(base)).activeScopeRevision, savedScope);
    receipt.checks.push({ actionId: planned.action.actionId, snapshot: planned.action.snapshots[0], warningAcknowledgment: planned.action.warningAcknowledgment });
    return planned.action.actionId;
  }
  async function terminal(actionId, kind) {
    const result = await until(async () => {
      const run = (await api(`${base}/runs`)).runs.find((item) => item.actionId === actionId);
      return run?.terminalKind ? run : false;
    }, `terminal ${kind}`, 90000);
    receipt.runs.push(result);
    assert.equal(result.terminalKind, kind, "Real tool terminal kind differs.");
    return result;
  }
  async function download(artifact, run) {
    const bytes = await http(`${base}/artifacts/${artifact.artifactId}/content`);
    assertDownload(artifact, bytes, run.id);
    receipt.artifacts.push({ ...artifact, actionId: run.actionId, downloadedDigest: sha256(bytes) });
    await writeFile(path.join(output, `real-${artifact.artifactId}.bin`), bytes, { mode: 0o600, flag: "wx" });
    return bytes;
  }
  async function rawArtifact(projected, run) {
    const report = await api(`${base}/report?format=json`);
    const artifact = report.evidenceArtifacts.rows.find((item) => item.artifactId === projected.artifactId);
    assert.ok(artifact);
    assert.equal(artifact.kind, "tool_raw");
    assert.equal(artifact.completeness, "complete");
    assert.equal(artifact.digest, projected.artifactDigest);
    return download(artifact, run);
  }

  phase = "nmap";
  const nmapId = await queue("127.0.0.1");
  const nmapProcess = await processProof("nmap");
  const nmapRun = await terminal(nmapId, "succeeded");
  await gone(nmapProcess.pid);
  const services = await api(`${base}/services`);
  assert.equal(services.length, 1);
  const service = services[0];
  assert.equal(service.address, "127.0.0.1");
  assert.equal(service.port, port);
  assert.equal(service.protocol, "tcp");
  assert.equal(service.runId, nmapRun.id);
  const xml = (await rawArtifact(service, nmapRun)).toString("utf8");
  assert.match(xml, /<nmaprun /);
  assert.ok(xml.includes('type="connect"') && xml.includes(`services="${port}"`) && xml.includes('addr="127.0.0.1"') && xml.includes('state="open"'));
  assert.ok(xml.includes(`portid="${port}"`));

  phase = "http-probe";
  const exactOrigin = `http://${service.address}:${service.port}`;
  assert.equal(exactOrigin, fixtureOrigin);
  const probeRun = await terminal(await queue(exactOrigin), "succeeded");
  const probes = await api(`${base}/http-probes`);
  assert.equal(probes.length, 1);
  const probe = probes[0];
  assert.equal(probe.runId, probeRun.id);
  assert.equal(probe.status, 200);
  assert.equal(probe.title, title);
  assert.equal(probe.url, `${fixtureOrigin}/`);
  assert.equal(probe.finalUrl, probe.url);
  const probeRaw = JSON.parse(await rawArtifact(probe, probeRun));
  assert.equal(probeRaw.title, title);
  assert.equal(probeRaw.status, 200);
  assert.equal(probeRaw.error, null);

  phase = "ffuf";
  const ffufId = await queue(exactOrigin, wordlist);
  const ffufProcess = await processProof("ffuf", wordlist);
  const ffufRun = await terminal(ffufId, "succeeded");
  await gone(ffufProcess.pid);
  const results = await api(`${base}/ffuf-results`);
  assert.equal(results.length, 1);
  const result = results[0];
  assert.equal(result.runId, ffufRun.id);
  assert.equal(result.url, `${fixtureOrigin}/${planted}`);
  assert.equal(result.status, 200);
  assert.equal(result.length, Buffer.byteLength(body));
  assert.equal(result.fuzz, planted);
  assert.ok(routeCounts["/missing-acceptance"] >= 1);
  const raw = JSON.parse(await rawArtifact(result, ffufRun));
  assert.equal(raw.results.length, 1);
  assert.equal(raw.results[0].url, result.url);
  assert.equal(raw.results[0].status, 200);
  assert.equal(raw.results[0].length, result.length);
  assert.equal(raw.results[0].words, result.words);
  assert.equal(raw.results[0].lines, result.lines);
  const finding = await api(`${base}/findings`, { title: "Planted acceptance path", severity: "info", body: `Synthetic path ${result.url}`, evidenceArtifactIds: [service.artifactId, probe.artifactId, result.artifactId] });
  const report = await api(`${base}/report?format=json`);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].id, finding.id);
  assert.deepEqual(report.findings[0].evidenceArtifactIds, finding.evidenceArtifactIds);
  for (const id of finding.evidenceArtifactIds) assert.ok(report.evidenceArtifacts.rows.some((item) => item.artifactId === id));
  await writeFile(path.join(output, "real-tools-report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  receipt.finding = finding;

  phase = "ffuf-cancellation";
  const cancelId = await queue(exactOrigin, slowWordlist);
  const slowProcess = await processProof("ffuf", slowWordlist);
  await until(() => slowRequests > 0, "real slow HTTP request", 10000);
  const active = (await api(`${base}/runs`)).runs.find((item) => item.actionId === cancelId);
  assert.equal(active.state, "running");
  const action = await api(`${base}/actions/${cancelId}`);
  const cancelledAt = Date.now();
  await api(`${base}/actions/${cancelId}/cancel`, { expectedRevision: action.revision }, 200);
  const cancelled = await terminal(cancelId, "cancelled");
  await gone(slowProcess.pid);
  await until(() => slowClosed > 0, "cancelled request connection cleanup", 10000);
  assert.ok(Date.now() - cancelledAt < 25000, "Cancellation exceeded bound.");
  const partialOutput = await api(`${base}/runs/${cancelled.id}/output`);
  assert.equal(partialOutput.run.id, cancelled.id);
  assert.equal(partialOutput.run.actionId, cancelId);
  assert.equal(partialOutput.run.terminalKind, "cancelled");
  for (const stream of [partialOutput.stdout, partialOutput.stderr]) { assert.equal(stream.present, true); assert.equal(stream.completeness, "partial"); }
  const afterCancel = await api(`${base}/report?format=json`);
  const partial = afterCancel.evidenceArtifacts.rows.filter((item) => item.runId === cancelled.id);
  assert.ok(partial.some((item) => item.kind === "stdout") && partial.some((item) => item.kind === "stderr"));
  for (const artifact of partial) { assert.equal(artifact.completeness, "partial"); await download(artifact, cancelled); }
  // ffuf may publish no raw JSON, empty bytes or incomplete JSON on TERM.
  // Only published bytes and their hashes are asserted, never fabricated JSON.
  receipt.cancellation = { actionId: cancelId, runId: cancelled.id, elapsedMs: Date.now() - cancelledAt, observedPid: slowProcess.pid, slowRequests, slowClosed, rawArtifacts: partial.filter((item) => item.kind === "tool_raw").length };
  assert.equal((await api(`${base}/ffuf-results`)).length, 1);
  assert.deepEqual((await api(base)).activeScopeRevision, savedScope);
  assert.equal(receipt.fixtureRequestLimitExceeded, undefined);
  receipt.routeCounts = routeCounts;
  const journal = await asUser(["/usr/bin/journalctl", "--user", "-u", unit, "--no-pager"]);
  const logs = await docker("logs", container);
  assert.equal(`${journal.stdout}${journal.stderr}${logs.stdout}${logs.stderr}`.includes(secret), false);
  receipt.checks.push("real distribution executables and exact argv", "single-port Nmap -> projected service -> HTTP probe -> ffuf -> immutable evidence -> finding/report", "one Continue retains target context and saved scope", "real active ffuf cancellation, bounded exit and exact truthful partial published bytes", "credentials absent from service/container logs");
  receipt.status = "passed";
} catch (error) {
  receipt.status = "failed";
  receipt.failure = { phase, message: String(error.message).replaceAll(secret || "\0", "[redacted]").slice(0, 1500), classification: "unclassified; inspect assertion and hosted step before attributing to product or infrastructure" };
  process.exitCode = 1;
} finally {
  phase = "cleanup";
  for (const timer of timers) clearTimeout(timer);
  if (fixture) { fixture.closeAllConnections(); await new Promise((resolve) => fixture.close(resolve)); receipt.cleanup.push("fixture closed"); }
  async function clean(label, callback) {
    try { await callback(); receipt.cleanup.push({ label, passed: true }); } catch { receipt.cleanup.push({ label, passed: false }); receipt.status = "failed"; process.exitCode = 1; }
  }
  if (managerStarted) {
    await clean("stop owned user service", () => systemctl("stop", unit));
    await clean("no surviving owned user processes", async () => { assert.equal((await run("/usr/bin/pgrep", ["-u", uid, "-x", "nmap|ffuf"], { allowed: [0, 1] })).code, 1); });
    await clean("stop owned user manager", () => run("/usr/bin/sudo", ["systemctl", "stop", `user@${uid}.service`]));
  }
  if (accountCreated) await clean("disable fixture linger", () => run("/usr/bin/sudo", ["loginctl", "disable-linger", user]));
  await clean("remove owned Compose volume", () => compose("down", "--volumes", "--remove-orphans"));
  receipt.limits = ["Recorded Ubuntu 24.04 x64 distribution tools and synthetic loopback target only", "No CTF/VPN/DNS/inference/other-OS or whole-RC certification", "No ffuf rate enforcement, forced KILL or escaped-descendant claim", "Prior service and broader M9/M10 limits remain open"];
  const json = JSON.stringify(receipt, null, 2);
  assert.equal(secret ? json.includes(secret) : false, false);
  await writeFile(path.join(output, "real-tools-acceptance.json"), `${json}\n`, { flag: "wx", mode: 0o600 });
  console.log(`Real tools acceptance ${receipt.status}; phase=${receipt.failure?.phase ?? "complete"}. See bounded synthetic receipt.`);
}
