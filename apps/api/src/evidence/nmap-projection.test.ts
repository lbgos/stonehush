import { createHash } from "node:crypto";
import { chmodSync, constants } from "node:fs";
import { chmod, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NMAP_MAX_XML_BYTES } from "@stonehush/contracts";
import { EngagementRepository, NmapServiceRepository, openEngagementDatabase } from "@stonehush/db";
import { loadEvidenceNative } from "@stonehush/evidence-native";
import { EvidenceStore } from "./evidence-store.js";
import { NmapProjectionService } from "./nmap-projection.js";
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "nmap-proj-"));
  await chmod(dir, 0o700);
  const db = openEngagementDatabase({ dataDirectory: dir });
  const engRepo = new EngagementRepository(db.db);
  const repo = new NmapServiceRepository(db.db);
  const eng = engRepo.createEngagement({ name: "L", kind: "lab", autoContinueWarnings: false });
  if (!eng.ok) throw new Error("eng");
  const native = loadEvidenceNative();
  if (!native.ok) throw new Error("native");
  const storeRes = EvidenceStore.open(dir, native.binding);
  if (!storeRes.ok) throw new Error("store");
  return { dir, db, engRepo, repo, store: storeRes.store, engId: eng.value.id };
}
async function writeFile(dir: string, id: string, xml: Buffer) {
  const digest = `sha256:${createHash("sha256").update(xml).digest("hex")}`;
  const p = path.join(dir, "evidence", "published", id);
  const fh = await open(p, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
  await fh.write(xml);
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
function addArtifact(db: ReturnType<typeof openEngagementDatabase>, aId: string, rId: string, xml: Buffer, digest: string, comp: string) {
  db.sqlite.prepare(`insert into evidence_artifacts (artifact_id, contract_version, profile, run_id, fence, event_sequence, artifact_slot, kind, size_bytes, digest, relative_path, completeness, redaction_applied, redaction_boundary, raw_bytes_preserved, created_at) values (?,1,'d3-v1',?,'1',1,'nmap-xml','tool_raw',?,?,?, ?,0,'none',1,?)`).run(aId, rId, xml.length, digest, `published/${aId}`, comp, new Date().toISOString());
}
describe("nmap projection", () => {
  it("projects valid/empty, skips partial/truncated, rejects malformed and is idempotent", async () => {
    const f = await fixture();
    const proj = new NmapProjectionService(f.store, f.repo);
    addRun(f.db, f.engId, "act-1", "run-1");
    const xml = Buffer.from(`<?xml version="1.0"?><nmaprun><host><address addr="192.0.2.10" addrtype="ipv4"/><ports><port protocol="tcp" portid="80"><state state="open"/><service name="http"/></port></ports></host></nmaprun>`);
    const d1 = await writeFile(f.dir, "00000000-0000-4000-8000-000000000001", xml);
    addArtifact(f.db, "00000000-0000-4000-8000-000000000001", "run-1", xml, d1, "complete");
    expect((await proj.projectForArtifact("00000000-0000-4000-8000-000000000001")).ok).toBe(true);
    expect((f.repo.listForEngagement(f.engId) as { ok: true; value: unknown[] }).value.length).toBe(1);
    expect((await proj.projectForArtifact("00000000-0000-4000-8000-000000000001")).ok).toBe(true);
    addRun(f.db, f.engId, "act-2", "run-2");
    const empty = Buffer.from(`<?xml version="1.0"?><nmaprun></nmaprun>`);
    const d2 = await writeFile(f.dir, "00000000-0000-4000-8000-000000000002", empty);
    addArtifact(f.db, "00000000-0000-4000-8000-000000000002", "run-2", empty, d2, "complete");
    expect((await proj.projectForArtifact("00000000-0000-4000-8000-000000000002")).ok).toBe(true);
    addRun(f.db, f.engId, "act-3", "run-3");
    const bad = Buffer.from(`<?xml version="1.0"?><nmaprun><host><address addr="192.0.2.1" addrtype="ipv4"><port></nmaprun>`);
    const d3 = await writeFile(f.dir, "00000000-0000-4000-8000-000000000003", bad);
    addArtifact(f.db, "00000000-0000-4000-8000-000000000003", "run-3", bad, d3, "complete");
    expect((await proj.projectForArtifact("00000000-0000-4000-8000-000000000003")).ok).toBe(false);
    addRun(f.db, f.engId, "act-4", "run-4");
    const d4 = await writeFile(f.dir, "00000000-0000-4000-8000-000000000004", bad);
    addArtifact(f.db, "00000000-0000-4000-8000-000000000004", "run-4", bad, d4, "partial");
    const r4 = await proj.projectForArtifact("00000000-0000-4000-8000-000000000004");
    expect(r4.ok).toBe(true);
    if (r4.ok) expect(r4.skipped).toBe(true);
    addRun(f.db, f.engId, "act-5", "run-5");
    const d5 = await writeFile(f.dir, "00000000-0000-4000-8000-000000000005", bad);
    addArtifact(f.db, "00000000-0000-4000-8000-000000000005", "run-5", bad, d5, "truncated");
    const r5 = await proj.projectForArtifact("00000000-0000-4000-8000-000000000005");
    expect(r5.ok).toBe(true);
    if (r5.ok) expect(r5.skipped).toBe(true);
    f.db.close();
    await rm(f.dir, { recursive: true, force: true });
  });
  it("fails for oversize before download and for corrupted store", async () => {
    const f = await fixture();
    addRun(f.db, f.engId, "act-o", "run-o");
    const big = NMAP_MAX_XML_BYTES + 1;
    const dig = `sha256:${"a".repeat(64)}`;
    f.db.sqlite.prepare(`insert into evidence_artifacts (artifact_id, contract_version, profile, run_id, fence, event_sequence, artifact_slot, kind, size_bytes, digest, relative_path, completeness, redaction_applied, redaction_boundary, raw_bytes_preserved, created_at) values (?,1,'d3-v1',?,'1',1,'nmap-xml','tool_raw',?,?,?, 'complete',0,'none',1,?)`).run("00000000-0000-4000-8000-000000000010", "run-o", big, dig, `published/00000000-0000-4000-8000-000000000010`, new Date().toISOString());
    let called = false;
    const fake1 = {
      verifiedDownload: async () => {
        called = true;
        return {
          status: "ready" as const,
          sizeBytes: big,
          digest: dig,
          stream: (async function* () {})(),
        };
      },
    } as unknown as EvidenceStore;
    expect((await new NmapProjectionService(fake1, f.repo).projectForArtifact("00000000-0000-4000-8000-000000000010")).ok).toBe(false);
    expect(called).toBe(false);
    addRun(f.db, f.engId, "act-c", "run-c");
    const xml = Buffer.from(`<?xml version="1.0"?><nmaprun></nmaprun>`);
    const d = await writeFile(f.dir, "00000000-0000-4000-8000-000000000011", xml);
    addArtifact(f.db, "00000000-0000-4000-8000-000000000011", "run-c", xml, d, "complete");
    const fake2 = { verifiedDownload: async () => ({ status: "corrupt" as const, code: "digest_mismatch" }) } as unknown as EvidenceStore;
    expect((await new NmapProjectionService(fake2, f.repo).projectForArtifact("00000000-0000-4000-8000-000000000011")).ok).toBe(false);
    f.db.close();
    await rm(f.dir, { recursive: true, force: true });
  });
  it("is engagement scoped", async () => {
    const f = await fixture();
    const { buildApp } = await import("../app.js");
    addRun(f.db, f.engId, "act-http-1", "run-http-1");
    const xml = Buffer.from(`<?xml version="1.0"?><nmaprun><host><address addr="192.0.2.5" addrtype="ipv4"/><ports><port protocol="tcp" portid="8080"><state state="open"/><service name="http-proxy"/></port></ports></host></nmaprun>`);
    const dig = await writeFile(f.dir, "00000000-0000-4000-8000-000000000012", xml);
    addArtifact(f.db, "00000000-0000-4000-8000-000000000012", "run-http-1", xml, dig, "complete");
    await new NmapProjectionService(f.store, f.repo).projectForArtifact("00000000-0000-4000-8000-000000000012");
    const eng2 = f.engRepo.createEngagement({ name: "E2", kind: "lab", autoContinueWarnings: false });
    if (!eng2.ok) throw new Error("e2");
    const app = buildApp({ engagementRepository: f.engRepo, getDevelopmentStorageReadiness: () => "ready" as const, nmapServiceRepository: f.repo });
    expect((await app.inject({ method: "GET", url: `/api/v1/engagements/${f.engId}/services` })).json().length).toBe(1);
    expect((await app.inject({ method: "GET", url: `/api/v1/engagements/${eng2.value.id}/services` })).json().length).toBe(0);
    expect((await app.inject({ method: "GET", url: `/api/v1/engagements/00000000-0000-4000-8000-000000009999/services` })).statusCode).toBe(404);
    await app.close();
    f.db.close();
    await rm(f.dir, { recursive: true, force: true });
  });
});
