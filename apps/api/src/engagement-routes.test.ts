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
    path.join(tmpdir(), "stonehush-engagement-route-test-"),
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
  return { app, database, repository };
}

function createEngagement(repository: EngagementRepository, name: string) {
  const result = repository.createEngagement({
    name,
    kind: "lab",
    autoContinueWarnings: false,
  });
  if (!result.ok) throw new Error(`Fixture failed: ${result.error.code}`);
  return result.value;
}

describe("engagement query routes", () => {
  it("returns a bare ordered engagement list including archived records", async () => {
    const { app, repository } = await createRepositoryBackedApp();
    const first = createEngagement(repository, "First lab");
    const second = createEngagement(repository, "Second lab");
    const archived = repository.archive(second.id, second.revision);
    if (!archived.ok) throw new Error(`Fixture failed: ${archived.error.code}`);

    const response = await app.inject({ method: "GET", url: "/api/v1/engagements" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^application\/json/);
    expect(response.json()).toEqual([first, archived.value]);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/engagements/${archived.value.id}`,
        })
      ).json(),
    ).toEqual({ engagement: archived.value, activeScopeRevision: null });
  });

  it("returns detail with no scope and with an active empty scope", async () => {
    const { app, repository } = await createRepositoryBackedApp();
    const engagement = createEngagement(repository, "Target lab");
    const path = `/api/v1/engagements/${engagement.id}`;

    expect((await app.inject({ method: "GET", url: path })).json()).toEqual({
      engagement,
      activeScopeRevision: null,
    });
    const scope = repository.appendScopeRevision({
      engagementId: engagement.id,
      expectedRevision: 1,
      rules: [],
    });
    if (!scope.ok) throw new Error(`Fixture failed: ${scope.error.code}`);

    const response = await app.inject({ method: "GET", url: path });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      engagement: { revision: 2, activeScopeRevisionId: scope.value.id },
      activeScopeRevision: scope.value,
    });
  });

  it("returns immutable scope history in ascending version order", async () => {
    const { app, repository } = await createRepositoryBackedApp();
    const engagement = createEngagement(repository, "Target lab");
    const first = repository.appendScopeRevision({
      engagementId: engagement.id,
      expectedRevision: 1,
      rules: [],
    });
    const second = repository.appendScopeRevision({
      engagementId: engagement.id,
      expectedRevision: 2,
      rules: [],
    });
    if (!first.ok || !second.ok) throw new Error("Fixture scope append failed.");

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagement.id}/scope-revisions`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([first.value, second.value]);
  });

  it("maps invalid IDs, unknown engagements, and unsupported methods exactly", async () => {
    const { app } = await createRepositoryBackedApp();
    expect(
      await app.inject({ method: "GET", url: "/api/v1/engagements/not-an-id" }),
    ).toMatchObject({ statusCode: 400, body: '{"code":"invalid_request"}' });
    expect(
      await app.inject({
        method: "GET",
        url: "/api/v1/engagements/not-an-id/scope-revisions",
      }),
    ).toMatchObject({ statusCode: 400, body: '{"code":"invalid_request"}' });
    expect(
      await app.inject({
        method: "GET",
        url: "/api/v1/engagements/10000000-0000-4000-8000-000000000099",
      }),
    ).toMatchObject({
      statusCode: 404,
      body: '{"code":"engagement_not_found"}',
    });
    expect(
      await app.inject({
        method: "GET",
        url: "/api/v1/engagements/10000000-0000-4000-8000-000000000099/scope-revisions",
      }),
    ).toMatchObject({
      statusCode: 404,
      body: '{"code":"engagement_not_found"}',
    });
    expect(
      await app.inject({ method: "POST", url: "/api/v1/engagements" }),
    ).toMatchObject({ statusCode: 404 });
  });

  it.each([
    ["storage_busy", 503],
    ["invalid_persisted_data", 500],
  ] as const)("maps %s without reflecting repository details", async (code, status) => {
    const app = buildApp({
      engagementRepository: {
        getEngagement: () => ({ ok: false, error: { code } }),
        getFindingForEngagement: () => ({ ok: false, error: { code: "finding_not_found" } }),
        listEngagements: () => ({ ok: false, error: { code } }),
        listScopeRevisions: () => ({ ok: false, error: { code } }),
        getAction: () => ({ ok: false, error: { code: "action_not_found" as const } }),
        retryActionContext: () => ({
          ok: false,
          error: { code: "action_not_found" as const },
        }),
        getEngagementNotes: () => ({ ok: false, error: { code } }),
        putEngagementNotes: () => ({ ok: false, error: { code } }),
      },
      getDevelopmentStorageReadiness: () => "ready",
    });
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/v1/engagements" });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ code });
    expect(response.body).not.toContain("path");
    expect(response.body).not.toContain("error");
  });

  it("fails closed when persisted scope linkage is corrupt", async () => {
    const { app, database, repository } = await createRepositoryBackedApp();
    const engagement = createEngagement(repository, "Target lab");
    database.sqlite.pragma("foreign_keys = OFF");
    database.sqlite
      .prepare(
        "insert into engagement_active_scopes (engagement_id, scope_revision_id) values (?, ?)",
      )
      .run(engagement.id, "10000000-0000-4000-8000-000000000099");
    database.sqlite.pragma("foreign_keys = ON");

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagement.id}`,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ code: "invalid_persisted_data" });
  });

  it("fails the list when an active scope belongs to another engagement", async () => {
    const { app, database, repository } = await createRepositoryBackedApp();
    const first = createEngagement(repository, "First lab");
    const second = createEngagement(repository, "Second lab");
    const scope = repository.appendScopeRevision({
      engagementId: second.id,
      expectedRevision: second.revision,
      rules: [],
    });
    if (!scope.ok) throw new Error(`Fixture failed: ${scope.error.code}`);
    database.sqlite.pragma("foreign_keys = OFF");
    database.sqlite
      .prepare(
        "insert into engagement_active_scopes (engagement_id, scope_revision_id) values (?, ?)",
      )
      .run(first.id, scope.value.id);
    database.sqlite.pragma("foreign_keys = ON");

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/engagements",
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ code: "invalid_persisted_data" });
  });

  it("does not reflect malformed repository output through response validation", async () => {
    const marker = "SENSITIVE_PERSISTED_MARKER";
    const app = buildApp({
      engagementRepository: {
        getEngagement: () => ({ ok: true, value: { marker } as never }),
        getFindingForEngagement: () => ({ ok: false, error: { code: "finding_not_found" } }),
        listEngagements: () => ({ ok: true, value: [{ marker }] as never }),
        listScopeRevisions: () => ({ ok: true, value: [{ marker }] as never }),
        getAction: () => ({ ok: false, error: { code: "action_not_found" as const } }),
        retryActionContext: () => ({
          ok: false,
          error: { code: "action_not_found" as const },
        }),
        getEngagementNotes: () => ({ ok: true, value: { marker } as never }),
        putEngagementNotes: () => ({ ok: true, value: { marker } as never }),
      },
      getDevelopmentStorageReadiness: () => "ready",
    });
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/v1/engagements" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ code: "invalid_persisted_data" });
    expect(response.body).not.toContain(marker);
  });

  it("does not reflect unexpected repository exceptions", async () => {
    const marker = "SQL failure at /private/stonehush.sqlite3";
    const app = buildApp({
      engagementRepository: {
        getEngagement() {
          throw new Error(marker);
        },
        getFindingForEngagement() {
          throw new Error(marker);
        },
        listEngagements() {
          throw new Error(marker);
        },
        listScopeRevisions() {
          throw new Error(marker);
        },
        getAction() {
          throw new Error(marker);
        },
        retryActionContext() {
          throw new Error(marker);
        },
        getEngagementNotes() {
          throw new Error(marker);
        },
        putEngagementNotes() {
          throw new Error(marker);
        },
      },
      getDevelopmentStorageReadiness: () => "ready",
    });
    openApps.push(app);

    for (const url of [
      "/api/v1/engagements",
      "/api/v1/engagements/10000000-0000-4000-8000-000000000001",
      "/api/v1/engagements/10000000-0000-4000-8000-000000000001/scope-revisions",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ code: "invalid_persisted_data" });
      expect(response.body).not.toContain(marker);
      expect(response.body).not.toContain("private");
    }
  });
});
