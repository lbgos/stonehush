import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bootstrapDevelopmentStorage,
  checkDevelopmentStorage,
  DevelopmentStorageError,
} from "./development-storage.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-storage-test-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  vi.restoreAllMocks();
});

describe("bootstrapDevelopmentStorage", () => {
  it("creates missing storage with mode 0700 and removes its mode 0600 probe", async () => {
    const root = await temporaryRoot();
    const dataDirectory = path.join(root, "nested", "development");
    const probePath = path.join(dataDirectory, ".stonehush-write-probe-fixed");
    let observedProbeMode: number | undefined;
    let observedProbeFlags: number | undefined;

    await bootstrapDevelopmentStorage(dataDirectory, {
      fileSystem: {
        async open(file, flags, mode) {
          observedProbeFlags = Number(flags);
          const handle = await open(file, flags, mode);
          observedProbeMode = (await handle.stat()).mode & 0o777;
          return handle;
        },
      },
      probeName: () => "fixed",
    });

    expect((await lstat(dataDirectory)).mode & 0o777).toBe(0o700);
    expect(observedProbeMode).toBe(0o600);
    expect(observedProbeFlags! & constants.O_EXCL).toBe(constants.O_EXCL);
    expect(observedProbeFlags! & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    await expect(readFile(probePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not replace or delete an existing probe path", async () => {
    const root = await temporaryRoot();
    const dataDirectory = path.join(root, "development");
    const probePath = path.join(dataDirectory, ".stonehush-write-probe-collision");
    await mkdir(dataDirectory, { mode: 0o700 });
    await writeFile(probePath, "existing", { mode: 0o600 });

    await expect(
      bootstrapDevelopmentStorage(dataDirectory, { probeName: () => "collision" }),
    ).rejects.toMatchObject({ failure: "write_probe" });
    await expect(readFile(probePath, "utf8")).resolves.toBe("existing");
  });

  it("uses unique probes safely across concurrent live checks", async () => {
    const root = await temporaryRoot();
    const dataDirectory = path.join(root, "development");
    await bootstrapDevelopmentStorage(dataDirectory);

    await Promise.all(
      Array.from({ length: 12 }, async () => checkDevelopmentStorage(dataDirectory)),
    );

    await expect(readdir(dataDirectory)).resolves.toEqual([]);
  });

  it("rejects a symbolic-link data directory without following it", async () => {
    const root = await temporaryRoot();
    const target = path.join(root, "target");
    const dataDirectory = path.join(root, "development");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, dataDirectory);

    await expect(bootstrapDevelopmentStorage(dataDirectory)).rejects.toMatchObject({
      failure: "symlink",
      message: "Development storage must not be a symbolic link.",
    });
  });

  it("rejects a non-directory target", async () => {
    const root = await temporaryRoot();
    const dataDirectory = path.join(root, "development");
    await writeFile(dataDirectory, "not a directory", { mode: 0o600 });

    await expect(bootstrapDevelopmentStorage(dataDirectory)).rejects.toMatchObject({
      failure: "not_directory",
    });
  });

  it("rejects storage owned by a different uid when uid checks are available", async () => {
    const root = await temporaryRoot();
    const dataDirectory = path.join(root, "development");
    await mkdir(dataDirectory, { mode: 0o700 });
    const actualUid = (await lstat(dataDirectory)).uid;

    await expect(
      bootstrapDevelopmentStorage(dataDirectory, { getCurrentUid: () => actualUid + 1 }),
    ).rejects.toMatchObject({ failure: "owner" });
  });

  it("rejects group or other permission bits without changing them", async () => {
    const root = await temporaryRoot();
    const dataDirectory = path.join(root, "development");
    await mkdir(dataDirectory, { mode: 0o750 });

    await expect(bootstrapDevelopmentStorage(dataDirectory)).rejects.toMatchObject({
      failure: "permissions",
    });
    expect((await lstat(dataDirectory)).mode & 0o777).toBe(0o750);
  });

  it("reports write-probe failures without exposing paths or raw errors", async () => {
    const root = await temporaryRoot();
    const dataDirectory = path.join(root, "development-secret-path");
    await mkdir(dataDirectory, { mode: 0o700 });

    const operation = bootstrapDevelopmentStorage(dataDirectory, {
      fileSystem: {
        open: vi.fn(async () => {
          throw new Error(`EACCES at ${dataDirectory}`);
        }),
      },
    });

    await expect(operation).rejects.toEqual(new DevelopmentStorageError("write_probe"));
    await expect(operation).rejects.not.toHaveProperty("cause");
    await expect(operation).rejects.not.toHaveProperty("message", expect.stringContaining(root));
  });
});
