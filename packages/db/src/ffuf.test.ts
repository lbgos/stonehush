import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openEngagementDatabase } from "./database.js";
import { FfufRepository } from "./ffuf.js";
import { EngagementRepository } from "./repository.js";
import { SettingsRepository } from "./settings.js";

const fixtures: { directory: string; database: ReturnType<typeof openEngagementDatabase> }[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.database.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

function fixture(autoContinueWarnings = false) {
  const directory = mkdtempSync(path.join(tmpdir(), "stonehush-ffuf-db-"));
  chmodSync(directory, 0o700);
  const database = openEngagementDatabase({ dataDirectory: directory });
  fixtures.push({ directory, database });
  const repository = new EngagementRepository(database.db);
  const created = repository.createEngagement({
    name: "Lab",
    kind: "lab",
    autoContinueWarnings,
  });
  if (!created.ok) throw new Error("engagement");
  return { database, repository, engagementId: created.value.id, revision: created.value.revision };
}

function launchInput(revision: number, overrides: Record<string, unknown> = {}) {
  return {
    expectedEngagementRevision: revision,
    expectedActiveScopeRevisionId: null,
    origin: "http://127.0.0.1:3130",
    wordlistPath: "/lists/smoke.txt",
    ...overrides,
  };
}

describe("planFfufDiscoveryAction", () => {
  it("pauses once for the T2 warning with the canonical origin", () => {
    const { repository, engagementId, revision } = fixture();
    const planned = repository.planFfufDiscoveryAction(engagementId, launchInput(revision));
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value.action.state).toBe("paused_for_warning");
    expect(planned.value.action.warningInteractions).toBe(1);
    expect(planned.value.action.pendingWarning?.reasonCodes).toEqual(["risk_tier_t2"]);
    const snapshot = planned.value.action.snapshots[0];
    expect(snapshot?.warningState.reasonCodes).toEqual(["risk_tier_t2"]);
    expect(snapshot?.typedOptions).toMatchObject({
      declaredPorts: null,
      ffuf: { wordlistPath: "/lists/smoke.txt", rate: 100, threads: 40 },
    });
    // The warned canonical URL is what executes, not the raw operator string.
    expect(snapshot?.canonicalTargets).toHaveLength(1);
    expect(snapshot?.typedOptions).toMatchObject({
      ffuf: { origin: "http://127.0.0.1:3130/" },
    });

    const continued = repository.continueAction({
      engagementId,
      actionId: planned.value.action.actionId,
      expectedRevision: planned.value.revision,
      snapshotVersion: 1,
      snapshotBinding: snapshot?.binding,
      occurredAt: new Date().toISOString(),
    });
    expect(continued.ok).toBe(true);
    if (!continued.ok) return;
    expect(continued.value.action.state).toBe("queued");
    expect(continued.value.action.warningAcknowledgment?.reasonCodes).toEqual(["risk_tier_t2"]);
  });

  it("stacks outside_scope with the tier and auto-continues when configured", () => {
    const scoped = fixture();
    const empty = scoped.repository.appendScopeRevision({
      engagementId: scoped.engagementId,
      expectedRevision: scoped.revision,
      rules: [],
    });
    if (!empty.ok) throw new Error("scope");
    const detail = scoped.repository.getEngagement(scoped.engagementId);
    if (!detail.ok) throw new Error("detail");
    const planned = scoped.repository.planFfufDiscoveryAction(scoped.engagementId, {
      ...launchInput(detail.value.engagement.revision),
      expectedActiveScopeRevisionId: empty.value.id,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value.action.pendingWarning?.reasonCodes).toEqual([
      "outside_scope",
      "risk_tier_t2",
    ]);

    const auto = fixture(true);
    const queued = auto.repository.planFfufDiscoveryAction(auto.engagementId, launchInput(auto.revision));
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(queued.value.action.state).toBe("queued");
    expect(queued.value.action.warningAcknowledgment).toMatchObject({
      source: "engagement_policy",
      reasonCodes: ["risk_tier_t2"],
    });
  });

  it("falls back to stored runner defaults under explicit values", () => {
    const { database, repository, engagementId, revision } = fixture();
    const settingsRepository = new SettingsRepository(database.db);
    expect(
      settingsRepository.updateRunnerSettings({
        ffufWordlistPath: "/lists/default.txt",
        ffufRate: 50,
        ffufThreads: 10,
        ffufTimeoutSeconds: 5,
        ffufMaxTimeSeconds: 60,
      }),
    ).toMatchObject({ ok: true });

    const minimal = {
      expectedEngagementRevision: revision,
      expectedActiveScopeRevisionId: null,
      origin: "http://127.0.0.1:3130",
    };
    const planned = repository.planFfufDiscoveryAction(engagementId, minimal);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value.action.snapshots[0]?.typedOptions).toMatchObject({
      ffuf: {
        wordlistPath: "/lists/default.txt",
        rate: 50,
        threads: 10,
        timeoutSeconds: 5,
        maxTimeSeconds: 60,
      },
    });

    const explicit = repository.planFfufDiscoveryAction(engagementId, {
      ...minimal,
      wordlistPath: "/lists/explicit.txt",
      rate: 200,
    });
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) return;
    expect(explicit.value.action.snapshots[0]?.typedOptions).toMatchObject({
      ffuf: { wordlistPath: "/lists/explicit.txt", rate: 200, threads: 10 },
    });

    const emptyWordlist = repository.planFfufDiscoveryAction(engagementId, {
      ...minimal,
      wordlistPath: "",
    });
    expect(emptyWordlist.ok).toBe(true);
    if (!emptyWordlist.ok) return;
    expect(emptyWordlist.value.action.snapshots[0]?.typedOptions).toMatchObject({
      ffuf: { wordlistPath: "/lists/default.txt" },
    });
  });

  it("rejects a launch with no wordlist anywhere", () => {
    const { repository, engagementId, revision } = fixture();
    expect(
      repository.planFfufDiscoveryAction(engagementId, {
        expectedEngagementRevision: revision,
        expectedActiveScopeRevisionId: null,
        origin: "http://127.0.0.1:3130",
      }),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
  });

  it("rejects invalid contracts and archived engagements", () => {
    const { database, repository, engagementId, revision } = fixture();
    expect(
      repository.planFfufDiscoveryAction(engagementId, launchInput(revision, { origin: "ftp://x/" })),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
    expect(
      repository.planFfufDiscoveryAction(engagementId, launchInput(revision, { wordlistPath: "../etc/words" })),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
    expect(
      repository.planFfufDiscoveryAction(engagementId, launchInput(revision, { origin: "192.0.2.10" })),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });

    const archived = repository.archive(engagementId, revision);
    if (!archived.ok) throw new Error("archive");
    expect(
      repository.planFfufDiscoveryAction(engagementId, launchInput(archived.value.revision)),
    ).toEqual({ ok: false, error: { code: "engagement_archived" } });
    void database;
  });
});

function addRun(
  database: ReturnType<typeof openEngagementDatabase>,
  engagementId: string,
  actionId: string,
  runId: string,
) {
  const now = new Date().toISOString();
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

function addArtifact(
  database: ReturnType<typeof openEngagementDatabase>,
  artifactId: string,
  runId: string,
  raw: Buffer,
  digest: string,
) {
  database.sqlite
    .prepare(
      `insert into evidence_artifacts (artifact_id, contract_version, profile, run_id, fence, event_sequence, artifact_slot, kind, size_bytes, digest, relative_path, completeness, redaction_applied, redaction_boundary, raw_bytes_preserved, created_at) values (?,1,'d3-v1',?,'1',1,'ffuf-json','tool_raw',?,?,?, 'complete',0,'none',1,?)`,
    )
    .run(artifactId, runId, raw.length, digest, `published/${artifactId}`, new Date().toISOString());
}

describe("FfufRepository", () => {
  it("projects raw ffuf JSON and lists results per engagement", () => {
    const { database, engagementId } = fixture();
    const repo = new FfufRepository(database.db);
    addRun(database, engagementId, "act-1", "run-1");
    const raw = Buffer.from(
      JSON.stringify({
        results: [
          {
            input: { FUZZ: "planted.txt" },
            position: 1,
            status: 200,
            length: 10,
            words: 1,
            lines: 2,
            redirectlocation: "",
            url: "http://127.0.0.1:3130/planted.txt",
          },
        ],
      }),
      "utf8",
    );
    const artifactId = "00000000-0000-4000-8000-000000000031";
    addArtifact(
      database,
      artifactId,
      "run-1",
      raw,
      "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    );
    expect(
      repo.project({ artifactId, observedAt: "2026-09-03T00:00:00.000Z", jsonBytes: raw }),
    ).toEqual({ ok: true });
    expect(
      repo.project({ artifactId, observedAt: "2026-09-03T00:00:00.000Z", jsonBytes: raw }),
    ).toEqual({ ok: true });

    const listed = repo.listForEngagement(engagementId);
    if (!listed.ok) throw new Error("list");
    expect(listed.value).toHaveLength(1);
    expect(listed.value[0]).toMatchObject({
      source: "ffuf",
      parserVersion: "ffuf-json-v1",
      url: "http://127.0.0.1:3130/planted.txt",
      status: 200,
      length: 10,
      words: 1,
      lines: 2,
      redirectlocation: null,
      fuzz: "planted.txt",
      runId: "run-1",
      artifactId,
    });
  });

  it("rejects malformed JSON and unknown engagements", () => {
    const { database } = fixture();
    const repo = new FfufRepository(database.db);
    expect(
      repo.project({
        artifactId: "00000000-0000-4000-8000-000000000032",
        observedAt: "2026-09-03T00:00:00.000Z",
        jsonBytes: Buffer.from("{not json", "utf8"),
      }),
    ).toEqual({ ok: false, code: "invalid_persisted_data" });
    expect(repo.listForEngagement("00000000-0000-4000-8000-000000009999")).toEqual({
      ok: false,
      code: "engagement_not_found",
    });
  });
});
