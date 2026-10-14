import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runOnce } from "./runner.js";

function urlTarget(url: string) {
  const parsed = new URL(url);
  return {
    kind: "url" as const,
    normalizationProfile: "d1-v1" as const,
    url,
    origin: `${parsed.protocol}//${parsed.host}`,
    host: { hostname: parsed.hostname } as never,
    effectivePort: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
    pathAndQuery: `${parsed.pathname}${parsed.search}`,
  };
}

function httpSnapshot(urls: string[]) {
  return {
    normalizationProfile: "d1-v1" as const,
    orchestrationProfile: "d2-v1" as const,
    snapshotId: "snapshot-http-1",
    version: 1,
    binding: `sha256:${"a".repeat(64)}`,
    actionId: "act-http-1",
    canonicalTargets: urls.map(urlTarget),
    concreteDestinations: [],
    typedOptions: {},
    resolutionSnapshots: [],
    scopeRevisionId: null,
    warningState: { reasonCodes: [], knownAdditions: [], acknowledgment: null },
  };
}

function leaseResponse(urls: string[]) {
  const now = new Date().toISOString();
  return {
    run: {
      id: "run-http-1",
      actionId: "act-http-1",
      engagementId: "eng-1",
      attempt: 1,
      state: "leased",
      currentLeaseId: "lease-http-1",
      currentFence: "1",
      terminalKind: null,
      terminalReason: null,
      createdAt: now,
      updatedAt: now,
      contractVersion: 1,
    },
    lease: {
      runId: "run-http-1",
      leaseId: "lease-http-1",
      runnerId: "runner-1",
      sessionId: "sess-1",
      fence: "1",
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      latestHeartbeatSequence: 0,
      latestEventSequence: 0,
      orchestrationProfile: "d2-v1",
      protocol: "runner-control-v1",
    },
    actionSnapshot: httpSnapshot(urls),
  };
}

function apiResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function startedResponse(): Response {
  return apiResponse({
    disposition: "accepted_event",
    event: {
      eventId: 1,
      runId: "run-http-1",
      sequence: 1,
      type: "started",
      fence: "1",
      payloadJson: "{}",
      digest: `sha256:${"a".repeat(64)}`,
      createdAt: new Date().toISOString(),
    },
  });
}

function completeResponse(kind: string): Response {
  return apiResponse({
    disposition: "accepted_completion",
    event: {
      eventId: 2,
      runId: "run-http-1",
      sequence: 2,
      type: kind,
      fence: "1",
      payloadJson: "{}",
      digest: `sha256:${"b".repeat(64)}`,
      createdAt: new Date().toISOString(),
    },
  });
}

describe("runner http probe abort and fence", () => {
  let dataDir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    dataDir = path.join(tmpdir(), `test-http-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(dataDir, { recursive: true });
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("body failure is recorded as fetch_failed, not a publication failure", async () => {
    const urls = ["http://127.0.0.1:8080/"];
    let completeBody: { terminalKind?: string; reason?: string | null } | null = null;
    let grantCalls = 0;
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const u = typeof input === "string" ? input : input.toString();
      if (u.includes("/handshake")) {
        return apiResponse({
          acceptedProtocol: "runner-control-v1",
          sessionId: "sess-1",
          runnerId: "runner-1",
          leaseAllowed: true,
          sessionPinned: true,
          registryPinned: false,
        });
      }
      if (u.includes("/lease") && !u.includes("/heartbeat") && !u.includes("/events") && !u.includes("/complete") && !u.includes("/artifacts")) {
        return apiResponse(leaseResponse(urls));
      }
      if (u.includes("/events") && !u.includes("/artifacts")) return startedResponse();
      if (u.includes("/heartbeat")) {
        return apiResponse({ leaseExpiresAt: new Date(Date.now() + 30000).toISOString(), heartbeatSequence: 2 });
      }
      if (u.includes("/artifacts/grants")) {
        grantCalls += 1;
        const b = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const slot = String(b.artifactSlot ?? "stdout");
        const isStdout = slot === "stdout";
        const isStderr = slot === "stderr";
        const artifactId = isStdout
          ? "00000000-0000-4000-8000-000000000001"
          : isStderr
            ? "00000000-0000-4000-8000-000000000002"
            : "00000000-0000-4000-8000-000000000003";
        const uploadId = isStdout
          ? "00000000-0000-4000-8000-000000000011"
          : isStderr
            ? "00000000-0000-4000-8000-000000000012"
            : "00000000-0000-4000-8000-000000000013";
        return apiResponse(
          {
            artifactId,
            uploadId,
            runId: "run-http-1",
            leaseId: "lease-http-1",
            sessionId: "sess-1",
            fence: "1",
            eventSequence: b.eventSequence,
            artifactSlot: slot,
            kind: b.kind,
            declaredSizeBytes: b.declaredSizeBytes,
            declaredDigest: b.declaredDigest,
            originalFileName: slot === "stdout" ? "stdout.log" : slot === "stderr" ? "stderr.log" : "http-probe.json",
            declaredContentType: slot === "stdout" || slot === "stderr" ? "text/plain; charset=utf-8" : "application/json",
            createdAt: new Date().toISOString(),
          },
          201,
        );
      }
      if (u.includes("/uploads/") && (init?.method ?? "GET") === "PUT") return new Response(null, { status: 204 });
      if (u.includes("/uploads/") && u.includes("/complete")) {
        const b = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const uploadId = u.split("/uploads/")[1]?.split("/")[0] ?? "";
        const artifactId =
          uploadId === "00000000-0000-4000-8000-000000000012"
            ? "00000000-0000-4000-8000-000000000002"
            : uploadId === "00000000-0000-4000-8000-000000000013"
              ? "00000000-0000-4000-8000-000000000003"
              : "00000000-0000-4000-8000-000000000001";
        return apiResponse({ disposition: "published", artifactId, sizeBytes: b.sizeBytes, digest: b.digest, completeness: b.completeness });
      }
      if (u.includes("/complete") && !u.includes("/artifacts")) {
        completeBody = JSON.parse(String(init?.body ?? "{}")) as { terminalKind?: string };
        return completeResponse(String(completeBody.terminalKind ?? "succeeded"));
      }
      if (u === "http://127.0.0.1:8080/") {
        // Body failure: headers ok but the stream errors mid-body.
        const errored = new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new Error("midstream boom"));
          },
        });
        return new Response(errored, { status: 200 }) as never;
      }
      return apiResponse({ code: "invalid_request" }, 400);
    }) as unknown as typeof fetch;

    const ok = await runOnce(
      { dataDir, runnerId: "runner-1", secret: "a".repeat(43), apiBaseUrl: "http://127.0.0.1:9", runRoot: path.join(dataDir, "runs") },
    );
    expect(ok).toBe(true);
    expect(completeBody).toMatchObject({ terminalKind: "succeeded" });
    expect(grantCalls).toBeGreaterThan(0);
  });

  it("no next URL after fence loss: stale heartbeat stops second probe", async () => {
    const urls = ["http://127.0.0.1:8080/", "http://127.0.0.1:8081/"];
    const probed: string[] = [];
    let completeBody: { terminalKind?: string; reason?: string | null } | null = null;
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const u = typeof input === "string" ? input : input.toString();
      if (u.includes("/handshake")) {
        return apiResponse({
          acceptedProtocol: "runner-control-v1",
          sessionId: "sess-1",
          runnerId: "runner-1",
          leaseAllowed: true,
          sessionPinned: true,
          registryPinned: false,
        });
      }
      if (u.includes("/lease") && !u.includes("/heartbeat") && !u.includes("/events") && !u.includes("/complete") && !u.includes("/artifacts")) {
        return apiResponse(leaseResponse(urls));
      }
      if (u.includes("/events") && !u.includes("/artifacts")) return startedResponse();
      if (u.includes("/heartbeat")) {
        if (probed.length === 0) return apiResponse({ leaseExpiresAt: new Date(Date.now() + 30000).toISOString(), heartbeatSequence: 2 });
        return apiResponse({ code: "stale_fence" }, 409);
      }
      if (u.includes("/complete") && !u.includes("/artifacts")) {
        completeBody = JSON.parse(String(init?.body ?? "{}")) as { terminalKind?: string };
        return completeResponse(String(completeBody.terminalKind ?? "failed"));
      }
      if (u === "http://127.0.0.1:8080/" || u === "http://127.0.0.1:8081/") {
        probed.push(u);
        // First probe takes 60ms so the 10ms heartbeat fence fires first.
        if (u === "http://127.0.0.1:8080/") await new Promise((r) => setTimeout(r, 60));
        return new Response("", { status: 200 }) as never;
      }
      return apiResponse({ code: "invalid_request" }, 400);
    }) as unknown as typeof fetch;

    const ok = await runOnce(
      {
        dataDir,
        runnerId: "runner-1",
        secret: "a".repeat(43),
        apiBaseUrl: "http://127.0.0.1:9",
        runRoot: path.join(dataDir, "runs"),
        heartbeatIntervalMs: 10,
        leaseDurationMs: 30000,
      },
    );
    expect(ok).toBe(true);
    expect(probed).toEqual(["http://127.0.0.1:8080/"]);
    expect(completeBody).toMatchObject({ terminalKind: "failed", reason: "runner_lost" });
  });

  it("expired lease never publishes: deadline expiry skips grants", async () => {
    const urls = ["http://127.0.0.1:8080/"];
    let grantCalls = 0;
    let completeBody: { terminalKind?: string; reason?: string | null } | null = null;
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const u = typeof input === "string" ? input : input.toString();
      if (u.includes("/handshake")) {
        return apiResponse({
          acceptedProtocol: "runner-control-v1",
          sessionId: "sess-1",
          runnerId: "runner-1",
          leaseAllowed: true,
          sessionPinned: true,
          registryPinned: false,
        });
      }
      if (u.includes("/lease") && !u.includes("/heartbeat") && !u.includes("/events") && !u.includes("/complete") && !u.includes("/artifacts")) {
        return apiResponse(leaseResponse(urls));
      }
      if (u.includes("/events") && !u.includes("/artifacts")) return startedResponse();
      if (u.includes("/heartbeat")) {
        return apiResponse({ leaseExpiresAt: new Date(Date.now() + 30000).toISOString(), heartbeatSequence: 2 });
      }
      if (u.includes("/artifacts/grants")) {
        grantCalls += 1;
        return apiResponse({ code: "stale_fence" }, 409);
      }
      if (u.includes("/complete") && !u.includes("/artifacts")) {
        completeBody = JSON.parse(String(init?.body ?? "{}")) as { terminalKind?: string };
        return completeResponse(String(completeBody.terminalKind ?? "failed"));
      }
      if (u === "http://127.0.0.1:8080/") {
        await new Promise((r) => setTimeout(r, 200));
        return new Response("", { status: 200 }) as never;
      }
      return apiResponse({ code: "invalid_request" }, 400);
    }) as unknown as typeof fetch;

    const ok = await runOnce(
      {
        dataDir,
        runnerId: "runner-1",
        secret: "a".repeat(43),
        apiBaseUrl: "http://127.0.0.1:9",
        runRoot: path.join(dataDir, "runs"),
        heartbeatIntervalMs: 10000,
        leaseDurationMs: 7100,
      },
    );
    expect(ok).toBe(true);
    expect(grantCalls).toBe(0);
    expect(completeBody).toMatchObject({ terminalKind: "failed", reason: "runner_lost" });
  });

  it("shutdown aborts in-flight probe promptly without waiting full timeout", async () => {
    const urls = ["http://127.0.0.1:8080/"];
    let completeBody: { terminalKind?: string; reason?: string | null } | null = null;
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const u = typeof input === "string" ? input : input.toString();
      if (u.includes("/handshake")) {
        return apiResponse({
          acceptedProtocol: "runner-control-v1",
          sessionId: "sess-1",
          runnerId: "runner-1",
          leaseAllowed: true,
          sessionPinned: true,
          registryPinned: false,
        });
      }
      if (u.includes("/lease") && !u.includes("/heartbeat") && !u.includes("/events") && !u.includes("/complete") && !u.includes("/artifacts")) {
        return apiResponse(leaseResponse(urls));
      }
      if (u.includes("/events") && !u.includes("/artifacts")) return startedResponse();
      if (u.includes("/heartbeat")) {
        return apiResponse({ leaseExpiresAt: new Date(Date.now() + 30000).toISOString(), heartbeatSequence: 2 });
      }
      if (u.includes("/complete") && !u.includes("/artifacts")) {
        completeBody = JSON.parse(String(init?.body ?? "{}")) as { terminalKind?: string };
        return completeResponse(String(completeBody.terminalKind ?? "failed"));
      }
      if (u === "http://127.0.0.1:8080/") {
        const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
        // Hanging probe that only settles via abort.
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
        return new Response("", { status: 200 }) as never;
      }
      return apiResponse({ code: "invalid_request" }, 400);
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const start = Date.now();
    const pending = runOnce(
      { dataDir, runnerId: "runner-1", secret: "a".repeat(43), apiBaseUrl: "http://127.0.0.1:9", runRoot: path.join(dataDir, "runs") },
      { signal: controller.signal },
    );
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("runOnce did not abort promptly")), 1500));
    await expect(Promise.race([pending, timeout])).rejects.toMatchObject({ name: "RunnerShutdownError" });
    expect(Date.now() - start).toBeLessThan(1500);
    expect(completeBody).toMatchObject({ terminalKind: "failed", reason: "runner_lost" });
  }, 10000);
});
