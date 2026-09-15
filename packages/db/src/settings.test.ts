import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { openEngagementDatabase, DATABASE_SCHEMA_VERSION } from "./database.js";
import { settings } from "./schema.js";
import { SettingsRepository } from "./settings.js";

interface Fixture {
  directory: string;
  database: ReturnType<typeof openEngagementDatabase>;
  repository: SettingsRepository;
}

const fixtures: Fixture[] = [];

function createFixture(): Fixture {
  const directory = mkdtempSync(path.join(tmpdir(), "stonehush-settings-test-"));
  chmodSync(directory, 0o700);
  const database = openEngagementDatabase({ dataDirectory: directory });
  let minute = 0;
  const repository = new SettingsRepository(database.db, {
    now: () => new Date(Date.UTC(2026, 7, 12, 12, minute++)),
  });
  const fixture = { directory, database, repository };
  fixtures.push(fixture);
  return fixture;
}

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture === undefined) continue;
    if (fixture.database.sqlite.open) fixture.database.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

describe("runner settings persistence", () => {
  it("serves shipped defaults when the row is absent", () => {
    const { repository } = createFixture();

    expect(repository.getRunnerSettings()).toEqual({
      ok: true,
      value: {
        ffufBinaryPath: "/usr/bin/ffuf",
        ffufWordlistPath: "",
        ffufRate: 100,
        ffufThreads: 40,
        ffufTimeoutSeconds: 10,
        ffufMaxTimeSeconds: 120,
      },
    });
  });

  it("persists a partial update and merges it over the previous values", () => {
    const { repository } = createFixture();

    const updated = repository.updateRunnerSettings({
      ffufWordlistPath: "/usr/share/wordlists/common.txt",
      ffufRate: 50,
    });
    expect(updated).toEqual({
      ok: true,
      value: {
        ffufBinaryPath: "/usr/bin/ffuf",
        ffufWordlistPath: "/usr/share/wordlists/common.txt",
        ffufRate: 50,
        ffufThreads: 40,
        ffufTimeoutSeconds: 10,
        ffufMaxTimeSeconds: 120,
      },
    });
    expect(repository.getRunnerSettings()).toEqual(updated);
  });

  it("rejects traversal, relative paths, and out-of-range ints without storing", () => {
    const { repository, database } = createFixture();

    expect(
      repository.updateRunnerSettings({ ffufWordlistPath: "/lists/../etc/passwd" }),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
    expect(repository.updateRunnerSettings({ ffufBinaryPath: "ffuf" })).toEqual({
      ok: false,
      error: { code: "invalid_repository_input" },
    });
    expect(repository.updateRunnerSettings({ ffufRate: 0 })).toEqual({
      ok: false,
      error: { code: "invalid_repository_input" },
    });
    expect(repository.updateRunnerSettings({ unknownKey: true })).toEqual({
      ok: false,
      error: { code: "invalid_repository_input" },
    });

    expect(
      database.db.select().from(settings).where(eq(settings.scope, "runner")).get(),
    ).toBeUndefined();
  });

  it("rejects corrupt persisted rows as invalid_persisted_data", () => {
    const { repository, database } = createFixture();

    database.db
      .insert(settings)
      .values({
        scope: "runner",
        valueJson: JSON.stringify({ ffufRate: "fast" }),
        updatedAt: new Date(Date.UTC(2026, 7, 12, 12, 0)).toISOString(),
      })
      .run();

    expect(repository.getRunnerSettings()).toEqual({
      ok: false,
      error: { code: "invalid_persisted_data" },
    });
  });

  it("touches updated_at on every write", () => {
    const { repository, database } = createFixture();

    repository.updateRunnerSettings({ ffufRate: 50 });
    const first = database.db
      .select()
      .from(settings)
      .where(eq(settings.scope, "runner"))
      .get()?.updatedAt;
    repository.updateRunnerSettings({ ffufRate: 60 });
    const second = database.db
      .select()
      .from(settings)
      .where(eq(settings.scope, "runner"))
      .get()?.updatedAt;

    expect(first).toBe("2026-08-12T12:00:00.000Z");
    expect(second).toBe("2026-08-12T12:01:00.000Z");
  });
});

describe("advisor settings persistence", () => {
  it("applies all migrations including the advisor scope widening", () => {
    const { database } = createFixture();

    expect(
      database.sqlite
        .prepare("select count(*) as count from __drizzle_migrations")
        .get(),
    ).toEqual({ count: DATABASE_SCHEMA_VERSION });
  });

  it("serves shipped defaults when the row is absent", () => {
    const { repository } = createFixture();

    expect(repository.getAdvisorSettings()).toEqual({
      ok: true,
      value: {
        endpointBaseUrl: "",
        modelId: "",
        apiKeyEnvVar: "",
        requestBudget: 10,
        rawResponseVisibility: true,
        publicEndpointOptIn: false,
      },
    });
  });

  it("persists a partial update and merges it over the previous values", () => {
    const { repository } = createFixture();

    const updated = repository.updateAdvisorSettings({
      endpointBaseUrl: "http://127.0.0.1:11434/v1",
      modelId: "qwen3:8b",
    });
    expect(updated).toEqual({
      ok: true,
      value: {
        endpointBaseUrl: "http://127.0.0.1:11434/v1",
        modelId: "qwen3:8b",
        apiKeyEnvVar: "",
        requestBudget: 10,
        rawResponseVisibility: true,
        publicEndpointOptIn: false,
      },
    });
    expect(repository.getAdvisorSettings()).toEqual(updated);
  });

  it("rejects key material, bad env names, bad URLs, and unknown keys without storing", () => {
    const { repository, database } = createFixture();

    expect(repository.updateAdvisorSettings({ modelId: "sk-abc123" })).toEqual({
      ok: false,
      error: { code: "invalid_repository_input" },
    });
    expect(
      repository.updateAdvisorSettings({ modelId: "Bearer eyJhbGciOiJIUzI1NiJ9" }),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
    expect(
      repository.updateAdvisorSettings({
        endpointBaseUrl: "https://example.invalid/sk-abc123",
      }),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
    expect(
      repository.updateAdvisorSettings({ endpointBaseUrl: "gopher://example.invalid" }),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
    expect(repository.updateAdvisorSettings({ apiKeyEnvVar: "bad-name" })).toEqual({
      ok: false,
      error: { code: "invalid_repository_input" },
    });
    expect(repository.updateAdvisorSettings({ requestBudget: 101 })).toEqual({
      ok: false,
      error: { code: "invalid_repository_input" },
    });
    expect(repository.updateAdvisorSettings({ unknownKey: true })).toEqual({
      ok: false,
      error: { code: "invalid_repository_input" },
    });

    expect(
      database.db.select().from(settings).where(eq(settings.scope, "advisor")).get(),
    ).toBeUndefined();
  });

  it("accepts a public URL without opt-in at storage", () => {
    const { repository } = createFixture();

    const updated = repository.updateAdvisorSettings({
      endpointBaseUrl: "https://api.example-provider.invalid/v1",
    });
    expect(updated.ok).toBe(true);
  });

  it("rejects corrupt persisted rows as invalid_persisted_data", () => {
    const { repository, database } = createFixture();

    database.db
      .insert(settings)
      .values({
        scope: "advisor",
        valueJson: JSON.stringify({ requestBudget: "many" }),
        updatedAt: new Date(Date.UTC(2026, 7, 12, 12, 0)).toISOString(),
      })
      .run();

    expect(repository.getAdvisorSettings()).toEqual({
      ok: false,
      error: { code: "invalid_persisted_data" },
    });
  });

  it("keeps the runner and advisor rows independent", () => {
    const { repository } = createFixture();

    repository.updateRunnerSettings({ ffufRate: 50 });
    repository.updateAdvisorSettings({ requestBudget: 5 });

    expect(repository.getRunnerSettings()).toEqual({
      ok: true,
      value: {
        ffufBinaryPath: "/usr/bin/ffuf",
        ffufWordlistPath: "",
        ffufRate: 50,
        ffufThreads: 40,
        ffufTimeoutSeconds: 10,
        ffufMaxTimeSeconds: 120,
      },
    });
    expect(repository.getAdvisorSettings()).toEqual({
      ok: true,
      value: {
        endpointBaseUrl: "",
        modelId: "",
        apiKeyEnvVar: "",
        requestBudget: 5,
        rawResponseVisibility: true,
        publicEndpointOptIn: false,
      },
    });
  });
});
