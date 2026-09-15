import type { RunState } from "@stonehush/contracts";
import { describe, expect, it } from "vitest";

import leaseFixtureData from "../../../docs/architecture/fixtures/d2/lease-events.json" with {
  type: "json",
};
import stateFixtureData from "../../../docs/architecture/fixtures/d2/state-machine.json" with {
  type: "json",
};
import {
  acceptHeartbeat,
  calculateSelfFenceDeadline,
  evaluateRunEventSequence,
  expireRunLease,
  incrementFencingToken,
  isTerminalRunState,
  selectSseResume,
  transitionRunState,
  validateLeaseAuthority,
} from "./runner-control.js";

const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;

const lease = {
  orchestrationProfile: "d2-v1",
  protocol: "runner-control-v1",
  runId: "run-fixture-1",
  leaseId: "lease-fixture-1",
  runnerId: "runner-fixture-1",
  sessionId: "session-fixture-1",
  fence: "7",
  expiresAt: "2026-08-09T12:00:30.000Z",
  latestHeartbeatSequence: 0,
  latestEventSequence: 0,
} as const;

const presented = {
  runId: lease.runId,
  leaseId: lease.leaseId,
  runnerId: lease.runnerId,
  sessionId: lease.sessionId,
  fence: lease.fence,
} as const;

function fixtureCase(
  fixture: { readonly cases: readonly { readonly id: string }[] },
  id: string,
): { readonly id: string } {
  const value = fixture.cases.find((candidate) => candidate.id === id);
  if (value === undefined) {
    throw new Error(`Missing D2 fixture ${id}`);
  }
  return value;
}

describe("runner control domain", () => {
  it("implements every edge in the D2 run transition matrix", () => {
    const fixture = fixtureCase(
      stateFixtureData,
      "d2.state.run-transition-matrix",
    ) as unknown as {
      given: {
        states: RunState[];
        validEdges: [RunState, RunState][];
      };
    };
    const validEdges = new Set(
      fixture.given.validEdges.map(([from, to]) => `${from}:${to}`),
    );

    for (const from of fixture.given.states) {
      for (const to of fixture.given.states) {
        const result = transitionRunState({ from, to });
        if (validEdges.has(`${from}:${to}`)) {
          expect(result, `${from} -> ${to}`).toEqual({ ok: true, state: to });
        } else {
          expect(result, `${from} -> ${to}`).toEqual({
            ok: false,
            error: { code: "invalid_run_transition" },
          });
        }
      }
    }
  });

  it("identifies only terminal Run states", () => {
    expect(isTerminalRunState("succeeded")).toBe(true);
    expect(isTerminalRunState("failed")).toBe(true);
    expect(isTerminalRunState("cancelled")).toBe(true);
    expect(isTerminalRunState("queued")).toBe(false);
    expect(isTerminalRunState("unknown")).toBe(false);
  });

  it("increments the durable signed 64-bit fence without wrapping", () => {
    const reassignment = fixtureCase(
      leaseFixtureData,
      "d2.lease.reassignment-increments-fence",
    ) as unknown as {
      given: { priorFence: number };
      expected: { newFence: number };
    };
    expect(
      incrementFencingToken({ currentFence: String(reassignment.given.priorFence) }),
    ).toEqual({
      ok: true,
      nextFence: String(reassignment.expected.newFence),
    });
    expect(incrementFencingToken({ currentFence: "0" })).toEqual({
      ok: true,
      nextFence: "1",
    });
    expect(
      incrementFencingToken({ currentFence: "9223372036854775807" }),
    ).toEqual({ ok: false, error: { code: "fencing_exhausted" } });
    expect(incrementFencingToken({ currentFence: "9223372036854775808" })).toEqual(
      { ok: false, error: { code: "invalid_runner_control_input" } },
    );
  });

  it("accepts only the current owner, session, lease, fence, and time", () => {
    expect(
      validateLeaseAuthority({
        lease,
        presented,
        serverNow: "2026-08-09T12:00:29.999Z",
      }),
    ).toEqual({ ok: true, lease });
    expect(
      validateLeaseAuthority({
        lease,
        presented: { ...presented, fence: "6" },
        serverNow: "2026-08-09T12:00:10.000Z",
      }),
    ).toEqual({ ok: false, error: { code: "stale_fence" } });
    expect(
      validateLeaseAuthority({
        lease,
        presented: { ...presented, runnerId: "runner-fixture-2" },
        serverNow: "2026-08-09T12:00:10.000Z",
      }),
    ).toEqual({ ok: false, error: { code: "lease_owner_mismatch" } });
    expect(
      validateLeaseAuthority({
        lease,
        presented,
        serverNow: lease.expiresAt,
      }),
    ).toEqual({ ok: false, error: { code: "lease_expired" } });
  });

  it("extends heartbeats from control-plane time", () => {
    const fixture = fixtureCase(
      leaseFixtureData,
      "d2.lease.heartbeat-extends-from-server-time",
    ) as unknown as {
      given: { heartbeatSequence: number; serverNow: string };
      expected: { leaseExpiresAt: string };
    };
    const result = acceptHeartbeat({
      lease,
      presented,
      heartbeatSequence: fixture.given.heartbeatSequence,
      requestDigest: digestA,
      serverNow: fixture.given.serverNow,
      storedHeartbeat: null,
    });

    expect(result).toEqual({
      ok: true,
      disposition: "accepted",
      lease: {
        ...lease,
        expiresAt: fixture.expected.leaseExpiresAt,
        latestHeartbeatSequence: fixture.given.heartbeatSequence,
      },
      heartbeat: {
        heartbeatSequence: fixture.given.heartbeatSequence,
        requestDigest: digestA,
        leaseExpiresAt: fixture.expected.leaseExpiresAt,
      },
    });
  });

  it("replays an exact stored heartbeat before current lease checks", () => {
    const replay = acceptHeartbeat({
      lease: { ...lease, expiresAt: "2026-08-09T12:00:01.000Z" },
      presented: { ...presented, fence: "6" },
      heartbeatSequence: 4,
      requestDigest: digestA,
      serverNow: "2026-08-09T12:00:10.000Z",
      storedHeartbeat: {
        heartbeatSequence: 4,
        requestDigest: digestA,
        leaseExpiresAt: "2026-08-09T12:00:35.000Z",
      },
    });
    expect(replay).toEqual({
      ok: true,
      disposition: "stored_heartbeat_replayed",
      leaseExpiresAt: "2026-08-09T12:00:35.000Z",
    });
    expect(
      acceptHeartbeat({
        lease,
        presented,
        heartbeatSequence: 4,
        requestDigest: digestB,
        serverNow: "2026-08-09T12:00:10.000Z",
        storedHeartbeat: {
          heartbeatSequence: 4,
          requestDigest: digestA,
          leaseExpiresAt: "2026-08-09T12:00:35.000Z",
        },
      }),
    ).toEqual({
      ok: false,
      error: { code: "heartbeat_replay_conflict" },
    });
  });

  it("rejects an unstored stale heartbeat without changing the lease", () => {
    expect(
      acceptHeartbeat({
        lease: { ...lease, latestHeartbeatSequence: 4 },
        presented,
        heartbeatSequence: 4,
        requestDigest: digestA,
        serverNow: "2026-08-09T12:00:10.000Z",
        storedHeartbeat: null,
      }),
    ).toEqual({
      ok: false,
      error: { code: "heartbeat_sequence_stale" },
    });
    expect(
      acceptHeartbeat({
        lease: { ...lease, latestHeartbeatSequence: 1 },
        presented,
        heartbeatSequence: 3,
        requestDigest: digestA,
        serverNow: "2026-08-09T12:00:10.000Z",
        storedHeartbeat: null,
      }),
    ).toMatchObject({
      ok: true,
      disposition: "accepted",
      lease: { latestHeartbeatSequence: 3 },
    });
  });

  it("rejects a heartbeat whose server-time extension leaves the wire range", () => {
    expect(
      acceptHeartbeat({
        lease: {
          ...lease,
          expiresAt: "9999-12-31T23:59:59.999Z",
        },
        presented,
        heartbeatSequence: 1,
        requestDigest: digestA,
        serverNow: "9999-12-31T23:59:59.000Z",
        storedHeartbeat: null,
      }),
    ).toEqual({
      ok: false,
      error: { code: "invalid_runner_control_input" },
    });
  });

  it("maps lease expiry without silently repeating started work", () => {
    expect(expireRunLease({ actionState: "active", runState: "leased" })).toEqual(
      {
        ok: true,
        actionState: "queued",
        runState: "queued",
        terminal: false,
        automaticallyRequeued: true,
        reason: "lease_expired",
      },
    );
    expect(expireRunLease({ actionState: "active", runState: "running" })).toEqual(
      {
        ok: true,
        actionState: "failed",
        runState: "failed",
        terminal: true,
        automaticallyRequeued: false,
        reason: "runner_lost",
      },
    );
    expect(
      expireRunLease({
        actionState: "active_paused_for_warning",
        runState: "running",
      }),
    ).toMatchObject({
      ok: true,
      actionState: "failed",
      runState: "failed",
      reason: "runner_lost",
    });
    expect(
      expireRunLease({ actionState: "active", runState: "cancel_requested" }),
    ).toMatchObject({
      ok: true,
      actionState: "failed",
      runState: "failed",
      reason: "runner_lost_during_cancel",
    });
    expect(expireRunLease({ actionState: "queued", runState: "leased" })).toEqual(
      { ok: false, error: { code: "invalid_run_transition" } },
    );
  });

  it("accepts, replays, and rejects fenced event sequences deterministically", () => {
    expect(
      evaluateRunEventSequence({
        kind: "event",
        lastAcceptedSequence: 0,
        presentedSequence: 1,
        presentedDigest: digestA,
        storedAtSequence: null,
        currentTerminalKind: null,
      }),
    ).toEqual({
      ok: true,
      disposition: "accepted_event",
      eventId: null,
      acceptedSequence: 1,
      nextEventSequence: 2,
    });

    expect(
      evaluateRunEventSequence({
        kind: "event",
        lastAcceptedSequence: 4,
        presentedSequence: 2,
        presentedDigest: digestA,
        storedAtSequence: {
          kind: "event",
          digest: digestA,
          eventId: 42,
          terminalKind: null,
        },
        currentTerminalKind: null,
      }),
    ).toEqual({
      ok: true,
      disposition: "stored_event_replayed",
      eventId: 42,
      acceptedSequence: 2,
      nextEventSequence: 5,
    });

    expect(
      evaluateRunEventSequence({
        kind: "event",
        lastAcceptedSequence: 2,
        presentedSequence: 2,
        presentedDigest: digestB,
        storedAtSequence: {
          kind: "event",
          digest: digestA,
          eventId: 42,
          terminalKind: null,
        },
        currentTerminalKind: null,
      }),
    ).toEqual({ ok: false, error: { code: "event_replay_conflict" } });

    expect(
      evaluateRunEventSequence({
        kind: "event",
        lastAcceptedSequence: 2,
        presentedSequence: 4,
        presentedDigest: digestA,
        storedAtSequence: null,
        currentTerminalKind: null,
      }),
    ).toEqual({
      ok: false,
      error: { code: "event_sequence_gap", expectedSequence: 3 },
    });
  });

  it("shares the event sequence with completion and preserves one terminal winner", () => {
    expect(
      evaluateRunEventSequence({
        kind: "completion",
        terminalKind: "succeeded",
        lastAcceptedSequence: 3,
        presentedSequence: 4,
        presentedDigest: digestA,
        storedAtSequence: null,
        currentTerminalKind: null,
      }),
    ).toEqual({
      ok: true,
      disposition: "accepted_completion",
      eventId: null,
      acceptedSequence: 4,
      nextEventSequence: 5,
    });

    expect(
      evaluateRunEventSequence({
        kind: "completion",
        terminalKind: "succeeded",
        lastAcceptedSequence: 4,
        presentedSequence: 4,
        presentedDigest: digestA,
        storedAtSequence: {
          kind: "completion",
          digest: digestA,
          eventId: 70,
          terminalKind: "succeeded",
        },
        currentTerminalKind: "succeeded",
      }),
    ).toEqual({
      ok: true,
      disposition: "stored_terminal_replayed",
      eventId: 70,
      acceptedSequence: 4,
      nextEventSequence: 5,
    });

    expect(
      evaluateRunEventSequence({
        kind: "completion",
        terminalKind: "failed",
        lastAcceptedSequence: 4,
        presentedSequence: 4,
        presentedDigest: digestB,
        storedAtSequence: {
          kind: "completion",
          digest: digestA,
          eventId: 70,
          terminalKind: "succeeded",
        },
        currentTerminalKind: "succeeded",
      }),
    ).toEqual({ ok: false, error: { code: "run_already_terminal" } });
    expect(
      evaluateRunEventSequence({
        kind: "event",
        lastAcceptedSequence: 4,
        presentedSequence: 5,
        presentedDigest: digestB,
        storedAtSequence: null,
        currentTerminalKind: "succeeded",
      }),
    ).toEqual({ ok: false, error: { code: "run_already_terminal" } });
  });

  it("fails closed at sequence exhaustion but preserves exact stored replay", () => {
    expect(
      evaluateRunEventSequence({
        kind: "event",
        lastAcceptedSequence: Number.MAX_SAFE_INTEGER,
        presentedSequence: Number.MAX_SAFE_INTEGER,
        presentedDigest: digestA,
        storedAtSequence: {
          kind: "event",
          digest: digestA,
          eventId: 71,
          terminalKind: null,
        },
        currentTerminalKind: null,
      }),
    ).toEqual({
      ok: true,
      disposition: "stored_event_replayed",
      eventId: 71,
      acceptedSequence: Number.MAX_SAFE_INTEGER,
      nextEventSequence: null,
    });
    expect(
      evaluateRunEventSequence({
        kind: "event",
        lastAcceptedSequence: Number.MAX_SAFE_INTEGER,
        presentedSequence: Number.MAX_SAFE_INTEGER,
        presentedDigest: digestA,
        storedAtSequence: null,
        currentTerminalKind: null,
      }),
    ).toEqual({
      ok: false,
      error: { code: "event_sequence_exhausted" },
    });
    expect(
      evaluateRunEventSequence({
        kind: "completion",
        terminalKind: "failed",
        lastAcceptedSequence: Number.MAX_SAFE_INTEGER - 1,
        presentedSequence: Number.MAX_SAFE_INTEGER,
        presentedDigest: digestA,
        storedAtSequence: null,
        currentTerminalKind: null,
      }),
    ).toEqual({
      ok: false,
      error: { code: "event_sequence_exhausted" },
    });
  });

  it("implements ordered, expired, and future SSE cursors from D2", () => {
    const snapshotUrl =
      "/api/v1/engagements/engagement-fixture-2/snapshot";
    expect(
      selectSseResume({
        retainedEventIds: [40, 41, 42, 43],
        lastEventId: 41,
        currentWatermark: 43,
        snapshotUrl,
      }),
    ).toEqual({ ok: true, deliveredEventIds: [42, 43] });
    expect(
      selectSseResume({
        retainedEventIds: [40, 41, 42, 43],
        lastEventId: 39,
        currentWatermark: 43,
        snapshotUrl,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "sse_cursor_expired",
        earliestEventId: 40,
        snapshotUrl,
      },
    });
    expect(
      selectSseResume({
        retainedEventIds: [40, 41, 42, 43],
        lastEventId: 44,
        currentWatermark: 43,
        snapshotUrl,
      }),
    ).toEqual({
      ok: false,
      error: { code: "sse_cursor_ahead", currentWatermark: 43 },
    });
    expect(
      selectSseResume({
        retainedEventIds: [],
        lastEventId: 5,
        currentWatermark: 43,
        snapshotUrl,
      }),
    ).toEqual({
      ok: false,
      error: { code: "invalid_runner_control_input" },
    });
    expect(
      selectSseResume({
        retainedEventIds: [],
        lastEventId: 0,
        currentWatermark: 0,
        snapshotUrl,
      }),
    ).toEqual({ ok: true, deliveredEventIds: [] });
  });

  it("derives the conservative self-fence deadline from monotonic send time", () => {
    const fixture = fixtureCase(
      leaseFixtureData,
      "d2.lease.partitioned-runner-self-fences",
    ) as unknown as {
      given: { heartbeatRequestSentMonotonicMs: number };
      expected: {
        cleanupStartsMonotonicMs: number;
        localFenceDeadlineMonotonicMs: number;
      };
    };
    expect(
      calculateSelfFenceDeadline({
        heartbeatRequestSentMonotonicMs:
          fixture.given.heartbeatRequestSentMonotonicMs,
      }),
    ).toEqual({
      ok: true,
      cleanupStartsMonotonicMs: fixture.expected.cleanupStartsMonotonicMs,
      localFenceDeadlineMonotonicMs:
        fixture.expected.localFenceDeadlineMonotonicMs,
    });
    expect(
      calculateSelfFenceDeadline({
        heartbeatRequestSentMonotonicMs: Number.MAX_SAFE_INTEGER - 1,
      }),
    ).toEqual({
      ok: false,
      error: { code: "invalid_runner_control_input" },
    });
  });

  it("never throws on hostile input and deep-freezes successful output", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("hostile input");
        },
      },
    );
    const operations = [
      incrementFencingToken,
      validateLeaseAuthority,
      acceptHeartbeat,
      transitionRunState,
      expireRunLease,
      evaluateRunEventSequence,
      selectSseResume,
      calculateSelfFenceDeadline,
    ] as const;
    for (const operation of operations) {
      expect(() => operation(hostile)).not.toThrow();
      expect(operation(hostile)).toMatchObject({
        ok: false,
        error: { code: "invalid_runner_control_input" },
      });
    }

    const result = acceptHeartbeat({
      lease,
      presented,
      heartbeatSequence: 1,
      requestDigest: digestA,
      serverNow: "2026-08-09T12:00:10.000Z",
      storedHeartbeat: null,
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.ok && result.disposition === "accepted") {
      expect(Object.isFrozen(result.lease)).toBe(true);
      expect(Object.isFrozen(result.heartbeat)).toBe(true);
    }
  });
});
