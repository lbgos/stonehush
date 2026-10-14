import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ActionSnapshot } from "@stonehush/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessResult } from "./process.js";

vi.mock("./process.js", async (original) => ({
  ...await original<typeof import("./process.js")>(),
  verifyExecutable: vi.fn(async () => {}),
  runSupervisedCommand: vi.fn(),
  readNmapXmlSecurely: vi.fn(async () => Buffer.from("<nmaprun>")),
  readFfufJsonSecurely: vi.fn(async () => Buffer.from('{"results":[]}')),
  readVhostJsonSecurely: vi.fn(async () => Buffer.from('{"results":[]}')),
}));
vi.mock("./evidence-client.js", async (original) => ({
  ...await original<typeof import("./evidence-client.js")>(),
  publishEvidenceArtifacts: vi.fn(async () => {}),
  publishFfufArtifacts: vi.fn(async () => {}),
  publishVhostArtifacts: vi.fn(async () => {}),
  publishHttpProbeArtifacts: vi.fn(async () => {}),
}));
import { runSupervisedCommand, verifyExecutable } from "./process.js";
import { EvidencePublicationError, publishEvidenceArtifacts, publishFfufArtifacts, publishHttpProbeArtifacts, publishVhostArtifacts } from "./evidence-client.js";
import { runOnce, RunnerShutdownError } from "./runner.js";

const ip = { normalizationProfile: "d1-v1" as const, kind: "ip" as const, family: 4 as const, address: "192.0.2.10", zone: null };
function urlTarget(url: string) {
  const parsed = new URL(url);
  return { normalizationProfile: "d1-v1" as const, kind: "url" as const, url, origin: parsed.origin,
    host: { address: parsed.hostname, zone: null }, effectivePort: Number(parsed.port || 80), pathAndQuery: parsed.pathname };
}
function snapshot(kind: "nmap" | "ffuf" | "vhost" | "probe"): ActionSnapshot {
  const options = { wordlistPath: "/lists/synthetic.txt", rate: 100, threads: 10, timeoutSeconds: 5, maxTimeSeconds: 60, matchStatusCodes: [200] };
  return { normalizationProfile: "d1-v1", orchestrationProfile: "d2-v1", snapshotId: "snapshot-1", version: 1,
    actionId: "act-1", binding: `sha256:${"a".repeat(64)}`,
    canonicalTargets: kind === "nmap" || kind === "vhost" ? [ip] :
      kind === "probe" ? [urlTarget("http://127.0.0.1:3288/first"), urlTarget("http://127.0.0.1:3288/slow"), urlTarget("http://127.0.0.1:3288/later")] : [urlTarget("http://192.0.2.10/")],
    concreteDestinations: kind === "nmap" ? [ip] : [],
    typedOptions: kind === "ffuf" ? { declaredPorts: null, ffuf: { ...options, origin: "http://192.0.2.10/" } } :
      kind === "vhost" ? { declaredPorts: [80], ffufVhost: { ...options, address: ip.address, port: 80, tls: false } } :
        kind === "probe" ? {} : { declaredPorts: [80] },
    resolutionSnapshots: [], scopeRevisionId: null,
    warningState: { reasonCodes: [], knownAdditions: [], acknowledgment: null } };
}
function captured(): ProcessResult {
  const stdout = Buffer.from("exact captured prefix\n");
  const meta = { inputBytesSeen: stdout.length, redactedBytesProduced: stdout.length, bytesRetained: stdout.length,
    bytesDropped: 0, firstDroppedRedactedOffset: null, truncated: false };
  return { exitCode: null, signal: "SIGTERM", stdout, stderr: Buffer.alloc(0),
    stdoutMeta: meta, stderrMeta: { ...meta, inputBytesSeen: 0, redactedBytesProduced: 0, bytesRetained: 0 }, truncated: false };
}
const directories: string[] = [];
beforeEach(() => { vi.clearAllMocks(); });
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function harness(kind: Parameters<typeof snapshot>[0], options: { beforeStart?: boolean; revoke?: boolean; publicationFailure?: boolean; shutdown?: boolean; completionRace?: boolean; delayVerification?: boolean; hangPoll?: "initial" | "final"; replayPartition?: boolean; cleanupFailure?: boolean; lateIntent?: boolean } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "stonehush-cancel-unit-"));
  directories.push(dataDir);
  const controller = new AbortController();
  let requested = options.beforeStart === true;
  let spawned = false;
  let nativeStopped = false;
  let verificationRelease: (() => void) | null = null;
  let heartbeatCalls = 0;
  let monotonic = 0;
  if (options.replayPartition) vi.spyOn(performance, "now").mockImplementation(() => monotonic);
  if (options.delayVerification) vi.mocked(verifyExecutable).mockImplementationOnce(async () => {
    requested = true;
    await new Promise<void>((resolve) => { verificationRelease = resolve; });
  });
  const completions: { terminalKind: string; reason: string | null }[] = [];
  const probes: string[] = [];
  const cancel = vi.fn(async () => ({ cleanupFailed: options.cleanupFailure === true }));
  vi.mocked(runSupervisedCommand).mockImplementation(() => {
    spawned = true;
    if (options.completionRace || options.lateIntent) {
      const handle = Promise.resolve({ ...captured(), exitCode: 0, signal: null }) as ReturnType<typeof runSupervisedCommand>;
      handle.cancel = cancel;
      return handle;
    }
    requested = options.replayPartition !== true;
    const handle = new Promise<ProcessResult>((resolve) => {
      cancel.mockImplementation(async () => { nativeStopped = true; resolve({ ...captured(), cleanupFailed: options.cleanupFailure === true }); return { cleanupFailed: options.cleanupFailure === true }; });
    }) as ReturnType<typeof runSupervisedCommand>;
    handle.cancel = cancel;
    return handle;
  });
  const now = new Date().toISOString();
  const lease = { runId: "run-1", leaseId: "lease-1", runnerId: "runner-1", sessionId: "sess-1", fence: "1",
    expiresAt: new Date(Date.now() + 30000).toISOString(), latestHeartbeatSequence: 0, latestEventSequence: 0,
    orchestrationProfile: "d2-v1", protocol: "runner-control-v1" };
  const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const event = (type: string) => response({ disposition: type === "started" ? "accepted_event" : "accepted_completion",
    event: { eventId: 1, runId: lease.runId, sequence: type === "started" ? 1 : 2, type, fence: "1", payloadJson: "{}",
      digest: `sha256:${"a".repeat(64)}`, createdAt: now } });
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    if (url.endsWith("/handshake")) return response({ acceptedProtocol: "runner-control-v1", sessionId: "sess-1", runnerId: "runner-1", leaseAllowed: true, sessionPinned: true, registryPinned: false });
    if (url.endsWith("/lease")) return response({ lease, actionSnapshot: snapshot(kind), run: {
      id: lease.runId, actionId: "act-1", engagementId: "eng-1", attempt: 1, state: "leased", currentLeaseId: lease.leaseId,
      currentFence: "1", terminalKind: null, terminalReason: null, createdAt: now, updatedAt: now, contractVersion: 1 } });
    if (url.endsWith("/events")) return event("started");
    if (url.endsWith("/heartbeat")) {
      heartbeatCalls += 1;
      if (options.hangPoll === "initial" || (options.hangPoll === "final" && nativeStopped)) {
        setImmediate(() => controller.abort());
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("shutdown", "AbortError")), { once: true });
        });
      }
      if (options.replayPartition) {
        if (heartbeatCalls === 1) throw new TypeError("stored heartbeat response lost");
        if (heartbeatCalls === 2) monotonic = 10000;
        else { monotonic = 24000; throw new TypeError("subsequent partition"); }
      }
      if (verificationRelease !== null) {
        const release = verificationRelease;
        verificationRelease = null;
        setImmediate(release);
      }
      if (spawned && options.lateIntent) requested = true;
      if (spawned && options.revoke) return response({ code: "runner_unauthorized" }, 401);
      if (spawned && options.shutdown) controller.abort();
      return response({ leaseExpiresAt: lease.expiresAt, heartbeatSequence: JSON.parse(String(init?.body)).heartbeatSequence,
        cancellationRequested: requested });
    }
    if (url.endsWith("/complete")) {
      const body = JSON.parse(String(init?.body)) as { terminalKind: string; reason: string | null };
      completions.push(body);
      if (options.completionRace && body.terminalKind === "succeeded") {
        requested = true;
        return response({ code: "invalid_run_transition" }, 409);
      }
      return event(body.terminalKind);
    }
    probes.push(url);
    if (url.endsWith("/first")) return new Response("<title>Captured</title>");
    requested = true;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
    });
  }));
  if (options.publicationFailure) vi.mocked(publishEvidenceArtifacts).mockRejectedValueOnce(new EvidencePublicationError("evidence_publication_failed"));
  const execution = runOnce({ dataDir, runnerId: "runner-1", secret: "a".repeat(43), sessionId: "sess-1",
    apiBaseUrl: "http://127.0.0.1:9", executable: "/usr/bin/nmap", runRoot: path.join(dataDir, "runs"), heartbeatIntervalMs: 20 },
    { signal: controller.signal });
  return { execution, completions, cancel, probes, lease };
}

describe("operator cancellation reaches installed action handlers", () => {
  it.each(["nmap", "ffuf", "vhost"] as const)("stops %s, retains exact output, then acknowledges cancellation", async (kind) => {
    const f = await harness(kind);
    await expect(f.execution).resolves.toBe(true);
    expect(f.cancel).toHaveBeenCalled();
    const publish = kind === "nmap" ? publishEvidenceArtifacts : kind === "ffuf" ? publishFfufArtifacts : publishVhostArtifacts;
    expect(publish).toHaveBeenCalledWith(expect.anything(), f.lease, expect.objectContaining({ stdout: captured().stdout }),
      expect.objectContaining({ isCancelled: true, eventSequence: 2 }));
    expect(f.completions).toEqual([expect.objectContaining({ terminalKind: "cancelled", reason: "operator_cancelled" })]);
  });
  it("cancellation before execution spawns nothing and preserves empty partial streams", async () => {
    const f = await harness("nmap", { beforeStart: true });
    await f.execution;
    expect(runSupervisedCommand).not.toHaveBeenCalled();
    expect(publishHttpProbeArtifacts).toHaveBeenCalledWith(expect.anything(), f.lease,
      expect.objectContaining({ stdout: Buffer.alloc(0), rawArtifacts: [], isCancelled: true }));
    expect(f.completions.at(-1)?.terminalKind).toBe("cancelled");
  });
  it("aborts an in-flight HTTP probe, retains the completed prefix, and starts no later URL", async () => {
    const f = await harness("probe");
    await f.execution;
    expect(f.probes).toEqual(["http://127.0.0.1:3288/first", "http://127.0.0.1:3288/slow"]);
    expect(publishHttpProbeArtifacts).toHaveBeenCalledWith(expect.anything(), f.lease,
      expect.objectContaining({ isCancelled: true, rawArtifacts: [expect.any(Buffer)] }));
    expect(f.completions.at(-1)?.terminalKind).toBe("cancelled");
  });
  it.each(["revoke", "shutdown"] as const)("keeps %s distinct from operator cancellation", async (cause) => {
    const f = await harness("nmap", { [cause]: true });
    if (cause === "shutdown") await expect(f.execution).rejects.toBeInstanceOf(RunnerShutdownError);
    else await f.execution;
    expect(f.cancel).toHaveBeenCalled();
    expect(f.completions.at(-1)).toMatchObject({ terminalKind: "failed", reason: "runner_lost" });
  });
  it("settles a cancel-first completion race without republishing immutable evidence", async () => {
    const f = await harness("nmap", { completionRace: true });
    await f.execution;
    expect(publishEvidenceArtifacts).toHaveBeenCalledOnce();
    expect(publishEvidenceArtifacts).toHaveBeenCalledWith(expect.anything(), f.lease, expect.anything(),
      expect.objectContaining({ isCancelled: false }));
    expect(f.completions.map((entry) => entry.terminalKind)).toEqual(["succeeded", "cancelled"]);
  });
  it.each(["ffuf", "vhost"] as const)("does not start %s after intent arrives during verification", async (kind) => {
    const f = await harness(kind, { delayVerification: true });
    await f.execution;
    expect(runSupervisedCommand).not.toHaveBeenCalled();
    expect(f.completions.at(-1)?.terminalKind).toBe("cancelled");
  });
  it.each(["initial", "final"] as const)("shutdown interrupts a hung %s heartbeat poll", async (hangPoll) => {
    const f = await harness("nmap", { hangPoll });
    await expect(f.execution).rejects.toBeInstanceOf(RunnerShutdownError);
    expect(f.completions.at(-1)).toMatchObject({ terminalKind: "failed", reason: "runner_lost" });
    if (hangPoll === "initial") expect(runSupervisedCommand).not.toHaveBeenCalled();
    else expect(f.cancel).toHaveBeenCalled();
  });
  it("a lost-response heartbeat replay cannot extend the original local authority", async () => {
    const f = await harness("nmap", { replayPartition: true });
    await f.execution;
    expect(f.cancel).toHaveBeenCalled();
    expect(f.completions.at(-1)).toMatchObject({ terminalKind: "failed", reason: "runner_lost" });
  });
  it("unverified native cleanup cannot acknowledge cancellation", async () => {
    const f = await harness("nmap", { cleanupFailure: true });
    await f.execution;
    expect(f.completions.at(-1)).toMatchObject({ terminalKind: "failed", reason: "process_cleanup_failed" });
  });
  it.each(["nmap", "ffuf", "vhost"] as const)("verifies %s cleanup when cancellation arrives after parent settlement", async (kind) => {
    const f = await harness(kind, { lateIntent: true });
    await f.execution;
    expect(f.cancel).toHaveBeenCalled();
    expect(f.completions.at(-1)?.terminalKind).toBe("cancelled");
  });
  it("a cancel-first completion race cannot ignore failed late cleanup", async () => {
    const f = await harness("nmap", { completionRace: true, cleanupFailure: true });
    await f.execution;
    expect(f.cancel).toHaveBeenCalled();
    expect(publishEvidenceArtifacts).toHaveBeenCalledOnce();
    expect(f.completions.at(-1)).toMatchObject({ terminalKind: "failed", reason: "process_cleanup_failed" });
  });
  it("reports partial publication failure instead of claiming preservation", async () => {
    const f = await harness("nmap", { publicationFailure: true });
    await expect(f.execution).rejects.toBeInstanceOf(EvidencePublicationError);
    expect(f.completions.at(-1)).toMatchObject({ terminalKind: "failed", reason: "evidence_publication_failed" });
  });
});
