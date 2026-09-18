import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { EngagementRepository, GitleaksRepository, openEngagementDatabase } from "@stonehush/db";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import type { GitleaksScanner } from "./gitleaks-routes.js";

const directories: string[] = [];
const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
  await Promise.all(
    directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })),
  );
});

const LIVE_KEY = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh12";

function redactedMatch(overrides: Record<string, unknown> = {}) {
  return {
    ruleId: "github-pat",
    file: "artifact-01",
    line: 7,
    fingerprint: "0123456789abcdef",
    ...overrides,
  };
}

async function fixture(scanner: GitleaksScanner) {
  const directory = await mkdtemp(path.join(tmpdir(), "stonehush-gitleaks-api-"));
  directories.push(directory);
  const database = openEngagementDatabase({ dataDirectory: directory });
  let nextId = 1;
  const engagementRepository = new EngagementRepository(database.db, {
    createId: () => `10000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
    now: () => new Date(Date.UTC(2026, 8, 18, 12, 0, nextId)),
  });
  let scan = 100;
  const app = buildApp({
    engagementRepository,
    gitleaksRepository: new GitleaksRepository(database.db, {
      createId: () => `20000000-0000-4000-8000-${String(scan++).padStart(12, "0")}`,
      now: () => new Date(Date.UTC(2026, 8, 18, 12, 0, scan)),
    }),
    gitleaksScanner: scanner,
    getDevelopmentStorageReadiness: () => "ready",
  });
  app.addHook("onClose", async () => database.close());
  apps.push(app);
  return { app, engagementRepository };
}

async function createEngagement(engagementRepository: EngagementRepository) {
  const created = engagementRepository.createEngagement({
    name: "Secret lab",
    kind: "lab",
    autoContinueWarnings: false,
  });
  if (!created.ok) throw new Error("engagement fixture failed");
  return created.value as { id: string; revision: number };
}

describe("gitleaks routes", () => {
  it("scans engagement evidence and lists redacted matches without values", async () => {
    const scanner: GitleaksScanner = {
      scan: async () => ({
        ok: true,
        value: { matches: [redactedMatch()], truncated: false, stagedFiles: 2, skippedFiles: 0 },
      }),
    };
    const { app, engagementRepository } = await fixture(scanner);
    const engagement = await createEngagement(engagementRepository);
    const base = `/api/v1/engagements/${engagement.id}`;

    const scanned = await app.inject({ method: "POST", url: `${base}/gitleaks-scans`, payload: {} });
    expect(scanned.statusCode).toBe(201);
    const body = scanned.json() as { matches: unknown[]; matchCount: number; truncated: boolean };
    expect(body.matchCount).toBe(1);
    expect(body.truncated).toBe(false);
    expect(body.matches).toEqual([redactedMatch()]);
    expect(JSON.stringify(body)).not.toContain(LIVE_KEY);

    const listed = await app.inject({ method: "GET", url: `${base}/gitleaks-matches` });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([redactedMatch()]);
    expect(JSON.stringify(listed.json())).not.toContain("Secret");
  });

  it("returns an empty match list before the first scan", async () => {
    const { app, engagementRepository } = await fixture({
      scan: async () => {
        throw new Error("must not run");
      },
    });
    const engagement = await createEngagement(engagementRepository);
    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagement.id}/gitleaks-matches`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([]);
  });

  it("surfaces the truthful missing-tool error when gitleaks is absent", async () => {
    const { app, engagementRepository } = await fixture({
      scan: async () => ({ ok: false, error: { code: "gitleaks_missing" } }),
    });
    const engagement = await createEngagement(engagementRepository);
    const scanned = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${engagement.id}/gitleaks-scans`,
      payload: {},
    });
    expect(scanned.statusCode).toBe(503);
    expect(scanned.json()).toEqual({ code: "gitleaks_missing" });
  });

  it("rescan after new evidence surfaces the new matches", async () => {
    let round = 0;
    const { app, engagementRepository } = await fixture({
      scan: async () => {
        round += 1;
        return round === 1
          ? { ok: true, value: { matches: [redactedMatch()], truncated: false, stagedFiles: 1, skippedFiles: 0 } }
          : {
              ok: true,
              value: {
                matches: [
                  redactedMatch(),
                  redactedMatch({ ruleId: "aws-access-key", file: "artifact-02", line: 3, fingerprint: "fedcba9876543210" }),
                ],
                truncated: false,
                stagedFiles: 2,
                skippedFiles: 0,
              },
            };
      },
    });
    const engagement = await createEngagement(engagementRepository);
    const base = `/api/v1/engagements/${engagement.id}`;
    expect((await app.inject({ method: "POST", url: `${base}/gitleaks-scans`, payload: {} })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `${base}/gitleaks-scans`, payload: {} })).statusCode).toBe(201);
    const listed = await app.inject({ method: "GET", url: `${base}/gitleaks-matches` });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as unknown[]).length).toBe(2);
  });

  it("refuses to persist a value even if the scanner returns one", async () => {
    const { app, engagementRepository } = await fixture({
      scan: async () => ({
        ok: true,
        value: {
          matches: [{ ...redactedMatch(), Secret: LIVE_KEY } as unknown as ReturnType<typeof redactedMatch>],
          truncated: false,
          stagedFiles: 1,
          skippedFiles: 0,
        },
      }),
    });
    const engagement = await createEngagement(engagementRepository);
    const scanned = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${engagement.id}/gitleaks-scans`,
      payload: {},
    });
    expect(scanned.statusCode).toBe(500);
    expect(scanned.json()).toEqual({ code: "invalid_persisted_data" });
    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagement.id}/gitleaks-matches`,
    });
    expect(listed.json()).toEqual([]);
  });

  it("rejects scans on archived engagements and unknown ids", async () => {
    const { app, engagementRepository } = await fixture({
      scan: async () => ({
        ok: true,
        value: { matches: [], truncated: false, stagedFiles: 0, skippedFiles: 0 },
      }),
    });
    const engagement = await createEngagement(engagementRepository);
    const archived = engagementRepository.archive(engagement.id, engagement.revision);
    expect(archived.ok).toBe(true);
    const scanned = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${engagement.id}/gitleaks-scans`,
      payload: {},
    });
    expect(scanned.statusCode).toBe(409);
    expect(scanned.json()).toEqual({ code: "engagement_archived" });
    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/engagements/10000000-0000-4000-8000-000000000099/gitleaks-matches",
    });
    expect(missing.statusCode).toBe(404);
  });
});
