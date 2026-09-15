import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  EngagementRepository,
  FfufRepository,
  OperatorCommandRepository,
  SettingsRepository,
  openEngagementDatabase,
} from "@stonehush/db";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

const directories: string[] = [];
const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
  await Promise.all(
    directories.splice(0).map(async (directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "stonehush-ffuf-api-"));
  directories.push(directory);
  await chmod(directory, 0o700);
  const database = openEngagementDatabase({ dataDirectory: directory });
  let nextId = 1;
  let minute = 0;
  const engagementRepository = new EngagementRepository(database.db, {
    createId: () =>
      `10000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
    now: () => new Date(Date.UTC(2026, 7, 12, 12, minute++)),
  });
  const operatorCommandRepository = new OperatorCommandRepository(
    engagementRepository,
    { now: () => new Date("2026-08-12T13:00:00.000Z") },
  );
  const app = buildApp({
    engagementRepository,
    operatorCommandRepository,
    ffufRepository: new FfufRepository(database.db),
    settingsRepository: new SettingsRepository(database.db),
    getDevelopmentStorageReadiness: () => "ready",
  });
  app.addHook("onClose", async () => database.close());
  apps.push(app);
  return { app, database };
}

const headers = (key: string) => ({ "idempotency-key": key });
const key = (suffix: string) => `fixture-idempotency-${suffix.padEnd(12, "0")}`;

async function createEngagement(app: ReturnType<typeof buildApp>) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/engagements",
    headers: headers(key("eng-ffuf")),
    payload: { name: "Ffuf lab", kind: "lab", autoContinueWarnings: false },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string; revision: number };
}

function launchPayload(revision: number, overrides: Record<string, unknown> = {}) {
  return {
    expectedEngagementRevision: revision,
    expectedActiveScopeRevisionId: null,
    origin: "http://127.0.0.1:3130",
    wordlistPath: "/lists/smoke.txt",
    ...overrides,
  };
}

describe("ffuf discovery routes", () => {
  it("launches with a T2 warning, continues through the shared path, and lists empty results", async () => {
    const { app } = await fixture();
    const engagement = await createEngagement(app);
    const base = `/api/v1/engagements/${engagement.id}`;

    const launched = await app.inject({
      method: "POST",
      url: `${base}/ffuf-discoveries`,
      headers: headers(key("ffuf-launch")),
      payload: launchPayload(engagement.revision),
    });
    expect(launched.statusCode).toBe(201);
    const action = launched.json() as {
      revision: number;
      action: {
        actionId: string;
        state: string;
        pendingWarning: { reasonCodes: string[] } | null;
        snapshots: { version: number; binding: string }[];
      };
    };
    expect(action.action.state).toBe("paused_for_warning");
    expect(action.action.pendingWarning?.reasonCodes).toEqual(["risk_tier_t2"]);

    const continued = await app.inject({
      method: "POST",
      url: `${base}/actions/${action.action.actionId}/continue`,
      headers: headers(key("ffuf-continue")),
      payload: {
        expectedRevision: action.revision,
        snapshotVersion: 1,
        snapshotBinding: action.action.snapshots[0]?.binding,
      },
    });
    expect(continued.statusCode).toBe(200);
    expect((continued.json() as { action: { state: string } }).action.state).toBe("queued");

    const results = await app.inject({ method: "GET", url: `${base}/ffuf-results` });
    expect(results.statusCode).toBe(200);
    expect(results.json()).toEqual([]);
  });

  it("rejects invalid contracts truthfully and archived engagements like other mutations", async () => {
    const { app } = await fixture();
    const engagement = await createEngagement(app);
    const base = `/api/v1/engagements/${engagement.id}`;

    for (const [suffix, payload] of [
      ["bad-origin", launchPayload(engagement.revision, { origin: "ftp://x/" })],
      ["bad-wordlist", launchPayload(engagement.revision, { wordlistPath: "../etc/words" })],
      ["bad-target", launchPayload(engagement.revision, { origin: "192.0.2.10" })],
    ] as const) {
      const rejected = await app.inject({
        method: "POST",
        url: `${base}/ffuf-discoveries`,
        headers: headers(key(`ffuf-${suffix}`)),
        payload,
      });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json()).toEqual({ code: "invalid_ffuf_action_contract" });
    }

    const archived = await app.inject({
      method: "POST",
      url: `${base}/archive`,
      headers: headers(key("ffuf-archive")),
      payload: { expectedRevision: engagement.revision },
    });
    expect(archived.statusCode).toBe(200);

    const afterArchive = await app.inject({
      method: "POST",
      url: `${base}/ffuf-discoveries`,
      headers: headers(key("ffuf-archived")),
      payload: launchPayload((archived.json() as { revision: number }).revision),
    });
    expect(afterArchive.statusCode).toBe(409);
    expect(afterArchive.json()).toEqual({ code: "engagement_archived" });
  });

  it("fills absent launch fields from stored runner defaults with explicit values winning", async () => {
    const { app } = await fixture();
    const engagement = await createEngagement(app);
    const base = `/api/v1/engagements/${engagement.id}`;

    const stored = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/runner",
      payload: {
        ffufWordlistPath: "/lists/default.txt",
        ffufRate: 50,
        ffufThreads: 10,
        ffufTimeoutSeconds: 5,
        ffufMaxTimeSeconds: 60,
      },
    });
    expect(stored.statusCode).toBe(200);

    const launched = await app.inject({
      method: "POST",
      url: `${base}/ffuf-discoveries`,
      headers: headers(key("ffuf-defaults")),
      payload: {
        expectedEngagementRevision: engagement.revision,
        expectedActiveScopeRevisionId: null,
        origin: "http://127.0.0.1:3130",
      },
    });
    expect(launched.statusCode).toBe(201);
    const snapshots = (launched.json() as { action: { snapshots: { typedOptions: unknown }[] } }).action
      .snapshots;
    expect(snapshots[0]?.typedOptions).toMatchObject({
      ffuf: {
        wordlistPath: "/lists/default.txt",
        rate: 50,
        threads: 10,
        timeoutSeconds: 5,
        maxTimeSeconds: 60,
      },
    });

    const explicit = await app.inject({
      method: "POST",
      url: `${base}/ffuf-discoveries`,
      headers: headers(key("ffuf-explicit-wins")),
      payload: {
        expectedEngagementRevision: engagement.revision,
        expectedActiveScopeRevisionId: null,
        origin: "http://127.0.0.1:3130",
        wordlistPath: "/lists/explicit.txt",
        rate: 200,
      },
    });
    expect(explicit.statusCode).toBe(201);
    const explicitSnapshots = (explicit.json() as { action: { snapshots: { typedOptions: unknown }[] } })
      .action.snapshots;
    expect(explicitSnapshots[0]?.typedOptions).toMatchObject({
      ffuf: { wordlistPath: "/lists/explicit.txt", rate: 200, threads: 10 },
    });
  });

  it("rejects a launch with no wordlist in the request or stored defaults", async () => {
    const { app } = await fixture();
    const engagement = await createEngagement(app);
    const rejected = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${engagement.id}/ffuf-discoveries`,
      headers: headers(key("ffuf-no-wordlist")),
      payload: {
        expectedEngagementRevision: engagement.revision,
        expectedActiveScopeRevisionId: null,
        origin: "http://127.0.0.1:3130",
      },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toEqual({ code: "invalid_request" });
  });

  it("returns engagement_not_found for unknown engagements", async () => {
    const { app } = await fixture();
    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/engagements/10000000-0000-4000-8000-000000009999/ffuf-results",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ code: "engagement_not_found" });
  });
});
