import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  encodeRunHistoryCursor,
  formatRunnerAuthorization,
  type ActionSnapshot,
} from "@stonehush/contracts";
import {
  bindActionSnapshot,
  EngagementRepository,
  RunOutputRepository,
  openEngagementDatabase,
} from "@stonehush/db";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

const directories: string[] = [];
const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await chmod(directory, 0o700).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

function boundSnapshot(actionId: string): ActionSnapshot {
  const snapshot: ActionSnapshot = {
    normalizationProfile: "d1-v1",
    orchestrationProfile: "d2-v1",
    snapshotId: `snapshot-${actionId}`,
    version: 1,
    binding: `sha256:${"a".repeat(64)}`,
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
    resolutionSnapshots: [],
    scopeRevisionId: null,
    warningState: { reasonCodes: [], knownAdditions: [], acknowledgment: null },
  };
  const bound = bindActionSnapshot(snapshot);
  if (!bound.ok) throw new Error(bound.error.code);
  return { ...snapshot, binding: bound.binding };
}

interface Harness {
  app: ReturnType<typeof buildApp>;
  database: ReturnType<typeof openEngagementDatabase>;
  engagementRepository: EngagementRepository;
}

async function createHarness(): Promise<Harness> {
  const directory = await mkdtemp(path.join(tmpdir(), "run-history-"));
  await chmod(directory, 0o700);
  directories.push(directory);
  const database = openEngagementDatabase({ dataDirectory: directory });
  let engagementSeq = 100;
  const engagementRepository = new EngagementRepository(database.db, {
    createId: () =>
      `10000000-0000-4000-8000-${String(++engagementSeq).padStart(12, "0")}`,
    now: () => new Date("2026-08-09T12:00:00.000Z"),
  });
  // No evidenceStore on purpose: history is metadata-only and must register
  // independently of artifact storage.
  const app = buildApp({
    engagementRepository,
    runOutputRepository: new RunOutputRepository(database.db),
    getDevelopmentStorageReadiness: () => "ready",
    logger: false,
  });
  app.addHook("onClose", async () => database.close());
  apps.push(app);
  return { app, database, engagementRepository };
}

function createEngagement(harness: Harness, name: string): string {
  const engagement = harness.engagementRepository.createEngagement({
    name,
    kind: "lab",
    description: null,
    authorizationContext: "Synthetic fixture authorization context",
    autoContinueWarnings: false,
  });
  if (!engagement.ok) throw new Error(engagement.error.code);
  return engagement.value.id;
}

function queueRun(harness: Harness, engagementId: string, actionId: string): string {
  const planned = harness.engagementRepository.persistPlannedAction({
    engagementId,
    snapshot: boundSnapshot(actionId),
    representable: true,
    capabilityErrorCode: null,
    occurredAt: "2026-08-09T12:00:00.000Z",
  });
  if (!planned.ok) throw new Error(planned.error.code);
  const row = harness.database.sqlite
    .prepare("select id from runs where action_id = ?")
    .get(actionId) as { id: string };
  return row.id;
}

function setRun(
  harness: Harness,
  runId: string,
  patch: { state: string; createdAt: string; updatedAt: string },
): void {
  const terminalKind =
    patch.state === "succeeded" || patch.state === "failed" || patch.state === "cancelled"
      ? `'${patch.state}'`
      : "null";
  const terminalReason =
    patch.state === "succeeded"
      ? "null"
      : patch.state === "failed" || patch.state === "cancelled"
        ? "'operator_cancelled'"
        : "null";
  harness.database.sqlite
    .prepare(
      `update runs set state = ?, terminal_kind = ${terminalKind}, terminal_reason = ${terminalReason}, current_fence = '1', created_at = ?, updated_at = ? where id = ?`,
    )
    .run(patch.state, patch.createdAt, patch.updatedAt, runId);
}

const RUNNER_HEADER = formatRunnerAuthorization(
  "runner-history-fixture",
  "a".repeat(43),
);

describe("run history routes", () => {
  it("returns all states and retry attempts with the exact public projection", async () => {
    const harness = await createHarness();
    const engagementId = createEngagement(harness, "History projection lab");
    const states = [
      "queued",
      "leased",
      "running",
      "cancel_requested",
      "succeeded",
      "failed",
      "cancelled",
    ] as const;
    states.forEach((state, index) => {
      const runId = queueRun(harness, engagementId, `action-projection-${index}`);
      const minute = String(index).padStart(2, "0");
      setRun(harness, runId, {
        state,
        createdAt: `2026-08-09T12:${minute}:00.000Z`,
        updatedAt: `2026-08-09T12:${minute}:00.000Z`,
      });
    });
    const retryAction = "action-projection-retry";
    const firstRetry = queueRun(harness, engagementId, retryAction);
    setRun(harness, firstRetry, {
      state: "failed",
      createdAt: "2026-08-09T11:00:00.000Z",
      updatedAt: "2026-08-09T11:01:00.000Z",
    });
    harness.database.sqlite
      .prepare(
        `insert into runs (id, contract_version, action_id, engagement_id, attempt, state, current_lease_id, current_fence, terminal_kind, terminal_reason, created_at, updated_at) values ('run-projection-retry-2',1,?, ?,2,'queued',null,'0',null,null,'2026-08-09T12:07:00.000Z','2026-08-09T12:07:00.000Z')`,
      )
      .run(retryAction, engagementId);

    const response = await harness.app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/runs?limit=100`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      runs: Record<string, unknown>[];
      nextCursor: null;
    };
    expect(body.runs).toHaveLength(9);
    expect(body.nextCursor).toBeNull();
    for (const run of body.runs) {
      expect(Object.keys(run).sort()).toEqual(
        [
          "actionId",
          "attempt",
          "createdAt",
          "id",
          "state",
          "terminalKind",
          "terminalReason",
          "updatedAt",
        ].sort(),
      );
    }
    const retryRows = body.runs.filter((run) => run["actionId"] === retryAction);
    expect(retryRows.map((run) => run["attempt"]).sort()).toEqual([1, 2]);
    // Exact terminal values per state: a swapped mapping must fail.
    const expectedTerminals: Record<string, { kind: unknown; reason: unknown }> = {
      queued: { kind: null, reason: null },
      leased: { kind: null, reason: null },
      running: { kind: null, reason: null },
      cancel_requested: { kind: null, reason: null },
      succeeded: { kind: "succeeded", reason: null },
      failed: { kind: "failed", reason: "operator_cancelled" },
      cancelled: { kind: "cancelled", reason: "operator_cancelled" },
    };
    for (const [index, state] of states.entries()) {
      const row = body.runs.find((run) => run["actionId"] === `action-projection-${index}`);
      expect(row?.["state"]).toBe(state);
      expect(row?.["terminalKind"]).toBe(expectedTerminals[state]?.kind ?? null);
      expect(row?.["terminalReason"]).toBe(expectedTerminals[state]?.reason ?? null);
    }
  });

  it("pages timestamp ties across pages and nulls the final cursor", async () => {
    const harness = await createHarness();
    const engagementId = createEngagement(harness, "History ties lab");
    const tiedAt = "2026-08-09T12:00:00.000Z";
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const runId = queueRun(harness, engagementId, `action-ties-${index}`);
      setRun(harness, runId, { state: "queued", createdAt: tiedAt, updatedAt: tiedAt });
      ids.push(runId);
    }
    const expectedDesc = [...ids].sort().reverse();

    const first = await harness.app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/runs?limit=2`,
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { runs: { id: string }[]; nextCursor: string };
    expect(firstBody.runs.map((run) => run.id)).toEqual(expectedDesc.slice(0, 2));
    expect(typeof firstBody.nextCursor).toBe("string");

    const second = await harness.app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/runs?limit=2&before=${encodeURIComponent(firstBody.nextCursor)}`,
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as { runs: { id: string }[]; nextCursor: string };
    expect(secondBody.runs.map((run) => run.id)).toEqual(expectedDesc.slice(2, 4));

    const third = await harness.app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/runs?limit=2&before=${encodeURIComponent(secondBody.nextCursor)}`,
    });
    expect(third.statusCode).toBe(200);
    const thirdBody = third.json() as { runs: { id: string }[]; nextCursor: null };
    expect(thirdBody.runs.map((run) => run.id)).toEqual(expectedDesc.slice(4, 5));
    expect(thirdBody.nextCursor).toBeNull();
  });

  it("keeps paging stable when newer runs arrive and states update", async () => {
    const harness = await createHarness();
    const engagementId = createEngagement(harness, "History stability lab");
    for (let index = 0; index < 4; index += 1) {
      const runId = queueRun(harness, engagementId, `action-stable-${index}`);
      const minute = String(index).padStart(2, "0");
      setRun(harness, runId, {
        state: "queued",
        createdAt: `2026-08-09T12:${minute}:00.000Z`,
        updatedAt: `2026-08-09T12:${minute}:00.000Z`,
      });
    }
    const first = await harness.app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/runs?limit=2`,
    });
    const firstBody = first.json() as { runs: { id: string }[]; nextCursor: string };

    // Capture the expected second page before any mutation.
    const secondBefore = await harness.app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/runs?limit=2&before=${encodeURIComponent(firstBody.nextCursor)}`,
    });
    expect(secondBefore.statusCode).toBe(200);
    const secondBeforeBody = secondBefore.json() as { runs: { id: string }[] };
    expect(secondBeforeBody.runs).toHaveLength(2);
    const expectedSecondIds = secondBeforeBody.runs.map((run) => run.id);

    const newer = queueRun(harness, engagementId, "action-stable-newer");
    setRun(harness, newer, {
      state: "queued",
      createdAt: "2026-08-09T13:00:00.000Z",
      updatedAt: "2026-08-09T13:00:00.000Z",
    });
    harness.database.sqlite
      .prepare("update runs set state = 'running', updated_at = '2026-08-09T14:00:00.000Z' where id = ?")
      .run(firstBody.runs[0]?.id as string);

    const second = await harness.app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/runs?limit=2&before=${encodeURIComponent(firstBody.nextCursor)}`,
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as { runs: { id: string }[] };
    // Live listing: the second page still holds exactly the preexisting rows
    // even though a newer run arrived and a paged row changed state.
    expect(secondBody.runs.map((run) => run.id)).toEqual(expectedSecondIds);
    expect(secondBody.runs.map((run) => run.id)).not.toContain(newer);
  });

  it("rejects strict query violations and invalid or cross-engagement cursors", async () => {
    const harness = await createHarness();
    const engagementId = createEngagement(harness, "History validation lab");
    const otherId = createEngagement(harness, "History validation other");
    const runId = queueRun(harness, engagementId, "action-validation-1");
    setRun(harness, runId, {
      state: "queued",
      createdAt: "2026-08-09T12:00:00.000Z",
      updatedAt: "2026-08-09T12:00:00.000Z",
    });
    const crossCursor = encodeRunHistoryCursor({
      engagementId: otherId,
      createdAt: "2026-08-09T12:00:00.000Z",
      id: runId,
    });
    const badCursors = [
      "not-base64!!",
      "a",
      "x".repeat(1025),
      Buffer.from(
        JSON.stringify({
          v: 2,
          engagementId,
          createdAt: "2026-08-09T12:00:00.000Z",
          id: runId,
        }),
        "utf8",
      ).toString("base64url"),
    ];
    for (const url of [
      `/api/v1/engagements/${engagementId}/runs?limit=`,
      `/api/v1/engagements/${engagementId}/runs?limit=0`,
      `/api/v1/engagements/${engagementId}/runs?limit=101`,
      `/api/v1/engagements/${engagementId}/runs?limit=2.5`,
      `/api/v1/engagements/${engagementId}/runs?limit=25.0`,
      `/api/v1/engagements/${engagementId}/runs?limit=25&limit=25`,
      `/api/v1/engagements/${engagementId}/runs?unknown=1`,
      `/api/v1/engagements/${engagementId}/runs?before=`,
      `/api/v1/engagements/${engagementId}/runs?before=${encodeURIComponent(crossCursor)}`,
      ...badCursors.map(
        (cursor) =>
          `/api/v1/engagements/${engagementId}/runs?before=${encodeURIComponent(cursor)}`,
      ),
      `/api/v1/engagements/not-a-uuid/runs`,
    ]) {
      const response = await harness.app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ code: "invalid_request" });
    }
  });

  it("handles empty, archived, missing, and isolated engagements", async () => {
    const harness = await createHarness();
    const engagementId = createEngagement(harness, "History empty lab");
    const otherId = createEngagement(harness, "History other lab");
    const runId = queueRun(harness, otherId, "action-isolation-1");
    setRun(harness, runId, {
      state: "queued",
      createdAt: "2026-08-09T12:00:00.000Z",
      updatedAt: "2026-08-09T12:00:00.000Z",
    });

    const empty = await harness.app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/runs`,
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ runs: [], nextCursor: null });

    harness.database.sqlite
      .prepare("update engagements set status = 'archived' where id = ?")
      .run(engagementId);
    const archived = await harness.app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/runs`,
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toEqual({ runs: [], nextCursor: null });

    const missing = await harness.app.inject({
      method: "GET",
      url: "/api/v1/engagements/10000000-0000-4000-8000-000000000099/runs",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ code: "engagement_not_found" });

    const isolated = await harness.app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/runs?limit=100`,
    });
    expect(isolated.json()).toEqual({ runs: [], nextCursor: null });
  });

  it("excludes rows with corrupted run/action ownership from both engagements", async () => {
    const harness = await createHarness();
    const first = createEngagement(harness, "History corrupt ownership A");
    const second = createEngagement(harness, "History corrupt ownership B");
    const runId = queueRun(harness, first, "action-corrupt-owner-api");
    setRun(harness, runId, {
      state: "queued",
      createdAt: "2026-08-09T12:00:00.000Z",
      updatedAt: "2026-08-09T12:00:00.000Z",
    });
    const clean = await harness.app.inject({
      method: "GET",
      url: `/api/v1/engagements/${first}/runs`,
    });
    expect(clean.statusCode).toBe(200);
    expect((clean.json() as { runs: { id: string }[] }).runs.map((run) => run.id)).toEqual([
      runId,
    ]);

    // Deliberate test-only corruption with FK enforcement restored. The temp
    // database is closed after this test so it never affects real data.
    harness.database.sqlite.pragma("foreign_keys = OFF");
    try {
      harness.database.sqlite
        .prepare("update runs set engagement_id = ? where id = ?")
        .run(second, runId);
    } finally {
      harness.database.sqlite.pragma("foreign_keys = ON");
    }
    expect(harness.database.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    for (const engagementId of [first, second]) {
      const listed = await harness.app.inject({
        method: "GET",
        url: `/api/v1/engagements/${engagementId}/runs`,
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toEqual({ runs: [], nextCursor: null });
    }
  });

  it("maps corrupt rows to 500 and busy storage to 503", async () => {
    const harness = await createHarness();
    const engagementId = createEngagement(harness, "History corrupt lab");
    const runId = queueRun(harness, engagementId, "action-corrupt-1");
    setRun(harness, runId, {
      state: "queued",
      createdAt: "2026-08-09T12:00:00.000Z",
      updatedAt: "2026-08-09T12:00:00.000Z",
    });
    harness.database.sqlite
      .prepare("update runs set created_at = 'not-a-timestamp' where id = ?")
      .run(runId);
    const corrupt = await harness.app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/runs`,
    });
    expect(corrupt.statusCode).toBe(500);
    expect(corrupt.json()).toEqual({ code: "invalid_persisted_data" });

    let calls = 0;
    const realBusyRepository = new RunOutputRepository(harness.database.db);
    const busyRepository: Pick<
      RunOutputRepository,
      | "latestTerminalRunForEngagement"
      | "runForEngagement"
      | "artifactsForRun"
      | "listArtifactsForEngagement"
      | "listRunsForEngagement"
    > = {
      latestTerminalRunForEngagement:
        realBusyRepository.latestTerminalRunForEngagement.bind(realBusyRepository),
      runForEngagement: realBusyRepository.runForEngagement.bind(realBusyRepository),
      artifactsForRun: realBusyRepository.artifactsForRun.bind(realBusyRepository),
      listArtifactsForEngagement:
        realBusyRepository.listArtifactsForEngagement.bind(realBusyRepository),
      listRunsForEngagement() {
        calls += 1;
        return { ok: false as const, code: "storage_busy" as const };
      },
    };
    const busyApp = buildApp({
      engagementRepository: harness.engagementRepository,
      runOutputRepository: busyRepository,
      getDevelopmentStorageReadiness: () => "ready",
      logger: false,
    });
    apps.push(busyApp);
    const busy = await busyApp.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/runs`,
    });
    expect(busy.statusCode).toBe(503);
    expect(busy.json()).toEqual({ code: "storage_busy" });
    expect(calls).toBe(1);
  });

  it("refuses runner credentials before repository access and needs no evidence store", async () => {
    const harness = await createHarness();
    const engagementId = createEngagement(harness, "History auth lab");
    const runId = queueRun(harness, engagementId, "action-auth-1");
    setRun(harness, runId, {
      state: "queued",
      createdAt: "2026-08-09T12:00:00.000Z",
      updatedAt: "2026-08-09T12:00:00.000Z",
    });

    // History works without an evidence store, while the artifact-backed
    // output route stays unregistered.
    const anonymous = await harness.app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/runs`,
    });
    expect(anonymous.statusCode).toBe(200);
    const missingOutput = await harness.app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/runs/latest/output`,
    });
    expect(missingOutput.statusCode).toBe(404);

    let calls = 0;
    const realCountingRepository = new RunOutputRepository(harness.database.db);
    const countingRepository: Pick<
      RunOutputRepository,
      | "latestTerminalRunForEngagement"
      | "runForEngagement"
      | "artifactsForRun"
      | "listArtifactsForEngagement"
      | "listRunsForEngagement"
    > = {
      latestTerminalRunForEngagement:
        realCountingRepository.latestTerminalRunForEngagement.bind(
          realCountingRepository,
        ),
      runForEngagement:
        realCountingRepository.runForEngagement.bind(realCountingRepository),
      artifactsForRun:
        realCountingRepository.artifactsForRun.bind(realCountingRepository),
      listArtifactsForEngagement:
        realCountingRepository.listArtifactsForEngagement.bind(realCountingRepository),
      listRunsForEngagement() {
        calls += 1;
        return { ok: true as const, runs: [] };
      },
    };
    const countingApp = buildApp({
      engagementRepository: harness.engagementRepository,
      runOutputRepository: countingRepository,
      getDevelopmentStorageReadiness: () => "ready",
      logger: false,
    });
    apps.push(countingApp);
    for (const url of [
      `/api/v1/engagements/${engagementId}/runs`,
      `/api/v1/engagements/${engagementId}/runs?limit=2`,
      `/api/v1/engagements/${engagementId}/runs?limit=2&before=abc`,
    ]) {
      const refused = await countingApp.inject({
        method: "GET",
        url,
        headers: { authorization: RUNNER_HEADER },
      });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toEqual({ code: "operator_identity_required" });
    }
    expect(calls).toBe(0);

    // Malformed credentials keep existing route behavior instead of the
    // operator-identity refusal.
    const malformed = await countingApp.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/runs`,
      headers: { authorization: "Bearer operator-token" },
    });
    expect(malformed.statusCode).toBe(200);

    // Non-GET keeps the generic runner refusal, never operator_identity_required.
    const posted = await countingApp.inject({
      method: "POST",
      url: `/api/v1/engagements/${engagementId}/runs`,
      headers: { authorization: RUNNER_HEADER },
      payload: {},
    });
    expect(posted.statusCode).toBe(403);
    expect(posted.json()).toEqual({ code: "runner_route_forbidden" });
  });
});
