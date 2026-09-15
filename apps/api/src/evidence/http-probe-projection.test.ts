import { createHash } from "node:crypto";
import { chmodSync, constants } from "node:fs";
import { chmod, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EngagementRepository, HttpProbeRepository, openEngagementDatabase } from "@stonehush/db";
import { loadEvidenceNative } from "@stonehush/evidence-native";
import { EvidenceStore } from "./evidence-store.js";
import { HttpProbeProjectionService } from "./http-probe-projection.js";

function rawFor(url: string): Buffer {
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

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "http-probe-proj-"));
  await chmod(dir, 0o700);
  const db = openEngagementDatabase({ dataDirectory: dir });
  const engRepo = new EngagementRepository(db.db);
  const repo = new HttpProbeRepository(db.db);
  const eng = engRepo.createEngagement({ name: "L", kind: "lab", autoContinueWarnings: false });
  if (!eng.ok) throw new Error("eng");
  const native = loadEvidenceNative();
  if (!native.ok) throw new Error("native");
  const storeRes = EvidenceStore.open(dir, native.binding);
  if (!storeRes.ok) throw new Error("store");
  return { dir, db, engRepo, repo, store: storeRes.store, engId: eng.value.id };
}

async function writeFile(dir: string, id: string, raw: Buffer) {
  const digest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  const p = path.join(dir, "evidence", "published", id);
  const fh = await open(p, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
  await fh.write(raw);
  await fh.sync();
  await fh.close();
  chmodSync(p, 0o600);
  return digest;
}

function addRun(db: ReturnType<typeof openEngagementDatabase>, engId: string, aId: string, rId: string) {
  const now = new Date().toISOString();
  db.sqlite.prepare(`insert into actions (id, contract_version, engagement_id, revision, state, queued_snapshot_version, warning_interactions, run_state, resume_requested, cleanup_required, capability_error_code, pending_warning_json, created_at, updated_at) values (?,1,?,1,'active',1,0,'running',0,0,null,null,?,?)`).run(aId, engId, now, now);
  db.sqlite.prepare(`insert into runs (id, contract_version, action_id, engagement_id, attempt, state, current_lease_id, current_fence, terminal_kind, terminal_reason, created_at, updated_at) values (?,1,?, ?,1,'running','lease-1','1',null,null,?,?)`).run(rId, aId, engId, now, now);
}

function addArtifact(db: ReturnType<typeof openEngagementDatabase>, aId: string, rId: string, raw: Buffer, digest: string, comp: string, slot = "http-probe-raw") {
  db.sqlite.prepare(`insert into evidence_artifacts (artifact_id, contract_version, profile, run_id, fence, event_sequence, artifact_slot, kind, size_bytes, digest, relative_path, completeness, redaction_applied, redaction_boundary, raw_bytes_preserved, created_at) values (?,1,'d3-v1',?,'1',1,?,'tool_raw',?,?,?, ?,0,'none',1,?)`).run(aId, rId, slot, raw.length, digest, `published/${aId}`, comp, new Date().toISOString());
}

describe("http probe projection", () => {
  it("projects valid raw, skips other slots and partial, rejects malformed", async () => {
    const f = await fixture();
    const proj = new HttpProbeProjectionService(f.store, f.repo);
    addRun(f.db, f.engId, "act-1", "run-1");
    const raw = rawFor("http://127.0.0.1:8080/");
    const d1 = await writeFile(f.dir, "00000000-0000-4000-8000-000000000031", raw);
    addArtifact(f.db, "00000000-0000-4000-8000-000000000031", "run-1", raw, d1, "complete");
    expect((await proj.projectForArtifact("00000000-0000-4000-8000-000000000031")).ok).toBe(true);
    expect((f.repo.listForEngagement(f.engId) as { ok: true; value: unknown[] }).value.length).toBe(1);

    addRun(f.db, f.engId, "act-2", "run-2");
    const bad = Buffer.from("{not json", "utf8");
    const d2 = await writeFile(f.dir, "00000000-0000-4000-8000-000000000032", bad);
    addArtifact(f.db, "00000000-0000-4000-8000-000000000032", "run-2", bad, d2, "complete");
    expect((await proj.projectForArtifact("00000000-0000-4000-8000-000000000032")).ok).toBe(false);

    addRun(f.db, f.engId, "act-3", "run-3");
    const d3 = await writeFile(f.dir, "00000000-0000-4000-8000-000000000033", raw);
    addArtifact(f.db, "00000000-0000-4000-8000-000000000033", "run-3", raw, d3, "partial");
    const r3 = await proj.projectForArtifact("00000000-0000-4000-8000-000000000033");
    expect(r3.ok).toBe(true);
    if (r3.ok) expect(r3.skipped).toBe(true);

    addRun(f.db, f.engId, "act-4", "run-4");
    const d4 = await writeFile(f.dir, "00000000-0000-4000-8000-000000000034", raw);
    addArtifact(f.db, "00000000-0000-4000-8000-000000000034", "run-4", raw, d4, "complete", "nmap-xml");
    const r4 = await proj.projectForArtifact("00000000-0000-4000-8000-000000000034");
    expect(r4.ok).toBe(true);
    if (r4.ok) expect(r4.skipped).toBe(true);

    f.db.close();
    await rm(f.dir, { recursive: true, force: true });
  });

  it("serves engagement-scoped probe results", async () => {
    const f = await fixture();
    const { buildApp } = await import("../app.js");
    addRun(f.db, f.engId, "act-5", "run-5");
    const raw = rawFor("http://127.0.0.1:8081/");
    const dig = await writeFile(f.dir, "00000000-0000-4000-8000-000000000035", raw);
    addArtifact(f.db, "00000000-0000-4000-8000-000000000035", "run-5", raw, dig, "complete");
    await new HttpProbeProjectionService(f.store, f.repo).projectForArtifact("00000000-0000-4000-8000-000000000035");
    const eng2 = f.engRepo.createEngagement({ name: "E2", kind: "lab", autoContinueWarnings: false });
    if (!eng2.ok) throw new Error("e2");
    const app = buildApp({ engagementRepository: f.engRepo, getDevelopmentStorageReadiness: () => "ready" as const, httpProbeRepository: f.repo });
    expect((await app.inject({ method: "GET", url: `/api/v1/engagements/${f.engId}/http-probes` })).json().length).toBe(1);
    expect((await app.inject({ method: "GET", url: `/api/v1/engagements/${eng2.value.id}/http-probes` })).json().length).toBe(0);
    expect((await app.inject({ method: "GET", url: `/api/v1/engagements/00000000-0000-4000-8000-000000009999/http-probes` })).statusCode).toBe(404);
    await app.close();
    f.db.close();
    await rm(f.dir, { recursive: true, force: true });
  });
});
