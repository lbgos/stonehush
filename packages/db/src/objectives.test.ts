import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openEngagementDatabase } from "./database.js";
import { ObjectiveRepository } from "./objectives.js";
import { EngagementRepository } from "./repository.js";

interface Fixture {
  directory: string;
  database: ReturnType<typeof openEngagementDatabase>;
  objectives: ObjectiveRepository;
}

const fixtures: Fixture[] = [];
const PROOF = "flag{synthetic-proof-0001}";

function createFixture(): Fixture & { engagementId: string } {
  const directory = mkdtempSync(path.join(tmpdir(), "blackglass-stone-objectives-test-"));
  chmodSync(directory, 0o700);
  const database = openEngagementDatabase({ dataDirectory: directory });
  let next = 1;
  let minute = 0;
  const providers = {
    createId: () => `10000000-0000-4000-8000-${String(next++).padStart(12, "0")}`,
    now: () => new Date(Date.UTC(2026, 7, 12, 12, minute++)),
  };
  const engagements = new EngagementRepository(database.db, providers);
  const created = engagements.createEngagement({
    name: "Objectives lab",
    kind: "lab",
    description: null,
    authorizationContext: null,
    autoContinueWarnings: false,
  });
  if (!created.ok) throw new Error(`Fixture create failed: ${created.error.code}`);
  const objectives = new ObjectiveRepository(database.db, providers);
  const fixture = { directory, database, objectives };
  fixtures.push(fixture);
  return { ...fixture, engagementId: created.value.id };
}

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture === undefined) continue;
    if (fixture.database.sqlite.open) fixture.database.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

describe("objective persistence", () => {
  it("creates user, root, single-proof, and custom goals", () => {
    const { objectives, engagementId } = createFixture();
    for (const kind of ["user_flag", "root_flag", "single_proof", "custom"] as const) {
      const created = objectives.createObjective(engagementId, { name: `${kind} goal`, kind });
      expect(created.ok).toBe(true);
    }
    const listed = objectives.listObjectives(engagementId);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(4);
  });

  it("captures without persisting the proof value and submits as a separate user-recorded step", () => {
    const { database, objectives, engagementId } = createFixture();
    const created = objectives.createObjective(engagementId, { name: "user flag", kind: "user_flag" });
    if (!created.ok) throw new Error("setup failed");
    const captured = objectives.captureObjective(engagementId, created.value.id, {
      proofValue: PROOF,
    });
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(captured.value.state).toBe("captured");
    expect(captured.value.capturedAt).not.toBe(null);
    expect(captured.value.submittedAt).toBe(null);
    expect(captured.value.proofDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(captured.value.proofHint).not.toContain(PROOF);
    expect(JSON.stringify(captured.value)).not.toContain(PROOF);
    // The raw value reaches no stored column: scan the row text.
    const row = database.sqlite
      .prepare(`select * from objectives where id = ?`)
      .get(created.value.id) as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain(PROOF);
    const submitted = objectives.submitObjective(engagementId, created.value.id);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    expect(submitted.value.state).toBe("submitted");
    expect(submitted.value.submittedAt).not.toBe(null);
    expect(submitted.value.capturedAt).not.toBe(submitted.value.submittedAt);
  });

  it("rejects out-of-order transitions: submit before capture, capture twice", () => {
    const { objectives, engagementId } = createFixture();
    const created = objectives.createObjective(engagementId, { name: "goal", kind: "custom" });
    if (!created.ok) throw new Error("setup failed");
    expect(objectives.submitObjective(engagementId, created.value.id).ok).toBe(false);
    const captured = objectives.captureObjective(engagementId, created.value.id, {
      proofValue: PROOF,
    });
    expect(captured.ok).toBe(true);
    expect(
      objectives.captureObjective(engagementId, created.value.id, { proofValue: PROOF }).ok,
    ).toBe(false);
  });

  it("reopens a captured objective back to open", () => {
    const { objectives, engagementId } = createFixture();
    const created = objectives.createObjective(engagementId, { name: "goal", kind: "custom" });
    if (!created.ok) throw new Error("setup failed");
    const captured = objectives.captureObjective(engagementId, created.value.id, {
      proofValue: PROOF,
    });
    expect(captured.ok).toBe(true);
    const reopened = objectives.reopenObjective(engagementId, created.value.id);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.value.state).toBe("open");
    expect(reopened.value.proofDigest).toBe(null);
  });

  it("rejects mutations on archived engagements but keeps reads", () => {
    const { database, objectives, engagementId } = createFixture();
    const created = objectives.createObjective(engagementId, { name: "goal", kind: "custom" });
    if (!created.ok) throw new Error("setup failed");
    database.sqlite
      .prepare(`update engagements set status = 'archived' where id = ?`)
      .run(engagementId);
    expect(
      objectives.createObjective(engagementId, { name: "another", kind: "custom" }).ok,
    ).toBe(false);
    expect(
      objectives.captureObjective(engagementId, created.value.id, { proofValue: PROOF }).ok,
    ).toBe(false);
    expect(objectives.listObjectives(engagementId).ok).toBe(true);
  });
});
