import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openEngagementDatabase } from "./database.js";
import { EngagementRepository } from "./repository.js";
import { SettingsRepository } from "./settings.js";
import { VhostRepository } from "./vhost.js";

const fixtures: { directory: string; database: ReturnType<typeof openEngagementDatabase> }[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.database.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

function fixture(autoContinueWarnings = false) {
  const directory = mkdtempSync(path.join(tmpdir(), "stonehush-vhost-db-"));
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
    address: "192.0.2.10",
    wordlistPath: "/lists/hosts.txt",
    ...overrides,
  };
}

describe("planVhostDiscoveryAction", () => {
  it("queues directly as T1 with the canonical IP and declared port", () => {
    const { repository, engagementId, revision } = fixture();
    const planned = repository.planVhostDiscoveryAction(engagementId, launchInput(revision));
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value.action.state).toBe("queued");
    expect(planned.value.action.warningInteractions).toBe(0);
    expect(planned.value.action.pendingWarning).toBe(null);
    const snapshot = planned.value.action.snapshots[0];
    expect(snapshot?.warningState.reasonCodes).toEqual([]);
    expect(snapshot?.canonicalTargets).toHaveLength(1);
    expect(snapshot?.canonicalTargets[0]).toMatchObject({ kind: "ip", address: "192.0.2.10" });
    expect(snapshot?.typedOptions).toMatchObject({
      declaredPorts: [80],
      ffufVhost: { address: "192.0.2.10", port: 80, tls: false, wordlistPath: "/lists/hosts.txt" },
    });
  });

  it("warns once for outside_scope and keeps Continue available", () => {
    const scoped = fixture();
    const empty = scoped.repository.appendScopeRevision({
      engagementId: scoped.engagementId,
      expectedRevision: scoped.revision,
      rules: [],
    });
    if (!empty.ok) throw new Error("scope");
    const detail = scoped.repository.getEngagement(scoped.engagementId);
    if (!detail.ok) throw new Error("detail");
    const planned = scoped.repository.planVhostDiscoveryAction(scoped.engagementId, {
      ...launchInput(detail.value.engagement.revision),
      expectedActiveScopeRevisionId: empty.value.id,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value.action.state).toBe("paused_for_warning");
    expect(planned.value.action.pendingWarning?.reasonCodes).toEqual(["outside_scope"]);
    expect(planned.value.action.pendingWarning?.reasonCodes).not.toContain("risk_tier_t2");

    const continued = scoped.repository.continueAction({
      engagementId: scoped.engagementId,
      actionId: planned.value.action.actionId,
      expectedRevision: planned.value.revision,
      snapshotVersion: 1,
      snapshotBinding: planned.value.action.snapshots[0]?.binding,
      occurredAt: new Date().toISOString(),
    });
    expect(continued.ok).toBe(true);
    if (!continued.ok) return;
    expect(continued.value.action.state).toBe("queued");
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
      address: "192.0.2.10",
    };
    const planned = repository.planVhostDiscoveryAction(engagementId, minimal);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value.action.snapshots[0]?.typedOptions).toMatchObject({
      ffufVhost: { wordlistPath: "/lists/default.txt", rate: 50, threads: 10 },
    });
  });

  it("rejects hostnames, URLs, CIDRs, and missing wordlists", () => {
    const { repository, engagementId, revision } = fixture();
    expect(
      repository.planVhostDiscoveryAction(engagementId, launchInput(revision, { address: "example.com" })),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
    expect(
      repository.planVhostDiscoveryAction(engagementId, launchInput(revision, { address: "http://192.0.2.10/" })),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
    expect(
      repository.planVhostDiscoveryAction(engagementId, launchInput(revision, { address: "192.0.2.0/24" })),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
    expect(
      repository.planVhostDiscoveryAction(engagementId, {
        expectedEngagementRevision: revision,
        expectedActiveScopeRevisionId: null,
        address: "192.0.2.10",
      }),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
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
      `insert into evidence_artifacts (artifact_id, contract_version, profile, run_id, fence, event_sequence, artifact_slot, kind, size_bytes, digest, relative_path, completeness, redaction_applied, redaction_boundary, raw_bytes_preserved, created_at) values (?,1,'d3-v1',?,'1',1,'vhost-json','tool_raw',?,?,?, 'complete',0,'none',1,?)`,
    )
    .run(artifactId, runId, raw.length, digest, `published/${artifactId}`, new Date().toISOString());
}

describe("VhostRepository", () => {
  it("projects raw ffuf JSON to hostname candidates and lists them per engagement", () => {
    const { database, engagementId } = fixture();
    const repo = new VhostRepository(database.db);
    addRun(database, engagementId, "act-1", "run-1");
    const raw = Buffer.from(
      JSON.stringify({
        results: [
          {
            input: { FUZZ: "admin.internal" },
            position: 1,
            status: 200,
            length: 1024,
            words: 40,
            lines: 12,
            url: "http://192.0.2.10:80/",
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
      source: "ffuf-vhost",
      parserVersion: "ffuf-vhost-v1",
      hostname: "admin.internal",
      baseUrl: "http://192.0.2.10:80/",
      status: 200,
      runId: "run-1",
      artifactId,
    });
  });

  it("rejects malformed JSON and unknown engagements", () => {
    const { database } = fixture();
    const repo = new VhostRepository(database.db);
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
