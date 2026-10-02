import { afterEach, expect, it, vi } from "vitest";
import { runOnce } from "./runner.js";

const config = {
  runnerId: "runner-startup-fixture", secret: "s".repeat(43), sessionId: "startup-session",
  apiBaseUrl: "http://127.0.0.1:18811",
  installationFingerprint: `sha256:${"a".repeat(64)}`,
};

afterEach(() => vi.unstubAllGlobals());

it("notifies readiness only after the child's accepted handshake", async () => {
  const order: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/handshake")) {
      order.push("accepted handshake");
      return Response.json({
        acceptedProtocol: "runner-control-v1", sessionId: config.sessionId,
        runnerId: config.runnerId, leaseAllowed: true, sessionPinned: true, registryPinned: false,
      });
    }
    order.push("lease");
    return new Response(null, { status: 204 });
  }));
  await expect(runOnce(config, { onHandshake: () => { order.push("ready"); } })).resolves.toBe(false);
  expect(order).toEqual(["accepted handshake", "ready", "lease"]);
});

it("rejected credentials never notify readiness", async () => {
  const ready = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));
  await expect(runOnce(config, { onHandshake: ready })).rejects.toThrow("handshake failed 401");
  expect(ready).not.toHaveBeenCalled();
});

it("shutdown aborts a pending handshake before a readiness notification", async () => {
  const controller = new AbortController();
  const ready = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
  })));
  const started = runOnce(config, { signal: controller.signal, onHandshake: ready });
  controller.abort();
  await expect(started).rejects.toThrow();
  expect(ready).not.toHaveBeenCalled();
});
