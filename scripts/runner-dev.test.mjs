import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  buildRunnerChildEnv,
  devFingerprint,
  enrollRunner,
  resolveRunnerDevConfig,
  revokeEnrolledRunner,
  runnerSpawnArgs,
} from "./runner-dev.mjs";

const ROOT = "/tmp/stonehush-runner-dev-test";
const VALID_SECRET = "a".repeat(43);
const VALID_SECRET_2 = `A${"b".repeat(41)}_`;

function envWith(overrides = {}) {
  return { ...overrides };
}

test("defaults to dev API 3001 and isolated runner data dir", () => {
  const plan = resolveRunnerDevConfig({ env: envWith(), repositoryRoot: ROOT, now: () => 7 });
  assert.equal(plan.apiBaseUrl, "http://127.0.0.1:3001");
  assert.equal(plan.runnerDataDir, path.join(ROOT, ".stonehush", "dev", "runner"));
  assert.equal(plan.runnerName, "dev-runner-7");
  assert.equal(plan.reuse, false);
  assert.match(plan.fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(plan.nmapExecutable, "/usr/bin/nmap");
});

test("dev fingerprint is stable and valid", () => {
  assert.equal(devFingerprint(), devFingerprint());
  assert.match(devFingerprint(), /^sha256:[0-9a-f]{64}$/);
});

test("respects explicit API base URL and strips trailing slashes", () => {
  const plan = resolveRunnerDevConfig({
    env: envWith({ STONEHUSH_API_BASE_URL: "http://127.0.0.1:18511///" }),
    repositoryRoot: ROOT,
  });
  assert.equal(plan.apiBaseUrl, "http://127.0.0.1:18511");
});

test("derives API base from STONEHUSH_API_PORT when no base URL", () => {
  const plan = resolveRunnerDevConfig({
    env: envWith({ STONEHUSH_API_PORT: "18511" }),
    repositoryRoot: ROOT,
  });
  assert.equal(plan.apiBaseUrl, "http://127.0.0.1:18511");
});

test("rejects malformed API base URL and ports", () => {
  assert.throws(
    () => resolveRunnerDevConfig({ env: envWith({ STONEHUSH_API_BASE_URL: "not-a-url" }), repositoryRoot: ROOT }),
    /STONEHUSH_API_BASE_URL must be a valid/,
  );
  assert.throws(
    () => resolveRunnerDevConfig({ env: envWith({ STONEHUSH_API_BASE_URL: "ftp://127.0.0.1:3001" }), repositoryRoot: ROOT }),
    /must use http or https/,
  );
  assert.throws(
    () => resolveRunnerDevConfig({ env: envWith({ STONEHUSH_API_PORT: "0" }), repositoryRoot: ROOT }),
    /decimal integer/,
  );
  assert.throws(
    () => resolveRunnerDevConfig({ env: envWith({ STONEHUSH_API_PORT: "abc" }), repositoryRoot: ROOT }),
    /decimal integer/,
  );
});

test("reuses valid credential env without enrollment", () => {
  const plan = resolveRunnerDevConfig({
    env: envWith({ STONEHUSH_RUNNER_ID: "runner-1", STONEHUSH_RUNNER_SECRET: VALID_SECRET }),
    repositoryRoot: ROOT,
  });
  assert.equal(plan.reuse, true);
  assert.equal(plan.runnerId, "runner-1");
  assert.equal(plan.runnerSecret, VALID_SECRET);
});

test("fails on partial credentials without leaking the secret", () => {
  for (const env of [
    envWith({ STONEHUSH_RUNNER_ID: "runner-1" }),
    envWith({ STONEHUSH_RUNNER_SECRET: VALID_SECRET }),
  ]) {
    let message = "";
    try {
      resolveRunnerDevConfig({ env, repositoryRoot: ROOT });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.match(message, /Partial runner credentials/);
    assert.ok(!message.includes(VALID_SECRET), "error must not contain the secret");
  }
});

test("rejects malformed secret without printing it", () => {
  for (const badSecret of ["short", `${"A".repeat(42)}!`]) {
    let message = "";
    try {
      resolveRunnerDevConfig({
        env: envWith({ STONEHUSH_RUNNER_ID: "runner-1", STONEHUSH_RUNNER_SECRET: badSecret }),
        repositoryRoot: ROOT,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.match(message, /looks malformed/);
    assert.ok(!message.includes(badSecret), "error must not echo the rejected secret");
  }
});

test("rejects malformed fingerprint, data dir, executable, and name", () => {
  assert.throws(
    () =>
      resolveRunnerDevConfig({
        env: envWith({ STONEHUSH_INSTALLATION_FINGERPRINT: "bad" }),
        repositoryRoot: ROOT,
      }),
    /INSTALLATION_FINGERPRINT/,
  );
  assert.throws(
    () =>
      resolveRunnerDevConfig({
        env: envWith({ STONEHUSH_RUNNER_DATA_DIR: "relative/path" }),
        repositoryRoot: ROOT,
      }),
    /STONEHUSH_RUNNER_DATA_DIR must be/,
  );
  assert.throws(
    () =>
      resolveRunnerDevConfig({
        env: envWith({ STONEHUSH_NMAP_EXECUTABLE: "relative/nmap" }),
        repositoryRoot: ROOT,
      }),
    /STONEHUSH_NMAP_EXECUTABLE must be/,
  );
  assert.throws(
    () =>
      resolveRunnerDevConfig({
        env: envWith({ STONEHUSH_RUNNER_NAME: "  spaced  " }),
        repositoryRoot: ROOT,
      }),
    /STONEHUSH_RUNNER_NAME/,
  );
});

test("derives runner data dir from STONEHUSH_DATA_DIR semantics", () => {
  const plan = resolveRunnerDevConfig({
    env: envWith({ STONEHUSH_DATA_DIR: "/tmp/stonehush-data" }),
    repositoryRoot: ROOT,
  });
  assert.equal(plan.runnerDataDir, path.join("/tmp/stonehush-data", "runner"));
  const explicit = resolveRunnerDevConfig({
    env: envWith({ STONEHUSH_RUNNER_DATA_DIR: "/tmp/custom-runner" }),
    repositoryRoot: ROOT,
  });
  assert.equal(explicit.runnerDataDir, "/tmp/custom-runner");
});

test("spawn args are argv-only with no secret and no shell", async () => {
  const { command, args } = runnerSpawnArgs({
    pnpmProgram: "/usr/bin/pnpm",
    runnerAbsolutePath: "/repo/apps/runner/src/index.ts",
  });
  assert.equal(typeof command, "string");
  assert.ok(Array.isArray(args));
  assert.ok(!args.join("\0").includes(VALID_SECRET));
  assert.ok(!args.join(" ").includes(VALID_SECRET));
  for (const entry of args) {
    assert.equal(typeof entry, "string");
    assert.ok(!entry.includes("\0"));
  }
  assert.ok(args.includes("--filter"));
  assert.ok(args.includes("@stonehush/api"));
  assert.ok(args.includes("tsx"));
});

test("child env carries credentials in memory only, args stay clean", () => {
  const plan = resolveRunnerDevConfig({ env: envWith(), repositoryRoot: ROOT });
  const childEnv = buildRunnerChildEnv({
    baseEnv: { PATH: "/usr/bin" },
    plan,
    runnerId: "runner-1",
    runnerSecret: VALID_SECRET_2,
  });
  assert.equal(childEnv.STONEHUSH_RUNNER_ID, "runner-1");
  assert.equal(childEnv.STONEHUSH_RUNNER_SECRET, VALID_SECRET_2);
  assert.equal(childEnv.STONEHUSH_API_BASE_URL, plan.apiBaseUrl);
  assert.equal(childEnv.STONEHUSH_RUNNER_DATA_DIR, plan.runnerDataDir);
  const { args } = runnerSpawnArgs({ pnpmProgram: "/x", runnerAbsolutePath: "/y" });
  assert.ok(!args.join(" ").includes(VALID_SECRET_2));
});

test("enrollment uses existing challenge and confirm endpoints with owner confirmation", async () => {
  const calls = [];
  const stop = { stopSignal: undefined, throwIfStopping: () => {} };
  const fakeFetch = async (base, method, urlPath, { body, idempotencyKey, signal } = {}) => {
    calls.push({ base, method, urlPath, body, idempotencyKey, signal });
    if (urlPath === "/api/v1/runners/enrollment-challenges") {
      assert.equal(body.ownerConfirmed, undefined);
      assert.equal(typeof body.name, "string");
      assert.match(body.installationFingerprint, /^sha256:/);
      return { challengeId: "challenge-1" };
    }
    assert.match(urlPath, /\/confirm$/);
    assert.deepEqual(body, { ownerConfirmed: true });
    return { runner: { id: "runner-9", revision: 1, status: "enabled", installationFingerprint: devFingerprint(), name: "dev-runner-1" }, secret: VALID_SECRET };
  };
  const result = await enrollRunner({
    apiBaseUrl: "http://127.0.0.1:9",
    fingerprint: devFingerprint(),
    runnerName: "dev-runner-1",
    stop,
    fetchJson: fakeFetch,
  });
  assert.equal(result.runnerId, "runner-9");
  assert.equal(result.runnerRevision, 1);
  assert.equal(result.runnerSecret, VALID_SECRET);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].urlPath, "/api/v1/runners/enrollment-challenges");
  for (const call of calls) {
    assert.equal(typeof call.idempotencyKey, "string");
    assert.match(call.idempotencyKey, /^[0-9a-f-]{36}$/);
  }
  assert.notEqual(calls[0].idempotencyKey, calls[1].idempotencyKey);
});

test("enrollment failure carries status without secret leakage", async () => {
  const stop = { stopSignal: undefined, throwIfStopping: () => {} };
  const failing = async () => {
    throw new Error("POST /api/v1/runners/enrollment-challenges failed status 410 code challenge_expired.");
  };
  let message = "";
  try {
    await enrollRunner({
      apiBaseUrl: "http://127.0.0.1:9",
      fingerprint: devFingerprint(),
      runnerName: "dev-runner-1",
      stop,
      fetchJson: failing,
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.match(message, /410/);
  assert.ok(!message.includes(VALID_SECRET));
});

test("enrollment rejects missing or malformed secret without storing it", async () => {
  const stop = { stopSignal: undefined, throwIfStopping: () => {} };
  const noSecret = async (base, method, urlPath) => {
    if (urlPath.endsWith("/confirm")) return { runner: { id: "runner-1", revision: 1, status: "enabled", installationFingerprint: devFingerprint(), name: "dev-runner-1" }, secret: "bad" };
    return { challengeId: "c1" };
  };
  await assert.rejects(
    enrollRunner({
      apiBaseUrl: "http://127.0.0.1:9",
      fingerprint: devFingerprint(),
      runnerName: "dev-runner-1",
      stop,
      fetchJson: noSecret,
    }),
    /no usable runner secret/,
  );
});

test("signals during API readiness exit promptly and leave the API running", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "stonehush-runner-dev-stop-"));
  try {
    for (const [signal, expectedCode] of [["SIGINT", 130], ["SIGTERM", 143]]) {
      const firstProbe = Promise.withResolvers();
      let enrollmentRequests = 0;
      const api = createServer((request, response) => {
        if (request.method === "POST") enrollmentRequests += 1;
        response.writeHead(503).end();
        firstProbe.resolve();
      });
      api.listen(0, "127.0.0.1");
      await once(api, "listening");
      const baseUrl = `http://127.0.0.1:${api.address().port}`;
      const child = spawn(process.execPath, [path.join(import.meta.dirname, "runner-dev.mjs")], {
        env: {
          PATH: process.env.PATH,
          npm_execpath: "/usr/bin/pnpm",
          STONEHUSH_API_BASE_URL: baseUrl,
          STONEHUSH_NMAP_EXECUTABLE: "/usr/bin/true",
          STONEHUSH_RUNNER_DATA_DIR: dataDir,
        },
        stdio: "ignore",
      });
      const exited = once(child, "exit");
      try {
        await Promise.race([
          firstProbe.promise,
          exited.then(() => { throw new Error("Starter exited before readiness probing."); }),
          delay(5_000, undefined, { ref: false }).then(() => { throw new Error("Readiness probe did not start."); }),
        ]);
        child.kill(signal);
        const result = await Promise.race([
          exited,
          delay(2_000, undefined, { ref: false }).then(() => { throw new Error("Signal did not stop readiness promptly."); }),
        ]);
        assert.deepEqual(result, [expectedCode, null]);
        assert.equal((await fetch(`${baseUrl}/health`)).status, 503);
        assert.equal(enrollmentRequests, 0);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
        api.closeAllConnections();
        await new Promise((resolve) => api.close(resolve));
      }
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("revocation uses the recorded identity and revision without the stop signal", async () => {
  const calls = [];
  await revokeEnrolledRunner({
    apiBaseUrl: "http://127.0.0.1:9",
    runnerId: "runner/owned",
    runnerRevision: 3,
    fetchJson: async (base, method, urlPath, options) => {
      calls.push({ base, method, urlPath, options });
      return { runner: { id: "runner/owned", revision: 4, status: "revoked" } };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].urlPath, "/api/v1/runners/runner%2Fowned/revoke");
  assert.deepEqual(calls[0].options.body, { expectedRevision: 3 });
  assert.match(calls[0].options.idempotencyKey, /^[0-9a-f-]{36}$/);
  assert.equal(calls[0].options.signal, undefined);
  for (const runner of [undefined, { id: "another", revision: 4, status: "revoked" }, { id: "runner/owned", revision: 3, status: "enabled" }]) {
    await assert.rejects(revokeEnrolledRunner({
      apiBaseUrl: "http://127.0.0.1:9",
      runnerId: "runner/owned",
      runnerRevision: 3,
      fetchJson: async () => ({ runner }),
    }), /no matching revoked identity/);
  }
});

test("starter cleans up only confirmed new identities after its child exits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-runner-dev-lifecycle-"));
  const fixture = path.join(root, "fixture-runner.cjs");
  await writeFile(fixture, `
    console.log('fixture-runner-ready:' + process.pid);
    if (process.env.RUNNER_FIXTURE_FAIL === '1') process.exit(7);
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 50);
  `);
  try {
    for (const scenario of ["normal", "startup-failure", "reused", "uncertain-confirm", "invalid-confirm", "failed-revoke"]) {
      const calls = [];
      let runnerPid;
      let childAliveAtRevoke;
      const api = createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        calls.push({ method: request.method, url: request.url, body, key: request.headers["idempotency-key"] });
        response.setHeader("content-type", "application/json");
        if (request.url === "/health") {
          response.end(JSON.stringify({ status: "ok" }));
        } else if (request.url === "/api/v1/runners/enrollment-challenges") {
          response.writeHead(201).end(JSON.stringify({ challengeId: "challenge-owned" }));
        } else if (request.url.endsWith("/confirm")) {
          if (scenario === "uncertain-confirm") {
            response.writeHead(503).end(JSON.stringify({ code: "confirmation_response_lost" }));
          } else {
            response.writeHead(201).end(JSON.stringify({ runner: { id: "runner-owned", revision: 1, status: "enabled", installationFingerprint: devFingerprint(), name: scenario === "invalid-confirm" ? "another-launch" : "lifecycle-fixture" }, secret: VALID_SECRET }));
          }
        } else if (request.url === "/api/v1/runners/runner-owned/revoke") {
          try { process.kill(runnerPid, 0); childAliveAtRevoke = true; } catch { childAliveAtRevoke = false; }
          if (scenario === "failed-revoke") {
            response.writeHead(503).end(JSON.stringify({ code: "unavailable" }));
          } else {
            response.end(JSON.stringify({ runner: { id: "runner-owned", revision: 2, status: "revoked" } }));
          }
        } else {
          response.writeHead(404).end(JSON.stringify({ code: "unexpected_request" }));
        }
      });
      api.listen(0, "127.0.0.1");
      await once(api, "listening");
      const baseUrl = `http://127.0.0.1:${api.address().port}`;
      const child = spawn(process.execPath, [path.join(import.meta.dirname, "runner-dev.mjs")], {
        env: {
          PATH: process.env.PATH,
          npm_execpath: fixture,
          STONEHUSH_API_BASE_URL: baseUrl,
          STONEHUSH_NMAP_EXECUTABLE: "/usr/bin/true",
          STONEHUSH_RUNNER_DATA_DIR: path.join(root, "data"),
          STONEHUSH_RUNNER_NAME: "lifecycle-fixture",
          ...(scenario === "reused" ? { STONEHUSH_RUNNER_ID: "runner-existing", STONEHUSH_RUNNER_SECRET: VALID_SECRET } : {}),
          ...(scenario === "startup-failure" ? { RUNNER_FIXTURE_FAIL: "1" } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const ready = Promise.withResolvers();
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
        const matched = output.match(/fixture-runner-ready:(\d+)/);
        if (matched) { runnerPid = Number(matched[1]); ready.resolve(); }
      });
      child.stderr.on("data", (chunk) => { output += chunk; });
      const exited = once(child, "exit");
      try {
        if (!["uncertain-confirm", "invalid-confirm", "startup-failure"].includes(scenario)) {
          await Promise.race([ready.promise, exited.then(() => { throw new Error("Fixture runner did not start."); }), delay(5_000, undefined, { ref: false }).then(() => { throw new Error("Fixture runner startup timed out."); })]);
          child.kill("SIGTERM");
        }
        const [code, signal] = await Promise.race([exited, delay(15_000, undefined, { ref: false }).then(() => { throw new Error("Lifecycle cleanup timed out."); })]);
        assert.equal(signal, null);
        assert.equal(code, ["startup-failure", "uncertain-confirm", "invalid-confirm"].includes(scenario) ? 1 : 143);
        const mutations = calls.filter((call) => call.method === "POST");
        const revokes = mutations.filter((call) => call.url.endsWith("/revoke"));
        if (scenario === "reused") {
          assert.equal(mutations.length, 0);
        } else if (scenario === "uncertain-confirm" || scenario === "invalid-confirm") {
          assert.equal(revokes.length, 0);
          assert.match(output, /Confirmation may have enabled a runner/);
        } else {
          assert.equal(revokes.length, 1);
          assert.deepEqual(JSON.parse(revokes[0].body), { expectedRevision: 1 });
          assert.match(revokes[0].key, /^[0-9a-f-]{36}$/);
          assert.equal(childAliveAtRevoke, false);
          if (scenario === "failed-revoke") assert.match(output, /Explicitly recover runner runner-owned at recorded revision 1/);
          else assert.match(output, /Revoked temporary runner runner-owned/);
        }
        assert.ok(!output.includes(VALID_SECRET));
        assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await exited;
        api.closeAllConnections();
        await new Promise((resolve) => api.close(resolve));
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
