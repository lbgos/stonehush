import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ActionSnapshot, RunnerLease } from "@stonehush/contracts";
import { EVIDENCE_QUOTA_DEFAULTS } from "@stonehush/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { bindActionSnapshot } from "./action-snapshot.js";
import { openEngagementDatabase } from "./database.js";
import { EvidenceGrantRepository } from "./evidence-grant.js";
import { EngagementRepository } from "./repository.js";
import { RunRepository } from "./run.js";

const digestA = `sha256:${"a".repeat(64)}`;

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface Fixture {
  readonly directory: string;
  readonly database: ReturnType<typeof openEngagementDatabase>;
  readonly engagements: EngagementRepository;
  readonly runs: RunRepository;
  readonly grants: EvidenceGrantRepository;
  setNow(value: string): void;
}

const fixtures: Fixture[] = [];

function createFixture(
  options: {
    grantIds?: readonly string[];
    quota?: unknown;
  } = {},
): Fixture {
  const directory = mkdtempSync(path.join(tmpdir(), "stonehush-evidence-grant-"));
  chmodSync(directory, 0o700);
  const database = openEngagementDatabase({ dataDirectory: directory });
  try {
    let engagementSeq = 0;
    let leaseSeq = 0;
    let grantSeq = 0;
    let now = new Date("2026-08-09T12:00:00.000Z");
    const engagements = new EngagementRepository(database.db, {
      createId: () =>
        `10000000-0000-4000-8000-${String(++engagementSeq).padStart(12, "0")}`,
      now: () => new Date(now),
    });
    const runs = new RunRepository(database.db, {
      createId: () => `lease-fixture-${++leaseSeq}`,
      now: () => new Date(now),
    });
    const grants = new EvidenceGrantRepository(
      database.db,
      options.grantIds === undefined
        ? { ...(options.quota === undefined ? {} : { quota: options.quota }) }
        : {
            createId: () => {
              const id = options.grantIds?.[grantSeq];
              grantSeq += 1;
              return id ?? `${String(grantSeq).padStart(12, "0")}aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`;
            },
            ...(options.quota === undefined ? {} : { quota: options.quota }),
          },
    );
    const fixture: Fixture = {
      directory,
      database,
      engagements,
      runs,
      grants,
      setNow(value: string) {
        now = new Date(value);
      },
    };
    fixtures.push(fixture);
    return fixture;
  } catch (error) {
    if (database.sqlite.open) database.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
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
  if (!bound.ok) throw new Error(bound.error.code);
  return { ...snapshot, binding: bound.binding };
}

function queuedRun(
  fixture: Fixture,
  actionId = "action-fixture-1",
): string {
  const engagement = fixture.engagements.createEngagement({
    name: "Evidence grant fixture lab",
    kind: "lab",
    description: null,
    authorizationContext: "Synthetic fixture authorization context",
    autoContinueWarnings: false,
  });
  if (!engagement.ok) throw new Error(engagement.error.code);
  const planned = fixture.engagements.persistPlannedAction({
    engagementId: engagement.value.id,
    snapshot: boundSnapshot(actionId),
    representable: true,
    capabilityErrorCode: null,
    occurredAt: "2026-08-09T12:00:00.000Z",
  });
  if (!planned.ok) throw new Error(planned.error.code);
  const row = fixture.database.sqlite
    .prepare("select id from runs where action_id = ?")
    .get(actionId) as { id: string } | undefined;
  if (row === undefined) throw new Error("queued run missing");
  return row.id;
}

function acquire(
  fixture: Fixture,
  runId: string,
  overrides: {
    runnerId?: string;
    sessionId?: string;
    serverNow?: string;
  } = {},
): RunnerLease {
  const runnerId = overrides.runnerId ?? "runner-fixture-1";
  const sessionId = overrides.sessionId ?? `session-${runnerId}`;
  const acquired = fixture.runs.acquireLease({
    runId,
    runnerId,
    sessionId,
    serverNow: overrides.serverNow ?? "2026-08-09T12:00:00.000Z",
  });
  if (!acquired.ok) throw new Error(acquired.error.code);
  return acquired.value.lease;
}

function grantInput(
  lease: RunnerLease,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    runId: lease.runId,
    leaseId: lease.leaseId,
    sessionId: lease.sessionId,
    fence: lease.fence,
    eventSequence: 1,
    artifactSlot: "stdout",
    kind: "stdout",
    runnerId: lease.runnerId,
    serverNow: "2026-08-09T12:00:01.000Z",
    ...overrides,
  };
}

function grantRow(fixture: Fixture, artifactId: string) {
  return fixture.database.sqlite
    .prepare("select * from evidence_grants where artifact_id = ?")
    .get(artifactId) as Record<string, unknown> | undefined;
}

function engagementIdForRun(fixture: Fixture, runId: string): string {
  const row = fixture.database.sqlite
    .prepare("select engagement_id from runs where id = ?")
    .get(runId) as { engagement_id: string };
  return row.engagement_id;
}

function publishArtifact(
  fixture: Fixture,
  artifactId: string,
  runId: string,
): void {
  fixture.database.sqlite
    .prepare(
      "insert into evidence_artifacts (contract_version, profile, artifact_id, run_id, fence, event_sequence, artifact_slot, kind, size_bytes, digest, relative_path, completeness, redaction_applied, redaction_boundary, raw_bytes_preserved, created_at) " +
        "values (1, 'd3-v1', ?, ?, '1', 1, 'stdout', 'stdout', 5, ?, ?, 'complete', 1, 'runner_stream', 0, 't')",
    )
    .run(
      artifactId,
      runId,
      `sha256:${"b".repeat(64)}`,
      `published/${artifactId}`,
    );
}

function latestEventSequence(fixture: Fixture, leaseId: string): number {
  const row = fixture.database.sqlite
    .prepare("select latest_event_sequence from run_leases where lease_id = ?")
    .get(leaseId) as { latest_event_sequence: number };
  return row.latest_event_sequence;
}

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture === undefined) continue;
    if (fixture.database.sqlite.open) fixture.database.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

describe("evidence grant admission", () => {
  it("admits a current lease grant with control-plane generated UUIDv4 IDs and a full reservation", () => {
    const fixture = createFixture();
    const runId = queuedRun(fixture);
    const lease = acquire(fixture, runId);
    const result = fixture.grants.createGrant(
      grantInput(lease, { declaredSizeBytes: 128 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.artifactId).toMatch(UUID_V4_PATTERN);
    expect(result.value.uploadId).toMatch(UUID_V4_PATTERN);
    expect(result.value.declaredSizeBytes).toBe(128);
    const row = grantRow(fixture, result.value.artifactId);
    expect(row).toBeDefined();
    expect(row?.state).toBe("in_progress");
    expect(row?.contract_version).toBe(1);
    expect(row?.profile).toBe("d3-v1");
    expect(row?.reservation_bytes).toBe(EVIDENCE_QUOTA_DEFAULTS.perArtifactBytes);
    expect(row?.put_finalized).toBe(0);
    expect(row?.accepted_bytes).toBe(0);
    expect(row?.original_file_name).toBeNull();
  });

  it("binds latestEventSequence+1 without consuming the cursor", () => {
    const fixture = createFixture();
    const runId = queuedRun(fixture);
    const lease = acquire(fixture, runId);
    const first = fixture.grants.createGrant(
      grantInput(lease, { artifactSlot: "slot-a" }),
    );
    expect(first.ok).toBe(true);
    expect(latestEventSequence(fixture, lease.leaseId)).toBe(0);
    // A distinct slot may bind the same next sequence.
    const second = fixture.grants.createGrant(
      grantInput(lease, { artifactSlot: "tool-raw", kind: "tool_raw" }),
    );
    expect(second.ok).toBe(true);
    expect(latestEventSequence(fixture, lease.leaseId)).toBe(0);
    // The cursor never moved, so the expected sequence stays 1.
    const third = fixture.grants.createGrant(
      grantInput(lease, { artifactSlot: "slot-c", eventSequence: 2 }),
    );
    expect(third).toEqual({
      ok: false,
      error: { code: "event_sequence_gap", expectedSequence: 1 },
    });
  });

  it("returns artifact_upload_in_progress for a duplicate in-flight identity", () => {
    const fixture = createFixture();
    const runId = queuedRun(fixture);
    const lease = acquire(fixture, runId);
    const first = fixture.grants.createGrant(grantInput(lease));
    expect(first.ok).toBe(true);
    const second = fixture.grants.createGrant(grantInput(lease));
    expect(second).toEqual({ ok: false, error: { code: "artifact_upload_in_progress" } });
    const count = fixture.database.sqlite
      .prepare("select count(*) as c from evidence_grants")
      .get() as { c: number };
    expect(count.c).toBe(1);
  });

  it("fails closed on stale fence, wrong session owner, other runner identity, and expired lease", () => {
    const fixture = createFixture();
    const runId = queuedRun(fixture);
    const lease = acquire(fixture, runId);
    expect(
      fixture.grants.createGrant(grantInput(lease, { fence: "99" })),
    ).toEqual({ ok: false, error: { code: "stale_fence" } });
    expect(
      fixture.grants.createGrant(
        grantInput(lease, { sessionId: "session-imposter" }),
      ),
    ).toEqual({ ok: false, error: { code: "lease_owner_mismatch" } });
    expect(
      fixture.grants.createGrant({ ...grantInput(lease), runnerId: "runner-other" }),
    ).toEqual({ ok: false, error: { code: "lease_owner_mismatch" } });
    expect(
      fixture.grants.createGrant(grantInput(lease, { leaseId: "lease-other" })),
    ).toEqual({ ok: false, error: { code: "stale_fence" } });
    fixture.setNow("2026-08-09T12:01:00.000Z");
    expect(
      fixture.grants.createGrant({
        ...grantInput(lease),
        serverNow: "2026-08-09T12:01:00.000Z",
      }),
    ).toEqual({ ok: false, error: { code: "lease_expired" } });
  });

  it("rejects grants against a terminal run", () => {
    const fixture = createFixture();
    const runId = queuedRun(fixture);
    const lease = acquire(fixture, runId);
    const started = fixture.runs.appendEvent({
      presented: {
        runId: lease.runId,
        leaseId: lease.leaseId,
        runnerId: lease.runnerId,
        sessionId: lease.sessionId,
        fence: lease.fence,
      },
      sequence: 1,
      type: "started",
      serverNow: "2026-08-09T12:00:05.000Z",
    });
    expect(started.ok).toBe(true);
    const completed = fixture.runs.completeRun({
      presented: {
        runId: lease.runId,
        leaseId: lease.leaseId,
        runnerId: lease.runnerId,
        sessionId: lease.sessionId,
        fence: lease.fence,
      },
      sequence: 2,
      terminalKind: "succeeded",
      reason: null,
      serverNow: "2026-08-09T12:00:10.000Z",
    });
    expect(completed.ok).toBe(true);
    const grant = fixture.grants.createGrant(
      grantInput(lease, { eventSequence: 3, serverNow: "2026-08-09T12:00:11.000Z" }),
    );
    expect(grant).toEqual({ ok: false, error: { code: "run_already_terminal" } });
  });

  it("rejects declared sizes above perArtifact but never lowers the reservation for smaller declarations", () => {
    const fixture = createFixture();
    const runId = queuedRun(fixture);
    const lease = acquire(fixture, runId);
    expect(
      fixture.grants.createGrant(
        grantInput(lease, {
          declaredSizeBytes: EVIDENCE_QUOTA_DEFAULTS.perArtifactBytes + 1,
        }),
      ),
    ).toEqual({ ok: false, error: { code: "artifact_quota_exceeded" } });
    const small = fixture.grants.createGrant(
      grantInput(lease, { declaredSizeBytes: 5 }),
    );
    expect(small.ok).toBe(true);
    if (!small.ok) throw new Error("unreachable");
    expect(grantRow(fixture, small.value.artifactId)?.reservation_bytes).toBe(
      EVIDENCE_QUOTA_DEFAULTS.perArtifactBytes,
    );
  });

  it("checks concurrent uploads before staging headroom", () => {
    const quota = {
      perArtifactBytes: 65_536,
      perRunPublishedBytes: 4_294_967_296,
      totalPublishedBytes: 1_073_741_824,
      maxInFlightStagingBytes: 196_608,
      maxConcurrentUploadsPerRunner: 2,
    };
    const fixture = createFixture({ quota });
    const run1 = queuedRun(fixture, "action-fixture-1");
    const run2 = queuedRun(fixture, "action-fixture-2");
    const run3 = queuedRun(fixture, "action-fixture-3");
    const leaseR1 = acquire(fixture, run1, { runnerId: "runner-r1" });
    const leaseR2 = acquire(fixture, run2, { runnerId: "runner-r2" });
    const leaseR3 = acquire(fixture, run3, { runnerId: "runner-r3" });
    expect(fixture.grants.createGrant(grantInput(leaseR1, { artifactSlot: "a" })).ok).toBe(
      true,
    );
    expect(fixture.grants.createGrant(grantInput(leaseR1, { artifactSlot: "b" })).ok).toBe(
      true,
    );
    expect(fixture.grants.createGrant(grantInput(leaseR2, { artifactSlot: "a" })).ok).toBe(
      true,
    );
    // Staging is now exhausted and runner-r1 is also at its concurrent cap:
    // the cap is evaluated first.
    expect(
      fixture.grants.createGrant(grantInput(leaseR1, { artifactSlot: "c" })),
    ).toEqual({ ok: false, error: { code: "concurrent_upload_limit" } });
    // A runner below its cap still hits the staging refusal next.
    expect(
      fixture.grants.createGrant(grantInput(leaseR3, { artifactSlot: "a" })),
    ).toEqual({ ok: false, error: { code: "staging_quota_exceeded" } });
  });

  it("rejects when the full reservation exceeds per-run published+reservation headroom", () => {
    const quota = {
      perArtifactBytes: 1_048_576,
      perRunPublishedBytes: 1_572_864,
      totalPublishedBytes: 1_073_741_824,
      maxInFlightStagingBytes: 268_435_456,
      maxConcurrentUploadsPerRunner: 8,
    };
    const fixture = createFixture({ quota });
    const run1 = queuedRun(fixture, "action-fixture-1");
    const run2 = queuedRun(fixture, "action-fixture-2");
    const lease1 = acquire(fixture, run1);
    const lease2 = acquire(fixture, run2);
    const first = fixture.grants.createGrant(grantInput(lease1, { artifactSlot: "a" }));
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    // The reservation is the full per-artifact amount even though only 1.5 MiB
    // of run headroom remains; a tiny declaration does not lower it.
    expect(grantRow(fixture, first.value.artifactId)?.reservation_bytes).toBe(1_048_576);
    // Run/total never clamp the reservation: published (0) plus in-flight
    // (1 MiB) plus the full new reservation (1 MiB) would exceed the 1.5 MiB
    // per-run quota, so admission refuses instead of creating a smaller grant.
    expect(
      fixture.grants.createGrant(
        grantInput(lease1, { artifactSlot: "b", declaredSizeBytes: 1 }),
      ),
    ).toEqual({ ok: false, error: { code: "run_quota_exceeded" } });
    // Another run still has its own full headroom.
    const otherRun = fixture.grants.createGrant(grantInput(lease2, { artifactSlot: "a" }));
    expect(otherRun.ok).toBe(true);
    if (!otherRun.ok) return;
    expect(grantRow(fixture, otherRun.value.artifactId)?.reservation_bytes).toBe(
      1_048_576,
    );
  });

  it("enforces the total published+reservation headroom across runs", () => {
    const quota = {
      perArtifactBytes: 1_073_741_824,
      perRunPublishedBytes: 4_294_967_296,
      totalPublishedBytes: 1_073_741_824,
      maxInFlightStagingBytes: 2_147_483_648,
      maxConcurrentUploadsPerRunner: 8,
    };
    const fixture = createFixture({ quota });
    const run1 = queuedRun(fixture, "action-fixture-1");
    const run2 = queuedRun(fixture, "action-fixture-2");
    const lease1 = acquire(fixture, run1, { runnerId: "runner-r1" });
    const lease2 = acquire(fixture, run2, { runnerId: "runner-r2" });
    expect(fixture.grants.createGrant(grantInput(lease1)).ok).toBe(true);
    expect(
      fixture.grants.createGrant(grantInput(lease2)),
    ).toEqual({ ok: false, error: { code: "total_quota_exceeded" } });
  });

  it("blocks event appends and completion at a granted sequence until no matching in-progress grant remains", () => {
    const fixture = createFixture();
    const runId = queuedRun(fixture);
    const lease = acquire(fixture, runId);
    const granted = fixture.grants.createGrant(grantInput(lease));
    expect(granted.ok).toBe(true);
    if (!granted.ok) throw new Error("unreachable");
    const presented = {
      runId: lease.runId,
      leaseId: lease.leaseId,
      runnerId: lease.runnerId,
      sessionId: lease.sessionId,
      fence: lease.fence,
    };
    expect(
      fixture.runs.appendEvent({
        presented,
        sequence: 1,
        type: "started",
        serverNow: "2026-08-09T12:00:05.000Z",
      }),
    ).toEqual({ ok: false, error: { code: "artifact_upload_in_progress" } });
    expect(
      fixture.runs.completeRun({
        presented,
        sequence: 1,
        terminalKind: "failed",
        reason: "runner_lost",
        serverNow: "2026-08-09T12:00:06.000Z",
      }),
    ).toEqual({ ok: false, error: { code: "artifact_upload_in_progress" } });
    expect(latestEventSequence(fixture, lease.leaseId)).toBe(0);
    fixture.database.sqlite
      .prepare("update evidence_grants set state = 'upload_interrupted' where artifact_id = ?")
      .run(granted.value.artifactId);
    const append = fixture.runs.appendEvent({
      presented,
      sequence: 1,
      type: "started",
      serverNow: "2026-08-09T12:00:07.000Z",
    });
    expect(append.ok).toBe(true);
  });

  it("rejects adversarial bodies: caller-supplied IDs or paths, traversal slots, and bad metadata bounds", () => {
    const fixture = createFixture();
    const runId = queuedRun(fixture);
    const lease = acquire(fixture, runId);
    expect(
      fixture.grants.createGrant(grantInput(lease, { artifactSlot: "../escape" })),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
    expect(
      fixture.grants.createGrant(grantInput(lease, { artifactSlot: "has/slash" })),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
    expect(
      fixture.grants.createGrant(grantInput(lease, { path: "/etc/passwd" })),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
    expect(
      fixture.grants.createGrant(grantInput(lease, { uploadId: "caller-chosen-id" })),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
    expect(
      fixture.grants.createGrant(grantInput(lease, { artifactId: "caller-chosen-id" })),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
    expect(
      fixture.grants.createGrant(
        grantInput(lease, { originalFileName: "x".repeat(256) }),
      ),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
    expect(
      fixture.grants.createGrant(
        grantInput(lease, { declaredDigest: "sha256:zzzz" }),
      ),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
    expect(
      fixture.grants.createGrant(grantInput(lease, { eventSequence: 0 })),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
  });

  it("validates generated IDs and fails closed when they cannot be stored safely", () => {
    const fixture = createFixture({ grantIds: ["../escape"] });
    const runId = queuedRun(fixture);
    const lease = acquire(fixture, runId);
    const result = fixture.grants.createGrant(grantInput(lease));
    expect(result).toEqual({ ok: false, error: { code: "invalid_persisted_data" } });
    const count = fixture.database.sqlite
      .prepare("select count(*) as c from evidence_grants")
      .get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("rejects generated IDs that match the grammar but are not UUIDv4", () => {
    const fixture = createFixture({
      grantIds: [
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        "11111111-2222-4333-8444-555555555555",
      ],
    });
    const runId = queuedRun(fixture);
    const lease = acquire(fixture, runId);
    const result = fixture.grants.createGrant(grantInput(lease));
    expect(result).toEqual({ ok: false, error: { code: "invalid_persisted_data" } });
    const count = fixture.database.sqlite
      .prepare("select count(*) as c from evidence_grants")
      .get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("rejects a provider that yields identical artifactId and uploadId", () => {
    const same = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const fixture = createFixture({ grantIds: [same, same] });
    const runId = queuedRun(fixture);
    const lease = acquire(fixture, runId);
    const result = fixture.grants.createGrant(grantInput(lease));
    expect(result).toEqual({ ok: false, error: { code: "invalid_persisted_data" } });
    const count = fixture.database.sqlite
      .prepare("select count(*) as c from evidence_grants")
      .get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("blocks non-presented completion at a granted sequence until the grant leaves in-progress", () => {
    const fixture = createFixture();
    const runId = queuedRun(fixture);
    const lease = acquire(fixture, runId);
    const granted = fixture.grants.createGrant(grantInput(lease));
    expect(granted.ok).toBe(true);
    if (!granted.ok) throw new Error("unreachable");
    // Internal (non-presented) completion is gated by the same in-progress
    // grant, using the effective fence of the current lease.
    expect(
      fixture.runs.completeRun({
        presented: null,
        runId,
        sequence: 1,
        terminalKind: "failed",
        reason: "runner_lost",
        serverNow: "2026-08-09T12:00:06.000Z",
      }),
    ).toEqual({ ok: false, error: { code: "artifact_upload_in_progress" } });
    expect(latestEventSequence(fixture, lease.leaseId)).toBe(0);
    fixture.database.sqlite
      .prepare("update evidence_grants set state = 'upload_interrupted' where artifact_id = ?")
      .run(granted.value.artifactId);
    const completed = fixture.runs.completeRun({
      presented: null,
      runId,
      sequence: 1,
      terminalKind: "failed",
      reason: "runner_lost",
      serverNow: "2026-08-09T12:00:07.000Z",
    });
    expect(completed.ok).toBe(true);
  });

  it("fails closed when a generated artifactId collides with an existing primary key", () => {
    const artifactIdA = "aaaaaaaa-bbbb-4ccc-8ddd-000000000001";
    const fixture = createFixture({
      grantIds: [
        artifactIdA,
        "bbbbbbbb-bbbb-4ccc-8ddd-000000000002",
        artifactIdA,
        "cccccccc-bbbb-4ccc-8ddd-000000000003",
      ],
    });
    const runId = queuedRun(fixture);
    const lease = acquire(fixture, runId);
    const first = fixture.grants.createGrant(
      grantInput(lease, { artifactSlot: "slot-a" }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    expect(first.value.artifactId).toBe(artifactIdA);
    // The second grant passes pre-insert validation (valid distinct UUIDv4
    // pair) but its generated artifactId collides with the stored primary key.
    // The insert-time unique catch classifies it as invalid_persisted_data,
    // not artifact_upload_in_progress.
    const second = fixture.grants.createGrant(
      grantInput(lease, { artifactSlot: "slot-b", kind: "tool_raw" }),
    );
    expect(second).toEqual({ ok: false, error: { code: "invalid_persisted_data" } });
    const count = fixture.database.sqlite
      .prepare("select count(*) as c from evidence_grants")
      .get() as { c: number };
    expect(count.c).toBe(1);
  });

  it("lowercases generated UUIDs before storage", () => {
    const fixture = createFixture({
      grantIds: [
        "ABCDEF01-2345-4CDE-8DEF-123456789ABC",
        "FFFFFFFF-FFFF-4FFF-8FFF-FFFFFFFFFFFF",
      ],
    });
    const runId = queuedRun(fixture);
    const lease = acquire(fixture, runId);
    const result = fixture.grants.createGrant(grantInput(lease));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.artifactId).toBe(
      "abcdef01-2345-4cde-8def-123456789abc",
    );
    expect(result.value.uploadId).toMatch(UUID_V4_PATTERN);
  });

  it("enforces migration constraints against unsafe direct rows", () => {
    const fixture = createFixture();
    const runId = queuedRun(fixture);
    const base =
      "insert into evidence_grants (artifact_id, contract_version, profile, upload_id, run_id, lease_id, runner_id, session_id, fence, event_sequence, artifact_slot, kind, declared_size_bytes, declared_digest, original_file_name, declared_content_type, state, reservation_bytes, put_finalized, accepted_bytes, streamed_digest, created_at, updated_at) " +
      "values (?, 1, 'd3-v1', ?, ?, 'l1', 'runner-fixture-1', 's1', '1', 1, ?, 'stdout', null, null, null, null, 'in_progress', 100, 0, 0, null, 't', 't')";
    const db = fixture.database.sqlite;
    const insert = (artifactId: string, uploadId: string, slot: string) =>
      db.prepare(base).run(artifactId, uploadId, runId, slot);
    expect(
      insert("aaaaaaaa-bbbb-4ccc-8ddd-cccccccccccc", "uuuuuuuu-bbbb-4ccc-8ddd-dddddddddddd", "slot-a"),
    ).toBeTruthy();
    expect(() =>
      insert("aaaaaaaa-bbbb-4ccc-8ddd-ccccccccccee", "u2", "slot-a"),
    ).toThrow();
    expect(() =>
      insert("/absolute/path", "u3", "slot-b"),
    ).toThrow();
    expect(() => insert("bad id spaces", "u4", "slot-c")).toThrow();
    // uploadId is unique across all grants, even for non-conflicting identities.
    expect(() =>
      insert(
        "bbbbbbbb-bbbb-4ccc-8ddd-cccccccccccc",
        "uuuuuuuu-bbbb-4ccc-8ddd-dddddddddddd",
        "slot-d",
      ),
    ).toThrow();
    const interrupted = db
      .prepare(base.replace("'in_progress'", "'upload_interrupted'"))
      .run(
        "cccccccc-bbbb-4ccc-8ddd-cccccccccccc",
        "u6",
        runId,
        "slot-a",
      );
    expect(interrupted.changes).toBe(1);
    // 'published' is a valid grant state; an unknown state must still fail.
    expect(() =>
      db
        .prepare(base.replace("'in_progress'", "'orphaned'"))
        .run("dddddddd-bbbb-4ccc-8ddd-cccccccccccc", "u7", runId, "slot-e"),
    ).toThrow();
    expect(() =>
      db
        .prepare(base.replace(", 100,", ", 1073741825,"))
        .run("eeeeeeee-bbbb-4ccc-8ddd-cccccccccccc", "u8", runId, "slot-f"),
    ).toThrow();
    expect(() =>
      db
        .prepare(base.replace(", 100, 0, 0,", ", 100, 0, 101,"))
        .run("ffffffff-bbbb-4ccc-8ddd-cccccccccccc", "u9", runId, "slot-g"),
    ).toThrow();
  });
});

describe("publishedArtifactForEngagement", () => {
  it("returns a committed artifact only when it belongs to the engagement through run -> action", () => {
    const fixture = createFixture();
    const runId = queuedRun(fixture);
    const otherRunId = queuedRun(fixture, "action-fixture-2");
    const engagementId = engagementIdForRun(fixture, runId);
    const otherEngagementId = engagementIdForRun(fixture, otherRunId);
    const artifactId = "aaaaaaaa-bbbb-4ccc-8ddd-00000000000a";
    publishArtifact(fixture, artifactId, runId);

    const member = fixture.grants.publishedArtifactForEngagement({
      engagementId,
      artifactId,
    });
    expect(member?.artifactId).toBe(artifactId);
    expect(member?.runId).toBe(runId);
    expect(member?.kind).toBe("stdout");
    expect(member?.sizeBytes).toBe(5);

    // A different engagement must not observe the artifact.
    expect(
      fixture.grants.publishedArtifactForEngagement({
        engagementId: otherEngagementId,
        artifactId,
      }),
    ).toBeUndefined();

    // Unknown artifacts and unknown engagements are indistinguishable.
    expect(
      fixture.grants.publishedArtifactForEngagement({
        engagementId,
        artifactId: "bbbbbbbb-bbbb-4ccc-8ddd-00000000000b",
      }),
    ).toBeUndefined();
    expect(
      fixture.grants.publishedArtifactForEngagement({
        engagementId: "nonexistent-engagement",
        artifactId,
      }),
    ).toBeUndefined();
  });
});
