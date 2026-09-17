import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  EngagementRepository,
  OperatorCommandRepository,
  SettingsRepository,
  VhostRepository,
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
  const directory = await mkdtemp(path.join(tmpdir(), "stonehush-vhost-api-"));
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
    vhostRepository: new VhostRepository(database.db),
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
    headers: headers(key("eng-vhost")),
    payload: { name: "Vhost lab", kind: "lab", autoContinueWarnings: false },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string; revision: number };
}

function launchPayload(revision: number, overrides: Record<string, unknown> = {}) {
  return {
    expectedEngagementRevision: revision,
    expectedActiveScopeRevisionId: null,
    address: "192.0.2.10",
    wordlistPath: "/lists/hosts.txt",
    ...overrides,
  };
}

describe("vhost discovery routes", () => {
  it("launches as T1 with no tier warning and lists empty results", async () => {
    const { app } = await fixture();
    const engagement = await createEngagement(app);
    const base = `/api/v1/engagements/${engagement.id}`;

    const launched = await app.inject({
      method: "POST",
      url: `${base}/vhost-discoveries`,
      headers: headers(key("vhost-launch")),
      payload: launchPayload(engagement.revision),
    });
    expect(launched.statusCode).toBe(201);
    const action = launched.json() as {
      revision: number;
      action: {
        actionId: string;
        state: string;
        pendingWarning: { reasonCodes: string[] } | null;
        snapshots: { version: number; binding: string; typedOptions: unknown }[];
      };
    };
    expect(action.action.state).toBe("queued");
    expect(action.action.pendingWarning).toBe(null);
    expect(action.action.snapshots[0]?.typedOptions).toMatchObject({
      declaredPorts: [80],
      ffufVhost: { address: "192.0.2.10", port: 80, tls: false },
    });

    const results = await app.inject({ method: "GET", url: `${base}/vhost-results` });
    expect(results.statusCode).toBe(200);
    expect(results.json()).toEqual([]);
  });

  it("pauses once for outside_scope with Continue available, exactly like other discovery", async () => {
    const { app } = await fixture();
    const engagement = await createEngagement(app);
    const base = `/api/v1/engagements/${engagement.id}`;

    const scoped = await app.inject({
      method: "POST",
      url: `${base}/scope-revisions`,
      headers: headers(key("vhost-scope")),
      payload: { expectedRevision: engagement.revision, rules: [] },
    });
    expect(scoped.statusCode).toBe(201);
    const scopeId = (scoped.json() as { id: string }).id;
    const detail = await app.inject({ method: "GET", url: base });
    const revision = (detail.json() as { engagement: { revision: number } }).engagement.revision;

    const launched = await app.inject({
      method: "POST",
      url: `${base}/vhost-discoveries`,
      headers: headers(key("vhost-outside")),
      payload: launchPayload(revision, { expectedActiveScopeRevisionId: scopeId }),
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
    expect(action.action.pendingWarning?.reasonCodes).toEqual(["outside_scope"]);

    const continued = await app.inject({
      method: "POST",
      url: `${base}/actions/${action.action.actionId}/continue`,
      headers: headers(key("vhost-continue")),
      payload: {
        expectedRevision: action.revision,
        snapshotVersion: 1,
        snapshotBinding: action.action.snapshots[0]?.binding,
      },
    });
    expect(continued.statusCode).toBe(200);
    expect((continued.json() as { action: { state: string } }).action.state).toBe("queued");
  });

  it("rejects non-IP targets and bad contracts truthfully", async () => {
    const { app } = await fixture();
    const engagement = await createEngagement(app);
    const base = `/api/v1/engagements/${engagement.id}`;

    for (const [suffix, payload] of [
      ["bad-host", launchPayload(engagement.revision, { address: "example.com" })],
      ["bad-url", launchPayload(engagement.revision, { address: "http://192.0.2.10/" })],
      ["bad-cidr", launchPayload(engagement.revision, { address: "192.0.2.0/24" })],
      ["bad-wordlist", launchPayload(engagement.revision, { wordlistPath: "../etc/words" })],
    ] as const) {
      const rejected = await app.inject({
        method: "POST",
        url: `${base}/vhost-discoveries`,
        headers: headers(key(`vhost-${suffix}`)),
        payload,
      });
      expect(rejected.statusCode).toBe(400);
    }
  });

  it("returns engagement_not_found for unknown engagements", async () => {
    const { app } = await fixture();
    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/engagements/10000000-0000-4000-8000-000000009999/vhost-results",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ code: "engagement_not_found" });
  });
});
