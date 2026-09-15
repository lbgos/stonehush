import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  bindPlannedSnapshot,
  derivePlanningWarningState,
} from "./action-operator.js";
import { openEngagementDatabase } from "./database.js";
import { EngagementRepository } from "./repository.js";

const IDS = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
  "10000000-0000-4000-8000-000000000004",
  "10000000-0000-4000-8000-000000000005",
  "10000000-0000-4000-8000-000000000006",
  "10000000-0000-4000-8000-000000000007",
  "10000000-0000-4000-8000-000000000008",
] as const;

const fixtures: Array<{
  directory: string;
  database: ReturnType<typeof openEngagementDatabase>;
}> = [];

function createFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "stonehush-action-operator-"));
  chmodSync(directory, 0o700);
  const database = openEngagementDatabase({ dataDirectory: directory });
  let idIndex = 0;
  let clockTick = 0;
  const repository = new EngagementRepository(database.db, {
    createId: () => IDS[idIndex++] ?? "10000000-0000-4000-8000-000000000099",
    now: () => new Date(Date.UTC(2026, 7, 12, 12, clockTick++)),
  });
  fixtures.push({ directory, database });
  return { directory, database, repository };
}

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture === undefined) continue;
    if (fixture.database.sqlite.open) fixture.database.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

describe("operator action planning", () => {
  it("distinguishes a null scope from an active empty revision", () => {
    const { repository } = createFixture();
    const engagement = repository.createEngagement({
      name: "Target lab",
      kind: "lab",
      autoContinueWarnings: false,
    });
    if (!engagement.ok) throw new Error(engagement.error.code);

    const noScope = repository.planOperatorAction(engagement.value.id, {
      expectedEngagementRevision: 1,
      expectedActiveScopeRevisionId: null,
      targets: ["192.0.2.10"],
    });
    expect(noScope).toMatchObject({
      ok: true,
      value: {
        action: {
          state: "queued",
          snapshots: [{ scopeRevisionId: null, warningState: { reasonCodes: [] } }],
        },
      },
    });

    const empty = repository.appendScopeRevision({
      engagementId: engagement.value.id,
      expectedRevision: 1,
      rules: [],
    });
    if (!empty.ok) throw new Error(empty.error.code);
    expect(
      repository.planOperatorAction(engagement.value.id, {
        expectedEngagementRevision: 2,
        expectedActiveScopeRevisionId: null,
        targets: ["192.0.2.11"],
      }),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });

    const paused = repository.planOperatorAction(engagement.value.id, {
      expectedEngagementRevision: 2,
      expectedActiveScopeRevisionId: empty.value.id,
      targets: ["192.0.2.11"],
    });
    expect(paused).toMatchObject({
      ok: true,
      value: {
        action: {
          state: "paused_for_warning",
          snapshots: [
            {
              scopeRevisionId: empty.value.id,
              warningState: { reasonCodes: ["outside_scope"] },
            },
          ],
        },
      },
    });
  });

  it("adds one scope revision and snapshot version 2 atomically", () => {
    const { repository } = createFixture();
    const engagement = repository.createEngagement({
      name: "Target lab",
      kind: "lab",
      autoContinueWarnings: false,
    });
    if (!engagement.ok) throw new Error(engagement.error.code);
    const empty = repository.appendScopeRevision({
      engagementId: engagement.value.id,
      expectedRevision: 1,
      rules: [],
    });
    if (!empty.ok) throw new Error(empty.error.code);
    const paused = repository.planOperatorAction(engagement.value.id, {
      expectedEngagementRevision: 2,
      expectedActiveScopeRevisionId: empty.value.id,
      targets: ["192.0.2.20"],
    });
    if (!paused.ok) throw new Error(paused.error.code);

    const stale = repository.addScopeAndRunOperatorAction(
      engagement.value.id,
      paused.value.action.actionId,
      {
        expectedEngagementRevision: 1,
        expectedActionRevision: paused.value.revision,
        rules: [
          {
            id: "reserved-ip",
            kind: "ip",
            target: {
              kind: "ip",
              normalizationProfile: "d1-v1",
              family: 4,
              address: "192.0.2.20",
              zone: null,
            },
          },
        ],
      },
    );
    expect(stale).toMatchObject({
      ok: false,
      error: { code: "revision_conflict", resourceType: "engagement" },
    });
    expect(repository.listScopeRevisions(engagement.value.id)).toMatchObject({
      ok: true,
      value: [{ version: 1, id: empty.value.id }],
    });

    const added = repository.addScopeAndRunOperatorAction(
      engagement.value.id,
      paused.value.action.actionId,
      {
        expectedEngagementRevision: 2,
        expectedActionRevision: paused.value.revision,
        rules: [
          {
            id: "reserved-ip",
            kind: "ip",
            target: {
              kind: "ip",
              normalizationProfile: "d1-v1",
              family: 4,
              address: "192.0.2.20",
              zone: null,
            },
          },
        ],
      },
    );
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
    if (!added.ok) throw new Error("expected add-scope success");
    expect(added.value.action.snapshots).toHaveLength(2);
    expect(repository.listScopeRevisions(engagement.value.id)).toMatchObject({
      ok: true,
      value: [{ version: 1 }, { version: 2 }],
    });
  });

  it("returns action_already_queued only while queued", () => {
    const { repository } = createFixture();
    const engagement = repository.createEngagement({
      name: "Target lab",
      kind: "lab",
      autoContinueWarnings: false,
    });
    if (!engagement.ok) throw new Error(engagement.error.code);
    const queued = repository.planOperatorAction(engagement.value.id, {
      expectedEngagementRevision: 1,
      expectedActiveScopeRevisionId: null,
      targets: ["192.0.2.10"],
    });
    if (!queued.ok) throw new Error(queued.error.code);
    expect(queued.value.action.state).toBe("queued");
    expect(
      repository.addScopeAndRunOperatorAction(
        engagement.value.id,
        queued.value.action.actionId,
        {
          expectedEngagementRevision: 1,
          expectedActionRevision: queued.value.revision,
          rules: [],
        },
      ),
    ).toEqual({ ok: false, error: { code: "action_already_queued" } });
  });

  it("returns invalid_action_transition for terminal add-scope requests", () => {
    const { repository } = createFixture();
    const engagement = repository.createEngagement({
      name: "Target lab",
      kind: "lab",
      autoContinueWarnings: false,
    });
    if (!engagement.ok) throw new Error(engagement.error.code);
    const empty = repository.appendScopeRevision({
      engagementId: engagement.value.id,
      expectedRevision: 1,
      rules: [],
    });
    if (!empty.ok) throw new Error(empty.error.code);
    const paused = repository.planOperatorAction(engagement.value.id, {
      expectedEngagementRevision: 2,
      expectedActiveScopeRevisionId: empty.value.id,
      targets: ["192.0.2.10"],
    });
    if (!paused.ok) throw new Error(paused.error.code);
    const cancelledPaused = repository.cancelAction({
      engagementId: engagement.value.id,
      actionId: paused.value.action.actionId,
      expectedRevision: paused.value.revision,
    });
    if (!cancelledPaused.ok) throw new Error(cancelledPaused.error.code);
    expect(
      repository.addScopeAndRunOperatorAction(
        engagement.value.id,
        paused.value.action.actionId,
        {
          expectedEngagementRevision: 2,
          expectedActionRevision: cancelledPaused.value.revision,
          rules: [],
        },
      ),
    ).toEqual({ ok: false, error: { code: "invalid_action_transition" } });

    const noScope = repository.planOperatorAction(engagement.value.id, {
      expectedEngagementRevision: 2,
      expectedActiveScopeRevisionId: empty.value.id,
      targets: ["192.0.2.11"],
    });
    if (!noScope.ok) throw new Error(noScope.error.code);
    const queuedBinding = noScope.value.action.snapshots[0]?.binding;
    if (queuedBinding === undefined) {
      throw new Error("expected queued snapshot binding");
    }
    const continued = repository.continueAction({
      engagementId: engagement.value.id,
      actionId: noScope.value.action.actionId,
      expectedRevision: noScope.value.revision,
      snapshotVersion: 1,
      snapshotBinding: queuedBinding,
      occurredAt: "2026-08-12T12:30:00.000Z",
    });
    if (!continued.ok) throw new Error(continued.error.code);
    const cancelledQueued = repository.cancelAction({
      engagementId: engagement.value.id,
      actionId: noScope.value.action.actionId,
      expectedRevision: continued.value.revision,
    });
    if (!cancelledQueued.ok) throw new Error(cancelledQueued.error.code);
    expect(cancelledQueued.value.action.queuedSnapshotVersion).toBe(1);
    expect(
      repository.addScopeAndRunOperatorAction(
        engagement.value.id,
        noScope.value.action.actionId,
        {
          expectedEngagementRevision: 2,
          expectedActionRevision: cancelledQueued.value.revision,
          rules: [],
        },
      ),
    ).toEqual({ ok: false, error: { code: "invalid_action_transition" } });
  });

  it("commits an empty add-scope revision, retains outside_scope, and queues once", () => {
    const { repository } = createFixture();
    const engagement = repository.createEngagement({
      name: "Target lab",
      kind: "lab",
      autoContinueWarnings: false,
    });
    if (!engagement.ok) throw new Error(engagement.error.code);
    const empty = repository.appendScopeRevision({
      engagementId: engagement.value.id,
      expectedRevision: 1,
      rules: [],
    });
    if (!empty.ok) throw new Error(empty.error.code);
    const paused = repository.planOperatorAction(engagement.value.id, {
      expectedEngagementRevision: 2,
      expectedActiveScopeRevisionId: empty.value.id,
      targets: ["192.0.2.10"],
    });
    if (!paused.ok) throw new Error(paused.error.code);
    const added = repository.addScopeAndRunOperatorAction(
      engagement.value.id,
      paused.value.action.actionId,
      {
        expectedEngagementRevision: 2,
        expectedActionRevision: paused.value.revision,
        rules: [],
      },
    );
    expect(added).toMatchObject({
      ok: true,
      value: {
        action: {
          state: "queued",
          queuedSnapshotVersion: 2,
          pendingWarning: null,
          warningAcknowledgment: { source: "add_scope_and_run" },
        },
      },
    });
    if (!added.ok) throw new Error("expected add-scope success");
    expect(added.value.action.snapshots).toHaveLength(2);
    expect(added.value.action.snapshots[1]).toMatchObject({
      version: 2,
      warningState: { reasonCodes: ["outside_scope"] },
    });
    expect(added.value.action.snapshots[1]?.scopeRevisionId).not.toBe(
      empty.value.id,
    );
    expect(repository.listScopeRevisions(engagement.value.id)).toMatchObject({
      ok: true,
      value: [
        { version: 1, rules: [] },
        { version: 2, rules: [] },
      ],
    });
  });
});

describe("numeric-IP URL target facts", () => {
  const reservedIp = {
    kind: "ip" as const,
    normalizationProfile: "d1-v1" as const,
    family: 4 as const,
    address: "192.0.2.10",
    zone: null,
  };

  it("counts an IP URL and equivalent direct IP once and ignores hostname URLs", () => {
    const { repository } = createFixture();
    const engagement = repository.createEngagement({
      name: "Target lab",
      kind: "lab",
      autoContinueWarnings: false,
    });
    if (!engagement.ok) throw new Error(engagement.error.code);
    const planned = repository.planOperatorAction(engagement.value.id, {
      expectedEngagementRevision: 1,
      expectedActiveScopeRevisionId: null,
      targets: [
        "https://192.0.2.10/a",
        "192.0.2.10",
        "https://192.0.2.10/b",
        "https://app.target.test/path",
      ],
    });
    expect(planned).toMatchObject({
      ok: true,
      value: {
        action: {
          snapshots: [
            {
              concreteDestinations: [reservedIp],
              warningState: { reasonCodes: [] },
            },
          ],
        },
      },
    });
  });

  it("preserves compact CIDR cardinality when an IP URL is already covered", () => {
    const warning = derivePlanningWarningState({
      actionId: "10000000-0000-4000-8000-000000000001",
      scopeRevisionId: null,
      rules: [],
      targets: [
        {
          kind: "cidr",
          normalizationProfile: "d1-v1",
          family: 4,
          network: "192.0.2.0",
          prefixLength: 24,
          hostBitsMasked: false,
        },
        {
          kind: "url",
          normalizationProfile: "d1-v1",
          url: "https://192.0.2.10/",
          origin: "https://192.0.2.10:443",
          host: { address: "192.0.2.10", zone: null },
          effectivePort: 443,
          pathAndQuery: "/",
        },
      ],
      declaredPorts: null,
    });
    expect(warning).toEqual({
      ok: true,
      value: { reasonCodes: [], knownAdditions: [] },
    });
    const snapshot = bindPlannedSnapshot({
      actionId: "10000000-0000-4000-8000-000000000001",
      snapshotId: "10000000-0000-4000-8000-000000000002",
      version: 1,
      scopeRevisionId: null,
      targets: [
        {
          kind: "cidr",
          normalizationProfile: "d1-v1",
          family: 4,
          network: "192.0.2.0",
          prefixLength: 24,
          hostBitsMasked: false,
        },
        {
          kind: "url",
          normalizationProfile: "d1-v1",
          url: "https://192.0.2.10/",
          origin: "https://192.0.2.10:443",
          host: { address: "192.0.2.10", zone: null },
          effectivePort: 443,
          pathAndQuery: "/",
        },
      ],
      typedOptions: { declaredPorts: null },
      resolutionSnapshots: [],
      warningState: { reasonCodes: [], knownAdditions: [] },
    });
    expect(snapshot).toMatchObject({
      ok: true,
      value: { concreteDestinations: [reservedIp] },
    });
  });

  it("warns when distinct numeric-IP URL hosts saturate concrete cardinality", () => {
    const targets = Array.from({ length: 4_097 }, (_, index) => {
      const high = Math.floor(index / 256);
      const low = index % 256;
      const address = `198.18.${high}.${low}`;
      return {
        kind: "url" as const,
        normalizationProfile: "d1-v1" as const,
        url: `http://${address}/`,
        origin: `http://${address}:80`,
        host: { address, zone: null },
        effectivePort: 80,
        pathAndQuery: "/",
      };
    });
    expect(
      derivePlanningWarningState({
        actionId: "10000000-0000-4000-8000-000000000001",
        scopeRevisionId: null,
        rules: [],
        targets,
        declaredPorts: null,
      }),
    ).toEqual({
      ok: true,
      value: {
        reasonCodes: ["large_target_set"],
        knownAdditions: [{ estimatedConcreteTargets: 4_097 }],
      },
    });
  });
});
