import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { SettingsRepository, openEngagementDatabase } from "@stonehush/db";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { registerAdvisorStatusRoutes } from "./advisor-status-routes.js";
import type { probeAdvisorEndpoint } from "./advisor-status-probe.js";

const KEY_ENV_VAR = "STONEHUSH_ADVISOR_STATUS_TEST_KEY";
const KEY_VALUE = "lab-secret-value";

const temporaryDirectories: string[] = [];
const openApps: ReturnType<typeof buildApp>[] = [];
const labServers: Server[] = [];

afterEach(async () => {
  delete process.env[KEY_ENV_VAR];
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
  await Promise.all(
    labServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  vi.restoreAllMocks();
});

async function createStatusBackedApp(options?: {
  probe?: typeof probeAdvisorEndpoint;
  statusTimeoutMs?: number;
}) {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "stonehush-advisor-status-test-"));
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
    ...(options?.probe === undefined && options?.statusTimeoutMs === undefined
      ? {}
      : {
          advisorStatus: {
            ...(options.probe === undefined ? {} : { probe: options.probe }),
            ...(options.statusTimeoutMs === undefined
              ? {}
              : { statusTimeoutMs: options.statusTimeoutMs }),
          },
        }),
  });
  app.addHook("onClose", async () => database.close());
  openApps.push(app);
  return { app };
}

async function startLabListener(status = 200): Promise<{ hits: () => number; url: string }> {
  let hits = 0;
  const server = createServer((_request, response) => {
    hits += 1;
    response.writeHead(status, { "content-type": "application/json" });
    response.end("{}");
  });
  labServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  return { hits: () => hits, url: `http://127.0.0.1:${address.port}/v1` };
}

async function configureAdvisor(
  app: ReturnType<typeof buildApp>,
  payload: Record<string, unknown>,
) {
  const response = await app.inject({
    method: "PUT",
    url: "/api/v1/settings/advisor",
    payload,
  });
  expect(response.statusCode).toBe(200);
}

describe("advisor status routes", () => {
  it("reports unconfigured on a fresh database without probing", async () => {
    const probe = vi.fn(async () => ({ reachable: true, latencyMs: 1 }));
    const { app } = await createStatusBackedApp({ probe });

    const response = await app.inject({ method: "GET", url: "/api/v1/advisor/status" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      configured: false,
      endpointReachable: null,
      modelId: "",
      endpointHost: "",
      publicEndpoint: false,
      optIn: false,
      keyEnvVar: "",
      keyPresent: false,
      latencyMs: null,
      reason: "unconfigured",
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it("reports no-auth reachability when no key env var is named", async () => {
    const lab = await startLabListener();
    const probe = vi.fn(async () => ({ reachable: true, latencyMs: 1 }));
    const { app } = await createStatusBackedApp({ probe });
    await configureAdvisor(app, { endpointBaseUrl: lab.url, modelId: "lab-model" });

    const response = await app.inject({ method: "GET", url: "/api/v1/advisor/status" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      configured: true,
      endpointReachable: true,
      modelId: "lab-model",
      endpointHost: "127.0.0.1",
      publicEndpoint: false,
      keyEnvVar: "",
      keyPresent: false,
      latencyMs: 1,
      reason: "ok",
    });
    // Reachability only: the probe receives the URL and a timeout, never auth.
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(lab.url, expect.objectContaining({ timeoutMs: expect.any(Number) }));
    expect(JSON.stringify(response.json())).not.toContain("authorization");
  });

  it("reports public_not_opted_in for a no-auth public endpoint without calling the probe", async () => {
    const probe = vi.fn(async () => ({ reachable: true, latencyMs: 1 }));
    const { app } = await createStatusBackedApp({ probe });
    await configureAdvisor(app, {
      endpointBaseUrl: "http://203.0.113.7:11434/v1",
      modelId: "lab-model",
    });

    const response = await app.inject({ method: "GET", url: "/api/v1/advisor/status" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      configured: true,
      endpointReachable: null,
      endpointHost: "203.0.113.7",
      publicEndpoint: true,
      optIn: false,
      keyEnvVar: "",
      keyPresent: false,
      latencyMs: null,
      reason: "public_not_opted_in",
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it("reports key_unset when the named variable is empty", async () => {
    const lab = await startLabListener();
    const probe = vi.fn(async () => ({ reachable: true, latencyMs: 1 }));
    const { app } = await createStatusBackedApp({ probe });
    await configureAdvisor(app, {
      apiKeyEnvVar: KEY_ENV_VAR,
      endpointBaseUrl: lab.url,
      modelId: "lab-model",
    });

    const response = await app.inject({ method: "GET", url: "/api/v1/advisor/status" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      configured: true,
      endpointReachable: null,
      keyEnvVar: KEY_ENV_VAR,
      keyPresent: false,
      reason: "key_unset",
    });
    expect(probe).not.toHaveBeenCalled();
    expect(lab.hits()).toBe(0);
  });

  it("reports ok for a live private endpoint without leaking key material", async () => {
    const lab = await startLabListener();
    const { app } = await createStatusBackedApp();
    process.env[KEY_ENV_VAR] = KEY_VALUE;
    await configureAdvisor(app, {
      apiKeyEnvVar: KEY_ENV_VAR,
      endpointBaseUrl: lab.url,
      modelId: "lab-model",
    });

    const response = await app.inject({ method: "GET", url: "/api/v1/advisor/status" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      configured: true,
      endpointReachable: true,
      modelId: "lab-model",
      endpointHost: "127.0.0.1",
      publicEndpoint: false,
      optIn: false,
      keyEnvVar: KEY_ENV_VAR,
      keyPresent: true,
      reason: "ok",
    });
    expect(typeof response.json().latencyMs).toBe("number");
    expect(lab.hits()).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(response.json())).not.toContain(KEY_VALUE);
  });

  it("reports unreachable after the lab listener stops", async () => {
    const lab = await startLabListener();
    const stoppedUrl = lab.url;
    await Promise.all(
      labServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    const { app } = await createStatusBackedApp();
    process.env[KEY_ENV_VAR] = KEY_VALUE;
    await configureAdvisor(app, {
      apiKeyEnvVar: KEY_ENV_VAR,
      endpointBaseUrl: stoppedUrl,
      modelId: "lab-model",
    });

    const response = await app.inject({ method: "GET", url: "/api/v1/advisor/status" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      configured: true,
      endpointReachable: false,
      reason: "unreachable",
    });
    expect(JSON.stringify(response.json())).not.toContain(KEY_VALUE);
  });

  it("reports public_not_opted_in without attempting any outbound connection", async () => {
    const probe = vi.fn(async () => ({ reachable: true, latencyMs: 1 }));
    const { app } = await createStatusBackedApp({ probe });
    process.env[KEY_ENV_VAR] = KEY_VALUE;
    await configureAdvisor(app, {
      apiKeyEnvVar: KEY_ENV_VAR,
      endpointBaseUrl: "http://203.0.113.7:11434/v1",
      modelId: "lab-model",
    });

    const response = await app.inject({ method: "GET", url: "/api/v1/advisor/status" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      configured: true,
      endpointReachable: null,
      endpointHost: "203.0.113.7",
      publicEndpoint: true,
      optIn: false,
      keyPresent: true,
      latencyMs: null,
      reason: "public_not_opted_in",
    });
    expect(probe).not.toHaveBeenCalled();
    expect(JSON.stringify(response.json())).not.toContain(KEY_VALUE);
  });

  it("maps a hung probe to probe_failed once the server cap elapses", async () => {
    const lab = await startLabListener();
    const probe = vi.fn(
      () => new Promise<{ reachable: boolean; latencyMs: number }>(() => {}),
    );
    const { app } = await createStatusBackedApp({ probe, statusTimeoutMs: 50 });
    process.env[KEY_ENV_VAR] = KEY_VALUE;
    await configureAdvisor(app, {
      apiKeyEnvVar: KEY_ENV_VAR,
      endpointBaseUrl: lab.url,
      modelId: "lab-model",
    });

    const response = await app.inject({ method: "GET", url: "/api/v1/advisor/status" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      configured: true,
      endpointReachable: false,
      reason: "probe_failed",
    });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("maps storage failures to 503 and 500, never to a status body", async () => {
    const busy = Fastify();
    registerAdvisorStatusRoutes(busy, {
      repository: {
        getAdvisorSettings: () => ({ ok: false, error: { code: "storage_busy" } }),
      },
    });
    const busyResponse = await busy.inject({ method: "GET", url: "/api/v1/advisor/status" });
    expect(busyResponse.statusCode).toBe(503);
    expect(busyResponse.json()).toEqual({ code: "storage_busy" });
    await busy.close();

    const broken = Fastify();
    registerAdvisorStatusRoutes(broken, {
      repository: {
        getAdvisorSettings: () => {
          throw new Error("database locked");
        },
      },
    });
    const brokenResponse = await broken.inject({ method: "GET", url: "/api/v1/advisor/status" });
    expect(brokenResponse.statusCode).toBe(500);
    expect(brokenResponse.json()).toEqual({ code: "invalid_persisted_data" });
    await broken.close();
  });
});
