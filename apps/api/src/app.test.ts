import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import {
  bootstrapDevelopmentStorage,
  checkDevelopmentStorage,
} from "./development-storage.js";

const openApps: ReturnType<typeof buildApp>[] = [];
const temporaryRoots: string[] = [];

const emptyEngagementRepository = {
  getEngagement() {
    return {
      ok: false as const,
      error: { code: "engagement_not_found" as const },
    };
  },
  getFindingForEngagement() {
    return {
      ok: false as const,
      error: { code: "finding_not_found" as const },
    };
  },
  listEngagements() {
    return { ok: true as const, value: [] };
  },
  listScopeRevisions() {
    return { ok: true as const, value: [] };
  },
  getAction() {
    return {
      ok: false as const,
      error: { code: "action_not_found" as const },
    };
  },
  retryActionContext() {
    return {
      ok: false as const,
      error: { code: "action_not_found" as const },
    };
  },
  getEngagementNotes() {
    return {
      ok: false as const,
      error: { code: "engagement_not_found" as const },
    };
  },
  putEngagementNotes() {
    return {
      ok: false as const,
      error: { code: "engagement_not_found" as const },
    };
  },
};

function createApp(readiness: "ready" | "not_ready" = "ready") {
  const app = buildApp({
    engagementRepository: emptyEngagementRepository,
    getDevelopmentStorageReadiness: () => readiness,
  });
  openApps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function createStorageBackedApp() {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-status-test-"));
  temporaryRoots.push(root);
  const dataDirectory = path.join(root, "development");
  await bootstrapDevelopmentStorage(dataDirectory);
  const app = buildApp({
    engagementRepository: emptyEngagementRepository,
    async getDevelopmentStorageReadiness() {
      await checkDevelopmentStorage(dataDirectory);
      return "ready" as const;
    },
  });
  openApps.push(app);
  return { app, dataDirectory };
}

describe("buildApp", () => {
  it("returns the exact health response", async () => {
    const app = createApp();

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^application\/json/);
    expect(response.json()).toEqual({ status: "ok" });
    expect(response.body).toBe('{"status":"ok"}');
  });

  it("does not serve the health payload for unsupported methods", async () => {
    const app = createApp();

    const response = await app.inject({ method: "POST", url: "/health" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).not.toEqual({ status: "ok" });
  });

  it("does not install process signal listeners", async () => {
    const before = {
      SIGINT: process.listenerCount("SIGINT"),
      SIGTERM: process.listenerCount("SIGTERM"),
    };

    createApp();

    expect(process.listenerCount("SIGINT")).toBe(before.SIGINT);
    expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM);
  });

  it.each([
    ["ready", 200],
    ["not_ready", 503],
  ] as const)("returns the strict %s system status with HTTP %d", async (readiness, code) => {
    const app = createApp(readiness);

    const response = await app.inject({ method: "GET", url: "/api/v1/system/status" });

    expect(response.statusCode).toBe(code);
    expect(response.headers["content-type"]).toMatch(/^application\/json/);
    expect(response.json()).toEqual({
      version: 1,
      overall: readiness,
      developmentStorage: readiness,
    });
    expect(response.body).not.toContain("path");
    expect(response.body).not.toContain("error");
  });

  it("turns a status dependency failure into a path-free not-ready response", async () => {
    const app = buildApp({
      engagementRepository: emptyEngagementRepository,
      getDevelopmentStorageReadiness() {
        throw new Error("Storage failed at /private/development-data");
      },
    });
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/v1/system/status" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      version: 1,
      overall: "not_ready",
      developmentStorage: "not_ready",
    });
    expect(response.body).not.toContain("private");
    expect(response.body).not.toContain("failed");
  });

  it("becomes not ready without recreating storage removed after startup", async () => {
    const { app, dataDirectory } = await createStorageBackedApp();
    expect((await app.inject({ method: "GET", url: "/api/v1/system/status" })).statusCode).toBe(
      200,
    );

    await rm(dataDirectory, { recursive: true });
    const response = await app.inject({ method: "GET", url: "/api/v1/system/status" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      version: 1,
      overall: "not_ready",
      developmentStorage: "not_ready",
    });
    await expect(checkDevelopmentStorage(dataDirectory)).rejects.toMatchObject({
      failure: "initialize",
    });
  });

  it("becomes not ready when storage permissions become unsafe", async () => {
    const { app, dataDirectory } = await createStorageBackedApp();
    expect((await app.inject({ method: "GET", url: "/api/v1/system/status" })).statusCode).toBe(
      200,
    );

    await chmod(dataDirectory, 0o750);
    const response = await app.inject({ method: "GET", url: "/api/v1/system/status" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      version: 1,
      overall: "not_ready",
      developmentStorage: "not_ready",
    });
  });
});
