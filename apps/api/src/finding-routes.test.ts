import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { EngagementRepository, openEngagementDatabase } from "@stonehush/db";
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

async function createRepositoryBackedApp() {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "stonehush-findings-route-test-"),
  );
  temporaryDirectories.push(dataDirectory);
  await chmod(dataDirectory, 0o700);
  const database = openEngagementDatabase({ dataDirectory });
  let nextId = 1;
  let minute = 0;
  const repository = new EngagementRepository(database.db, {
    createId: () =>
      `10000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
    now: () => new Date(Date.UTC(2026, 7, 12, 12, minute++)),
  });
  const app = buildApp({
    engagementRepository: repository,
    getDevelopmentStorageReadiness: () => "ready",
  });
  app.addHook("onClose", async () => database.close());
  openApps.push(app);
  return { app, repository, database };
}

const ROUTE_ARTIFACT_DIGEST =
  "sha256:0000000000000000000000000000000000000000000000000000000000000000";

function seedRouteRun(
  database: ReturnType<typeof openEngagementDatabase>,
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

function seedRouteArtifact(
  database: ReturnType<typeof openEngagementDatabase>,
  artifactId: string,
  runId: string,
  eventSequence = 1,
) {
  database.sqlite
    .prepare(
      `insert into evidence_artifacts (artifact_id, contract_version, profile, run_id, fence, event_sequence, artifact_slot, kind, size_bytes, digest, relative_path, completeness, redaction_applied, redaction_boundary, raw_bytes_preserved, created_at) values (?,1,'d3-v1',?,'1',?,'finding-evidence','tool_raw',?,?,?, 'complete',0,'none',1,?)`,
    )
    .run(
      artifactId,
      runId,
      eventSequence,
      10,
      ROUTE_ARTIFACT_DIGEST,
      `published/${artifactId}`,
      new Date(Date.UTC(2026, 7, 12, 12, 0)).toISOString(),
    );
}

describe("findings routes", () => {
  it("creates, lists, resolves, and reopens a finding", async () => {
    const { app, repository, database } = await createRepositoryBackedApp();
    const createdEngagement = repository.createEngagement({
      name: "Findings lab",
      kind: "lab",
      autoContinueWarnings: false,
    });
    if (!createdEngagement.ok) throw new Error(`Fixture failed: ${createdEngagement.error.code}`);
    const engagementId = createdEngagement.value.id;
    seedRouteRun(database, engagementId, "route-action-1", "route-run-1");
    seedRouteArtifact(database, "nmap-xml-1", "route-run-1");

    const empty = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/findings`,
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual([]);

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${engagementId}/findings`,
      payload: {
        title: "Default credentials",
        severity: "high",
        body: "# impact\nAdmin access.",
        evidenceArtifactIds: ["nmap-xml-1"],
      },
    });
    expect(created.statusCode).toBe(201);
    const finding = created.json() as { id: string; status: string };
    expect(finding.status).toBe("open");

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/findings`,
    });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as unknown[])).toHaveLength(1);

    const resolved = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${engagementId}/findings/${finding.id}/resolve`,
    });
    expect(resolved.statusCode).toBe(200);
    expect((resolved.json() as { status: string }).status).toBe("resolved");

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/engagements/${engagementId}/findings/${finding.id}/resolve`,
        })
      ).statusCode,
    ).toBe(409);

    const reopened = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${engagementId}/findings/${finding.id}/reopen`,
    });
    expect(reopened.statusCode).toBe(200);
    expect((reopened.json() as { status: string }).status).toBe("open");
  });

  it("rejects invalid input, unknown ids, and archived writes", async () => {
    const { app, repository } = await createRepositoryBackedApp();
    const createdEngagement = repository.createEngagement({
      name: "Findings lab",
      kind: "lab",
      autoContinueWarnings: false,
    });
    if (!createdEngagement.ok) throw new Error(`Fixture failed: ${createdEngagement.error.code}`);
    const engagementId = createdEngagement.value.id;

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/engagements/${engagementId}/findings`,
          payload: { title: "", severity: "low", body: "" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/engagements/not-an-id/findings",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/engagements/10000000-0000-4000-8000-000000000099/findings",
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/engagements/${engagementId}/findings/10000000-0000-4000-8000-000000000099/resolve`,
        })
      ).statusCode,
    ).toBe(404);

    const archived = repository.archive(engagementId, createdEngagement.value.revision);
    if (!archived.ok) throw new Error(`Fixture failed: ${archived.error.code}`);

    const write = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${engagementId}/findings`,
      payload: { title: "Late finding", severity: "low", body: "" },
    });
    expect(write.statusCode).toBe(409);
    expect(write.json()).toEqual({ code: "engagement_archived" });
  });

  it("rejects foreign and missing evidence without leaking details", async () => {
    const { app, repository, database } = await createRepositoryBackedApp();
    const first = repository.createEngagement({
      name: "Findings lab",
      kind: "lab",
      autoContinueWarnings: false,
    });
    if (!first.ok) throw new Error(`Fixture failed: ${first.error.code}`);
    const second = repository.createEngagement({
      name: "Other lab",
      kind: "lab",
      autoContinueWarnings: false,
    });
    if (!second.ok) throw new Error(`Fixture failed: ${second.error.code}`);

    seedRouteRun(database, first.value.id, "owned-api-action-1", "owned-api-run-1");
    seedRouteArtifact(database, "owned-api-art-1", "owned-api-run-1", 1);
    seedRouteRun(database, second.value.id, "foreign-api-action-1", "foreign-api-run-1");
    seedRouteArtifact(database, "foreign-api-art-1", "foreign-api-run-1", 1);

    const valid = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${first.value.id}/findings`,
      payload: {
        title: "Owned evidence",
        severity: "low",
        body: "",
        evidenceArtifactIds: ["owned-api-art-1"],
      },
    });
    expect(valid.statusCode).toBe(201);

    for (const evidenceArtifactIds of [
      ["missing-api-art-1"],
      ["foreign-api-art-1"],
      ["owned-api-art-1", "foreign-api-art-1"],
      ["owned-api-art-1", "missing-api-art-1"],
    ]) {
      const rejected = await app.inject({
        method: "POST",
        url: `/api/v1/engagements/${first.value.id}/findings`,
        payload: { title: "Bad evidence", severity: "low", body: "", evidenceArtifactIds },
      });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json()).toEqual({ code: "invalid_request" });
      expect(rejected.body).not.toContain("foreign-api-art-1");
      expect(rejected.body).not.toContain("published/");
    }

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${first.value.id}/findings`,
    });
    expect((listed.json() as unknown[])).toHaveLength(1);

    const archived = repository.archive(first.value.id, first.value.revision);
    if (!archived.ok) throw new Error(`Fixture failed: ${archived.error.code}`);
    const late = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${first.value.id}/findings`,
      payload: {
        title: "Late evidence",
        severity: "low",
        body: "",
        evidenceArtifactIds: ["foreign-api-art-1"],
      },
    });
    expect(late.statusCode).toBe(409);
    expect(late.json()).toEqual({ code: "engagement_archived" });
  });

  it("edits content with a revision precondition and rejects stale writers", async () => {
    const { app, repository, database } = await createRepositoryBackedApp();
    const createdEngagement = repository.createEngagement({
      name: "Findings lab",
      kind: "lab",
      autoContinueWarnings: false,
    });
    if (!createdEngagement.ok) throw new Error(`Fixture failed: ${createdEngagement.error.code}`);
    const engagementId = createdEngagement.value.id;
    seedRouteRun(database, engagementId, "edit-api-action-1", "edit-api-run-1");
    seedRouteArtifact(database, "nmap-xml-1", "edit-api-run-1");

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${engagementId}/findings`,
      payload: {
        title: "Default credentials",
        severity: "high",
        body: "# impact\nAdmin access.",
        evidenceArtifactIds: ["nmap-xml-1"],
      },
    });
    expect(created.statusCode).toBe(201);
    const finding = created.json() as { id: string; revision: number };

    const edited = await app.inject({
      method: "PUT",
      url: `/api/v1/engagements/${engagementId}/findings/${finding.id}`,
      payload: {
        title: "Corrected title",
        severity: "critical",
        body: "# impact\nConfirmed.",
        expectedRevision: finding.revision,
      },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({
      title: "Corrected title",
      severity: "critical",
      body: "# impact\nConfirmed.",
      status: "open",
      evidenceArtifactIds: ["nmap-xml-1"],
      revision: finding.revision + 1,
    });

    const stale = await app.inject({
      method: "PUT",
      url: `/api/v1/engagements/${engagementId}/findings/${finding.id}`,
      payload: {
        title: "Stale overwrite",
        severity: "low",
        body: "",
        expectedRevision: finding.revision,
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({
      code: "revision_conflict",
      resourceType: "finding",
      resourceId: finding.id,
      currentRevision: finding.revision + 1,
    });

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/findings`,
    });
    expect((listed.json() as { title: string }[]).map((entry) => entry.title)).toEqual([
      "Corrected title",
    ]);
  });

  it("rejects finding edits for bad input, unknown ids, and archived engagements", async () => {
    const { app, repository } = await createRepositoryBackedApp();
    const createdEngagement = repository.createEngagement({
      name: "Findings lab",
      kind: "lab",
      autoContinueWarnings: false,
    });
    if (!createdEngagement.ok) throw new Error(`Fixture failed: ${createdEngagement.error.code}`);
    const engagementId = createdEngagement.value.id;
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${engagementId}/findings`,
      payload: { title: "Banner", severity: "low", body: "" },
    });
    const finding = created.json() as { id: string; revision: number };
    const editUrl = `/api/v1/engagements/${engagementId}/findings/${finding.id}`;
    const valid = {
      title: "Edited",
      severity: "low",
      body: "",
      expectedRevision: finding.revision,
    };

    expect((await app.inject({ method: "PUT", url: editUrl, payload: { ...valid, title: "" } })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: "PUT", url: editUrl, payload: { ...valid, expectedRevision: undefined } }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/v1/engagements/${engagementId}/findings/10000000-0000-4000-8000-000000000099`,
          payload: valid,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/engagements/not-an-id/findings/10000000-0000-4000-8000-000000000001",
          payload: valid,
        })
      ).statusCode,
    ).toBe(400);

    const archived = repository.archive(engagementId, createdEngagement.value.revision);
    if (!archived.ok) throw new Error(`Fixture failed: ${archived.error.code}`);
    const late = await app.inject({ method: "PUT", url: editUrl, payload: valid });
    expect(late.statusCode).toBe(409);
    expect(late.json()).toEqual({ code: "engagement_archived" });
  });
});
