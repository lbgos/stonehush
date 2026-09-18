import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openEngagementDatabase } from "./database.js";
import { GitleaksRepository } from "./gitleaks.js";
import { EngagementRepository } from "./repository.js";
import * as schema from "./schema.js";

const fixtures: { directory: string; database: ReturnType<typeof openEngagementDatabase> }[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.database.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

const LIVE_KEY = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh12";

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "stonehush-gitleaks-db-"));
  chmodSync(directory, 0o700);
  const database = openEngagementDatabase({ dataDirectory: directory });
  fixtures.push({ directory, database });
  const engagements = new EngagementRepository(database.db);
  const created = engagements.createEngagement({ name: "Lab", kind: "lab", autoContinueWarnings: false });
  if (!created.ok) throw new Error("engagement");
  let scan = 0;
  const repository = new GitleaksRepository(database.db, {
    createId: () => `10000000-0000-4000-8000-${String(++scan).padStart(12, "0")}`,
    now: () => new Date(Date.UTC(2026, 8, 18, 12, scan)),
  });
  return { database, repository, engagementId: created.value.id };
}

function match(overrides: Record<string, unknown> = {}) {
  return {
    ruleId: "github-pat",
    file: "bundle.js",
    line: 7,
    fingerprint: "0123456789abcdef",
    ...overrides,
  };
}

describe("GitleaksRepository", () => {
  it("stores a scan with redacted matches only", () => {
    const { database, repository, engagementId } = fixture();
    const created = repository.createScan(engagementId, { matches: [match()], truncated: false });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.matchCount).toBe(1);
    expect(created.value.matches).toEqual([match()]);

    const rows = database.db.select().from(schema.gitleaksMatches).all();
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(
      ["file", "fingerprint", "line", "ruleId", "scanId"].sort(),
    );
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(LIVE_KEY);
    expect(serialized).not.toContain("secret");
  });

  it("serves the latest scan, so a rescan surfaces new matches", () => {
    const { repository, engagementId } = fixture();
    const first = repository.createScan(engagementId, { matches: [match()], truncated: false });
    expect(first.ok).toBe(true);
    const second = repository.createScan(engagementId, {
      matches: [match(), match({ ruleId: "aws-access-key", file: "config.txt", line: 3, fingerprint: "fedcba9876543210" })],
      truncated: false,
    });
    expect(second.ok).toBe(true);
    const latest = repository.latestForEngagement(engagementId);
    expect(latest.ok).toBe(true);
    if (!latest.ok || latest.value === null) {
      expect(latest.ok).toBe(true);
      return;
    }
    expect(latest.value.matchCount).toBe(2);
    expect(latest.value.matches.map((entry) => entry.ruleId).sort()).toEqual(
      ["aws-access-key", "github-pat"],
    );
  });

  it("returns null before the first scan and rejects unknown engagements", () => {
    const { repository, engagementId } = fixture();
    const empty = repository.latestForEngagement(engagementId);
    expect(empty).toEqual({ ok: true, value: null });
    const missing = repository.createScan("10000000-0000-4000-8000-000000000099", {
      matches: [],
      truncated: false,
    });
    expect(missing).toEqual({ ok: false, code: "engagement_not_found" });
  });

  it("counts kept rows when duplicate matches arrive together", () => {
    const { repository, engagementId } = fixture();
    const created = repository.createScan(engagementId, {
      matches: [match(), match(), match({ line: 8, fingerprint: "1111111111111111" })],
      truncated: false,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.matchCount).toBe(2);
    expect(created.value.matches).toHaveLength(2);
  });

  it("refuses the write when the engagement is archived", () => {
    const { database, repository, engagementId } = fixture();
    const created = repository.createScan(engagementId, { matches: [match()], truncated: false });
    expect(created.ok).toBe(true);
    const engagements = new EngagementRepository(database.db);
    const current = engagements.getEngagement(engagementId);
    if (!current.ok) throw new Error("engagement fixture failed");
    const archived = engagements.archive(engagementId, current.value.engagement.revision);
    expect(archived.ok).toBe(true);
    const refused = repository.createScan(engagementId, { matches: [match()], truncated: false });
    expect(refused).toEqual({ ok: false, code: "engagement_archived" });
  });

  it("rejects matches carrying secret-shaped fields", () => {
    const { repository, engagementId } = fixture();
    const created = repository.createScan(engagementId, {
      matches: [{ ...match(), Secret: LIVE_KEY } as unknown as ReturnType<typeof match>],
      truncated: false,
    });
    expect(created).toEqual({ ok: false, code: "invalid_persisted_data" });
    const latest = repository.latestForEngagement(engagementId);
    expect(latest).toEqual({ ok: true, value: null });
  });
});
