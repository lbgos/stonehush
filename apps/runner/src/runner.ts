import {
  AcquireRunnerLeaseRequestSchema,
  AcquireRunnerLeaseResponseSchema,
  DeclaredPortsSchema,
  RunnerAppendStartedRequestSchema,
  RunnerCompleteRequestSchema,
  RunnerEventResponseSchema,
  RunnerHandshakeAcceptedResponseSchema,
  RunnerHandshakeRequestSchema,
  RunnerHeartbeatRequestSchema,
  RunnerHeartbeatResponseSchema,
  commandJsonV1RunnerAppendStartedDigest,
  commandJsonV1RunnerCompleteDigest,
  type ActionSnapshot,
  type FfufActionOptions,
  type FfufVhostActionOptions,
} from "@stonehush/contracts";
import { buildFfufArgv, buildNmapArgv, buildVhostArgv, ffufOptionsForSnapshot, hasFfufMarker, hasVhostMarker, vhostOptionsForSnapshot } from "@stonehush/domain";

import { resolveRunnerConfig, type RunnerConfig } from "./config.js";
import { EvidencePublicationError, publishEvidenceArtifacts, publishFfufArtifacts, publishHttpProbeArtifacts, publishVhostArtifacts } from "./evidence-client.js";
import { FFUF_DEFAULT_EXECUTABLE, runFfufDiscovery } from "./ffuf.js";
import { runVhostDiscovery } from "./vhost.js";
import { probeOneUrl, probeUrlsFromSnapshot, ProbeAbortedError } from "./http-probe.js";
import { getOrCreateOutboxEntry, removeOutboxAtomically } from "./outbox.js";
import { readFfufJsonSecurely, readNmapXmlSecurely, readVhostJsonSecurely, resolveFfufJsonPath, resolveNmapXmlPath, resolveVhostJsonPath, runSupervisedCommand, verifyExecutable, type ProcessResult } from "./process.js";

export type HandshakeResponse = ReturnType<typeof RunnerHandshakeAcceptedResponseSchema.parse>;
export type AcquiredLease = ReturnType<typeof AcquireRunnerLeaseResponseSchema.parse>;
export type HeartbeatResponse = ReturnType<typeof RunnerHeartbeatResponseSchema.parse>;
export type RunnerEventResponse = ReturnType<typeof RunnerEventResponseSchema.parse>;

export class RunnerShutdownError extends Error {
  readonly code = "runner_shutdown";
  constructor(message = "runner shutdown requested") {
    super(message);
    this.name = "RunnerShutdownError";
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RunnerShutdownError();
}

function authHeader(runnerId: string, secret: string): string {
  return `Stonehush-Runner ${runnerId} ${secret}`;
}

type NmapSliceOptions = {
  serviceDetection: true;
  timingTemplate: "T4";
  skipHostDiscovery: true;
  versionIntensity: 7;
  maxRetries: 2;
  ports?: { from: number; to: number }[];
};

function adaptToNmapOptions(value: unknown): NmapSliceOptions | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "declaredPorts") {
    return null;
  }
  const declaredPortsResult = DeclaredPortsSchema.safeParse(record.declaredPorts);
  if (!declaredPortsResult.success) {
    return null;
  }
  const declaredPorts = declaredPortsResult.data;
  const base = {
    serviceDetection: true as const,
    timingTemplate: "T4" as const,
    skipHostDiscovery: true as const,
    versionIntensity: 7 as const,
    maxRetries: 2 as const,
  };
  if (declaredPorts === null) {
    return base;
  }
  const ports = declaredPorts.map((port) => ({ from: port, to: port }));
  if (ports.length === 0) {
    return base;
  }
  return { ...base, ports };
}

export function prepareNmapExecution(params: {
  snapshot: ActionSnapshot;
  runRoot: string;
  runId: string;
  fence: string;
}): { ok: true; argv: readonly string[] } | { ok: false; reason: "invalid_action_snapshot" } {
  try {
    const xmlPath = resolveNmapXmlPath(params.runRoot, params.runId, params.fence);
    const adapted = adaptToNmapOptions(params.snapshot.typedOptions);
    if (adapted === null) return { ok: false, reason: "invalid_action_snapshot" };
    const built = buildNmapArgv({
      options: adapted,
      canonicalTargets: params.snapshot.canonicalTargets,
      xmlPath,
    });
    if (!built.ok) return { ok: false, reason: "invalid_action_snapshot" };
    return { ok: true, argv: built.argv };
  } catch {
    return { ok: false, reason: "invalid_action_snapshot" };
  }
}

/**
 * Derive ffuf discovery options plus deterministic argv from a leased
 * snapshot. The JSON output path is runner-owned host state under the
 * controlled run directory, never an operator option. Snapshots carrying a
 * corrupt ffuf marker fail closed here so they are never probed as HTTP.
 */
export function prepareFfufExecution(params: {
  snapshot: ActionSnapshot;
  runRoot: string;
  runId: string;
  fence: string;
}):
  | { ok: true; options: FfufActionOptions; argv: readonly string[] }
  | { ok: false; reason: "not_ffuf_snapshot" | "invalid_action_snapshot" } {
  try {
    if (!hasFfufMarker(params.snapshot)) return { ok: false, reason: "not_ffuf_snapshot" };
    const marker = ffufOptionsForSnapshot(params.snapshot);
    if (marker === null) return { ok: false, reason: "invalid_action_snapshot" };
    const outputJsonPath = resolveFfufJsonPath(params.runRoot, params.runId, params.fence);
    const options: FfufActionOptions = { ...marker, outputJsonPath };
    const built = buildFfufArgv(options);
    if (!built.ok) return { ok: false, reason: "invalid_action_snapshot" };
    return { ok: true, options, argv: built.argv };
  } catch {
    return { ok: false, reason: "invalid_action_snapshot" };
  }
}

/**
 * Derive vhost discovery options plus deterministic argv from a leased
 * snapshot. The JSON output path is runner-owned host state under the
 * controlled run directory, never an operator option. Corrupt vhost
 * markers fail closed so they never run as plain ffuf or HTTP probes.
 */
export function prepareVhostExecution(params: {
  snapshot: ActionSnapshot;
  runRoot: string;
  runId: string;
  fence: string;
}):
  | { ok: true; options: FfufVhostActionOptions; argv: readonly string[] }
  | { ok: false; reason: "not_vhost_snapshot" | "invalid_action_snapshot" } {
  try {
    if (!hasVhostMarker(params.snapshot)) return { ok: false, reason: "not_vhost_snapshot" };
    const marker = vhostOptionsForSnapshot(params.snapshot);
    if (marker === null) return { ok: false, reason: "invalid_action_snapshot" };
    const outputJsonPath = resolveVhostJsonPath(params.runRoot, params.runId, params.fence);
    const options: FfufVhostActionOptions = { ...marker, outputJsonPath };
    const built = buildVhostArgv(options);
    if (!built.ok) return { ok: false, reason: "invalid_action_snapshot" };
    return { ok: true, options, argv: built.argv };
  } catch {
    return { ok: false, reason: "invalid_action_snapshot" };
  }
}

export async function handshake(config: RunnerConfig, signal?: AbortSignal): Promise<HandshakeResponse> {
  const url = `${config.apiBaseUrl}/api/v1/runner/handshake`;
  const rawBody = RunnerHandshakeRequestSchema.parse({
    protocol: "runner-control-v1",
    sessionId: config.sessionId,
    installationFingerprint: config.installationFingerprint,
    eventSchemas: ["runner-event-v1"],
    capabilities: [],
  });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: authHeader(config.runnerId, config.secret),
    },
    body: JSON.stringify(rawBody),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`handshake failed ${res.status}: ${text}`);
  }
  const json = await res.json();
  return RunnerHandshakeAcceptedResponseSchema.parse(json);
}

export async function acquireLease(
  config: RunnerConfig,
): Promise<AcquiredLease | null> {
  const url = `${config.apiBaseUrl}/api/v1/runner/lease`;
  const rawBody = AcquireRunnerLeaseRequestSchema.parse({ sessionId: config.sessionId });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: authHeader(config.runnerId, config.secret),
    },
    body: JSON.stringify(rawBody),
  });
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { code?: string };
    if (body.code === "no_work") return null;
    throw new Error(`lease acquire 409 ${body.code}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`acquireLease failed ${res.status}: ${text}`);
  }
  const json = await res.json();
  return AcquireRunnerLeaseResponseSchema.parse(json);
}

export async function heartbeat(
  config: RunnerConfig,
  lease: AcquiredLease["lease"],
  sequence: number,
  signal?: AbortSignal,
): Promise<HeartbeatResponse> {
  const url = `${config.apiBaseUrl}/api/v1/runner/leases/${lease.leaseId}/heartbeat`;
  const rawBody = RunnerHeartbeatRequestSchema.parse({
    runId: lease.runId,
    sessionId: lease.sessionId,
    fence: lease.fence,
    heartbeatSequence: sequence,
  });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: authHeader(config.runnerId, config.secret),
    },
    body: JSON.stringify(rawBody),
    signal: signal ?? AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { code?: string } | null;
    const code = body?.code ?? `http_${res.status}`;
    const err = new Error(`heartbeat failed ${code}`) as Error & { code?: string; status?: number };
    err.code = code;
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  return RunnerHeartbeatResponseSchema.parse(json);
}

export async function appendStarted(
  config: RunnerConfig,
  lease: AcquiredLease["lease"],
  sequence: number,
): Promise<RunnerEventResponse> {
  const url = `${config.apiBaseUrl}/api/v1/runner/leases/${lease.leaseId}/events`;
  const route = `/api/v1/runner/leases/${lease.leaseId}/events`;
  const rawBody = RunnerAppendStartedRequestSchema.parse({
    runId: lease.runId,
    sessionId: lease.sessionId,
    fence: lease.fence,
    sequence,
    payload: { startedAt: new Date().toISOString() },
  });
  const { entry } = await getOrCreateOutboxEntry({
    dataDir: config.dataDir,
    actorId: config.runnerId,
    route,
    operation: "append_started",
    path: { leaseId: lease.leaseId },
    query: {},
    body: rawBody as unknown as import("@stonehush/contracts").JsonValue,
    digestProjection: commandJsonV1RunnerAppendStartedDigest,
  });
  const key = entry.key;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: authHeader(config.runnerId, config.secret),
        "idempotency-key": key,
      },
      body: JSON.stringify(rawBody),
    });
  } catch (e) {
    throw e;
  }
  try {
    await removeOutboxAtomically(config.dataDir, key);
  } catch (e) {
    throw new Error(`outbox removal failed: ${String(e)}`);
  }
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { code?: string; expectedSequence?: number };
    const err = new Error(`appendStarted failed ${res.status} ${j.code ?? ""}`) as Error & { code?: string };
    if (j.code !== undefined) (err as { code?: string }).code = j.code;
    throw err;
  }
  const json = await res.json();
  return RunnerEventResponseSchema.parse(json);
}

export async function completeRun(
  config: RunnerConfig,
  lease: AcquiredLease["lease"],
  sequence: number,
  terminalKind: "succeeded" | "failed" | "cancelled",
  reason: string | null,
): Promise<RunnerEventResponse> {
  const url = `${config.apiBaseUrl}/api/v1/runner/leases/${lease.leaseId}/complete`;
  const route = `/api/v1/runner/leases/${lease.leaseId}/complete`;
  const rawBody = RunnerCompleteRequestSchema.parse({
    runId: lease.runId,
    sessionId: lease.sessionId,
    fence: lease.fence,
    sequence,
    terminalKind,
    reason,
  });
  const { entry } = await getOrCreateOutboxEntry({
    dataDir: config.dataDir,
    actorId: config.runnerId,
    route,
    operation: "complete",
    path: { leaseId: lease.leaseId },
    query: {},
    body: rawBody as unknown as import("@stonehush/contracts").JsonValue,
    digestProjection: commandJsonV1RunnerCompleteDigest,
  });
  const key = entry.key;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: authHeader(config.runnerId, config.secret),
        "idempotency-key": key,
      },
      body: JSON.stringify(rawBody),
    });
  } catch (e) {
    throw e;
  }
  try {
    await removeOutboxAtomically(config.dataDir, key);
  } catch (e) {
    throw new Error(`outbox removal failed: ${String(e)}`);
  }
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { code?: string };
    const err = new Error(`complete failed ${res.status} ${j.code ?? ""}`) as Error & { code?: string };
    if (j.code !== undefined) (err as { code?: string }).code = j.code;
    throw err;
  }
  const json = await res.json();
  return RunnerEventResponseSchema.parse(json);
}

/**
 * Single-iteration Nmap execution: handshake -> lease -> started -> heartbeat -> Nmap spawn -> complete.
 * Nmap argv is derived deterministically from acquired.actionSnapshot before spawn using the controlled run directory.
 * Invalid snapshot or unusable executable completes with a fixed non-reflective reason without spawn.
 */
export async function runOnce(
  overrides: Partial<RunnerConfig> = {},
  opts: { signal?: AbortSignal; onHandshake?: () => void } = {},
): Promise<boolean> {
  const signal = opts.signal;
  throwIfAborted(signal);
  const config = resolveRunnerConfig(overrides);
  if (config.runnerId === "" || config.secret === "") {
    throw new Error("runner credentials required (STONEHUSH_RUNNER_ID/SECRET)");
  }

  throwIfAborted(signal);
  await handshake(config, signal);
  throwIfAborted(signal);
  opts.onHandshake?.();

  const leaseSendMonotonic = globalThis.performance.now();
  const acquired = await acquireLease(config);
  throwIfAborted(signal);
  if (acquired === null) return false;

  const lease = acquired.lease;

  let nextSequence = 2;
  try {
    throwIfAborted(signal);
    const started = await appendStarted(config, lease, 1);
    nextSequence = started.event.sequence + 1;
    throwIfAborted(signal);
  } catch (e) {
    if (e instanceof RunnerShutdownError) {
      try {
        await completeRun(config, lease, nextSequence, "failed", "runner_lost");
      } catch {}
      throw e;
    }
    throw e;
  }

  let authorityDeadlineMonotonic = leaseSendMonotonic + config.leaseDurationMs;
  let hbSeq = 1;
  let hbTimer: ReturnType<typeof setInterval> | null = null;
  let hbFailed = false;
  let shutdownAfterStarted = false;
  const onAbortAfterStarted = (): void => {
    shutdownAfterStarted = true;
  };
  if (signal) {
    if (signal.aborted) shutdownAfterStarted = true;
    else signal.addEventListener("abort", onAbortAfterStarted, { once: true });
  }

  let cancellationRequested = false;
  let heartbeatInFlight: Promise<void> | null = null;
  let pendingHeartbeatSentMonotonic: number | null = null;
  const pollHeartbeat = (): Promise<void> => {
    if (hbFailed || signal?.aborted || globalThis.performance.now() >= authorityDeadlineMonotonic - 7000) {
      hbFailed = true;
      return Promise.resolve();
    }
    if (heartbeatInFlight !== null) return heartbeatInFlight;
    pendingHeartbeatSentMonotonic ??= globalThis.performance.now();
    const hbSendMonotonic = pendingHeartbeatSentMonotonic;
    const heartbeatSignal = signal === undefined ? AbortSignal.timeout(5000) : AbortSignal.any([signal, AbortSignal.timeout(5000)]);
    const nextSeq = hbSeq + 1;
    heartbeatInFlight = heartbeat(config, lease, nextSeq, heartbeatSignal)
      .then((response) => {
        if (hbFailed || globalThis.performance.now() >= authorityDeadlineMonotonic - 7000) {
          hbFailed = true;
          return;
        }
        hbSeq = nextSeq;
        pendingHeartbeatSentMonotonic = null;
        authorityDeadlineMonotonic = hbSendMonotonic + config.leaseDurationMs;
        cancellationRequested ||= response.cancellationRequested === true;
      })
      .catch((e: unknown) => {
        const error = e as { code?: string; status?: number };
        if (error.status === 401 || error.status === 403 ||
          error.code === "stale_fence" || error.code === "lease_expired" || error.code === "lease_owner_mismatch") {
          hbFailed = true;
        }
      })
      .finally(() => { heartbeatInFlight = null; });
    return heartbeatInFlight;
  };
  hbTimer = setInterval(() => {
    if (signal?.aborted) return;
    void pollHeartbeat();
  }, config.heartbeatIntervalMs);
  hbTimer.unref();

  const cleanup = (): void => {
    if (hbTimer !== null) clearInterval(hbTimer);
    if (signal) signal.removeEventListener("abort", onAbortAfterStarted);
  };

  try {
    const prepared = prepareNmapExecution({
      snapshot: acquired.actionSnapshot,
      runRoot: config.runRoot,
      runId: lease.runId,
      fence: lease.fence,
    });
    let executableUnavailable = false;
    if (prepared.ok) {
      try {
        await verifyExecutable(config.executable);
      } catch {
        executableUnavailable = true;
      }
    }

    const isAuthorityLost = (): boolean =>
      Boolean(signal?.aborted) ||
      shutdownAfterStarted ||
      hbFailed ||
      globalThis.performance.now() >= authorityDeadlineMonotonic - 7000;

    if (isAuthorityLost()) {
      await completeRun(config, lease, nextSequence, "failed", "runner_lost").catch(() => {});
      if (signal?.aborted) throw new RunnerShutdownError();
      return true;
    }

    let cancelNative: ReturnType<typeof runSupervisedCommand>["cancel"] | null = null;
    const stopNative = async () => cancelNative?.();
    const finishOperatorCancellation = async (
      publish: () => Promise<void>,
      cleanupFailed = false,
    ): Promise<boolean> => {
      const nativeCleanup = await stopNative();
      cleanupFailed ||= nativeCleanup?.cleanupFailed === true;
      if (isAuthorityLost()) {
        await completeRun(config, lease, nextSequence, "failed", "runner_lost").catch(() => {});
        if (signal?.aborted) throw new RunnerShutdownError();
        return true;
      }
      try {
        await publish();
      } catch (e) {
        await completeRun(config, lease, nextSequence, "failed", "evidence_publication_failed").catch(() => {});
        if (e instanceof EvidencePublicationError) throw e;
        throw new EvidencePublicationError("evidence_publication_failed");
      }
      if (isAuthorityLost()) {
        await completeRun(config, lease, nextSequence, "failed", "runner_lost").catch(() => {});
        if (signal?.aborted) throw new RunnerShutdownError();
        return true;
      }
      await completeRun(config, lease, nextSequence,
        cleanupFailed ? "failed" : "cancelled",
        cleanupFailed ? "process_cleanup_failed" : "operator_cancelled");
      return true;
    };
    const completeExecution = async (kind: "succeeded" | "failed", reason: string | null): Promise<void> => {
      if (isAuthorityLost()) {
        await stopNative();
        await completeRun(config, lease, nextSequence, "failed", "runner_lost").catch(() => {});
        if (signal?.aborted) throw new RunnerShutdownError();
        return;
      }
      try {
        await completeRun(config, lease, nextSequence, kind, reason);
      } catch (e) {
        // Cancellation and success serialize in the control plane. If cancel
        // committed first after publication, retain immutable completed bytes
        // and acknowledge cleanup with the still-current lease.
        if ((e as { code?: string }).code !== "invalid_run_transition") throw e;
        await pollHeartbeat();
        if (isAuthorityLost()) {
          await stopNative();
          await completeRun(config, lease, nextSequence, "failed", "runner_lost").catch(() => {});
          if (signal?.aborted) throw new RunnerShutdownError();
          return;
        }
        if (!cancellationRequested) throw e;
        await finishOperatorCancellation(async () => {});
      }
    };

    await pollHeartbeat();
    if (isAuthorityLost()) {
      await completeRun(config, lease, nextSequence, "failed", "runner_lost").catch(() => {});
      if (signal?.aborted) throw new RunnerShutdownError();
      return true;
    }
    const cancelBeforeExecution = (): Promise<boolean> => finishOperatorCancellation(() => publishHttpProbeArtifacts(config, lease, {
      stdout: Buffer.alloc(0), rawArtifacts: [], isCancelled: true, eventSequence: nextSequence,
    }));
    if (cancellationRequested) return await cancelBeforeExecution();

    // vhost discovery runs before ffuf content discovery: the vhost marker
    // is an IP target with Host header fuzzing, so it never collides with a
    // URL-origin ffuf action. Corrupt markers fail closed here.
    const vhost = prepareVhostExecution({
      snapshot: acquired.actionSnapshot,
      runRoot: config.runRoot,
      runId: lease.runId,
      fence: lease.fence,
    });
    if (vhost.ok || vhost.reason === "invalid_action_snapshot") {
      if (!vhost.ok) {
        await completeRun(config, lease, nextSequence, "failed", "invalid_ffuf_vhost_contract").catch(() => {});
        return true;
      }
      try {
        await verifyExecutable(FFUF_DEFAULT_EXECUTABLE);
      } catch {
        await completeRun(config, lease, nextSequence, "failed", "ffuf_missing").catch(() => {});
        return true;
      }
      if (isAuthorityLost()) {
        await completeRun(config, lease, nextSequence, "failed", "runner_lost").catch(() => {});
        if (signal?.aborted) throw new RunnerShutdownError();
        return true;
      }

      if (cancellationRequested) return await cancelBeforeExecution();

      let captured: ProcessResult | null = null;
      let cancelSpawn: ReturnType<typeof runSupervisedCommand>["cancel"] | null = null;
      const vhostSpawn = (request: { executable: string; argv: readonly string[] }) => {
        const handle = runSupervisedCommand({
          runId: lease.runId,
          leaseId: lease.leaseId,
          fence: lease.fence,
          runRoot: config.runRoot,
          executable: request.executable,
          argv: request.argv,
          configuration: "ffuf",
          secrets: [config.secret],
          shouldCancel: () => cancellationRequested || isAuthorityLost(),
        });
        cancelSpawn = () => handle.cancel();
        cancelNative = cancelSpawn;
        return handle.then((result) => {
          captured = result;
          return { exitCode: result.exitCode };
        });
      };
      const readVhostOutput = async (absolutePath: string): Promise<Buffer> => {
        if (absolutePath !== vhost.options.outputJsonPath) throw new Error("vhost_json_unavailable");
        return readVhostJsonSecurely({ runRoot: config.runRoot, runId: lease.runId, fence: lease.fence });
      };
      let vhostFenceCheck: ReturnType<typeof setInterval> | null = null;
      vhostFenceCheck = setInterval(() => {
        if (cancellationRequested || isAuthorityLost()) {
          void cancelSpawn?.();
          if (vhostFenceCheck !== null) clearInterval(vhostFenceCheck);
        }
      }, 500);
      if (typeof (vhostFenceCheck as unknown as { unref?: () => void }).unref === "function") {
        (vhostFenceCheck as unknown as { unref: () => void }).unref?.();
      }

      let discovery: Awaited<ReturnType<typeof runVhostDiscovery>>;
      try {
        discovery = await runVhostDiscovery(
          {
            runContext: { runId: lease.runId, leaseId: lease.leaseId, fence: lease.fence, runRoot: config.runRoot },
            ffufExecutable: FFUF_DEFAULT_EXECUTABLE,
            spawn: vhostSpawn,
            readOutputJson: readVhostOutput,
          },
          vhost.options,
        );
      } catch {
        discovery = { ok: false, error: { code: "ffuf_parse_error" } };
      } finally {
        if (vhostFenceCheck !== null) clearInterval(vhostFenceCheck);
      }

      const readPartialJson = async (): Promise<Buffer | undefined> => {
        try {
          return await readVhostJsonSecurely({ runRoot: config.runRoot, runId: lease.runId, fence: lease.fence });
        } catch {
          return undefined;
        }
      };

      await pollHeartbeat();
      if (isAuthorityLost()) {
        await stopNative();
        if (captured !== null) {
          const partial = await readPartialJson();
          try {
            await publishVhostArtifacts(config, lease, captured, {
              isCancelled: true,
              eventSequence: nextSequence,
              ...(partial === undefined ? {} : { vhostJson: partial }),
              vhostExitCode: discovery.ok ? discovery.exitCode : null,
            });
          } catch {}
        }
        await completeRun(config, lease, nextSequence, "failed", "runner_lost").catch(() => {});
        if (signal?.aborted) throw new RunnerShutdownError();
        return true;
      }

      if (cancellationRequested) {
        const partial = await readPartialJson();
        const result = captured as ProcessResult | null;
        if (result === null) {
          await completeRun(config, lease, nextSequence, "failed", "process_cleanup_failed");
          return true;
        }
        return await finishOperatorCancellation(() => publishVhostArtifacts(config, lease, result, {
          isCancelled: true,
          eventSequence: nextSequence,
          ...(partial === undefined ? {} : { vhostJson: partial }),
          vhostExitCode: discovery.ok ? discovery.exitCode : null,
        }), result.cleanupFailed === true);
      }

      if (captured !== null) {
        const preserved = await readPartialJson();
        try {
          await publishVhostArtifacts(config, lease, captured, {
            isCancelled: false,
            eventSequence: nextSequence,
            ...(preserved === undefined ? {} : { vhostJson: preserved }),
            vhostExitCode: discovery.ok ? discovery.exitCode : null,
          });
        } catch (e) {
          await completeRun(config, lease, nextSequence, "failed", "evidence_publication_failed").catch(() => {});
          if (e instanceof EvidencePublicationError) throw e;
          throw new EvidencePublicationError("evidence_publication_failed");
        }
      }
      if (!discovery.ok) {
        const reason =
          discovery.error.code === "invalid_ffuf_vhost_contract"
            ? "invalid_ffuf_vhost_contract"
            : discovery.error.code;
        await completeRun(config, lease, nextSequence, "failed", reason).catch(() => {});
        return true;
      }
      if (discovery.exitCode === 0) {
        await completeExecution("succeeded", null);
      } else {
        await completeExecution("failed", "process_failed");
      }
      return true;
    }

    // ffuf discovery runs before the HTTP probe branch: an ffuf origin is also
    // a URL target, so the ffuf marker must win dispatch. Corrupt markers fail
    // closed here instead of falling through to a plain probe.
    const ffuf = prepareFfufExecution({
      snapshot: acquired.actionSnapshot,
      runRoot: config.runRoot,
      runId: lease.runId,
      fence: lease.fence,
    });
    if (ffuf.ok || ffuf.reason === "invalid_action_snapshot") {
      if (!ffuf.ok) {
        await completeRun(config, lease, nextSequence, "failed", "invalid_ffuf_action_contract").catch(() => {});
        return true;
      }
      try {
        await verifyExecutable(FFUF_DEFAULT_EXECUTABLE);
      } catch {
        await completeRun(config, lease, nextSequence, "failed", "ffuf_missing").catch(() => {});
        return true;
      }
      if (isAuthorityLost()) {
        await completeRun(config, lease, nextSequence, "failed", "runner_lost").catch(() => {});
        if (signal?.aborted) throw new RunnerShutdownError();
        return true;
      }

      if (cancellationRequested) return await cancelBeforeExecution();

      let captured: ProcessResult | null = null;
      let cancelSpawn: ReturnType<typeof runSupervisedCommand>["cancel"] | null = null;
      const ffufSpawn = (request: { executable: string; argv: readonly string[] }) => {
        const handle = runSupervisedCommand({
          runId: lease.runId,
          leaseId: lease.leaseId,
          fence: lease.fence,
          runRoot: config.runRoot,
          executable: request.executable,
          argv: request.argv,
          configuration: "ffuf",
          secrets: [config.secret],
          shouldCancel: () => cancellationRequested || isAuthorityLost(),
        });
        cancelSpawn = () => handle.cancel();
        cancelNative = cancelSpawn;
        return handle.then((result) => {
          captured = result;
          return { exitCode: result.exitCode };
        });
      };
      const readFfufOutput = async (absolutePath: string): Promise<Buffer> => {
        if (absolutePath !== ffuf.options.outputJsonPath) throw new Error("ffuf_json_unavailable");
        return readFfufJsonSecurely({ runRoot: config.runRoot, runId: lease.runId, fence: lease.fence });
      };
      let ffufFenceCheck: ReturnType<typeof setInterval> | null = null;
      ffufFenceCheck = setInterval(() => {
        if (cancellationRequested || isAuthorityLost()) {
          void cancelSpawn?.();
          if (ffufFenceCheck !== null) clearInterval(ffufFenceCheck);
        }
      }, 500);
      if (typeof (ffufFenceCheck as unknown as { unref?: () => void }).unref === "function") {
        (ffufFenceCheck as unknown as { unref: () => void }).unref?.();
      }

      let discovery: Awaited<ReturnType<typeof runFfufDiscovery>>;
      try {
        discovery = await runFfufDiscovery(
          {
            runContext: { runId: lease.runId, leaseId: lease.leaseId, fence: lease.fence, runRoot: config.runRoot },
            ffufExecutable: FFUF_DEFAULT_EXECUTABLE,
            spawn: ffufSpawn,
            readOutputJson: readFfufOutput,
          },
          ffuf.options,
        );
      } catch {
        discovery = { ok: false, error: { code: "ffuf_parse_error" } };
      } finally {
        if (ffufFenceCheck !== null) clearInterval(ffufFenceCheck);
      }

      const readPartialJson = async (): Promise<Buffer | undefined> => {
        try {
          return await readFfufJsonSecurely({ runRoot: config.runRoot, runId: lease.runId, fence: lease.fence });
        } catch {
          return undefined;
        }
      };

      await pollHeartbeat();
      if (isAuthorityLost()) {
        await stopNative();
        if (captured !== null) {
          const partial = await readPartialJson();
          try {
            await publishFfufArtifacts(config, lease, captured, {
              isCancelled: true,
              eventSequence: nextSequence,
              ...(partial === undefined ? {} : { ffufJson: partial }),
              ffufExitCode: discovery.ok ? discovery.exitCode : null,
            });
          } catch {}
        }
        await completeRun(config, lease, nextSequence, "failed", "runner_lost").catch(() => {});
        if (signal?.aborted) throw new RunnerShutdownError();
        return true;
      }

      if (cancellationRequested) {
        const partial = await readPartialJson();
        const result = captured as ProcessResult | null;
        if (result === null) {
          await completeRun(config, lease, nextSequence, "failed", "process_cleanup_failed");
          return true;
        }
        return await finishOperatorCancellation(() => publishFfufArtifacts(config, lease, result, {
          isCancelled: true,
          eventSequence: nextSequence,
          ...(partial === undefined ? {} : { ffufJson: partial }),
          ffufExitCode: discovery.ok ? discovery.exitCode : null,
        }), result.cleanupFailed === true);
      }

      if (captured !== null) {
        const preserved = await readPartialJson();
        try {
          await publishFfufArtifacts(config, lease, captured, {
            isCancelled: false,
            eventSequence: nextSequence,
            ...(preserved === undefined ? {} : { ffufJson: preserved }),
            ffufExitCode: discovery.ok ? discovery.exitCode : null,
          });
        } catch (e) {
          await completeRun(config, lease, nextSequence, "failed", "evidence_publication_failed").catch(() => {});
          if (e instanceof EvidencePublicationError) throw e;
          throw new EvidencePublicationError("evidence_publication_failed");
        }
      }
      if (!discovery.ok) {
        await completeRun(config, lease, nextSequence, "failed", discovery.error.code).catch(() => {});
        return true;
      }
      if (discovery.exitCode === 0) {
        await completeExecution("succeeded", null);
      } else {
        await completeExecution("failed", "process_failed");
      }
      return true;
    }

    const probeUrls = probeUrlsFromSnapshot(acquired.actionSnapshot);
    if (probeUrls !== null) {
      const httpProbeController = new AbortController();
      const onOuterAbortHttp = (): void => {
        try {
          httpProbeController.abort();
        } catch {}
      };
      if (signal) {
        if (signal.aborted) {
          try {
            httpProbeController.abort();
          } catch {}
        } else {
          signal.addEventListener("abort", onOuterAbortHttp, { once: true });
        }
      }
      let httpFenceCheck: ReturnType<typeof setInterval> | null = setInterval(() => {
        if (cancellationRequested || isAuthorityLost()) {
          try {
            httpProbeController.abort();
          } catch {}
          if (httpFenceCheck !== null) {
            clearInterval(httpFenceCheck);
            httpFenceCheck = null;
          }
        }
      }, 500);
      if (typeof (httpFenceCheck as unknown as { unref?: () => void }).unref === "function") {
        (httpFenceCheck as unknown as { unref: () => void }).unref?.();
      }
      if (isAuthorityLost()) {
        try {
          httpProbeController.abort();
        } catch {}
      }
      const rawArtifacts: Buffer[] = [];
      let probeFailed = false;
      let probeAborted = false;
      for (const url of probeUrls) {
        if (httpProbeController.signal.aborted || cancellationRequested || isAuthorityLost()) {
          probeAborted = true;
          break;
        }
        try {
          const probed = await probeOneUrl(url, { signal: httpProbeController.signal });
          rawArtifacts.push(probed.rawBytes);
        } catch (e) {
          if (
            e instanceof ProbeAbortedError ||
            e instanceof RunnerShutdownError ||
            (e as { name?: string })?.name === "AbortError" ||
            httpProbeController.signal.aborted ||
            isAuthorityLost()
          ) {
            probeAborted = true;
          } else {
            probeFailed = true;
          }
          break;
        }
      }
      if (httpFenceCheck !== null) {
        clearInterval(httpFenceCheck);
        httpFenceCheck = null;
      }
      if (signal) signal.removeEventListener("abort", onOuterAbortHttp);
      await pollHeartbeat();
      if (cancellationRequested && !isAuthorityLost()) {
        return await finishOperatorCancellation(() => publishHttpProbeArtifacts(config, lease, {
          stdout: Buffer.from(`probed ${String(rawArtifacts.length)} of ${String(probeUrls.length)} url(s) with http-probe-raw-v1`, "utf8"),
          rawArtifacts,
          isCancelled: true,
          eventSequence: nextSequence,
        }));
      }
      if (probeAborted || isAuthorityLost()) {
        // Preserve a fully completed URL set as partial evidence only when the
        // fence still permits publication. A partial URL subset is discarded to
        // preserve all-or-nothing run-target correspondence; an expired or
        // superseded lease is never published.
        const fenceStillValid =
          !hbFailed && globalThis.performance.now() < authorityDeadlineMonotonic - 7000;
        if (rawArtifacts.length === probeUrls.length && rawArtifacts.length > 0 && fenceStillValid) {
          try {
            const stdout = Buffer.from(
              `probed ${String(rawArtifacts.length)} url(s) with http-probe-raw-v1`,
              "utf8",
            );
            await publishHttpProbeArtifacts(config, lease, {
              stdout,
              rawArtifacts,
              isCancelled: true,
              eventSequence: nextSequence,
            });
          } catch {}
        }
        await completeRun(config, lease, nextSequence, "failed", "runner_lost").catch(() => {});
        if (signal?.aborted) throw new RunnerShutdownError();
        return true;
      }
      if (probeFailed || rawArtifacts.length !== probeUrls.length) {
        await completeRun(config, lease, nextSequence, "failed", "evidence_publication_failed").catch(() => {});
        throw new EvidencePublicationError("evidence_publication_failed");
      }
      if (isAuthorityLost()) {
        await completeRun(config, lease, nextSequence, "failed", "runner_lost").catch(() => {});
        if (signal?.aborted) throw new RunnerShutdownError();
        return true;
      }
      try {
        const stdout = Buffer.from(
          `probed ${String(rawArtifacts.length)} url(s) with http-probe-raw-v1`,
          "utf8",
        );
        await publishHttpProbeArtifacts(config, lease, {
          stdout,
          rawArtifacts,
          isCancelled: false,
          eventSequence: nextSequence,
        });
      } catch (e) {
        try {
          await completeRun(config, lease, nextSequence, "failed", "evidence_publication_failed");
        } catch {}
        if (e instanceof EvidencePublicationError) throw e;
        throw new EvidencePublicationError("evidence_publication_failed");
      }
      await completeExecution("succeeded", null);
      return true;
    }

    if (!prepared.ok) {
      await completeRun(config, lease, nextSequence, "failed", prepared.reason).catch(() => {});
      return true;
    }

    if (executableUnavailable) {
      await completeRun(config, lease, nextSequence, "failed", "nmap_unavailable").catch(() => {});
      return true;
    }

    const nmapArgv = prepared.argv;

    let result: Awaited<ReturnType<typeof runSupervisedCommand>> | null = null;
    let cancelledByFence = false;
    let handle: ReturnType<typeof runSupervisedCommand> | null = null;
    let fenceCheck: ReturnType<typeof setInterval> | null = null;

    const fullCleanup = (): void => {
      if (fenceCheck !== null) clearInterval(fenceCheck);
    };

    try {
      throwIfAborted(signal);
      handle = runSupervisedCommand({
        runId: lease.runId,
        leaseId: lease.leaseId,
        fence: lease.fence,
        runRoot: config.runRoot,
        executable: config.executable,
        argv: nmapArgv,
        secrets: [config.secret],
        shouldCancel: () => cancellationRequested || isAuthorityLost(),
      });

      cancelNative = () => handle?.cancel() ?? Promise.resolve({ cleanupFailed: true });
      if (signal?.aborted || shutdownAfterStarted) {
        cancelledByFence = true;
        void handle.cancel();
      }

      fenceCheck = setInterval(() => {
        if (cancellationRequested || isAuthorityLost()) {
          cancelledByFence = isAuthorityLost();
          void handle?.cancel();
          if (fenceCheck !== null) clearInterval(fenceCheck);
        }
      }, 500);
      if (typeof (fenceCheck as unknown as { unref?: () => void }).unref === "function") {
        (fenceCheck as unknown as { unref: () => void }).unref?.();
      }

      result = await handle;
      if (fenceCheck !== null) clearInterval(fenceCheck);
    } catch {
      fullCleanup();
      if (isAuthorityLost()) {
        await completeRun(config, lease, nextSequence, "failed", "runner_lost").catch(() => {});
        if (signal?.aborted) throw new RunnerShutdownError();
        return true;
      }
      await completeRun(config, lease, nextSequence, "failed", "nmap_unavailable").catch(() => {});
      return true;
    }
    fullCleanup();

    if (signal?.aborted || shutdownAfterStarted) {
      cancelledByFence = true;
    }

    await pollHeartbeat();
    if (cancellationRequested && !isAuthorityLost() && result !== null) {
      let xml: Buffer | undefined;
      try { xml = await readNmapXmlSecurely({ runRoot: config.runRoot, runId: lease.runId, fence: lease.fence }); } catch {}
      const captured = result;
      return await finishOperatorCancellation(() => publishEvidenceArtifacts(config, lease, captured, {
        isCancelled: true, eventSequence: nextSequence, nmapExitCode: captured.exitCode,
        ...(xml === undefined ? {} : { nmapXml: xml }),
      }), captured.cleanupFailed === true);
    }

    const isCancelledForEvidence = cancelledByFence || isAuthorityLost();

    if (isCancelledForEvidence) {
      await stopNative();
      if (result !== null) {
        let xml: Buffer | undefined;
        try {
          xml = await readNmapXmlSecurely({ runRoot: config.runRoot, runId: lease.runId, fence: lease.fence });
        } catch {}
        try {
          if (xml !== undefined) {
            await publishEvidenceArtifacts(config, lease, result, { isCancelled: true, eventSequence: nextSequence, nmapXml: xml, nmapExitCode: result.exitCode });
          } else {
            await publishEvidenceArtifacts(config, lease, result, { isCancelled: true, eventSequence: nextSequence, nmapExitCode: result.exitCode });
          }
        } catch {}
      }
      await completeRun(config, lease, nextSequence, "failed", "runner_lost").catch(() => {});
      if (signal?.aborted) throw new RunnerShutdownError();
      return true;
    }

    if (result !== null) {
      let xml: Buffer | undefined;
      let xmlOk = false;
      try {
        xml = await readNmapXmlSecurely({ runRoot: config.runRoot, runId: lease.runId, fence: lease.fence });
        xmlOk = true;
      } catch {
        xmlOk = false;
      }
      const isSuccess = result.exitCode === 0;
      if (isSuccess && !xmlOk) {
        try {
          await publishEvidenceArtifacts(config, lease, result, { isCancelled: false, eventSequence: nextSequence });
        } catch {}
        await completeRun(config, lease, nextSequence, "failed", "evidence_publication_failed").catch(() => {});
        throw new EvidencePublicationError("evidence_publication_failed");
      }
      try {
        if (xmlOk && xml !== undefined) {
          await publishEvidenceArtifacts(config, lease, result, { isCancelled: false, eventSequence: nextSequence, nmapXml: xml, nmapExitCode: result.exitCode });
        } else {
          await publishEvidenceArtifacts(config, lease, result, { isCancelled: false, eventSequence: nextSequence, nmapExitCode: result.exitCode });
        }
      } catch (e) {
        try {
          await completeRun(config, lease, nextSequence, "failed", "evidence_publication_failed");
        } catch {}
        if (e instanceof EvidencePublicationError) throw e;
        throw new EvidencePublicationError("evidence_publication_failed");
      }
    }

    const terminalKind = result !== null && result.exitCode === 0 ? "succeeded" : "failed";
    const reason: string | null = terminalKind === "succeeded" ? null : "process_failed";
    await completeExecution(terminalKind, reason);
    return true;
  } finally {
    cleanup();
  }
}

export function createRunnerLoop(
  configOverrides: Partial<RunnerConfig> = {},
  options: { onHandshake?: () => void } = {},
): {
  start: () => void;
  stop: () => Promise<void>;
  isStopped: () => boolean;
} {
  let stopped = false;
  let stopPromise: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerResolve: (() => void) | null = null;
  let abortController: AbortController | null = null;
  let inFlight: Promise<boolean> | null = null;
  let loopPromise: Promise<void> | null = null;

  // Loop idle wait stays referenced so a standalone CLI with no other
  // handles keeps polling instead of exiting. stop() clears/resolves it
  // for prompt exit. Per-run heartbeat/fence timers remain unref'd.
  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((res) => {
      timerResolve = res;
      timer = setTimeout(() => {
        timer = null;
        timerResolve = null;
        res();
      }, ms);
    });

  const loop = async (): Promise<void> => {
    while (!stopped) {
      if (abortController === null || abortController.signal.aborted) {
        abortController = new AbortController();
      }
      const signal = abortController.signal;
      try {
        inFlight = runOnce(configOverrides, {
          signal,
          ...(options.onHandshake === undefined ? {} : { onHandshake: options.onHandshake }),
        });
        const didWork = await inFlight;
        inFlight = null;
        if (stopped) break;
        await sleep(didWork ? 100 : 1000);
      } catch (e) {
        inFlight = null;
        if (e instanceof RunnerShutdownError) {
          break;
        }
        if (stopped) break;
        await sleep(2000);
      }
    }
  };

  return {
    start() {
      if (loopPromise !== null) return;
      stopped = false;
      stopPromise = null;
      abortController = new AbortController();
      loopPromise = loop();
      loopPromise.catch(() => {});
    },
    stop(): Promise<void> {
      if (stopPromise !== null) return stopPromise;
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (timerResolve !== null) {
        const res = timerResolve;
        timerResolve = null;
        res();
      }
      abortController?.abort();
      stopPromise = (async () => {
        if (inFlight !== null) {
          try {
            await inFlight;
          } catch {}
        }
        if (loopPromise !== null) {
          try {
            await loopPromise;
          } catch {}
        }
      })();
      return stopPromise;
    },
    isStopped(): boolean {
      return stopped;
    },
  };
}
