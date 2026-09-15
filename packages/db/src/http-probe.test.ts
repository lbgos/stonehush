import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openEngagementDatabase } from "./database.js";
import { HttpProbeRepository } from "./http-probe.js";
import { EngagementRepository } from "./repository.js";

const fixtures: { directory: string; database: ReturnType<typeof openEngagementDatabase> }[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.database.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "stonehush-http-probe-db-"));
  chmodSync(directory, 0o700);
  const database = openEngagementDatabase({ dataDirectory: directory });
  fixtures.push({ directory, database });
  return database;
}

function rawBytes(url: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      parserVersion: "http-probe-raw-v1",
      url,
      fetchedAt: "2026-09-03T00:00:00.000Z",
      finalUrl: url,
      status: 200,
      title: "Lab",
      selectedHeaders: { contentType: "text/html", server: null, poweredBy: null },
      hops: [{ url, status: 200, location: null }],
      error: null,
    }),
    "utf8",
  );
}

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
      `insert into evidence_artifacts (artifact_id, contract_version, profile, run_id, fence, event_sequence, artifact_slot, kind, size_bytes, digest, relative_path, completeness, redaction_applied, redaction_boundary, raw_bytes_preserved, created_at) values (?,1,'d3-v1',?,'1',1,'http-probe-raw','tool_raw',?,?,?, 'complete',0,'none',1,?)`,
    )
    .run(artifactId, runId, raw.length, digest, `published/${artifactId}`, new Date().toISOString());
}

describe("HttpProbeRepository", () => {
  it("projects raw evidence and lists it per engagement", () => {
    const database = fixture();
    const engagements = new EngagementRepository(database.db);
    const created = engagements.createEngagement({ name: "Lab", kind: "lab", autoContinueWarnings: false });
    if (!created.ok) throw new Error("engagement");
    const engagementId = created.value.id;
    const repo = new HttpProbeRepository(database.db);

    addRun(database, engagementId, "act-1", "run-1");
    const raw = rawBytes("http://127.0.0.1:8080/");
    const digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    addArtifact(database, "00000000-0000-4000-8000-000000000021", "run-1", raw, digest);

    expect(
      repo.project({
        artifactId: "00000000-0000-4000-8000-000000000021",
        observedAt: "2026-09-03T00:00:00.000Z",
        rawBytes: raw,
      }),
    ).toEqual({ ok: true });
    // Idempotent re-projection.
    expect(
      repo.project({
        artifactId: "00000000-0000-4000-8000-000000000021",
        observedAt: "2026-09-03T00:00:00.000Z",
        rawBytes: raw,
      }),
    ).toEqual({ ok: true });

    const listed = repo.listForEngagement(engagementId);
    if (!listed.ok) throw new Error("list");
    expect(listed.value.length).toBe(1);
    expect(listed.value[0]).toMatchObject({
      source: "http-probe",
      url: "http://127.0.0.1:8080/",
      status: 200,
      title: "Lab",
    });
  });

  it("rejects malformed raw evidence", () => {
    const database = fixture();
    const repo = new HttpProbeRepository(database.db);
    expect(
      repo.project({
        artifactId: "00000000-0000-4000-8000-000000000022",
        observedAt: "2026-09-03T00:00:00.000Z",
        rawBytes: Buffer.from("{not json", "utf8"),
      }),
    ).toEqual({ ok: false, code: "invalid_persisted_data" });
  });

  it("returns engagement_not_found for unknown engagements", () => {
    const database = fixture();
    const repo = new HttpProbeRepository(database.db);
    expect(repo.listForEngagement("00000000-0000-4000-8000-000000009999")).toEqual({
      ok: false,
      code: "engagement_not_found",
    });
  });
});
