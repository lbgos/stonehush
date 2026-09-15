import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ActionSnapshot, RunnerLease } from "@stonehush/contracts";
import { afterEach, describe, expect, it } from "vitest";

import leaseFixtureData from "../../../docs/architecture/fixtures/d2/lease-events.json" with {
  type: "json",
};
import { bindActionSnapshot } from "./action-snapshot.js";
import { DATABASE_FILENAME, openEngagementDatabase, DATABASE_SCHEMA_VERSION } from "./database.js";
import { EngagementRepository } from "./repository.js";
import { RunRepository } from "./run.js";

const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;
const digestC = `sha256:${"c".repeat(64)}`;

const MUST_IMPLEMENT = [
  "d2.lease.acquire-once",
  "d2.lease.heartbeat-extends-from-server-time",
  "d2.lease.heartbeat-replay",
  "d2.lease.unstarted-expiry-requeues",
  "d2.lease.reassignment-increments-fence",
  "d2.lease.fencing-exhausted-fails-before-lease",
  "d2.lease.running-expiry-fails",
  "d2.lease.control-plane-restart-preserves-lease",
  "d2.lease.stale-fence-rejected",
  "d2.lease.expired-append-rejected",
  "d2.lease.owner-mismatch-rejected",
] as const;

const DEFERRED: Record<string, string> = {
  "d2.lease.runner-restart-fences-abandoned-work":
    "runner executable / process journal",
  "d2.lease.partitioned-runner-self-fences": "runner monotonic clock",
  "d2.event.stale-late-destination-cannot-pause":
    "action late-warning persistence / API",
  "d2.sse.ordered-resume": "SSE transport",
  "d2.sse.expired-cursor": "SSE transport",
  "d2.sse.future-cursor": "SSE transport",
};

interface Fixture {
  directory: string;
  database: ReturnType<typeof openEngagementDatabase>;
  engagements: EngagementRepository;
  runs: RunRepository;
  setNow(value: string): void;
}

const fixtures: Fixture[] = [];

function createFixture(
  options: { runId?: string; leaseIds?: readonly string[] } = {},
): Fixture {
  const directory = mkdtempSync(path.join(tmpdir(), "stonehush-run-db-"));
  chmodSync(directory, 0o700);
  const database = openEngagementDatabase({ dataDirectory: directory });
  let engagementSeq = 0;
  let leaseSeq = 0;
  let now = new Date("2026-08-09T12:00:00.000Z");
  const engagements = new EngagementRepository(database.db, {
    createId: () => {
      engagementSeq += 1;
      if (engagementSeq === 2 && options.runId !== undefined) return options.runId;
      return `10000000-0000-4000-8000-${String(engagementSeq).padStart(12, "0")}`;
    },
    now: () => new Date(now),
  });
  const fixture: Fixture = {
    directory,
    database,
    engagements,
    runs: new RunRepository(database.db, {
      createId: () => {
        const id = options.leaseIds?.[leaseSeq];
        leaseSeq += 1;
        return id ?? `lease-storage-fixture-${leaseSeq}`;
      },
      now: () => new Date(now),
    }),
    setNow(value: string) {
      now = new Date(value);
    },
  };
  fixtures.push(fixture);
  return fixture;
}

function boundSnapshot(actionId: string): ActionSnapshot {
  const snapshot: ActionSnapshot = {
    normalizationProfile: "d1-v1",
    orchestrationProfile: "d2-v1",
    snapshotId: `snapshot-${actionId}`,
    version: 1,
    binding: digestA,
    actionId,
    canonicalTargets: [
      {
        normalizationProfile: "d1-v1",
        kind: "hostname",
        hostname: "app.target.test",
      },
    ],
    concreteDestinations: [
      {
        normalizationProfile: "d1-v1",
        kind: "ip",
        family: 4,
        address: "192.0.2.40",
        zone: null,
      },
    ],
    typedOptions: { fixture: true },
    resolutionSnapshots: [
      {
        canonicalQueryName: "app.target.test",
        resolverMode: "system",
        cnameChain: [],
        answers: [{ address: "192.0.2.40", family: 4, ttlSeconds: 60 }],
        resolvedAt: "2026-08-09T11:59:00.000Z",
      },
    ],
    scopeRevisionId: null,
    warningState: {
      reasonCodes: [],
      knownAdditions: [],
      acknowledgment: null,
    },
  };
  const bound = bindActionSnapshot(snapshot);
  if (!bound.ok) throw new Error("fixture snapshot binding failed");
  return { ...snapshot, binding: bound.binding };
}

function queuedAction(
  fixture: Fixture,
  actionId = "action-fixture-1",
): { engagementId: string; runId: string } {
  const engagement = fixture.engagements.createEngagement({
    name: "Runner fixture lab",
    kind: "lab",
    description: null,
    authorizationContext: "Synthetic fixture authorization context",
    autoContinueWarnings: false,
  });
  if (!engagement.ok) throw new Error("fixture engagement failed");
  const planned = fixture.engagements.persistPlannedAction({
    engagementId: engagement.value.id,
    snapshot: boundSnapshot(actionId),
    representable: true,
    capabilityErrorCode: null,
    occurredAt: "2026-08-09T12:00:00.000Z",
  });
  if (!planned.ok) throw new Error(`fixture action failed: ${planned.error.code}`);
  const row = fixture.database.sqlite
    .prepare("select id from runs where action_id = ?")
    .get(actionId) as { id: string } | undefined;
  if (row === undefined) throw new Error("queued run was not allocated");
  return { engagementId: engagement.value.id, runId: row.id };
}

function acquire(
  fixture: Fixture,
  runId: string,
  overrides: {
    runnerId?: string;
    sessionId?: string;
    serverNow?: string;
  } = {},
) {
  const acquired = fixture.runs.acquireLease({
    runId,
    runnerId: overrides.runnerId ?? "runner-fixture-1",
    sessionId: overrides.sessionId ?? "session-fixture-1",
    serverNow: overrides.serverNow ?? "2026-08-09T12:00:00.000Z",
  });
  if (!acquired.ok) throw new Error(`fixture lease failed: ${acquired.error.code}`);
  return acquired.value;
}

function presentation(lease: RunnerLease, fence = lease.fence) {
  return {
    runId: lease.runId,
    leaseId: lease.leaseId,
    runnerId: lease.runnerId,
    sessionId: lease.sessionId,
    fence,
  };
}

function startRun(fixture: Fixture, lease: RunnerLease, sequence = 1) {
  const started = fixture.runs.appendEvent({
    presented: presentation(lease),
    sequence,
    type: "started",
    payload: { started: true },
    digest: digestA,
    serverNow: "2026-08-09T12:00:05.000Z",
  });
  if (!started.ok) throw new Error(`fixture start failed: ${started.error.code}`);
  return started.value;
}

function fixtureCase(id: string) {
  const value = leaseFixtureData.cases.find((candidate) => candidate.id === id);
  if (value === undefined) throw new Error(`Missing D2 fixture ${id}`);
  return value;
}

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture === undefined) continue;
    if (fixture.database.sqlite.open) fixture.database.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

describe("run persistence fixture ownership", () => {
  it("implements or explicitly defers every D2 lease-events case", () => {
    const implemented = new Set<string>([
      ...MUST_IMPLEMENT,
      "d2.lease.cancel-requested-expiry-fails",
      "d2.lease.paused-running-expiry-fails",
      "d2.event.identical-sequence-replay",
      "d2.event.sequence-body-conflict",
      "d2.event.sequence-gap-rejected",
      "d2.event.completion-shares-event-sequence",
      "d2.event.duplicate-completion-no-duplicates",
    ]);
    for (const entry of leaseFixtureData.cases) {
      const deferredOwner = DEFERRED[entry.id];
      if (deferredOwner !== undefined) {
        expect(implemented.has(entry.id), `${entry.id} must not be fake-passed`).toBe(
          false,
        );
        expect(deferredOwner.length).toBeGreaterThan(0);
        continue;
      }
      expect(implemented.has(entry.id), `${entry.id} has no owner`).toBe(true);
    }
  });
});

describe("run persistence", () => {
  it("allocates attempt 1 in the same transaction that first queues an Action", () => {
    const fixture = createFixture({ runId: "run-fixture-1" });
    const created = queuedAction(fixture, "action-fixture-1");
    expect(fixture.runs.getRun(created.runId)).toMatchObject({
      ok: true,
      value: {
        id: created.runId,
        actionId: "action-fixture-1",
        attempt: 1,
        state: "queued",
        currentLeaseId: null,
        currentFence: "0",
      },
    });
    expect(
      fixture.engagements.withWriteTx((transaction) =>
        transaction.createQueuedRun({
          actionId: "action-fixture-1",
          engagementId: created.engagementId,
        }),
      ),
    ).toEqual({ ok: false, error: { code: "run_already_queued" } });
  });

  it("rolls back the queued Run when the Action write transaction aborts", () => {
    const fixture = createFixture();
    const engagement = fixture.engagements.createEngagement({
      name: "Runner fixture lab",
      kind: "lab",
      autoContinueWarnings: false,
    });
    if (!engagement.ok) throw new Error(engagement.error.code);
    expect(() =>
      fixture.engagements.withWriteTx((transaction) => {
        const planned = transaction.persistPlannedAction({
          engagementId: engagement.value.id,
          snapshot: boundSnapshot("action-rolled-back"),
          representable: true,
          capabilityErrorCode: null,
          occurredAt: "2026-08-09T12:00:00.000Z",
        });
        expect(planned).toMatchObject({ ok: true });
        throw new Error("synthetic queue rollback");
      }),
    ).toThrow("synthetic queue rollback");
    expect(
      fixture.database.sqlite
        .prepare("select count(*) as count from runs where action_id = ?")
        .get("action-rolled-back"),
    ).toEqual({ count: 0 });
  });

  it("d2.lease.acquire-once: concurrent acquisition produces one current lease and fence 1", () => {
    const spec = fixtureCase("d2.lease.acquire-once") as {
      given: { runId: string; concurrentAcquirers: number };
      expected: { leasesCreated: number; state: string; fence: number; loserResult: string };
    };
    const fixture = createFixture({
      runId: spec.given.runId,
      leaseIds: ["lease-fixture-1"],
    });
    const created = queuedAction(fixture, "action-fixture-9");
    expect(created.runId).toBe("run:action-fixture-9:1");
    const winner = fixture.runs.acquireLease({
      runId: created.runId,
      runnerId: "runner-fixture-1",
      sessionId: "session-fixture-1",
      serverNow: "2026-08-09T12:00:00.000Z",
    });
    const loser = fixture.runs.acquireLease({
      runId: created.runId,
      runnerId: "runner-fixture-2",
      sessionId: "session-fixture-2",
      serverNow: "2026-08-09T12:00:00.000Z",
    });
    expect(winner).toMatchObject({
      ok: true,
      value: {
        disposition: "acquired",
        run: { state: spec.expected.state, currentFence: String(spec.expected.fence) },
        lease: { fence: String(spec.expected.fence) },
      },
    });
    expect(loser).toEqual({
      ok: false,
      error: { code: spec.expected.loserResult },
    });
    expect(
      fixture.database.sqlite
        .prepare("select count(*) as count from run_leases where run_id = ?")
        .get(created.runId),
    ).toEqual({ count: spec.expected.leasesCreated });
  });

  it("d2.lease.heartbeat-extends-from-server-time: ignores runner wall time", () => {
    const spec = fixtureCase("d2.lease.heartbeat-extends-from-server-time") as {
      given: {
        heartbeatSequence: number;
        serverNow: string;
        runnerReportedNow: string;
      };
      expected: { leaseExpiresAt: string; runnerClockUsed: boolean };
    };
    const fixture = createFixture();
    const created = queuedAction(fixture);
    const acquired = acquire(fixture, created.runId);
    const heartbeated = fixture.runs.heartbeat({
      presented: presentation(acquired.lease),
      heartbeatSequence: spec.given.heartbeatSequence,
      requestDigest: digestA,
      serverNow: spec.given.serverNow,
    });
    expect(heartbeated).toMatchObject({
      ok: true,
      value: {
        ok: true,
        disposition: "accepted",
        heartbeat: { leaseExpiresAt: spec.expected.leaseExpiresAt },
      },
    });
    expect(spec.expected.runnerClockUsed).toBe(false);
    expect(
      Date.parse(spec.given.runnerReportedNow) >
        Date.parse(spec.expected.leaseExpiresAt),
    ).toBe(true);
  });

  it("d2.lease.heartbeat-replay: identical sequence replays stored expiry once", () => {
    const spec = fixtureCase("d2.lease.heartbeat-replay") as {
      given: { heartbeatSequence: number; replayCount: number };
      expected: { result: string; expiryWriteCount: number };
    };
    const fixture = createFixture({
      runId: "run-fixture-2",
      leaseIds: ["lease-fixture-2"],
    });
    const created = queuedAction(fixture, "action-fixture-2");
    const first = acquire(fixture, created.runId);
    for (let sequence = 1; sequence < spec.given.heartbeatSequence; sequence += 1) {
      const prior = fixture.runs.heartbeat({
        presented: presentation(first.lease),
        heartbeatSequence: sequence,
        requestDigest: digestA,
        serverNow: `2026-08-09T12:00:0${sequence}.000Z`,
      });
      if (!prior.ok) throw new Error(prior.error.code);
    }
    const accepted = fixture.runs.heartbeat({
      presented: presentation(first.lease),
      heartbeatSequence: spec.given.heartbeatSequence,
      requestDigest: digestB,
      serverNow: "2026-08-09T12:00:10.000Z",
    });
    if (
      !accepted.ok ||
      accepted.value.ok !== true ||
      accepted.value.disposition !== "accepted"
    ) {
      throw new Error("expected accepted heartbeat");
    }
    expect(accepted.value.expiryWriteCount).toBe(1);
    let replayedExpiry = "";
    for (let replay = 0; replay < spec.given.replayCount; replay += 1) {
      const replayed = fixture.runs.heartbeat({
        presented: presentation(first.lease),
        heartbeatSequence: spec.given.heartbeatSequence,
        requestDigest: digestB,
        serverNow: "2026-08-09T12:00:20.000Z",
      });
      expect(replayed).toMatchObject({
        ok: true,
        value: {
          ok: true,
          disposition: spec.expected.result,
          expiryWriteCount: 0,
        },
      });
      if (replayed.ok && replayed.value.ok && "leaseExpiresAt" in replayed.value) {
        replayedExpiry = replayed.value.leaseExpiresAt;
      }
    }
    expect(replayedExpiry).toBe(accepted.value.heartbeat.leaseExpiresAt);
    expect(
      fixture.database.sqlite
        .prepare(
          "select count(*) as count from run_events where run_id = ? and type = 'heartbeat'",
        )
        .get(created.runId),
    ).toEqual({ count: spec.given.heartbeatSequence });
  });

  it("d2.lease.unstarted-expiry-requeues: leased never-started returns to queued", () => {
    const spec = fixtureCase("d2.lease.unstarted-expiry-requeues") as {
      given: { expiredByMs: number };
      expected: { state: string; event: string; terminal: boolean };
    };
    const fixture = createFixture();
    const created = queuedAction(fixture, "action-fixture-10");
    acquire(fixture, created.runId, { serverNow: "2026-08-09T12:00:00.000Z" });
    const expired = fixture.runs.expireLease({
      runId: created.runId,
      serverNow: "2026-08-09T12:00:30.001Z",
    });
    expect(expired).toMatchObject({
      ok: true,
      value: {
        automaticallyRequeued: true,
        run: { state: spec.expected.state, terminalKind: null },
        event: { type: spec.expected.event },
      },
    });
    expect(spec.expected.terminal).toBe(false);
    expect(
      fixture.engagements.getAction(created.engagementId, "action-fixture-10"),
    ).toMatchObject({
      ok: true,
      value: { action: { state: "queued", runState: null } },
    });
  });

  it("d2.lease.reassignment-increments-fence: new lease id and higher fence", () => {
    const spec = fixtureCase("d2.lease.reassignment-increments-fence") as {
      given: { priorFence: number };
      expected: { newFence: number; state: string; priorLeaseCurrent: boolean };
    };
    const fixture = createFixture({
      runId: "run-fixture-10",
      leaseIds: ["lease-fixture-3", "lease-fixture-4"],
    });
    const created = queuedAction(fixture, "action-fixture-10");
    const first = acquire(fixture, created.runId);
    expect(first.lease.leaseId).toBe("lease-fixture-3");
    fixture.database.sqlite
      .prepare("update runs set current_fence = ? where id = ?")
      .run(String(spec.given.priorFence), created.runId);
    fixture.database.sqlite
      .prepare("update run_leases set fence = ? where lease_id = ?")
      .run(String(spec.given.priorFence), first.lease.leaseId);
    const expired = fixture.runs.expireLease({
      runId: created.runId,
      serverNow: "2026-08-09T12:00:30.001Z",
    });
    if (!expired.ok) throw new Error(expired.error.code);
    const second = acquire(fixture, created.runId);
    expect(second.lease.leaseId).toBe("lease-fixture-4");
    expect(second).toMatchObject({
      run: {
        state: spec.expected.state,
        currentFence: String(spec.expected.newFence),
      },
      lease: { fence: String(spec.expected.newFence) },
    });
    expect(
      fixture.database.sqlite
        .prepare("select current as current from run_leases where lease_id = ?")
        .get("lease-fixture-3"),
    ).toEqual({ current: spec.expected.priorLeaseCurrent ? 1 : 0 });
  });

  it("d2.lease.fencing-exhausted-fails-before-lease: max fence does not wrap", () => {
    const spec = fixtureCase("d2.lease.fencing-exhausted-fails-before-lease") as {
      given: { currentFence: string };
      error: {
        code: string;
        actionState: string;
        runState: string;
        leaseCreated: boolean;
        fenceWrapped: boolean;
        terminalWriteCount: number;
      };
    };
    const fixture = createFixture();
    const created = queuedAction(fixture, "action-fixture-18");
    fixture.database.sqlite
      .prepare("update runs set current_fence = ? where id = ?")
      .run(spec.given.currentFence, created.runId);
    const acquired = fixture.runs.acquireLease({
      runId: created.runId,
      runnerId: "runner-fixture-1",
      sessionId: "session-fixture-1",
      serverNow: "2026-08-09T12:00:00.000Z",
    });
    expect(acquired).toEqual({ ok: false, error: { code: spec.error.code } });
    expect(fixture.runs.getRun(created.runId)).toMatchObject({
      ok: true,
      value: {
        state: spec.error.runState,
        currentFence: spec.given.currentFence,
        terminalKind: "failed",
        terminalReason: "fencing_exhausted",
      },
    });
    expect(
      fixture.engagements.getAction(created.engagementId, "action-fixture-18"),
    ).toMatchObject({
      ok: true,
      value: { action: { state: spec.error.actionState } },
    });
    expect(
      fixture.database.sqlite
        .prepare("select count(*) as count from run_leases where run_id = ?")
        .get(created.runId),
    ).toEqual({ count: spec.error.leaseCreated ? 1 : 0 });
    expect(spec.error.fenceWrapped).toBe(false);
    expect(
      fixture.database.sqlite
        .prepare("select count(*) as count from runs where id = ? and state = 'failed'")
        .get(created.runId),
    ).toEqual({ count: spec.error.terminalWriteCount });
  });

  it("d2.lease.running-expiry-fails: started work is not auto-requeued", () => {
    const spec = fixtureCase("d2.lease.running-expiry-fails") as {
      expected: { state: string; reason: string; automaticallyRequeued: boolean };
    };
    const fixture = createFixture();
    const created = queuedAction(fixture, "action-fixture-11");
    const acquired = acquire(fixture, created.runId);
    startRun(fixture, acquired.lease);
    const expired = fixture.runs.expireLease({
      runId: created.runId,
      serverNow: "2026-08-09T12:00:30.001Z",
    });
    expect(expired).toMatchObject({
      ok: true,
      value: {
        automaticallyRequeued: spec.expected.automaticallyRequeued,
        run: {
          state: spec.expected.state,
          terminalKind: "failed",
          terminalReason: spec.expected.reason,
        },
      },
    });
  });

  it("d2.lease.control-plane-restart-preserves-lease: reopening the db file keeps the lease current", () => {
    const spec = fixtureCase("d2.lease.control-plane-restart-preserves-lease") as {
      given: { leaseId: string; fence: number; expiresAt: string; sessionId: string };
      expected: {
        leaseCurrent: boolean;
        fenceChanged: boolean;
        resumeHeartbeatAllowed: boolean;
      };
    };
    const fixture = createFixture({
      runId: "run-fixture-5",
      leaseIds: [spec.given.leaseId],
    });
    const created = queuedAction(fixture, "action-fixture-5");
    const acquired = acquire(fixture, created.runId, {
      sessionId: spec.given.sessionId,
    });
    fixture.database.sqlite
      .prepare("update runs set current_fence = ? where id = ?")
      .run(String(spec.given.fence), created.runId);
    fixture.database.sqlite
      .prepare("update run_leases set fence = ?, expires_at = ? where lease_id = ?")
      .run(String(spec.given.fence), spec.given.expiresAt, acquired.lease.leaseId);
    fixture.database.close();
    fixture.database = openEngagementDatabase({ dataDirectory: fixture.directory });
    const restarted = new RunRepository(fixture.database.db);
    const lease = restarted.getCurrentLease(created.runId);
    expect(lease).toMatchObject({
      ok: true,
      value: {
        leaseId: spec.given.leaseId,
        fence: String(spec.given.fence),
        sessionId: spec.given.sessionId,
        expiresAt: spec.given.expiresAt,
      },
    });
    expect(spec.expected.leaseCurrent).toBe(true);
    expect(spec.expected.fenceChanged).toBe(false);
    const heartbeated = restarted.heartbeat({
      presented: {
        runId: created.runId,
        leaseId: spec.given.leaseId,
        runnerId: "runner-fixture-1",
        sessionId: spec.given.sessionId,
        fence: String(spec.given.fence),
      },
      heartbeatSequence: 1,
      requestDigest: digestA,
      serverNow: "2026-08-09T12:00:30.000Z",
    });
    expect(heartbeated.ok).toBe(spec.expected.resumeHeartbeatAllowed);
  });

  it("d2.lease.stale-fence-rejected: superseded fence cannot append", () => {
    const spec = fixtureCase("d2.lease.stale-fence-rejected") as {
      given: { presentedFence: number; currentFence: number; sequence: number };
      error: { code: string; eventAppendCount: number; stateChanged: boolean };
    };
    const fixture = createFixture();
    const created = queuedAction(fixture, "action-fixture-12");
    const acquired = acquire(fixture, created.runId);
    fixture.database.sqlite
      .prepare("update runs set current_fence = ? where id = ?")
      .run(String(spec.given.currentFence), created.runId);
    fixture.database.sqlite
      .prepare("update run_leases set fence = ? where lease_id = ?")
      .run(String(spec.given.currentFence), acquired.lease.leaseId);
    const before = fixture.runs.listEvents(created.runId);
    const appended = fixture.runs.appendEvent({
      presented: presentation(acquired.lease, String(spec.given.presentedFence)),
      sequence: spec.given.sequence,
      type: "started",
      digest: digestA,
      serverNow: "2026-08-09T12:00:05.000Z",
    });
    expect(appended).toMatchObject({
      ok: false,
      error: { code: spec.error.code },
    });
    expect(fixture.runs.listEvents(created.runId)).toEqual(before);
    expect(fixture.runs.getRun(created.runId)).toMatchObject({
      ok: true,
      value: { state: "leased" },
    });
  });

  it("d2.lease.expired-append-rejected: expired current fence cannot append", () => {
    const spec = fixtureCase("d2.lease.expired-append-rejected") as {
      given: { sequence: number };
      error: { code: string; eventAppendCount: number; stateChanged: boolean };
    };
    const fixture = createFixture();
    const created = queuedAction(fixture, "action-fixture-13");
    const acquired = acquire(fixture, created.runId);
    const before = fixture.runs.listEvents(created.runId);
    const appended = fixture.runs.appendEvent({
      presented: presentation(acquired.lease),
      sequence: spec.given.sequence,
      type: "started",
      digest: digestA,
      serverNow: "2026-08-09T12:00:30.001Z",
    });
    expect(appended).toMatchObject({
      ok: false,
      error: { code: spec.error.code },
    });
    expect(fixture.runs.listEvents(created.runId)).toEqual(before);
    expect(fixture.runs.getRun(created.runId)).toMatchObject({
      ok: true,
      value: { state: "leased" },
    });
  });

  it("d2.lease.owner-mismatch-rejected: another runner or session cannot mutate", () => {
    const spec = fixtureCase("d2.lease.owner-mismatch-rejected") as {
      given: {
        currentRunnerId: string;
        presentedRunnerId: string;
        currentSessionId: string;
        presentedSessionId: string;
        sequence: number;
      };
      error: {
        code: string;
        eventAppendCount: number;
        stateChanged: boolean;
        presentedRunnerCleanupRequired: boolean;
      };
    };
    const fixture = createFixture();
    const created = queuedAction(fixture, "action-fixture-34");
    const acquired = acquire(fixture, created.runId, {
      runnerId: spec.given.currentRunnerId,
      sessionId: spec.given.currentSessionId,
    });
    const before = fixture.runs.listEvents(created.runId);
    const appended = fixture.runs.appendEvent({
      presented: {
        ...presentation(acquired.lease),
        runnerId: spec.given.presentedRunnerId,
        sessionId: spec.given.presentedSessionId,
      },
      sequence: spec.given.sequence,
      type: "started",
      digest: digestA,
      serverNow: "2026-08-09T12:00:05.000Z",
    });
    expect(appended).toEqual({
      ok: false,
      error: {
        code: spec.error.code,
        presentedRunnerCleanupRequired: spec.error.presentedRunnerCleanupRequired,
      },
    });
    expect(fixture.runs.listEvents(created.runId)).toEqual(before);
    expect(fixture.runs.getRun(created.runId)).toMatchObject({
      ok: true,
      value: { state: "leased" },
    });
  });

  it("expires cancel_requested and paused running leases without auto-requeue", () => {
    const fixture = createFixture();
    const cancelCase = queuedAction(fixture, "action-fixture-19");
    acquire(fixture, cancelCase.runId);
    fixture.database.sqlite
      .prepare("update runs set state = 'cancel_requested' where id = ?")
      .run(cancelCase.runId);
    const cancelExpired = fixture.runs.expireLease({
      runId: cancelCase.runId,
      serverNow: "2026-08-09T12:00:30.001Z",
    });
    expect(cancelExpired).toMatchObject({
      ok: true,
      value: {
        automaticallyRequeued: false,
        run: { state: "failed", terminalReason: "runner_lost_during_cancel" },
      },
    });

    const paused = queuedAction(fixture, "action-fixture-16");
    const acquired = acquire(fixture, paused.runId);
    startRun(fixture, acquired.lease);
    fixture.database.sqlite
      .prepare("update actions set state = 'active_paused_for_warning' where id = ?")
      .run("action-fixture-16");
    const pausedExpired = fixture.runs.expireLease({
      runId: paused.runId,
      serverNow: "2026-08-09T12:00:30.001Z",
    });
    expect(pausedExpired).toMatchObject({
      ok: true,
      value: {
        automaticallyRequeued: false,
        run: { state: "failed", terminalReason: "runner_lost" },
      },
    });
  });

  it("replays identical runner events, rejects digest conflicts and sequence gaps", () => {
    const fixture = createFixture();
    const created = queuedAction(fixture, "action-fixture-14");
    const acquired = acquire(fixture, created.runId);
    const first = fixture.runs.appendEvent({
      presented: presentation(acquired.lease),
      sequence: 1,
      type: "started",
      digest: digestC,
      payload: { started: true },
      serverNow: "2026-08-09T12:00:05.000Z",
    });
    expect(first).toMatchObject({
      ok: true,
      value: { disposition: "accepted_event" },
    });
    const replayed = fixture.runs.appendEvent({
      presented: presentation(acquired.lease),
      sequence: 1,
      type: "started",
      digest: digestC,
      payload: { started: true },
      serverNow: "2026-08-09T12:00:06.000Z",
    });
    expect(replayed).toMatchObject({
      ok: true,
      value: { disposition: "stored_event_replayed" },
    });
    expect(
      fixture.runs.appendEvent({
        presented: presentation(acquired.lease),
        sequence: 1,
        type: "started",
        digest: digestB,
        payload: { started: false },
        serverNow: "2026-08-09T12:00:07.000Z",
      }),
    ).toEqual({ ok: false, error: { code: "event_replay_conflict" } });
    expect(
      fixture.runs.appendEvent({
        presented: presentation(acquired.lease),
        sequence: 3,
        type: "started",
        digest: digestA,
        serverNow: "2026-08-09T12:00:08.000Z",
      }),
    ).toEqual({
      ok: false,
      error: { code: "event_sequence_gap", expectedSequence: 2 },
    });
  });

  it("shares completion with the per-fence event sequence and CAS terminal once", () => {
    const fixture = createFixture();
    const created = queuedAction(fixture, "action-fixture-17");
    const acquired = acquire(fixture, created.runId);
    startRun(fixture, acquired.lease, 1);
    fixture.runs.heartbeat({
      presented: presentation(acquired.lease),
      heartbeatSequence: 1,
      requestDigest: digestA,
      serverNow: "2026-08-09T12:00:10.000Z",
    });
    const completed = fixture.runs.completeRun({
      presented: presentation(acquired.lease),
      sequence: 2,
      terminalKind: "succeeded",
      reason: null,
      digest: digestB,
      serverNow: "2026-08-09T12:00:12.000Z",
    });
    expect(completed).toMatchObject({
      ok: true,
      value: { disposition: "accepted_completion" },
    });
    expect(fixture.runs.getCurrentLease(created.runId).ok).toBe(false);
    const replayed = fixture.runs.completeRun({
      presented: presentation(acquired.lease),
      sequence: 2,
      terminalKind: "succeeded",
      reason: null,
      digest: digestB,
      serverNow: "2026-08-09T12:00:13.000Z",
    });
    expect(replayed).toMatchObject({
      ok: true,
      value: { disposition: "stored_terminal_replayed" },
    });
    expect(
      fixture.runs.completeRun({
        presented: presentation(acquired.lease),
        sequence: 2,
        terminalKind: "failed",
        reason: "runner_lost",
        digest: digestA,
        serverNow: "2026-08-09T12:00:14.000Z",
      }),
    ).toEqual({ ok: false, error: { code: "run_already_terminal" } });
    expect(
      fixture.database.sqlite
        .prepare(
          "select latest_event_sequence as sequence, latest_heartbeat_sequence as heartbeat from run_leases where lease_id = ?",
        )
        .get(acquired.lease.leaseId),
    ).toEqual({ sequence: 2, heartbeat: 1 });
    const replayedWithoutSequence = fixture.runs.completeRun({
      presented: presentation(acquired.lease),
      terminalKind: "succeeded",
      reason: null,
      digest: digestB,
      serverNow: "2026-08-09T12:00:40.000Z",
    });
    expect(replayedWithoutSequence).toMatchObject({
      ok: true,
      value: {
        disposition: "stored_terminal_replayed",
        event: { type: "succeeded", sequence: 2 },
      },
    });
  });

  it("retry allocates attempt N+1 and does not mutate prior terminal rows", () => {
    const fixture = createFixture({
      runId: "run-fixture-1",
      leaseIds: ["lease-fixture-1"],
    });
    const created = queuedAction(fixture, "action-fixture-3");
    const acquired = acquire(fixture, created.runId);
    startRun(fixture, acquired.lease);
    const failed = fixture.runs.completeRun({
      presented: presentation(acquired.lease),
      sequence: 2,
      terminalKind: "failed",
      reason: "runner_lost",
      digest: digestB,
      serverNow: "2026-08-09T12:00:12.000Z",
    });
    if (!failed.ok) throw new Error(failed.error.code);
    const prior = fixture.database.sqlite
      .prepare(
        "select id, attempt, state, terminal_kind, terminal_reason, updated_at from runs where id = ?",
      )
      .get(created.runId);
    const retried = fixture.engagements.withWriteTx((transaction) =>
      transaction.retryRun({ actionId: "action-fixture-3" }),
    );
    expect(retried).toMatchObject({
      ok: true,
      value: { attempt: 2, state: "queued", currentFence: "0" },
    });
    expect(
      fixture.database.sqlite
        .prepare(
          "select id, attempt, state, terminal_kind, terminal_reason, updated_at from runs where id = ?",
        )
        .get(created.runId),
    ).toEqual(prior);
    expect(
      fixture.engagements.getAction(created.engagementId, "action-fixture-3"),
    ).toMatchObject({
      ok: true,
      value: { action: { state: "queued", queuedSnapshotVersion: 1 } },
    });
  });
});

describe("run persistence adversarial checks", () => {
  it("rejects stale fence, expired lease, and owner mismatch without appending", () => {
    const fixture = createFixture();
    const created = queuedAction(fixture, "action-adversarial");
    const acquired = acquire(fixture, created.runId);
    const before = (
      fixture.database.sqlite
        .prepare("select count(*) as count from run_events where run_id = ?")
        .get(created.runId) as { count: number }
    ).count;

    expect(
      fixture.runs.appendEvent({
        presented: presentation(acquired.lease, "9"),
        sequence: 1,
        type: "started",
        digest: digestA,
        serverNow: "2026-08-09T12:00:05.000Z",
      }),
    ).toMatchObject({ ok: false, error: { code: "stale_fence" } });
    expect(
      fixture.runs.appendEvent({
        presented: presentation(acquired.lease),
        sequence: 1,
        type: "started",
        digest: digestA,
        serverNow: "2026-08-09T12:00:30.000Z",
      }),
    ).toMatchObject({ ok: false, error: { code: "lease_expired" } });
    expect(
      fixture.runs.appendEvent({
        presented: {
          ...presentation(acquired.lease),
          runnerId: "runner-fixture-2",
        },
        sequence: 1,
        type: "started",
        digest: digestA,
        serverNow: "2026-08-09T12:00:05.000Z",
      }),
    ).toMatchObject({ ok: false, error: { code: "lease_owner_mismatch" } });
    expect(
      fixture.database.sqlite
        .prepare("select count(*) as count from run_events where run_id = ?")
        .get(created.runId),
    ).toEqual({ count: before });
  });

  it("does not wrap the signed 64-bit fence at its maximum value", () => {
    const fixture = createFixture();
    const created = queuedAction(fixture, "action-fence-max");
    fixture.database.sqlite
      .prepare("update runs set current_fence = ? where id = ?")
      .run("9223372036854775807", created.runId);
    expect(
      fixture.runs.acquireLease({
        runId: created.runId,
        runnerId: "runner-fixture-1",
        sessionId: "session-fixture-1",
        serverNow: "2026-08-09T12:00:00.000Z",
      }),
    ).toEqual({ ok: false, error: { code: "fencing_exhausted" } });
    expect(fixture.runs.getRun(created.runId)).toMatchObject({
      ok: true,
      value: { currentFence: "9223372036854775807", state: "failed" },
    });
  });

  it("enforces one current lease per run at the unique index", () => {
    const fixture = createFixture({
      runId: "run-fixture-unique",
      leaseIds: ["lease-fixture-1"],
    });
    const created = queuedAction(fixture, "action-unique-lease");
    acquire(fixture, created.runId);
    expect(() =>
      fixture.database.sqlite
        .prepare(
          `insert into run_leases (
            lease_id, contract_version, run_id, runner_id, session_id, fence,
            expires_at, latest_heartbeat_sequence, latest_event_sequence, current, created_at
          ) values (?, 1, ?, 'runner-fixture-2', 'session-fixture-2', '2',
            '2026-08-09T12:01:00.000Z', 0, 0, 1, '2026-08-09T12:00:00.000Z')`,
        )
        .run("lease-fixture-conflict", created.runId),
    ).toThrow(/UNIQUE|unique/i);
  });

  it("serializes competing processes into one lease and one no_work", async () => {
    const fixture = createFixture();
    const created = queuedAction(fixture, "action-concurrent");
    fixture.database.close();
    const goPath = path.join(fixture.directory, "go");
    const workers = [0, 1].map((index) => {
      const readyPath = path.join(fixture.directory, `ready-${index}`);
      const resultPath = path.join(fixture.directory, `result-${index}.json`);
      const child = spawn(
        "pnpm",
        ["exec", "vitest", "run", "src/run-concurrency-process.test.ts", "--reporter=dot"],
        {
          cwd: path.resolve(import.meta.dirname, ".."),
          env: {
            ...process.env,
            FORCE_COLOR: "0",
            STONEHUSH_RUN_CONCURRENCY_DATA_DIRECTORY: fixture.directory,
            STONEHUSH_RUN_CONCURRENCY_RUN_ID: created.runId,
            STONEHUSH_RUN_CONCURRENCY_RUNNER_ID: `runner-fixture-${index + 1}`,
            STONEHUSH_RUN_CONCURRENCY_SESSION_ID: `session-fixture-${index + 1}`,
            STONEHUSH_RUN_CONCURRENCY_READY_PATH: readyPath,
            STONEHUSH_RUN_CONCURRENCY_GO_PATH: goPath,
            STONEHUSH_RUN_CONCURRENCY_RESULT_PATH: resultPath,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      return { child, readyPath, resultPath, output: () => ({ stdout, stderr }) };
    });
    const deadline = Date.now() + 15_000;
    while (!workers.every(({ readyPath }) => existsSync(readyPath))) {
      const failedWorker = workers.find(({ child }) => child.exitCode !== null);
      if (failedWorker !== undefined) {
        throw new Error(
          `Worker exited ${failedWorker.child.exitCode} before the barrier: ${JSON.stringify(failedWorker.output())}`,
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Workers did not reach the barrier: ${JSON.stringify(workers.map(({ output }) => output()))}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    writeFileSync(goPath, "go", { mode: 0o600 });
    const results = await Promise.all(
      workers.map(
        ({ child, resultPath, output }) =>
          new Promise<unknown>((resolve, reject) => {
            child.once("exit", (code) => {
              if (code !== 0) {
                reject(
                  new Error(`Worker failed (${code}): ${JSON.stringify(output())}`),
                );
                return;
              }
              resolve(JSON.parse(readFileSync(resultPath, "utf8")));
            });
          }),
      ),
    );
    const dispositions = results.map((result) => {
      if (
        typeof result === "object" &&
        result !== null &&
        "ok" in result &&
        result.ok === true
      ) {
        return "acquired";
      }
      if (
        typeof result === "object" &&
        result !== null &&
        "error" in result &&
        typeof result.error === "object" &&
        result.error !== null &&
        "code" in result.error
      ) {
        return result.error.code;
      }
      return result;
    });
    expect(dispositions.sort()).toEqual(["acquired", "no_work"]);
  });

  it("serializes a second in-process acquirer as no_work", () => {
    const fixture = createFixture();
    const created = queuedAction(fixture, "action-serialized");
    const first = fixture.runs.acquireLease({
      runId: created.runId,
      runnerId: "runner-fixture-1",
      sessionId: "session-fixture-1",
      serverNow: "2026-08-09T12:00:00.000Z",
    });
    const second = fixture.runs.acquireLease({
      runId: created.runId,
      runnerId: "runner-fixture-1",
      sessionId: "session-fixture-1",
      serverNow: "2026-08-09T12:00:00.000Z",
    });
    expect(first).toMatchObject({ ok: true, value: { disposition: "acquired" } });
    expect(second).toEqual({ ok: false, error: { code: "no_work" } });
  });

  it("replays a stored started event after the lease expires", () => {
    const fixture = createFixture();
    const created = queuedAction(fixture, "action-replay-after-expiry");
    const acquired = acquire(fixture, created.runId);
    const first = startRun(fixture, acquired.lease);
    const replayed = fixture.runs.appendEvent({
      presented: presentation(acquired.lease),
      sequence: 1,
      type: "started",
      payload: { started: true },
      digest: digestA,
      serverNow: "2026-08-09T12:00:30.001Z",
    });
    expect(replayed).toMatchObject({
      ok: true,
      value: {
        disposition: "stored_event_replayed",
        event: { eventId: first.event.eventId, type: "started" },
      },
    });
  });

  it("rejects a control-plane completion sequence gap and a succeeded reason", () => {
    const fixture = createFixture();
    const created = queuedAction(fixture, "action-control-complete");
    const acquired = acquire(fixture, created.runId);
    startRun(fixture, acquired.lease);
    expect(
      fixture.runs.completeRun({
        presented: null,
        runId: created.runId,
        sequence: 9,
        terminalKind: "failed",
        reason: "runner_lost",
        digest: digestB,
        serverNow: "2026-08-09T12:00:12.000Z",
      }),
    ).toEqual({
      ok: false,
      error: { code: "event_sequence_gap", expectedSequence: 2 },
    });
    expect(
      fixture.runs.completeRun({
        presented: presentation(acquired.lease),
        sequence: 2,
        terminalKind: "succeeded",
        reason: "suspicious",
        digest: digestB,
        serverNow: "2026-08-09T12:00:12.000Z",
      }),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
  });

  it("rejects a succeeded Action retry and keeps the terminal Run untouched", () => {
    const fixture = createFixture();
    const created = queuedAction(fixture, "action-succeeded");
    const acquired = acquire(fixture, created.runId);
    startRun(fixture, acquired.lease);
    const completed = fixture.runs.completeRun({
      presented: presentation(acquired.lease),
      sequence: 2,
      terminalKind: "succeeded",
      reason: null,
      digest: digestB,
      serverNow: "2026-08-09T12:00:12.000Z",
    });
    if (!completed.ok) throw new Error(completed.error.code);
    expect(fixture.runs.retryRun({ actionId: "action-succeeded" })).toEqual({
      ok: false,
      error: { code: "run_not_retryable" },
    });
  });
});

describe("run persistence schema", () => {
  it("applies 0005 and keeps run events append-only", () => {
    const fixture = createFixture();
    const created = queuedAction(fixture, "action-schema");
    acquire(fixture, created.runId);
    expect(
      fixture.database.sqlite
        .prepare("select count(*) as count from __drizzle_migrations")
        .get(),
    ).toEqual({ count: DATABASE_SCHEMA_VERSION });
    const evidenceTable = fixture.database.sqlite
      .prepare(
        "select count(*) as count from sqlite_master where type = 'table' and name = 'evidence_grants'",
      )
      .get() as { count: number };
    expect(evidenceTable).toEqual({ count: 1 });
    expect(() =>
      fixture.database.sqlite.prepare("update run_events set sequence = 99").run(),
    ).toThrow("run events are immutable");
    expect(() =>
      fixture.database.sqlite.prepare("delete from run_events").run(),
    ).toThrow("run events are immutable");
    expect(path.basename(path.join(fixture.directory, DATABASE_FILENAME))).toBe(
      DATABASE_FILENAME,
    );
  });
});
