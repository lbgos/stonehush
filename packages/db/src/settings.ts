import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import {
  ADVISOR_SETTINGS_DEFAULTS,
  RUNNER_SETTINGS_DEFAULTS,
  AdvisorSettingsSchema,
  RunnerSettingsSchema,
  UpdateAdvisorSettingsRequestSchema,
  UpdateSettingsRequestSchema,
  type AdvisorSettings,
  type RunnerSettings,
} from "@stonehush/contracts";
import * as schema from "./schema.js";
import { settings } from "./schema.js";

type Database = BetterSQLite3Database<typeof schema>;

export type SettingsRepositoryErrorCode =
  | "invalid_repository_input"
  | "storage_busy"
  | "invalid_persisted_data";

export type SettingsRepositoryError = { code: SettingsRepositoryErrorCode };

export type SettingsResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: SettingsRepositoryError };

export interface SettingsRepositoryProviders {
  now?: () => Date;
}

function storageError(error: unknown): SettingsRepositoryError {
  const code = (error as { code?: string })?.code;
  if (code === "SQLITE_BUSY" || code === "SQLITE_BUSY_TIMEOUT") {
    return { code: "storage_busy" };
  }
  return { code: "invalid_persisted_data" };
}

function parseStoredValue(raw: string): RunnerSettings | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const validated = RunnerSettingsSchema.safeParse(parsed);
  return validated.success ? validated.data : undefined;
}

function parseStoredAdvisorValue(raw: string): AdvisorSettings | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const validated = AdvisorSettingsSchema.safeParse(parsed);
  return validated.success ? validated.data : undefined;
}

// Control-plane store for validated runner and advisor settings. Each scope
// has its own row, absent on a fresh database; readers then serve the shipped
// defaults without writing.
export class SettingsRepository {
  constructor(
    private readonly db: Database,
    private readonly providers: SettingsRepositoryProviders = {},
  ) {}

  private now(): Date {
    return this.providers.now?.() ?? new Date();
  }

  getRunnerSettings(): SettingsResult<RunnerSettings> {
    try {
      const row = this.db
        .select()
        .from(settings)
        .where(eq(settings.scope, "runner"))
        .get();
      if (row === undefined) {
        return { ok: true, value: { ...RUNNER_SETTINGS_DEFAULTS } };
      }
      const value = parseStoredValue(row.valueJson);
      if (value === undefined) {
        return { ok: false, error: { code: "invalid_persisted_data" } };
      }
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: storageError(error) };
    }
  }

  updateRunnerSettings(input: unknown): SettingsResult<RunnerSettings> {
    const parsed = UpdateSettingsRequestSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: { code: "invalid_repository_input" } };
    }
    const current = this.getRunnerSettings();
    if (!current.ok) return current;
    const merged = RunnerSettingsSchema.safeParse({
      ...current.value,
      ...parsed.data,
    });
    if (!merged.success) {
      return { ok: false, error: { code: "invalid_repository_input" } };
    }
    try {
      const updatedAt = this.now().toISOString();
      this.db
        .insert(settings)
        .values({
          scope: "runner",
          valueJson: JSON.stringify(merged.data),
          updatedAt,
        })
        .onConflictDoUpdate({
          target: settings.scope,
          set: { valueJson: JSON.stringify(merged.data), updatedAt },
        })
        .run();
      return { ok: true, value: merged.data };
    } catch (error) {
      return { ok: false, error: storageError(error) };
    }
  }

  getAdvisorSettings(): SettingsResult<AdvisorSettings> {
    try {
      const row = this.db
        .select()
        .from(settings)
        .where(eq(settings.scope, "advisor"))
        .get();
      if (row === undefined) {
        return { ok: true, value: { ...ADVISOR_SETTINGS_DEFAULTS } };
      }
      const value = parseStoredAdvisorValue(row.valueJson);
      if (value === undefined) {
        return { ok: false, error: { code: "invalid_persisted_data" } };
      }
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: storageError(error) };
    }
  }

  updateAdvisorSettings(input: unknown): SettingsResult<AdvisorSettings> {
    const parsed = UpdateAdvisorSettingsRequestSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: { code: "invalid_repository_input" } };
    }
    const current = this.getAdvisorSettings();
    if (!current.ok) return current;
    const merged = AdvisorSettingsSchema.safeParse({
      ...current.value,
      ...parsed.data,
    });
    if (!merged.success) {
      return { ok: false, error: { code: "invalid_repository_input" } };
    }
    try {
      const updatedAt = this.now().toISOString();
      this.db
        .insert(settings)
        .values({
          scope: "advisor",
          valueJson: JSON.stringify(merged.data),
          updatedAt,
        })
        .onConflictDoUpdate({
          target: settings.scope,
          set: { valueJson: JSON.stringify(merged.data), updatedAt },
        })
        .run();
      return { ok: true, value: merged.data };
    } catch (error) {
      return { ok: false, error: storageError(error) };
    }
  }
}
