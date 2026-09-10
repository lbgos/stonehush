import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  EngagementRepository,
  TechniqueRepository,
  openEngagementDatabase,
} from "@blackglass/db";
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

async function createTechniqueBackedApp() {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "blackglass-techniques-route-test-"),
  );
  temporaryDirectories.push(dataDirectory);
  await chmod(dataDirectory, 0o700);
  const database = openEngagementDatabase({ dataDirectory });
  let nextId = 1;
  let minute = 0;
  const engagements = new EngagementRepository(database.db, {
    createId: () =>
      `10000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
    now: () => new Date(Date.UTC(2026, 7, 12, 12, minute++)),
  });
  const techniques = new TechniqueRepository(database.db, {
    createId: () =>
      `20000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
    now: () => new Date(Date.UTC(2026, 7, 12, 12, minute++)),
  });
  const app = buildApp({
    engagementRepository: engagements,
    techniqueRepository: techniques,
    getDevelopmentStorageReadiness: () => "ready",
  });
  app.addHook("onClose", async () => database.close());
  openApps.push(app);
  return { app, engagements };
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "Check default credentials",
    whenUseful: "A login form appears.",
    prerequisites: ["Login form observed"],
    question: "Does the login accept default credentials?",
    procedure: [
      { instruction: "Try one documented default pair.", command: "curl -s {{url}}" },
    ],
    meaning: "Success proves weak credentials.",
    ...overrides,
  };
}

describe("technique routes", () => {
  it("creates, lists, and reads a technique", async () => {
    const { app, engagements } = await createTechniqueBackedApp();
    const createdEngagement = engagements.createEngagement({
      name: "Techniques lab",
      kind: "lab",
      autoContinueWarnings: false,
    });
    if (!createdEngagement.ok) throw new Error(`Fixture failed: ${createdEngagement.error.code}`);
    const engagementId = createdEngagement.value.id;

    const empty = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/techniques`,
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual([]);

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${engagementId}/techniques`,
      payload: validBody(),
    });
    expect(created.statusCode).toBe(201);
    const technique = created.json() as { id: string; name: string };
    expect(technique.name).toBe("Check default credentials");

    const reread = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/techniques/${technique.id}`,
    });
    expect(reread.statusCode).toBe(200);
    expect((reread.json() as { id: string }).id).toBe(technique.id);
  });

  it("rejects invalid bodies and unknown engagements", async () => {
    const { app, engagements } = await createTechniqueBackedApp();
    const createdEngagement = engagements.createEngagement({
      name: "Techniques lab",
      kind: "lab",
      autoContinueWarnings: false,
    });
    if (!createdEngagement.ok) throw new Error(`Fixture failed: ${createdEngagement.error.code}`);
    const engagementId = createdEngagement.value.id;

    const invalid = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${engagementId}/techniques`,
      payload: validBody({ procedure: [] }),
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ code: "invalid_request" });

    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/engagements/10000000-0000-4000-8000-000000009999/techniques",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ code: "engagement_not_found" });

    const missingTechnique = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/techniques/10000000-0000-4000-8000-000000009999`,
    });
    expect(missingTechnique.statusCode).toBe(404);
    expect(missingTechnique.json()).toEqual({ code: "technique_not_found" });
  });

  it("refuses creates on archived engagements", async () => {
    const { app, engagements } = await createTechniqueBackedApp();
    const createdEngagement = engagements.createEngagement({
      name: "Techniques lab",
      kind: "lab",
      autoContinueWarnings: false,
    });
    if (!createdEngagement.ok) throw new Error(`Fixture failed: ${createdEngagement.error.code}`);
    const engagementId = createdEngagement.value.id;
    const archived = engagements.archive(engagementId, createdEngagement.value.revision);
    if (!archived.ok) throw new Error(`Archive failed: ${archived.error.code}`);

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${engagementId}/techniques`,
      payload: validBody(),
    });
    expect(created.statusCode).toBe(409);
    expect(created.json()).toEqual({ code: "engagement_archived" });
  });
});
