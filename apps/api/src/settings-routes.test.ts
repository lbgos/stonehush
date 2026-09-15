import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SettingsRepository, openEngagementDatabase } from "@stonehush/db";
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

async function createSettingsBackedApp() {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "stonehush-settings-route-test-"),
  );
  temporaryDirectories.push(dataDirectory);
  await chmod(dataDirectory, 0o700);
  const database = openEngagementDatabase({ dataDirectory });
  const settingsRepository = new SettingsRepository(database.db);
  const engagementRepository = {
    getEngagement: () => ({ ok: false, error: { code: "engagement_not_found" } }),
    getFindingForEngagement: () => ({ ok: false, error: { code: "finding_not_found" } }),
    listEngagements: () => ({ ok: true, value: [] }),
    listScopeRevisions: () => ({ ok: false, error: { code: "engagement_not_found" } }),
    getAction: () => ({ ok: false, error: { code: "action_not_found" } }),
    retryActionContext: () => ({ ok: false, error: { code: "action_not_found" } }),
    getEngagementNotes: () => ({ ok: false, error: { code: "engagement_not_found" } }),
    putEngagementNotes: () => ({ ok: false, error: { code: "engagement_not_found" } }),
  } as never;
  const app = buildApp({
    engagementRepository,
    getDevelopmentStorageReadiness: () => "ready",
    settingsRepository,
  });
  app.addHook("onClose", async () => database.close());
  openApps.push(app);
  return { app };
}

describe("runner settings routes", () => {
  it("serves shipped defaults on a fresh database", async () => {
    const { app } = await createSettingsBackedApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/settings/runner",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ffufBinaryPath: "/usr/bin/ffuf",
      ffufWordlistPath: "",
      ffufRate: 100,
      ffufThreads: 40,
      ffufTimeoutSeconds: 10,
      ffufMaxTimeSeconds: 120,
    });
  });

  it("persists a partial update and serves it back", async () => {
    const { app } = await createSettingsBackedApp();

    const updated = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/runner",
      payload: {
        ffufWordlistPath: "/usr/share/wordlists/common.txt",
        ffufRate: 50,
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      ffufBinaryPath: "/usr/bin/ffuf",
      ffufWordlistPath: "/usr/share/wordlists/common.txt",
      ffufRate: 50,
      ffufThreads: 40,
    });

    const reloaded = await app.inject({
      method: "GET",
      url: "/api/v1/settings/runner",
    });
    expect(reloaded.statusCode).toBe(200);
    expect(reloaded.json()).toEqual(updated.json());
  });

  it("rejects traversal paths, out-of-range ints, and unknown keys with 400", async () => {
    const { app } = await createSettingsBackedApp();

    for (const payload of [
      { ffufWordlistPath: "/lists/../etc/passwd" },
      { ffufBinaryPath: "ffuf" },
      { ffufRate: 0 },
      { ffufThreads: 201 },
      { ffufTimeoutSeconds: 0 },
      { ffufMaxTimeSeconds: 1801 },
      { ffufRate: 50, scope: "runner" },
    ]) {
      const response = await app.inject({
        method: "PUT",
        url: "/api/v1/settings/runner",
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ code: "invalid_request" });
    }

    const unchanged = await app.inject({
      method: "GET",
      url: "/api/v1/settings/runner",
    });
    expect(unchanged.json()).toMatchObject({ ffufRate: 100, ffufWordlistPath: "" });
  });
});

describe("advisor settings routes", () => {
  it("serves shipped defaults on a fresh database", async () => {
    const { app } = await createSettingsBackedApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/settings/advisor",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      endpointBaseUrl: "",
      modelId: "",
      apiKeyEnvVar: "",
      requestBudget: 10,
      rawResponseVisibility: true,
      publicEndpointOptIn: false,
    });
  });

  it("persists a partial update and serves it back", async () => {
    const { app } = await createSettingsBackedApp();

    const updated = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/advisor",
      payload: {
        endpointBaseUrl: "http://127.0.0.1:11434/v1",
        modelId: "qwen3:8b",
        apiKeyEnvVar: "STONEHUSH_ADVISOR_API_KEY",
        requestBudget: 25,
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({
      endpointBaseUrl: "http://127.0.0.1:11434/v1",
      modelId: "qwen3:8b",
      apiKeyEnvVar: "STONEHUSH_ADVISOR_API_KEY",
      requestBudget: 25,
      rawResponseVisibility: true,
      publicEndpointOptIn: false,
    });

    const reloaded = await app.inject({
      method: "GET",
      url: "/api/v1/settings/advisor",
    });
    expect(reloaded.statusCode).toBe(200);
    expect(reloaded.json()).toEqual(updated.json());
  });

  it("rejects key material, bad env names, bad URLs, and unknown keys with 400", async () => {
    const { app } = await createSettingsBackedApp();

    for (const payload of [
      { modelId: "sk-abc123" },
      { modelId: "Bearer eyJhbGciOiJIUzI1NiJ9" },
      { endpointBaseUrl: "https://example.invalid/sk-abc123" },
      { endpointBaseUrl: "gopher://example.invalid" },
      { apiKeyEnvVar: "bad-name" },
      { requestBudget: 0 },
      { requestBudget: 101 },
      { requestBudget: 5, scope: "advisor" },
    ]) {
      const response = await app.inject({
        method: "PUT",
        url: "/api/v1/settings/advisor",
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ code: "invalid_request" });
    }

    const unchanged = await app.inject({
      method: "GET",
      url: "/api/v1/settings/advisor",
    });
    expect(unchanged.json()).toMatchObject({ endpointBaseUrl: "", requestBudget: 10 });
  });

  it("leaves the runner scope unaffected by advisor writes", async () => {
    const { app } = await createSettingsBackedApp();

    const updated = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/advisor",
      payload: { requestBudget: 5 },
    });
    expect(updated.statusCode).toBe(200);

    const runner = await app.inject({
      method: "GET",
      url: "/api/v1/settings/runner",
    });
    expect(runner.statusCode).toBe(200);
    expect(runner.json()).toMatchObject({ ffufRate: 100 });
  });
});
