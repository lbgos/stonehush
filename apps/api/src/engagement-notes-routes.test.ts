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
    path.join(tmpdir(), "stonehush-notes-route-test-"),
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
  return { app, repository };
}

describe("engagement notes routes", () => {
  it("round-trips markdown with revision 0 -> 1", async () => {
    const { app, repository } = await createRepositoryBackedApp();
    const created = repository.createEngagement({
      name: "Notes lab",
      kind: "lab",
      autoContinueWarnings: false,
    });
    if (!created.ok) throw new Error(`Fixture failed: ${created.error.code}`);
    const markdown = "# creds\nadmin / s3cret\n\nflag{notes-round-trip}";

    const saved = await app.inject({
      method: "PUT",
      url: `/api/v1/engagements/${created.value.id}/notes`,
      payload: { markdown, expectedRevision: 0 },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      engagementId: created.value.id,
      markdown,
      revision: 1,
    });

    const loaded = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${created.value.id}/notes`,
    });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json()).toMatchObject({
      engagementId: created.value.id,
      markdown,
      revision: 1,
    });
    expect(loaded.json().markdown).toBe(markdown);
  });

  it("returns revision 0 before the first save", async () => {
    const { app, repository } = await createRepositoryBackedApp();
    const created = repository.createEngagement({
      name: "Notes lab",
      kind: "lab",
      autoContinueWarnings: false,
    });
    if (!created.ok) throw new Error(`Fixture failed: ${created.error.code}`);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${created.value.id}/notes`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      engagementId: created.value.id,
      markdown: "",
      revision: 0,
    });
  });

  it("rejects a stale revision without overwriting", async () => {
    const { app, repository } = await createRepositoryBackedApp();
    const created = repository.createEngagement({
      name: "Notes lab",
      kind: "lab",
      autoContinueWarnings: false,
    });
    if (!created.ok) throw new Error(`Fixture failed: ${created.error.code}`);
    const first = await app.inject({
      method: "PUT",
      url: `/api/v1/engagements/${created.value.id}/notes`,
      payload: { markdown: "# v1", expectedRevision: 0 },
    });
    expect(first.statusCode).toBe(200);

    const stale = await app.inject({
      method: "PUT",
      url: `/api/v1/engagements/${created.value.id}/notes`,
      payload: { markdown: "# stale", expectedRevision: 0 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({
      code: "revision_conflict",
      resourceType: "engagement_notes",
      resourceId: created.value.id,
      currentRevision: 1,
    });

    const loaded = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${created.value.id}/notes`,
    });
    expect(loaded.json()).toMatchObject({ markdown: "# v1", revision: 1 });
  });

  it("rejects missing revisions and unsafe integers", async () => {
    const { app, repository } = await createRepositoryBackedApp();
    const created = repository.createEngagement({
      name: "Notes lab",
      kind: "lab",
      autoContinueWarnings: false,
    });
    if (!created.ok) throw new Error(`Fixture failed: ${created.error.code}`);

    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/v1/engagements/${created.value.id}/notes`,
          payload: { markdown: "# notes" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/v1/engagements/${created.value.id}/notes`,
          payload: { markdown: "# notes", expectedRevision: -1 },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("rejects oversize bodies and unknown engagements", async () => {
    const { app, repository } = await createRepositoryBackedApp();
    const created = repository.createEngagement({
      name: "Notes lab",
      kind: "lab",
      autoContinueWarnings: false,
    });
    if (!created.ok) throw new Error(`Fixture failed: ${created.error.code}`);

    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/v1/engagements/${created.value.id}/notes`,
          payload: { markdown: "a".repeat(65_537), expectedRevision: 0 },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/engagements/10000000-0000-4000-8000-000000000099/notes",
          payload: { markdown: "# notes", expectedRevision: 0 },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/engagements/not-an-id/notes",
        })
      ).statusCode,
    ).toBe(400);
  });

  it("rejects notes writes to archived engagements", async () => {
    const { app, repository } = await createRepositoryBackedApp();
    const created = repository.createEngagement({
      name: "Notes lab",
      kind: "lab",
      autoContinueWarnings: false,
    });
    if (!created.ok) throw new Error(`Fixture failed: ${created.error.code}`);
    const archived = repository.archive(created.value.id, created.value.revision);
    if (!archived.ok) throw new Error(`Fixture failed: ${archived.error.code}`);

    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/engagements/${created.value.id}/notes`,
      payload: { markdown: "# notes", expectedRevision: 0 },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: "engagement_archived" });
  });
});
