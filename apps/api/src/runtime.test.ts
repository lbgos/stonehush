import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DATABASE_FILENAME,
  openEngagementDatabase,
  type EngagementDatabase,
} from "@stonehush/db";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildStorageBackedApp } from "./runtime.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

async function temporaryDataDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-runtime-test-"));
  temporaryRoots.push(root);
  const dataDirectory = path.join(root, "data");
  return dataDirectory;
}

describe("storage-backed API runtime", () => {
  it("bootstraps storage and migrations before returning the app", async () => {
    const dataDirectory = await temporaryDataDirectory();
    const app = await buildStorageBackedApp(dataDirectory);

    expect((await stat(dataDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(dataDirectory, DATABASE_FILENAME))).mode & 0o777).toBe(
      0o600,
    );
    expect(
      await app.inject({ method: "GET", url: "/api/v1/engagements" }),
    ).toMatchObject({ statusCode: 200, body: "[]" });
    const createRequest = {
      method: "POST" as const,
      url: "/api/v1/engagements",
      headers: { "idempotency-key": "fixture-runtime-idempotency-key" },
      payload: {
        name: "Runtime lab",
        kind: "lab",
        autoContinueWarnings: false,
      },
    };
    const created = await app.inject(createRequest);
    expect(created.statusCode).toBe(201);
    await app.close();

    const restarted = await buildStorageBackedApp(dataDirectory);
    expect(
      await restarted.inject({ method: "GET", url: "/api/v1/engagements" }),
    ).toMatchObject({ statusCode: 200 });
    expect((await restarted.inject(createRequest)).body).toBe(created.body);
    await restarted.close();
  });

  it("closes the migrated database exactly once with repeated app close", async () => {
    const dataDirectory = await temporaryDataDirectory();
    await chmod(path.dirname(dataDirectory), 0o700);
    let closeCount = 0;
    const app = await buildStorageBackedApp(dataDirectory, {
      openDatabase(options): EngagementDatabase {
        const database = openEngagementDatabase(options);
        return {
          ...database,
          close() {
            closeCount += 1;
            database.close();
          },
        };
      },
    });

    await app.close();
    await app.close();
    expect(closeCount).toBe(1);
  });

  it("does not open the database when storage bootstrap fails", async () => {
    const dataDirectory = await temporaryDataDirectory();
    const openDatabase = vi.fn(openEngagementDatabase);

    await expect(
      buildStorageBackedApp(dataDirectory, {
        bootstrapStorage: async () => {
          throw new Error("private storage path");
        },
        openDatabase,
      }),
    ).rejects.toThrow("private storage path");
    expect(openDatabase).not.toHaveBeenCalled();
  });

  it("closes an opened database if app construction fails", async () => {
    const dataDirectory = await temporaryDataDirectory();
    let closeCount = 0;
    await expect(
      buildStorageBackedApp(dataDirectory, {
        createApp() {
          throw new Error("synthetic app construction failure");
        },
        openDatabase(options): EngagementDatabase {
          const database = openEngagementDatabase(options);
          return {
            ...database,
            close() {
              closeCount += 1;
              database.close();
            },
          };
        },
      }),
    ).rejects.toThrow();
    expect(closeCount).toBe(1);
  });
});
