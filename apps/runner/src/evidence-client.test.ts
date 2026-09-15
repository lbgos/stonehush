import { createHash } from "node:crypto";
import { mkdir, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import { EvidencePublicationError, publishEvidenceArtifacts } from "./evidence-client.js";
import { runOnce } from "./runner.js";

function sha256(buffer: Buffer): string {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

describe("evidence publishing grant flow", () => {
  let dataDir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    dataDir = path.join(tmpdir(), `test-evid-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(dataDir, { recursive: true });
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("exact 6-request order for two streams and byte/digest/headers", async () => {
    const lease = { runId: "run-1", leaseId: "lease-1", sessionId: "sess-1", fence: "1" };
    const config = { dataDir, runnerId: "runner-1", secret: "a".repeat(43), apiBaseUrl: "http://127.0.0.1:9", runRoot: path.join(dataDir, "runs"), sessionId: "sess-1", installationFingerprint: "sha256:" + "a".repeat(64), heartbeatIntervalMs: 10000, leaseDurationMs: 30000, executable: process.execPath } as const;
    const stdout = Buffer.from("hello stdout", "utf8");
    const stderr = Buffer.from("hello stderr", "utf8");
    const result = {
      exitCode: 0,
      signal: null,
      stdout,
      stderr,
      stdoutMeta: { inputBytesSeen: stdout.length, redactedBytesProduced: stdout.length, bytesRetained: stdout.length, bytesDropped: 0, firstDroppedRedactedOffset: null, truncated: false },
      stderrMeta: { inputBytesSeen: stderr.length, redactedBytesProduced: stderr.length, bytesRetained: stderr.length, bytesDropped: 0, firstDroppedRedactedOffset: null, truncated: false },
      truncated: false,
    } as unknown as import("./process.js").ProcessResult;

    const requests: { method: string; url: string; headers: Record<string, string>; body: unknown }[] = [];
    const grantIds = new Map<string, { artifactId: string; uploadId: string }>();
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      const method = init?.method ?? "GET";
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = String(v);
      let body: unknown = init?.body;
      if (typeof body === "string") {
        try { body = JSON.parse(body); } catch {}
      }
      requests.push({ method, url: u, headers, body });
      if (u.includes("/artifacts/grants")) {
        const b = body as Record<string, unknown>;
        const slot = b.artifactSlot as string;
        const artifactId = `00000000-0000-4000-8000-${slot === "stdout" ? "000000000001" : "000000000002"}`;
        const uploadId = `00000000-0000-4000-8000-${slot === "stdout" ? "000000000011" : "000000000012"}`;
        grantIds.set(slot, { artifactId, uploadId });
        return new Response(JSON.stringify({ artifactId, uploadId, runId: lease.runId, leaseId: lease.leaseId, sessionId: lease.sessionId, fence: lease.fence, eventSequence: (b.eventSequence as number), artifactSlot: slot, kind: slot, declaredSizeBytes: (b.declaredSizeBytes as number), declaredDigest: b.declaredDigest, originalFileName: b.originalFileName, declaredContentType: b.declaredContentType, createdAt: new Date().toISOString() }), { status: 201, headers: { "content-type": "application/json" } });
      }
      if (u.includes("/uploads/") && method === "PUT") {
        return new Response(null, { status: 204 });
      }
      if (u.includes("/complete") && method === "POST") {
        const b = body as Record<string, unknown>;
        return new Response(JSON.stringify({ disposition: "published", artifactId: (grantIds.get(b.uploadId === grantIds.get("stdout")?.uploadId ? "stdout" : "stderr")?.artifactId ?? "x"), sizeBytes: b.sizeBytes, digest: b.digest, completeness: b.completeness }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ code: "invalid_request" }), { status: 400 });
    }) as unknown as typeof fetch;

    await publishEvidenceArtifacts(config as unknown as import("./config.js").RunnerConfig, lease, result, { isCancelled: false, eventSequence: 2 });

    // 6 requests order
    expect(requests.length).toBe(6);
    expect(requests[0]?.url).toContain("/artifacts/grants");
    expect(requests[0]?.body).toHaveProperty("artifactSlot", "stdout");
    expect(requests[1]?.method).toBe("PUT");
    expect(requests[1]?.url).toContain("/uploads/");
    expect(requests[2]?.url).toContain("/complete");
    expect(requests[3]?.url).toContain("/artifacts/grants");
    expect(requests[3]?.body).toHaveProperty("artifactSlot", "stderr");
    expect(requests[4]?.method).toBe("PUT");
    expect(requests[5]?.url).toContain("/complete");

    // byte/digest/headers for stdout
    const stdoutGrant = requests[0]?.body as Record<string, unknown>;
    expect(stdoutGrant.declaredSizeBytes).toBe(stdout.length);
    expect(stdoutGrant.declaredDigest).toBe(sha256(stdout));
    expect(stdoutGrant.originalFileName).toBe("stdout.log");
    expect(stdoutGrant.declaredContentType).toBe("text/plain; charset=utf-8");
    expect(stdoutGrant.eventSequence).toBe(2);
    expect(stdoutGrant.kind).toBe("stdout");
    expect(requests[0]?.headers["content-type"]).toContain("application/json");
    expect(requests[0]?.headers["authorization"]).toBe(`Stonehush-Runner runner-1 ${"a".repeat(43)}`);
    expect(requests[0]?.headers["idempotency-key"]).toMatch(/^[\x20-\x7e]{22,128}$/);
    // PUT headers
    expect(requests[1]?.headers["content-type"]).toBe("application/octet-stream");
    expect(requests[1]?.headers["authorization"]).toBe(`Stonehush-Runner runner-1 ${"a".repeat(43)}`);
    // complete body
    const stdoutComplete = requests[2]?.body as Record<string, unknown>;
    expect(stdoutComplete.sizeBytes).toBe(stdout.length);
    expect(stdoutComplete.digest).toBe(sha256(stdout));
    expect(stdoutComplete.completeness).toBe("complete");
    // stderr same checks
    const stderrGrant = requests[3]?.body as Record<string, unknown>;
    expect(stderrGrant.declaredSizeBytes).toBe(stderr.length);
    expect(stderrGrant.declaredDigest).toBe(sha256(stderr));
    expect(stderrGrant.originalFileName).toBe("stderr.log");
    expect(requests[4]?.headers["content-type"]).toBe("application/octet-stream");
    const stderrComplete = requests[5]?.body as Record<string, unknown>;
    expect(stderrComplete.completeness).toBe("complete");
  });

  it("empty buffers publish with empty digest", async () => {
    const lease = { runId: "run-1", leaseId: "lease-1", sessionId: "sess-1", fence: "1" };
    const config = { dataDir, runnerId: "runner-1", secret: "a".repeat(43), apiBaseUrl: "http://127.0.0.1:9", runRoot: path.join(dataDir, "runs"), sessionId: "sess-1", installationFingerprint: "sha256:" + "a".repeat(64), heartbeatIntervalMs: 10000, leaseDurationMs: 30000, executable: process.execPath } as const;
    const empty = Buffer.alloc(0);
    const result = {
      exitCode: 0, signal: null, stdout: empty, stderr: empty,
      stdoutMeta: { inputBytesSeen: 0, redactedBytesProduced: 0, bytesRetained: 0, bytesDropped: 0, firstDroppedRedactedOffset: null, truncated: false },
      stderrMeta: { inputBytesSeen: 0, redactedBytesProduced: 0, bytesRetained: 0, bytesDropped: 0, firstDroppedRedactedOffset: null, truncated: false },
      truncated: false,
    } as unknown as import("./process.js").ProcessResult;
    const emptyDigest = sha256(empty);
    expect(emptyDigest).toBe("sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    const bodies: unknown[] = [];
    const grantMapEmpty = new Map<string, string>();
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      const method = init?.method ?? "GET";
      let body: unknown = init?.body;
      if (typeof body === "string") try { body = JSON.parse(body); } catch {}
      if (u.includes("/artifacts/grants")) {
        bodies.push(body);
        const b = body as Record<string, unknown>;
        const slot = b.artifactSlot as string;
        const artifactId = `00000000-0000-4000-8000-${slot === "stdout" ? "000000000001" : "000000000002"}`;
        const uploadId = `00000000-0000-4000-8000-${slot === "stdout" ? "000000000011" : "000000000012"}`;
        grantMapEmpty.set(uploadId, artifactId);
        return new Response(JSON.stringify({ artifactId, uploadId, runId: lease.runId, leaseId: lease.leaseId, sessionId: lease.sessionId, fence: lease.fence, eventSequence: (b.eventSequence as number), artifactSlot: slot, kind: slot, declaredSizeBytes: 0, declaredDigest: emptyDigest, originalFileName: `${slot}.log`, declaredContentType: "text/plain; charset=utf-8", createdAt: new Date().toISOString() }), { status: 201 });
      }
      if (u.includes("/uploads/") && method === "PUT") return new Response(null, { status: 204 });
      if (u.includes("/complete")) {
        const b = body as Record<string, unknown>;
        const uploadId = u.split("/uploads/")[1]?.split("/")[0] ?? "";
        const artifactId = grantMapEmpty.get(uploadId) ?? "00000000-0000-4000-8000-000000000001";
        return new Response(JSON.stringify({ disposition: "published", artifactId, sizeBytes: 0, digest: emptyDigest, completeness: b.completeness }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: "invalid_request" }), { status: 400 });
    }) as unknown as typeof fetch;
    await publishEvidenceArtifacts(config as unknown as import("./config.js").RunnerConfig, lease, result, { isCancelled: false, eventSequence: 2 });
    expect(bodies.length).toBe(2);
    for (const b of bodies) {
      const rec = b as Record<string, unknown>;
      expect(rec.declaredSizeBytes).toBe(0);
      expect(rec.declaredDigest).toBe(emptyDigest);
    }
  });

  it("redacted/truncated/partial completeness: truncated wins", async () => {
    const lease = { runId: "run-1", leaseId: "lease-1", sessionId: "sess-1", fence: "1" };
    const config = { dataDir, runnerId: "runner-1", secret: "a".repeat(43), apiBaseUrl: "http://127.0.0.1:9", runRoot: path.join(dataDir, "runs"), sessionId: "sess-1", installationFingerprint: "sha256:" + "a".repeat(64), heartbeatIntervalMs: 10000, leaseDurationMs: 30000, executable: process.execPath } as const;
    const stdout = Buffer.from("secret [REDACTED] retained", "utf8"); // already redacted
    const stderr = Buffer.from("normal", "utf8");
    const result = {
      exitCode: 0, signal: null, stdout, stderr,
      stdoutMeta: { inputBytesSeen: 100, redactedBytesProduced: 50, bytesRetained: 20, bytesDropped: 30, firstDroppedRedactedOffset: 20, truncated: true },
      stderrMeta: { inputBytesSeen: stderr.length, redactedBytesProduced: stderr.length, bytesRetained: stderr.length, bytesDropped: 0, firstDroppedRedactedOffset: null, truncated: false },
      truncated: true,
    } as unknown as import("./process.js").ProcessResult;
    const completes: Record<string, unknown>[] = [];
    const grantMapTrunc = new Map<string, string>();
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      const method = init?.method ?? "GET";
      let body: unknown = init?.body;
      if (typeof body === "string") try { body = JSON.parse(body); } catch {}
      if (u.includes("/artifacts/grants")) {
        const b = body as Record<string, unknown>;
        const slot = b.artifactSlot as string;
        const artifactId = `00000000-0000-4000-8000-${slot === "stdout" ? "000000000001" : "000000000002"}`;
        const uploadId = `00000000-0000-4000-8000-${slot === "stdout" ? "000000000011" : "000000000012"}`;
        grantMapTrunc.set(uploadId, artifactId);
        return new Response(JSON.stringify({ artifactId, uploadId, runId: lease.runId, leaseId: lease.leaseId, sessionId: lease.sessionId, fence: lease.fence, eventSequence: (b.eventSequence as number), artifactSlot: slot, kind: slot, declaredSizeBytes: (b.declaredSizeBytes as number), declaredDigest: b.declaredDigest, originalFileName: `${slot}.log`, declaredContentType: "text/plain; charset=utf-8", createdAt: new Date().toISOString() }), { status: 201 });
      }
      if (u.includes("/uploads/") && method === "PUT") return new Response(null, { status: 204 });
      if (u.includes("/complete")) {
        completes.push(body as Record<string, unknown>);
        const b = body as Record<string, unknown>;
        const uploadId = u.split("/uploads/")[1]?.split("/")[0] ?? "";
        const artifactId = grantMapTrunc.get(uploadId) ?? "00000000-0000-4000-8000-000000000001";
        return new Response(JSON.stringify({ disposition: "published", artifactId, sizeBytes: b.sizeBytes, digest: b.digest, completeness: b.completeness }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: "invalid_request" }), { status: 400 });
    }) as unknown as typeof fetch;

    // isCancelled true but truncated wins
    await publishEvidenceArtifacts(config as unknown as import("./config.js").RunnerConfig, lease, result, { isCancelled: true, eventSequence: 2 });
    expect(completes.length).toBe(2);
    expect(completes[0]).toHaveProperty("completeness", "truncated"); // stdout truncated wins over partial
    expect(completes[1]).toHaveProperty("completeness", "partial"); // stderr not truncated, so partial

    // clean for second check: not cancelled but not truncated => complete
    completes.length = 0;
    const result2 = {
      exitCode: 0, signal: null, stdout: Buffer.from("a"), stderr: Buffer.from("b"),
      stdoutMeta: { inputBytesSeen: 1, redactedBytesProduced: 1, bytesRetained: 1, bytesDropped: 0, firstDroppedRedactedOffset: null, truncated: false },
      stderrMeta: { inputBytesSeen: 1, redactedBytesProduced: 1, bytesRetained: 1, bytesDropped: 0, firstDroppedRedactedOffset: null, truncated: false },
      truncated: false,
    } as unknown as import("./process.js").ProcessResult;
    // need new dataDir outbox cleared; reuse same config but outbox already removed, next grants will create new keys
    await publishEvidenceArtifacts(config as unknown as import("./config.js").RunnerConfig, lease, result2, { isCancelled: false, eventSequence: 2 });
    expect(completes[0]).toHaveProperty("completeness", "complete");
    expect(completes[1]).toHaveProperty("completeness", "complete");
  });

  it("transport retry reuses grant key", async () => {
    const lease = { runId: "run-1", leaseId: "lease-1", sessionId: "sess-1", fence: "1" };
    const config = { dataDir, runnerId: "runner-1", secret: "a".repeat(43), apiBaseUrl: "http://127.0.0.1:9", runRoot: path.join(dataDir, "runs"), sessionId: "sess-1", installationFingerprint: "sha256:" + "a".repeat(64), heartbeatIntervalMs: 10000, leaseDurationMs: 30000, executable: process.execPath } as const;
    const stdout = Buffer.from("retry", "utf8");
    const stderr = Buffer.from("ok", "utf8");
    const result = {
      exitCode: 0, signal: null, stdout, stderr,
      stdoutMeta: { inputBytesSeen: stdout.length, redactedBytesProduced: stdout.length, bytesRetained: stdout.length, bytesDropped: 0, firstDroppedRedactedOffset: null, truncated: false },
      stderrMeta: { inputBytesSeen: stderr.length, redactedBytesProduced: stderr.length, bytesRetained: stderr.length, bytesDropped: 0, firstDroppedRedactedOffset: null, truncated: false },
      truncated: false,
    } as unknown as import("./process.js").ProcessResult;

    let grantAttempts = 0;
    const seenKeys: string[] = [];
    const grantMapRetry1 = new Map<string, string>();
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      const headers = (init?.headers as Record<string, string>) ?? {};
      const key = String(headers["idempotency-key"] ?? headers["Idempotency-Key"] ?? "");
      if (u.includes("/artifacts/grants")) {
        seenKeys.push(key);
        grantAttempts += 1;
        if (grantAttempts === 1) throw new Error("network failure");
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const slot = body.artifactSlot as string;
        const artifactId = `00000000-0000-4000-8000-${slot === "stdout" ? "000000000001" : "000000000002"}`;
        const uploadId = `00000000-0000-4000-8000-${slot === "stdout" ? "000000000011" : "000000000012"}`;
        grantMapRetry1.set(uploadId, artifactId);
        return new Response(JSON.stringify({ artifactId, uploadId, runId: lease.runId, leaseId: lease.leaseId, sessionId: lease.sessionId, fence: lease.fence, eventSequence: (body.eventSequence as number), artifactSlot: slot, kind: slot, declaredSizeBytes: (body.declaredSizeBytes as number), declaredDigest: body.declaredDigest, originalFileName: `${slot}.log`, declaredContentType: "text/plain; charset=utf-8", createdAt: new Date().toISOString() }), { status: 201 });
      }
      if (u.includes("/uploads/") && (init?.method === "PUT")) return new Response(null, { status: 204 });
      if (u.includes("/complete")) {
        const b = JSON.parse(String(init?.body));
        const uploadId = u.split("/uploads/")[1]?.split("/")[0] ?? "";
        const artifactId = grantMapRetry1.get(uploadId) ?? "00000000-0000-4000-8000-000000000001";
        return new Response(JSON.stringify({ disposition: "published", artifactId, sizeBytes: b.sizeBytes, digest: b.digest, completeness: b.completeness }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: "invalid_request" }), { status: 400 });
    }) as unknown as typeof fetch;

    // First attempt fails at grant transport
    await expect(publishEvidenceArtifacts(config as unknown as import("./config.js").RunnerConfig, lease, result, { isCancelled: false, eventSequence: 2 })).rejects.toBeInstanceOf(EvidencePublicationError);
    // Outbox should remain for retry
    const outboxFiles = await readdir(path.join(dataDir, "outbox")).catch(() => []);
    expect(outboxFiles.length).toBe(1);
    const firstKey = seenKeys[0] as string;
    expect(firstKey.length).toBeGreaterThan(10);
    // Second attempt with same lease/result should reuse same key for stdout grant
    seenKeys.length = 0;
    grantAttempts = 0; // reset counter but fetch will now succeed on first try; we need to check reuse: second run should reuse same key as before
    // For this we need to keep outbox: next publish will call getOrCreateOutboxEntry which should return same key
    // Mock fetch to succeed now
    const grantMapRetry2 = new Map<string, string>();
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      const headers = (init?.headers as Record<string, string>) ?? {};
      const key = String(headers["idempotency-key"] ?? "");
      if (u.includes("/artifacts/grants")) {
        seenKeys.push(key);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const slot = body.artifactSlot as string;
        const artifactId = `00000000-0000-4000-8000-${slot === "stdout" ? "000000000001" : "000000000002"}`;
        const uploadId = `00000000-0000-4000-8000-${slot === "stdout" ? "000000000011" : "000000000012"}`;
        grantMapRetry2.set(uploadId, artifactId);
        return new Response(JSON.stringify({ artifactId, uploadId, runId: lease.runId, leaseId: lease.leaseId, sessionId: lease.sessionId, fence: lease.fence, eventSequence: (body.eventSequence as number), artifactSlot: slot, kind: slot, declaredSizeBytes: (body.declaredSizeBytes as number), declaredDigest: body.declaredDigest, originalFileName: `${slot}.log`, declaredContentType: "text/plain; charset=utf-8", createdAt: new Date().toISOString() }), { status: 201 });
      }
      if (u.includes("/uploads/") && (init?.method === "PUT")) return new Response(null, { status: 204 });
      if (u.includes("/complete")) {
        const b = JSON.parse(String(init?.body));
        const uploadId = u.split("/uploads/")[1]?.split("/")[0] ?? "";
        const artifactId = grantMapRetry2.get(uploadId) ?? "00000000-0000-4000-8000-000000000001";
        return new Response(JSON.stringify({ disposition: "published", artifactId, sizeBytes: b.sizeBytes, digest: b.digest, completeness: b.completeness }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: "invalid_request" }), { status: 400 });
    }) as unknown as typeof fetch;

    await publishEvidenceArtifacts(config as unknown as import("./config.js").RunnerConfig, lease, result, { isCancelled: false, eventSequence: 2 });
    expect(seenKeys[0]).toBe(firstKey);
  });

  it("second failure leaves no succeeded completion via runOnce", async () => {
    const dataDir2 = path.join(tmpdir(), `test-evid-runonce-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(dataDir2, { recursive: true });
    const leaseResponse = {
      run: { id: "run-1", actionId: "act-1", engagementId: "eng-1", attempt: 1, state: "leased", currentLeaseId: "lease-1", currentFence: "1", terminalKind: null, terminalReason: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), contractVersion: 1 },
      lease: { runId: "run-1", leaseId: "lease-1", runnerId: "runner-1", sessionId: "sess-1", fence: "1", expiresAt: new Date(Date.now() + 30000).toISOString(), latestHeartbeatSequence: 0, latestEventSequence: 0, orchestrationProfile: "d2-v1", protocol: "runner-control-v1" },
      actionSnapshot: {
        normalizationProfile: "d1-v1",
        orchestrationProfile: "d2-v1",
        snapshotId: "snapshot-act-1",
        version: 1,
        binding: `sha256:${"a".repeat(64)}`,
        actionId: "act-1",
        canonicalTargets: [{ normalizationProfile: "d1-v1", kind: "hostname", hostname: "app.target.test" }],
        concreteDestinations: [{ normalizationProfile: "d1-v1", kind: "ip", family: 4, address: "192.0.2.10", zone: null }],
        typedOptions: { declaredPorts: [80] },
        resolutionSnapshots: [],
        scopeRevisionId: null,
        warningState: { reasonCodes: [], knownAdditions: [], acknowledgment: null },
      },
    };
    const completeCalls: { terminalKind: string; reason: string | null }[] = [];
    let grantCall = 0;
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      const method = init?.method ?? "GET";
      if (u.includes("/handshake")) {
        return new Response(JSON.stringify({ acceptedProtocol: "runner-control-v1", sessionId: "sess-1", runnerId: "runner-1", leaseAllowed: true, sessionPinned: true, registryPinned: false }), { status: 200 });
      }
      if (u.includes("/lease") && !u.includes("/heartbeat") && !u.includes("/events") && !u.includes("/complete") && !u.includes("/artifacts")) {
        return new Response(JSON.stringify(leaseResponse), { status: 200 });
      }
      if (u.includes("/events") && !u.includes("/artifacts")) {
        return new Response(JSON.stringify({ disposition: "accepted_event", event: { eventId: 1, runId: "run-1", sequence: 1, type: "started", fence: "1", payloadJson: "{}", digest: "sha256:" + "a".repeat(64), createdAt: new Date().toISOString() } }), { status: 200 });
      }
      if (u.includes("/heartbeat")) {
        return new Response(JSON.stringify({ leaseExpiresAt: new Date(Date.now() + 30000).toISOString(), heartbeatSequence: 2 }), { status: 200 });
      }
      if (u.includes("/artifacts/grants")) {
        grantCall += 1;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const slot = body.artifactSlot as string;
        if (slot === "stderr") {
          // second slot fails with 500
          return new Response(JSON.stringify({ code: "invalid_request" }), { status: 500 });
        }
        return new Response(JSON.stringify({ artifactId: `00000000-0000-4000-8000-${slot === "stdout" ? "000000000001" : "000000000002"}`, uploadId: `00000000-0000-4000-8000-${slot === "stdout" ? "000000000011" : "000000000012"}`, runId: "run-1", leaseId: "lease-1", sessionId: "sess-1", fence: "1", eventSequence: (body.eventSequence as number), artifactSlot: slot, kind: slot, declaredSizeBytes: body.declaredSizeBytes, declaredDigest: body.declaredDigest, originalFileName: `${slot}.log`, declaredContentType: "text/plain; charset=utf-8", createdAt: new Date().toISOString() }), { status: 201 });
      }
      if (u.includes("/uploads/") && method === "PUT") {
        // Check if this is for stderr uploadId which we never got because grant failed; but stdout PUT should succeed
        return new Response(null, { status: 204 });
      }
      if (u.includes("/uploads/") && u.includes("/complete") && method === "POST") {
        const b = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ disposition: "published", artifactId: "00000000-0000-4000-8000-000000000001", sizeBytes: b.sizeBytes, digest: b.digest, completeness: b.completeness }), { status: 200 });
      }
      if (u.includes("/complete") && !u.includes("/artifacts")) {
        const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
        completeCalls.push({ terminalKind: b.terminalKind as string, reason: b.reason as string | null });
        return new Response(JSON.stringify({ disposition: "accepted_completion", event: { eventId: 2, runId: "run-1", sequence: 2, type: b.terminalKind as string, fence: "1", payloadJson: "{}", digest: "sha256:" + "b".repeat(64), createdAt: new Date().toISOString() } }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: "invalid_request" }), { status: 400 });
    }) as unknown as typeof fetch;

    let thrown: unknown = null;
    try {
      await runOnce({ dataDir: dataDir2, runnerId: "runner-1", secret: "a".repeat(43), apiBaseUrl: "http://127.0.0.1:9", runRoot: path.join(dataDir2, "runs"), executable: process.execPath });
    } catch (e) { thrown = e; }
    // runOnce should have thrown evidence publication error, not succeeded
    expect(thrown).toBeInstanceOf(EvidencePublicationError);
    expect((thrown as EvidencePublicationError).code).toBe("evidence_publication_failed");
    // Should have attempted failed evidence_publication_failed, not succeeded
    expect(completeCalls.some((c) => c.terminalKind === "succeeded")).toBe(false);
    expect(completeCalls.some((c) => c.terminalKind === "failed" && c.reason === "evidence_publication_failed")).toBe(true);
    // First slot stdout should have been published before second failed: verify grantCall was 2 (stdout succeed, stderr fail)
    expect(grantCall).toBe(2);
    await rm(dataDir2, { recursive: true, force: true });
  });

  it("stale fence fixed error", async () => {
    const lease = { runId: "run-1", leaseId: "lease-1", sessionId: "sess-1", fence: "1" };
    const config = { dataDir, runnerId: "runner-1", secret: "a".repeat(43), apiBaseUrl: "http://127.0.0.1:9", runRoot: path.join(dataDir, "runs"), sessionId: "sess-1", installationFingerprint: "sha256:" + "a".repeat(64), heartbeatIntervalMs: 10000, leaseDurationMs: 30000, executable: process.execPath } as const;
    const stdout = Buffer.from("data", "utf8");
    const stderr = Buffer.from("data2", "utf8");
    const result = {
      exitCode: 0, signal: null, stdout, stderr,
      stdoutMeta: { inputBytesSeen: stdout.length, redactedBytesProduced: stdout.length, bytesRetained: stdout.length, bytesDropped: 0, firstDroppedRedactedOffset: null, truncated: false },
      stderrMeta: { inputBytesSeen: stderr.length, redactedBytesProduced: stderr.length, bytesRetained: stderr.length, bytesDropped: 0, firstDroppedRedactedOffset: null, truncated: false },
      truncated: false,
    } as unknown as import("./process.js").ProcessResult;
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/artifacts/grants")) {
        return new Response(JSON.stringify({ code: "stale_fence" }), { status: 409, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ code: "invalid_request" }), { status: 400 });
    }) as unknown as typeof fetch;

    let err: unknown = null;
    try {
      await publishEvidenceArtifacts(config as unknown as import("./config.js").RunnerConfig, lease, result, { isCancelled: false, eventSequence: 2 });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(EvidencePublicationError);
    expect((err as EvidencePublicationError).code).toBe("stale_fence");
    // Ensure fixed message does not leak body bytes or paths
    expect(String((err as Error).message)).not.toContain("stale_fence_body");
    expect(String((err as Error).message)).not.toContain(stdout.toString());
    expect(String((err as Error).message)).toBe("stale_fence");
    // Outbox retained on stale_fence? Since we retain on non-grant, outbox file should remain
    const outboxFiles = await readdir(path.join(dataDir, "outbox")).catch(() => []);
    expect(outboxFiles.length).toBe(1);
  });

  it("current live sequence is sent on every grant", async () => {
    const lease = { runId: "run-1", leaseId: "lease-1", sessionId: "sess-1", fence: "1" };
    const config = { dataDir, runnerId: "runner-1", secret: "a".repeat(43), apiBaseUrl: "http://127.0.0.1:9", runRoot: path.join(dataDir, "runs"), sessionId: "sess-1", installationFingerprint: "sha256:" + "a".repeat(64), heartbeatIntervalMs: 10000, leaseDurationMs: 30000, executable: process.execPath } as const;
    const stdout = Buffer.from("seq stdout", "utf8");
    const stderr = Buffer.from("seq stderr", "utf8");
    const result = {
      exitCode: 0, signal: null, stdout, stderr,
      stdoutMeta: { inputBytesSeen: stdout.length, redactedBytesProduced: stdout.length, bytesRetained: stdout.length, bytesDropped: 0, firstDroppedRedactedOffset: null, truncated: false },
      stderrMeta: { inputBytesSeen: stderr.length, redactedBytesProduced: stderr.length, bytesRetained: stderr.length, bytesDropped: 0, firstDroppedRedactedOffset: null, truncated: false },
      truncated: false,
    } as unknown as import("./process.js").ProcessResult;
    const grantSequences: unknown[] = [];
    const grantMap = new Map<string, string>();
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      const method = init?.method ?? "GET";
      let body: unknown = init?.body;
      if (typeof body === "string") try { body = JSON.parse(body); } catch {}
      if (u.includes("/artifacts/grants")) {
        const b = body as Record<string, unknown>;
        grantSequences.push(b.eventSequence);
        const slot = b.artifactSlot as string;
        const artifactId = `00000000-0000-4000-8000-${slot === "stdout" ? "000000000001" : "000000000002"}`;
        const uploadId = `00000000-0000-4000-8000-${slot === "stdout" ? "000000000011" : "000000000012"}`;
        grantMap.set(uploadId, artifactId);
        return new Response(JSON.stringify({ artifactId, uploadId, runId: lease.runId, leaseId: lease.leaseId, sessionId: lease.sessionId, fence: lease.fence, eventSequence: b.eventSequence, artifactSlot: slot, kind: slot, declaredSizeBytes: (b.declaredSizeBytes as number), declaredDigest: b.declaredDigest, originalFileName: `${slot}.log`, declaredContentType: "text/plain; charset=utf-8", createdAt: new Date().toISOString() }), { status: 201 });
      }
      if (u.includes("/uploads/") && method === "PUT") return new Response(null, { status: 204 });
      if (u.includes("/complete")) {
        const b = body as Record<string, unknown>;
        const uploadId = u.split("/uploads/")[1]?.split("/")[0] ?? "";
        return new Response(JSON.stringify({ disposition: "published", artifactId: grantMap.get(uploadId), sizeBytes: b.sizeBytes, digest: b.digest, completeness: b.completeness }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: "invalid_request" }), { status: 400 });
    }) as unknown as typeof fetch;
    await publishEvidenceArtifacts(config as unknown as import("./config.js").RunnerConfig, lease, result, { isCancelled: false, eventSequence: 2 });
    expect(grantSequences).toEqual([2, 2]);
  });

  it("stale sequence surfaces event_sequence_gap and retains outbox", async () => {
    const lease = { runId: "run-1", leaseId: "lease-1", sessionId: "sess-1", fence: "1" };
    const config = { dataDir, runnerId: "runner-1", secret: "a".repeat(43), apiBaseUrl: "http://127.0.0.1:9", runRoot: path.join(dataDir, "runs"), sessionId: "sess-1", installationFingerprint: "sha256:" + "a".repeat(64), heartbeatIntervalMs: 10000, leaseDurationMs: 30000, executable: process.execPath } as const;
    const stdout = Buffer.from("stale", "utf8");
    const stderr = Buffer.from("stale2", "utf8");
    const result = {
      exitCode: 0, signal: null, stdout, stderr,
      stdoutMeta: { inputBytesSeen: stdout.length, redactedBytesProduced: stdout.length, bytesRetained: stdout.length, bytesDropped: 0, firstDroppedRedactedOffset: null, truncated: false },
      stderrMeta: { inputBytesSeen: stderr.length, redactedBytesProduced: stderr.length, bytesRetained: stderr.length, bytesDropped: 0, firstDroppedRedactedOffset: null, truncated: false },
      truncated: false,
    } as unknown as import("./process.js").ProcessResult;
    const seen: unknown[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/artifacts/grants")) {
        const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
        seen.push(b.eventSequence);
        return new Response(JSON.stringify({ code: "event_sequence_gap", expectedSequence: 2 }), { status: 409, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ code: "invalid_request" }), { status: 400 });
    }) as unknown as typeof fetch;
    let err: unknown = null;
    try {
      await publishEvidenceArtifacts(config as unknown as import("./config.js").RunnerConfig, lease, result, { isCancelled: false, eventSequence: 1 });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(EvidencePublicationError);
    expect((err as EvidencePublicationError).code).toBe("event_sequence_gap");
    expect(seen).toEqual([1]);
    const outboxFiles = await readdir(path.join(dataDir, "outbox")).catch(() => []);
    expect(outboxFiles.length).toBe(1);
  });

  it("schema-valid mismatched grant retains outbox and performs no PUT", async () => {
    const lease = { runId: "run-1", leaseId: "lease-1", sessionId: "sess-1", fence: "1" };
    const config = { dataDir, runnerId: "runner-1", secret: "a".repeat(43), apiBaseUrl: "http://127.0.0.1:9", runRoot: path.join(dataDir, "runs"), sessionId: "sess-1", installationFingerprint: "sha256:" + "a".repeat(64), heartbeatIntervalMs: 10000, leaseDurationMs: 30000, executable: process.execPath } as const;
    const stdout = Buffer.from("hello stdout binding", "utf8");
    const stderr = Buffer.from("hello stderr", "utf8");
    const result = {
      exitCode: 0, signal: null, stdout, stderr,
      stdoutMeta: { inputBytesSeen: stdout.length, redactedBytesProduced: stdout.length, bytesRetained: stdout.length, bytesDropped: 0, firstDroppedRedactedOffset: null, truncated: false },
      stderrMeta: { inputBytesSeen: stderr.length, redactedBytesProduced: stderr.length, bytesRetained: stderr.length, bytesDropped: 0, firstDroppedRedactedOffset: null, truncated: false },
      truncated: false,
    } as unknown as import("./process.js").ProcessResult;

    const requests: string[] = [];
    const mismatchedDigest = `sha256:${"b".repeat(64)}`;
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      requests.push(`${init?.method ?? "GET"} ${u}`);
      if (u.includes("/artifacts/grants")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const slot = body.artifactSlot as string;
        // Return schema-valid grant but with declaredDigest mismatched
        return new Response(JSON.stringify({
          artifactId: "00000000-0000-4000-8000-000000000001",
          uploadId: "00000000-0000-4000-8000-000000000011",
          runId: body.runId,
          leaseId: body.leaseId,
          sessionId: body.sessionId,
          fence: body.fence,
          eventSequence: body.eventSequence,
          artifactSlot: body.artifactSlot,
          kind: body.kind,
          declaredSizeBytes: body.declaredSizeBytes,
          declaredDigest: slot === "stdout" ? mismatchedDigest : body.declaredDigest,
          originalFileName: body.originalFileName,
          declaredContentType: body.declaredContentType,
          createdAt: new Date().toISOString(),
        }), { status: 201, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ code: "invalid_request" }), { status: 500 });
    }) as unknown as typeof fetch;

    let err: unknown = null;
    try {
      await publishEvidenceArtifacts(config as unknown as import("./config.js").RunnerConfig, lease, result, { isCancelled: false, eventSequence: 2 });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(EvidencePublicationError);
    expect((err as EvidencePublicationError).code).toBe("evidence_publication_failed");
    expect(String((err as Error).message)).toBe("evidence_publication_failed");
    // Must not leak declared values
    expect(String((err as Error).message)).not.toContain(mismatchedDigest);
    expect(String((err as Error).message)).not.toContain(stdout.toString());
    // Outbox retained (ambiguous/untrusted), no PUT performed
    const outboxFiles = await readdir(path.join(dataDir, "outbox")).catch(() => []);
    expect(outboxFiles.length).toBe(1);
    expect(requests.some((r) => r.startsWith("PUT"))).toBe(false);
    expect(requests.length).toBe(1);
    expect(requests[0]).toContain("/artifacts/grants");
  });

  it("schema-valid mismatched completion is rejected", async () => {
    const lease = { runId: "run-1", leaseId: "lease-1", sessionId: "sess-1", fence: "1" };
    const config = { dataDir, runnerId: "runner-1", secret: "a".repeat(43), apiBaseUrl: "http://127.0.0.1:9", runRoot: path.join(dataDir, "runs"), sessionId: "sess-1", installationFingerprint: "sha256:" + "a".repeat(64), heartbeatIntervalMs: 10000, leaseDurationMs: 30000, executable: process.execPath } as const;
    const stdout = Buffer.from("complete binding test", "utf8");
    const stderr = Buffer.from("stderr2", "utf8");
    const result = {
      exitCode: 0, signal: null, stdout, stderr,
      stdoutMeta: { inputBytesSeen: stdout.length, redactedBytesProduced: stdout.length, bytesRetained: stdout.length, bytesDropped: 0, firstDroppedRedactedOffset: null, truncated: false },
      stderrMeta: { inputBytesSeen: stderr.length, redactedBytesProduced: stderr.length, bytesRetained: stderr.length, bytesDropped: 0, firstDroppedRedactedOffset: null, truncated: false },
      truncated: false,
    } as unknown as import("./process.js").ProcessResult;

    let grantedArtifactId = "";
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      const method = init?.method ?? "GET";
      if (u.includes("/artifacts/grants")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const slot = body.artifactSlot as string;
        const artifactId = `00000000-0000-4000-8000-${slot === "stdout" ? "000000000001" : "000000000002"}`;
        const uploadId = `00000000-0000-4000-8000-${slot === "stdout" ? "000000000011" : "000000000012"}`;
        if (slot === "stdout") grantedArtifactId = artifactId;
        return new Response(JSON.stringify({
          artifactId, uploadId,
          runId: body.runId, leaseId: body.leaseId, sessionId: body.sessionId, fence: body.fence,
          eventSequence: body.eventSequence, artifactSlot: body.artifactSlot, kind: body.kind,
          declaredSizeBytes: body.declaredSizeBytes, declaredDigest: body.declaredDigest,
          originalFileName: body.originalFileName, declaredContentType: body.declaredContentType,
          createdAt: new Date().toISOString(),
        }), { status: 201 });
      }
      if (u.includes("/uploads/") && method === "PUT") {
        return new Response(null, { status: 204 });
      }
      if (u.includes("/complete") && method === "POST") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        // Schema-valid but mismatched: artifactId different from grant, sizeBytes/digest/completeness echo request except artifactId mismatch
        const mismatchedArtifactId = "00000000-0000-4000-8000-000000000099";
        return new Response(JSON.stringify({
          disposition: "published",
          artifactId: mismatchedArtifactId,
          sizeBytes: body.sizeBytes,
          digest: body.digest,
          completeness: body.completeness,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ code: "invalid_request" }), { status: 400 });
    }) as unknown as typeof fetch;

    let err: unknown = null;
    try {
      await publishEvidenceArtifacts(config as unknown as import("./config.js").RunnerConfig, lease, result, { isCancelled: false, eventSequence: 2 });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(EvidencePublicationError);
    expect((err as EvidencePublicationError).code).toBe("evidence_publication_failed");
    expect(String((err as Error).message)).toBe("evidence_publication_failed");
    expect(String((err as Error).message)).not.toContain(grantedArtifactId);
    expect(String((err as Error).message)).not.toContain(stdout.toString());
  });
});
