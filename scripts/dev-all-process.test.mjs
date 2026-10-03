import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./dev-all.mjs", import.meta.url));
const secret = "a".repeat(43);

async function listener(handler, port = 0) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

async function freePort() {
  const server = await listener((_request, response) => response.end());
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function fixture(t, extraEnv = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-dev-all-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ["apps/api/src", "apps/api/node_modules/tsx", "apps/web/node_modules/vite/bin", "apps/runner/src"]) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  await writeFile(path.join(root, "apps/api/package.json"), '{"type":"module"}\n');
  await writeFile(path.join(root, "apps/web/package.json"), '{"type":"module"}\n');
  await writeFile(path.join(root, "apps/api/node_modules/tsx/package.json"), '{"type":"module","exports":"./loader.mjs"}\n');
  await writeFile(path.join(root, "apps/api/node_modules/tsx/loader.mjs"), "export {};\n");
  await writeFile(path.join(root, "apps/web/node_modules/vite/package.json"), '{"type":"module","exports":{"./package.json":"./package.json"}}\n');
  await writeFile(path.join(root, "apps/api/src/server.ts"), `
import { createServer } from "node:http";
if (process.env.STONEHUSH_RUNNER_SECRET || process.env.STONEHUSH_RUNNER_ID) process.exit(9);
const server = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/health") return res.end(JSON.stringify({status:"ok"}));
  console.log("fixture enrollment request " + req.url);
  const body = req.url.endsWith("/confirm")
    ? {runner:{id:"fixture-runner",revision:1,status:"enabled",installationFingerprint:process.env.STONEHUSH_INSTALLATION_FINGERPRINT || "sha256:" + "a".repeat(64),name:process.env.STONEHUSH_RUNNER_NAME},secret:"a".repeat(43)}
    : req.url.endsWith("/revoke") ? {runner:{id:"fixture-runner",revision:2,status:"revoked"}}
    : {challengeId:"fixture-challenge"};
  if (process.env.FIXTURE_MODE === "enrollment-delay") setTimeout(() => res.end(JSON.stringify(body)), 2000);
  else res.end(JSON.stringify(body));
});
const bind = () => server.listen(Number(process.env.STONEHUSH_API_PORT), "127.0.0.1", () => {
  console.log("fixture API listening");
  if (process.env.FIXTURE_MODE !== "api-unready") process.send({type:"stonehush-api-ready"}, () => process.disconnect());
});
if (process.env.FIXTURE_MODE === "api-bind-race") {
  console.log("fixture API before bind");
  setTimeout(bind, 500);
} else bind();
server.on("error", () => process.exit(1));
for (const signal of ["SIGINT","SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
`);
  await writeFile(path.join(root, "apps/web/node_modules/vite/bin/vite.js"), `
import { createServer } from "node:http";
if (process.env.STONEHUSH_RUNNER_SECRET || process.env.STONEHUSH_RUNNER_ID) process.exit(9);
if (process.env.FIXTURE_MODE === "web-exit") process.exit(0);
const server = createServer(async (req, res) => {
  if (req.url === "/health") {
    const api = await fetch("http://127.0.0.1:" + process.env.STONEHUSH_API_PORT + "/health");
    return res.end(await api.text());
  }
  res.end('<html><div id="root"></div></html>');
});
const bind = () => server.listen(Number(process.env.STONEHUSH_WEB_PORT), "127.0.0.1", () => {
  console.log("fixture web listening");
  if (process.env.FIXTURE_MODE !== "web-unready") process.send({type:"stonehush-web-ready"}, () => process.disconnect());
});
if (process.env.FIXTURE_MODE === "web-bind-race") {
  console.log("fixture web before bind");
  setTimeout(bind, 500);
} else bind();
server.on("error", () => process.exit(1));
for (const signal of ["SIGINT","SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
`);
  await writeFile(path.join(root, "apps/runner/src/index.ts"), `
if (process.env.STONEHUSH_RUNNER_SECRET !== "a".repeat(43)) process.exit(8);
console.log("fixture runner started pid=" + process.pid);
if (process.env.FIXTURE_MODE === "runner-exit") process.exit(0);
if (process.env.FIXTURE_MODE !== "runner-unready") process.send({type:"stonehush-runner-ready"}, () => process.disconnect());
const timer = setInterval(() => {}, 1000);
for (const signal of ["SIGINT","SIGTERM"]) process.on(signal, () => {
  if (process.env.FIXTURE_MODE !== "runner-uncooperative") {clearInterval(timer); process.exit(0);}
});
`);
  const apiPort = await freePort();
  let webPort = await freePort();
  while (webPort === apiPort) webPort = await freePort();
  const env = {
    ...process.env, STONEHUSH_API_PORT: String(apiPort), STONEHUSH_WEB_PORT: String(webPort),
    STONEHUSH_DATA_DIR: path.join(root, "data"), STONEHUSH_NMAP_EXECUTABLE: process.execPath,
    STONEHUSH_INSTALLATION_FINGERPRINT: `sha256:${"a".repeat(64)}`, STONEHUSH_RUNNER_NAME: "process-fixture",
    npm_execpath: "/tmp/fixture-pnpm", ...extraEnv,
  };
  delete env.STONEHUSH_API_BASE_URL;
  if (!extraEnv.STONEHUSH_RUNNER_ID) delete env.STONEHUSH_RUNNER_ID;
  if (!extraEnv.STONEHUSH_RUNNER_SECRET) delete env.STONEHUSH_RUNNER_SECRET;
  function start() {
    const source = `
      import {readFileSync} from "node:fs";
      import childProcess from "node:child_process";
      import {syncBuiltinESMExports} from "node:module";
      const kill = process.kill.bind(process);
      process.kill = (pid, signal) => {
        if (pid < 0 && process.env.FIXTURE_MODE?.startsWith("failed-stop")) {
          let command = "";
          try { command = readFileSync("/proc/" + (-pid) + "/cmdline", "utf8"); } catch {}
          if (command.includes("apps/runner/src/index.ts")
            && (process.env.FIXTURE_MODE === "failed-stop-probe" ? signal === 0 : signal === "SIGTERM")) {
            throw Object.assign(new Error("Synthetic owned-runner stop failure."), {code:"EPERM"});
          }
        }
        return kill(pid, signal);
      };
      if (process.env.FIXTURE_MODE === "runner-spawn-failure") {
        const spawn = childProcess.spawn;
        childProcess.spawn = (command, args, options) => spawn(
          args.includes(${JSON.stringify(path.join(root, "apps/runner/src/index.ts"))})
            ? ${JSON.stringify(path.join(root, "missing-runner-executable"))} : command,
          args, options);
        syncBuiltinESMExports();
      }
      const {runCombinedDev} = await import(${JSON.stringify(script)});
      await runCombinedDev({repositoryRoot:${JSON.stringify(root)}});`;

    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      env, stdio: ["ignore", "pipe", "pipe"], detached: true, shell: false,
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exited;
    });
    return { child, exited, output: () => output };
  }
  return { root, apiPort, webPort, start };
}

async function waitForOutput(process, text) {
  const deadline = Date.now() + 10_000;
  while (!process.output().includes(text) && Date.now() < deadline) {
    if (process.child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(process.output().includes(text), process.output());
}

async function assertReleased(port) {
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(100) }));
}

test("combined processes enroll and stop together without credential output", { timeout: 15_000 }, async (t) => {
  const lab = await fixture(t);
  const process = lab.start();
  await waitForOutput(process, "Stonehush ready at");
  assert.equal((process.output().match(/fixture enrollment request/g) ?? []).length, 2);
  assert.ok(!process.output().includes(secret));
  process.child.kill("SIGINT");
  assert.equal((await process.exited).code, 130);
  assert.ok(process.output().includes("Revoked temporary runner fixture-runner"));
  await assertReleased(lab.apiPort);
  await assertReleased(lab.webPort);
});

test("reused credentials skip enrollment and stay out of API/web environments", { timeout: 15_000 }, async (t) => {
  const lab = await fixture(t, { STONEHUSH_RUNNER_ID: "fixture-runner", STONEHUSH_RUNNER_SECRET: secret });
  const process = lab.start();
  await waitForOutput(process, "Stonehush ready at");
  assert.ok(!process.output().includes("fixture enrollment request"));
  assert.ok(!process.output().includes(secret));
  process.child.kill("SIGTERM");
  assert.equal((await process.exited).code, 143);
  assert.ok(!process.output().includes("/revoke"));
  await assertReleased(lab.apiPort);
});

for (const occupied of ["apiPort", "webPort"]) {
test(`foreign healthy ${occupied} is untouched and cannot satisfy readiness`, { timeout: 15_000 }, async (t) => {
  const lab = await fixture(t);
  let mutations = 0;
  const foreign = await listener((request, response) => {
    if (request.method !== "GET") mutations += 1;
    response.end(JSON.stringify({ status: "ok" }));
  }, lab[occupied]);
  t.after(() => new Promise((resolve) => foreign.close(resolve)));
  const process = lab.start();
  assert.equal((await process.exited).code, 1);
  assert.ok(process.output().includes("already occupied"));
  assert.ok(!process.output().includes("fixture API listening"));
  assert.equal(mutations, 0);
  assert.equal((await fetch(`http://127.0.0.1:${lab[occupied]}/health`)).status, 200);
  await assert.rejects(access(path.join(lab.root, "data")));
});
}

test("losing the API bind race never adopts the healthy foreign listener", { timeout: 15_000 }, async (t) => {
  const lab = await fixture(t, { FIXTURE_MODE: "api-bind-race" });
  const process = lab.start();
  await waitForOutput(process, "fixture API before bind");
  let mutations = 0;
  const foreign = await listener((request, response) => {
    if (request.method !== "GET") mutations += 1;
    response.end(JSON.stringify({ status: "ok" }));
  }, lab.apiPort);
  t.after(() => new Promise((resolve) => foreign.close(resolve)));
  assert.equal((await process.exited).code, 1);
  assert.ok(!process.output().includes("fixture enrollment request"));
  assert.ok(!process.output().includes("Stonehush ready at"));
  assert.equal(mutations, 0);
  assert.equal((await fetch(`http://127.0.0.1:${lab.apiPort}/health`)).status, 200);
});

test("losing the web bind race never enrolls against a foreign app", { timeout: 15_000 }, async (t) => {
  const lab = await fixture(t, { FIXTURE_MODE: "web-bind-race" });
  const starter = lab.start();
  await waitForOutput(starter, "fixture web before bind");
  const foreign = await listener((request, response) => {
    response.end(request.url === "/health"
      ? JSON.stringify({ status: "ok" }) : '<html><div id="root"></div></html>');
  }, lab.webPort);
  t.after(() => new Promise((resolve) => foreign.close(resolve)));
  assert.equal((await starter.exited).code, 1);
  assert.ok(!starter.output().includes("fixture enrollment request"));
  assert.ok(!starter.output().includes("Stonehush ready at"));
  assert.equal((await fetch(`http://127.0.0.1:${lab.webPort}/health`)).status, 200);
  await assertReleased(lab.apiPort);
});

test("uncooperative owned runner escalates while unrelated process survives", { timeout: 20_000 }, async (t) => {
  const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
  const sentinelExit = new Promise((resolve) => sentinel.once("exit", resolve));
  t.after(async () => { sentinel.kill("SIGTERM"); await sentinelExit; });
  const lab = await fixture(t, { FIXTURE_MODE: "runner-uncooperative" });
  const starter = lab.start();
  await waitForOutput(starter, "Stonehush ready at");
  const start = Date.now();
  starter.child.kill("SIGTERM");
  starter.child.kill("SIGTERM");
  assert.equal((await starter.exited).code, 143);
  assert.ok(Date.now() - start < 15_000);
  assert.equal(sentinel.exitCode, null);
  await assertReleased(lab.apiPort);
  await assertReleased(lab.webPort);
});

for (const mode of ["web-exit", "runner-exit"]) {
  test(`unexpected ${mode} cleans every owned listener and fails truthfully`, { timeout: 15_000 }, async (t) => {
    const lab = await fixture(t, { FIXTURE_MODE: mode });
    const process = lab.start();
    assert.equal((await process.exited).code, 1);
    assert.ok(!process.output().includes("Stonehush ready at"));
    await assertReleased(lab.apiPort);
    await assertReleased(lab.webPort);
  });
}

for (const [mode, marker] of [["api-unready", "fixture API listening"],
  ["web-unready", "fixture web listening"],
  ["enrollment-delay", "fixture enrollment request"], ["runner-unready", "fixture runner started"]]) {
  test(`signal during ${mode} prevents later startup and releases children`, { timeout: 15_000 }, async (t) => {
    const lab = await fixture(t, { FIXTURE_MODE: mode });
    const process = lab.start();
    await waitForOutput(process, marker);
    process.child.kill("SIGTERM");
    assert.equal((await process.exited).code, 143);
    assert.ok(!process.output().includes("Stonehush ready at"));
    if (mode !== "runner-unready") assert.ok(!process.output().includes("fixture runner started"));
    await assertReleased(lab.apiPort);
    await assertReleased(lab.webPort);
  });
}

for (const mode of ["failed-stop-probe", "failed-stop-signal"]) {
  for (const reuse of [false, true]) {
    test(`${mode} preserves ${reuse ? "reused" : "new"} identity for explicit recovery`, { timeout: 15_000 }, async (t) => {
      const lab = await fixture(t, {
        FIXTURE_MODE: mode,
        ...(reuse ? { STONEHUSH_RUNNER_ID: "fixture-runner", STONEHUSH_RUNNER_SECRET: secret } : {}),
      });
      const starter = lab.start();
      let runnerPid;
      t.after(() => {
        if (runnerPid !== undefined) {
          try { process.kill(-runnerPid, "SIGKILL"); } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        }
      });
      await waitForOutput(starter, "Stonehush ready at");
      runnerPid = Number(starter.output().match(/fixture runner started pid=(\d+)/)[1]);
      starter.child.kill("SIGTERM");
      assert.equal((await starter.exited).code, 1);
      assert.doesNotThrow(() => process.kill(runnerPid, 0));
      assert.match(starter.output(), /Owned runner shutdown could not be confirmed\. Revocation skipped\./);
      if (!reuse) assert.match(starter.output(), /Explicitly stop the owned runner and recover runner fixture-runner at recorded revision 1/);
      assert.doesNotMatch(starter.output(), /Revoked temporary runner|\/revoke/);
      assert.ok(!starter.output().includes(secret));
      assert.equal((starter.output().match(/fixture enrollment request/g) ?? []).length, reuse ? 0 : 2);
      await assertReleased(lab.apiPort);
      await assertReleased(lab.webPort);
    });
  }
}

test("childless failed runner spawn revokes only the confirmed launch identity", { timeout: 15_000 }, async (t) => {
  const lab = await fixture(t, { FIXTURE_MODE: "runner-spawn-failure" });
  const starter = lab.start();
  assert.equal((await starter.exited).code, 1);
  assert.ok(!starter.output().includes("Stonehush ready at"));
  assert.ok(!starter.output().includes("fixture runner started"));
  assert.match(starter.output(), /Revoked temporary runner fixture-runner/);
  assert.equal((starter.output().match(/fixture enrollment request.*\/revoke/g) ?? []).length, 1);
  assert.ok(!starter.output().includes(secret));
  await assertReleased(lab.apiPort);
  await assertReleased(lab.webPort);
});
