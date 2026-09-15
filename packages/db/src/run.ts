import { createHash, randomUUID } from "node:crypto";

import {
  AcquireRunLeaseInputSchema,
  AppendPersistedRunEventInputSchema,
  CompletePersistedRunInputSchema,
  CreateQueuedRunInputSchema,
  ExpirePersistedRunLeaseInputSchema,
  MAX_CANONICAL_JSON_BYTES,
  PersistRunHeartbeatInputSchema,
  PersistedRunEventSchema,
  PersistedRunSchema,
  RUNNER_CONTROL_PROFILE,
  RUNNER_CONTROL_PROTOCOL,
  RUNNER_LEASE_DURATION_SECONDS,
  RUN_PERSISTENCE_CONTRACT_VERSION,
  RetryRunInputSchema,
  RunnerLeaseSchema,
  type AcceptHeartbeatResult,
  type PersistedRun,
  type PersistedRunEvent,
  type RunnerLease,
  type RunTerminalKind,
} from "@stonehush/contracts";
import {
  acceptHeartbeat,
  evaluateRunEventSequence,
  expireRunLease,
  incrementFencingToken,
  isTerminalRunState,
  transitionRunState,
  validateLeaseAuthority,
} from "@stonehush/domain";
import { and, asc, desc, eq, max } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema.js";
import {
  actions,
  runEvents,
  runLeases,
  runs,
  type ActionRow,
  type RunEventRow,
  type RunLeaseRow,
  type RunRow,
} from "./schema.js";
import { hasInProgressGrantAtSequence } from "./evidence-grant.js";

type DatabaseSchema = typeof schema;
export type RunWriteClient = Parameters<
  Parameters<BetterSQLite3Database<DatabaseSchema>["transaction"]>[0]
>[0];
export type RunQueryClient = RunWriteClient | BetterSQLite3Database<DatabaseSchema>;

export type RunRepositoryError =
  | { code: "action_not_found" }
  | { code: "action_not_queued" }
  | { code: "artifact_upload_in_progress" }
  | { code: "event_replay_conflict" }
  | { code: "event_sequence_exhausted" }
  | { code: "event_sequence_gap"; expectedSequence: number }
  | { code: "fencing_exhausted" }
  | { code: "heartbeat_replay_conflict" }
  | { code: "heartbeat_sequence_stale" }
  | { code: "invalid_action_transition" }
  | { code: "invalid_persisted_data" }
  | { code: "invalid_repository_input" }
  | { code: "invalid_run_transition" }
  | { code: "lease_expired" }
  | { code: "lease_owner_mismatch"; presentedRunnerCleanupRequired?: true }
  | { code: "no_work" }
  | { code: "run_already_queued" }
  | { code: "run_already_terminal" }
  | { code: "run_attempt_exhausted" }
  | { code: "run_not_found" }
  | { code: "run_not_retryable" }
  | { code: "stale_fence" }
  | { code: "storage_busy" };

export type RunResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: RunRepositoryError };

export interface RunPersistenceContext {
  readonly client: RunQueryClient;
  readonly createId: () => string;
  readonly now: () => Date;
}

export interface RunRepositoryProviders {
  createId?: () => string;
  now?: () => Date;
}

export interface AcquiredRunLease {
  readonly disposition: "acquired";
  readonly run: PersistedRun;
  readonly lease: RunnerLease;
}

export interface StoredRunEventResult {
  readonly disposition:
    | "accepted_completion"
    | "accepted_event"
    | "stored_event_replayed"
    | "stored_heartbeat_replayed"
    | "stored_terminal_replayed";
  readonly event: PersistedRunEvent;
  readonly leaseExpiresAt?: string;
}

const RUNNER_EVENT_TYPES = new Set(["started", "succeeded", "failed", "cancelled"]);

function failed<T>(error: RunRepositoryError): RunResult<T> {
  return { ok: false, error };
}

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

class InvalidRunWriteError extends Error {}

function abortInvalidWrite(): never {
  throw new InvalidRunWriteError("run persistence write invariant failed");
}

function runFromRow(row: RunRow): RunResult<PersistedRun> {
  const parsed = PersistedRunSchema.safeParse({
    contractVersion: row.contractVersion,
    id: row.id,
    actionId: row.actionId,
    engagementId: row.engagementId,
    attempt: row.attempt,
    state: row.state,
    currentLeaseId: row.currentLeaseId,
    currentFence: row.currentFence,
    terminalKind: row.terminalKind,
    terminalReason: row.terminalReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  return parsed.success
    ? { ok: true, value: parsed.data }
    : failed({ code: "invalid_persisted_data" });
}

function leaseFromRow(row: RunLeaseRow): RunResult<RunnerLease> {
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
  return parsed.success
    ? { ok: true, value: parsed.data }
    : failed({ code: "invalid_persisted_data" });
}

function eventFromRow(row: RunEventRow): RunResult<PersistedRunEvent> {
  const parsed = PersistedRunEventSchema.safeParse({
    eventId: row.eventId,
    runId: row.runId,
    sequence: row.sequence,
    type: row.type,
    fence: row.fence,
    payloadJson: row.payloadJson,
    digest: row.digest,
    createdAt: row.createdAt,
  });
  return parsed.success
    ? { ok: true, value: parsed.data }
    : failed({ code: "invalid_persisted_data" });
}

function payloadJsonForStorage(payload: unknown): RunResult<string> {
  let payloadJson: string;
  try {
    payloadJson = JSON.stringify(payload ?? {});
  } catch {
    return failed({ code: "invalid_repository_input" });
  }
  if (
    typeof payloadJson !== "string" ||
    Buffer.byteLength(payloadJson, "utf8") > MAX_CANONICAL_JSON_BYTES
  ) {
    return failed({ code: "invalid_repository_input" });
  }
  return { ok: true, value: payloadJson };
}

function eventDigest(payloadJson: string): string {
  return `sha256:${createHash("sha256").update(payloadJson, "utf8").digest("hex")}`;
}

function expiresAtFrom(serverNow: string): string {
  return new Date(
    Date.parse(serverNow) + RUNNER_LEASE_DURATION_SECONDS * 1_000,
  ).toISOString();
}

function mapDomainError(error: {
  code: string;
  expectedSequence?: number;
}): RunRepositoryError {
  switch (error.code) {
    case "event_sequence_gap":
      return {
        code: "event_sequence_gap",
        expectedSequence: error.expectedSequence ?? 1,
      };
    case "lease_owner_mismatch":
      return { code: "lease_owner_mismatch", presentedRunnerCleanupRequired: true };
    case "event_replay_conflict":
    case "event_sequence_exhausted":
    case "fencing_exhausted":
    case "heartbeat_replay_conflict":
    case "heartbeat_sequence_stale":
    case "invalid_run_transition":
    case "lease_expired":
    case "run_already_terminal":
    case "stale_fence":
      return { code: error.code };
    default:
      return { code: "invalid_repository_input" };
  }
}

function currentLeaseForRun(
  client: RunQueryClient,
  runId: string,
): RunLeaseRow | undefined {
  return client
    .select()
    .from(runLeases)
    .where(and(eq(runLeases.runId, runId), eq(runLeases.current, true)))
    .get();
}

function latestRunForAction(
  client: RunQueryClient,
  actionId: string,
): RunRow | undefined {
  return client
    .select()
    .from(runs)
    .where(eq(runs.actionId, actionId))
    .orderBy(desc(runs.attempt))
    .get();
}

function loadAction(client: RunQueryClient, actionId: string): ActionRow | undefined {
  return client.select().from(actions).where(eq(actions.id, actionId)).get();
}

function storedRunnerEvent(
  client: RunQueryClient,
  runId: string,
  fence: string,
  sequence: number,
): RunEventRow | undefined {
  return client
    .select()
    .from(runEvents)
    .where(
      and(
        eq(runEvents.runId, runId),
        eq(runEvents.fence, fence),
        eq(runEvents.sequence, sequence),
      ),
    )
    .all()
    .find((row) => RUNNER_EVENT_TYPES.has(row.type));
}

function storedCompletionEvent(
  client: RunQueryClient,
  runId: string,
  terminalKind: RunTerminalKind,
  fence?: string,
  sequence?: number,
): RunEventRow | undefined {
  const rows = client
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), eq(runEvents.type, terminalKind)))
    .all();
  return rows.find(
    (row) =>
      (fence === undefined || row.fence === fence) &&
      (sequence === undefined || row.sequence === sequence),
  );
}

function insertEvent(
  client: RunQueryClient,
  values: {
    runId: string;
    sequence: number;
    type: PersistedRunEvent["type"];
    fence: string;
    payloadJson: string;
    digest: string;
    createdAt: string;
  },
): RunEventRow {
  return client
    .insert(runEvents)
    .values({
      contractVersion: RUN_PERSISTENCE_CONTRACT_VERSION,
      runId: values.runId,
      sequence: values.sequence,
      type: values.type,
      fence: values.fence,
      payloadJson: values.payloadJson,
      digest: values.digest,
      createdAt: values.createdAt,
    })
    .returning()
    .get();
}

function bumpAction(
  client: RunQueryClient,
  action: ActionRow,
  patch: {
    state: ActionRow["state"];
    runState: ActionRow["runState"];
    cleanupRequired?: boolean;
    resumeRequested?: boolean;
    pendingWarningJson?: string | null;
    updatedAt: string;
  },
): RunResult<true> {
  const updated = client
    .update(actions)
    .set({
      revision: action.revision + 1,
      state: patch.state,
      runState: patch.runState,
      cleanupRequired: patch.cleanupRequired ?? action.cleanupRequired,
      resumeRequested: patch.resumeRequested ?? false,
      pendingWarningJson:
        patch.pendingWarningJson === undefined
          ? action.pendingWarningJson
          : patch.pendingWarningJson,
      updatedAt: patch.updatedAt,
    })
    .where(and(eq(actions.id, action.id), eq(actions.revision, action.revision)))
    .run();
  if (updated.changes !== 1) return failed({ code: "invalid_persisted_data" });
  return { ok: true, value: true };
}

function requireCurrentLeaseAuthority(
  current: RunLeaseRow | undefined,
  presented: {
    runId: string;
    leaseId: string;
    runnerId: string;
    sessionId: string;
    fence: string;
  },
  serverNow: string,
): RunResult<RunnerLease> {
  if (current === undefined) return failed({ code: "stale_fence" });
  const lease = leaseFromRow(current);
  if (!lease.ok) return lease;
  const authority = validateLeaseAuthority({
    lease: lease.value,
    presented,
    serverNow,
  });
  if (!authority.ok) return failed(mapDomainError(authority.error));
  return lease;
}

export function allocateQueuedRun(
  context: RunPersistenceContext,
  input: unknown,
): RunResult<PersistedRun> {
  const parsed = CreateQueuedRunInputSchema.safeParse(input);
  if (!parsed.success) return failed({ code: "invalid_repository_input" });
  const action = context.client
    .select()
    .from(actions)
    .where(
      and(
        eq(actions.id, parsed.data.actionId),
        eq(actions.engagementId, parsed.data.engagementId),
      ),
    )
    .get();
  if (action === undefined) return failed({ code: "action_not_found" });
  if (action.queuedSnapshotVersion === null) {
    return failed({ code: "action_not_queued" });
  }
  if (action.state === "succeeded") return failed({ code: "run_not_retryable" });
  if (
    action.state !== "queued" &&
    action.state !== "failed" &&
    action.state !== "cancelled"
  ) {
    return failed({ code: "action_not_queued" });
  }
  const existing = context.client
    .select()
    .from(runs)
    .where(eq(runs.actionId, action.id))
    .all()
    .find((row) => !isTerminalRunState(row.state));
  if (existing !== undefined) return failed({ code: "run_already_queued" });
  const succeeded = context.client
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.actionId, action.id), eq(runs.state, "succeeded")))
    .get();
  if (succeeded !== undefined) return failed({ code: "run_not_retryable" });

  const maximumAttempt =
    context.client
      .select({ value: max(runs.attempt) })
      .from(runs)
      .where(eq(runs.actionId, action.id))
      .get()?.value ?? 0;
  if (
    !Number.isSafeInteger(maximumAttempt) ||
    maximumAttempt >= Number.MAX_SAFE_INTEGER
  ) {
    return failed({ code: "run_attempt_exhausted" });
  }
  const attempt = parsed.data.attempt ?? maximumAttempt + 1;
  if (attempt !== maximumAttempt + 1) {
    return failed({ code: "invalid_repository_input" });
  }
  const timestamp = context.now().toISOString();
  const candidate = PersistedRunSchema.safeParse({
    contractVersion: RUN_PERSISTENCE_CONTRACT_VERSION,
    id: `run:${action.id}:${attempt}`,
    actionId: action.id,
    engagementId: action.engagementId,
    attempt,
    state: "queued",
    currentLeaseId: null,
    currentFence: "0",
    terminalKind: null,
    terminalReason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  if (!candidate.success) return failed({ code: "invalid_repository_input" });
  context.client.insert(runs).values(candidate.data).run();
  return { ok: true, value: candidate.data };
}

export function cancelQueuedRunForAction(
  context: RunPersistenceContext,
  actionId: string,
): RunResult<PersistedRun | null> {
  const current = latestRunForAction(context.client, actionId);
  if (current === undefined) return { ok: true, value: null };
  if (isTerminalRunState(current.state)) return { ok: true, value: null };
  const transition = transitionRunState({ from: current.state, to: "cancelled" });
  if (!transition.ok) return failed(mapDomainError(transition.error));
  const timestamp = context.now().toISOString();
  if (current.currentLeaseId !== null) {
    context.client
      .update(runLeases)
      .set({ current: false })
      .where(
        and(eq(runLeases.leaseId, current.currentLeaseId), eq(runLeases.current, true)),
      )
      .run();
  }
  const updated = context.client
    .update(runs)
    .set({
      state: "cancelled",
      currentLeaseId: null,
      terminalKind: "cancelled",
      terminalReason: "operator_cancelled",
      updatedAt: timestamp,
    })
    .where(and(eq(runs.id, current.id), eq(runs.state, current.state)))
    .run();
  if (updated.changes !== 1) return failed({ code: "invalid_persisted_data" });
  const stored = context.client.select().from(runs).where(eq(runs.id, current.id)).get();
  if (stored === undefined) return failed({ code: "invalid_persisted_data" });
  return runFromRow(stored);
}

export function acquireRunLease(
  context: RunPersistenceContext,
  input: unknown,
): RunResult<AcquiredRunLease> {
  const parsed = AcquireRunLeaseInputSchema.safeParse(input);
  if (!parsed.success) return failed({ code: "invalid_repository_input" });
  const runRow = context.client
    .select()
    .from(runs)
    .where(eq(runs.id, parsed.data.runId))
    .get();
  if (runRow === undefined) return failed({ code: "run_not_found" });
  if (runRow.state !== "queued") return failed({ code: "no_work" });
  if (currentLeaseForRun(context.client, runRow.id) !== undefined) {
    return failed({ code: "no_work" });
  }
  const action = loadAction(context.client, runRow.actionId);
  if (action === undefined) return failed({ code: "action_not_found" });
  if (action.engagementId !== runRow.engagementId) {
    return failed({ code: "invalid_persisted_data" });
  }

  const nextFence = incrementFencingToken({ currentFence: runRow.currentFence });
  const timestamp = parsed.data.serverNow;
  if (!nextFence.ok) {
    if (nextFence.error.code !== "fencing_exhausted") {
      return failed({ code: "invalid_repository_input" });
    }
    const failedRun = transitionRunState({ from: runRow.state, to: "failed" });
    if (!failedRun.ok) return failed(mapDomainError(failedRun.error));
    const runUpdate = context.client
      .update(runs)
      .set({
        state: "failed",
        terminalKind: "failed",
        terminalReason: "fencing_exhausted",
        updatedAt: timestamp,
      })
      .where(and(eq(runs.id, runRow.id), eq(runs.state, "queued")))
      .run();
    const actionUpdate = bumpAction(context.client, action, {
      state: "failed",
      runState: null,
      cleanupRequired: false,
      resumeRequested: false,
      pendingWarningJson: null,
      updatedAt: timestamp,
    });
    if (runUpdate.changes !== 1 || !actionUpdate.ok) abortInvalidWrite();
    return failed({ code: "fencing_exhausted" });
  }

  const leased = transitionRunState({ from: "queued", to: "leased" });
  if (!leased.ok) return failed(mapDomainError(leased.error));
  const leaseId = context.createId();
  const expiresAt = expiresAtFrom(parsed.data.serverNow);
  const runUpdate = context.client
    .update(runs)
    .set({
      state: "leased",
      currentLeaseId: leaseId,
      currentFence: nextFence.nextFence,
      updatedAt: timestamp,
    })
    .where(and(eq(runs.id, runRow.id), eq(runs.state, "queued")))
    .run();
  if (runUpdate.changes !== 1) return failed({ code: "no_work" });
  try {
    context.client.insert(runLeases).values({
      leaseId,
      contractVersion: RUN_PERSISTENCE_CONTRACT_VERSION,
      runId: runRow.id,
      runnerId: parsed.data.runnerId,
      sessionId: parsed.data.sessionId,
      fence: nextFence.nextFence,
      expiresAt,
      latestHeartbeatSequence: 0,
      latestEventSequence: 0,
      latestHeartbeatDigest: null,
      current: true,
      createdAt: timestamp,
    }).run();
  } catch (error) {
    if (isUniqueConstraint(error)) return failed({ code: "no_work" });
    throw error;
  }

  if (action.state === "queued") {
    const activated = bumpAction(context.client, action, {
      state: "active",
      runState: "running",
      updatedAt: timestamp,
    });
    if (!activated.ok) abortInvalidWrite();
  } else if (action.state !== "active") {
    return failed({ code: "invalid_action_transition" });
  }

  const payload = payloadJsonForStorage({
    leaseId,
    runnerId: parsed.data.runnerId,
    sessionId: parsed.data.sessionId,
  });
  if (!payload.ok) abortInvalidWrite();
  insertEvent(context.client, {
    runId: runRow.id,
    sequence: 1,
    type: "lease_acquired",
    fence: nextFence.nextFence,
    payloadJson: payload.value,
    digest: eventDigest(payload.value),
    createdAt: timestamp,
  });

  const storedRun = context.client.select().from(runs).where(eq(runs.id, runRow.id)).get();
  const storedLease = context.client
    .select()
    .from(runLeases)
    .where(eq(runLeases.leaseId, leaseId))
    .get();
  if (storedRun === undefined || storedLease === undefined) abortInvalidWrite();
  const run = runFromRow(storedRun);
  const lease = leaseFromRow(storedLease);
  if (!run.ok) return run;
  if (!lease.ok) return lease;
  return { ok: true, value: { disposition: "acquired", run: run.value, lease: lease.value } };
}

export function heartbeatRunLease(
  context: RunPersistenceContext,
  input: unknown,
): RunResult<AcceptHeartbeatResult & { expiryWriteCount: number }> {
  const parsed = PersistRunHeartbeatInputSchema.safeParse(input);
  if (!parsed.success) return failed({ code: "invalid_repository_input" });
  const presentedLease = context.client
    .select()
    .from(runLeases)
    .where(eq(runLeases.leaseId, parsed.data.presented.leaseId))
    .get();
  if (presentedLease === undefined) return failed({ code: "stale_fence" });
  const storedHeartbeat =
    presentedLease.latestHeartbeatSequence === parsed.data.heartbeatSequence &&
    presentedLease.latestHeartbeatDigest !== null
      ? {
          heartbeatSequence: presentedLease.latestHeartbeatSequence,
          requestDigest: presentedLease.latestHeartbeatDigest,
          leaseExpiresAt: presentedLease.expiresAt,
        }
      : null;
  if (storedHeartbeat !== null) {
    const storedLease = leaseFromRow(presentedLease);
    if (!storedLease.ok) return storedLease;
    const replayed = acceptHeartbeat({
      lease: storedLease.value,
      presented: parsed.data.presented,
      heartbeatSequence: parsed.data.heartbeatSequence,
      requestDigest: parsed.data.requestDigest,
      serverNow: parsed.data.serverNow,
      storedHeartbeat,
    });
    if (!replayed.ok) return failed(mapDomainError(replayed.error));
    if (replayed.disposition === "stored_heartbeat_replayed") {
      return { ok: true, value: { ...replayed, expiryWriteCount: 0 } };
    }
  }

  const current = currentLeaseForRun(context.client, parsed.data.presented.runId);
  const lease = requireCurrentLeaseAuthority(
    current,
    parsed.data.presented,
    parsed.data.serverNow,
  );
  if (!lease.ok) return lease;
  if (current === undefined) return failed({ code: "stale_fence" });

  const accepted = acceptHeartbeat({
    lease: lease.value,
    presented: parsed.data.presented,
    heartbeatSequence: parsed.data.heartbeatSequence,
    requestDigest: parsed.data.requestDigest,
    serverNow: parsed.data.serverNow,
    storedHeartbeat: null,
  });
  if (!accepted.ok) return failed(mapDomainError(accepted.error));
  if (accepted.disposition === "stored_heartbeat_replayed") {
    return { ok: true, value: { ...accepted, expiryWriteCount: 0 } };
  }

  context.client
    .update(runLeases)
    .set({
      expiresAt: accepted.lease.expiresAt,
      latestHeartbeatSequence: accepted.lease.latestHeartbeatSequence,
      latestHeartbeatDigest: accepted.heartbeat.requestDigest,
    })
    .where(and(eq(runLeases.leaseId, current.leaseId), eq(runLeases.current, true)))
    .run();
  const payload = payloadJsonForStorage({
    heartbeatSequence: accepted.heartbeat.heartbeatSequence,
    leaseExpiresAt: accepted.heartbeat.leaseExpiresAt,
  });
  if (!payload.ok) abortInvalidWrite();
  insertEvent(context.client, {
    runId: current.runId,
    sequence: accepted.heartbeat.heartbeatSequence,
    type: "heartbeat",
    fence: current.fence,
    payloadJson: payload.value,
    digest: accepted.heartbeat.requestDigest,
    createdAt: parsed.data.serverNow,
  });
  return { ok: true, value: { ...accepted, expiryWriteCount: 1 } };
}

export function expirePersistedRunLease(
  context: RunPersistenceContext,
  input: unknown,
): RunResult<{
  run: PersistedRun;
  event: PersistedRunEvent;
  automaticallyRequeued: boolean;
}> {
  const parsed = ExpirePersistedRunLeaseInputSchema.safeParse(input);
  if (!parsed.success) return failed({ code: "invalid_repository_input" });
  const runRow = context.client
    .select()
    .from(runs)
    .where(eq(runs.id, parsed.data.runId))
    .get();
  if (runRow === undefined) return failed({ code: "run_not_found" });
  const leaseRow = currentLeaseForRun(context.client, runRow.id);
  if (leaseRow === undefined) return failed({ code: "lease_expired" });
  if (Date.parse(parsed.data.serverNow) < Date.parse(leaseRow.expiresAt)) {
    return failed({ code: "invalid_run_transition" });
  }
  const action = loadAction(context.client, runRow.actionId);
  if (action === undefined) return failed({ code: "action_not_found" });
  const expiration = expireRunLease({
    actionState: action.state,
    runState: runRow.state,
  });
  if (!expiration.ok) return failed(mapDomainError(expiration.error));

  const timestamp = parsed.data.serverNow;
  const leaseUpdate = context.client
    .update(runLeases)
    .set({ current: false })
    .where(and(eq(runLeases.leaseId, leaseRow.leaseId), eq(runLeases.current, true)))
    .run();
  const runUpdate = context.client
    .update(runs)
    .set({
      state: expiration.runState,
      currentLeaseId: null,
      terminalKind: expiration.terminal ? "failed" : null,
      terminalReason: expiration.terminal ? expiration.reason : null,
      updatedAt: timestamp,
    })
    .where(and(eq(runs.id, runRow.id), eq(runs.state, runRow.state)))
    .run();
  const actionUpdate = bumpAction(context.client, action, {
    state: expiration.actionState,
    runState: null,
    cleanupRequired: false,
    resumeRequested: false,
    pendingWarningJson: expiration.terminal ? action.pendingWarningJson : null,
    updatedAt: timestamp,
  });
  if (leaseUpdate.changes !== 1 || runUpdate.changes !== 1 || !actionUpdate.ok) {
    abortInvalidWrite();
  }

  const payload = payloadJsonForStorage({ reason: expiration.reason });
  if (!payload.ok) abortInvalidWrite();
  const inserted = insertEvent(context.client, {
    runId: runRow.id,
    sequence: 1,
    type: "lease_expired",
    fence: leaseRow.fence,
    payloadJson: payload.value,
    digest: eventDigest(payload.value),
    createdAt: timestamp,
  });
  const storedRun = context.client.select().from(runs).where(eq(runs.id, runRow.id)).get();
  if (storedRun === undefined) abortInvalidWrite();
  const run = runFromRow(storedRun);
  const event = eventFromRow(inserted);
  if (!run.ok) return run;
  if (!event.ok) return event;
  return {
    ok: true,
    value: {
      run: run.value,
      event: event.value,
      automaticallyRequeued: expiration.automaticallyRequeued,
    },
  };
}

export function appendRunEvent(
  context: RunPersistenceContext,
  input: unknown,
): RunResult<StoredRunEventResult> {
  const parsed = AppendPersistedRunEventInputSchema.safeParse(input);
  if (!parsed.success) return failed({ code: "invalid_repository_input" });
  if (parsed.data.type !== "started") {
    return failed({ code: "invalid_repository_input" });
  }
  const runRow = context.client
    .select()
    .from(runs)
    .where(eq(runs.id, parsed.data.presented.runId))
    .get();
  if (runRow === undefined) return failed({ code: "run_not_found" });
  const payload = payloadJsonForStorage(parsed.data.payload ?? {});
  if (!payload.ok) return payload;
  const digest = parsed.data.digest ?? eventDigest(payload.value);
  const storedRow = storedRunnerEvent(
    context.client,
    runRow.id,
    parsed.data.presented.fence,
    parsed.data.sequence,
  );
  if (storedRow !== undefined) {
    const replay = evaluateRunEventSequence({
      kind: "event",
      lastAcceptedSequence: parsed.data.sequence,
      presentedSequence: parsed.data.sequence,
      presentedDigest: digest,
      storedAtSequence: {
        kind: "event",
        digest: storedRow.digest,
        eventId: storedRow.eventId,
        terminalKind: null,
      },
      currentTerminalKind: runRow.terminalKind,
    });
    if (!replay.ok) return failed(mapDomainError(replay.error));
    const event = eventFromRow(storedRow);
    return event.ok
      ? { ok: true, value: { disposition: replay.disposition, event: event.value } }
      : event;
  }

  const current = currentLeaseForRun(context.client, runRow.id);
  const lease = requireCurrentLeaseAuthority(
    current,
    parsed.data.presented,
    parsed.data.serverNow,
  );
  if (!lease.ok) return lease;
  if (current === undefined) return failed({ code: "stale_fence" });

  const sequence = evaluateRunEventSequence({
    kind: "event",
    lastAcceptedSequence: current.latestEventSequence,
    presentedSequence: parsed.data.sequence,
    presentedDigest: digest,
    storedAtSequence: null,
    currentTerminalKind: runRow.terminalKind,
  });
  if (!sequence.ok) return failed(mapDomainError(sequence.error));
  // An event at a sequence bound by an in-progress upload grant waits until
  // the grant finalizes; the artifact identity owns that sequence slot.
  if (
    hasInProgressGrantAtSequence(
      context.client,
      runRow.id,
      current.fence,
      parsed.data.sequence,
    )
  ) {
    return failed({ code: "artifact_upload_in_progress" });
  }

  const transition = transitionRunState({ from: runRow.state, to: "running" });
  if (!transition.ok) return failed(mapDomainError(transition.error));
  const inserted = insertEvent(context.client, {
    runId: runRow.id,
    sequence: parsed.data.sequence,
    type: "started",
    fence: current.fence,
    payloadJson: payload.value,
    digest,
    createdAt: parsed.data.serverNow,
  });
  const leaseUpdate = context.client
    .update(runLeases)
    .set({ latestEventSequence: parsed.data.sequence })
    .where(and(eq(runLeases.leaseId, current.leaseId), eq(runLeases.current, true)))
    .run();
  const runUpdate = context.client
    .update(runs)
    .set({ state: "running", updatedAt: parsed.data.serverNow })
    .where(and(eq(runs.id, runRow.id), eq(runs.state, "leased")))
    .run();
  if (leaseUpdate.changes !== 1 || runUpdate.changes !== 1) abortInvalidWrite();
  const event = eventFromRow(inserted);
  return event.ok
    ? { ok: true, value: { disposition: "accepted_event", event: event.value } }
    : event;
}

function replayOrRejectTerminal(
  runRow: RunRow,
  terminalKind: RunTerminalKind,
  reason: string | null,
  storedRow: RunEventRow | undefined,
): RunResult<StoredRunEventResult> {
  if (!isTerminalRunState(runRow.state) || runRow.terminalKind === null) {
    return failed({ code: "invalid_persisted_data" });
  }
  if (runRow.terminalKind !== terminalKind || runRow.terminalReason !== reason) {
    return failed({ code: "run_already_terminal" });
  }
  if (storedRow === undefined) return failed({ code: "invalid_persisted_data" });
  const event = eventFromRow(storedRow);
  return event.ok
    ? {
        ok: true,
        value: { disposition: "stored_terminal_replayed", event: event.value },
      }
    : event;
}

export function completePersistedRun(
  context: RunPersistenceContext,
  input: unknown,
): RunResult<StoredRunEventResult> {
  const parsed = CompletePersistedRunInputSchema.safeParse(input);
  if (!parsed.success) return failed({ code: "invalid_repository_input" });
  if (
    (parsed.data.terminalKind === "succeeded" && parsed.data.reason !== null) ||
    (parsed.data.terminalKind !== "succeeded" && parsed.data.reason === null)
  ) {
    return failed({ code: "invalid_repository_input" });
  }
  const runId = parsed.data.presented?.runId ?? parsed.data.runId;
  if (runId === undefined) return failed({ code: "invalid_repository_input" });
  const runRow = context.client.select().from(runs).where(eq(runs.id, runId)).get();
  if (runRow === undefined) return failed({ code: "run_not_found" });

  const payload = payloadJsonForStorage(parsed.data.payload ?? { reason: parsed.data.reason });
  if (!payload.ok) return payload;
  const digest = parsed.data.digest ?? eventDigest(payload.value);
  const timestamp = parsed.data.serverNow;

  if (isTerminalRunState(runRow.state) && runRow.terminalKind !== null) {
    const stored =
      storedCompletionEvent(
        context.client,
        runRow.id,
        runRow.terminalKind,
        parsed.data.presented?.fence,
        parsed.data.sequence,
      ) ??
      storedCompletionEvent(context.client, runRow.id, runRow.terminalKind);
    return replayOrRejectTerminal(
      runRow,
      parsed.data.terminalKind,
      parsed.data.reason,
      stored,
    );
  }

  if (parsed.data.presented !== null) {
    const current = currentLeaseForRun(context.client, runRow.id);
    const lease = requireCurrentLeaseAuthority(
      current,
      parsed.data.presented,
      timestamp,
    );
    if (!lease.ok) return lease;
    if (current === undefined) return failed({ code: "stale_fence" });
    const presentedSequence =
      parsed.data.sequence ?? current.latestEventSequence + 1;
    const storedRow = storedRunnerEvent(
      context.client,
      runRow.id,
      current.fence,
      presentedSequence,
    );
    const sequence = evaluateRunEventSequence({
      kind: "completion",
      lastAcceptedSequence: current.latestEventSequence,
      presentedSequence,
      presentedDigest: digest,
      storedAtSequence:
        storedRow === undefined
          ? null
          : {
              kind: "completion",
              digest: storedRow.digest,
              eventId: storedRow.eventId,
              terminalKind: storedRow.type as RunTerminalKind,
            },
      currentTerminalKind: runRow.terminalKind,
      terminalKind: parsed.data.terminalKind,
    });
    if (!sequence.ok) return failed(mapDomainError(sequence.error));
    if (sequence.disposition === "stored_terminal_replayed") {
      return replayOrRejectTerminal(
        runRow,
        parsed.data.terminalKind,
        parsed.data.reason,
        storedRow,
      );
    }
    if (
      hasInProgressGrantAtSequence(
        context.client,
        runRow.id,
        current.fence,
        presentedSequence,
      )
    ) {
      return failed({ code: "artifact_upload_in_progress" });
    }
    const transition = transitionRunState({
      from: runRow.state,
      to: parsed.data.terminalKind,
    });
    if (!transition.ok) return failed(mapDomainError(transition.error));
    const action = loadAction(context.client, runRow.actionId);
    if (action === undefined) return failed({ code: "action_not_found" });
    const inserted = insertEvent(context.client, {
      runId: runRow.id,
      sequence: presentedSequence,
      type: parsed.data.terminalKind,
      fence: current.fence,
      payloadJson: payload.value,
      digest,
      createdAt: timestamp,
    });
    const leaseUpdate = context.client
      .update(runLeases)
      .set({ latestEventSequence: presentedSequence, current: false })
      .where(and(eq(runLeases.leaseId, current.leaseId), eq(runLeases.current, true)))
      .run();
    const runUpdate = context.client
      .update(runs)
      .set({
        state: parsed.data.terminalKind,
        currentLeaseId: null,
        terminalKind: parsed.data.terminalKind,
        terminalReason: parsed.data.reason,
        updatedAt: timestamp,
      })
      .where(and(eq(runs.id, runRow.id), eq(runs.state, runRow.state)))
      .run();
    const actionUpdate = bumpAction(context.client, action, {
      state: parsed.data.terminalKind,
      runState: null,
      cleanupRequired: false,
      resumeRequested: false,
      updatedAt: timestamp,
    });
    if (leaseUpdate.changes !== 1 || runUpdate.changes !== 1 || !actionUpdate.ok) {
      abortInvalidWrite();
    }
    const event = eventFromRow(inserted);
    return event.ok
      ? { ok: true, value: { disposition: "accepted_completion", event: event.value } }
      : event;
  }

  const current = currentLeaseForRun(context.client, runRow.id);
  const lastAccepted = current?.latestEventSequence ?? 0;
  const presentedSequence = parsed.data.sequence ?? lastAccepted + 1;
  const sequence = evaluateRunEventSequence({
    kind: "completion",
    lastAcceptedSequence: lastAccepted,
    presentedSequence,
    presentedDigest: digest,
    storedAtSequence: null,
    currentTerminalKind: runRow.terminalKind,
    terminalKind: parsed.data.terminalKind,
  });
  if (!sequence.ok) return failed(mapDomainError(sequence.error));
  const transition = transitionRunState({
    from: runRow.state,
    to: parsed.data.terminalKind,
  });
  if (!transition.ok) return failed(mapDomainError(transition.error));
  const action = loadAction(context.client, runRow.actionId);
  if (action === undefined) return failed({ code: "action_not_found" });
  // Effective fence is computed once and reused for gating and insertion.
  const fence = current?.fence ?? runRow.currentFence;
  if (fence === "0") return failed({ code: "invalid_run_transition" });
  // Non-presented completions also wait behind an in-progress upload grant
  // bound to the effective fence and target sequence.
  if (hasInProgressGrantAtSequence(context.client, runRow.id, fence, presentedSequence)) {
    return failed({ code: "artifact_upload_in_progress" });
  }
  const inserted = insertEvent(context.client, {
    runId: runRow.id,
    sequence: presentedSequence,
    type: parsed.data.terminalKind,
    fence,
    payloadJson: payload.value,
    digest,
    createdAt: timestamp,
  });
  if (current !== undefined) {
    context.client
      .update(runLeases)
      .set({ latestEventSequence: presentedSequence, current: false })
      .where(eq(runLeases.leaseId, current.leaseId))
      .run();
  }
  const runUpdate = context.client
    .update(runs)
    .set({
      state: parsed.data.terminalKind,
      currentLeaseId: null,
      terminalKind: parsed.data.terminalKind,
      terminalReason: parsed.data.reason,
      updatedAt: timestamp,
    })
    .where(and(eq(runs.id, runRow.id), eq(runs.state, runRow.state)))
    .run();
  const actionUpdate = bumpAction(context.client, action, {
    state: parsed.data.terminalKind,
    runState: null,
    cleanupRequired: false,
    resumeRequested: false,
    updatedAt: timestamp,
  });
  if (runUpdate.changes !== 1 || !actionUpdate.ok) abortInvalidWrite();
  const event = eventFromRow(inserted);
  return event.ok
    ? { ok: true, value: { disposition: "accepted_completion", event: event.value } }
    : event;
}

export function retryPersistedRun(
  context: RunPersistenceContext,
  input: unknown,
): RunResult<PersistedRun> {
  const parsed = RetryRunInputSchema.safeParse(input);
  if (!parsed.success) return failed({ code: "invalid_repository_input" });
  const action = loadAction(context.client, parsed.data.actionId);
  if (action === undefined) return failed({ code: "action_not_found" });
  if (action.state === "succeeded") return failed({ code: "run_not_retryable" });
  if (action.state !== "failed" && action.state !== "cancelled") {
    return failed({ code: "invalid_action_transition" });
  }
  const prior = latestRunForAction(context.client, action.id);
  if (prior === undefined || !isTerminalRunState(prior.state)) {
    return failed({ code: "run_not_retryable" });
  }
  if (prior.state === "succeeded") return failed({ code: "run_not_retryable" });
  const queued = allocateQueuedRun(context, {
    actionId: action.id,
    engagementId: action.engagementId,
  });
  if (!queued.ok) return queued;
  const timestamp = context.now().toISOString();
  const actionUpdate = bumpAction(context.client, action, {
    state: "queued",
    runState: null,
    cleanupRequired: false,
    resumeRequested: false,
    pendingWarningJson: null,
    updatedAt: timestamp,
  });
  if (!actionUpdate.ok) abortInvalidWrite();
  return queued;
}

export function selectOldestQueuedRun(
  client: RunQueryClient,
): RunResult<PersistedRun> {
  const row = client
    .select()
    .from(runs)
    .where(eq(runs.state, "queued"))
    .orderBy(asc(runs.createdAt), asc(runs.id))
    .get();
  return row === undefined ? failed({ code: "no_work" }) : runFromRow(row);
}

export function fenceCurrentLeasesForRunner(
  context: RunPersistenceContext,
  input: { runnerId: string; serverNow: string },
): RunResult<{ leasesFenced: number; cancellationRequested: boolean }> {
  if (input.runnerId.length < 1 || input.runnerId.length > 255) {
    return failed({ code: "invalid_repository_input" });
  }
  const currentLeases = context.client
    .select()
    .from(runLeases)
    .where(
      and(eq(runLeases.runnerId, input.runnerId), eq(runLeases.current, true)),
    )
    .all();
  let cancellationRequested = false;
  const timestamp = input.serverNow;
  for (const lease of currentLeases) {
    const runRow = context.client
      .select()
      .from(runs)
      .where(eq(runs.id, lease.runId))
      .get();
    if (runRow === undefined) return failed({ code: "invalid_persisted_data" });
    const leaseUpdate = context.client
      .update(runLeases)
      .set({ current: false })
      .where(and(eq(runLeases.leaseId, lease.leaseId), eq(runLeases.current, true)))
      .run();
    if (leaseUpdate.changes !== 1) abortInvalidWrite();
    if (runRow.state !== "leased" && runRow.state !== "running") {
      if (runRow.currentLeaseId === lease.leaseId) {
        context.client
          .update(runs)
          .set({ currentLeaseId: null, updatedAt: timestamp })
          .where(eq(runs.id, runRow.id))
          .run();
      }
      continue;
    }
    const transition = transitionRunState({
      from: runRow.state,
      to: "cancel_requested",
    });
    if (!transition.ok) return failed(mapDomainError(transition.error));
    const runUpdate = context.client
      .update(runs)
      .set({
        state: "cancel_requested",
        currentLeaseId: null,
        updatedAt: timestamp,
      })
      .where(and(eq(runs.id, runRow.id), eq(runs.state, runRow.state)))
      .run();
    if (runUpdate.changes !== 1) abortInvalidWrite();
    const action = loadAction(context.client, runRow.actionId);
    if (action === undefined) return failed({ code: "action_not_found" });
    const actionUpdate = bumpAction(context.client, action, {
      state: action.state,
      runState: "cancel_requested",
      updatedAt: timestamp,
    });
    if (!actionUpdate.ok) abortInvalidWrite();
    cancellationRequested = true;
  }
  return {
    ok: true,
    value: {
      leasesFenced: currentLeases.length,
      cancellationRequested,
    },
  };
}

export function getPersistedRun(
  client: RunQueryClient,
  runId: string,
): RunResult<PersistedRun> {
  const row = client.select().from(runs).where(eq(runs.id, runId)).get();
  return row === undefined ? failed({ code: "run_not_found" }) : runFromRow(row);
}

export function getCurrentRunLease(
  client: RunQueryClient,
  runId: string,
): RunResult<RunnerLease> {
  const row = client
    .select()
    .from(runLeases)
    .where(and(eq(runLeases.runId, runId), eq(runLeases.current, true)))
    .get();
  return row === undefined ? failed({ code: "run_not_found" }) : leaseFromRow(row);
}

export function listPersistedRunEvents(
  client: RunQueryClient,
  runId: string,
): RunResult<PersistedRunEvent[]> {
  const rows = client
    .select()
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(asc(runEvents.eventId))
    .all();
  const values: PersistedRunEvent[] = [];
  for (const row of rows) {
    const event = eventFromRow(row);
    if (!event.ok) return event;
    values.push(event.value);
  }
  return { ok: true, value: values };
}

export class RunRepository {
  private readonly createId: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly db: BetterSQLite3Database<DatabaseSchema>,
    providers: RunRepositoryProviders = {},
  ) {
    this.createId = providers.createId ?? randomUUID;
    this.now = providers.now ?? (() => new Date());
  }

  private write<T>(
    operation: (context: RunPersistenceContext) => RunResult<T>,
    transaction?: RunWriteClient,
  ): RunResult<T> {
    if (transaction !== undefined) {
      return operation({
        client: transaction,
        createId: this.createId,
        now: this.now,
      });
    }
    try {
      return this.db.transaction(
        (client) =>
          operation({
            client,
            createId: this.createId,
            now: this.now,
          }),
        { behavior: "immediate" },
      );
    } catch (error) {
      if (error instanceof InvalidRunWriteError) {
        return failed({ code: "invalid_persisted_data" });
      }
      return failed({
        code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data",
      });
    }
  }

  createQueuedRun(
    input: unknown,
    transaction?: RunWriteClient,
  ): RunResult<PersistedRun> {
    return this.write((context) => allocateQueuedRun(context, input), transaction);
  }

  acquireLease(
    input: unknown,
    transaction?: RunWriteClient,
  ): RunResult<AcquiredRunLease> {
    return this.write((context) => acquireRunLease(context, input), transaction);
  }

  heartbeat(
    input: unknown,
    transaction?: RunWriteClient,
  ): RunResult<AcceptHeartbeatResult & { expiryWriteCount: number }> {
    return this.write((context) => heartbeatRunLease(context, input), transaction);
  }

  expireLease(
    input: unknown,
    transaction?: RunWriteClient,
  ): RunResult<{
    run: PersistedRun;
    event: PersistedRunEvent;
    automaticallyRequeued: boolean;
  }> {
    return this.write(
      (context) => expirePersistedRunLease(context, input),
      transaction,
    );
  }

  appendEvent(
    input: unknown,
    transaction?: RunWriteClient,
  ): RunResult<StoredRunEventResult> {
    return this.write((context) => appendRunEvent(context, input), transaction);
  }

  completeRun(
    input: unknown,
    transaction?: RunWriteClient,
  ): RunResult<StoredRunEventResult> {
    return this.write((context) => completePersistedRun(context, input), transaction);
  }

  retryRun(input: unknown, transaction?: RunWriteClient): RunResult<PersistedRun> {
    return this.write((context) => retryPersistedRun(context, input), transaction);
  }

  selectOldestQueued(): RunResult<PersistedRun> {
    try {
      return selectOldestQueuedRun(this.db);
    } catch (error) {
      return failed({
        code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data",
      });
    }
  }

  fenceCurrentLeases(input: {
    runnerId: string;
    serverNow: string;
  }, transaction?: RunWriteClient): RunResult<{
    leasesFenced: number;
    cancellationRequested: boolean;
  }> {
    return this.write(
      (context) => fenceCurrentLeasesForRunner(context, input),
      transaction,
    );
  }

  getRun(runId: string): RunResult<PersistedRun> {
    try {
      return getPersistedRun(this.db, runId);
    } catch (error) {
      return failed({
        code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data",
      });
    }
  }

  getCurrentLease(runId: string): RunResult<RunnerLease> {
    try {
      return getCurrentRunLease(this.db, runId);
    } catch (error) {
      return failed({
        code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data",
      });
    }
  }

  listEvents(runId: string): RunResult<PersistedRunEvent[]> {
    try {
      return listPersistedRunEvents(this.db, runId);
    } catch (error) {
      return failed({
        code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data",
      });
    }
  }
}
