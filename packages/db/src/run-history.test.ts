import { mkdtempSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ActionSnapshot } from "@stonehush/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { bindActionSnapshot } from "./action-snapshot.js";
import { openEngagementDatabase } from "./database.js";
import { EngagementRepository } from "./repository.js";
import { RunRepository } from "./run.js";
import { RunOutputRepository } from "./run-output.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
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

function createHarness() {
  const directory = mkdtempSync(path.join(tmpdir(), "run-history-repo-"));
  chmodSync(directory, 0o700);
  directories.push(directory);
  const database = openEngagementDatabase({ dataDirectory: directory });
  let engagementSeq = 0;
  const engagements = new EngagementRepository(database.db, {
    createId: () =>
      `10000000-0000-4000-8000-${String(++engagementSeq).padStart(12, "0")}`,
    now: () => new Date("2026-08-09T12:00:00.000Z"),
  });
  const runs = new RunRepository(database.db, {
    now: () => new Date("2026-08-09T12:00:00.000Z"),
  });
  const outputs = new RunOutputRepository(database.db);
  return { database, engagements, runs, outputs };
}

function createEngagement(harness: ReturnType<typeof createHarness>, name: string): string {
  const engagement = harness.engagements.createEngagement({
    name,
    kind: "lab",
    description: null,
    authorizationContext: "Synthetic fixture authorization context",
    autoContinueWarnings: false,
  });
  if (!engagement.ok) throw new Error(engagement.error.code);
  return engagement.value.id;
}

function queueRun(
  harness: ReturnType<typeof createHarness>,
  engagementId: string,
  actionId: string,
): string {
  const planned = harness.engagements.persistPlannedAction({
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
  harness: ReturnType<typeof createHarness>,
  runId: string,
  patch: { state: string; createdAt: string; updatedAt: string },
): void {
  const terminalKind =
    patch.state === "succeeded" ||
    patch.state === "failed" ||
    patch.state === "cancelled"
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

describe("run history repository", () => {
  it("lists all seven states with attempts in descending createdAt/id order", () => {
    const harness = createHarness();
    const engagementId = createEngagement(harness, "History states lab");
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
      const actionId = `action-history-${index}`;
      const runId = queueRun(harness, engagementId, actionId);
      const minute = String(index).padStart(2, "0");
      setRun(harness, runId, {
        state,
        createdAt: `2026-08-09T12:${minute}:00.000Z`,
        updatedAt: `2026-08-09T12:${minute}:00.000Z`,
      });
    });
    // Retry attempt for the first action: terminal then a second queued run.
    const retryAction = "action-history-retry";
    const firstRetry = queueRun(harness, engagementId, retryAction);
    setRun(harness, firstRetry, {
      state: "failed",
      createdAt: "2026-08-09T11:00:00.000Z",
      updatedAt: "2026-08-09T11:01:00.000Z",
    });
    harness.database.sqlite
      .prepare(
        `insert into runs (id, contract_version, action_id, engagement_id, attempt, state, current_lease_id, current_fence, terminal_kind, terminal_reason, created_at, updated_at) values ('run-retry-2',1,?, ?,2,'queued',null,'0',null,null,'2026-08-09T12:07:00.000Z','2026-08-09T12:07:00.000Z')`,
      )
      .run(retryAction, engagementId);

    const listed = harness.outputs.listRunsForEngagement(engagementId, { limit: 100 });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error("list failed");
    expect(listed.runs).toHaveLength(9);
    const ordered = [...listed.runs];
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1] as { createdAt: string; id: string };
      const current = ordered[index] as { createdAt: string; id: string };
      const before =
        previous.createdAt > current.createdAt ||
        (previous.createdAt === current.createdAt && previous.id > current.id);
      expect(before).toBe(true);
    }
    const statesSeen = new Set(listed.runs.map((run) => run.state));
    for (const state of states) expect(statesSeen.has(state)).toBe(true);
    const retryRows = listed.runs.filter((run) => run.actionId === retryAction);
    expect(retryRows.map((run) => run.attempt).sort()).toEqual([1, 2]);
    // Exact terminal projection per state: non-terminal rows carry null
    // terminals, terminal rows carry their kind and reason.
    const expectedTerminals: Record<string, { kind: string | null; reason: string | null }> = {
      queued: { kind: null, reason: null },
      leased: { kind: null, reason: null },
      running: { kind: null, reason: null },
      cancel_requested: { kind: null, reason: null },
      succeeded: { kind: "succeeded", reason: null },
      failed: { kind: "failed", reason: "operator_cancelled" },
      cancelled: { kind: "cancelled", reason: "operator_cancelled" },
    };
    for (const [index, state] of states.entries()) {
      const row = listed.runs.find((run) => run.actionId === `action-history-${index}`);
      expect(row?.state).toBe(state);
      expect(row?.terminalKind).toBe(expectedTerminals[state]?.kind ?? null);
      expect(row?.terminalReason).toBe(expectedTerminals[state]?.reason ?? null);
    }
    harness.database.close();
  });

  it("pages timestamp ties by id and keeps newer inserts and state updates stable", () => {
    const harness = createHarness();
    const engagementId = createEngagement(harness, "History ties lab");
    const tiedAt = "2026-08-09T12:00:00.000Z";
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const runId = queueRun(harness, engagementId, `action-tie-${index}`);
      setRun(harness, runId, { state: "queued", createdAt: tiedAt, updatedAt: tiedAt });
      ids.push(runId);
    }
    const expectedDesc = [...ids].sort().reverse();
    const first = harness.outputs.listRunsForEngagement(engagementId, { limit: 2 });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("first page failed");
    // Repository fetches limit plus one for the has-more lookahead.
    expect(first.runs).toHaveLength(3);
    expect(first.runs.map((run) => run.id)).toEqual(expectedDesc.slice(0, 3));

    const boundary = {
      createdAt: (first.runs[1] as { createdAt: string }).createdAt,
      id: (first.runs[1] as { id: string }).id,
    };
    const secondBefore = harness.outputs.listRunsForEngagement(engagementId, {
      limit: 2,
      before: boundary,
    });
    expect(secondBefore.ok).toBe(true);
    if (!secondBefore.ok) throw new Error("second page failed");
    expect(secondBefore.runs.map((run) => run.id)).toEqual(expectedDesc.slice(2, 5));

    // Newer run inserted after the first page does not move the second page.
    const newer = queueRun(harness, engagementId, "action-tie-newer");
    setRun(harness, newer, {
      state: "queued",
      createdAt: "2026-08-09T13:00:00.000Z",
      updatedAt: "2026-08-09T13:00:00.000Z",
    });
    // State update on an already paged row (updatedAt only) keeps ordering.
    harness.database.sqlite
      .prepare("update runs set state = 'running', updated_at = '2026-08-09T14:00:00.000Z' where id = ?")
      .run(expectedDesc[0] as string);
    const secondAfter = harness.outputs.listRunsForEngagement(engagementId, {
      limit: 2,
      before: boundary,
    });
    expect(secondAfter.ok).toBe(true);
    if (!secondAfter.ok || !secondBefore.ok) throw new Error("stable page failed");
    expect(secondAfter.runs.map((run) => run.id)).toEqual(
      secondBefore.runs.map((run) => run.id),
    );
    harness.database.close();
  });

  it("returns empty for a known engagement, keeps archived readable, and 404s missing", () => {
    const harness = createHarness();
    const engagementId = createEngagement(harness, "History empty lab");
    expect(harness.outputs.listRunsForEngagement(engagementId, { limit: 25 })).toEqual({
      ok: true,
      runs: [],
    });
    harness.database.sqlite
      .prepare("update engagements set status = 'archived' where id = ?")
      .run(engagementId);
    expect(harness.outputs.listRunsForEngagement(engagementId, { limit: 25 })).toEqual({
      ok: true,
      runs: [],
    });
    expect(
      harness.outputs.listRunsForEngagement("10000000-0000-4000-8000-000000000099", {
        limit: 25,
      }),
    ).toEqual({ ok: false, code: "engagement_not_found" });
    harness.database.close();
  });

  it("isolates engagements and maps corrupt rows to invalid_persisted_data", () => {
    const harness = createHarness();
    const first = createEngagement(harness, "History isolation A");
    const second = createEngagement(harness, "History isolation B");
    const runA = queueRun(harness, first, "action-iso-a");
    const runB = queueRun(harness, second, "action-iso-b");
    setRun(harness, runA, {
      state: "queued",
      createdAt: "2026-08-09T12:00:00.000Z",
      updatedAt: "2026-08-09T12:00:00.000Z",
    });
    setRun(harness, runB, {
      state: "queued",
      createdAt: "2026-08-09T12:00:00.000Z",
      updatedAt: "2026-08-09T12:00:00.000Z",
    });
    const listedA = harness.outputs.listRunsForEngagement(first, { limit: 25 });
    expect(listedA.ok).toBe(true);
    if (!listedA.ok) throw new Error("isolation list failed");
    expect(listedA.runs.map((run) => run.id)).toEqual([runA]);

    harness.database.sqlite
      .prepare("update runs set created_at = 'not-a-timestamp' where id = ?")
      .run(runA);
    expect(harness.outputs.listRunsForEngagement(first, { limit: 25 })).toEqual({
      ok: false,
      code: "invalid_persisted_data",
    });
    harness.database.close();
  });

  it("excludes rows with corrupted run/action ownership from both engagements", () => {
    const harness = createHarness();
    const first = createEngagement(harness, "History corrupt ownership A");
    const second = createEngagement(harness, "History corrupt ownership B");
    const runA = queueRun(harness, first, "action-corrupt-owner");
    setRun(harness, runA, {
      state: "queued",
      createdAt: "2026-08-09T12:00:00.000Z",
      updatedAt: "2026-08-09T12:00:00.000Z",
    });
    // Sanity: the clean row is visible in its own engagement only.
    const clean = harness.outputs.listRunsForEngagement(first, { limit: 25 });
    expect(clean.ok).toBe(true);
    if (!clean.ok) throw new Error("clean list failed");
    expect(clean.runs.map((run) => run.id)).toEqual([runA]);

    // Deliberate test-only corruption: move runs.engagement_id apart from
    // actions.engagement_id with FK enforcement off, then restore it. The
    // temp database is closed after this test so the corruption never
    // affects real data.
    harness.database.sqlite.pragma("foreign_keys = OFF");
    try {
      harness.database.sqlite
        .prepare("update runs set engagement_id = ? where id = ?")
        .run(second, runA);
    } finally {
      harness.database.sqlite.pragma("foreign_keys = ON");
    }
    expect(harness.database.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(harness.outputs.listRunsForEngagement(first, { limit: 25 })).toEqual({
      ok: true,
      runs: [],
    });
    expect(harness.outputs.listRunsForEngagement(second, { limit: 25 })).toEqual({
      ok: true,
      runs: [],
    });
    harness.database.close();
  });

  it("maps invalid persisted identifiers to invalid_persisted_data", () => {
    const harness = createHarness();
    const engagementId = createEngagement(harness, "History corrupt identifier lab");
    const runId = queueRun(harness, engagementId, "action-corrupt-id");
    setRun(harness, runId, {
      state: "queued",
      createdAt: "2026-08-09T12:00:00.000Z",
      updatedAt: "2026-08-09T12:00:00.000Z",
    });
    // Test-only corruption of a column with no storage CHECK: the empty
    // lease id passes SQLite but fails PersistedRunSchema identifier rules.
    harness.database.sqlite
      .prepare("update runs set current_lease_id = '' where id = ?")
      .run(runId);
    expect(harness.outputs.listRunsForEngagement(engagementId, { limit: 25 })).toEqual({
      ok: false,
      code: "invalid_persisted_data",
    });
    harness.database.close();
  });
});
