import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  bindActionSnapshot,
  EngagementRepository,
  OperatorCommandRepository,
  openEngagementDatabase,
} from "@stonehush/db";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

const directories: string[] = [];
const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
  await Promise.all(
    directories.splice(0).map(async (directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "stonehush-action-api-"));
  directories.push(directory);
  await chmod(directory, 0o700);
  const database = openEngagementDatabase({ dataDirectory: directory });
  let nextId = 1;
  let minute = 0;
  const engagementRepository = new EngagementRepository(database.db, {
    createId: () =>
      `10000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
    now: () => new Date(Date.UTC(2026, 7, 12, 12, minute++)),
  });
  const operatorCommandRepository = new OperatorCommandRepository(
    engagementRepository,
    { now: () => new Date("2026-08-12T13:00:00.000Z") },
  );
  const app = buildApp({
    engagementRepository,
    operatorCommandRepository,
    getDevelopmentStorageReadiness: () => "ready",
  });
  app.addHook("onClose", async () => database.close());
  apps.push(app);
  return { app, database, engagementRepository };
}

const headers = (key: string) => ({ "idempotency-key": key });
const key = (suffix: string) => `fixture-idempotency-${suffix.padEnd(12, "0")}`;

const reservedIpRule = {
  id: "reserved-ip",
  kind: "ip" as const,
  target: {
    kind: "ip" as const,
    normalizationProfile: "d1-v1" as const,
    family: 4 as const,
    address: "192.0.2.20",
    zone: null,
  },
};

const lateScopeRule = {
  id: "late-ip",
  kind: "ip" as const,
  target: {
    kind: "ip" as const,
    normalizationProfile: "d1-v1" as const,
    family: 4 as const,
    address: "192.0.2.10",
    zone: null,
  },
};

async function createEngagement(
  app: ReturnType<typeof buildApp>,
  autoContinueWarnings = false,
  keySuffix?: string,
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/engagements",
    headers: headers(key(keySuffix ?? `eng-${autoContinueWarnings ? "auto" : "man"}`)),
    payload: {
      name: "Target lab",
      kind: "lab",
      autoContinueWarnings,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

describe("action query and mutation routes", () => {
  it("plans, reads, continues, and leaves saved scope unchanged", async () => {
    const { app } = await fixture();
    const engagement = await createEngagement(app);
    const base = `/api/v1/engagements/${engagement.id}`;
    const scope = (
      await app.inject({
        method: "POST",
        url: `${base}/scope-revisions`,
        headers: headers(key("empty-scope")),
        payload: { expectedRevision: 1, rules: [] },
      })
    ).json();

    const planned = await app.inject({
      method: "POST",
      url: `${base}/actions`,
      headers: headers(key("plan-out")),
      payload: {
        expectedEngagementRevision: 2,
        expectedActiveScopeRevisionId: scope.id,
        targets: ["192.0.2.10"],
      },
    });
    expect(planned.statusCode).toBe(201);
    const action = planned.json();
    expect(action.action.state).toBe("paused_for_warning");
    expect(action.action.warningAcknowledgment).toBeNull();
    expect(action.action.snapshots[0]?.scopeRevisionId).toBe(scope.id);
    expect(action.action.snapshots[0]?.warningState.reasonCodes).toEqual([
      "outside_scope",
    ]);
    expect(action.action.snapshots[0]?.resolutionSnapshots).toEqual([]);

    const read = await app.inject({
      method: "GET",
      url: `${base}/actions/${action.action.actionId}`,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(action);

    const continued = await app.inject({
      method: "POST",
      url: `${base}/actions/${action.action.actionId}/continue`,
      headers: headers(key("continue")),
      payload: {
        expectedRevision: action.revision,
        snapshotVersion: 1,
        snapshotBinding: action.action.snapshots[0].binding,
      },
    });
    expect(continued.statusCode).toBe(200);
    expect(continued.json().action).toMatchObject({
      state: "queued",
      queuedSnapshotVersion: 1,
      warningAcknowledgment: { source: "operator_continue" },
    });

    const detail = await app.inject({ method: "GET", url: base });
    expect(detail.json()).toMatchObject({
      engagement: { activeScopeRevisionId: scope.id, revision: 2 },
      activeScopeRevision: { id: scope.id, rules: [] },
    });
  });

  it("replays exact Continue after later cancel and conflicts on a changed digest", async () => {
    const { app } = await fixture();
    const engagement = await createEngagement(app);
    const base = `/api/v1/engagements/${engagement.id}`;
    const scope = (
      await app.inject({
        method: "POST",
        url: `${base}/scope-revisions`,
        headers: headers(key("scope-replay")),
        payload: { expectedRevision: 1, rules: [] },
      })
    ).json();
    const planned = (
      await app.inject({
        method: "POST",
        url: `${base}/actions`,
        headers: headers(key("plan-replay")),
        payload: {
          expectedEngagementRevision: 2,
          expectedActiveScopeRevisionId: scope.id,
          targets: ["app.target.test"],
        },
      })
    ).json();
    const continueRequest = {
      method: "POST" as const,
      url: `${base}/actions/${planned.action.actionId}/continue`,
      headers: headers(key("continue-replay")),
      payload: {
        expectedRevision: planned.revision,
        snapshotVersion: 1,
        snapshotBinding: planned.action.snapshots[0].binding,
      },
    };
    const first = await app.inject(continueRequest);
    expect(first.statusCode).toBe(200);
    await app.inject({
      method: "POST",
      url: `${base}/actions/${planned.action.actionId}/cancel`,
      headers: headers(key("cancel-after")),
      payload: { expectedRevision: first.json().revision },
    });
    const replay = await app.inject(continueRequest);
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toBe(first.body);
    const conflict = await app.inject({
      ...continueRequest,
      payload: {
        ...continueRequest.payload,
        expectedRevision: 99,
      },
    });
    expect(conflict).toMatchObject({
      statusCode: 409,
      body: '{"code":"idempotency_conflict"}',
    });
  });

  it("replays omitted declaredPorts and strips unknown action fields from the digest", async () => {
    const { app, database } = await fixture();
    const engagement = await createEngagement(app);
    const base = `/api/v1/engagements/${engagement.id}`;
    const planKey = key("plan-ports");
    const omittedPorts = {
      expectedEngagementRevision: 1,
      expectedActiveScopeRevisionId: null,
      targets: ["192.0.2.10"],
    };
    const planned = await app.inject({
      method: "POST",
      url: `${base}/actions`,
      headers: headers(planKey),
      payload: omittedPorts,
    });
    expect(planned.statusCode).toBe(201);
    expect(
      await app.inject({
        method: "POST",
        url: `${base}/actions`,
        headers: headers(planKey),
        payload: { ...omittedPorts, declaredPorts: null },
      }),
    ).toMatchObject({ statusCode: 201, body: planned.body });
    expect(
      await app.inject({
        method: "POST",
        url: `${base}/actions?ignored=true`,
        headers: headers(planKey),
        payload: { ...omittedPorts, extra: true },
      }),
    ).toMatchObject({ statusCode: 201, body: planned.body });
    expect(
      await app.inject({
        method: "POST",
        url: `${base}/actions`,
        headers: headers(planKey),
        payload: { ...omittedPorts, declaredPorts: [80], extra: true },
      }),
    ).toMatchObject({ statusCode: 409, body: '{"code":"idempotency_conflict"}' });

    const unknownPlanKey = key("plan-unknown");
    const unknownPlan = await app.inject({
      method: "POST",
      url: `${base}/actions`,
      headers: headers(unknownPlanKey),
      payload: { ...omittedPorts, extra: true, targets: ["192.0.2.11"] },
    });
    expect(unknownPlan).toMatchObject({
      statusCode: 400,
      body: '{"code":"invalid_request"}',
    });
    expect(
      await app.inject({
        method: "POST",
        url: `${base}/actions`,
        headers: headers(unknownPlanKey),
        payload: { ...omittedPorts, targets: ["192.0.2.11"] },
      }),
    ).toMatchObject({ statusCode: 400, body: unknownPlan.body });

    const addKey = key("add-unknown");
    const addRequest = {
      method: "POST" as const,
      url: `${base}/actions/${planned.json().action.actionId}/add-scope-and-run`,
      headers: headers(addKey),
      payload: {
        expectedEngagementRevision: 1,
        expectedActionRevision: planned.json().revision,
        extra: true,
        rules: [{ ...reservedIpRule, extra: true, target: { ...reservedIpRule.target, extra: true } }],
      },
    };
    const addedUnknown = await app.inject(addRequest);
    expect(addedUnknown).toMatchObject({
      statusCode: 400,
      body: '{"code":"invalid_request"}',
    });
    expect(
      await app.inject({
        ...addRequest,
        payload: {
          expectedEngagementRevision: 1,
          expectedActionRevision: planned.json().revision,
          rules: [reservedIpRule],
        },
      }),
    ).toMatchObject({ statusCode: 400, body: addedUnknown.body });
    expect(
      database.sqlite
        .prepare("select count(*) from actions")
        .pluck()
        .get(),
    ).toBe(1);
  });

  it("replays a stored command body that current action schemas would reject", async () => {
    const { app, database } = await fixture();
    const engagement = await createEngagement(app);
    const commandKey = key("stale-body");
    const request = {
      method: "POST" as const,
      url: `/api/v1/engagements/${engagement.id}/actions`,
      headers: headers(commandKey),
      payload: {
        expectedEngagementRevision: 1,
        expectedActiveScopeRevisionId: null,
        targets: ["192.0.2.10"],
      },
    };
    const first = await app.inject(request);
    expect(first.statusCode).toBe(201);
    database.sqlite
      .prepare(
        "update operator_command_idempotency set response_body_json = ? where idempotency_key = ?",
      )
      .run('{"stale":true}', commandKey);
    const replay = await app.inject(request);
    expect(replay).toMatchObject({
      statusCode: 201,
      body: '{"stale":true}',
    });
  });

  it("keeps a null current scope distinct from an active empty revision", async () => {
    const { app } = await fixture();
    const engagement = await createEngagement(app);
    const base = `/api/v1/engagements/${engagement.id}`;
    const queued = await app.inject({
      method: "POST",
      url: `${base}/actions`,
      headers: headers(key("plan-null")),
      payload: {
        expectedEngagementRevision: 1,
        expectedActiveScopeRevisionId: null,
        targets: ["192.0.2.10"],
      },
    });
    expect(queued.json().action).toMatchObject({
      state: "queued",
      snapshots: [{ scopeRevisionId: null, warningState: { reasonCodes: [] } }],
    });

    const scope = (
      await app.inject({
        method: "POST",
        url: `${base}/scope-revisions`,
        headers: headers(key("empty-after")),
        payload: { expectedRevision: 1, rules: [] },
      })
    ).json();
    const staleNull = await app.inject({
      method: "POST",
      url: `${base}/actions`,
      headers: headers(key("stale-null")),
      payload: {
        expectedEngagementRevision: 2,
        expectedActiveScopeRevisionId: null,
        targets: ["192.0.2.11"],
      },
    });
    expect(staleNull).toMatchObject({
      statusCode: 400,
      body: '{"code":"invalid_request"}',
    });
    const paused = await app.inject({
      method: "POST",
      url: `${base}/actions`,
      headers: headers(key("empty-active")),
      payload: {
        expectedEngagementRevision: 2,
        expectedActiveScopeRevisionId: scope.id,
        targets: ["192.0.2.11"],
      },
    });
    expect(paused.json().action).toMatchObject({
      state: "paused_for_warning",
      snapshots: [{ scopeRevisionId: scope.id }],
    });
    expect(
      (await app.inject({ method: "GET", url: `${base}/actions` })).statusCode,
    ).not.toBe(201);
  });

  it("rejects stale engagement, action, and scope context without partial writes", async () => {
    const { app, engagementRepository } = await fixture();
    const engagement = await createEngagement(app);
    const base = `/api/v1/engagements/${engagement.id}`;
    const scope = (
      await app.inject({
        method: "POST",
        url: `${base}/scope-revisions`,
        headers: headers(key("scope-stale")),
        payload: { expectedRevision: 1, rules: [] },
      })
    ).json();
    const planned = (
      await app.inject({
        method: "POST",
        url: `${base}/actions`,
        headers: headers(key("plan-stale")),
        payload: {
          expectedEngagementRevision: 2,
          expectedActiveScopeRevisionId: scope.id,
          targets: ["192.0.2.10"],
        },
      })
    ).json();

    const staleEngagement = await app.inject({
      method: "POST",
      url: `${base}/actions`,
      headers: headers(key("stale-eng")),
      payload: {
        expectedEngagementRevision: 1,
        expectedActiveScopeRevisionId: scope.id,
        targets: ["192.0.2.12"],
      },
    });
    expect(staleEngagement.statusCode).toBe(409);
    expect(staleEngagement.json()).toEqual({
      code: "revision_conflict",
      resourceType: "engagement",
      resourceId: engagement.id,
      currentRevision: 2,
    });

    const staleAction = await app.inject({
      method: "POST",
      url: `${base}/actions/${planned.action.actionId}/continue`,
      headers: headers(key("stale-act")),
      payload: {
        expectedRevision: 99,
        snapshotVersion: 1,
        snapshotBinding: planned.action.snapshots[0].binding,
      },
    });
    expect(staleAction.json()).toEqual({
      code: "revision_conflict",
      resourceType: "action",
      resourceId: planned.action.actionId,
      currentRevision: planned.revision,
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: `${base}/actions/${planned.action.actionId}`,
        })
      ).json().action.state,
    ).toBe("paused_for_warning");

    const staleAdd = await app.inject({
      method: "POST",
      url: `${base}/actions/${planned.action.actionId}/add-scope-and-run`,
      headers: headers(key("stale-add")),
      payload: {
        expectedEngagementRevision: 1,
        expectedActionRevision: planned.revision,
        rules: [reservedIpRule],
      },
    });
    expect(staleAdd.json()).toMatchObject({
      code: "revision_conflict",
      resourceType: "engagement",
      resourceId: engagement.id,
    });
    expect(engagementRepository.listScopeRevisions(engagement.id)).toMatchObject({
      ok: true,
      value: [{ id: scope.id, version: 1 }],
    });
  });

  it("adds to scope and runs once, then replays without duplicates", async () => {
    const { app, engagementRepository } = await fixture();
    const engagement = await createEngagement(app);
    const base = `/api/v1/engagements/${engagement.id}`;
    const scope = (
      await app.inject({
        method: "POST",
        url: `${base}/scope-revisions`,
        headers: headers(key("scope-add")),
        payload: { expectedRevision: 1, rules: [] },
      })
    ).json();
    const planned = (
      await app.inject({
        method: "POST",
        url: `${base}/actions`,
        headers: headers(key("plan-add")),
        payload: {
          expectedEngagementRevision: 2,
          expectedActiveScopeRevisionId: scope.id,
          targets: ["192.0.2.20"],
        },
      })
    ).json();
    const addRequest = {
      method: "POST" as const,
      url: `${base}/actions/${planned.action.actionId}/add-scope-and-run`,
      headers: headers(key("add-run")),
      payload: {
        expectedEngagementRevision: 2,
        expectedActionRevision: planned.revision,
        rules: [reservedIpRule],
      },
    };
    const added = await app.inject(addRequest);
    expect(added.statusCode).toBe(200);
    expect(added.json().action).toMatchObject({
      state: "queued",
      queuedSnapshotVersion: 2,
      warningAcknowledgment: { source: "add_scope_and_run" },
    });
    expect(added.json().action.snapshots).toHaveLength(2);
    expect(added.json().action.snapshots[1].scopeRevisionId).not.toBe(scope.id);
    expect(added.json().action.snapshots[1].warningState.reasonCodes).toEqual([]);

    await app.inject({
      method: "POST",
      url: `${base}/actions/${planned.action.actionId}/cancel`,
      headers: headers(key("cancel-queued")),
      payload: { expectedRevision: added.json().revision },
    });
    const replay = await app.inject(addRequest);
    expect(replay.body).toBe(added.body);
    expect(engagementRepository.listScopeRevisions(engagement.id)).toMatchObject({
      ok: true,
      value: [{ version: 1 }, { version: 2 }],
    });
    const conflict = await app.inject({
      ...addRequest,
      payload: { ...addRequest.payload, rules: [] },
    });
    expect(conflict).toMatchObject({
      statusCode: 409,
      body: '{"code":"idempotency_conflict"}',
    });
    expect(engagementRepository.listScopeRevisions(engagement.id)).toMatchObject({
      ok: true,
      value: [{ version: 1 }, { version: 2 }],
    });
  });

  it("add-scope-and-run may commit an empty revision, retain outside_scope, and queue once", async () => {
    const { app, engagementRepository } = await fixture();
    const engagement = await createEngagement(app);
    const base = `/api/v1/engagements/${engagement.id}`;
    const scope = (
      await app.inject({
        method: "POST",
        url: `${base}/scope-revisions`,
        headers: headers(key("empty-retain")),
        payload: { expectedRevision: 1, rules: [] },
      })
    ).json();
    const planned = (
      await app.inject({
        method: "POST",
        url: `${base}/actions`,
        headers: headers(key("plan-retain")),
        payload: {
          expectedEngagementRevision: 2,
          expectedActiveScopeRevisionId: scope.id,
          targets: ["192.0.2.10"],
        },
      })
    ).json();
    expect(planned.action.state).toBe("paused_for_warning");
    const added = await app.inject({
      method: "POST",
      url: `${base}/actions/${planned.action.actionId}/add-scope-and-run`,
      headers: headers(key("add-empty")),
      payload: {
        expectedEngagementRevision: 2,
        expectedActionRevision: planned.revision,
        rules: [],
      },
    });
    expect(added.statusCode).toBe(200);
    expect(added.json().action).toMatchObject({
      state: "queued",
      queuedSnapshotVersion: 2,
      pendingWarning: null,
      warningAcknowledgment: { source: "add_scope_and_run" },
    });
    expect(added.json().action.snapshots).toHaveLength(2);
    expect(added.json().action.snapshots[1]).toMatchObject({
      version: 2,
      warningState: { reasonCodes: ["outside_scope"] },
    });
    expect(added.json().action.snapshots[1].scopeRevisionId).not.toBe(scope.id);
    expect(engagementRepository.listScopeRevisions(engagement.id)).toMatchObject({
      ok: true,
      value: [
        { version: 1, rules: [] },
        { version: 2, rules: [] },
      ],
    });
    const queuedAdd = await app.inject({
      method: "POST",
      url: `${base}/actions/${planned.action.actionId}/add-scope-and-run`,
      headers: headers(key("add-again")),
      payload: {
        expectedEngagementRevision: 3,
        expectedActionRevision: added.json().revision,
        rules: [],
      },
    });
    expect(queuedAdd).toMatchObject({
      statusCode: 409,
      body: '{"code":"action_already_queued"}',
    });
  });

  it("auto-continues from the stored engagement preference", async () => {
    const { app } = await fixture();
    const engagement = await createEngagement(app, true);
    const base = `/api/v1/engagements/${engagement.id}`;
    const scope = (
      await app.inject({
        method: "POST",
        url: `${base}/scope-revisions`,
        headers: headers(key("auto-scope")),
        payload: { expectedRevision: 1, rules: [] },
      })
    ).json();
    const planned = await app.inject({
      method: "POST",
      url: `${base}/actions`,
      headers: headers(key("auto-plan")),
      payload: {
        expectedEngagementRevision: 2,
        expectedActiveScopeRevisionId: scope.id,
        targets: ["outside.target.test"],
      },
    });
    expect(planned.json().action).toMatchObject({
      state: "queued",
      warningAcknowledgment: { source: "engagement_policy" },
    });
  });

  it("cancels paused and queued actions and rejects invalid lifecycle without mutation", async () => {
    const { app } = await fixture();
    const engagement = await createEngagement(app);
    const base = `/api/v1/engagements/${engagement.id}`;
    const scope = (
      await app.inject({
        method: "POST",
        url: `${base}/scope-revisions`,
        headers: headers(key("cancel-scope")),
        payload: { expectedRevision: 1, rules: [] },
      })
    ).json();
    const paused = (
      await app.inject({
        method: "POST",
        url: `${base}/actions`,
        headers: headers(key("cancel-paused")),
        payload: {
          expectedEngagementRevision: 2,
          expectedActiveScopeRevisionId: scope.id,
          targets: ["192.0.2.10"],
        },
      })
    ).json();
    const cancelledPaused = await app.inject({
      method: "POST",
      url: `${base}/actions/${paused.action.actionId}/cancel`,
      headers: headers(key("do-cancel-paused")),
      payload: { expectedRevision: paused.revision },
    });
    expect(cancelledPaused.json().action).toMatchObject({
      state: "cancelled",
      pendingWarning: null,
      queuedSnapshotVersion: null,
    });
    const invalid = await app.inject({
      method: "POST",
      url: `${base}/actions/${paused.action.actionId}/cancel`,
      headers: headers(key("cancel-again")),
      payload: { expectedRevision: cancelledPaused.json().revision },
    });
    expect(invalid).toMatchObject({
      statusCode: 409,
      body: '{"code":"invalid_action_transition"}',
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: `${base}/actions/${paused.action.actionId}`,
        })
      ).json().revision,
    ).toBe(cancelledPaused.json().revision);

    const queued = (
      await app.inject({
        method: "POST",
        url: `${base}/actions`,
        headers: headers(key("cancel-queued-plan")),
        payload: {
          expectedEngagementRevision: 2,
          expectedActiveScopeRevisionId: scope.id,
          targets: ["192.0.2.10"],
        },
      })
    ).json();
    const continued = (
      await app.inject({
        method: "POST",
        url: `${base}/actions/${queued.action.actionId}/continue`,
        headers: headers(key("queue-then-cancel")),
        payload: {
          expectedRevision: queued.revision,
          snapshotVersion: 1,
          snapshotBinding: queued.action.snapshots[0].binding,
        },
      })
    ).json();
    const cancelledQueued = await app.inject({
      method: "POST",
      url: `${base}/actions/${queued.action.actionId}/cancel`,
      headers: headers(key("do-cancel-queued")),
      payload: { expectedRevision: continued.revision },
    });
    expect(cancelledQueued.json().action).toMatchObject({
      state: "cancelled",
      queuedSnapshotVersion: 1,
    });
  });

  it("exposes retry context only for retryable cancelled actions", async () => {
    const { app } = await fixture();
    const engagement = await createEngagement(app);
    const base = `/api/v1/engagements/${engagement.id}`;
    const queued = (
      await app.inject({
        method: "POST",
        url: `${base}/actions`,
        headers: headers(key("retry-plan")),
        payload: {
          expectedEngagementRevision: 1,
          expectedActiveScopeRevisionId: null,
          targets: ["192.0.2.10"],
        },
      })
    ).json();
    const cancelled = (
      await app.inject({
        method: "POST",
        url: `${base}/actions/${queued.action.actionId}/cancel`,
        headers: headers(key("retry-cancel")),
        payload: { expectedRevision: queued.revision },
      })
    ).json();
    const context = await app.inject({
      method: "GET",
      url: `${base}/actions/${queued.action.actionId}/retry-context`,
    });
    expect(context.statusCode).toBe(200);
    expect(context.json()).toEqual({
      actionId: queued.action.actionId,
      snapshotId: queued.action.snapshots[0].snapshotId,
      snapshotVersion: 1,
      snapshotBinding: queued.action.snapshots[0].binding,
      warningAcknowledgment: cancelled.action.warningAcknowledgment,
      warningAcknowledgmentId: cancelled.warningAcknowledgmentId,
      resolutionRefreshed: false,
      newWarningBudget: false,
    });

    const scope = (
      await app.inject({
        method: "POST",
        url: `${base}/scope-revisions`,
        headers: headers(key("retry-empty")),
        payload: { expectedRevision: 1, rules: [] },
      })
    ).json();
    const paused = (
      await app.inject({
        method: "POST",
        url: `${base}/actions`,
        headers: headers(key("retry-paused")),
        payload: {
          expectedEngagementRevision: 2,
          expectedActiveScopeRevisionId: scope.id,
          targets: ["192.0.2.10"],
        },
      })
    ).json();
    expect(paused.action.state).toBe("paused_for_warning");
    const notRetryable = await app.inject({
      method: "GET",
      url: `${base}/actions/${paused.action.actionId}/retry-context`,
    });
    expect(notRetryable).toMatchObject({
      statusCode: 409,
      body: '{"code":"invalid_action_transition"}',
    });
  });

  it("does not let Continue override a persisted capability error", async () => {
    const { app, engagementRepository } = await fixture();
    const engagement = await createEngagement(app);
    const actionId = "20000000-0000-4000-8000-000000000001";
    const snapshot = {
      normalizationProfile: "d1-v1" as const,
      orchestrationProfile: "d2-v1" as const,
      snapshotId: "20000000-0000-4000-8000-000000000002",
      version: 1,
      binding: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      actionId,
      canonicalTargets: [
        {
          normalizationProfile: "d1-v1" as const,
          kind: "ip" as const,
          family: 4 as const,
          address: "192.0.2.10",
          zone: null,
        },
      ],
      concreteDestinations: [
        {
          normalizationProfile: "d1-v1" as const,
          kind: "ip" as const,
          family: 4 as const,
          address: "192.0.2.10",
          zone: null,
        },
      ],
      typedOptions: { declaredPorts: null },
      resolutionSnapshots: [],
      scopeRevisionId: null,
      warningState: {
        reasonCodes: [] as const,
        knownAdditions: [] as const,
        acknowledgment: null,
      },
    };
    const bound = bindActionSnapshot(snapshot);
    if (!bound.ok) throw new Error("capability snapshot binding failed");
    const persisted = engagementRepository.persistPlannedAction({
      engagementId: engagement.id,
      snapshot: { ...snapshot, binding: bound.binding },
      representable: false,
      capabilityErrorCode: "target_set_unrepresentable",
      occurredAt: "2026-08-12T12:41:00.000Z",
    });
    if (!persisted.ok) throw new Error(persisted.error.code);
    expect(persisted.value.action.state).toBe("capability_error");
    const continued = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${engagement.id}/actions/${actionId}/continue`,
      headers: headers(key("cap-continue")),
      payload: {
        expectedRevision: persisted.value.revision,
        snapshotVersion: 1,
        snapshotBinding: bound.binding,
      },
    });
    expect(continued).toMatchObject({
      statusCode: 409,
      body: '{"code":"capability_error_not_overridable"}',
    });
    expect(
      engagementRepository.getAction(engagement.id, actionId),
    ).toMatchObject({
      ok: true,
      value: { action: { state: "capability_error" }, revision: 1 },
    });
  });

  it("rejects malformed, Unicode-hostile, duplicate, and oversized input without reflection", async () => {
    const { app, database } = await fixture();
    const engagement = await createEngagement(app);
    const base = `/api/v1/engagements/${engagement.id}/actions`;
    const marker = "SENSITIVE_TARGET_MARKER.example";
    const oversized = `192.0.2.10/${"1".repeat(5_000)}`;
    for (const [index, payload] of [
      {
        expectedEngagementRevision: 1,
        expectedActiveScopeRevisionId: null,
        targets: [marker, marker],
      },
      {
        expectedEngagementRevision: 1,
        expectedActiveScopeRevisionId: null,
        targets: [oversized],
      },
      {
        expectedEngagementRevision: 1,
        expectedActiveScopeRevisionId: null,
        targets: ["192.0.2.10"],
        command: "nmap -sS 192.0.2.10",
      },
      {
        expectedEngagementRevision: 1,
        expectedActiveScopeRevisionId: null,
        targets: ["192.0.2.10"],
        reasonCodes: ["outside_scope"],
      },
      {
        expectedEngagementRevision: 1,
        expectedActiveScopeRevisionId: null,
        targets: ["192.0.2.10\u0000"],
      },
      {
        expectedEngagementRevision: 1,
        expectedActiveScopeRevisionId: null,
        targets: ["192.0.2.10", " 192.0.2.10 "],
      },
    ].entries()) {
      const response = await app.inject({
        method: "POST",
        url: base,
        headers: headers(key(`bad-${index}`)),
        payload,
      });
      expect(response).toMatchObject({
        statusCode: 400,
        body: '{"code":"invalid_request"}',
      });
      expect(response.body).not.toContain(marker);
      expect(response.body).not.toContain("nmap");
      expect(response.body).not.toContain("/private");
    }
    const malformed = await app.inject({
      method: "POST",
      url: base,
      headers: {
        ...headers(key("bad-json")),
        "content-type": "application/json",
      },
      payload: `{"expectedEngagementRevision":1,"expectedActiveScopeRevisionId":null,"targets":["${marker}"`,
    });
    expect(malformed).toMatchObject({
      statusCode: 400,
      body: '{"code":"invalid_request"}',
    });
    expect(malformed.body).not.toContain(marker);
    expect(
      database.sqlite.prepare("select count(*) from actions").pluck().get(),
    ).toBe(0);
    expect(
      await app.inject({
        method: "POST",
        url: `${base}?ignored=true`,
        headers: headers(key("query")),
        payload: {
          expectedEngagementRevision: 1,
          expectedActiveScopeRevisionId: null,
          targets: ["192.0.2.10"],
        },
      }),
    ).toMatchObject({ statusCode: 400, body: '{"code":"invalid_request"}' });
    expect(
      (
        await app.inject({
          method: "GET",
          url: `${base}/not-a-uuid`,
        })
      ).body,
    ).toBe('{"code":"invalid_request"}');
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/engagements/${engagement.id}/actions/20000000-0000-4000-8000-000000000099`,
        })
      ).body,
    ).toBe('{"code":"action_not_found"}');
  });

  it("continues a paused run from the current warning event only", async () => {
    const { app, engagementRepository } = await fixture();
    const engagement = await createEngagement(app);
    const base = `/api/v1/engagements/${engagement.id}`;
    const scope = (
      await app.inject({
        method: "POST",
        url: `${base}/scope-revisions`,
        headers: headers(key("late-scope")),
        payload: { expectedRevision: 1, rules: [lateScopeRule] },
      })
    ).json();
    const planned = (
      await app.inject({
        method: "POST",
        url: `${base}/actions`,
        headers: headers(key("late-plan")),
        payload: {
          expectedEngagementRevision: 2,
          expectedActiveScopeRevisionId: scope.id,
          targets: ["192.0.2.10"],
        },
      })
    ).json();
    const actionId = planned.action.actionId as string;
    const binding = planned.action.snapshots[0].binding as string;
    const addition = { origin: "https://other.test:443", resolvedAddress: "192.0.2.41" };
    const activated = engagementRepository.activateAction({
      engagementId: engagement.id,
      actionId,
      expectedRevision: planned.revision,
    });
    if (!activated.ok) throw new Error(activated.error.code);
    const paused = engagementRepository.recordLateWarning({
      engagementId: engagement.id,
      actionId,
      expectedRevision: activated.value.revision,
      snapshotVersion: 1,
      snapshotBinding: binding,
      reasonCodes: ["risk_tier_t2"],
      addition,
      pendingEventId: 7,
      occurredAt: "2026-08-12T12:14:00.000Z",
    });
    if (!paused.ok) throw new Error(paused.error.code);
    expect(paused.value.action.state).toBe("active_paused_for_warning");

    const lateUrl = `${base}/actions/${actionId}/continue-late-warning`;
    const stale = await app.inject({
      method: "POST",
      url: lateUrl,
      headers: headers(key("late-stale")),
      payload: {
        expectedRevision: paused.value.revision,
        snapshotVersion: 1,
        snapshotBinding: binding,
        pendingEventId: 8,
      },
    });
    expect(stale).toMatchObject({
      statusCode: 409,
      body: '{"code":"invalid_run_transition"}',
    });
    // A stale event cannot resume the run: the stored revision is unchanged.
    expect(
      (await app.inject({ method: "GET", url: `${base}/actions/${actionId}` })).json().revision,
    ).toBe(paused.value.revision);

    const continued = await app.inject({
      method: "POST",
      url: lateUrl,
      headers: headers(key("late-continue")),
      payload: {
        expectedRevision: paused.value.revision,
        snapshotVersion: 1,
        snapshotBinding: binding,
        pendingEventId: 7,
      },
    });
    expect(continued.statusCode).toBe(200);
    expect(continued.json().action).toMatchObject({
      state: "active",
      runState: "running",
      resumeRequested: true,
      pendingWarning: null,
      warningAcknowledgment: {
        source: "operator_continue",
        pendingEventId: 7,
        reasonCodes: ["risk_tier_t2"],
      },
      coveredDestinations: [addition],
    });

    // A duplicate Continue after the warning is gone cannot resume anything.
    const again = await app.inject({
      method: "POST",
      url: lateUrl,
      headers: headers(key("late-again")),
      payload: {
        expectedRevision: continued.json().revision,
        snapshotVersion: 1,
        snapshotBinding: binding,
        pendingEventId: 7,
      },
    });
    expect(again).toMatchObject({
      statusCode: 409,
      body: '{"code":"invalid_action_transition"}',
    });

    const detail = await app.inject({ method: "GET", url: base });
    expect(detail.json()).toMatchObject({
      engagement: { activeScopeRevisionId: scope.id, revision: 2 },
      activeScopeRevision: { id: scope.id, rules: [lateScopeRule] },
    });
  });

  it("rejects late-warning continue across ownership, archive, and lifecycle boundaries", async () => {
    const { app, engagementRepository } = await fixture();
    const engagement = await createEngagement(app);
    const base = `/api/v1/engagements/${engagement.id}`;
    const scope = (
      await app.inject({
        method: "POST",
        url: `${base}/scope-revisions`,
        headers: headers(key("late-bound-scope")),
        payload: { expectedRevision: 1, rules: [lateScopeRule] },
      })
    ).json();
    const planned = (
      await app.inject({
        method: "POST",
        url: `${base}/actions`,
        headers: headers(key("late-bound-plan")),
        payload: {
          expectedEngagementRevision: 2,
          expectedActiveScopeRevisionId: scope.id,
          targets: ["192.0.2.10"],
        },
      })
    ).json();
    const actionId = planned.action.actionId as string;
    const binding = planned.action.snapshots[0].binding as string;
    const lateUrl = `${base}/actions/${actionId}/continue-late-warning`;
    const latePayload = (overrides: Record<string, unknown> = {}) => ({
      expectedRevision: planned.revision,
      snapshotVersion: 1,
      snapshotBinding: binding,
      pendingEventId: 7,
      ...overrides,
    });

    // No pending warning exists yet: the pre-run action cannot take this path.
    expect(
      await app.inject({
        method: "POST",
        url: lateUrl,
        headers: headers(key("late-no-warning")),
        payload: latePayload(),
      }),
    ).toMatchObject({ statusCode: 409, body: '{"code":"invalid_action_transition"}' });

    // Malformed bodies never reach the transition.
    expect(
      await app.inject({
        method: "POST",
        url: lateUrl,
        headers: headers(key("late-no-event")),
        payload: {
          expectedRevision: planned.revision,
          snapshotVersion: 1,
          snapshotBinding: binding,
        },
      }),
    ).toMatchObject({ statusCode: 400, body: '{"code":"invalid_request"}' });

    // A foreign engagement never resolves another engagement's action.
    const other = await createEngagement(app, false, "eng-other");
    expect(
      await app.inject({
        method: "POST",
        url: `/api/v1/engagements/${other.id}/actions/${actionId}/continue-late-warning`,
        headers: headers(key("late-foreign")),
        payload: latePayload(),
      }),
    ).toMatchObject({ statusCode: 404, body: '{"code":"action_not_found"}' });
    expect(
      await app.inject({
        method: "POST",
        url: `${base}/actions/20000000-0000-4000-8000-000000000099/continue-late-warning`,
        headers: headers(key("late-unknown")),
        payload: latePayload(),
      }),
    ).toMatchObject({ statusCode: 404, body: '{"code":"action_not_found"}' });

    const activated = engagementRepository.activateAction({
      engagementId: engagement.id,
      actionId,
      expectedRevision: planned.revision,
    });
    if (!activated.ok) throw new Error(activated.error.code);
    const paused = engagementRepository.recordLateWarning({
      engagementId: engagement.id,
      actionId,
      expectedRevision: activated.value.revision,
      snapshotVersion: 1,
      snapshotBinding: binding,
      reasonCodes: ["risk_tier_t2"],
      addition: { origin: "https://other.test:443", resolvedAddress: "192.0.2.41" },
      pendingEventId: 7,
      occurredAt: "2026-08-12T12:14:00.000Z",
    });
    if (!paused.ok) throw new Error(paused.error.code);

    // A mismatched snapshot binding cannot resume the run.
    expect(
      await app.inject({
        method: "POST",
        url: lateUrl,
        headers: headers(key("late-binding")),
        payload: latePayload({
          expectedRevision: paused.value.revision,
          snapshotBinding: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        }),
      }),
    ).toMatchObject({ statusCode: 409, body: '{"code":"snapshot_binding_mismatch"}' });

    // A concurrent cancel wins: cancelling a running paused action requests
    // run cancellation, and the paused warning can no longer be continued.
    const cancelled = await app.inject({
      method: "POST",
      url: `${base}/actions/${actionId}/cancel`,
      headers: headers(key("late-cancel")),
      payload: { expectedRevision: paused.value.revision },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(
      await app.inject({
        method: "POST",
        url: lateUrl,
        headers: headers(key("late-after-cancel")),
        payload: latePayload({ expectedRevision: cancelled.json().revision }),
      }),
    ).toMatchObject({ statusCode: 409, body: '{"code":"invalid_run_transition"}' });
  });

  it("replays an identical late-warning continue without a second resume", async () => {
    const { app, engagementRepository } = await fixture();
    const engagement = await createEngagement(app);
    const base = `/api/v1/engagements/${engagement.id}`;
    const scope = (
      await app.inject({
        method: "POST",
        url: `${base}/scope-revisions`,
        headers: headers(key("late-replay-scope")),
        payload: { expectedRevision: 1, rules: [lateScopeRule] },
      })
    ).json();
    const planned = (
      await app.inject({
        method: "POST",
        url: `${base}/actions`,
        headers: headers(key("late-replay-plan")),
        payload: {
          expectedEngagementRevision: 2,
          expectedActiveScopeRevisionId: scope.id,
          targets: ["192.0.2.10"],
        },
      })
    ).json();
    const actionId = planned.action.actionId as string;
    const binding = planned.action.snapshots[0].binding as string;
    const activated = engagementRepository.activateAction({
      engagementId: engagement.id,
      actionId,
      expectedRevision: planned.revision,
    });
    if (!activated.ok) throw new Error(activated.error.code);
    const paused = engagementRepository.recordLateWarning({
      engagementId: engagement.id,
      actionId,
      expectedRevision: activated.value.revision,
      snapshotVersion: 1,
      snapshotBinding: binding,
      reasonCodes: ["risk_tier_t2"],
      addition: { origin: "https://other.test:443", resolvedAddress: "192.0.2.41" },
      pendingEventId: 7,
      occurredAt: "2026-08-12T12:14:00.000Z",
    });
    if (!paused.ok) throw new Error(paused.error.code);
    const lateRequest = {
      method: "POST" as const,
      url: `${base}/actions/${actionId}/continue-late-warning`,
      headers: headers(key("late-replay")),
      payload: {
        expectedRevision: paused.value.revision,
        snapshotVersion: 1,
        snapshotBinding: binding,
        pendingEventId: 7,
      },
    };
    const first = await app.inject(lateRequest);
    expect(first.statusCode).toBe(200);
    const replay = await app.inject(lateRequest);
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toBe(first.body);
  });

  it("refuses late-warning continue on archived engagements", async () => {
    const { app, engagementRepository } = await fixture();
    const engagement = await createEngagement(app);
    const base = `/api/v1/engagements/${engagement.id}`;
    const scope = (
      await app.inject({
        method: "POST",
        url: `${base}/scope-revisions`,
        headers: headers(key("late-arch-scope")),
        payload: { expectedRevision: 1, rules: [lateScopeRule] },
      })
    ).json();
    const planned = (
      await app.inject({
        method: "POST",
        url: `${base}/actions`,
        headers: headers(key("late-arch-plan")),
        payload: {
          expectedEngagementRevision: 2,
          expectedActiveScopeRevisionId: scope.id,
          targets: ["192.0.2.10"],
        },
      })
    ).json();
    const actionId = planned.action.actionId as string;
    const binding = planned.action.snapshots[0].binding as string;
    const activated = engagementRepository.activateAction({
      engagementId: engagement.id,
      actionId,
      expectedRevision: planned.revision,
    });
    if (!activated.ok) throw new Error(activated.error.code);
    const paused = engagementRepository.recordLateWarning({
      engagementId: engagement.id,
      actionId,
      expectedRevision: activated.value.revision,
      snapshotVersion: 1,
      snapshotBinding: binding,
      reasonCodes: ["risk_tier_t2"],
      addition: { origin: "https://other.test:443", resolvedAddress: "192.0.2.41" },
      pendingEventId: 7,
      occurredAt: "2026-08-12T12:14:00.000Z",
    });
    if (!paused.ok) throw new Error(paused.error.code);
    const archived = await app.inject({
      method: "POST",
      url: `${base}/archive`,
      headers: headers(key("late-arch")),
      payload: { expectedRevision: 2 },
    });
    expect(archived.statusCode).toBe(200);
    expect(
      await app.inject({
        method: "POST",
        url: `${base}/actions/${actionId}/continue-late-warning`,
        headers: headers(key("late-arch-continue")),
        payload: {
          expectedRevision: paused.value.revision,
          snapshotVersion: 1,
          snapshotBinding: binding,
          pendingEventId: 7,
        },
      }),
    ).toMatchObject({ statusCode: 409, body: '{"code":"engagement_archived"}' });
  });
});
