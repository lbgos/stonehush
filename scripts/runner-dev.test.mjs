import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  buildRunnerChildEnv,
  devFingerprint,
  enrollRunner,
  resolveRunnerDevConfig,
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
    return { runner: { id: "runner-9" }, secret: VALID_SECRET };
  };
  const result = await enrollRunner({
    apiBaseUrl: "http://127.0.0.1:9",
    fingerprint: devFingerprint(),
    runnerName: "dev-runner-1",
    stop,
    fetchJson: fakeFetch,
  });
  assert.equal(result.runnerId, "runner-9");
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
    if (urlPath.endsWith("/confirm")) return { runner: { id: "runner-1" }, secret: "bad" };
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
