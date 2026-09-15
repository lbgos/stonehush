import { chmodSync, cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAX_CANONICAL_JSON_BYTES,
  type ActionSnapshot,
  type WarningContextAddition,
} from "@stonehush/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { bindActionSnapshot } from "./action-snapshot.js";
import { openEngagementDatabase, DATABASE_SCHEMA_VERSION } from "./database.js";
import { EngagementRepository } from "./repository.js";

const IDS = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
  "10000000-0000-4000-8000-000000000004",
  "10000000-0000-4000-8000-000000000005",
  "10000000-0000-4000-8000-000000000006",
  "10000000-0000-4000-8000-000000000007",
] as const;

const drizzleDirectory = fileURLToPath(new URL("../drizzle/", import.meta.url));

const lateAddition: WarningContextAddition = {
  origin: "https://other.test:443",
  resolvedAddress: "192.0.2.41",
};

interface Fixture {
  directory: string;
  database: ReturnType<typeof openEngagementDatabase>;
  repository: EngagementRepository;
}

const fixtures: Fixture[] = [];

function createFixture(
  migrationsFolder?: string,
): Fixture {
  const directory = mkdtempSync(path.join(tmpdir(), "stonehush-action-db-"));
  chmodSync(directory, 0o700);
  const database = openEngagementDatabase({
    dataDirectory: directory,
    ...(migrationsFolder === undefined ? {} : { migrationsFolder }),
  });
  let idIndex = 0;
  let clockTick = 0;
  const repository = new EngagementRepository(database.db, {
    createId: () => IDS[idIndex++] ?? "10000000-0000-4000-8000-000000000099",
    now: () => new Date(Date.UTC(2026, 7, 12, 12, clockTick++)),
  });
  const fixture = { directory, database, repository };
  fixtures.push(fixture);
  return fixture;
}

function createEngagement(repository: EngagementRepository, name = "Target lab") {
  const result = repository.createEngagement({
    name,
    kind: "lab",
    description: null,
    authorizationContext: "Synthetic fixture authorization context",
    autoContinueWarnings: false,
  });
  if (!result.ok) throw new Error(`Fixture create failed: ${result.error.code}`);
  return result.value;
}

function boundSnapshot(
  overrides: Partial<ActionSnapshot> & Pick<ActionSnapshot, "actionId">,
): ActionSnapshot {
  const snapshot: ActionSnapshot = {
    normalizationProfile: "d1-v1",
    orchestrationProfile: "d2-v1",
    snapshotId: overrides.snapshotId ?? "snapshot-1",
    version: overrides.version ?? 1,
    binding: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    actionId: overrides.actionId,
    canonicalTargets: overrides.canonicalTargets ?? [
      {
        normalizationProfile: "d1-v1",
        kind: "hostname",
        hostname: "app.target.test",
      },
    ],
    concreteDestinations: overrides.concreteDestinations ?? [
      {
        normalizationProfile: "d1-v1",
        kind: "ip",
        family: 4,
        address: "192.0.2.40",
        zone: null,
      },
    ],
    typedOptions: overrides.typedOptions ?? { ports: [80, 443] },
    resolutionSnapshots: overrides.resolutionSnapshots ?? [
      {
        canonicalQueryName: "app.target.test",
        resolverMode: "system",
        cnameChain: [],
        answers: [{ address: "192.0.2.40", family: 4, ttlSeconds: 60 }],
        resolvedAt: "2026-08-09T12:00:00.000Z",
      },
    ],
    scopeRevisionId: overrides.scopeRevisionId ?? null,
    warningState: overrides.warningState ?? {
      reasonCodes: [],
      knownAdditions: [],
      acknowledgment: null,
    },
  };
  const bound = bindActionSnapshot(snapshot);
  if (!bound.ok) throw new Error("Fixture snapshot binding failed");
  return { ...snapshot, binding: bound.binding };
}

function persistPlan(
  repository: EngagementRepository,
  engagementId: string,
  snapshot: ActionSnapshot,
  extras: {
    representable?: boolean;
    capabilityErrorCode?:
      | "capability_error"
      | "required_resolution_unavailable"
      | "target_set_unrepresentable"
      | null;
    occurredAt?: string;
  } = {},
) {
  const result = repository.persistPlannedAction({
    engagementId,
    snapshot,
    representable: extras.representable ?? true,
    capabilityErrorCode: extras.capabilityErrorCode ?? null,
    occurredAt: extras.occurredAt ?? "2026-08-12T12:00:00.000Z",
  });
  if (!result.ok) throw new Error(`Persist plan failed: ${result.error.code}`);
  return result.value;
}

function expectNoPersistedAction(
  database: ReturnType<typeof openEngagementDatabase>,
  repository: EngagementRepository,
  actionId: string,
  engagementId: string,
) {
  expect(repository.getAction(engagementId, actionId)).toEqual({
    ok: false,
    error: { code: "action_not_found" },
  });
  expect(
    database.sqlite
      .prepare("select count(*) as count from actions where id = ?")
      .get(actionId),
  ).toEqual({ count: 0 });
  expect(
    database.sqlite
      .prepare("select count(*) as count from action_snapshots where action_id = ?")
      .get(actionId),
  ).toEqual({ count: 0 });
  expect(
    database.sqlite
      .prepare(
        "select count(*) as count from action_warning_acknowledgments where action_id = ?",
      )
      .get(actionId),
  ).toEqual({ count: 0 });
}

function writePartialMigrations(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "stonehush-partial-migrate-"));
  chmodSync(directory, 0o700);
  mkdirSync(path.join(directory, "meta"), { recursive: true });
  for (const fileName of [
    "0000_engagement_persistence.sql",
    "0001_operator_command_idempotency.sql",
  ]) {
    cpSync(path.join(drizzleDirectory, fileName), path.join(directory, fileName));
  }
  writeFileSync(
    path.join(directory, "meta/_journal.json"),
    `${JSON.stringify(
      {
        version: "7",
        dialect: "sqlite",
        entries: [
          {
            idx: 0,
            version: "6",
            when: 1786549868423,
            tag: "0000_engagement_persistence",
            breakpoints: true,
          },
          {
            idx: 1,
            version: "6",
            when: 1786552115437,
            tag: "0001_operator_command_idempotency",
            breakpoints: true,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return directory;
}

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture === undefined) continue;
    if (fixture.database.sqlite.open) fixture.database.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

describe("action persistence foundation", () => {
  it("applies a fresh 0002 migration and upgrades an existing 0001 database", () => {
    const fresh = createFixture();
    expect(
      fresh.database.sqlite
        .prepare("select count(*) as count from __drizzle_migrations")
        .get(),
    ).toEqual({ count: DATABASE_SCHEMA_VERSION });
    expect(
      fresh.database.sqlite
        .prepare(
          "select name from sqlite_master where type = 'table' and name = 'action_snapshots'",
        )
        .get(),
    ).toEqual({ name: "action_snapshots" });

    const partialDirectory = writePartialMigrations();
    try {
      const upgraded = createFixture(partialDirectory);
      // The pre-upgrade binary wrote the old row shape without deadline_at,
      // so seed it with raw SQL instead of the current repository.
      const legacyId = IDS[0];
      upgraded.database.sqlite
        .prepare(
          "insert into engagements (id, contract_version, revision, name, kind, status, description, authorization_context, auto_continue_warnings, created_at, updated_at) values (?, 1, 1, 'Target lab', 'lab', 'active', null, 'Synthetic fixture authorization context', 0, '2026-08-12T12:00:00.000Z', '2026-08-12T12:00:00.000Z')",
        )
        .run(legacyId);
      expect(
        upgraded.database.sqlite
          .prepare("select count(*) as count from __drizzle_migrations")
          .get(),
      ).toEqual({ count: 2 });
      upgraded.database.close();
      upgraded.database = openEngagementDatabase({
        dataDirectory: upgraded.directory,
      });
      const upgradedRepository = new EngagementRepository(upgraded.database.db, {
        createId: () => IDS[2],
        now: () => new Date("2026-08-12T12:30:00.000Z"),
      });
      expect(
        upgraded.database.sqlite
          .prepare("select count(*) as count from __drizzle_migrations")
          .get(),
      ).toEqual({ count: DATABASE_SCHEMA_VERSION });
      expect(upgradedRepository.getEngagement(legacyId)).toMatchObject({
        ok: true,
        value: {
          engagement: { id: legacyId, name: "Target lab", deadlineAt: null },
        },
      });
    } finally {
      rmSync(partialDirectory, { recursive: true, force: true });
    }
  });

  it("distinguishes no saved scope from an active empty revision", () => {
    const { repository } = createFixture();
    const engagement = createEngagement(repository);
    const noScope = persistPlan(
      repository,
      engagement.id,
      boundSnapshot({ actionId: "action-no-scope" }),
    );
    expect(noScope.action.snapshots[0]?.scopeRevisionId).toBeNull();

    const emptyScope = repository.appendScopeRevision({
      engagementId: engagement.id,
      expectedRevision: 1,
      rules: [],
    });
    if (!emptyScope.ok) throw new Error(emptyScope.error.code);
    const activeEmpty = persistPlan(
      repository,
      engagement.id,
      boundSnapshot({
        actionId: "action-empty-scope",
        snapshotId: "snapshot-empty",
        scopeRevisionId: emptyScope.value.id,
        warningState: {
          reasonCodes: ["outside_scope"],
          knownAdditions: [],
          acknowledgment: null,
        },
      }),
    );
    expect(activeEmpty.action.snapshots[0]?.scopeRevisionId).toBe(emptyScope.value.id);
    expect(repository.getAction(engagement.id, "action-no-scope")).toMatchObject({
      ok: true,
      value: { action: { snapshots: [{ scopeRevisionId: null }] } },
    });
    expect(repository.getAction(engagement.id, "action-empty-scope")).toMatchObject({
      ok: true,
      value: {
        action: { snapshots: [{ scopeRevisionId: emptyScope.value.id }] },
      },
    });
  });

  it("records Continue, add-scope, auto-continue, and late-warning contexts", () => {
    const { repository } = createFixture();
    const engagement = createEngagement(repository);
    const continueSnapshot = boundSnapshot({
      actionId: "action-continue",
      warningState: {
        reasonCodes: ["outside_scope"],
        knownAdditions: [],
        acknowledgment: null,
      },
    });
    const paused = persistPlan(repository, engagement.id, continueSnapshot);
    const continued = repository.continueAction({
      engagementId: engagement.id,
      actionId: "action-continue",
      expectedRevision: paused.revision,
      snapshotVersion: 1,
      snapshotBinding: continueSnapshot.binding,
      occurredAt: "2026-08-12T12:10:00.000Z",
    });
    expect(continued).toMatchObject({
      ok: true,
      value: {
        action: {
          state: "queued",
          warningAcknowledgment: {
            source: "operator_continue",
            snapshotBinding: continueSnapshot.binding,
            scopeRevisionId: null,
          },
        },
      },
    });

    const addScopePaused = persistPlan(
      repository,
      engagement.id,
      boundSnapshot({
        actionId: "action-add-scope",
        snapshotId: "snapshot-before-scope",
        warningState: {
          reasonCodes: ["outside_scope"],
          knownAdditions: [],
          acknowledgment: null,
        },
      }),
    );
    const added = repository.withWriteTx((transaction) => {
      const scope = transaction.appendScopeRevision({
        engagementId: engagement.id,
        expectedRevision: 1,
        rules: [],
      });
      if (!scope.ok) throw new Error(scope.error.code);
      const rechecked = boundSnapshot({
        actionId: "action-add-scope",
        snapshotId: "snapshot-after-scope",
        version: 2,
        scopeRevisionId: scope.value.id,
        warningState: {
          reasonCodes: ["large_target_set"],
          knownAdditions: [],
          acknowledgment: null,
        },
      });
      return transaction.addScopeAndRunAction({
        engagementId: engagement.id,
        actionId: "action-add-scope",
        expectedRevision: addScopePaused.revision,
        recheckedSnapshot: rechecked,
        occurredAt: "2026-08-12T12:11:00.000Z",
      });
    });
    expect(added).toMatchObject({
      ok: true,
      value: {
        action: {
          state: "queued",
          queuedSnapshotVersion: 2,
          warningAcknowledgment: { source: "add_scope_and_run" },
        },
      },
    });

    const engagementAfterScope = repository.getEngagement(engagement.id);
    if (!engagementAfterScope.ok) throw new Error(engagementAfterScope.error.code);
    const activeScopeId =
      engagementAfterScope.value.engagement.activeScopeRevisionId;
    if (activeScopeId === null) {
      throw new Error("expected an active scope after add-scope");
    }

    expect(
      repository.updateAutoContinueWarnings(engagement.id, 2, true),
    ).toMatchObject({ ok: true });
    const autoContinued = persistPlan(
      repository,
      engagement.id,
      boundSnapshot({
        actionId: "action-auto-continue",
        snapshotId: "snapshot-auto",
        scopeRevisionId: activeScopeId,
        warningState: {
          reasonCodes: ["outside_scope"],
          knownAdditions: [],
          acknowledgment: null,
        },
      }),
    );
    expect(autoContinued.action).toMatchObject({
      state: "queued",
      warningAcknowledgment: { source: "engagement_policy" },
    });

    const autoLateQueued = persistPlan(
      repository,
      engagement.id,
      boundSnapshot({
        actionId: "action-late-auto",
        snapshotId: "snapshot-late-auto",
        scopeRevisionId: activeScopeId,
      }),
    );
    const autoLateActivated = repository.activateAction({
      engagementId: engagement.id,
      actionId: "action-late-auto",
      expectedRevision: autoLateQueued.revision,
    });
    if (!autoLateActivated.ok) throw new Error(autoLateActivated.error.code);
    expect(
      repository.recordLateWarning({
        engagementId: engagement.id,
        actionId: "action-late-auto",
        expectedRevision: autoLateActivated.value.revision,
        snapshotVersion: 1,
        snapshotBinding: autoLateQueued.action.snapshots[0]?.binding,
        reasonCodes: ["outside_scope"],
        addition: lateAddition,
        pendingEventId: 3,
        occurredAt: "2026-08-12T12:12:30.000Z",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        action: {
          state: "active",
          warningAcknowledgment: { source: "engagement_policy" },
          coveredDestinations: [lateAddition],
          pendingWarning: null,
        },
      },
    });

    expect(
      repository.updateAutoContinueWarnings(engagement.id, 3, false),
    ).toMatchObject({ ok: true });
    const queued = persistPlan(
      repository,
      engagement.id,
      boundSnapshot({
        actionId: "action-late",
        snapshotId: "snapshot-late",
        scopeRevisionId: activeScopeId,
      }),
    );
    const activated = repository.activateAction({
      engagementId: engagement.id,
      actionId: "action-late",
      expectedRevision: queued.revision,
    });
    if (!activated.ok) throw new Error(activated.error.code);
    const late = repository.recordLateWarning({
      engagementId: engagement.id,
      actionId: "action-late",
      expectedRevision: activated.value.revision,
      snapshotVersion: 1,
      snapshotBinding: queued.action.snapshots[0]?.binding,
      reasonCodes: ["outside_scope"],
      addition: lateAddition,
      pendingEventId: 7,
      occurredAt: "2026-08-12T12:12:00.000Z",
    });
    expect(late).toMatchObject({
      ok: true,
      value: {
        action: {
          state: "active_paused_for_warning",
          pendingWarning: { pendingEventId: 7, knownAdditions: [lateAddition] },
        },
      },
    });
  });

  it("appends covered destinations without mutating snapshot or acknowledgment rows", () => {
    const { database, repository } = createFixture();
    const engagement = createEngagement(repository);
    const snapshot = boundSnapshot({ actionId: "action-covered" });
    const queued = persistPlan(repository, engagement.id, snapshot);
    const activated = repository.activateAction({
      engagementId: engagement.id,
      actionId: "action-covered",
      expectedRevision: queued.revision,
    });
    if (!activated.ok) throw new Error(activated.error.code);
    const paused = repository.recordLateWarning({
      engagementId: engagement.id,
      actionId: "action-covered",
      expectedRevision: activated.value.revision,
      snapshotVersion: 1,
      snapshotBinding: snapshot.binding,
      reasonCodes: ["outside_scope"],
      addition: lateAddition,
      pendingEventId: 1,
      occurredAt: "2026-08-12T12:13:00.000Z",
    });
    if (!paused.ok) throw new Error(paused.error.code);
    const continued = repository.continueLateWarning({
      engagementId: engagement.id,
      actionId: "action-covered",
      expectedRevision: paused.value.revision,
      snapshotVersion: 1,
      snapshotBinding: snapshot.binding,
      pendingEventId: 1,
      occurredAt: "2026-08-12T12:14:00.000Z",
    });
    if (!continued.ok) throw new Error(continued.error.code);
    const originalSnapshot = database.sqlite
      .prepare("select snapshot_json, binding from action_snapshots where id = ?")
      .get("snapshot-1");
    const originalAck = database.sqlite
      .prepare(
        "select reason_codes_json, known_additions_json from action_warning_acknowledgments where action_id = ?",
      )
      .get("action-covered");
    const second = {
      hostname: "cdn.target.test",
      address: "192.0.2.50",
    } as const;
    const covered = repository.recordLateWarning({
      engagementId: engagement.id,
      actionId: "action-covered",
      expectedRevision: continued.value.revision,
      snapshotVersion: 1,
      snapshotBinding: snapshot.binding,
      reasonCodes: ["outside_scope", "risk_tier_t2"],
      addition: second,
      pendingEventId: 2,
      occurredAt: "2026-08-12T12:15:00.000Z",
    });
    expect(covered).toMatchObject({
      ok: true,
      value: {
        action: {
          state: "active",
          coveredDestinations: [lateAddition, second],
          warningAcknowledgment: {
            coveredDestinations: [second],
            reasonCodes: ["outside_scope", "risk_tier_t2"],
          },
        },
      },
    });
    expect(
      database.sqlite
        .prepare("select snapshot_json, binding from action_snapshots where id = ?")
        .get("snapshot-1"),
    ).toEqual(originalSnapshot);
    expect(
      database.sqlite
        .prepare(
          "select reason_codes_json, known_additions_json from action_warning_acknowledgments where action_id = ?",
        )
        .get("action-covered"),
    ).toEqual(originalAck);
    expect(
      database.sqlite
        .prepare("select count(*) as count from action_covered_destinations")
        .get(),
    ).toEqual({ count: 2 });
    expect(() =>
      database.sqlite
        .prepare("update action_warning_acknowledgments set source = 'engagement_policy'")
        .run(),
    ).toThrow("action warning acknowledgments are immutable");
    expect(() =>
      database.sqlite.prepare("delete from action_warning_acknowledgments").run(),
    ).toThrow("action warning acknowledgments are immutable");
    expect(() =>
      database.sqlite
        .prepare("update action_covered_destinations set sequence = 9")
        .run(),
    ).toThrow("action covered destinations are immutable");
    const ack = database.sqlite
      .prepare(
        "select id, action_id, engagement_id, snapshot_id, snapshot_version, snapshot_binding, acknowledged_at from action_warning_acknowledgments where action_id = ?",
      )
      .get("action-covered") as {
      id: string;
      action_id: string;
      engagement_id: string;
      snapshot_id: string;
      snapshot_version: number;
      snapshot_binding: string;
      acknowledged_at: string;
    };
    expect(() =>
      database.sqlite
        .prepare(
          "insert or replace into action_warning_acknowledgments (id, contract_version, action_id, engagement_id, snapshot_id, snapshot_version, snapshot_binding, scope_revision_id, reason_codes_json, known_additions_json, source, acknowledged_at, pending_event_id) values (?, 1, ?, ?, ?, ?, ?, null, '[]', '[]', 'engagement_policy', ?, null)",
        )
        .run(
          ack.id,
          ack.action_id,
          ack.engagement_id,
          ack.snapshot_id,
          ack.snapshot_version,
          ack.snapshot_binding,
          ack.acknowledged_at,
        ),
    ).toThrow("action warning acknowledgments are immutable");
  });

  it("preserves the exact queued snapshot and acknowledgment for retry", () => {
    const { repository } = createFixture();
    const engagement = createEngagement(repository);
    const snapshot = boundSnapshot({
      actionId: "action-retry",
      warningState: {
        reasonCodes: ["outside_scope"],
        knownAdditions: [],
        acknowledgment: null,
      },
    });
    const paused = persistPlan(repository, engagement.id, snapshot);
    const queued = repository.continueAction({
      engagementId: engagement.id,
      actionId: "action-retry",
      expectedRevision: paused.revision,
      snapshotVersion: 1,
      snapshotBinding: snapshot.binding,
      occurredAt: "2026-08-12T12:16:00.000Z",
    });
    if (!queued.ok) throw new Error(queued.error.code);
    const cancelled = repository.cancelAction({
      engagementId: engagement.id,
      actionId: "action-retry",
      expectedRevision: queued.value.revision,
    });
    if (!cancelled.ok) throw new Error(cancelled.error.code);
    expect(repository.retryActionContext(engagement.id, "action-retry")).toEqual({
      ok: true,
      value: {
        actionId: "action-retry",
        snapshotId: "snapshot-1",
        snapshotVersion: 1,
        snapshotBinding: snapshot.binding,
        warningAcknowledgment: cancelled.value.action.warningAcknowledgment,
        warningAcknowledgmentId: cancelled.value.warningAcknowledgmentId,
        resolutionRefreshed: false,
        newWarningBudget: false,
      },
    });
  });

  it("rejects a stale action revision without writing", () => {
    const { repository } = createFixture();
    const engagement = createEngagement(repository);
    const snapshot = boundSnapshot({
      actionId: "action-revision",
      warningState: {
        reasonCodes: ["outside_scope"],
        knownAdditions: [],
        acknowledgment: null,
      },
    });
    const paused = persistPlan(repository, engagement.id, snapshot);
    expect(
      repository.continueAction({
        engagementId: engagement.id,
        actionId: "action-revision",
        expectedRevision: 99,
        snapshotVersion: 1,
        snapshotBinding: snapshot.binding,
        occurredAt: "2026-08-12T12:17:00.000Z",
      }),
    ).toEqual({
      ok: false,
      error: { code: "revision_conflict", currentRevision: paused.revision },
    });
    expect(repository.getAction(engagement.id, "action-revision")).toMatchObject({
      ok: true,
      value: { revision: 1, action: { state: "paused_for_warning" } },
    });
  });

  it("rolls back action writes when a later statement fails", () => {
    const { database, repository } = createFixture();
    const engagement = createEngagement(repository);
    database.sqlite.exec(`
      create trigger synthetic_action_insert_failure
      after insert on action_snapshots
      begin
        select raise(abort, 'synthetic snapshot failure');
      end;
    `);
    expect(
      repository.persistPlannedAction({
        engagementId: engagement.id,
        snapshot: boundSnapshot({ actionId: "action-rollback" }),
          representable: true,
        capabilityErrorCode: null,
        occurredAt: "2026-08-12T12:18:00.000Z",
      }),
    ).toEqual({ ok: false, error: { code: "invalid_persisted_data" } });
    expect(repository.getAction(engagement.id, "action-rollback")).toEqual({
      ok: false,
      error: { code: "action_not_found" },
    });
  });

  it("rolls back a caller-owned add-scope transaction as one unit", () => {
    const { repository } = createFixture();
    const engagement = createEngagement(repository);
    const paused = persistPlan(
      repository,
      engagement.id,
      boundSnapshot({
        actionId: "action-tx",
        warningState: {
          reasonCodes: ["outside_scope"],
          knownAdditions: [],
          acknowledgment: null,
        },
      }),
    );

    expect(() =>
      repository.withWriteTx((transaction) => {
        const scope = transaction.appendScopeRevision({
          engagementId: engagement.id,
          expectedRevision: 1,
          rules: [],
        });
        if (!scope.ok) throw new Error(scope.error.code);
        const rechecked = boundSnapshot({
          actionId: "action-tx",
          snapshotId: "snapshot-tx-2",
          version: 2,
          scopeRevisionId: scope.value.id,
          warningState: {
            reasonCodes: [],
            knownAdditions: [],
            acknowledgment: null,
          },
        });
        expect(
          transaction.addScopeAndRunAction({
            engagementId: engagement.id,
            actionId: "action-tx",
            expectedRevision: paused.revision,
            recheckedSnapshot: rechecked,
            occurredAt: "2026-08-12T12:23:00.000Z",
          }),
        ).toMatchObject({ ok: true });
        throw new Error("synthetic rollback");
      }),
    ).toThrow("synthetic rollback");

    expect(repository.listScopeRevisions(engagement.id)).toEqual({
      ok: true,
      value: [],
    });
    expect(repository.getAction(engagement.id, "action-tx")).toMatchObject({
      ok: true,
      value: {
        revision: paused.revision,
        action: { state: "paused_for_warning", queuedSnapshotVersion: null },
      },
    });
    expect(repository.getEngagement(engagement.id)).toMatchObject({
      ok: true,
      value: { engagement: { revision: 1, activeScopeRevisionId: null } },
    });
  });

  it("rejects malformed and shape-invalid stored snapshot JSON without reflection", () => {
    const { database, repository } = createFixture();
    const engagement = createEngagement(repository);
    const snapshot = boundSnapshot({ actionId: "action-json" });
    persistPlan(repository, engagement.id, snapshot);
    expect(() =>
      database.sqlite
        .prepare("update action_snapshots set snapshot_json = ? where id = ?")
        .run("{", "snapshot-1"),
    ).toThrow("action snapshots are immutable");

    database.sqlite.exec("drop trigger action_snapshots_no_update");
    expect(() =>
      database.sqlite
        .prepare("update action_snapshots set snapshot_json = ? where id = ?")
        .run("{", "snapshot-1"),
    ).toThrow();

    database.sqlite
      .prepare("update action_snapshots set snapshot_json = ? where id = ?")
      .run("{}", "snapshot-1");
    const invalid = repository.getAction(engagement.id, "action-json");
    expect(invalid).toEqual({
      ok: false,
      error: { code: "invalid_persisted_data" },
    });
    expect(JSON.stringify(invalid)).not.toContain("snapshot-1");
  });

  it("rejects cross-engagement ownership and protects immutable rows", () => {
    const { database, repository } = createFixture();
    const first = createEngagement(repository, "First lab");
    const second = createEngagement(repository, "Second lab");
    const snapshot = boundSnapshot({ actionId: "action-owned" });
    persistPlan(repository, first.id, snapshot);
    expect(repository.getAction(second.id, "action-owned")).toEqual({
      ok: false,
      error: { code: "action_not_found" },
    });
    expect(
      repository.continueAction({
        engagementId: second.id,
        actionId: "action-owned",
        expectedRevision: 1,
        snapshotVersion: 1,
        snapshotBinding: snapshot.binding,
        occurredAt: "2026-08-12T12:19:00.000Z",
      }),
    ).toEqual({ ok: false, error: { code: "action_not_found" } });
    expect(
      repository.persistPlannedAction({
        engagementId: second.id,
        snapshot: boundSnapshot({
          actionId: "action-foreign-scope",
          snapshotId: "snapshot-foreign",
          scopeRevisionId: first.id,
        }),
          representable: true,
        capabilityErrorCode: null,
        occurredAt: "2026-08-12T12:20:00.000Z",
      }),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });

    expect(() =>
      database.sqlite
        .prepare("update action_snapshots set version = 2 where id = ?")
        .run("snapshot-1"),
    ).toThrow("action snapshots are immutable");
    expect(() =>
      database.sqlite.prepare("delete from action_snapshots where id = ?").run("snapshot-1"),
    ).toThrow("action snapshots are immutable");
    expect(() =>
      database.sqlite
        .prepare(
          "insert or replace into action_snapshots (id, contract_version, action_id, engagement_id, version, binding, canonicalization_profile, scope_revision_id, snapshot_json, created_at) values (?, 1, ?, ?, 1, ?, 'action-snapshot-json-v1', null, '{}', ?)",
        )
        .run(
          "snapshot-1",
          "action-owned",
          first.id,
          snapshot.binding,
          "2026-08-12T12:21:00.000Z",
        ),
    ).toThrow("action snapshots are immutable");
  });

  it("keeps queued snapshots after archive and reopen", () => {
    const { repository } = createFixture();
    const engagement = createEngagement(repository);
    const snapshot = boundSnapshot({ actionId: "action-reopen" });
    const queued = persistPlan(repository, engagement.id, snapshot);
    expect(repository.archive(engagement.id, 1)).toMatchObject({ ok: true });
    expect(
      repository.activateAction({
        engagementId: engagement.id,
        actionId: "action-reopen",
        expectedRevision: queued.revision,
      }),
    ).toEqual({ ok: false, error: { code: "engagement_archived" } });
    expect(repository.getAction(engagement.id, "action-reopen")).toMatchObject({
      ok: true,
      value: { action: { state: "queued", snapshots: [{ binding: snapshot.binding }] } },
    });
    expect(repository.reopen(engagement.id, 2)).toMatchObject({ ok: true });
    expect(
      repository.activateAction({
        engagementId: engagement.id,
        actionId: "action-reopen",
        expectedRevision: queued.revision,
      }),
    ).toMatchObject({ ok: true, value: { action: { state: "active" } } });
  });

  it("rejects an unbound snapshot digest without reflecting input", () => {
    const { repository } = createFixture();
    const engagement = createEngagement(repository);
    const marker = "SENSITIVE_UNTRUSTED_MARKER";
    const result = repository.persistPlannedAction({
      engagementId: engagement.id,
      snapshot: {
        ...boundSnapshot({ actionId: "action-mismatch" }),
        binding: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        typedOptions: { note: marker },
      },
      representable: true,
      capabilityErrorCode: null,
      occurredAt: "2026-08-12T12:22:00.000Z",
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "snapshot_binding_mismatch" },
    });
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it("rejects a shape-valid noncanonical pending warning addition without reflection", () => {
    const { database, repository } = createFixture();
    const engagement = createEngagement(repository);
    persistPlan(
      repository,
      engagement.id,
      boundSnapshot({
        actionId: "action-hostile-pending",
        snapshotId: "snapshot-hostile-pending",
        warningState: {
          reasonCodes: ["outside_scope"],
          knownAdditions: [],
          acknowledgment: null,
        },
      }),
    );
    database.sqlite
      .prepare("update actions set pending_warning_json = ? where id = ?")
      .run(
        JSON.stringify({
          reasonCodes: ["outside_scope"],
          knownAdditions: [
            { hostname: "Target.Test", address: "192.0.2.41" },
          ],
          pendingEventId: null,
        }),
        "action-hostile-pending",
      );
    const invalid = repository.getAction(engagement.id, "action-hostile-pending");
    expect(invalid).toEqual({
      ok: false,
      error: { code: "invalid_persisted_data" },
    });
    expect(JSON.stringify(invalid)).not.toContain("Target.Test");
  });

  it("rejects a covered destination that points at another action's acknowledgment", () => {
    const { database, repository } = createFixture();
    const engagement = createEngagement(repository);
    const firstSnapshot = boundSnapshot({
      actionId: "action-ack-owner",
      warningState: {
        reasonCodes: ["outside_scope"],
        knownAdditions: [],
        acknowledgment: null,
      },
    });
    const firstPaused = persistPlan(repository, engagement.id, firstSnapshot);
    expect(
      repository.continueAction({
        engagementId: engagement.id,
        actionId: "action-ack-owner",
        expectedRevision: firstPaused.revision,
        snapshotVersion: 1,
        snapshotBinding: firstSnapshot.binding,
        occurredAt: "2026-08-12T12:24:00.000Z",
      }),
    ).toMatchObject({ ok: true });
    const secondSnapshot = boundSnapshot({
      actionId: "action-ack-borrower",
      snapshotId: "snapshot-borrower",
      warningState: {
        reasonCodes: ["outside_scope"],
        knownAdditions: [],
        acknowledgment: null,
      },
    });
    const secondPaused = persistPlan(repository, engagement.id, secondSnapshot);
    expect(
      repository.continueAction({
        engagementId: engagement.id,
        actionId: "action-ack-borrower",
        expectedRevision: secondPaused.revision,
        snapshotVersion: 1,
        snapshotBinding: secondSnapshot.binding,
        occurredAt: "2026-08-12T12:25:00.000Z",
      }),
    ).toMatchObject({ ok: true });
    const foreignAck = database.sqlite
      .prepare(
        "select id from action_warning_acknowledgments where action_id = ?",
      )
      .pluck()
      .get("action-ack-owner");
    expect(() =>
      database.sqlite
        .prepare(
          "insert into action_covered_destinations (action_id, engagement_id, acknowledgment_id, sequence, destination_json, reason_codes_json, acknowledged_cover, created_at) values (?, ?, ?, 1, ?, '[]', 0, ?)",
        )
        .run(
          "action-ack-borrower",
          engagement.id,
          foreignAck,
          JSON.stringify(lateAddition),
          "2026-08-12T12:26:00.000Z",
        ),
    ).toThrow(/FOREIGN KEY constraint failed/i);
  });

  it("rejects noncanonical stored snapshot targets and covered additions", () => {
    const { database, repository } = createFixture();
    const engagement = createEngagement(repository);
    const snapshot = boundSnapshot({
      actionId: "action-hostile-json",
      snapshotId: "snapshot-hostile",
      warningState: {
        reasonCodes: ["outside_scope"],
        knownAdditions: [],
        acknowledgment: null,
      },
    });
    const paused = persistPlan(repository, engagement.id, snapshot);
    expect(
      repository.continueAction({
        engagementId: engagement.id,
        actionId: "action-hostile-json",
        expectedRevision: paused.revision,
        snapshotVersion: 1,
        snapshotBinding: snapshot.binding,
        occurredAt: "2026-08-12T12:27:00.000Z",
      }),
    ).toMatchObject({ ok: true });

    const hostileSnapshot = boundSnapshot({
      actionId: "action-hostile-json",
      snapshotId: "snapshot-hostile",
      canonicalTargets: [
        {
          normalizationProfile: "d1-v1",
          kind: "hostname",
          hostname: "Target.Test",
        },
      ],
    });
    database.sqlite.exec("drop trigger action_snapshots_no_update");
    database.sqlite
      .prepare(
        "update action_snapshots set snapshot_json = ?, binding = ? where id = ?",
      )
      .run(
        JSON.stringify(hostileSnapshot),
        hostileSnapshot.binding,
        "snapshot-hostile",
      );
    const invalidSnapshot = repository.getAction(
      engagement.id,
      "action-hostile-json",
    );
    expect(invalidSnapshot).toEqual({
      ok: false,
      error: { code: "invalid_persisted_data" },
    });
    expect(JSON.stringify(invalidSnapshot)).not.toContain("Target.Test");

    database.sqlite
      .prepare(
        "update action_snapshots set snapshot_json = ?, binding = ? where id = ?",
      )
      .run(JSON.stringify(snapshot), snapshot.binding, "snapshot-hostile");
    const ackId = database.sqlite
      .prepare(
        "select id from action_warning_acknowledgments where action_id = ?",
      )
      .pluck()
      .get("action-hostile-json") as string;
    database.sqlite
      .prepare(
        "insert into action_covered_destinations (action_id, engagement_id, acknowledgment_id, sequence, destination_json, reason_codes_json, acknowledged_cover, created_at) values (?, ?, ?, 1, ?, '[]', 0, ?)",
      )
      .run(
        "action-hostile-json",
        engagement.id,
        ackId,
        JSON.stringify({
          hostname: "Target.Test",
          address: "192.0.2.41",
        }),
        "2026-08-12T12:28:00.000Z",
      );
    const invalidAddition = repository.getAction(
      engagement.id,
      "action-hostile-json",
    );
    expect(invalidAddition).toEqual({
      ok: false,
      error: { code: "invalid_persisted_data" },
    });
    expect(JSON.stringify(invalidAddition)).not.toContain("Target.Test");
  });

  it("derives auto-continue from the stored engagement and rejects caller forgeries", () => {
    const { repository } = createFixture();
    const engagement = createEngagement(repository);
    const warningSnapshot = boundSnapshot({
      actionId: "action-forge-prerun",
      warningState: {
        reasonCodes: ["outside_scope"],
        knownAdditions: [],
        acknowledgment: null,
      },
    });
    const forgedPlan = repository.persistPlannedAction({
      engagementId: engagement.id,
      snapshot: warningSnapshot,
      engagementAutoContinue: true,
      representable: true,
      capabilityErrorCode: null,
      occurredAt: "2026-08-12T12:29:00.000Z",
    });
    expect(forgedPlan).toEqual({
      ok: false,
      error: { code: "invalid_repository_input" },
    });
    expect(JSON.stringify(forgedPlan)).not.toContain("engagementAutoContinue");

    const paused = persistPlan(repository, engagement.id, warningSnapshot);
    expect(paused.action).toMatchObject({
      state: "paused_for_warning",
      warningAcknowledgment: null,
    });

    const queued = persistPlan(
      repository,
      engagement.id,
      boundSnapshot({ actionId: "action-forge-late", snapshotId: "snapshot-forge-late" }),
    );
    const activated = repository.activateAction({
      engagementId: engagement.id,
      actionId: "action-forge-late",
      expectedRevision: queued.revision,
    });
    if (!activated.ok) throw new Error(activated.error.code);
    const forgedLate = repository.recordLateWarning({
      engagementId: engagement.id,
      actionId: "action-forge-late",
      expectedRevision: activated.value.revision,
      snapshotVersion: 1,
      snapshotBinding: queued.action.snapshots[0]?.binding,
      reasonCodes: ["outside_scope"],
      addition: lateAddition,
      pendingEventId: 4,
      engagementAutoContinue: true,
      occurredAt: "2026-08-12T12:30:00.000Z",
    });
    expect(forgedLate).toEqual({
      ok: false,
      error: { code: "invalid_repository_input" },
    });
    expect(JSON.stringify(forgedLate)).not.toContain("engagementAutoContinue");
    const forgedRunState = repository.recordLateWarning({
      engagementId: engagement.id,
      actionId: "action-forge-late",
      expectedRevision: activated.value.revision,
      snapshotVersion: 1,
      snapshotBinding: queued.action.snapshots[0]?.binding,
      reasonCodes: ["outside_scope"],
      addition: lateAddition,
      pendingEventId: 4,
      runState: "running",
      occurredAt: "2026-08-12T12:31:00.000Z",
    });
    expect(forgedRunState).toEqual({
      ok: false,
      error: { code: "invalid_repository_input" },
    });
    expect(JSON.stringify(forgedRunState)).not.toContain("runState");
    const pausedLate = repository.recordLateWarning({
      engagementId: engagement.id,
      actionId: "action-forge-late",
      expectedRevision: activated.value.revision,
      snapshotVersion: 1,
      snapshotBinding: queued.action.snapshots[0]?.binding,
      reasonCodes: ["outside_scope"],
      addition: lateAddition,
      pendingEventId: 4,
      occurredAt: "2026-08-12T12:32:00.000Z",
    });
    expect(pausedLate).toMatchObject({
      ok: true,
      value: { action: { state: "active_paused_for_warning" } },
    });
  });

  it("persists and reloads a capability error without a queued snapshot", () => {
    const { repository } = createFixture();
    const engagement = createEngagement(repository);
    const snapshot = boundSnapshot({
      actionId: "action-capability",
      snapshotId: "snapshot-capability",
    });
    const persisted = persistPlan(repository, engagement.id, snapshot, {
      representable: false,
      capabilityErrorCode: "required_resolution_unavailable",
    });
    expect(persisted.action).toMatchObject({
      state: "capability_error",
      queuedSnapshotVersion: null,
      capabilityErrorCode: "required_resolution_unavailable",
      warningAcknowledgment: null,
    });
    expect(repository.getAction(engagement.id, "action-capability")).toEqual({
      ok: true,
      value: persisted,
    });
    expect(
      repository.continueAction({
        engagementId: engagement.id,
        actionId: "action-capability",
        expectedRevision: persisted.revision,
        snapshotVersion: 1,
        snapshotBinding: snapshot.binding,
        occurredAt: "2026-08-12T12:33:00.000Z",
      }),
    ).toEqual({
      ok: false,
      error: { code: "capability_error_not_overridable" },
    });
  });

  it("cancels persisted paused-for-warning and queued actions", () => {
    const { repository } = createFixture();
    const engagement = createEngagement(repository);

    const paused = persistPlan(
      repository,
      engagement.id,
      boundSnapshot({
        actionId: "action-cancel-paused",
        snapshotId: "snapshot-cancel-paused",
        warningState: {
          reasonCodes: ["outside_scope"],
          knownAdditions: [],
          acknowledgment: null,
        },
      }),
    );
    expect(paused.action.state).toBe("paused_for_warning");
    expect(
      repository.cancelAction({
        engagementId: engagement.id,
        actionId: "action-cancel-paused",
        expectedRevision: paused.revision,
      }),
    ).toMatchObject({
      ok: true,
      value: {
        action: {
          state: "cancelled",
          pendingWarning: null,
          queuedSnapshotVersion: null,
        },
      },
    });
    expect(repository.getAction(engagement.id, "action-cancel-paused")).toMatchObject({
      ok: true,
      value: { action: { state: "cancelled", pendingWarning: null } },
    });

    const queued = persistPlan(
      repository,
      engagement.id,
      boundSnapshot({
        actionId: "action-cancel-queued",
        snapshotId: "snapshot-cancel-queued",
      }),
    );
    expect(queued.action.state).toBe("queued");
    expect(
      repository.cancelAction({
        engagementId: engagement.id,
        actionId: "action-cancel-queued",
        expectedRevision: queued.revision,
      }),
    ).toMatchObject({
      ok: true,
      value: { action: { state: "cancelled", queuedSnapshotVersion: 1 } },
    });
    expect(repository.getAction(engagement.id, "action-cancel-queued")).toMatchObject({
      ok: true,
      value: { action: { state: "cancelled" } },
    });
  });

  it("reloads retry context from a failed queued action", () => {
    const { database, repository } = createFixture();
    const engagement = createEngagement(repository);
    const snapshot = boundSnapshot({
      actionId: "action-failed-retry",
      snapshotId: "snapshot-failed-retry",
      warningState: {
        reasonCodes: ["outside_scope"],
        knownAdditions: [],
        acknowledgment: null,
      },
    });
    const paused = persistPlan(repository, engagement.id, snapshot);
    const queued = repository.continueAction({
      engagementId: engagement.id,
      actionId: "action-failed-retry",
      expectedRevision: paused.revision,
      snapshotVersion: 1,
      snapshotBinding: snapshot.binding,
      occurredAt: "2026-08-12T12:34:00.000Z",
    });
    if (!queued.ok) throw new Error(queued.error.code);
    database.sqlite
      .prepare("update actions set state = 'failed' where id = ?")
      .run("action-failed-retry");
    const reloaded = repository.getAction(engagement.id, "action-failed-retry");
    if (!reloaded.ok) throw new Error(reloaded.error.code);
    expect(reloaded.value.action.state).toBe("failed");
    expect(repository.retryActionContext(engagement.id, "action-failed-retry")).toEqual({
      ok: true,
      value: {
        actionId: "action-failed-retry",
        snapshotId: "snapshot-failed-retry",
        snapshotVersion: 1,
        snapshotBinding: snapshot.binding,
        warningAcknowledgment: reloaded.value.action.warningAcknowledgment,
        warningAcknowledgmentId: reloaded.value.warningAcknowledgmentId,
        resolutionRefreshed: false,
        newWarningBudget: false,
      },
    });
  });

  it("reloads late-warning acknowledgment covered destinations from stored deltas", () => {
    const { database, repository } = createFixture();
    const engagement = createEngagement(repository);
    const snapshot = boundSnapshot({
      actionId: "action-reload-covered",
      snapshotId: "snapshot-reload-covered",
    });
    const queued = persistPlan(repository, engagement.id, snapshot);
    const activated = repository.activateAction({
      engagementId: engagement.id,
      actionId: "action-reload-covered",
      expectedRevision: queued.revision,
    });
    if (!activated.ok) throw new Error(activated.error.code);
    const paused = repository.recordLateWarning({
      engagementId: engagement.id,
      actionId: "action-reload-covered",
      expectedRevision: activated.value.revision,
      snapshotVersion: 1,
      snapshotBinding: snapshot.binding,
      reasonCodes: ["outside_scope"],
      addition: lateAddition,
      pendingEventId: 1,
      occurredAt: "2026-08-12T12:35:00.000Z",
    });
    if (!paused.ok) throw new Error(paused.error.code);
    const continued = repository.continueLateWarning({
      engagementId: engagement.id,
      actionId: "action-reload-covered",
      expectedRevision: paused.value.revision,
      snapshotVersion: 1,
      snapshotBinding: snapshot.binding,
      pendingEventId: 1,
      occurredAt: "2026-08-12T12:36:00.000Z",
    });
    if (!continued.ok) throw new Error(continued.error.code);
    const second = {
      hostname: "cdn.target.test",
      address: "192.0.2.50",
    } as const;
    const covered = repository.recordLateWarning({
      engagementId: engagement.id,
      actionId: "action-reload-covered",
      expectedRevision: continued.value.revision,
      snapshotVersion: 1,
      snapshotBinding: snapshot.binding,
      reasonCodes: ["outside_scope", "risk_tier_t2"],
      addition: second,
      pendingEventId: 2,
      occurredAt: "2026-08-12T12:37:00.000Z",
    });
    if (!covered.ok) throw new Error(covered.error.code);

    const storedReasons = database.sqlite
      .prepare(
        "select sequence, reason_codes_json from action_covered_destinations where action_id = ? order by sequence",
      )
      .all("action-reload-covered") as {
      sequence: number;
      reason_codes_json: string;
    }[];
    expect(storedReasons.map((row) => JSON.parse(row.reason_codes_json))).toEqual([
      [],
      ["risk_tier_t2"],
    ]);

    expect(repository.getAction(engagement.id, "action-reload-covered")).toEqual({
      ok: true,
      value: covered.value,
    });
    expect(covered.value.action.warningAcknowledgment).toMatchObject({
      reasonCodes: ["outside_scope", "risk_tier_t2"],
      coveredDestinations: [second],
    });
    expect(covered.value.action.coveredDestinations).toEqual([lateAddition, second]);
  });

  it("rejects add-scope against a prior owned revision instead of the active one", () => {
    const { repository } = createFixture();
    const engagement = createEngagement(repository);
    const firstScope = repository.appendScopeRevision({
      engagementId: engagement.id,
      expectedRevision: 1,
      rules: [],
    });
    if (!firstScope.ok) throw new Error(firstScope.error.code);
    const paused = persistPlan(
      repository,
      engagement.id,
      boundSnapshot({
        actionId: "action-stale-scope",
        snapshotId: "snapshot-stale-scope",
        scopeRevisionId: firstScope.value.id,
        warningState: {
          reasonCodes: ["outside_scope"],
          knownAdditions: [],
          acknowledgment: null,
        },
      }),
    );
    const secondScope = repository.appendScopeRevision({
      engagementId: engagement.id,
      expectedRevision: 2,
      rules: [],
    });
    if (!secondScope.ok) throw new Error(secondScope.error.code);
    expect(
      repository.addScopeAndRunAction({
        engagementId: engagement.id,
        actionId: "action-stale-scope",
        expectedRevision: paused.revision,
        recheckedSnapshot: boundSnapshot({
          actionId: "action-stale-scope",
          snapshotId: "snapshot-stale-scope-2",
          version: 2,
          scopeRevisionId: firstScope.value.id,
          warningState: {
            reasonCodes: ["large_target_set"],
            knownAdditions: [],
            acknowledgment: null,
          },
        }),
        occurredAt: "2026-08-12T12:38:00.000Z",
      }),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
    expect(repository.getAction(engagement.id, "action-stale-scope")).toMatchObject({
      ok: true,
      value: {
        revision: paused.revision,
        action: {
          state: "paused_for_warning",
          queuedSnapshotVersion: null,
          snapshots: [{ version: 1, scopeRevisionId: firstScope.value.id }],
        },
      },
    });
  });

  it("requires persistPlannedAction to bind the current active scope revision", () => {
    const { database, repository } = createFixture();
    const engagement = createEngagement(repository);
    const marker = "UNTRUSTED_SCOPE_BINDING_MARKER";

    const nullToNull = persistPlan(
      repository,
      engagement.id,
      boundSnapshot({
        actionId: "action-null-to-null",
        snapshotId: "snapshot-null-to-null",
      }),
    );
    expect(nullToNull.action.snapshots[0]?.scopeRevisionId).toBeNull();

    expect(
      repository.updateAutoContinueWarnings(engagement.id, 1, true),
    ).toMatchObject({ ok: true });
    const unowned = repository.persistPlannedAction({
      engagementId: engagement.id,
      snapshot: boundSnapshot({
        actionId: "action-unowned-scope",
        snapshotId: "snapshot-unowned-scope",
        scopeRevisionId: "20000000-0000-4000-8000-0000000000aa",
        typedOptions: { note: marker },
        warningState: {
          reasonCodes: ["outside_scope"],
          knownAdditions: [],
          acknowledgment: null,
        },
      }),
      representable: true,
      capabilityErrorCode: null,
      occurredAt: "2026-08-12T12:40:00.000Z",
    });
    expect(unowned).toEqual({
      ok: false,
      error: { code: "invalid_repository_input" },
    });
    expect(JSON.stringify(unowned)).not.toContain(marker);
    expectNoPersistedAction(
      database,
      repository,
      "action-unowned-scope",
      engagement.id,
    );

    const firstScope = repository.appendScopeRevision({
      engagementId: engagement.id,
      expectedRevision: 2,
      rules: [],
    });
    if (!firstScope.ok) throw new Error(firstScope.error.code);

    const matching = persistPlan(
      repository,
      engagement.id,
      boundSnapshot({
        actionId: "action-matching-scope",
        snapshotId: "snapshot-matching-scope",
        scopeRevisionId: firstScope.value.id,
      }),
    );
    expect(matching.action.snapshots[0]?.scopeRevisionId).toBe(firstScope.value.id);

    const nullWhileActive = repository.persistPlannedAction({
      engagementId: engagement.id,
      snapshot: boundSnapshot({
        actionId: "action-null-while-active",
        snapshotId: "snapshot-null-while-active",
        scopeRevisionId: null,
        typedOptions: { note: marker },
        warningState: {
          reasonCodes: ["outside_scope"],
          knownAdditions: [],
          acknowledgment: null,
        },
      }),
      representable: true,
      capabilityErrorCode: null,
      occurredAt: "2026-08-12T12:41:00.000Z",
    });
    expect(nullWhileActive).toEqual({
      ok: false,
      error: { code: "invalid_repository_input" },
    });
    expect(JSON.stringify(nullWhileActive)).not.toContain(marker);
    expectNoPersistedAction(
      database,
      repository,
      "action-null-while-active",
      engagement.id,
    );

    const secondScope = repository.appendScopeRevision({
      engagementId: engagement.id,
      expectedRevision: 3,
      rules: [],
    });
    if (!secondScope.ok) throw new Error(secondScope.error.code);

    const stale = repository.persistPlannedAction({
      engagementId: engagement.id,
      snapshot: boundSnapshot({
        actionId: "action-stale-owned-scope",
        snapshotId: "snapshot-stale-owned-scope",
        scopeRevisionId: firstScope.value.id,
        typedOptions: { note: marker },
        warningState: {
          reasonCodes: ["outside_scope"],
          knownAdditions: [],
          acknowledgment: null,
        },
      }),
      representable: true,
      capabilityErrorCode: null,
      occurredAt: "2026-08-12T12:42:00.000Z",
    });
    expect(stale).toEqual({
      ok: false,
      error: { code: "invalid_repository_input" },
    });
    expect(JSON.stringify(stale)).not.toContain(marker);
    expect(JSON.stringify(stale)).not.toContain(firstScope.value.id);
    expectNoPersistedAction(
      database,
      repository,
      "action-stale-owned-scope",
      engagement.id,
    );
  });

  it("rejects stored snapshot JSON over the 1 MiB bound as invalid input", () => {
    const { repository } = createFixture();
    const engagement = createEngagement(repository);
    const seed = boundSnapshot({
      actionId: "action-oversize",
      snapshotId: "snapshot-oversize",
      typedOptions: { pad: "" },
    });
    const pad = "n".repeat(
      MAX_CANONICAL_JSON_BYTES - Buffer.byteLength(JSON.stringify(seed), "utf8") + 1,
    );
    const snapshot = boundSnapshot({
      actionId: "action-oversize",
      snapshotId: "snapshot-oversize",
      typedOptions: { pad },
    });
    const bound = bindActionSnapshot(snapshot);
    expect(bound.ok).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBeGreaterThan(
      MAX_CANONICAL_JSON_BYTES,
    );
    const result = repository.persistPlannedAction({
      engagementId: engagement.id,
      snapshot,
      representable: true,
      capabilityErrorCode: null,
      occurredAt: "2026-08-12T12:39:00.000Z",
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "invalid_repository_input" },
    });
    expect(JSON.stringify(result)).not.toContain(pad.slice(0, 32));
    expect(repository.getAction(engagement.id, "action-oversize")).toEqual({
      ok: false,
      error: { code: "action_not_found" },
    });
  });
});
