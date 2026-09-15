import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  EngagementRepository,
  FfufRepository,
  HttpProbeRepository,
  NmapServiceRepository,
  RunOutputRepository,
  openEngagementDatabase,
} from "@stonehush/db";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

const temporaryDirectories: string[] = [];
const openApps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createReportApp() {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "stonehush-report-route-test-"),
  );
  temporaryDirectories.push(dataDirectory);
  await chmod(dataDirectory, 0o700);
  const database = openEngagementDatabase({ dataDirectory });
  let nextId = 1;
  let minute = 0;
  const engagementRepository = new EngagementRepository(database.db, {
    createId: () =>
      `10000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
    now: () => new Date(Date.UTC(2026, 7, 12, 12, minute++)),
  });
  const app = buildApp({
    engagementRepository,
    getDevelopmentStorageReadiness: () => "ready",
    nmapServiceRepository: new NmapServiceRepository(database.db),
    httpProbeRepository: new HttpProbeRepository(database.db),
    ffufRepository: new FfufRepository(database.db),
    runOutputRepository: new RunOutputRepository(database.db),
    now: () => new Date(Date.UTC(2026, 7, 12, 13, 0)),
  });
  app.addHook("onClose", async () => database.close());
  openApps.push(app);
  return { app, engagementRepository, database };
}

function seedServiceRow(
  database: ReturnType<typeof openEngagementDatabase>,
  engagementId: string,
) {
  const now = new Date(Date.UTC(2026, 7, 12, 12, 30)).toISOString();
  database.sqlite
    .prepare(
      `insert into actions (id, contract_version, engagement_id, revision, state, queued_snapshot_version, warning_interactions, run_state, resume_requested, cleanup_required, capability_error_code, pending_warning_json, created_at, updated_at) values ('act-1',1,?,1,'active',1,0,'running',0,0,null,null,?,?)`,
    )
    .run(engagementId, now, now);
  database.sqlite
    .prepare(
      `insert into runs (id, contract_version, action_id, engagement_id, attempt, state, current_lease_id, current_fence, terminal_kind, terminal_reason, created_at, updated_at) values ('run-1',1,'act-1',?,1,'running','lease-1','1',null,null,?,?)`,
    )
    .run(engagementId, now, now);
  database.sqlite
    .prepare(
      `insert into evidence_artifacts (artifact_id, contract_version, profile, run_id, fence, event_sequence, artifact_slot, kind, size_bytes, digest, relative_path, completeness, redaction_applied, redaction_boundary, raw_bytes_preserved, created_at) values ('svc-artifact-1',1,'d3-v1','run-1','1',1,'nmap-xml','tool_raw',128,'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855','published/svc-artifact-1','complete',0,'none',1,?)`,
    )
    .run(now);
  database.sqlite
    .prepare(
      `insert into nmap_services (artifact_id, parser_version, address, port, protocol, hostname, service_name, product, version, observed_at) values ('svc-artifact-1','nmap-xml-v1','10.0.0.5',80,'tcp',null,'http','nginx','1.25',?)`,
    )
    .run(now);
}

async function createEngagementWithContent(
  engagementRepository: EngagementRepository,
) {
  const created = engagementRepository.createEngagement({
    name: "Report lab",
    kind: "lab",
    autoContinueWarnings: false,
    deadlineAt: "2026-08-20T12:00:00.000Z",
  });
  if (!created.ok) throw new Error(`Fixture failed: ${created.error.code}`);
  const engagementId = created.value.id;
  const noted = engagementRepository.putEngagementNotes(engagementId, {
    markdown: "# creds\nadmin:admin",
    expectedRevision: 0,
  });
  if (!noted.ok) throw new Error(`Fixture failed: ${noted.error.code}`);
  const found = engagementRepository.createFinding(engagementId, {
    title: "Default credentials on admin panel",
    severity: "high",
    body: "# impact\nAdmin access.",
    evidenceArtifactIds: [],
  });
  if (!found.ok) throw new Error(`Fixture failed: ${found.error.code}`);
  return { engagementId, revision: created.value.revision };
}

describe("report routes", () => {
  it("exports json with findings, notes, and services", async () => {
    const { app, engagementRepository, database } = await createReportApp();
    const { engagementId } = await createEngagementWithContent(engagementRepository);
    seedServiceRow(database, engagementId);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/report`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    const bundle = response.json() as {
      engagement: { name: string; deadlineAt: string };
      findings: { title: string }[];
      notesMarkdown: string;
      services: { total: number; truncated: boolean; rows: { address: string }[] };
      probes: { total: number };
      ffufResults: { total: number };
      evidenceArtifacts: { total: number; rows: { digest: string }[] };
    };
    expect(bundle.engagement.name).toBe("Report lab");
    expect(bundle.engagement.deadlineAt).toBe("2026-08-20T12:00:00.000Z");
    expect(bundle.findings.map((finding) => finding.title)).toEqual([
      "Default credentials on admin panel",
    ]);
    expect(bundle.notesMarkdown).toBe("# creds\nadmin:admin");
    expect(bundle.services.total).toBe(1);
    expect(bundle.services.truncated).toBe(false);
    expect(bundle.services.rows[0]?.address).toBe("10.0.0.5");
    expect(bundle.evidenceArtifacts.total).toBe(1);
    expect(bundle.evidenceArtifacts.rows[0]?.digest).toContain("sha256:");
  });

  it("exports markdown with finding title and notes text", async () => {
    const { app, engagementRepository, database } = await createReportApp();
    const { engagementId } = await createEngagementWithContent(engagementRepository);
    seedServiceRow(database, engagementId);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/report?format=markdown`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/markdown");
    expect(response.headers["content-disposition"]).toBe(
      `attachment; filename="engagement-${engagementId}-report.md"`,
    );
    expect(response.body).toContain("Default credentials on admin panel");
    expect(response.body).toContain("# creds\nadmin:admin");
    expect(response.body).toContain("10.0.0.5");
  });

  it("exports archived engagements and empty engagements", async () => {
    const { app, engagementRepository } = await createReportApp();
    const { engagementId, revision } = await createEngagementWithContent(
      engagementRepository,
    );
    const archived = engagementRepository.archive(engagementId, revision);
    if (!archived.ok) throw new Error(`Fixture failed: ${archived.error.code}`);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/report`,
    });
    expect(response.statusCode).toBe(200);
    const bundle = response.json() as {
      engagement: { status: string };
      findings: unknown[];
    };
    expect(bundle.engagement.status).toBe("archived");
    expect(bundle.findings).toHaveLength(1);

    const created = engagementRepository.createEngagement({
      name: "Empty lab",
      kind: "lab",
      autoContinueWarnings: false,
    });
    if (!created.ok) throw new Error(`Fixture failed: ${created.error.code}`);
    const empty = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${created.value.id}/report?format=markdown`,
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.body).toContain("_No findings recorded._");
  });

  it("rejects unknown engagements and invalid format", async () => {
    const { app } = await createReportApp();
    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/engagements/10000000-0000-4000-8000-000000009999/report",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ code: "engagement_not_found" });

    const malformed = await app.inject({
      method: "GET",
      url: "/api/v1/engagements/not-a-uuid/report",
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({ code: "invalid_request" });

    const badFormat = await app.inject({
      method: "GET",
      url: "/api/v1/engagements/10000000-0000-4000-8000-000000009999/report?format=pdf",
    });
    expect(badFormat.statusCode).toBe(400);
    expect(badFormat.json()).toEqual({ code: "invalid_request" });
  });
});
