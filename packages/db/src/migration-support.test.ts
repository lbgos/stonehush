import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { DATABASE_FILENAME, openEngagementDatabase } from "./database.js";

it("reopens the current migration baseline and refuses a newer schema without clobbering it", () => {
  const dataDirectory = mkdtempSync(path.join(tmpdir(), "stonehush-migration-support-"));
  try {
    openEngagementDatabase({ dataDirectory }).close();
    openEngagementDatabase({ dataDirectory }).close();
    const filename = path.join(dataDirectory, DATABASE_FILENAME);
    const sqlite = new Database(filename);
    try {
      sqlite.exec("insert into __drizzle_migrations (hash, created_at) select 'synthetic-future', max(created_at) + 1 from __drizzle_migrations");
    } finally {
      sqlite.close();
    }
    const before = readFileSync(filename);
    expect(() => openEngagementDatabase({ dataDirectory })).toThrow("Database schema is newer than this build supports.");
    expect(readFileSync(filename)).toEqual(before);
  } finally {
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});
