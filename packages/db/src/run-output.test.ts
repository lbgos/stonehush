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
  const directory = mkdtempSync(path.join(tmpdir(), "run-output-repo-"));
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

describe("run output repository", () => {
  it("returns undefined before any terminal run and picks the latest terminal", () => {
    const harness = createHarness();
    const engagement = harness.engagements.createEngagement({
      name: "Output repo lab",
      kind: "lab",
      description: null,
      authorizationContext: "Synthetic fixture authorization context",
      autoContinueWarnings: false,
    });
    if (!engagement.ok) throw new Error(engagement.error.code);
    const engagementId = engagement.value.id;
    const first = queueRun(harness, engagementId, "action-repo-1");
    expect(harness.outputs.latestTerminalRunForEngagement(engagementId)).toEqual({
      ok: true,
      run: undefined,
    });
    // Non-terminal runs are hidden from the per-run lookup.
    expect(harness.outputs.runForEngagement(engagementId, first)).toEqual({
      ok: true,
      run: expect.objectContaining({ id: first, state: "queued" }),
    });

    harness.database.sqlite
      .prepare("update runs set state = 'succeeded', terminal_kind = 'succeeded', current_fence = '1', updated_at = '2026-08-09T12:01:00.000Z' where id = ?")
      .run(first);
    const second = queueRun(harness, engagementId, "action-repo-2");
    harness.database.sqlite
      .prepare("update runs set state = 'cancelled', terminal_kind = 'cancelled', terminal_reason = 'operator_cancelled', current_fence = '1', updated_at = '2026-08-09T12:02:00.000Z' where id = ?")
      .run(second);

    const latest = harness.outputs.latestTerminalRunForEngagement(engagementId);
    expect(latest).toEqual({ ok: true, run: expect.objectContaining({ id: second }) });
    harness.database.close();
  });

  it("reports engagement_not_found and isolates engagements", () => {
    const harness = createHarness();
    expect(
      harness.outputs.latestTerminalRunForEngagement(
        "10000000-0000-4000-8000-000000000099",
      ),
    ).toEqual({ ok: false, code: "engagement_not_found" });
    const engagement = harness.engagements.createEngagement({
      name: "Isolation lab",
      kind: "lab",
      description: null,
      authorizationContext: "Synthetic fixture authorization context",
      autoContinueWarnings: false,
    });
    if (!engagement.ok) throw new Error(engagement.error.code);
    const runId = queueRun(harness, engagement.value.id, "action-repo-iso");
    expect(
      harness.outputs.runForEngagement(
        "10000000-0000-4000-8000-000000000099",
        runId,
      ),
    ).toEqual({ ok: false, code: "engagement_not_found" });
    expect(
      harness.outputs.runForEngagement(engagement.value.id, "missing-run"),
    ).toEqual({ ok: true, run: undefined });
    harness.database.close();
  });
});
