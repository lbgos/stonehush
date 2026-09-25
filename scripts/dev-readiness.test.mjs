import assert from "node:assert/strict";
import test from "node:test";

import {
  probeApiHealth,
  startApiThenWeb,
  waitForApiReadiness,
} from "./dev-readiness.mjs";

function response(payload, status = 200) {
  return { json: async () => payload, status };
}

test("health readiness accepts only the exact 200 health response and sends an abort signal", async () => {
  let requestOptions;
  assert.equal(
    await probeApiHealth(async (_url, options) => {
      requestOptions = options;
      return response({ status: "ok" });
    }, "http://127.0.0.1:3001/health"),
    true,
  );
  assert.equal(requestOptions.method, "GET");
  assert.ok(requestOptions.signal instanceof AbortSignal);

  for (const candidate of [
    response({ status: "ok", detail: true }),
    response({ status: "down" }),
    response({ status: "ok" }, 503),
  ]) {
    assert.equal(await probeApiHealth(async () => candidate, "http://127.0.0.1/health"), false);
  }
});

test("development startup is API-first", async () => {
  const order = [];
  const api = { running: true };

  const children = await startApiThenWeb({
    apiIsRunning: (candidate) => candidate.running,
    startApi() {
      order.push("start API");
      return api;
    },
    async waitUntilReady(candidate) {
      assert.equal(candidate, api);
      order.push("API ready");
    },
    startWeb() {
      order.push("start web");
      return { running: true };
    },
  });

  assert.deepEqual(order, ["start API", "API ready", "start web"]);
  assert.equal(children.api, api);
});

test("API readiness failure prevents web startup", async () => {
  let webStarted = false;
  await assert.rejects(
    startApiThenWeb({
      apiIsRunning: () => true,
      startApi: () => ({ running: true }),
      waitUntilReady: async () => {
        throw new Error("not ready");
      },
      startWeb() {
        webStarted = true;
        return { running: true };
      },
    }),
    /not ready/,
  );
  assert.equal(webStarted, false);
});

test("shutdown during API readiness prevents a late web process", async () => {
  const controller = new AbortController();
  const ready = Promise.withResolvers();
  const children = [];
  const startup = startApiThenWeb({
    signal: controller.signal,
    apiIsRunning: () => true,
    startApi: () => children.push("API"),
    startWeb: () => children.push("web"),
    waitUntilReady: () => ready.promise,
  });
  const stopping = [...children];
  controller.abort();
  ready.resolve();
  await assert.rejects(startup, { name: "AbortError" });
  assert.deepEqual(children, stopping);
  assert.deepEqual(children, ["API"]);
});

test("API readiness uses a finite deadline", async () => {
  let clock = 0;
  let probes = 0;
  const exited = new Promise(() => undefined);

  await assert.rejects(
    waitForApiReadiness({
      exited,
      fetchImplementation: async () => {
        probes += 1;
        return response({ status: "down" });
      },
      now: () => clock,
      pause: async (milliseconds) => {
        clock += milliseconds;
      },
      timeoutMs: 100,
      url: "http://127.0.0.1:3001/health",
    }),
    /startup deadline/,
  );
  assert.equal(probes, 2);
});

test("API exit fails readiness immediately", async () => {
  await assert.rejects(
    waitForApiReadiness({
      exited: Promise.resolve({ code: 1, signal: null }),
      fetchImplementation: async () => new Promise(() => undefined),
      url: "http://127.0.0.1:3001/health",
    }),
    /exited before it became ready/,
  );
});
