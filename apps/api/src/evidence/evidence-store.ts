import { createHash } from "node:crypto";
import {
  close as closeCb,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsync as fsyncCb,
  fsyncSync,
  mkdirSync,
  openSync,
  read as cbRead,
  write as cbWrite,
  type Stats,
} from "node:fs";
import { promisify } from "node:util";
import path from "node:path";

import { OPAQUE_EVIDENCE_ID_PATTERN } from "@stonehush/contracts";
import { O_CLOEXEC, type EvidenceNativeBinding } from "@stonehush/evidence-native";

// Descriptor-relative filesystem boundary for ADR-0003 publication. Every
// managed-tree operation starts at a startup-opened directory descriptor and
// uses openat(2)/renameat2(RENAME_NOREPLACE) through the native binding. No
// caller-supplied path ever reaches open(): names are control-plane IDs
// validated here and re-validated inside the binding.


const READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | O_CLOEXEC;
const DIRECTORY_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | O_CLOEXEC;
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
const fdFsync = promisify(fsyncCb);
const fdClose = promisify(closeCb);

export type EvidenceStorageErrorCode =
  | "artifact_symlink_rejected"
  | "artifact_hardlink_rejected"
  | "artifact_not_regular_file"
  | "artifact_path_rejected"
  | "artifact_published_root_changed"
  | "cross_filesystem_staging"
  | "evidence_roots_cross_device"
  | "evidence_storage_invalid"
  | "evidence_storage_unsupported"
  | "evidence_staging_name_taken"
  | "evidence_io_error";

export type EvidenceStoreOpenResult =
  | { ok: true; store: EvidenceStore }
  | { ok: false; code: EvidenceStorageErrorCode };

export type StagingCreateResult =
  | { ok: true; fd: number }
  | { ok: false; code: EvidenceStorageErrorCode };

export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export type PublishOutcome =
  | { status: "published"; identity: FileIdentity }
  // renameat2 could not move the source: either the destination exists
  // (EEXIST), or the source is already gone after a crash-window rename.
  | { status: "destination_exists" }
  | { status: "source_missing" }
  | { status: "failed"; code: EvidenceStorageErrorCode };

export type DestinationInspection =
  | { status: "missing" }
  | { status: "match"; sizeBytes: number; digest: string }
  | { status: "mismatch" }
  | { status: "failed"; code: EvidenceStorageErrorCode };

// Fail-closed download verdicts. Symlink, hardlink, ownership, size, and
// digest tampering all collapse into typed corrupt reasons; a replaced
// published directory reports missing. No filesystem path ever appears in
// any variant.
export type VerifiedDownloadCorruptCode =
  | "invalid_download_request"
  | "size_mismatch"
  | "digest_mismatch"
  | Exclude<EvidenceStorageErrorCode, "artifact_path_rejected">;

export interface VerifiedDownloadReady {
  readonly status: "ready";
  readonly sizeBytes: number;
  readonly digest: string;
  // Bounded async byte stream over the SAME fd that passed verification,
  // starting at offset 0. The descriptor is closed on normal completion,
  // consumer abort/return, and read error.
  readonly stream: AsyncGenerator<Buffer>;
}

export type VerifiedDownloadResult =
  | { status: "missing" }
  | { status: "corrupt"; code: VerifiedDownloadCorruptCode }
  | VerifiedDownloadReady;

export interface VerifiedExcerptReady {
  readonly status: "ready";
  readonly totalBytes: number;
  readonly truncated: boolean;
  readonly content: Buffer;
}

export type VerifiedExcerptResult =
  | { status: "missing" }
  | { status: "corrupt"; code: VerifiedDownloadCorruptCode }
  | VerifiedExcerptReady;

export const VERIFIED_EXCERPT_MAX_BYTES = 64 * 1024;

const VERIFIED_DOWNLOAD_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const DOWNLOAD_CHUNK_BYTES = 256 * 1024;

const ERRNO = {
  EPERM: 1,
  ENOENT: 2,
  EEXIST: 17,
  EXDEV: 18,
  EINVAL: 22,
  ENOTDIR: 20,
  ELOOP: 40,
  ENOSYS: 38,
} as const;

// Errno-to-code mapping never yields path-rejection codes because the
// caller already validated the name before touching the kernel.
function mapOpenErrno(
  errno: number,
): Exclude<EvidenceStorageErrorCode, "artifact_path_rejected"> {
  switch (errno) {
    case ERRNO.ELOOP:
      return "artifact_symlink_rejected";
    case ERRNO.ENOTDIR:
    case ERRNO.EPERM:
      return "artifact_not_regular_file";
    default:
      return "evidence_io_error";
  }
}

function fstatOf(fd: number): Stats | undefined {
  try {
    return fstatSync(fd);
  } catch {
    return undefined;
  }
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Best-effort close; nothing actionable remains.
  }
}

function fsyncDirectory(fd: number): boolean {
  try {
    fsyncSync(fd);
    return false;
  } catch {
    return true;
  }
}

// Returns a failure code when the descriptor does not hold an acceptable
// evidence file: regular, nlink 1, control-plane owned, mode 0600, on the
// evidence root device, and optionally the exact expected size and inode.
function regularFileDefect(
  fd: number,
  options: {
    rootDev: number;
    uid: number;
    expectedSize?: number;
    expectedIdentity?: FileIdentity;
  },
): EvidenceStorageErrorCode | undefined {
  const stats = fstatOf(fd);
  if (stats === undefined) return "evidence_io_error";
  if (!stats.isFile() || stats.nlink !== 1) {
    return stats.nlink !== 1 ? "artifact_hardlink_rejected" : "artifact_not_regular_file";
  }
  if (stats.uid !== options.uid || (stats.mode & 0o777) !== 0o600) {
    return "evidence_storage_invalid";
  }
  if (stats.dev !== options.rootDev) return "cross_filesystem_staging";
  if (
    (options.expectedSize !== undefined && stats.size !== options.expectedSize) ||
    (options.expectedIdentity !== undefined &&
      (stats.dev !== options.expectedIdentity.dev || stats.ino !== options.expectedIdentity.ino))
  ) {
    return "evidence_io_error";
  }
  return undefined;
}

interface ManagedDirectory {
  readonly fd: number;
  readonly identity: FileIdentity;
}

// Opens a managed child directory relative to its parent descriptor without
// following symlinks, creating it mode 0700 when missing.
function ensureManagedDirectory(
  parentFd: number,
  name: "evidence" | "published" | "staging",
  parentPath: string,
  binding: EvidenceNativeBinding,
): { ok: true; fd: number } | { ok: false; code: EvidenceStorageErrorCode } {
  const opened = binding.openAt(parentFd, name, DIRECTORY_FLAGS, 0);
  if (opened.ok) return opened;
  if (opened.errno !== ERRNO.ENOENT) {
    return { ok: false, code: mapOpenErrno(opened.errno) };
  }
  try {
    mkdirSync(path.join(parentPath, name), { mode: 0o700 });
  } catch {
    return { ok: false, code: "evidence_storage_invalid" };
  }
  const retried = binding.openAt(parentFd, name, DIRECTORY_FLAGS, 0);
  if (!retried.ok) return { ok: false, code: mapOpenErrno(retried.errno) };
  return retried;
}

export class EvidenceStore {
  private constructor(
    private readonly binding: EvidenceNativeBinding,
    private readonly rootDev: number,
    private readonly evidence: ManagedDirectory,
    private readonly staging: ManagedDirectory,
    private readonly published: ManagedDirectory,
    private readonly uid: number,
  ) {}

  static open(
    dataDirectory: string,
    binding: EvidenceNativeBinding,
    getCurrentUid: () => number | undefined = () =>
      typeof process.getuid === "function" ? process.getuid() : undefined,
  ): EvidenceStoreOpenResult {
    const uid = getCurrentUid();
    if (uid === undefined) return { ok: false, code: "evidence_storage_invalid" };
    let rootFd: number;
    let evidenceFd: number | undefined;
    let publishedFd: number | undefined;
    let stagingFd: number | undefined;
    try {
      rootFd = openSync(dataDirectory, DIRECTORY_FLAGS);
    } catch {
      return { ok: false, code: "evidence_storage_invalid" };
    }
    try {
      const evidence = ensureManagedDirectory(rootFd, "evidence", dataDirectory, binding);
      if (!evidence.ok) return evidence;
      evidenceFd = evidence.fd;
      const published = ensureManagedDirectory(
        evidence.fd,
        "published",
        path.join(dataDirectory, "evidence"),
        binding,
      );
      if (!published.ok) return published;
      publishedFd = published.fd;
      const staging = ensureManagedDirectory(
        evidence.fd,
        "staging",
        path.join(dataDirectory, "evidence"),
        binding,
      );
      if (!staging.ok) return staging;
      stagingFd = staging.fd;

      const directories = [
        ["root", rootFd],
        ["evidence", evidence.fd],
        ["published", published.fd],
        ["staging", staging.fd],
      ] as const;
      let rootDev: number | undefined;
      for (const [index, [, fd]] of directories.entries()) {
        const stats = fstatOf(fd);
        if (
          stats === undefined ||
          !stats.isDirectory() ||
          stats.uid !== uid ||
          (stats.mode & 0o777) !== 0o700
        ) {
          return { ok: false, code: "evidence_storage_invalid" };
        }
        if (index === 0) {
          rootDev = stats.dev;
          continue;
        }
        if (stats.dev !== rootDev) return { ok: false, code: "evidence_roots_cross_device" };
      }

      const candidate = new EvidenceStore(
        binding,
        rootDev ?? -1,
        { fd: evidence.fd, identity: identityOf(fstatOf(evidence.fd)) },
        { fd: staging.fd, identity: identityOf(fstatOf(staging.fd)) },
        { fd: published.fd, identity: identityOf(fstatOf(published.fd)) },
        uid,
      );
      const probe = candidate.probeRenameNoReplaceSupport();
      if (!probe.ok) return probe;
      // Ownership of the managed descriptors transfers to the store; the
      // finally block must not close them.
      stagingFd = undefined;
      publishedFd = undefined;
      evidenceFd = undefined;
      return { ok: true, store: candidate };
    } finally {
      if (evidenceFd !== undefined) closeQuietly(evidenceFd);
      if (publishedFd !== undefined) closeQuietly(publishedFd);
      if (stagingFd !== undefined) closeQuietly(stagingFd);
      closeQuietly(rootFd);
    }
  }

  // renameat2 support probe: two nonexistent names under the staging
  // descriptor must yield ENOENT. ENOSYS or EINVAL means the host cannot
  // honor RENAME_NOREPLACE, and serving must fail closed instead of falling
  // back to plain rename().
  private probeRenameNoReplaceSupport(): { ok: true } | { ok: false; code: EvidenceStorageErrorCode } {
    const outcome = this.binding.renameNoReplace(
      this.staging.fd,
      ".stonehush-rename-probe-source",
      this.staging.fd,
      ".stonehush-rename-probe-destination",
    );
    if (outcome.ok || outcome.errno === ERRNO.ENOENT) return { ok: true };
    return { ok: false, code: "evidence_storage_unsupported" };
  }

  close(): void {
    closeQuietly(this.evidence.fd);
    closeQuietly(this.staging.fd);
    closeQuietly(this.published.fd);
  }

  // Publication step 2: create staging/{uploadId} exclusively with mode 0600
  // through the no-follow staging descriptor, then verify the fresh inode.
  openStagingFile(uploadId: string): StagingCreateResult {
    if (!OPAQUE_EVIDENCE_ID_PATTERN.test(uploadId)) {
      return { ok: false, code: "artifact_path_rejected" };
    }
    const created = this.binding.openAt(
      this.staging.fd,
      uploadId,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW | O_CLOEXEC,
      0o600,
    );
    if (!created.ok) {
      if (created.errno === ERRNO.EEXIST) {
        // O_EXCL|O_NOFOLLOW reports EEXIST for an existing symlink too.
        // Distinguish so the fixture-pinned code stays truthful.
        const probe = this.binding.openAt(
          this.staging.fd,
          uploadId,
          READ_FLAGS,
          0,
        );
        if (!probe.ok && probe.errno === ERRNO.ELOOP) {
          return { ok: false, code: "artifact_symlink_rejected" };
        }
        if (probe.ok) closeQuietly(probe.fd);
        return { ok: false, code: "evidence_staging_name_taken" };
      }
      return { ok: false, code: mapOpenErrno(created.errno) };
    }
    const defect = regularFileDefect(created.fd, {
      rootDev: this.rootDev,
      uid: this.uid,
      expectedSize: 0,
    });
    if (defect !== undefined) {
      closeQuietly(created.fd);
      return { ok: false, code: defect };
    }
    return created;
  }

  // Resolves only after the kernel accepts the chunk, so the pump below
  // naturally applies backpressure to the request stream.
  async writeStagedChunk(fd: number, chunk: Buffer): Promise<void> {
    await fdWrite(fd, chunk, 0, chunk.length, null);
  }

  finalizeStagedWrite(fd: number): Promise<void> {
    return fdFsync(fd).then(() => undefined);
  }

  closeStagedFile(fd: number): Promise<void> {
    return fdClose(fd).then(() => undefined);
  }

  fsyncStagingDirectory(): void {
    if (fsyncDirectory(this.staging.fd)) throw new Error("staging directory fsync failed");
  }

  fsyncPublishedDirectory(): void {
    if (fsyncDirectory(this.published.fd)) throw new Error("published directory fsync failed");
  }

  // Publication steps 7 through 9. Directory descriptor identities are
  // rechecked immediately before the rename so a replaced staging or
  // published directory can never retarget it.
  publish(input: {
    uploadId: string;
    artifactId: string;
    expectedSizeBytes: number;
  }): PublishOutcome {
    if (
      !OPAQUE_EVIDENCE_ID_PATTERN.test(input.uploadId) ||
      !OPAQUE_EVIDENCE_ID_PATTERN.test(input.artifactId)
    ) {
      return { status: "failed", code: "artifact_path_rejected" };
    }
    if (
      !this.onTreeDirectoryMatches(this.published) ||
      !this.onTreeDirectoryMatches(this.staging)
    ) {
      return { status: "failed", code: "artifact_published_root_changed" };
    }

    const source = this.binding.openAt(this.staging.fd, input.uploadId, READ_FLAGS, 0);
    if (!source.ok) {
      if (source.errno === ERRNO.ENOENT) return { status: "source_missing" };
      return { status: "failed", code: mapOpenErrno(source.errno) };
    }
    const defect = regularFileDefect(source.fd, {
      rootDev: this.rootDev,
      uid: this.uid,
      expectedSize: input.expectedSizeBytes,
    });
    const identity = defect === undefined ? identityOf(fstatOf(source.fd)) : undefined;
    closeQuietly(source.fd);
    if (defect !== undefined || identity === undefined) {
      return { status: "failed", code: defect ?? "evidence_io_error" };
    }

    const renamed = this.binding.renameNoReplace(
      this.staging.fd,
      input.uploadId,
      this.published.fd,
      input.artifactId,
    );
    if (!renamed.ok) {
      switch (renamed.errno) {
        case ERRNO.EEXIST:
          return { status: "destination_exists" };
        case ERRNO.ENOENT:
          return { status: "source_missing" };
        case ERRNO.EXDEV:
          return { status: "failed", code: "cross_filesystem_staging" };
        case ERRNO.EINVAL:
        case ERRNO.ENOSYS:
          return { status: "failed", code: "evidence_storage_unsupported" };
        default:
          return { status: "failed", code: "evidence_io_error" };
      }
    }

    try {
      this.fsyncPublishedDirectory();
    } catch {
      return { status: "failed", code: "evidence_io_error" };
    }

    // The on-tree published name must still resolve to the descriptor the
    // rename targeted; a swap inside the race window fails metadata commit.
    if (!this.onTreeDirectoryMatches(this.published)) {
      return { status: "failed", code: "artifact_published_root_changed" };
    }

    // Re-fstat through a no-follow open: regular file, nlink 1, owner, mode,
    // device, size still hold and the inode is exactly the one streamed to.
    const publishedFile = this.binding.openAt(
      this.published.fd,
      input.artifactId,
      READ_FLAGS,
      0,
    );
    if (!publishedFile.ok) {
      return { status: "failed", code: mapOpenErrno(publishedFile.errno) };
    }
    try {
      const postDefect = regularFileDefect(publishedFile.fd, {
        rootDev: this.rootDev,
        uid: this.uid,
        expectedSize: input.expectedSizeBytes,
        expectedIdentity: identity,
      });
      if (postDefect !== undefined) return { status: "failed", code: postDefect };
      return { status: "published", identity };
    } finally {
      closeQuietly(publishedFile.fd);
    }
  }

  // Post-crash replay inspection of an existing published name. The digest is
  // computed from the opened descriptor so the decision never trusts a path
  // that could have been swapped between stat and read.
  async inspectPublishedDestination(artifactId: string): Promise<DestinationInspection> {
    if (!OPAQUE_EVIDENCE_ID_PATTERN.test(artifactId)) {
      return { status: "failed", code: "artifact_path_rejected" };
    }
    const opened = this.binding.openAt(this.published.fd, artifactId, READ_FLAGS, 0);
    if (!opened.ok) {
      if (opened.errno === ERRNO.ENOENT) return { status: "missing" };
      if (opened.errno === ERRNO.ELOOP) return { status: "mismatch" };
      return { status: "failed", code: mapOpenErrno(opened.errno) };
    }
    try {
      const stats = fstatOf(opened.fd);
      if (stats === undefined || !stats.isFile() || stats.nlink !== 1) {
        return { status: "mismatch" };
      }
      if (stats.dev !== this.rootDev || stats.uid !== this.uid || (stats.mode & 0o777) !== 0o600) {
        return { status: "mismatch" };
      }
      const hashed = await hashDescriptor(opened.fd);
      return { status: "match", sizeBytes: hashed.sizeBytes, digest: hashed.digest };
    } catch {
      return { status: "failed", code: "evidence_io_error" };
    }
  }

  // Verified download foundation: opens published/{artifactId} relative to
  // the startup descriptor, rechecks the on-tree directory identity, fstats
  // the regular-file invariants, stream-hashes with positioned reads, and
  // only after size and digest match exposes a bounded byte stream from the
  // same verified fd. Empty files are valid.
  async verifiedDownload(input: {
    readonly artifactId: string;
    readonly expectedSizeBytes: number;
    readonly expectedDigest: string;
  }): Promise<VerifiedDownloadResult> {
    const { artifactId, expectedSizeBytes, expectedDigest } = input;
    if (
      !OPAQUE_EVIDENCE_ID_PATTERN.test(artifactId) ||
      !Number.isSafeInteger(expectedSizeBytes) ||
      expectedSizeBytes < 0 ||
      !VERIFIED_DOWNLOAD_DIGEST_PATTERN.test(expectedDigest)
    ) {
      return { status: "corrupt", code: "invalid_download_request" };
    }
    // A replaced published directory fails closed before any name lookup.
    if (!this.onTreeDirectoryMatches(this.published)) {
      return { status: "missing" };
    }
    const opened = this.binding.openAt(this.published.fd, artifactId, READ_FLAGS, 0);
    if (!opened.ok) {
      if (opened.errno === ERRNO.ENOENT) return { status: "missing" };
      if (opened.errno === ERRNO.ELOOP) {
        return { status: "corrupt", code: "artifact_symlink_rejected" };
      }
      return { status: "corrupt", code: mapOpenErrno(opened.errno) };
    }
    const fd = opened.fd;

    const stats = fstatOf(fd);
    if (stats === undefined) {
      closeQuietly(fd);
      return { status: "corrupt", code: "evidence_io_error" };
    }
    if (!stats.isFile()) {
      closeQuietly(fd);
      return { status: "corrupt", code: "artifact_not_regular_file" };
    }
    if (stats.nlink !== 1) {
      closeQuietly(fd);
      return { status: "corrupt", code: "artifact_hardlink_rejected" };
    }
    if (stats.dev !== this.rootDev) {
      closeQuietly(fd);
      return { status: "corrupt", code: "cross_filesystem_staging" };
    }
    if (stats.uid !== this.uid || (stats.mode & 0o777) !== 0o600) {
      closeQuietly(fd);
      return { status: "corrupt", code: "evidence_storage_invalid" };
    }
    if (stats.size !== expectedSizeBytes) {
      closeQuietly(fd);
      return { status: "corrupt", code: "size_mismatch" };
    }

    let hashed: { sizeBytes: number; digest: string };
    try {
      hashed = await hashDescriptor(fd);
    } catch {
      closeQuietly(fd);
      return { status: "corrupt", code: "evidence_io_error" };
    }
    if (hashed.sizeBytes !== expectedSizeBytes) {
      closeQuietly(fd);
      return { status: "corrupt", code: "size_mismatch" };
    }
    if (hashed.digest !== expectedDigest) {
      closeQuietly(fd);
      return { status: "corrupt", code: "digest_mismatch" };
    }

    const total = hashed.sizeBytes;
    async function* verifiedChunks(): AsyncGenerator<Buffer> {
      try {
        let position = 0;
        while (position < total) {
          const chunk = Buffer.allocUnsafe(Math.min(DOWNLOAD_CHUNK_BYTES, total - position));
          const read = await fdRead(fd, chunk, 0, chunk.length, position);
          if (read.bytesRead === 0) {
            // Truncation mid-stream: fail with a generic, path-free error.
            // The reply headers are already sent so the connection aborts;
            // the finally block still closes the verified fd and nothing
            // buffers the remaining bytes.
            throw new Error("verified artifact truncated during streaming");
          }
          position += read.bytesRead;
          yield Buffer.from(chunk.subarray(0, read.bytesRead));
        }
      } finally {
        closeQuietly(fd);
      }
    }
    return {
      status: "ready",
      sizeBytes: total,
      digest: hashed.digest,
      stream: verifiedChunks(),
    };
  }

  // Verified excerpt for console display: same fail-closed verification as a
  // download, then a single bounded read of at most maxBytes from offset 0.
  // The response never carries more than maxBytes; truncated is truthful.
  async verifiedExcerpt(input: {
    readonly artifactId: string;
    readonly expectedSizeBytes: number;
    readonly expectedDigest: string;
    readonly maxBytes: number;
  }): Promise<VerifiedExcerptResult> {
    const { artifactId, expectedSizeBytes, expectedDigest, maxBytes } = input;
    if (
      !OPAQUE_EVIDENCE_ID_PATTERN.test(artifactId) ||
      !Number.isSafeInteger(expectedSizeBytes) ||
      expectedSizeBytes < 0 ||
      !VERIFIED_DOWNLOAD_DIGEST_PATTERN.test(expectedDigest) ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes <= 0 ||
      maxBytes > VERIFIED_EXCERPT_MAX_BYTES
    ) {
      return { status: "corrupt", code: "invalid_download_request" };
    }
    if (!this.onTreeDirectoryMatches(this.published)) {
      return { status: "missing" };
    }
    const opened = this.binding.openAt(this.published.fd, artifactId, READ_FLAGS, 0);
    if (!opened.ok) {
      if (opened.errno === ERRNO.ENOENT) return { status: "missing" };
      if (opened.errno === ERRNO.ELOOP) {
        return { status: "corrupt", code: "artifact_symlink_rejected" };
      }
      return { status: "corrupt", code: mapOpenErrno(opened.errno) };
    }
    const fd = opened.fd;
    try {
      const stats = fstatOf(fd);
      if (stats === undefined) {
        return { status: "corrupt", code: "evidence_io_error" };
      }
      if (!stats.isFile()) {
        return { status: "corrupt", code: "artifact_not_regular_file" };
      }
      if (stats.nlink !== 1) {
        return { status: "corrupt", code: "artifact_hardlink_rejected" };
      }
      if (stats.dev !== this.rootDev) {
        return { status: "corrupt", code: "cross_filesystem_staging" };
      }
      if (stats.uid !== this.uid || (stats.mode & 0o777) !== 0o600) {
        return { status: "corrupt", code: "evidence_storage_invalid" };
      }
      if (stats.size !== expectedSizeBytes) {
        return { status: "corrupt", code: "size_mismatch" };
      }
      let hashed: { sizeBytes: number; digest: string };
      try {
        hashed = await hashDescriptor(fd);
      } catch {
        return { status: "corrupt", code: "evidence_io_error" };
      }
      if (hashed.sizeBytes !== expectedSizeBytes) {
        return { status: "corrupt", code: "size_mismatch" };
      }
      if (hashed.digest !== expectedDigest) {
        return { status: "corrupt", code: "digest_mismatch" };
      }
      const total = hashed.sizeBytes;
      const wanted = Math.min(total, maxBytes);
      const content = Buffer.allocUnsafe(wanted);
      let position = 0;
      while (position < wanted) {
        const read = await fdRead(fd, content, position, wanted - position, position);
        if (read.bytesRead === 0) {
          return { status: "corrupt", code: "evidence_io_error" };
        }
        position += read.bytesRead;
      }
      return {
        status: "ready",
        totalBytes: total,
        truncated: total > maxBytes,
        content: Buffer.from(content),
      };
    } finally {
      closeQuietly(fd);
    }
  }

  // Verified positioned range for evidence excerpts: same fail-closed
  // verification as an excerpt, then a bounded read of exactly byteLength
  // bytes at byteOffset. Lets long output be excerpted without rendering or
  // transferring the whole file. Ranges past the verified size fail closed.
  async verifiedByteRange(input: {
    readonly artifactId: string;
    readonly expectedSizeBytes: number;
    readonly expectedDigest: string;
    readonly byteOffset: number;
    readonly byteLength: number;
  }): Promise<VerifiedExcerptResult> {
    const { artifactId, expectedSizeBytes, expectedDigest, byteOffset, byteLength } = input;
    if (
      !OPAQUE_EVIDENCE_ID_PATTERN.test(artifactId) ||
      !Number.isSafeInteger(expectedSizeBytes) ||
      expectedSizeBytes < 0 ||
      !VERIFIED_DOWNLOAD_DIGEST_PATTERN.test(expectedDigest) ||
      !Number.isSafeInteger(byteOffset) ||
      byteOffset < 0 ||
      !Number.isSafeInteger(byteLength) ||
      byteLength <= 0 ||
      byteLength > VERIFIED_EXCERPT_MAX_BYTES ||
      byteOffset + byteLength > expectedSizeBytes
    ) {
      return { status: "corrupt", code: "invalid_download_request" };
    }
    if (!this.onTreeDirectoryMatches(this.published)) {
      return { status: "missing" };
    }
    const opened = this.binding.openAt(this.published.fd, artifactId, READ_FLAGS, 0);
    if (!opened.ok) {
      if (opened.errno === ERRNO.ENOENT) return { status: "missing" };
      if (opened.errno === ERRNO.ELOOP) {
        return { status: "corrupt", code: "artifact_symlink_rejected" };
      }
      return { status: "corrupt", code: mapOpenErrno(opened.errno) };
    }
    const fd = opened.fd;
    try {
      const stats = fstatOf(fd);
      if (stats === undefined) {
        return { status: "corrupt", code: "evidence_io_error" };
      }
      if (!stats.isFile()) {
        return { status: "corrupt", code: "artifact_not_regular_file" };
      }
      if (stats.nlink !== 1) {
        return { status: "corrupt", code: "artifact_hardlink_rejected" };
      }
      if (stats.dev !== this.rootDev) {
        return { status: "corrupt", code: "cross_filesystem_staging" };
      }
      if (stats.uid !== this.uid || (stats.mode & 0o777) !== 0o600) {
        return { status: "corrupt", code: "evidence_storage_invalid" };
      }
      if (stats.size !== expectedSizeBytes) {
        return { status: "corrupt", code: "size_mismatch" };
      }
      let hashed: { sizeBytes: number; digest: string };
      try {
        hashed = await hashDescriptor(fd);
      } catch {
        return { status: "corrupt", code: "evidence_io_error" };
      }
      if (hashed.sizeBytes !== expectedSizeBytes) {
        return { status: "corrupt", code: "size_mismatch" };
      }
      if (hashed.digest !== expectedDigest) {
        return { status: "corrupt", code: "digest_mismatch" };
      }
      const content = Buffer.allocUnsafe(byteLength);
      let position = 0;
      while (position < byteLength) {
        const read = await fdRead(fd, content, position, byteLength - position, byteOffset + position);
        if (read.bytesRead === 0) {
          return { status: "corrupt", code: "evidence_io_error" };
        }
        position += read.bytesRead;
      }
      return {
        status: "ready",
        totalBytes: hashed.sizeBytes,
        truncated: byteOffset + byteLength < hashed.sizeBytes,
        content: Buffer.from(content),
      };
    } finally {
      closeQuietly(fd);
    }
  }

  // Re-opens the on-tree managed directory through the evidence descriptor
  // and compares it to the held startup identity. A replaced directory fails
  // closed: the rename keeps targeting the verified inode, never the tree.
  private onTreeDirectoryMatches(directory: ManagedDirectory): boolean {
    const opened = this.binding.openAt(
      this.evidence.fd,
      directory === this.published ? "published" : "staging",
      DIRECTORY_FLAGS,
      0,
    );
    if (!opened.ok) return false;
    try {
      const stats = fstatOf(opened.fd);
      return (
        stats !== undefined &&
        stats.isDirectory() &&
        stats.dev === directory.identity.dev &&
        stats.ino === directory.identity.ino
      );
    } finally {
      closeQuietly(opened.fd);
    }
  }

}

function identityOf(stats: Stats | undefined): FileIdentity {
  if (stats === undefined) throw new Error("managed directory stat failed");
  return { dev: stats.dev, ino: stats.ino };
}

async function hashDescriptor(fd: number): Promise<{ sizeBytes: number; digest: string }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  for (;;) {
    const read = await fdRead(fd, chunk, 0, chunk.length, sizeBytes);
    if (read.bytesRead === 0) break;
    sizeBytes += read.bytesRead;
    hash.update(chunk.subarray(0, read.bytesRead));
  }
  return { sizeBytes, digest: `sha256:${hash.digest("hex")}` };
}
