import { createHash } from "node:crypto";

import {
  CompleteEvidenceUploadSuccessSchema,
  EvidenceGrantResponseSchema,
  commandJsonV1RunnerArtifactGrantDigest,
  type JsonValue,
} from "@stonehush/contracts";

import type { RunnerConfig } from "./config.js";
import { getOrCreateOutboxEntry, removeOutboxAtomically } from "./outbox.js";
import type { ProcessResult } from "./process.js";

export class EvidencePublicationError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "EvidencePublicationError";
    this.code = code;
  }
}

function authHeader(runnerId: string, secret: string): string {
  return `Stonehush-Runner ${runnerId} ${secret}`;
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function completenessFor(truncated: boolean, isCancelled: boolean): "complete" | "partial" | "truncated" {
  if (truncated) return "truncated";
  if (isCancelled) return "partial";
  return "complete";
}

// Fixed codes exposed to callers. Never include response bodies, paths, or digests.
const FIXED_GRANT_CODES = new Set([
  "stale_fence",
  "lease_expired",
  "lease_owner_mismatch",
  "run_already_terminal",
  "artifact_upload_in_progress",
  "event_sequence_gap",
]);

function grantRoute(): string {
  return "/api/v1/runner/artifacts/grants";
}

interface LeaseIdentity {
  runId: string;
  leaseId: string;
  sessionId: string;
  fence: string;
}

async function publishSingleArtifact(input: {
  config: RunnerConfig;
  lease: LeaseIdentity;
  eventSequence: number;
  slot: "stdout" | "stderr" | "nmap-xml" | (string & {});
  kind: "stdout" | "stderr" | "tool_raw";
  buffer: Buffer;
  truncated: boolean;
  isCancelled: boolean;
  completenessOverride?: "complete" | "partial" | "truncated";
}): Promise<void> {
  const { config, lease, eventSequence, slot, kind, buffer, truncated, isCancelled, completenessOverride } = input;
  const digestHex = sha256Hex(buffer);
  const declaredDigest = `sha256:${digestHex}`;
  const declaredSizeBytes = buffer.length;
  const originalFileName =
    slot === "nmap-xml"
      ? "nmap.xml"
      : slot === "ffuf-json"
        ? "ffuf.json"
        : slot === "stdout"
          ? "stdout.log"
          : slot === "stderr"
            ? "stderr.log"
            : "http-probe.json";
  const declaredContentType =
    slot === "nmap-xml"
      ? "application/xml"
      : slot === "stdout" || slot === "stderr"
        ? "text/plain; charset=utf-8"
        : "application/json";
  const completeness = completenessOverride ?? completenessFor(truncated, isCancelled);

  const grantBody = {
    runId: lease.runId,
    leaseId: lease.leaseId,
    sessionId: lease.sessionId,
    fence: lease.fence,
    eventSequence,
    artifactSlot: slot,
    kind,
    declaredSizeBytes,
    declaredDigest,
    originalFileName,
    declaredContentType,
  };

  const route = grantRoute();
  let grant: ReturnType<typeof EvidenceGrantResponseSchema.parse> | null = null;

  try {
    const { entry } = await getOrCreateOutboxEntry({
      dataDir: config.dataDir,
      actorId: config.runnerId,
      route,
      operation: "create_artifact_grant",
      path: {} as unknown as JsonValue,
      query: {} as unknown as JsonValue,
      body: grantBody as unknown as JsonValue,
      digestProjection: commandJsonV1RunnerArtifactGrantDigest,
    });

    const grantUrl = `${config.apiBaseUrl}/api/v1/runner/artifacts/grants`;
    let grantRes: Response;
    try {
      grantRes = await fetch(grantUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: authHeader(config.runnerId, config.secret),
          "idempotency-key": entry.key,
        },
        body: JSON.stringify(grantBody),
      });
    } catch {
      // Transport failure: retain outbox for retry.
      throw new EvidencePublicationError("evidence_publication_failed");
    }

    let grantJson: unknown;
    try {
      grantJson = await grantRes.json();
    } catch {
      throw new EvidencePublicationError("evidence_publication_failed");
    }

    // Non-2xx: retain outbox, expose fixed code only.
    if (!grantRes.ok) {
      const code = (grantJson as { code?: string })?.code;
      if (typeof code === "string" && FIXED_GRANT_CODES.has(code)) {
        throw new EvidencePublicationError(code);
      }
      // Known grant errors mapped to fixed publication failure when not in fixed set.
      throw new EvidencePublicationError("evidence_publication_failed");
    }

    const parsedGrant = EvidenceGrantResponseSchema.safeParse(grantJson);
    if (!parsedGrant.success) {
      // Ambiguous: retain outbox, fixed code only.
      throw new EvidencePublicationError("evidence_publication_failed");
    }
    grant = parsedGrant.data;

    // Response binding: every field reflecting the request must exactly match.
    // Schema-valid mismatch is ambiguous/untrusted: retain outbox, fixed error, no leak.
    {
      const g = grant;
      const b = grantBody;
      const mismatch =
        g.runId !== b.runId ||
        g.leaseId !== b.leaseId ||
        g.sessionId !== b.sessionId ||
        g.fence !== b.fence ||
        g.eventSequence !== b.eventSequence ||
        g.artifactSlot !== b.artifactSlot ||
        g.kind !== b.kind ||
        g.declaredSizeBytes !== b.declaredSizeBytes ||
        g.declaredDigest !== b.declaredDigest ||
        g.originalFileName !== b.originalFileName ||
        g.declaredContentType !== b.declaredContentType;
      if (mismatch) {
        throw new EvidencePublicationError("evidence_publication_failed");
      }
    }

    // Definitive schema-valid grant: remove outbox atomically.
    try {
      await removeOutboxAtomically(config.dataDir, entry.key);
    } catch {
      throw new EvidencePublicationError("evidence_publication_failed");
    }
  } catch (e) {
    if (e instanceof EvidencePublicationError) throw e;
    // Failure to create outbox entry is a fixed publication failure.
    throw new EvidencePublicationError("evidence_publication_failed");
  }

  if (grant === null) {
    throw new EvidencePublicationError("evidence_publication_failed");
  }

  // PUT raw bytes as application/octet-stream
  const putUrl = `${config.apiBaseUrl}/api/v1/runner/artifacts/uploads/${grant.uploadId}`;
  let putRes: Response;
  try {
    putRes = await fetch(putUrl, {
      method: "PUT",
      headers: {
        authorization: authHeader(config.runnerId, config.secret),
        "content-type": "application/octet-stream",
      },
      body: buffer as unknown as BodyInit,
    });
  } catch {
    throw new EvidencePublicationError("evidence_publication_failed");
  }
  if (putRes.status !== 204) {
    throw new EvidencePublicationError("evidence_publication_failed");
  }

  // POST complete with strict body, parse success schema.
  const completeBody = {
    uploadId: grant.uploadId,
    sizeBytes: declaredSizeBytes,
    digest: declaredDigest,
    completeness,
  };
  const completeUrl = `${config.apiBaseUrl}/api/v1/runner/artifacts/uploads/${grant.uploadId}/complete`;
  let completeRes: Response;
  try {
    completeRes = await fetch(completeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: authHeader(config.runnerId, config.secret),
      },
      body: JSON.stringify(completeBody),
    });
  } catch {
    throw new EvidencePublicationError("evidence_publication_failed");
  }
  if (!completeRes.ok) {
    // Do not leak body; fixed code only. Check for known fixed codes but map to generic.
    // Stale fence during complete is still a fixed publication failure for this path.
    // Preserve fixed stale_fence for direct grant-style errors if needed, but complete errors are generic.
    try {
      const j = (await completeRes.json().catch(() => null)) as { code?: string } | null;
      const code = j?.code;
      if (typeof code === "string" && FIXED_GRANT_CODES.has(code)) {
        throw new EvidencePublicationError(code);
      }
    } catch (e) {
      if (e instanceof EvidencePublicationError) throw e;
    }
    throw new EvidencePublicationError("evidence_publication_failed");
  }
  let completeJson: unknown;
  try {
    completeJson = await completeRes.json();
  } catch {
    throw new EvidencePublicationError("evidence_publication_failed");
  }
  const parsedComplete = CompleteEvidenceUploadSuccessSchema.safeParse(completeJson);
  if (!parsedComplete.success) {
    throw new EvidencePublicationError("evidence_publication_failed");
  }
  const disposition = parsedComplete.data.disposition;
  if (disposition !== "published" && disposition !== "stored_artifact_replayed") {
    throw new EvidencePublicationError("evidence_publication_failed");
  }
  // Completion binding: artifactId must equal accepted grant artifactId and
  // sizeBytes/digest/completeness must exactly equal the complete request.
  // Mismatch is ambiguous/untrusted: fixed error without leaking values.
  {
    const c = parsedComplete.data;
    const b = completeBody;
    const mismatch =
      c.artifactId !== grant.artifactId ||
      c.sizeBytes !== b.sizeBytes ||
      c.digest !== b.digest ||
      c.completeness !== b.completeness;
    if (mismatch) {
      throw new EvidencePublicationError("evidence_publication_failed");
    }
  }
}

/**
 * Publish one http-probe-raw tool_raw artifact per probed URL plus a small
 * stdout log and empty stderr, reusing the lease grant/upload machinery.
 * Slots are http-probe-raw, http-probe-raw-2, ... so the durable identity
 * (runId, fence, eventSequence, slot) stays unique per URL. The caller
 * passes the live eventSequence threaded from the started event.
 */
export async function publishHttpProbeArtifacts(
  config: RunnerConfig,
  lease: LeaseIdentity,
  input: { stdout: Buffer; rawArtifacts: Buffer[]; isCancelled: boolean; eventSequence: number },
): Promise<void> {
  const completeness = input.isCancelled ? "partial" : "complete";
  await publishSingleArtifact({
    config,
    lease,
    slot: "stdout",
    kind: "stdout",
    buffer: input.stdout,
    truncated: false,
    isCancelled: input.isCancelled,
    eventSequence: input.eventSequence,
  });
  await publishSingleArtifact({
    config,
    lease,
    slot: "stderr",
    kind: "stderr",
    buffer: Buffer.alloc(0),
    truncated: false,
    isCancelled: input.isCancelled,
    eventSequence: input.eventSequence,
  });
  for (const [index, raw] of input.rawArtifacts.entries()) {
    const slot = index === 0 ? "http-probe-raw" : `http-probe-raw-${index + 1}`;
    await publishSingleArtifact({
      config,
      lease,
      slot,
      kind: "tool_raw",
      buffer: raw,
      truncated: false,
      isCancelled: input.isCancelled,
      eventSequence: input.eventSequence,
      completenessOverride: completeness,
    });
  }
}

/**
 * Publish ProcessResult stdout then stderr after child settles and before completeRun.
 * Completeness: truncated if stream metadata truncated, else partial on cancellation, else complete. Truncated wins.
 * Grant uses lease identity, live eventSequence, durable outbox, PUT raw Buffer, POST strict complete.
 * Preserve first slot if second fails: stdout is not rolled back when stderr fails.
 * An optional tool_raw sidecar (nmap-xml or ffuf-json) publishes last with
 * partial completeness on cancellation or a non-zero tool exit.
 */
export async function publishEvidenceArtifacts(
  config: RunnerConfig,
  lease: LeaseIdentity,
  result: ProcessResult,
  options: {
    isCancelled: boolean;
    eventSequence: number;
    nmapXml?: Buffer;
    nmapExitCode?: number | null;
    ffufJson?: Buffer;
    ffufExitCode?: number | null;
  },
): Promise<void> {
  const isCancelled = options.isCancelled;
  const eventSequence = options.eventSequence;
  await publishSingleArtifact({
    config,
    lease,
    eventSequence,
    slot: "stdout",
    kind: "stdout",
    buffer: result.stdout,
    truncated: result.stdoutMeta.truncated,
    isCancelled,
  });
  await publishSingleArtifact({
    config,
    lease,
    eventSequence,
    slot: "stderr",
    kind: "stderr",
    buffer: result.stderr,
    truncated: result.stderrMeta.truncated,
    isCancelled,
  });
  const sidecars: Array<{ slot: "nmap-xml" | "ffuf-json"; buffer: Buffer; exitCode: number | null | undefined }> = [];
  if (options.nmapXml !== undefined) {
    sidecars.push({ slot: "nmap-xml", buffer: options.nmapXml, exitCode: options.nmapExitCode });
  }
  if (options.ffufJson !== undefined) {
    sidecars.push({ slot: "ffuf-json", buffer: options.ffufJson, exitCode: options.ffufExitCode });
  }
  for (const sidecar of sidecars) {
    let toolCompleteness: "complete" | "partial" = "complete";
    if (isCancelled) {
      toolCompleteness = "partial";
    } else if (
      sidecar.exitCode !== undefined &&
      sidecar.exitCode !== null &&
      sidecar.exitCode !== 0
    ) {
      toolCompleteness = "partial";
    }
    await publishSingleArtifact({
      config,
      lease,
      eventSequence,
      slot: sidecar.slot,
      kind: "tool_raw",
      buffer: sidecar.buffer,
      truncated: false,
      isCancelled,
      completenessOverride: toolCompleteness,
    });
  }
}

/**
 * Publish ffuf discovery evidence: stdout, stderr, then the raw ffuf -of
 * json output as tool_raw under the ffuf-json slot. The control plane
 * projects parsed results from the preserved JSON bytes.
 */
export async function publishFfufArtifacts(
  config: RunnerConfig,
  lease: LeaseIdentity,
  result: ProcessResult,
  options: { isCancelled: boolean; eventSequence: number; ffufJson?: Buffer; ffufExitCode?: number | null },
): Promise<void> {
  return publishEvidenceArtifacts(config, lease, result, {
    isCancelled: options.isCancelled,
    eventSequence: options.eventSequence,
    ...(options.ffufJson === undefined ? {} : { ffufJson: options.ffufJson }),
    ...(options.ffufExitCode === undefined ? {} : { ffufExitCode: options.ffufExitCode }),
  });
}
