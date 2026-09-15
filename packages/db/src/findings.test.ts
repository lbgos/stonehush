import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openEngagementDatabase } from "./database.js";
import { EngagementRepository } from "./repository.js";

const UNKNOWN_ID = "10000000-0000-4000-8000-000000000099";

interface Fixture {
  directory: string;
  database: ReturnType<typeof openEngagementDatabase>;
  repository: EngagementRepository;
}

const fixtures: Fixture[] = [];

function createFixture(): Fixture {
  const directory = mkdtempSync(path.join(tmpdir(), "stonehush-findings-test-"));
  chmodSync(directory, 0o700);
  const database = openEngagementDatabase({ dataDirectory: directory });
  let next = 1;
  let minute = 0;
  const repository = new EngagementRepository(database.db, {
    createId: () => `10000000-0000-4000-8000-${String(next++).padStart(12, "0")}`,
    now: () => new Date(Date.UTC(2026, 7, 12, 12, minute++)),
  });
  const fixture = { directory, database, repository };
  fixtures.push(fixture);
  return fixture;
}

function createEngagement(repository: EngagementRepository) {
  const result = repository.createEngagement({
    name: "Findings lab",
    kind: "lab",
    description: null,
    authorizationContext: null,
    autoContinueWarnings: false,
  });
  if (!result.ok) throw new Error(`Fixture create failed: ${result.error.code}`);
  return result.value;
}

const ARTIFACT_DIGEST =
  "sha256:0000000000000000000000000000000000000000000000000000000000000000";

function seedRun(
  database: Fixture["database"],
  engagementId: string,
  actionId: string,
  runId: string,
) {
  const now = new Date(Date.UTC(2026, 7, 12, 12, 0)).toISOString();
  database.sqlite
    .prepare(
      `insert into actions (id, contract_version, engagement_id, revision, state, queued_snapshot_version, warning_interactions, run_state, resume_requested, cleanup_required, capability_error_code, pending_warning_json, created_at, updated_at) values (?,1,?,1,'active',1,0,'running',0,0,null,null,?,?)`,
    )
    .run(actionId, engagementId, now, now);
  database.sqlite
    .prepare(
      `insert into runs (id, contract_version, action_id, engagement_id, attempt, state, current_lease_id, current_fence, terminal_kind, terminal_reason, created_at, updated_at) values (?,1,?, ?,1,'running','lease-1','1',null,null,?,?)`,
    )
    .run(runId, actionId, engagementId, now, now);
}

function seedArtifact(
  database: Fixture["database"],
  artifactId: string,
  runId: string,
  eventSequence = 1,
  completeness: "complete" | "partial" | "truncated" = "complete",
) {
  database.sqlite
    .prepare(
      `insert into evidence_artifacts (artifact_id, contract_version, profile, run_id, fence, event_sequence, artifact_slot, kind, size_bytes, digest, relative_path, completeness, redaction_applied, redaction_boundary, raw_bytes_preserved, created_at) values (?,1,'d3-v1',?,'1',?,'finding-evidence','tool_raw',?,?,?, ?,0,'none',1,?)`,
    )
    .run(
      artifactId,
      runId,
      eventSequence,
      10,
      ARTIFACT_DIGEST,
      `published/${artifactId}`,
      completeness,
      new Date(Date.UTC(2026, 7, 12, 12, 0)).toISOString(),
    );
}

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture === undefined) continue;
    if (fixture.database.sqlite.open) fixture.database.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

describe("findings persistence", () => {
  it("creates and lists findings scoped to one engagement", () => {
    const { database, repository } = createFixture();
    const first = createEngagement(repository);
    const second = createEngagement(repository);

    expect(repository.listFindings(first.id)).toEqual({ ok: true, value: [] });

    seedRun(database, first.id, "finding-action-1", "finding-run-1");
    seedArtifact(database, "nmap-xml-1", "finding-run-1");

    const created = repository.createFinding(first.id, {
      title: "Default credentials",
      severity: "high",
      body: "# impact\nAdmin access.",
      evidenceArtifactIds: ["nmap-xml-1"],
    });
    if (!created.ok) throw new Error(`Create failed: ${created.error.code}`);
    expect(created.value).toMatchObject({
      engagementId: first.id,
      title: "Default credentials",
      severity: "high",
      status: "open",
      evidenceArtifactIds: ["nmap-xml-1"],
    });

    const listed = repository.listFindings(first.id);
    if (!listed.ok) throw new Error(`List failed: ${listed.error.code}`);
    expect(listed.value.map((finding) => finding.id)).toEqual([created.value.id]);
    expect(repository.listFindings(second.id)).toEqual({ ok: true, value: [] });
    expect(repository.listFindings(UNKNOWN_ID)).toEqual({
      ok: false,
      error: { code: "engagement_not_found" },
    });
  });

  it("resolves and reopens with transition validation", () => {
    const { repository } = createFixture();
    const engagement = createEngagement(repository);
    const created = repository.createFinding(engagement.id, {
      title: "Open banner",
      severity: "low",
      body: "banner",
    });
    if (!created.ok) throw new Error(`Create failed: ${created.error.code}`);

    const resolved = repository.resolveFinding(engagement.id, created.value.id);
    if (!resolved.ok) throw new Error(`Resolve failed: ${resolved.error.code}`);
    expect(resolved.value.status).toBe("resolved");

    expect(repository.resolveFinding(engagement.id, created.value.id)).toEqual({
      ok: false,
      error: { code: "invalid_finding_transition" },
    });

    const reopened = repository.reopenFinding(engagement.id, created.value.id);
    if (!reopened.ok) throw new Error(`Reopen failed: ${reopened.error.code}`);
    expect(reopened.value.status).toBe("open");

    expect(repository.reopenFinding(engagement.id, created.value.id)).toEqual({
      ok: false,
      error: { code: "invalid_finding_transition" },
    });
    expect(repository.resolveFinding(engagement.id, UNKNOWN_ID)).toEqual({
      ok: false,
      error: { code: "finding_not_found" },
    });
  });

  it("rejects invalid input and archived engagement writes", () => {
    const { repository } = createFixture();
    const engagement = createEngagement(repository);

    expect(
      repository.createFinding(engagement.id, {
        title: "  padded  ",
        severity: "low",
        body: "",
      }),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
    expect(
      repository.createFinding(engagement.id, {
        title: "Finding",
        severity: "unknown",
        body: "",
      }),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
    expect(
      repository.createFinding(UNKNOWN_ID, {
        title: "Finding",
        severity: "low",
        body: "",
      }),
    ).toEqual({ ok: false, error: { code: "engagement_not_found" } });

    const archived = repository.archive(engagement.id, engagement.revision);
    if (!archived.ok) throw new Error(`Archive failed: ${archived.error.code}`);

    expect(
      repository.createFinding(engagement.id, {
        title: "Late finding",
        severity: "low",
        body: "",
      }),
    ).toEqual({ ok: false, error: { code: "engagement_archived" } });

    const fresh = createFixture();
    const active = createEngagement(fresh.repository);
    const created = fresh.repository.createFinding(active.id, {
      title: "Active finding",
      severity: "medium",
      body: "",
    });
    if (!created.ok) throw new Error(`Create failed: ${created.error.code}`);
    const archivedActive = fresh.repository.archive(active.id, active.revision);
    if (!archivedActive.ok) throw new Error(`Archive failed: ${archivedActive.error.code}`);
    expect(
      fresh.repository.resolveFinding(active.id, created.value.id),
    ).toEqual({ ok: false, error: { code: "engagement_archived" } });
    expect(
      fresh.repository.reopenFinding(active.id, created.value.id),
    ).toEqual({ ok: false, error: { code: "engagement_archived" } });
  });

  it("accepts owned evidence and rejects foreign, missing, and mixed references atomically", () => {
    const { database, repository } = createFixture();
    const first = createEngagement(repository);
    const second = createEngagement(repository);

    seedRun(database, first.id, "owned-action-1", "owned-run-1");
    seedArtifact(database, "owned-art-1", "owned-run-1", 1);
    seedArtifact(database, "owned-art-2", "owned-run-1", 2);
    seedArtifact(database, "owned-partial-1", "owned-run-1", 3, "partial");
    seedArtifact(database, "owned-truncated-1", "owned-run-1", 4, "truncated");
    seedRun(database, second.id, "foreign-action-1", "foreign-run-1");
    seedArtifact(database, "foreign-art-1", "foreign-run-1", 1);

    expect(
      repository.createFinding(first.id, {
        title: "Empty evidence",
        severity: "low",
        body: "",
        evidenceArtifactIds: [],
      }),
    ).toEqual(expect.objectContaining({ ok: true }));

    const single = repository.createFinding(first.id, {
      title: "Single evidence",
      severity: "low",
      body: "",
      evidenceArtifactIds: ["owned-art-1"],
    });
    if (!single.ok) throw new Error(`Owned single failed: ${single.error.code}`);

    const multi = repository.createFinding(first.id, {
      title: "Multi evidence",
      severity: "low",
      body: "",
      evidenceArtifactIds: ["owned-art-1", "owned-art-2"],
    });
    if (!multi.ok) throw new Error(`Owned multi failed: ${multi.error.code}`);

    for (const completeness of ["owned-partial-1", "owned-truncated-1"]) {
      const kept = repository.createFinding(first.id, {
        title: "Historical evidence",
        severity: "low",
        body: "",
        evidenceArtifactIds: [completeness],
      });
      if (!kept.ok) throw new Error(`Historical failed: ${kept.error.code}`);
    }

    const before = repository.listFindings(first.id);
    if (!before.ok) throw new Error(`List failed: ${before.error.code}`);
    const count = before.value.length;

    for (const evidenceArtifactIds of [
      ["missing-art-1"],
      ["foreign-art-1"],
      ["owned-art-1", "foreign-art-1"],
      ["owned-art-1", "missing-art-1"],
    ]) {
      expect(
        repository.createFinding(first.id, {
          title: "Bad evidence",
          severity: "low",
          body: "",
          evidenceArtifactIds,
        }),
      ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
    }

    const after = repository.listFindings(first.id);
    if (!after.ok) throw new Error(`List failed: ${after.error.code}`);
    expect(after.value).toHaveLength(count);
  });

  it("accepts duplicate references to the same owned artifact", () => {
    const { database, repository } = createFixture();
    const engagement = createEngagement(repository);
    seedRun(database, engagement.id, "dup-action-1", "dup-run-1");
    seedArtifact(database, "dup-art-1", "dup-run-1", 1);

    const created = repository.createFinding(engagement.id, {
      title: "Duplicate evidence",
      severity: "low",
      body: "",
      evidenceArtifactIds: ["dup-art-1", "dup-art-1"],
    });
    if (!created.ok) throw new Error(`Duplicate failed: ${created.error.code}`);
    expect(created.value.evidenceArtifactIds).toEqual(["dup-art-1", "dup-art-1"]);
  });

  it("prefers archived-engagement error over evidence validation", () => {
    const { database, repository } = createFixture();
    const engagement = createEngagement(repository);
    seedRun(database, engagement.id, "arch-action-1", "arch-run-1");
    seedArtifact(database, "arch-art-1", "arch-run-1", 1);
    const archived = repository.archive(engagement.id, engagement.revision);
    if (!archived.ok) throw new Error(`Archive failed: ${archived.error.code}`);

    for (const evidenceArtifactIds of [["arch-art-1"], ["missing-art-1"], []]) {
      expect(
        repository.createFinding(engagement.id, {
          title: "Late finding",
          severity: "low",
          body: "",
          evidenceArtifactIds,
        }),
      ).toEqual({ ok: false, error: { code: "engagement_archived" } });
    }
    expect(
      repository.createFinding(UNKNOWN_ID, {
        title: "Finding",
        severity: "low",
        body: "",
        evidenceArtifactIds: ["missing-art-1"],
      }),
    ).toEqual({ ok: false, error: { code: "engagement_not_found" } });
  });
});

describe("scoped finding reads", () => {
  it("returns owned findings and stays readable when archived", () => {
    const { repository } = createFixture();
    const engagement = createEngagement(repository);
    const created = repository.createFinding(engagement.id, {
      title: "Scoped finding",
      severity: "medium",
      body: "Evidence shows the banner.",
    });
    if (!created.ok) throw new Error(`Create failed: ${created.error.code}`);
    expect(
      repository.getFindingForEngagement(engagement.id, created.value.id),
    ).toEqual({ ok: true, value: created.value });
    const archived = repository.archive(engagement.id, engagement.revision);
    if (!archived.ok) throw new Error(`Archive failed: ${archived.error.code}`);
    expect(
      repository.getFindingForEngagement(engagement.id, created.value.id),
    ).toEqual({ ok: true, value: created.value });
  });

  it("reports unknown and foreign findings identically", () => {
    const { repository } = createFixture();
    const first = createEngagement(repository);
    const second = createEngagement(repository);
    const created = repository.createFinding(first.id, {
      title: "Owned finding",
      severity: "low",
      body: "",
    });
    if (!created.ok) throw new Error(`Create failed: ${created.error.code}`);
    const expected = { ok: false, error: { code: "finding_not_found" } };
    expect(repository.getFindingForEngagement(first.id, UNKNOWN_ID)).toEqual(expected);
    expect(repository.getFindingForEngagement(second.id, created.value.id)).toEqual(expected);
    expect(repository.getFindingForEngagement(UNKNOWN_ID, created.value.id)).toEqual({
      ok: false,
      error: { code: "engagement_not_found" },
    });
  });
});

describe("finding content edits", () => {
  it("creates at revision 1 and applies an edit without touching evidence or status", () => {
    const { database, repository } = createFixture();
    const engagement = createEngagement(repository);
    seedRun(database, engagement.id, "edit-action-1", "edit-run-1");
    seedArtifact(database, "nmap-xml-1", "edit-run-1");
    const created = repository.createFinding(engagement.id, {
      title: "Default credentials",
      severity: "high",
      body: "# impact\nAdmin access.",
      evidenceArtifactIds: ["nmap-xml-1"],
    });
    if (!created.ok) throw new Error(`Create failed: ${created.error.code}`);
    expect(created.value.revision).toBe(1);

    const edited = repository.updateFinding(engagement.id, created.value.id, {
      title: "Corrected title",
      severity: "critical",
      body: "# impact\nConfirmed.",
      expectedRevision: 1,
    });
    if (!edited.ok) throw new Error(`Edit failed: ${edited.error.code}`);
    expect(edited.value).toMatchObject({
      title: "Corrected title",
      severity: "critical",
      body: "# impact\nConfirmed.",
      status: "open",
      evidenceArtifactIds: ["nmap-xml-1"],
      revision: 2,
    });

    const listed = repository.listFindings(engagement.id);
    if (!listed.ok) throw new Error(`List failed: ${listed.error.code}`);
    expect(listed.value).toEqual([edited.value]);
  });

  it("rejects a stale writer with the current revision", () => {
    const { repository } = createFixture();
    const engagement = createEngagement(repository);
    const created = repository.createFinding(engagement.id, {
      title: "Banner",
      severity: "low",
      body: "",
    });
    if (!created.ok) throw new Error(`Create failed: ${created.error.code}`);

    const first = repository.updateFinding(engagement.id, created.value.id, {
      title: "Banner v2",
      severity: "low",
      body: "",
      expectedRevision: 1,
    });
    if (!first.ok) throw new Error(`First edit failed: ${first.error.code}`);
    expect(first.value.revision).toBe(2);

    expect(
      repository.updateFinding(engagement.id, created.value.id, {
        title: "Stale overwrite",
        severity: "low",
        body: "",
        expectedRevision: 1,
      }),
    ).toEqual({ ok: false, error: { code: "revision_conflict", currentRevision: 2 } });

    const listed = repository.listFindings(engagement.id);
    if (!listed.ok) throw new Error(`List failed: ${listed.error.code}`);
    expect(listed.value[0]?.title).toBe("Banner v2");
  });

  it("keeps status transitions working and bumps their revision", () => {
    const { repository } = createFixture();
    const engagement = createEngagement(repository);
    const created = repository.createFinding(engagement.id, {
      title: "Banner",
      severity: "low",
      body: "",
    });
    if (!created.ok) throw new Error(`Create failed: ${created.error.code}`);

    const edited = repository.updateFinding(engagement.id, created.value.id, {
      title: "Banner v2",
      severity: "medium",
      body: "notes",
      expectedRevision: 1,
    });
    if (!edited.ok) throw new Error(`Edit failed: ${edited.error.code}`);

    const resolved = repository.resolveFinding(engagement.id, created.value.id);
    if (!resolved.ok) throw new Error(`Resolve failed: ${resolved.error.code}`);
    expect(resolved.value).toMatchObject({ status: "resolved", revision: 3 });

    expect(
      repository.updateFinding(engagement.id, created.value.id, {
        title: "Late edit",
        severity: "medium",
        body: "notes",
        expectedRevision: 2,
      }),
    ).toEqual({ ok: false, error: { code: "revision_conflict", currentRevision: 3 } });

    const reopened = repository.reopenFinding(engagement.id, created.value.id);
    if (!reopened.ok) throw new Error(`Reopen failed: ${reopened.error.code}`);
    expect(reopened.value).toMatchObject({ status: "open", revision: 4, title: "Banner v2" });
  });

  it("rejects edits for archived, unknown, foreign, and invalid input", () => {
    const { repository } = createFixture();
    const first = createEngagement(repository);
    const second = createEngagement(repository);
    const created = repository.createFinding(first.id, {
      title: "Owned finding",
      severity: "low",
      body: "",
    });
    if (!created.ok) throw new Error(`Create failed: ${created.error.code}`);
    const valid = {
      title: "Edited",
      severity: "low",
      body: "",
      expectedRevision: 1,
    } as const;

    expect(repository.updateFinding(first.id, UNKNOWN_ID, valid)).toEqual({
      ok: false,
      error: { code: "finding_not_found" },
    });
    expect(repository.updateFinding(second.id, created.value.id, valid)).toEqual({
      ok: false,
      error: { code: "finding_not_found" },
    });
    expect(repository.updateFinding(UNKNOWN_ID, created.value.id, valid)).toEqual({
      ok: false,
      error: { code: "engagement_not_found" },
    });
    expect(
      repository.updateFinding(first.id, created.value.id, { ...valid, title: "  padded  " }),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
    expect(
      repository.updateFinding(first.id, created.value.id, { ...valid, expectedRevision: undefined }),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });

    const archived = repository.archive(first.id, first.revision);
    if (!archived.ok) throw new Error(`Archive failed: ${archived.error.code}`);
    expect(repository.updateFinding(first.id, created.value.id, valid)).toEqual({
      ok: false,
      error: { code: "engagement_archived" },
    });
  });

  it("initializes pre-existing findings at revision 1 through migration", () => {
    const { database, repository } = createFixture();
    const info = database.sqlite
      .prepare("select dflt_value from pragma_table_info('findings') where name = 'revision'")
      .get() as { dflt_value: string | null };
    expect(info.dflt_value).toBe("1");
    const engagement = createEngagement(repository);
    const created = repository.createFinding(engagement.id, {
      title: "Migrated finding",
      severity: "info",
      body: "",
    });
    if (!created.ok) throw new Error(`Create failed: ${created.error.code}`);
    expect(created.value.revision).toBe(1);
  });
});
