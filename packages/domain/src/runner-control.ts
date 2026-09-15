import {
  AcceptHeartbeatInputSchema,
  AcceptHeartbeatResultSchema,
  EvaluateRunEventSequenceInputSchema,
  ExpireRunLeaseInputSchema,
  IncrementFenceInputSchema,
  MAX_FENCING_TOKEN,
  RUNNER_LEASE_DURATION_SECONDS,
  RUNNER_SELF_FENCE_CLEANUP_SECONDS,
  RunTransitionInputSchema,
  SelectSseResumeInputSchema,
  SelfFenceDeadlineInputSchema,
  ValidateLeaseAuthorityInputSchema,
  type AcceptHeartbeatResult,
  type EvaluateRunEventSequenceResult,
  type ExpireRunLeaseResult,
  type IncrementFenceResult,
  type LeaseAuthorityResult,
  type RunState,
  type RunTerminalKind,
  type RunTransitionResult,
  type SelectSseResumeResult,
  type SelfFenceDeadlineResult,
} from "@stonehush/contracts";

const RUN_TRANSITIONS = new Set<string>([
  "queued:leased",
  "queued:cancelled",
  "queued:failed",
  "leased:queued",
  "leased:running",
  "leased:cancel_requested",
  "leased:failed",
  "running:cancel_requested",
  "running:succeeded",
  "running:failed",
  "cancel_requested:cancelled",
  "cancel_requested:failed",
]);

const TERMINAL_RUN_STATES = new Set<RunState>([
  "succeeded",
  "failed",
  "cancelled",
]);

// These rules are deliberately side-effect free. The control plane must call
// them inside the D2 transaction that owns leases, sequences, and event IDs.
function parseWithoutThrow<T>(operation: () => T): T | null {
  try {
    return operation();
  } catch {
    return null;
  }
}

function freeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    freeze(child);
  }
  return value;
}

function invalidLeaseAuthority(): LeaseAuthorityResult {
  return freeze({
    ok: false,
    error: { code: "invalid_runner_control_input" },
  });
}

export function incrementFencingToken(input: unknown): IncrementFenceResult {
  const parsed = parseWithoutThrow(() => IncrementFenceInputSchema.safeParse(input));
  if (parsed === null || !parsed.success) {
    return freeze({
      ok: false,
      error: { code: "invalid_runner_control_input" },
    });
  }

  const currentFence = BigInt(parsed.data.currentFence);
  if (currentFence === MAX_FENCING_TOKEN) {
    return freeze({ ok: false, error: { code: "fencing_exhausted" } });
  }

  return freeze({ ok: true, nextFence: String(currentFence + 1n) });
}

export function validateLeaseAuthority(input: unknown): LeaseAuthorityResult {
  const parsed = parseWithoutThrow(() =>
    ValidateLeaseAuthorityInputSchema.safeParse(input),
  );
  if (parsed === null || !parsed.success) {
    return invalidLeaseAuthority();
  }

  const { lease, presented, serverNow } = parsed.data;
  if (
    lease.runnerId !== presented.runnerId ||
    lease.sessionId !== presented.sessionId
  ) {
    return freeze({
      ok: false,
      error: { code: "lease_owner_mismatch" },
    });
  }
  if (
    lease.runId !== presented.runId ||
    lease.leaseId !== presented.leaseId ||
    lease.fence !== presented.fence
  ) {
    return freeze({ ok: false, error: { code: "stale_fence" } });
  }
  if (Date.parse(serverNow) >= Date.parse(lease.expiresAt)) {
    return freeze({ ok: false, error: { code: "lease_expired" } });
  }

  return freeze({ ok: true, lease });
}

export function acceptHeartbeat(input: unknown): AcceptHeartbeatResult {
  const parsed = parseWithoutThrow(() => AcceptHeartbeatInputSchema.safeParse(input));
  if (parsed === null || !parsed.success) {
    return freeze({
      ok: false,
      error: { code: "invalid_runner_control_input" },
    });
  }

  const { storedHeartbeat } = parsed.data;
  if (storedHeartbeat !== null) {
    if (storedHeartbeat.requestDigest !== parsed.data.requestDigest) {
      return freeze({
        ok: false,
        error: { code: "heartbeat_replay_conflict" },
      });
    }
    return freeze({
      ok: true,
      disposition: "stored_heartbeat_replayed",
      leaseExpiresAt: storedHeartbeat.leaseExpiresAt,
    });
  }

  const authority = validateLeaseAuthority({
    lease: parsed.data.lease,
    presented: parsed.data.presented,
    serverNow: parsed.data.serverNow,
  });
  if (!authority.ok) {
    return authority;
  }
  if (
    parsed.data.heartbeatSequence <=
    parsed.data.lease.latestHeartbeatSequence
  ) {
    return freeze({
      ok: false,
      error: { code: "heartbeat_sequence_stale" },
    });
  }

  const serverNowMs = Date.parse(parsed.data.serverNow);
  const leaseExpiresAtMs =
    serverNowMs + RUNNER_LEASE_DURATION_SECONDS * 1_000;
  if (!Number.isFinite(leaseExpiresAtMs)) {
    return freeze({
      ok: false,
      error: { code: "invalid_runner_control_input" },
    });
  }

  const leaseExpiresAt = new Date(leaseExpiresAtMs).toISOString();
  const heartbeat = {
    heartbeatSequence: parsed.data.heartbeatSequence,
    requestDigest: parsed.data.requestDigest,
    leaseExpiresAt,
  };
  const result = parseWithoutThrow(() =>
    AcceptHeartbeatResultSchema.safeParse({
      ok: true,
      disposition: "accepted",
      lease: {
        ...parsed.data.lease,
        expiresAt: leaseExpiresAt,
        latestHeartbeatSequence: parsed.data.heartbeatSequence,
      },
      heartbeat,
    }),
  );
  if (result === null || !result.success) {
    return freeze({
      ok: false,
      error: { code: "invalid_runner_control_input" },
    });
  }
  return freeze(result.data);
}

export function transitionRunState(input: unknown): RunTransitionResult {
  const parsed = parseWithoutThrow(() => RunTransitionInputSchema.safeParse(input));
  if (parsed === null || !parsed.success) {
    return freeze({
      ok: false,
      error: { code: "invalid_runner_control_input" },
    });
  }
  if (!RUN_TRANSITIONS.has(`${parsed.data.from}:${parsed.data.to}`)) {
    return freeze({ ok: false, error: { code: "invalid_run_transition" } });
  }
  return freeze({ ok: true, state: parsed.data.to });
}

export function expireRunLease(input: unknown): ExpireRunLeaseResult {
  const parsed = parseWithoutThrow(() => ExpireRunLeaseInputSchema.safeParse(input));
  if (parsed === null || !parsed.success) {
    return freeze({
      ok: false,
      error: { code: "invalid_runner_control_input" },
    });
  }

  const { actionState, runState } = parsed.data;
  if (runState === "leased" && actionState === "active") {
    return freeze({
      ok: true,
      actionState: "queued",
      runState: "queued",
      terminal: false,
      automaticallyRequeued: true,
      reason: "lease_expired",
    });
  }
  if (
    runState === "running" &&
    (actionState === "active" || actionState === "active_paused_for_warning")
  ) {
    return freeze({
      ok: true,
      actionState: "failed",
      runState: "failed",
      terminal: true,
      automaticallyRequeued: false,
      reason: "runner_lost",
    });
  }
  if (
    runState === "cancel_requested" &&
    (actionState === "active" || actionState === "active_paused_for_warning")
  ) {
    return freeze({
      ok: true,
      actionState: "failed",
      runState: "failed",
      terminal: true,
      automaticallyRequeued: false,
      reason: "runner_lost_during_cancel",
    });
  }

  return freeze({ ok: false, error: { code: "invalid_run_transition" } });
}

export function evaluateRunEventSequence(
  input: unknown,
): EvaluateRunEventSequenceResult {
  const parsed = parseWithoutThrow(() =>
    EvaluateRunEventSequenceInputSchema.safeParse(input),
  );
  if (parsed === null || !parsed.success) {
    return freeze({
      ok: false,
      error: { code: "invalid_runner_control_input" },
    });
  }

  const { storedAtSequence } = parsed.data;
  if (storedAtSequence !== null) {
    if (
      storedAtSequence.digest !== parsed.data.presentedDigest ||
      storedAtSequence.kind !== parsed.data.kind ||
      (parsed.data.kind === "completion" &&
        storedAtSequence.terminalKind !== parsed.data.terminalKind)
    ) {
      return freeze({
        ok: false,
        error: {
          code:
            parsed.data.kind === "completion" &&
            parsed.data.currentTerminalKind !== null
              ? "run_already_terminal"
              : "event_replay_conflict",
        },
      });
    }
    return freeze({
      ok: true,
      disposition:
        storedAtSequence.kind === "completion"
          ? "stored_terminal_replayed"
          : "stored_event_replayed",
      eventId: storedAtSequence.eventId,
      acceptedSequence: parsed.data.presentedSequence,
      nextEventSequence:
        parsed.data.lastAcceptedSequence === Number.MAX_SAFE_INTEGER
          ? null
          : parsed.data.lastAcceptedSequence + 1,
    });
  }

  if (parsed.data.currentTerminalKind !== null) {
    return freeze({ ok: false, error: { code: "run_already_terminal" } });
  }
  if (parsed.data.lastAcceptedSequence === Number.MAX_SAFE_INTEGER) {
    return freeze({
      ok: false,
      error: { code: "event_sequence_exhausted" },
    });
  }

  const expectedSequence = parsed.data.lastAcceptedSequence + 1;
  if (parsed.data.presentedSequence !== expectedSequence) {
    return freeze({
      ok: false,
      error: { code: "event_sequence_gap", expectedSequence },
    });
  }
  if (parsed.data.presentedSequence === Number.MAX_SAFE_INTEGER) {
    return freeze({
      ok: false,
      error: { code: "event_sequence_exhausted" },
    });
  }

  return freeze({
    ok: true,
    disposition:
      parsed.data.kind === "completion"
        ? "accepted_completion"
        : "accepted_event",
    eventId: null,
    acceptedSequence: parsed.data.presentedSequence,
    nextEventSequence: parsed.data.presentedSequence + 1,
  });
}

export function selectSseResume(input: unknown): SelectSseResumeResult {
  const parsed = parseWithoutThrow(() => SelectSseResumeInputSchema.safeParse(input));
  if (parsed === null || !parsed.success) {
    return freeze({
      ok: false,
      error: { code: "invalid_runner_control_input" },
    });
  }

  if (parsed.data.lastEventId > parsed.data.currentWatermark) {
    return freeze({
      ok: false,
      error: {
        code: "sse_cursor_ahead",
        currentWatermark: parsed.data.currentWatermark,
      },
    });
  }

  const earliestEventId = parsed.data.retainedEventIds[0];
  if (
    earliestEventId !== undefined &&
    parsed.data.lastEventId < earliestEventId
  ) {
    return freeze({
      ok: false,
      error: {
        code: "sse_cursor_expired",
        earliestEventId,
        snapshotUrl: parsed.data.snapshotUrl,
      },
    });
  }

  return freeze({
    ok: true,
    deliveredEventIds: parsed.data.retainedEventIds.filter(
      (eventId) => eventId > parsed.data.lastEventId,
    ),
  });
}

export function calculateSelfFenceDeadline(
  input: unknown,
): SelfFenceDeadlineResult {
  const parsed = parseWithoutThrow(() =>
    SelfFenceDeadlineInputSchema.safeParse(input),
  );
  if (parsed === null || !parsed.success) {
    return freeze({
      ok: false,
      error: { code: "invalid_runner_control_input" },
    });
  }

  const localFenceDeadlineMonotonicMs =
    parsed.data.heartbeatRequestSentMonotonicMs +
    RUNNER_LEASE_DURATION_SECONDS * 1_000;
  const cleanupStartsMonotonicMs =
    localFenceDeadlineMonotonicMs -
    RUNNER_SELF_FENCE_CLEANUP_SECONDS * 1_000;
  if (!Number.isSafeInteger(localFenceDeadlineMonotonicMs)) {
    return freeze({
      ok: false,
      error: { code: "invalid_runner_control_input" },
    });
  }

  return freeze({
    ok: true,
    cleanupStartsMonotonicMs,
    localFenceDeadlineMonotonicMs,
  });
}

export function isTerminalRunState(state: unknown): state is RunTerminalKind {
  return typeof state === "string" && TERMINAL_RUN_STATES.has(state as RunState);
}
