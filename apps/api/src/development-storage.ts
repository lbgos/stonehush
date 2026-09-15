import { constants } from "node:fs";
import { lstat, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type DevelopmentStorageFailure =
  | "initialize"
  | "not_directory"
  | "owner"
  | "permissions"
  | "symlink"
  | "write_probe";

const failureMessages: Record<DevelopmentStorageFailure, string> = {
  initialize: "Development storage could not be initialized.",
  not_directory: "Development storage must be a directory.",
  owner: "Development storage must be owned by the current user.",
  permissions: "Development storage must not allow group or other access.",
  symlink: "Development storage must not be a symbolic link.",
  write_probe: "Development storage is not writable.",
};

export class DevelopmentStorageError extends Error {
  readonly failure: DevelopmentStorageFailure;

  constructor(failure: DevelopmentStorageFailure) {
    super(failureMessages[failure]);
    this.name = "DevelopmentStorageError";
    this.failure = failure;
  }
}

interface StorageFileSystem {
  lstat: typeof lstat;
  mkdir: typeof mkdir;
  open: typeof open;
  unlink: typeof unlink;
}

interface DevelopmentStorageDependencies {
  fileSystem?: Partial<StorageFileSystem>;
  getCurrentUid?: () => number | undefined;
  probeName?: () => string;
}

const storageFileSystem: StorageFileSystem = { lstat, mkdir, open, unlink };

interface ResolvedDevelopmentStorageDependencies {
  fileSystem: StorageFileSystem;
  getCurrentUid: () => number | undefined;
  probeName: () => string;
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

async function removeProbe(
  fileSystem: StorageFileSystem,
  probePath: string,
  handle: FileHandle | undefined,
  created: boolean,
): Promise<void> {
  try {
    await handle?.close();
  } catch {
    // A failed close still requires the best-effort unlink below.
  }
  if (!created) return;
  try {
    await fileSystem.unlink(probePath);
  } catch {
    // The caller reports one safe write-probe failure.
  }
}

function resolveDependencies(
  dependencies: DevelopmentStorageDependencies,
): ResolvedDevelopmentStorageDependencies {
  return {
    fileSystem: { ...storageFileSystem, ...dependencies.fileSystem },
    getCurrentUid: dependencies.getCurrentUid ?? currentUid,
    probeName: dependencies.probeName ?? randomUUID,
  };
}

async function validateDevelopmentStorage(
  dataDirectory: string,
  { fileSystem, getCurrentUid, probeName }: ResolvedDevelopmentStorageDependencies,
): Promise<void> {
  let stats;
  try {
    stats = await fileSystem.lstat(dataDirectory);
  } catch {
    throw new DevelopmentStorageError("initialize");
  }

  if (stats.isSymbolicLink()) throw new DevelopmentStorageError("symlink");
  if (!stats.isDirectory()) throw new DevelopmentStorageError("not_directory");
  const uid = getCurrentUid();
  if (uid !== undefined && stats.uid !== uid) throw new DevelopmentStorageError("owner");
  if ((stats.mode & 0o077) !== 0) throw new DevelopmentStorageError("permissions");

  const probePath = path.join(dataDirectory, `.stonehush-write-probe-${probeName()}`);
  let handle: FileHandle | undefined;
  let created = false;
  try {
    handle = await fileSystem.open(
      probePath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_WRONLY,
      0o600,
    );
    created = true;
    const probeStats = await handle.stat();
    if (!probeStats.isFile() || (probeStats.mode & 0o777) !== 0o600) {
      throw new DevelopmentStorageError("write_probe");
    }
    await handle.close();
    handle = undefined;
    await fileSystem.unlink(probePath);
    created = false;
  } catch {
    await removeProbe(fileSystem, probePath, handle, created);
    throw new DevelopmentStorageError("write_probe");
  }
}

export async function checkDevelopmentStorage(
  dataDirectory: string,
  dependencies: DevelopmentStorageDependencies = {},
): Promise<void> {
  await validateDevelopmentStorage(dataDirectory, resolveDependencies(dependencies));
}

export async function bootstrapDevelopmentStorage(
  dataDirectory: string,
  dependencies: DevelopmentStorageDependencies = {},
): Promise<void> {
  const resolvedDependencies = resolveDependencies(dependencies);

  try {
    await resolvedDependencies.fileSystem.mkdir(dataDirectory, { mode: 0o700, recursive: true });
  } catch {
    // lstat below differentiates an existing invalid target from initialization failure.
  }
  await validateDevelopmentStorage(dataDirectory, resolvedDependencies);
}
