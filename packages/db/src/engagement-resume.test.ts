import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openEngagementDatabase } from "./database.js";
import { EngagementResumeRepository } from "./engagement-resume.js";
import { EngagementRepository } from "./repository.js";

interface Fixture {
  directory: string;
  database: ReturnType<typeof openEngagementDatabase>;
  engagements: EngagementRepository;
  resume: EngagementResumeRepository;
}

const fixtures: Fixture[] = [];

function createFixture(): Fixture {
  const directory = mkdtempSync(path.join(tmpdir(), "stonehush-resume-test-"));
  chmodSync(directory, 0o700);
  const database = openEngagementDatabase({ dataDirectory: directory });
  let minute = 0;
  const engagements = new EngagementRepository(database.db, {
    createId: () => "10000000-0000-4000-8000-000000000001",
    now: () => new Date(Date.UTC(2026, 8, 10, 12, minute++)),
  });
  const resume = new EngagementResumeRepository(database.db, {
    now: () => new Date(Date.UTC(2026, 8, 10, 12, minute++)),
  });
  const fixture = { directory, database, engagements, resume };
  fixtures.push(fixture);
  return fixture;
}

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture === undefined) continue;
    if (fixture.database.sqlite.open) fixture.database.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

describe("engagement next-step persistence", () => {
  it("reads cleared revision 0, writes one sentence, and clears again", () => {
    const { engagements, resume } = createFixture();
    const created = engagements.createEngagement({
      name: "Resume lab",
      kind: "lab",
      description: null,
      authorizationContext: null,
      autoContinueWarnings: false,
    });
    if (!created.ok) throw new Error(`Fixture create failed: ${created.error.code}`);
    const id = created.value.id;

    const initial = resume.getNextStep(id);
    if (!initial.ok) throw new Error("initial read failed");
    expect(initial.value).toMatchObject({ nextStep: null, revision: 0 });

    const saved = resume.putNextStep(id, { nextStep: "Probe port 8080 next.", expectedRevision: 0 });
    if (!saved.ok) throw new Error("save failed");
    expect(saved.value).toMatchObject({ nextStep: "Probe port 8080 next.", revision: 1 });

    const cleared = resume.putNextStep(id, { nextStep: null, expectedRevision: 1 });
    if (!cleared.ok) throw new Error("clear failed");
    expect(cleared.value).toMatchObject({ nextStep: null, revision: 2 });
  });

  it("rejects multiline steps, stale revisions, and archived engagements", () => {
    const { engagements, resume } = createFixture();
    const created = engagements.createEngagement({
      name: "Resume lab 2",
      kind: "lab",
      description: null,
      authorizationContext: null,
      autoContinueWarnings: false,
    });
    if (!created.ok) throw new Error(`Fixture create failed: ${created.error.code}`);
    const id = created.value.id;

    expect(resume.putNextStep(id, { nextStep: "one\ntwo", expectedRevision: 0 }).ok).toBe(false);
    expect(resume.putNextStep(id, { nextStep: "x".repeat(281), expectedRevision: 0 }).ok).toBe(false);

    const saved = resume.putNextStep(id, { nextStep: "First step.", expectedRevision: 0 });
    if (!saved.ok) throw new Error("save failed");
    const stale = resume.putNextStep(id, { nextStep: "Stale step.", expectedRevision: 0 });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("revision_conflict");

    const archived = engagements.archive(id, created.value.revision);
    if (!archived.ok) throw new Error("archive failed");
    const afterArchive = resume.putNextStep(id, { nextStep: "Too late.", expectedRevision: 1 });
    expect(afterArchive.ok).toBe(false);
  });

  it("returns engagement_not_found for unknown engagements", () => {
    const { resume } = createFixture();
    const result = resume.getNextStep("10000000-0000-4000-8000-000000000099");
    expect(result.ok).toBe(false);
  });
});
