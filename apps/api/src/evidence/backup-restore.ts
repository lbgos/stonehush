import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  read as cbRead,
  readSync,
  unlinkSync,
  write as cbWrite,
  writeSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import {
  BACKUP_INCOMPLETE_MARKER_FILENAME,
  BACKUP_MANIFEST_FILENAME,
  BACKUP_PROTOCOL,
  BackupManifestSchema,
  OPAQUE_EVIDENCE_ID_PATTERN,
  type BackupArtifactEntry,
  type BackupManifest,
} from "@stonehush/contracts";
import {
  DATABASE_FILENAME,
  DATABASE_SCHEMA_VERSION,
  openReadOnlyEngagementDatabase,
  openReadOnlySqliteFile,
} from "@stonehush/db";
import {
  loadEvidenceNative,
  O_CLOEXEC,
  type EvidenceNativeBinding,
} from "@stonehush/evidence-native";

import { BackupLock } from "./backup-lock.js";

// ADR-0003 `stonehush-backup-v1` snapshot and restore. Backup refuses a
// nonempty destination before writing anything, takes the exclusive quiesce
// lock around the whole snapshot, copies SQLite with the better-sqlite3
// backup API plus every published artifact through descriptor-relative
// no-follow opens (never hardlinked), verifies size and digest during and
// after every copy, and only then finalizes the manifest and removes the
// INCOMPLETE marker. Restore verifies the entire backup before its first
// destination write, copies exclusively with the same defenses, verifies
// again, and removes its marker only after fsync. Staging is excluded from
// both directions by construction. Errors carry typed codes only, never
// filesystem paths.

const READ_FLAGS =
  fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | O_CLOEXEC;
const DIRECTORY_FLAGS =
  fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | O_CLOEXEC;
const CREATE_FILE_FLAGS =
  fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
  fsConstants.O_NOFOLLOW | O_CLOEXEC;

const fdRead = promisify(cbRead) as (
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number | null,
) => Promise<{ bytesRead: number }>;
const fdWrite = promisify(cbWrite) as (
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number | null,
) => Promise<{ bytesWritten: number }>;

const ERRNO = {
  ENOENT: 2,
} as const;

const SQLITE_DIRNAME = "sqlite";
const EVIDENCE_DIRNAME = "evidence";
const PUBLISHED_DIRNAME = "published";
const STAGING_DIRNAME = "staging";
const MANIFEST_MAX_BYTES = 1024 * 1024;
const COPY_CHUNK_BYTES = 1024 * 1024;

export type BackupErrorCode =
  | "backup_destination_not_empty"
  | "backup_destination_invalid"
  | "backup_source_unavailable"
  | "storage_busy"
  | "evidence_io_error";

export type RestoreErrorCode =
  | "restore_destination_not_empty"
  | "restore_destination_invalid"
  | "backup_incomplete"
  | "restore_consistency_mismatch"
  | "restore_schema_newer"
  | "evidence_io_error";

export type BackupOutcome =
  | { status: "complete"; protocol: typeof BACKUP_PROTOCOL; artifactCount: number }
  | { status: "error"; code: BackupErrorCode };

export type RestoreOutcome =
  | { status: "complete"; protocol: typeof BACKUP_PROTOCOL; restoredArtifacts: number }
  | { status: "error"; code: RestoreErrorCode };

export interface RunBackupInput {
  readonly dataDirectory: string;
  readonly destinationDirectory: string;
  readonly now?: () => Date;
}

export interface RunRestoreInput {
  readonly backupDirectory: string;
  readonly dataDirectory: string;
}

let cachedBinding: EvidenceNativeBinding | undefined;

function bindingOrThrow(): EvidenceNativeBinding {
  if (cachedBinding === undefined) {
    const native = loadEvidenceNative();
    if (!native.ok) throw new Error("native binding unavailable");
    cachedBinding = native.binding;
  }
  return cachedBinding;
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Best-effort close; nothing actionable remains.
  }
}

function statOf(fd: number): Stats | undefined {
  try {
    return fstatSync(fd);
  } catch {
    return undefined;
  }
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

async function hashDescriptor(fd: number): Promise<{
  sizeBytes: number;
  digest: string;
}> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  for (;;) {
    const read = await fdRead(fd, chunk, 0, chunk.length, sizeBytes);
    if (read.bytesRead === 0) break;
    sizeBytes += read.bytesRead;
    hash.update(chunk.subarray(0, read.bytesRead));
  }
  return { sizeBytes, digest: `sha256:${hash.digest("hex")}` };
}

interface OpenedDirectory {
  readonly fd: number;
  readonly stats: Stats;
}

// Opens an existing directory without following symlinks and proves the
// managed-directory invariants: directory type, control-plane owner, mode
// 0700.
function openValidatedDirectory(
  pathValue: string,
  uid: number,
): OpenedDirectory | undefined {
  let fd: number;
  try {
    fd = openSync(pathValue, DIRECTORY_FLAGS);
  } catch {
    return undefined;
  }
  const stats = statOf(fd);
  if (
    stats === undefined ||
    !stats.isDirectory() ||
    stats.uid !== uid ||
    (stats.mode & 0o777) !== 0o700
  ) {
    closeQuietly(fd);
    return undefined;
  }
  return { fd, stats };
}

// Validates a caller-supplied destination directory before ANY write: it
// must exist, be a real control-plane-owned 0700 directory, and be empty.
function validateEmptyDestination(
  destinationDirectory: string,
  uid: number,
): { ok: true; fd: number; stats: Stats } | { ok: false; code: "invalid" | "not_empty" } {
  const opened = openValidatedDirectory(destinationDirectory, uid);
  if (opened === undefined) return { ok: false, code: "invalid" };
  try {
    const listed = bindingOrThrow().readDirNames(opened.fd);
    if (!listed.ok) {
      closeQuietly(opened.fd);
      return { ok: false, code: "invalid" };
    }
    if (listed.names.length > 0) {
      closeQuietly(opened.fd);
      return { ok: false, code: "not_empty" };
    }
    return { ok: true, fd: opened.fd, stats: opened.stats };
  } catch {
    closeQuietly(opened.fd);
    return { ok: false, code: "invalid" };
  }
}

function directoryChildIsValid(stats: Stats | undefined): stats is Stats {
  return (
    stats !== undefined &&
    stats.isDirectory() &&
    (stats.mode & 0o777) === 0o700
  );
}

// Opens an existing managed child directory relative to a held parent
// descriptor without following symlinks. Never creates anything.
function openExistingChildDirectory(
  parentFd: number,
  name: string,
  uid: number,
): number | undefined {
  const opened = bindingOrThrow().openAt(parentFd, name, DIRECTORY_FLAGS, 0);
  if (!opened.ok) return undefined;
  const stats = statOf(opened.fd);
  if (!directoryChildIsValid(stats) || stats.uid !== uid) {
    closeQuietly(opened.fd);
    return undefined;
  }
  return opened.fd;
}

// Creates a managed child directory relative to a parent descriptor, mode
// 0700, then revalidates it through a fresh no-follow open. The caller
// supplies the expected control-plane uid and the fallback filesystem path
// used only for the mkdir race window; both the existing and the freshly
// reopened descriptors are fully validated for type, owner, and mode.
function createManagedChildDirectory(
  parentFd: number,
  name: string,
  fallbackPath: string,
  uid: number,
): { ok: true; fd: number } | { ok: false } {
  const binding = bindingOrThrow();
  const existing = binding.openAt(parentFd, name, DIRECTORY_FLAGS, 0);
  if (existing.ok) {
    const stats = statOf(existing.fd);
    if (stats !== undefined && directoryChildIsValid(stats) && stats.uid === uid) {
      return existing;
    }
    closeQuietly(existing.fd);
    return { ok: false };
  }
  if (existing.errno !== ERRNO.ENOENT) return { ok: false };
  try {
    mkdirSync(path.join(fallbackPath, name), { mode: 0o700 });
    chmodSync(path.join(fallbackPath, name), 0o700);
  } catch {
    return { ok: false };
  }
  const retried = binding.openAt(parentFd, name, DIRECTORY_FLAGS, 0);
  if (!retried.ok) return { ok: false };
  const retriedStats = statOf(retried.fd);
  if (retriedStats === undefined || !directoryChildIsValid(retriedStats) || retriedStats.uid !== uid) {
    closeQuietly(retried.fd);
    return { ok: false };
  }
  return retried;
}

// Copies one file between two validated descriptors while hashing the
// stream. The destination is created exclusively (never hardlinked, never
// replaced), forced to mode 0600, fsynced, then reopened and re-hashed so
// both during-copy and after-copy verification hold.
async function copyVerifying(input: {
  readonly sourceFd: number;
  readonly destDirFd: number;
  readonly destName: string;
  readonly expectedSizeBytes: number;
  readonly expectedDigest: string;
}): Promise<boolean> {
  const binding = bindingOrThrow();
  const created = binding.openAt(
    input.destDirFd,
    input.destName,
    CREATE_FILE_FLAGS,
    0o600,
  );
  if (!created.ok) return false;
  const fd = created.fd;
  try {
    const freshStats = statOf(fd);
    if (
      freshStats === undefined ||
      !freshStats.isFile() ||
      freshStats.nlink !== 1 ||
      freshStats.size !== 0
    ) {
      return false;
    }
    fchmodSync(fd, 0o600);

    const hash = createHash("sha256");
    let written = 0;
    const chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    for (;;) {
      const read = await fdRead(input.sourceFd, chunk, 0, chunk.length, written);
      if (read.bytesRead === 0) break;
      // The async fs.write may perform a short write; loop until the whole
      // chunk is durable, rejecting zero or negative progress to avoid an
      // infinite loop and to surface truncation.
      let chunkOffset = 0;
      while (chunkOffset < read.bytesRead) {
        const advance = await fdWrite(
          fd,
          chunk,
          chunkOffset,
          read.bytesRead - chunkOffset,
          written + chunkOffset,
        );
        if (advance.bytesWritten <= 0) return false;
        chunkOffset += advance.bytesWritten;
      }
      hash.update(chunk.subarray(0, read.bytesRead));
      written += read.bytesRead;
    }
    if (written !== input.expectedSizeBytes) return false;
    if (`sha256:${hash.digest("hex")}` !== input.expectedDigest) return false;

    fsyncSync(fd);
  } catch {
    return false;
  } finally {
    closeQuietly(fd);
  }

  // After-copy verification: reopen the durable name through the directory
  // descriptor and re-check identity, size, and digest.
  const reopened = binding.openAt(input.destDirFd, input.destName, READ_FLAGS, 0);
  if (!reopened.ok) return false;
  try {
    const stats = statOf(reopened.fd);
    if (
      stats === undefined ||
      !stats.isFile() ||
      stats.nlink !== 1 ||
      stats.size !== input.expectedSizeBytes ||
      (stats.mode & 0o777) !== 0o600
    ) {
      return false;
    }
    const hashed = await hashDescriptor(reopened.fd);
    return hashed.digest === input.expectedDigest;
  } catch {
    return false;
  } finally {
    closeQuietly(reopened.fd);
  }
}

function fsyncDirectoryFd(fd: number | undefined): void {
  if (fd !== undefined) fsyncSync(fd);
}

// Creates the INCOMPLETE marker exclusively through the destination
// descriptor. An interruption anywhere later leaves it behind on purpose.
function createIncompleteMarker(destFd: number): boolean {
  const created = bindingOrThrow().openAt(
    destFd,
    BACKUP_INCOMPLETE_MARKER_FILENAME,
    CREATE_FILE_FLAGS,
    0o600,
  );
  if (!created.ok) return false;
  try {
    fsyncSync(created.fd);
    return true;
  } finally {
    closeQuietly(created.fd);
  }
}

function serializeManifest(manifest: BackupManifest): Buffer {
  // Fixed key insertion order keeps the serialization deterministic.
  return Buffer.from(
    `${JSON.stringify({
      protocol: manifest.protocol,
      state: manifest.state,
      startedAt: manifest.startedAt,
      ...(manifest.completedAt === undefined ? {} : { completedAt: manifest.completedAt }),
      schemaVersion: manifest.schemaVersion,
      sqliteDigest: manifest.sqliteDigest,
      artifacts: manifest.artifacts.map((entry) => ({
        artifactId: entry.artifactId,
        sizeBytes: entry.sizeBytes,
        digest: entry.digest,
      })),
      artifactCount: manifest.artifactCount,
    })}\n`,
    "utf8",
  );
}

function writeManifestFile(destFd: number, manifest: BackupManifest): boolean {
  const created = bindingOrThrow().openAt(
    destFd,
    BACKUP_MANIFEST_FILENAME,
    CREATE_FILE_FLAGS,
    0o600,
  );
  if (!created.ok) return false;
  const fd = created.fd;
  try {
    fchmodSync(fd, 0o600);
    if (!writeAllSync(fd, serializeManifest(manifest))) return false;
    fsyncSync(fd);
    return true;
  } catch {
    return false;
  } finally {
    closeQuietly(fd);
  }
}

// Replaces the started manifest content with the finalized one. The file
// already exists and is owned by this process, so a truncated in-place write
// followed by fsync is safe here.
function finalizeManifestFile(destinationDirectory: string, manifest: BackupManifest): boolean {
  let fd: number;
  try {
    fd = openSync(
      path.join(destinationDirectory, BACKUP_MANIFEST_FILENAME),
      fsConstants.O_WRONLY | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW | O_CLOEXEC,
    );
  } catch {
    return false;
  }
  try {
    if (!writeAllSync(fd, serializeManifest(manifest))) return false;
    fsyncSync(fd);
    return true;
  } catch {
    return false;
  } finally {
    closeQuietly(fd);
  }
}

function writeAllSync(
  fd: number,
  buffer: Buffer,
): boolean {
  let written = 0;
  while (written < buffer.length) {
    try {
      const count = writeSync(fd, buffer, written, buffer.length - written);
      if (count <= 0) return false;
      written += count;
    } catch {
      return false;
    }
  }
  return true;
}

function readBoundedSync(fd: number, maxBytes: number): Buffer | undefined {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let count: number;
    try {
      count = readSync(fd, chunk, 0, chunk.length, total);
    } catch {
      return undefined;
    }
    if (count === 0) break;
    total += count;
    if (total > maxBytes) return undefined;
    chunks.push(chunk.subarray(0, count));
  }
  return Buffer.concat(chunks);
}

// Reads and strictly parses the backup manifest through a directory
// descriptor. Anything malformed, oversized, or non-strict is rejected.
function readManifestAt(dirFd: number): BackupManifest | undefined {
  const opened = bindingOrThrow().openAt(dirFd, BACKUP_MANIFEST_FILENAME, READ_FLAGS, 0);
  if (!opened.ok) return undefined;
  const fd = opened.fd;
  try {
    const bytes = readBoundedSync(fd, MANIFEST_MAX_BYTES);
    if (bytes === undefined) return undefined;
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    const validated = BackupManifestSchema.safeParse(parsed);
    return validated.success ? validated.data : undefined;
  } catch {
    return undefined;
  } finally {
    closeQuietly(fd);
  }
}

interface ArtifactRow {
  readonly artifactId: string;
  readonly sizeBytes: number;
  readonly digest: string;
  readonly relativePath: string;
}

// Queries artifact metadata from the frozen snapshot database so the
// manifest membership matches exactly what was copied.
function readArtifactRowsFromSnapshot(databasePath: string): ArtifactRow[] | undefined {
  let sqlite;
  try {
    sqlite = openReadOnlySqliteFile(databasePath);
  } catch {
    return undefined;
  }
  try {
    const rows = sqlite
      .prepare(
        "select artifact_id as artifactId, size_bytes as sizeBytes, digest as digest, relative_path as relativePath from evidence_artifacts order by artifact_id",
      )
      .all() as ArtifactRow[];
    return rows;
  } catch {
    return undefined;
  } finally {
    sqlite.close();
  }
}

function readSnapshotSchemaVersion(databasePath: string): number | undefined {
  let sqlite;
  try {
    sqlite = openReadOnlySqliteFile(databasePath);
  } catch {
    return undefined;
  }
  try {
    const row = sqlite
      .prepare("select count(*) as count from __drizzle_migrations")
      .get() as { count: number } | undefined;
    if (row === undefined || typeof row.count !== "number" || !Number.isSafeInteger(row.count) || row.count < 0) {
      return undefined;
    }
    return row.count;
  } catch {
    return undefined;
  } finally {
    sqlite.close();
  }
}

function snapshotArtifactsMatchManifest(
  rows: ArtifactRow[],
  artifacts: readonly BackupArtifactEntry[],
): boolean {
  if (rows.length !== artifacts.length) return false;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] as ArtifactRow;
    const entry = artifacts[index] as BackupArtifactEntry;
    if (
      row.artifactId !== entry.artifactId ||
      row.sizeBytes !== entry.sizeBytes ||
      row.digest !== entry.digest ||
      row.relativePath !== `published/${row.artifactId}`
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Runs one `stonehush-backup-v1` snapshot of the live data directory into
 * an empty, control-plane-owned, 0700 destination directory. Holds the
 * exclusive quiesce lock for the whole snapshot; releases it in a finally
 * block. On any failure the INCOMPLETE marker stays behind and the outcome
 * carries a typed code with no filesystem paths.
 */
export async function runBackup(input: RunBackupInput): Promise<BackupOutcome> {
  const uid = currentUid();
  const now = input.now ?? (() => new Date());
  if (uid === undefined) return { status: "error", code: "evidence_io_error" };

  let binding: EvidenceNativeBinding;
  try {
    binding = bindingOrThrow();
  } catch {
    return { status: "error", code: "evidence_io_error" };
  }

  const destination = validateEmptyDestination(input.destinationDirectory, uid);
  if (!destination.ok) {
    return {
      status: "error",
      code: destination.code === "not_empty" ?
          "backup_destination_not_empty"
        : "backup_destination_invalid",
    };
  }
  const destFd = destination.fd;

  let lock: BackupLock | undefined;
  let exclusive: ReturnType<BackupLock["acquireExclusive"]> | undefined;
  let releaseExclusive: (() => void) | undefined;
  // True once the exclusive lock is held and snapshot work has begun: from
  // that point on a failure must leave INCOMPLETE behind as truthful
  // evidence of an interrupted backup. Refusals before that remove it so
  // refused runs leave zero writes.
  let markerRemovable = true;
  const failBeforeSnapshot = (code: BackupErrorCode): BackupOutcome => {
    if (markerRemovable) {
      try {
        unlinkSync(path.join(input.destinationDirectory, BACKUP_INCOMPLETE_MARKER_FILENAME));
      } catch {
        // The marker staying behind keeps the refusal detectable.
      }
    }
    return { status: "error", code };
  };
  let liveRootFd: number | undefined;
  let liveEvidenceFd: number | undefined;
  let livePublishedFd: number | undefined;
  let destSqliteFd: number | undefined;
  let destEvidenceFd: number | undefined;
  let destPublishedFd: number | undefined;

  try {
    // Marker first: any interruption from here on is detectable.
    if (!createIncompleteMarker(destFd)) {
      return { status: "error", code: "evidence_io_error" };
    }

    const lockResult = BackupLock.open(input.dataDirectory, binding);
    if (!lockResult.ok) {
      return failBeforeSnapshot("backup_source_unavailable");
    }
    lock = lockResult.lock;
    exclusive = lock.acquireExclusive();
    if (!exclusive.ok) {
      // Another snapshot holds the lock; nothing was modified beyond our own
      // marker, which is removed to leave the destination pristine.
      exclusive = undefined;
      lock.close();
      lock = undefined;
      return failBeforeSnapshot("storage_busy");
    }
    releaseExclusive = exclusive.release;
    markerRemovable = false;

    // Live managed tree: every hop no-follow, every directory validated.
    const liveRoot = openValidatedDirectory(input.dataDirectory, uid);
    if (liveRoot === undefined) {
      return { status: "error", code: "backup_source_unavailable" };
    }
    liveRootFd = liveRoot.fd;
    liveEvidenceFd = openExistingChildDirectory(liveRootFd, EVIDENCE_DIRNAME, uid);
    if (liveEvidenceFd === undefined) {
      return { status: "error", code: "backup_source_unavailable" };
    }
    livePublishedFd = openExistingChildDirectory(liveEvidenceFd, PUBLISHED_DIRNAME, uid);
    if (livePublishedFd === undefined) {
      return { status: "error", code: "backup_source_unavailable" };
    }
    // The ADR requires evidence/published share the evidence root device;
    // SQLite may live on another device. Compare artifact inodes to the
    // published directory device, not the data-root device.
    const evidenceDirStats = statOf(liveEvidenceFd);
    const publishedDirStats = statOf(livePublishedFd);
    if (
      evidenceDirStats === undefined ||
      publishedDirStats === undefined ||
      evidenceDirStats.dev !== publishedDirStats.dev
    ) {
      return { status: "error", code: "backup_source_unavailable" };
    }
    const publishedDev = publishedDirStats.dev;

    // Destination layout: sqlite/, evidence/, evidence/published/.
    const destSqlite = createManagedChildDirectory(destFd, SQLITE_DIRNAME, input.destinationDirectory, uid);
    if (!destSqlite.ok) return { status: "error", code: "evidence_io_error" };
    destSqliteFd = destSqlite.fd;
    const destEvidence = createManagedChildDirectory(destFd, EVIDENCE_DIRNAME, input.destinationDirectory, uid);
    if (!destEvidence.ok) return { status: "error", code: "evidence_io_error" };
    destEvidenceFd = destEvidence.fd;
    const destPublished = createManagedChildDirectory(
      destEvidenceFd,
      PUBLISHED_DIRNAME,
      path.join(input.destinationDirectory, EVIDENCE_DIRNAME),
      uid,
    );
    if (!destPublished.ok) return { status: "error", code: "evidence_io_error" };
    destPublishedFd = destPublished.fd;

    // Standalone consistent SQLite copy via the better-sqlite3 backup API.
    // The backup API would otherwise replace a raced-in file, so we copy
    // into a uniquely named staging file inside the already validated
    // destination sqlite directory and then move it with descriptor-relative
    // renameNoReplace (no overwrite, no path traversal).
    const finalDatabasePath = path.join(
      input.destinationDirectory,
      SQLITE_DIRNAME,
      DATABASE_FILENAME,
    );
    const stagingName = `${DATABASE_FILENAME}.staging-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const stagingPath = path.join(input.destinationDirectory, SQLITE_DIRNAME, stagingName);
    let sourceDatabase;
    try {
      sourceDatabase = openReadOnlyEngagementDatabase(input.dataDirectory);
    } catch {
      return { status: "error", code: "backup_source_unavailable" };
    }
    try {
      await sourceDatabase.backup(stagingPath);
    } catch {
      try {
        unlinkSync(stagingPath);
      } catch {}
      return { status: "error", code: "evidence_io_error" };
    } finally {
      sourceDatabase.close();
    }
    try {
      chmodSync(stagingPath, 0o600);
    } catch {
      try {
        unlinkSync(stagingPath);
      } catch {}
      return { status: "error", code: "evidence_io_error" };
    }
    try {
      const sqliteFileFd = openSync(
        stagingPath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | O_CLOEXEC,
      );
      try {
        fsyncSync(sqliteFileFd);
      } finally {
        closeQuietly(sqliteFileFd);
      }
      fsyncDirectoryFd(destSqliteFd);
    } catch {
      try {
        unlinkSync(stagingPath);
      } catch {}
      return { status: "error", code: "evidence_io_error" };
    }
    // Move the durable staging file into its final name without ever
    // overwriting a raced-in destination.
    const renamed = binding.renameNoReplace(destSqliteFd, stagingName, destSqliteFd, DATABASE_FILENAME);
    if (!renamed.ok) {
      try {
        unlinkSync(stagingPath);
      } catch {}
      return { status: "error", code: "evidence_io_error" };
    }
    try {
      fsyncDirectoryFd(destSqliteFd);
    } catch {
      return { status: "error", code: "evidence_io_error" };
    }

    // Digest of the frozen snapshot file through a no-follow open.
    const copiedSqlite = binding.openAt(destSqliteFd, DATABASE_FILENAME, READ_FLAGS, 0);
    if (!copiedSqlite.ok) return { status: "error", code: "evidence_io_error" };
    let sqliteDigest: string;
    try {
      const stats = statOf(copiedSqlite.fd);
      if (
        stats === undefined ||
        !stats.isFile() ||
        stats.nlink !== 1 ||
        stats.uid !== uid ||
        (stats.mode & 0o777) !== 0o600
      ) {
        return { status: "error", code: "evidence_io_error" };
      }
      sqliteDigest = (await hashDescriptor(copiedSqlite.fd)).digest;
    } finally {
      closeQuietly(copiedSqlite.fd);
    }

    // The snapshot's internal schema version must match the running binary;
    // a divergent live database is never backed up under the running label.
    const snapshotSchemaVersion = readSnapshotSchemaVersion(finalDatabasePath);
    if (snapshotSchemaVersion === undefined || snapshotSchemaVersion !== DATABASE_SCHEMA_VERSION) {
      return { status: "error", code: "evidence_io_error" };
    }

    // Artifact membership comes from the frozen snapshot, never the live DB.
    const rows = readArtifactRowsFromSnapshot(finalDatabasePath);
    if (rows === undefined) return { status: "error", code: "evidence_io_error" };
    const entries: BackupArtifactEntry[] = [];
    for (const row of rows) {
      // Metadata containment: rows must name exactly published/{artifactId}
      // or the snapshot cannot be trusted.
      if (
        !OPAQUE_EVIDENCE_ID_PATTERN.test(row.artifactId) ||
        row.relativePath !== `published/${row.artifactId}`
      ) {
        return { status: "error", code: "evidence_io_error" };
      }
      entries.push({
        artifactId: row.artifactId,
        sizeBytes: row.sizeBytes,
        digest: row.digest,
      });
    }
    entries.sort((left, right) => (left.artifactId < right.artifactId ? -1 : left.artifactId > right.artifactId ? 1 : 0));

    const startedAt = now().toISOString();

    // Started manifest: an interruption after this point still leaves a
    // machine-readable record, and restore refuses any non-complete state.
    const startedManifest: BackupManifest = BackupManifestSchema.parse({
      protocol: BACKUP_PROTOCOL,
      state: "started",
      startedAt,
      schemaVersion: snapshotSchemaVersion,
      sqliteDigest,
      artifacts: [],
      artifactCount: 0,
    });
    if (!writeManifestFile(destFd, startedManifest)) {
      return { status: "error", code: "evidence_io_error" };
    }
    fsyncDirectoryFd(destFd);

    // Copy every published artifact from the live tree. Staging is never
    // consulted. Each copy verifies during and after.
    for (const entry of entries) {
      const source = binding.openAt(livePublishedFd, entry.artifactId, READ_FLAGS, 0);
      if (!source.ok) return { status: "error", code: "evidence_io_error" };
      let usable = true;
      try {
        const stats = statOf(source.fd);
        usable =
          stats !== undefined &&
          stats.isFile() &&
          stats.nlink === 1 &&
          stats.uid === uid &&
          (stats.mode & 0o777) === 0o600 &&
          stats.dev === publishedDev &&
          stats.size === entry.sizeBytes;
      } finally {
        if (!usable) closeQuietly(source.fd);
      }
      if (!usable) {
        return { status: "error", code: "evidence_io_error" };
      }
      const copied = await copyVerifying({
        sourceFd: source.fd,
        destDirFd: destPublishedFd,
        destName: entry.artifactId,
        expectedSizeBytes: entry.sizeBytes,
        expectedDigest: entry.digest,
      });
      closeQuietly(source.fd);
      if (!copied) return { status: "error", code: "evidence_io_error" };
    }

    fsyncDirectoryFd(destPublishedFd);
    fsyncDirectoryFd(destEvidenceFd);
    fsyncDirectoryFd(destSqliteFd);

    const completedAt = now().toISOString();
    const completeManifest: BackupManifest = BackupManifestSchema.parse({
      protocol: BACKUP_PROTOCOL,
      state: "complete",
      startedAt,
      completedAt,
      schemaVersion: snapshotSchemaVersion,
      sqliteDigest,
      artifacts: entries,
      artifactCount: entries.length,
    });
    if (!finalizeManifestFile(input.destinationDirectory, completeManifest)) {
      return { status: "error", code: "evidence_io_error" };
    }
    fsyncDirectoryFd(destFd);

    // Only now is the backup complete: drop the marker.
    unlinkSync(path.join(input.destinationDirectory, BACKUP_INCOMPLETE_MARKER_FILENAME));
    try {
      fsyncDirectoryFd(destFd);
    } catch {
      return { status: "error", code: "evidence_io_error" };
    }

    return {
      status: "complete",
      protocol: BACKUP_PROTOCOL,
      artifactCount: entries.length,
    };
  } catch {
    return { status: "error", code: "evidence_io_error" };
  } finally {
    releaseExclusive?.();
    lock?.close();
    if (livePublishedFd !== undefined) closeQuietly(livePublishedFd);
    if (liveEvidenceFd !== undefined) closeQuietly(liveEvidenceFd);
    if (liveRootFd !== undefined) closeQuietly(liveRootFd);
    if (destPublishedFd !== undefined) closeQuietly(destPublishedFd);
    if (destEvidenceFd !== undefined) closeQuietly(destEvidenceFd);
    if (destSqliteFd !== undefined) closeQuietly(destSqliteFd);
    closeQuietly(destFd);
  }
}

/**
 * Restores one `stonehush-backup-v1` backup into an empty data directory.
 * Verifies the complete manifest, schema version, SQLite digest, and the
 * exact published membership plus every artifact digest BEFORE any
 * destination write, then copies with exclusive no-follow opens, verifies
 * again, fsyncs, and removes the INCOMPLETE marker last.
 */
export async function runRestore(input: RunRestoreInput): Promise<RestoreOutcome> {
  const uid = currentUid();
  if (uid === undefined) return { status: "error", code: "evidence_io_error" };

  let binding: EvidenceNativeBinding;
  try {
    binding = bindingOrThrow();
  } catch {
    return { status: "error", code: "evidence_io_error" };
  }

  const destination = validateEmptyDestination(input.dataDirectory, uid);
  if (!destination.ok) {
    return {
      status: "error",
      code: destination.code === "not_empty" ?
          "restore_destination_not_empty"
        : "restore_destination_invalid",
    };
  }
  const destFd = destination.fd;

  let backupFd: number | undefined;
  let backupSqliteDirFd: number | undefined;
  let backupEvidenceFd: number | undefined;
  let backupPublishedFd: number | undefined;
  let destEvidenceFd: number | undefined;
  let destPublishedFd: number | undefined;

  try {
    const backupRoot = openValidatedDirectory(input.backupDirectory, uid);
    if (backupRoot === undefined) {
      return { status: "error", code: "evidence_io_error" };
    }
    backupFd = backupRoot.fd;

    // Refuse-closed: an interrupted backup can never be restored.
    const incompleteProbe = binding.openAt(
      backupFd,
      BACKUP_INCOMPLETE_MARKER_FILENAME,
      READ_FLAGS,
      0,
    );
    if (incompleteProbe.ok) {
      closeQuietly(incompleteProbe.fd);
      return { status: "error", code: "backup_incomplete" };
    }
    if (incompleteProbe.errno !== ERRNO.ENOENT) {
      return { status: "error", code: "evidence_io_error" };
    }

    const manifest = readManifestAt(backupFd);
    if (manifest === undefined || manifest.state !== "complete") {
      return { status: "error", code: "backup_incomplete" };
    }
    if (manifest.schemaVersion > DATABASE_SCHEMA_VERSION) {
      return { status: "error", code: "restore_schema_newer" };
    }

    // --- Verification phase: zero destination writes below this line. ---

    backupSqliteDirFd = openExistingChildDirectory(backupFd, SQLITE_DIRNAME, uid);
    backupEvidenceFd = openExistingChildDirectory(backupFd, EVIDENCE_DIRNAME, uid);
    if (backupSqliteDirFd === undefined || backupEvidenceFd === undefined) {
      return { status: "error", code: "restore_consistency_mismatch" };
    }
    backupPublishedFd = openExistingChildDirectory(backupEvidenceFd, PUBLISHED_DIRNAME, uid);
    if (backupPublishedFd === undefined) {
      return { status: "error", code: "restore_consistency_mismatch" };
    }

    const backupSqlite = binding.openAt(backupSqliteDirFd, DATABASE_FILENAME, READ_FLAGS, 0);
    if (!backupSqlite.ok) {
      return { status: "error", code: "restore_consistency_mismatch" };
    }
    let sqliteSizeBytes: number;
    try {
      const stats = statOf(backupSqlite.fd);
      if (stats === undefined || !stats.isFile() || stats.nlink !== 1) {
        return { status: "error", code: "restore_consistency_mismatch" };
      }
      const hashed = await hashDescriptor(backupSqlite.fd);
      if (hashed.digest !== manifest.sqliteDigest) {
        return { status: "error", code: "restore_consistency_mismatch" };
      }
      sqliteSizeBytes = hashed.sizeBytes;
    } finally {
      closeQuietly(backupSqlite.fd);
    }

    // Internal SQLite consistency: the backup's own migration count and
    // artifact rows must agree with the manifest before any destination
    // writes. This proves the manifest is not just internally consistent
    // with the files but also with the database that claims to list them.
    const backupDatabasePath = path.join(input.backupDirectory, SQLITE_DIRNAME, DATABASE_FILENAME);
    const internalSchemaVersion = readSnapshotSchemaVersion(backupDatabasePath);
    if (internalSchemaVersion === undefined || internalSchemaVersion !== manifest.schemaVersion) {
      return { status: "error", code: "restore_consistency_mismatch" };
    }
    const internalRows = readArtifactRowsFromSnapshot(backupDatabasePath);
    if (internalRows === undefined || !snapshotArtifactsMatchManifest(internalRows, manifest.artifacts)) {
      return { status: "error", code: "restore_consistency_mismatch" };
    }

    // Exact published membership: every manifest entry exists, no extras.
    const listed = binding.readDirNames(backupPublishedFd);
    if (!listed.ok) return { status: "error", code: "evidence_io_error" };
    const manifestIds = new Set(manifest.artifacts.map((entry) => entry.artifactId));
    if (listed.names.length !== manifestIds.size) {
      return { status: "error", code: "restore_consistency_mismatch" };
    }
    for (const name of listed.names) {
      if (!manifestIds.has(name)) {
        return { status: "error", code: "restore_consistency_mismatch" };
      }
    }

    for (const entry of manifest.artifacts) {
      const source = binding.openAt(backupPublishedFd, entry.artifactId, READ_FLAGS, 0);
      if (!source.ok) {
        return { status: "error", code: "restore_consistency_mismatch" };
      }
      try {
        const stats = statOf(source.fd);
        if (
          stats === undefined ||
          !stats.isFile() ||
          stats.nlink !== 1 ||
          stats.size !== entry.sizeBytes
        ) {
          return { status: "error", code: "restore_consistency_mismatch" };
        }
        const hashed = await hashDescriptor(source.fd);
        if (hashed.digest !== entry.digest) {
          return { status: "error", code: "restore_consistency_mismatch" };
        }
      } finally {
        closeQuietly(source.fd);
      }
    }

    // --- Write phase: the whole backup proved consistent. ---

    if (!createIncompleteMarker(destFd)) {
      return { status: "error", code: "evidence_io_error" };
    }

    const destEvidence = createManagedChildDirectory(destFd, EVIDENCE_DIRNAME, input.dataDirectory, uid);
    if (!destEvidence.ok) return { status: "error", code: "evidence_io_error" };
    destEvidenceFd = destEvidence.fd;
    const destPublished = createManagedChildDirectory(
      destEvidenceFd,
      PUBLISHED_DIRNAME,
      path.join(input.dataDirectory, EVIDENCE_DIRNAME),
      uid,
    );
    if (!destPublished.ok) return { status: "error", code: "evidence_io_error" };
    destPublishedFd = destPublished.fd;
    // An empty staging tree makes the destination immediately usable as a
    // live data directory without ever importing in-flight upload bytes.
    const destStaging = createManagedChildDirectory(
      destEvidenceFd,
      STAGING_DIRNAME,
      path.join(input.dataDirectory, EVIDENCE_DIRNAME),
      uid,
    );
    if (!destStaging.ok) return { status: "error", code: "evidence_io_error" };
    try {
      fsyncSync(destStaging.fd);
    } catch {
      closeQuietly(destStaging.fd);
      return { status: "error", code: "evidence_io_error" };
    }
    closeQuietly(destStaging.fd);
    try {
      fsyncDirectoryFd(destEvidenceFd);
    } catch {
      return { status: "error", code: "evidence_io_error" };
    }

    // The database returns to the data-directory root where the control
    // plane opens it; only the backup layout nests it under sqlite/.
    const sqliteCopy = binding.openAt(backupSqliteDirFd, DATABASE_FILENAME, READ_FLAGS, 0);
    if (!sqliteCopy.ok) return { status: "error", code: "evidence_io_error" };
    let sqliteCopied: boolean;
    try {
      sqliteCopied = await copyVerifying({
        sourceFd: sqliteCopy.fd,
        destDirFd: destFd,
        destName: DATABASE_FILENAME,
        expectedSizeBytes: sqliteSizeBytes,
        expectedDigest: manifest.sqliteDigest,
      });
    } finally {
      closeQuietly(sqliteCopy.fd);
    }
    if (!sqliteCopied) {
      // Failure leaves INCOMPLETE: the destination must not be used as a
      // live data directory.
      return { status: "error", code: "restore_consistency_mismatch" };
    }

    for (const entry of manifest.artifacts) {
      const source = binding.openAt(backupPublishedFd, entry.artifactId, READ_FLAGS, 0);
      if (!source.ok) return { status: "error", code: "evidence_io_error" };
      let copied: boolean;
      try {
        copied = await copyVerifying({
          sourceFd: source.fd,
          destDirFd: destPublishedFd,
          destName: entry.artifactId,
          expectedSizeBytes: entry.sizeBytes,
          expectedDigest: entry.digest,
        });
      } finally {
        closeQuietly(source.fd);
      }
      if (!copied) {
        return { status: "error", code: "restore_consistency_mismatch" };
      }
    }

    fsyncDirectoryFd(destPublishedFd);
    fsyncDirectoryFd(destEvidenceFd);
    fsyncDirectoryFd(destFd);

    // Everything is durable: only now may the marker disappear.
    unlinkSync(path.join(input.dataDirectory, BACKUP_INCOMPLETE_MARKER_FILENAME));
    try {
      fsyncDirectoryFd(destFd);
    } catch {
      return { status: "error", code: "evidence_io_error" };
    }

    return {
      status: "complete",
      protocol: BACKUP_PROTOCOL,
      restoredArtifacts: manifest.artifacts.length,
    };
  } catch {
    return { status: "error", code: "evidence_io_error" };
  } finally {
    if (backupPublishedFd !== undefined) closeQuietly(backupPublishedFd);
    if (backupEvidenceFd !== undefined) closeQuietly(backupEvidenceFd);
    if (backupSqliteDirFd !== undefined) closeQuietly(backupSqliteDirFd);
    if (backupFd !== undefined) closeQuietly(backupFd);
    if (destPublishedFd !== undefined) closeQuietly(destPublishedFd);
    if (destEvidenceFd !== undefined) closeQuietly(destEvidenceFd);
    closeQuietly(destFd);
  }
}
