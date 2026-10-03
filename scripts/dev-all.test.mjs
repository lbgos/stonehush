import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { childReady, resolveCombinedConfig, superviseWait, waitForWebReadiness } from "./dev-all.mjs";
import { createStopState } from "./demo-lifecycle.mjs";

const repositoryRoot = "/tmp/stonehush-combined-fixture";
const pending = () => new Promise(() => {});

test("combined config keeps dev defaults and accepted runner overrides", () => {
  const defaults = resolveCombinedConfig({}, repositoryRoot);
  assert.equal(defaults.dev.apiPort, 3001);
  assert.equal(defaults.dev.webPort, 5173);
  assert.equal(defaults.dev.dataDirectory, `${repositoryRoot}/.stonehush/dev`);
  assert.equal(defaults.runner.runnerDataDir, `${repositoryRoot}/.stonehush/dev/runner`);
  const explicit = resolveCombinedConfig({
    STONEHUSH_API_PORT: "18811", STONEHUSH_WEB_PORT: "18812",
    STONEHUSH_DATA_DIR: "/tmp/combined-data", STONEHUSH_RUNNER_DATA_DIR: "/tmp/combined-runner",
    STONEHUSH_API_BASE_URL: "http://localhost:18811/",
    STONEHUSH_NMAP_EXECUTABLE: "/tmp/nmap-fixture",
  }, repositoryRoot);
  assert.equal(explicit.runner.apiBaseUrl, "http://127.0.0.1:18811");
  assert.equal(explicit.runner.runnerDataDir, "/tmp/combined-runner");
  assert.equal(explicit.runner.nmapExecutable, "/tmp/nmap-fixture");
});

test("combined config rejects a foreign service before startup", () => {
  for (const url of ["http://127.0.0.1:9000", "http://192.0.2.1:3001",
    "https://127.0.0.1:3001", "http://127.0.0.1:3001/api", "http://user@127.0.0.1:3001",
    "http://127.0.0.1:3001/?ignored=1", "http://127.0.0.1:3001/#fragment"]) {
    assert.throws(() => resolveCombinedConfig({ STONEHUSH_API_BASE_URL: url }, repositoryRoot), /must match/);
  }
});

test("combined config rejects partial and malformed credentials without echo", () => {
  for (const env of [
    { STONEHUSH_RUNNER_SECRET: "synthetic-rejected-secret" },
    { STONEHUSH_RUNNER_ID: "runner-fixture", STONEHUSH_RUNNER_SECRET: "synthetic-rejected-secret" },
  ]) {
    assert.throws(() => resolveCombinedConfig(env, repositoryRoot), (error) => {
      assert.ok(!error.message.includes(env.STONEHUSH_RUNNER_SECRET));
      return true;
    });
  }
});

test("only the exact owned-child notification satisfies readiness", async () => {
  const child = new EventEmitter();
  const ready = childReady(child, "stonehush-runner-ready");
  let settled = false;
  ready.then(() => { settled = true; });
  child.emit("message", { type: "stonehush-api-ready" });
  child.emit("message", { type: "stonehush-runner-ready", secret: "unexpected" });
  await Promise.resolve();
  assert.equal(settled, false);
  child.emit("message", { type: "stonehush-runner-ready" });
  await ready;
  assert.equal(child.listenerCount("message"), 0);
  assert.equal(child.listenerCount("disconnect"), 0);
});

test("disconnect before accepted readiness fails and removes listeners", async () => {
  const child = new EventEmitter();
  const ready = childReady(child, "stonehush-api-ready");
  child.emit("disconnect");
  await assert.rejects(ready, /before readiness/);
  assert.equal(child.listenerCount("message"), 0);
});

test("every startup wait fails promptly for any owned child exit", async () => {
  await assert.rejects(superviseWait(pending(), {
    registry: { anyExit: () => Promise.resolve({ code: 0 }) }, stop: createStopState(),
  }), /exited unexpectedly/);
});

test("startup wait stops on signal and has a finite deadline", async () => {
  const stop = createStopState();
  const waiting = superviseWait(pending(), { registry: { anyExit: pending }, stop });
  stop.requestStop("SIGTERM");
  await assert.rejects(waiting, /stopped/);
  await assert.rejects(superviseWait(pending(), {
    registry: { anyExit: pending }, stop: createStopState(), timeoutMs: 5,
  }), /deadline/);
});

test("running wait has no startup deadline", async () => {
  const stop = createStopState();
  const waiting = superviseWait(pending(), {
    registry: { anyExit: pending }, stop, timeoutMs: Infinity,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  stop.requestStop("SIGINT");
  await assert.rejects(waiting, /stopped/);
});

test("web readiness requires the app page and exact proxied API health", async () => {
  const requests = [];
  await waitForWebReadiness({
    url: "http://127.0.0.1:18812", signal: new AbortController().signal,
    fetchImplementation: async (url) => {
      requests.push(url);
      return url.endsWith("/health")
        ? new Response(JSON.stringify({ status: "ok" }), { status: 200 })
        : new Response('<html><div id="root"></div></html>', { status: 200 });
    },
  });
  assert.deepEqual(requests, ["http://127.0.0.1:18812", "http://127.0.0.1:18812/health"]);
});

test("web readiness aborts a pending request", async () => {
  const controller = new AbortController();
  const waiting = waitForWebReadiness({
    url: "http://127.0.0.1:18812", signal: controller.signal,
    fetchImplementation: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
});
