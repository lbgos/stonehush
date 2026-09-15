import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DATABASE_FILENAME, openEngagementDatabase, openReadOnlyEngagementDatabase } from "./database.js";

const directories: string[] = [];

function createFixture(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "stonehush-db-readonly-"));
  chmodSync(directory, 0o700);
  directories.push(directory);
  return directory;
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory === undefined) continue;
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("openReadOnlyEngagementDatabase", () => {
  it("reads a migrated database without writing, migrating, or chmodding", () => {
    const directory = createFixture();
    const writer = openEngagementDatabase({ dataDirectory: directory });
    try {
      writer.sqlite.exec("create table probe (value integer not null)");
      writer.sqlite.exec("insert into probe values (1)");
    } finally {
      writer.close();
    }

    // Leave the file group/other readable to prove no silent chmod occurs.
    const databasePath = path.join(directory, DATABASE_FILENAME);
    chmodSync(databasePath, 0o644);
    const beforeBytes = readFileSync(databasePath);

    const reader = openReadOnlyEngagementDatabase(directory);
    try {
      expect(reader.prepare("select value from probe").get()).toEqual({ value: 1 });
      const tables = reader
        .prepare("select name from sqlite_master where type = 'table' order by name")
        .all() as { name: string }[];
      expect(tables.map((row) => row.name)).toContain("evidence_artifacts");
      expect(statSync(databasePath).mode & 0o777).toBe(0o644);
      expect(readFileSync(databasePath).equals(beforeBytes)).toBe(true);
    } finally {
      reader.close();
    }
    // A clean read-only close leaves the file byte-for-byte identical.
    expect(readFileSync(databasePath).equals(beforeBytes)).toBe(true);
  });

  it("rejects writes and schema changes on the connection", () => {
    const directory = createFixture();
    const writer = openEngagementDatabase({ dataDirectory: directory });
    writer.close();

    const reader = openReadOnlyEngagementDatabase(directory);
    try {
      expect(() => reader.exec("create table tamper (value text)")).toThrow(/readonly/i);
    } finally {
      reader.close();
    }
  });

  it("fails without creating a file when the database is missing", () => {
    const directory = createFixture();
    expect(() => openReadOnlyEngagementDatabase(directory)).toThrow();
    expect(existsSync(path.join(directory, DATABASE_FILENAME))).toBe(false);
  });
});
