import { chmodSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import * as schema from "./schema.js";

export const DATABASE_FILENAME = "stonehush.sqlite3";

// The logical schema version recorded in backup manifests. It is derived
// from the migration journal so a new append-only migration bumps it without
// a hand-maintained constant drifting out of sync.
export const DATABASE_SCHEMA_VERSION: number = readMigrationEntryCount();

function assertSupportedMigration(sqlite: Database.Database, migrationsFolder: string): void {
  const table = sqlite.prepare("select name from sqlite_master where type = 'table' and name = '__drizzle_migrations'").get();
  if (table === undefined) return;
  const latest = sqlite.prepare("select created_at from __drizzle_migrations order by created_at desc limit 1").get() as
    { created_at: unknown } | undefined;
  if (latest === undefined) return;
  const journal = JSON.parse(readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8")) as {
    entries: { when: number }[];
  };
  const supported = journal.entries.at(-1)?.when;
  if (typeof latest.created_at !== "number" || typeof supported !== "number" || latest.created_at > supported) {
    throw new Error("Database schema is newer than this build supports.");
  }
}

function readMigrationEntryCount(): number {
  const journalPath = fileURLToPath(new URL("../drizzle/meta/_journal.json", import.meta.url));
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries?: unknown[];
  };
  const count = journal.entries?.length;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    throw new Error("migration journal is unreadable; refusing to guess the schema version.");
  }
  return count;
}

export interface EngagementDatabase {
  sqlite: Database.Database;
  db: BetterSQLite3Database<typeof schema>;
  close: () => void;
}

export interface OpenDatabaseOptions {
  dataDirectory: string;
  migrationsFolder?: string;
}

function pragmaValue(
  sqlite: Database.Database,
  name: string,
): unknown {
  const row = sqlite.pragma(name, { simple: true });
  return row;
}

function configureAndAssertPragmas(sqlite: Database.Database): void {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("recursive_triggers = ON");
  sqlite.pragma("synchronous = FULL");
  sqlite.pragma("busy_timeout = 5000");

  if (
    pragmaValue(sqlite, "journal_mode") !== "wal" ||
    pragmaValue(sqlite, "foreign_keys") !== 1 ||
    pragmaValue(sqlite, "recursive_triggers") !== 1 ||
    pragmaValue(sqlite, "synchronous") !== 2 ||
    pragmaValue(sqlite, "busy_timeout") !== 5_000
  ) {
    throw new Error("SQLite connection safety configuration failed.");
  }
}

function defaultMigrationsFolder(): string {
  return fileURLToPath(new URL("../drizzle/", import.meta.url));
}

export function openEngagementDatabase({
  dataDirectory,
  migrationsFolder = defaultMigrationsFolder(),
}: OpenDatabaseOptions): EngagementDatabase {
  const databasePath = path.join(dataDirectory, DATABASE_FILENAME);
  const sqlite = new Database(databasePath);
  try {
    // Refuse an unsupported future schema before applying migrations or
    // changing persisted connection settings. Recovery uses the matching build.
    assertSupportedMigration(sqlite, migrationsFolder);
    chmodSync(databasePath, 0o600);
    configureAndAssertPragmas(sqlite);
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder });
    return { sqlite, db, close: () => sqlite.close() };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

// Read-only connection for the ADR-0003 doctor evidence check. It never
// migrates, chmods, writes, or creates: a missing database file fails instead
// of materializing an empty one. No pragma is persisted to the file.
export function openReadOnlyEngagementDatabase(dataDirectory: string): Database.Database {
  const databasePath = path.join(dataDirectory, DATABASE_FILENAME);
  return new Database(databasePath, { readonly: true, fileMustExist: true });
}

// Read-only connection to one explicit SQLite file, used by the backup
// restore path to verify the frozen snapshot database. Same no-write,
// no-create guarantees as the doctor connection.
export function openReadOnlySqliteFile(databasePath: string): Database.Database {
  return new Database(databasePath, { readonly: true, fileMustExist: true });
}
