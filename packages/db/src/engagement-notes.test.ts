import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openEngagementDatabase } from "./database.js";
import { EngagementRepository } from "./repository.js";

const NOTES_ID = "10000000-0000-4000-8000-000000000001";
const UNKNOWN_ID = "10000000-0000-4000-8000-000000000099";

interface Fixture {
  directory: string;
  database: ReturnType<typeof openEngagementDatabase>;
  repository: EngagementRepository;
}

const fixtures: Fixture[] = [];

function createFixture(): Fixture {
  const directory = mkdtempSync(path.join(tmpdir(), "stonehush-notes-test-"));
  chmodSync(directory, 0o700);
  const database = openEngagementDatabase({ dataDirectory: directory });
  let minute = 0;
  const repository = new EngagementRepository(database.db, {
    createId: () => NOTES_ID,
    now: () => new Date(Date.UTC(2026, 7, 12, 12, minute++)),
  });
  const fixture = { directory, database, repository };
  fixtures.push(fixture);
  return fixture;
}

function createEngagement(repository: EngagementRepository) {
  const result = repository.createEngagement({
    name: "Notes lab",
    kind: "lab",
    description: null,
    authorizationContext: null,
    autoContinueWarnings: false,
  });
  if (!result.ok) throw new Error(`Fixture create failed: ${result.error.code}`);
  return result.value;
}

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture === undefined) continue;
    if (fixture.database.sqlite.open) fixture.database.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

describe("engagement notes persistence", () => {
  it("returns revision 0 before the first save", () => {
    const { repository } = createFixture();
    const engagement = createEngagement(repository);

    expect(repository.getEngagementNotes(engagement.id)).toEqual({
      ok: true,
      value: {
        engagementId: engagement.id,
        markdown: "",
        updatedAt: engagement.updatedAt,
        revision: 0,
      },
    });
  });

  it("writes 0 -> 1 on first save and 1 -> 2 on the next save", () => {
    const { repository } = createFixture();
    const engagement = createEngagement(repository);

    const first = repository.putEngagementNotes(engagement.id, {
      markdown: "# creds\nadmin / secret",
      expectedRevision: 0,
    });
    expect(first).toMatchObject({
      ok: true,
      value: { markdown: "# creds\nadmin / secret", revision: 1 },
    });
    if (!first.ok) throw new Error(`Fixture save failed: ${first.error.code}`);
    const second = repository.putEngagementNotes(engagement.id, {
      markdown: "# updated\nflag{second}",
      expectedRevision: first.value.revision,
    });
    if (!second.ok) throw new Error(`Fixture save failed: ${second.error.code}`);
    expect(second.value.revision).toBe(2);

    expect(repository.getEngagementNotes(engagement.id)).toEqual({
      ok: true,
      value: second.value,
    });
  });

  it("rejects a stale write without storing", () => {
    const { repository } = createFixture();
    const engagement = createEngagement(repository);
    const first = repository.putEngagementNotes(engagement.id, {
      markdown: "# v1",
      expectedRevision: 0,
    });
    if (!first.ok) throw new Error(`Fixture save failed: ${first.error.code}`);

    expect(
      repository.putEngagementNotes(engagement.id, {
        markdown: "# stale",
        expectedRevision: 0,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "revision_conflict",
        currentRevision: 1,
      },
    });
    expect(repository.getEngagementNotes(engagement.id)).toMatchObject({
      ok: true,
      value: { markdown: "# v1", revision: 1 },
    });
  });

  it("rejects the second first-save and unsafe revisions", () => {
    const { repository } = createFixture();
    const engagement = createEngagement(repository);
    const first = repository.putEngagementNotes(engagement.id, {
      markdown: "# winner",
      expectedRevision: 0,
    });
    if (!first.ok) throw new Error(`Fixture save failed: ${first.error.code}`);

    expect(
      repository.putEngagementNotes(engagement.id, {
        markdown: "# loser",
        expectedRevision: 0,
      }),
    ).toMatchObject({ ok: false, error: { code: "revision_conflict", currentRevision: 1 } });
    expect(
      repository.putEngagementNotes(engagement.id, { markdown: "# notes" }),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
    expect(
      repository.putEngagementNotes(engagement.id, {
        markdown: "# notes",
        expectedRevision: -1,
      }),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
    expect(
      repository.putEngagementNotes(engagement.id, {
        markdown: "# notes",
        expectedRevision: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
  });

  it("prefers archived over revision conflict", () => {
    const { repository } = createFixture();
    const engagement = createEngagement(repository);
    const first = repository.putEngagementNotes(engagement.id, {
      markdown: "# v1",
      expectedRevision: 0,
    });
    if (!first.ok) throw new Error(`Fixture save failed: ${first.error.code}`);
    const archived = repository.archive(engagement.id, engagement.revision);
    if (!archived.ok) throw new Error(`Fixture archive failed: ${archived.error.code}`);

    expect(
      repository.putEngagementNotes(engagement.id, {
        markdown: "# stale",
        expectedRevision: 0,
      }),
    ).toEqual({ ok: false, error: { code: "engagement_archived" } });
  });

  it("rejects oversize markdown and unknown engagements without storing", () => {
    const { repository } = createFixture();
    const engagement = createEngagement(repository);

    expect(
      repository.putEngagementNotes(engagement.id, {
        markdown: "a".repeat(65_537),
        expectedRevision: 0,
      }),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
    expect(
      repository.putEngagementNotes(UNKNOWN_ID, { markdown: "# notes", expectedRevision: 0 }),
    ).toEqual({ ok: false, error: { code: "engagement_not_found" } });
    expect(repository.getEngagementNotes(UNKNOWN_ID)).toEqual({
      ok: false,
      error: { code: "engagement_not_found" },
    });
    expect(repository.getEngagementNotes(engagement.id)).toMatchObject({
      ok: true,
      value: { markdown: "", revision: 0 },
    });
  });

  it("preserves existing markdown through the revision migration", () => {
    const { repository, database } = createFixture();
    const engagement = createEngagement(repository);
    const saved = repository.putEngagementNotes(engagement.id, {
      markdown: "# migrated",
      expectedRevision: 0,
    });
    if (!saved.ok) throw new Error(`Fixture save failed: ${saved.error.code}`);
    const row = database.sqlite
      .prepare("select engagement_id, markdown, revision from engagement_notes where engagement_id = ?")
      .get(engagement.id) as { engagement_id: string; markdown: string; revision: number };
    expect(row.markdown).toBe("# migrated");
    expect(row.revision).toBe(1);
  });
});
