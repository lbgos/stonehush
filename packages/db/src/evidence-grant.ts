import { randomUUID } from "node:crypto";

import {
  CreateEvidenceGrantRequestSchema,
  EVIDENCE_CONTRACT_VERSION,
  EVIDENCE_PROFILE,
  EVIDENCE_QUOTA_DEFAULTS,
  EvidenceArtifactRecordSchema,
  EvidenceGrantResponseSchema,
  EvidenceQuotaConfigSchema,
  RunnerLeaseSchema,
  RUNNER_CONTROL_PROFILE,
  RUNNER_CONTROL_PROTOCOL,
  type CompleteEvidenceUploadErrorCode,
  type CreateEvidenceGrantRequest,
  type EvidenceArtifactKind,
  type EvidenceGrantResponse,
  type EvidenceQuotaConfig,
  type PublishedCompleteness,
  type RunnerLease,
} from "@stonehush/contracts";
import { isTerminalRunState, validateLeaseAuthority } from "@stonehush/domain";
import { and, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema.js";
import {
  actions,
  evidenceArtifacts,
  evidenceGrants,
  runLeases,
  runs,
} from "./schema.js";

type DatabaseSchema = typeof schema;
export type EvidenceGrantWriteClient = Parameters<
  Parameters<BetterSQLite3Database<DatabaseSchema>["transaction"]>[0]
>[0];
export type EvidenceGrantQueryClient =
  | EvidenceGrantWriteClient
  | BetterSQLite3Database<DatabaseSchema>;

export type EvidenceGrantRepositoryError =
  | { code: "artifact_quota_exceeded" }
  | { code: "artifact_upload_in_progress" }
  | { code: "concurrent_upload_limit" }
  | { code: "event_sequence_gap"; expectedSequence: number }
  | { code: "invalid_persisted_data" }
  | { code: "invalid_repository_input" }
  | { code: "lease_expired" }
  | { code: "lease_owner_mismatch" }
  | { code: "run_already_terminal" }
  | { code: "run_not_found" }
  | { code: "run_quota_exceeded" }
  | { code: "stale_fence" }
  | { code: "staging_quota_exceeded" }
  | { code: "storage_busy" }
  | { code: "total_quota_exceeded" };

export type EvidenceGrantResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: EvidenceGrantRepositoryError };

export interface CreateEvidenceGrantInput extends CreateEvidenceGrantRequest {
  readonly runnerId: string;
  readonly serverNow: string;
}

export interface EvidenceGrantRepositoryProviders {
  createId?: () => string;
  now?: () => Date;
  quota?: unknown;
}

export type EvidenceGrantRecord = schema.EvidenceGrantRow;

function failed<T>(error: EvidenceGrantRepositoryError): EvidenceGrantResult<T> {
  return { ok: false, error };
}

// Lowercased UUIDv4: version nibble 4, RFC 4122 variant 8/9/a/b.
const EVIDENCE_GRANT_ID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isStorageBusy(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "SQLITE_BUSY" || error.code === "SQLITE_BUSY_TIMEOUT")
  );
}

function isUniqueConstraint(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "SQLITE_CONSTRAINT" ||
      error.code === "SQLITE_CONSTRAINT_UNIQUE" ||
      error.code === "SQLITE_CONSTRAINT_PRIMARYKEY")
  );
}

// Published bytes count against run and total quota headroom so admission
// cannot overcommit while artifacts stay published.
function publishedRunBytes(client: EvidenceGrantQueryClient, runId: string): number {
  const row = client
    .select({ total: sql<string | null>`sum(${evidenceArtifacts.sizeBytes})` })
    .from(evidenceArtifacts)
    .where(eq(evidenceArtifacts.runId, runId))
    .get();
  const total = row?.total;
  return total === null || total === undefined ? 0 : Number(total);
}

function publishedTotalBytes(client: EvidenceGrantQueryClient): number {
  const row = client
    .select({ total: sql<string | null>`sum(${evidenceArtifacts.sizeBytes})` })
    .from(evidenceArtifacts)
    .get();
  const total = row?.total;
  return total === null || total === undefined ? 0 : Number(total);
}

function currentLeaseForRun(
  client: EvidenceGrantQueryClient,
  runId: string,
) {
  return client
    .select()
    .from(runLeases)
    .where(and(eq(runLeases.runId, runId), eq(runLeases.current, true)))
    .get();
}

function leaseForAuthority(
  row: NonNullable<ReturnType<typeof currentLeaseForRun>>,
): EvidenceGrantResult<RunnerLease> {
  const lease = leaseFromRow(row);
  return lease === undefined
    ? failed({ code: "invalid_persisted_data" })
    : { ok: true, value: lease };
}

function leaseFromRow(
  row: NonNullable<ReturnType<typeof currentLeaseForRun>>,
): RunnerLease | undefined {
  const parsed = RunnerLeaseSchema.safeParse({
    orchestrationProfile: RUNNER_CONTROL_PROFILE,
    protocol: RUNNER_CONTROL_PROTOCOL,
    runId: row.runId,
    leaseId: row.leaseId,
    runnerId: row.runnerId,
    sessionId: row.sessionId,
    fence: row.fence,
    expiresAt: row.expiresAt,
    latestHeartbeatSequence: row.latestHeartbeatSequence,
    latestEventSequence: row.latestEventSequence,
  });
  return parsed.success ? parsed.data : undefined;
}

// Lowercase sha256 digest grammar shared by streamed and declared digests.
const EVIDENCE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export type FinalizePutErrorCode =
  | "grant_not_found"
  | "grant_not_finalizable"
  | "storage_busy"
  | "invalid_repository_input"
  | "invalid_persisted_data";

export type PublicationInsertOutcome =
  | { status: "inserted" }
  | { status: "identity_exists"; artifact: schema.EvidenceArtifactRow };

export type EvidencePublicationWriteResult =
  | { ok: true; outcome: PublicationInsertOutcome }
  | {
      ok: false;
      error: { code: "storage_busy" | "invalid_persisted_data" };
    };

function sumInProgressReservations(
  client: EvidenceGrantQueryClient,
  runId?: string,
): number {
  const rows = client
    .select({ total: sql<string | null>`sum(${evidenceGrants.reservationBytes})` })
    .from(evidenceGrants)
    .where(
      runId === undefined
        ? eq(evidenceGrants.state, "in_progress")
        : and(
            eq(evidenceGrants.state, "in_progress"),
            eq(evidenceGrants.runId, runId),
          ),
    )
    .get();
  const total = rows?.total;
  return total === null || total === undefined ? 0 : Number(total);
}

function countInProgressForRunner(
  client: EvidenceGrantQueryClient,
  runnerId: string,
): number {
  const row = client
    .select({ count: sql<string | null>`count(*)` })
    .from(evidenceGrants)
    .where(
      and(eq(evidenceGrants.runnerId, runnerId), eq(evidenceGrants.state, "in_progress")),
    )
    .get();
  const count = row?.count;
  return count === null || count === undefined ? 0 : Number(count);
}

export function hasInProgressGrantAtSequence(
  client: EvidenceGrantQueryClient,
  runId: string,
  fence: string,
  eventSequence: number,
): boolean {
  return (
    client
      .select({ artifactId: evidenceGrants.artifactId })
      .from(evidenceGrants)
      .where(
        and(
          eq(evidenceGrants.runId, runId),
          eq(evidenceGrants.fence, fence),
          eq(evidenceGrants.eventSequence, eventSequence),
          eq(evidenceGrants.state, "in_progress"),
        ),
      )
      .get() !== undefined
  );
}

interface AdmissionQuotas {
  readonly remainingStagingBytes: number;
  readonly remainingRunBytes: number;
  readonly remainingTotalBytes: number;
}

function computeAdmissionHeadroom(
  client: EvidenceGrantQueryClient,
  quota: EvidenceQuotaConfig,
  runId: string,
): AdmissionQuotas {
  const inFlightTotal = sumInProgressReservations(client);
  const inFlightRun = sumInProgressReservations(client, runId);
  const usedRun = publishedRunBytes(client, runId) + inFlightRun;
  const usedTotal = publishedTotalBytes(client) + inFlightTotal;
  return {
    remainingStagingBytes: quota.maxInFlightStagingBytes - inFlightTotal,
    remainingRunBytes: quota.perRunPublishedBytes - usedRun,
    remainingTotalBytes: quota.totalPublishedBytes - usedTotal,
  };
}

function admitEvidenceGrant(
  context: {
    client: EvidenceGrantWriteClient;
    createId: () => string;
    now: () => Date;
    quota: EvidenceQuotaConfig;
  },
  input: unknown,
): EvidenceGrantResult<EvidenceGrantResponse> {
  if (typeof input !== "object" || input === null) {
    return failed({ code: "invalid_repository_input" });
  }
  // Trusted control-plane context is separated before strict parsing; callers
  // can never smuggle runner identity or server time into the request body.
  const { runnerId, serverNow, ...requestFields } = input as Record<string, unknown>;
  if (
    typeof runnerId !== "string" ||
    runnerId.length < 1 ||
    runnerId.length > 255
  ) {
    return failed({ code: "invalid_repository_input" });
  }
  if (
    typeof serverNow !== "string" ||
    !Number.isFinite(Date.parse(serverNow))
  ) {
    return failed({ code: "invalid_repository_input" });
  }
  const parsed = CreateEvidenceGrantRequestSchema.safeParse(requestFields);
  if (!parsed.success) return failed({ code: "invalid_repository_input" });
  const request = parsed.data;

  const runRow = context.client
    .select()
    .from(runs)
    .where(eq(runs.id, request.runId))
    .get();
  if (runRow === undefined) return failed({ code: "run_not_found" });
  if (isTerminalRunState(runRow.state)) {
    return failed({ code: "run_already_terminal" });
  }

  const leaseRow = currentLeaseForRun(context.client, request.runId);
  if (leaseRow === undefined) return failed({ code: "stale_fence" });
  const lease = leaseForAuthority(leaseRow);
  if (!lease.ok) return lease;
  const authority = validateLeaseAuthority({
    lease: lease.value,
    presented: {
      runId: request.runId,
      leaseId: request.leaseId,
      runnerId,
      sessionId: request.sessionId,
      fence: request.fence,
    },
    serverNow,
  });
  if (!authority.ok) {
    switch (authority.error.code) {
      case "lease_expired":
        return failed({ code: "lease_expired" });
      case "lease_owner_mismatch":
        return failed({ code: "lease_owner_mismatch" });
      case "stale_fence":
        return failed({ code: "stale_fence" });
      default:
        return failed({ code: "invalid_repository_input" });
    }
  }

  // Grants bind latestEventSequence+1 but never consume the cursor.
  const expectedSequence = leaseRow.latestEventSequence + 1;
  if (request.eventSequence !== expectedSequence) {
    return failed({ code: "event_sequence_gap", expectedSequence });
  }

  // A second grant for an in-flight identity stays artifact_upload_in_progress
  // regardless of quota headroom.
  if (inProgressGrantForIdentity(context.client, request) !== undefined) {
    return failed({ code: "artifact_upload_in_progress" });
  }

  if (
    request.declaredSizeBytes !== undefined &&
    request.declaredSizeBytes > context.quota.perArtifactBytes
  ) {
    return failed({ code: "artifact_quota_exceeded" });
  }

  // Precedence per ADR-0003: duplicate identities short-circuit above, then
  // declared size, concurrent uploads, and staging headroom. Declared sizes
  // are advisory and never lower reservations.
  if (
    countInProgressForRunner(context.client, runnerId) >=
    context.quota.maxConcurrentUploadsPerRunner
  ) {
    return failed({ code: "concurrent_upload_limit" });
  }
  const headroom = computeAdmissionHeadroom(context.client, context.quota, request.runId);
  if (headroom.remainingStagingBytes <= 0) {
    return failed({ code: "staging_quota_exceeded" });
  }

  // ADR-0003 admission step 4: the reservation is the minimum of
  // perArtifactBytes and remaining maxInFlightStagingBytes. Run and total
  // quotas do not clamp it; the full reservation must fit alongside published
  // bytes plus existing in-flight reservations or admission refuses.
  const reservationBytes = Math.min(
    context.quota.perArtifactBytes,
    headroom.remainingStagingBytes,
  );
  if (headroom.remainingRunBytes < reservationBytes) {
    return failed({ code: "run_quota_exceeded" });
  }
  if (headroom.remainingTotalBytes < reservationBytes) {
    return failed({ code: "total_quota_exceeded" });
  }

  const timestamp = context.now().toISOString();
  const artifactId = context.createId().toLowerCase();
  const uploadId = context.createId().toLowerCase();
  // Generated identity is control-plane owned: validate the lowercased UUIDv4
  // shape and distinctness before storage so broken providers fail closed
  // without leaving a row.
  if (
    !EVIDENCE_GRANT_ID_V4_PATTERN.test(artifactId) ||
    !EVIDENCE_GRANT_ID_V4_PATTERN.test(uploadId) ||
    artifactId === uploadId
  ) {
    return failed({ code: "invalid_persisted_data" });
  }
  try {
    context.client
      .insert(evidenceGrants)
      .values({
        artifactId,
        contractVersion: EVIDENCE_CONTRACT_VERSION,
        profile: EVIDENCE_PROFILE,
        uploadId,
        runId: request.runId,
        leaseId: request.leaseId,
        runnerId,
        sessionId: request.sessionId,
        fence: request.fence,
        eventSequence: request.eventSequence,
        artifactSlot: request.artifactSlot,
        kind: request.kind,
        declaredSizeBytes: request.declaredSizeBytes ?? null,
        declaredDigest: request.declaredDigest ?? null,
        originalFileName: request.originalFileName ?? null,
        declaredContentType: request.declaredContentType ?? null,
        state: "in_progress",
        reservationBytes,
        putFinalized: false,
        acceptedBytes: 0,
        streamedDigest: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
  } catch (error) {
    if (isUniqueConstraint(error)) {
      // Only a durable in-flight identity collision is artifact_upload_in_progress.
      // A random generated-ID collision must fail closed instead of pretending
      // the caller's identity is already uploading.
      if (inProgressGrantForIdentity(context.client, request) !== undefined) {
        return failed({ code: "artifact_upload_in_progress" });
      }
      return failed({ code: "invalid_persisted_data" });
    }
    throw error;
  }

  const response: EvidenceGrantResponse = {
    artifactId,
    uploadId,
    runId: request.runId,
    leaseId: request.leaseId,
    sessionId: request.sessionId,
    fence: request.fence,
    eventSequence: request.eventSequence,
    artifactSlot: request.artifactSlot,
    kind: request.kind,
    ...(request.declaredSizeBytes === undefined
      ? {}
      : { declaredSizeBytes: request.declaredSizeBytes }),
    ...(request.declaredDigest === undefined ? {} : { declaredDigest: request.declaredDigest }),
    ...(request.originalFileName === undefined
      ? {}
      : { originalFileName: request.originalFileName }),
    ...(request.declaredContentType === undefined
      ? {}
      : { declaredContentType: request.declaredContentType }),
    createdAt: timestamp,
  };
  const validated = EvidenceGrantResponseSchema.safeParse(response);
  if (!validated.success) return failed({ code: "invalid_persisted_data" });
  return { ok: true, value: validated.data };
}

function inProgressGrantForIdentity(
  client: EvidenceGrantQueryClient,
  request: CreateEvidenceGrantRequest,
) {
  return client
    .select({ artifactId: evidenceGrants.artifactId })
    .from(evidenceGrants)
    .where(
      and(
        eq(evidenceGrants.runId, request.runId),
        eq(evidenceGrants.fence, request.fence),
        eq(evidenceGrants.eventSequence, request.eventSequence),
        eq(evidenceGrants.artifactSlot, request.artifactSlot),
        eq(evidenceGrants.state, "in_progress"),
      ),
    )
    .get();
}

// Committed artifact projected for operator download, joined with its
// published grant's advisory display metadata. declaredContentType is never
// trusted for serving; callers must ignore it.
export interface EngagementArtifactRecord extends schema.EvidenceArtifactRow {
  readonly originalFileName: string | null;
  readonly declaredContentType: string | null;
}

export class EvidenceGrantRepository {
  private readonly createId: () => string;
  private readonly now: () => Date;
  private readonly quota: EvidenceQuotaConfig;

  constructor(
    private readonly db: BetterSQLite3Database<DatabaseSchema>,
    providers: EvidenceGrantRepositoryProviders = {},
  ) {
    this.createId = providers.createId ?? randomUUID;
    this.now = providers.now ?? (() => new Date());
    const quota = providers.quota ?? EVIDENCE_QUOTA_DEFAULTS;
    const parsed = EvidenceQuotaConfigSchema.safeParse(quota);
    if (!parsed.success) {
      throw new Error("evidence grant repository received invalid quota config");
    }
    this.quota = parsed.data;
  }

  createGrant(
    input: unknown,
    transaction?: EvidenceGrantWriteClient,
  ): EvidenceGrantResult<EvidenceGrantResponse> {
    return this.write((context) => admitEvidenceGrant(context, input), transaction);
  }

  findGrantByUploadId(uploadId: string): schema.EvidenceGrantRow | undefined {
    return this.db
      .select()
      .from(evidenceGrants)
      .where(eq(evidenceGrants.uploadId, uploadId))
      .get();
  }

  publishedArtifactForIdentity(identity: {
    runId: string;
    fence: string;
    eventSequence: number;
    artifactSlot: string;
  }): schema.EvidenceArtifactRow | undefined {
    return this.db
      .select()
      .from(evidenceArtifacts)
      .where(
        and(
          eq(evidenceArtifacts.runId, identity.runId),
          eq(evidenceArtifacts.fence, identity.fence),
          eq(evidenceArtifacts.eventSequence, identity.eventSequence),
          eq(evidenceArtifacts.artifactSlot, identity.artifactSlot),
        ),
      )
      .get();
  }

  // Typed read for safe downloads: resolves a committed evidence artifact
  // only when its artifactId belongs through run -> action to the specified
  // engagement. Unknown artifacts and engagement mismatches are deliberately
  // indistinguishable (both undefined) so callers cannot probe existence.
  publishedArtifactForEngagement(input: {
    readonly engagementId: string;
    readonly artifactId: string;
  }): EngagementArtifactRecord | undefined {
    const row = this.db
      .select({
        artifact: evidenceArtifacts,
        originalFileName: evidenceGrants.originalFileName,
        declaredContentType: evidenceGrants.declaredContentType,
      })
      .from(evidenceArtifacts)
      .innerJoin(runs, eq(runs.id, evidenceArtifacts.runId))
      .innerJoin(actions, eq(actions.id, runs.actionId))
      .leftJoin(
        evidenceGrants,
        and(
          eq(evidenceGrants.runId, evidenceArtifacts.runId),
          eq(evidenceGrants.fence, evidenceArtifacts.fence),
          eq(evidenceGrants.eventSequence, evidenceArtifacts.eventSequence),
          eq(evidenceGrants.artifactSlot, evidenceArtifacts.artifactSlot),
          eq(evidenceGrants.state, "published"),
        ),
      )
      .where(
        and(
          eq(evidenceArtifacts.artifactId, input.artifactId),
          eq(runs.engagementId, input.engagementId),
          eq(actions.engagementId, input.engagementId),
        ),
      )
      .get();
    return row === undefined
      ? undefined
      : { ...row.artifact, originalFileName: row.originalFileName, declaredContentType: row.declaredContentType };
  }

  // Validates that the authenticated runner still holds lease authority over
  // a grant's bound identity: current non-expired lease, matching session and
  // fence, and a non-terminal Run.
  checkUploadLeaseAuthority(input: {
    grant: schema.EvidenceGrantRow;
    runnerId: string;
    serverNow: string;
  }): { ok: true } | { ok: false; code: CompleteEvidenceUploadErrorCode | "invalid_persisted_data" } {
    const runRow = this.db
      .select({ state: runs.state })
      .from(runs)
      .where(eq(runs.id, input.grant.runId))
      .get();
    if (runRow === undefined || isTerminalRunState(runRow.state)) {
      return { ok: false, code: "stale_fence" };
    }
    const leaseRow = currentLeaseForRun(this.db, input.grant.runId);
    if (leaseRow === undefined) return { ok: false, code: "stale_fence" };
    const lease = leaseFromRow(leaseRow);
    if (lease === undefined) return { ok: false, code: "invalid_persisted_data" };
    const authority = validateLeaseAuthority({
      lease,
      presented: {
        runId: input.grant.runId,
        leaseId: input.grant.leaseId,
        runnerId: input.runnerId,
        sessionId: input.grant.sessionId,
        fence: input.grant.fence,
      },
      serverNow: input.serverNow,
    });
    if (authority.ok) return { ok: true };
    switch (authority.error.code) {
      case "lease_expired":
        return { ok: false, code: "lease_expired" };
      case "lease_owner_mismatch":
        return { ok: false, code: "lease_owner_mismatch" };
      default:
        return { ok: false, code: "stale_fence" };
    }
  }

  // Durably records putFinalized=true with the streamed size and digest. The
  // update is guarded: only an owned in-progress unfinalized grant finalizes.
  finalizePut(input: {
    uploadId: string;
    runnerId: string;
    acceptedBytes: number;
    streamedDigest: string;
    serverNow: string;
  }): { ok: true } | { ok: false; code: FinalizePutErrorCode } {
    if (
      !Number.isSafeInteger(input.acceptedBytes) ||
      input.acceptedBytes < 0 ||
      !EVIDENCE_DIGEST_PATTERN.test(input.streamedDigest)
    ) {
      return { ok: false, code: "invalid_repository_input" };
    }
    try {
      return this.db.transaction((client) => {
        const row = client
          .select()
          .from(evidenceGrants)
          .where(eq(evidenceGrants.uploadId, input.uploadId))
          .get();
        if (row === undefined) return { ok: false as const, code: "grant_not_found" as const };
        if (
          row.state !== "in_progress" ||
          row.putFinalized ||
          row.runnerId !== input.runnerId
        ) {
          return { ok: false as const, code: "grant_not_finalizable" as const };
        }
        if (input.acceptedBytes > row.reservationBytes) {
          return { ok: false as const, code: "grant_not_finalizable" as const };
        }
        client
          .update(evidenceGrants)
          .set({
            acceptedBytes: input.acceptedBytes,
            streamedDigest: input.streamedDigest,
            putFinalized: true,
            updatedAt: input.serverNow,
          })
          .where(eq(evidenceGrants.uploadId, input.uploadId))
          .run();
        return { ok: true as const };
      }, { behavior: "immediate" });
    } catch (error) {
      return { ok: false, code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data" };
    }
  }

  markGrantInterrupted(input: {
    uploadId: string;
    serverNow: string;
  }): { ok: true } | { ok: false; code: "storage_busy" | "invalid_persisted_data" } {
    return this.transitionGrantState(input.uploadId, "upload_interrupted", input.serverNow);
  }

  // Marks an in-progress grant published once its bytes are durably
  // represented by a committed evidence_artifacts row.
  markGrantPublished(input: {
    uploadId: string;
    serverNow: string;
  }): { ok: true } | { ok: false; code: "storage_busy" | "invalid_persisted_data" } {
    return this.transitionGrantState(input.uploadId, "published", input.serverNow);
  }

  private transitionGrantState(
    uploadId: string,
    state: "upload_interrupted" | "published",
    serverNow: string,
  ): { ok: true } | { ok: false; code: "storage_busy" | "invalid_persisted_data" } {
    try {
      this.db.transaction((client) => {
        client
          .update(evidenceGrants)
          .set({ state, updatedAt: serverNow })
          .where(and(eq(evidenceGrants.uploadId, uploadId), eq(evidenceGrants.state, "in_progress")))
          .run();
      }, { behavior: "immediate" });
      return { ok: true };
    } catch (error) {
      return { ok: false, code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data" };
    }
  }

  // Metadata-after-file commit point: inserts the evidence row and marks the
  // grant published in one immediate transaction. A concurrent insert for the
  // same durable identity returns identity_exists with the stored artifact so
  // the caller can decide replay versus conflict from its bytes.
  recordPublication(
    input: {
      uploadId: string;
      artifactId: string;
      runId: string;
      fence: string;
      eventSequence: number;
      artifactSlot: string;
      kind: EvidenceArtifactKind;
      sizeBytes: number;
      digest: string;
      completeness: PublishedCompleteness;
      occurredAt: string;
    },
  ): EvidencePublicationWriteResult {
    const redactionApplied = input.kind === "stdout" || input.kind === "stderr";
    const candidate = {
      contractVersion: EVIDENCE_CONTRACT_VERSION,
      profile: EVIDENCE_PROFILE,
      artifactId: input.artifactId,
      runId: input.runId,
      fence: input.fence,
      eventSequence: input.eventSequence,
      artifactSlot: input.artifactSlot,
      kind: input.kind,
      sizeBytes: input.sizeBytes,
      digest: input.digest,
      relativePath: `published/${input.artifactId}`,
      completeness: input.completeness,
      redaction: {
        applied: redactionApplied,
        boundary: redactionApplied ? ("runner_stream" as const) : ("none" as const),
        rawBytesPreserved: !redactionApplied,
      },
      createdAt: input.occurredAt,
    };
    const parsed = EvidenceArtifactRecordSchema.safeParse(candidate);
    if (!parsed.success) return { ok: false, error: { code: "invalid_persisted_data" } };
    try {
      return this.db.transaction((client) => {
        try {
          client
            .insert(evidenceArtifacts)
            .values({
              artifactId: parsed.data.artifactId,
              contractVersion: parsed.data.contractVersion,
              profile: parsed.data.profile,
              runId: parsed.data.runId,
              fence: parsed.data.fence,
              eventSequence: parsed.data.eventSequence,
              artifactSlot: parsed.data.artifactSlot,
              kind: parsed.data.kind,
              sizeBytes: parsed.data.sizeBytes,
              digest: parsed.data.digest,
              relativePath: parsed.data.relativePath,
              completeness: parsed.data.completeness,
              redactionApplied: parsed.data.redaction.applied,
              redactionBoundary: parsed.data.redaction.boundary,
              rawBytesPreserved: parsed.data.redaction.rawBytesPreserved,
              createdAt: parsed.data.createdAt,
            })
            .run();
        } catch (error) {
          if (!isUniqueConstraint(error)) throw error;
          const existing = client
            .select()
            .from(evidenceArtifacts)
            .where(
              and(
                eq(evidenceArtifacts.runId, input.runId),
                eq(evidenceArtifacts.fence, input.fence),
                eq(evidenceArtifacts.eventSequence, input.eventSequence),
                eq(evidenceArtifacts.artifactSlot, input.artifactSlot),
              ),
            )
            .get();
          if (existing === undefined) {
            return { ok: false as const, error: { code: "invalid_persisted_data" as const } };
          }
          return { ok: true as const, outcome: { status: "identity_exists" as const, artifact: existing } };
        }
        client
          .update(evidenceGrants)
          .set({ state: "published", updatedAt: input.occurredAt })
          .where(and(eq(evidenceGrants.uploadId, input.uploadId), eq(evidenceGrants.state, "in_progress")))
          .run();
        return { ok: true as const, outcome: { status: "inserted" as const } };
      }, { behavior: "immediate" });
    } catch (error) {
      return { ok: false, error: { code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data" } };
    }
  }

  private write<T>(
    operation: (context: {
      client: EvidenceGrantWriteClient;
      createId: () => string;
      now: () => Date;
      quota: EvidenceQuotaConfig;
    }) => EvidenceGrantResult<T>,
    transaction?: EvidenceGrantWriteClient,
  ): EvidenceGrantResult<T> {
    if (transaction !== undefined) {
      return operation({
        client: transaction,
        createId: this.createId,
        now: this.now,
        quota: this.quota,
      });
    }
    try {
      return this.db.transaction(
        (client) =>
          operation({
            client,
            createId: this.createId,
            now: this.now,
            quota: this.quota,
          }),
        { behavior: "immediate" },
      );
    } catch (error) {
      return failed({
        code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data",
      });
    }
  }
}
