import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  read as cbRead,
} from "node:fs";
import { promisify } from "node:util";

import { OPAQUE_EVIDENCE_ID_PATTERN } from "@stonehush/contracts";
import { openReadOnlyEngagementDatabase } from "@stonehush/db";
import { O_CLOEXEC, loadEvidenceNative } from "@stonehush/evidence-native";

// ADR-0003 `stonehush doctor` evidence check: strictly read-only integrity
// verification of the managed evidence tree plus the SQLite metadata. Every
// filesystem decision starts at startup-opened directory descriptors and
// walks no-follow through the native binding; nothing is ever rewritten,
// restat-as-repaired, chowned, deleted, migrated, or created. Findings carry
// artifact/upload IDs only, never physical paths.

// O_NONBLOCK is a no-op for regular files but keeps the probe from ever
// blocking on a planted FIFO or device inode; the fstat below rejects any
// non-regular entry before a single byte is read.
const READ_FLAGS =
  fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | O_CLOEXEC;
const DIRECTORY_FLAGS =
  fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | O_CLOEXEC;

const fdRead = promisify(cbRead) as (
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number | null,
) => Promise<{ bytesRead: number }>;

type NativeBinding = Extract<ReturnType<typeof loadEvidenceNative>, { ok: true }>["binding"];
type ReadOnlySqlite = ReturnType<typeof openReadOnlyEngagementDatabase>;

const ERRNO = {
  ENOENT: 2,
  ELOOP: 40,
} as const;

// Pinned ADR-0003 taxonomy. `healthy` is emitted only when no defect exists.
export type DoctorFindingCode =
  | "healthy"
  | "missing_artifact"
  | "corrupt_artifact"
  | "unsafe_ownership"
  | "unsafe_link_count"
  | "extra_artifact"
  | "orphan_staging"
  | "path_escape";

export interface DoctorFinding {
  readonly code: Exclude<DoctorFindingCode, "healthy">;
  readonly artifactId?: string;
  readonly uploadId?: string;
}

export interface DoctorReport {
  readonly profile: "d3-v1";
  readonly healthy: boolean;
  // `path_escape` and every error outcome are fatal for serving.
  readonly fatal: boolean;
  readonly findings: readonly ({ readonly code: "healthy" } | DoctorFinding)[];
}

// Operational failures outside the pinned taxonomy: doctor cannot even form
// a trustworthy view. All of them fail closed and are fatal for serving.
export type DoctorErrorCode =
  | "storage_unavailable"
  | "managed_directory_invalid"
  | "database_unavailable"
  | "database_foreign_key_violation"
  | "evidence_scan_failed"
  | "storage_changed_during_scan";

export type DoctorOutcome =
  | { readonly status: "report"; readonly report: DoctorReport }
  | { readonly status: "error"; readonly code: DoctorErrorCode };

export interface EvidenceDoctorInput {
  readonly dataDirectory: string;
  readonly now?: Date;
  readonly getCurrentUid?: () => number | undefined;
  // Test seam: defaults to the real native binding. Callers cannot weaken
  // the descriptor-relative guarantees, only observe or wrap them.
  readonly nativeBinding?: NativeBinding;
}

interface ArtifactRow {
  readonly artifactId: string;
  readonly sizeBytes: number;
  readonly digest: string;
  readonly relativePath: string;
}

interface StagingGrant {
  readonly uploadId: string;
  // Null when no current lease binds the grant anymore.
  readonly leaseExpiresAt: string | null;
}

class DoctorScan {
  private readonly defects: DoctorFinding[] = [];

  add(finding: DoctorFinding): void {
    this.defects.push(finding);
  }

  hasEscape(): boolean {
    return this.defects.some((defect) => defect.code === "path_escape");
  }

  report(): DoctorReport {
    if (this.defects.length === 0) {
      return { profile: "d3-v1", healthy: true, fatal: false, findings: [{ code: "healthy" }] };
    }
    const findings = [...this.defects].sort((left, right) => {
      // Byte-wise ordering keeps output deterministic across locales.
      const codeOrder =
        left.code < right.code ? -1 : left.code > right.code ? 1 : 0;
      if (codeOrder !== 0) return codeOrder;
      const leftId = left.artifactId ?? left.uploadId ?? "";
      const rightId = right.artifactId ?? right.uploadId ?? "";
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
    return {
      profile: "d3-v1",
      healthy: false,
      fatal: this.hasEscape(),
      findings,
    };
  }
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Best-effort close; nothing actionable remains.
  }
}

function statOf(fd: number) {
  try {
    return fstatSync(fd);
  } catch {
    return undefined;
  }
}

function isManagedSegment(name: string): boolean {
  return OPAQUE_EVIDENCE_ID_PATTERN.test(name);
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

// Opens the managed tree relative to the data directory without creating or
// repairing anything. Returns the startup descriptors plus their shared
// device, or a typed failure. A child that opens but fails containment
// (symlink, non-directory, wrong owner or mode, off-device) yields
// `path_escape` in the scan because the resolved location cannot be proven
// to stay inside the managed root.
function openManagedTree(
  dataDirectory: string,
  binding: NativeBinding,
  uid: number,
): {
  ok: true;
  rootFd: number;
  evidenceFd: number;
  publishedFd: number;
  stagingFd: number;
  rootDev: number;
} | { ok: false; escape: boolean } {
  let rootFd: number;
  try {
    rootFd = openSync(dataDirectory, DIRECTORY_FLAGS);
  } catch {
    return { ok: false, escape: false };
  }
  const held: number[] = [];
  try {
    const rootStats = statOf(rootFd);
    if (rootStats === undefined || !rootStats.isDirectory()) {
      return { ok: false, escape: false };
    }
    const rootDev = rootStats.dev;

    // Opens one child relative to its parent and enforces the managed
    // directory invariants: directory type, control-plane owner, mode 0700,
    // same device as the managed root. A planted symlink (ELOOP) or a
    // replaced non-directory fails containment into `path_escape`.
    function openChild(parentFd: number, name: "evidence" | "published" | "staging"):
      { ok: true; fd: number } | { ok: false; escape: boolean } {
      const opened = binding.openAt(parentFd, name, DIRECTORY_FLAGS, 0);
      if (!opened.ok) {
        return { ok: false, escape: opened.errno !== ERRNO.ENOENT };
      }
      const stats = statOf(opened.fd);
      if (
        stats === undefined ||
        !stats.isDirectory() ||
        stats.uid !== uid ||
        (stats.mode & 0o777) !== 0o700 ||
        stats.dev !== rootDev
      ) {
        closeQuietly(opened.fd);
        return { ok: false, escape: true };
      }
      held.push(opened.fd);
      return { ok: true, fd: opened.fd };
    }

    const evidence = openChild(rootFd, "evidence");
    if (!evidence.ok) return { ok: false, escape: evidence.escape };
    const published = openChild(evidence.fd, "published");
    if (!published.ok) return { ok: false, escape: published.escape };
    const staging = openChild(evidence.fd, "staging");
    if (!staging.ok) return { ok: false, escape: staging.escape };

    // Ownership of the kept descriptors transfers to the caller.
    return {
      ok: true,
      rootFd,
      evidenceFd: evidence.fd,
      publishedFd: published.fd,
      stagingFd: staging.fd,
      rootDev,
    };
  } finally {
    if (held.length < 3) {
      for (const fd of held) closeQuietly(fd);
      closeQuietly(rootFd);
    }
  }
}

// Re-opens each managed directory through the held evidence/root descriptors
// and compares identities against the startup fds so a mid-scan replacement
// invalidates the whole verdict instead of partially trusting it.
function treeIdentityMatches(
  binding: NativeBinding,
  rootFd: number,
  evidenceFd: number,
  publishedFd: number,
  stagingFd: number,
): boolean {
  function matches(parentFd: number, name: "evidence" | "published" | "staging", expectedFd: number): boolean {
    const opened = binding.openAt(parentFd, name, DIRECTORY_FLAGS, 0);
    if (!opened.ok) return false;
    try {
      const expected = statOf(expectedFd);
      const actual = statOf(opened.fd);
      return (
        expected !== undefined &&
        actual !== undefined &&
        actual.isDirectory() &&
        actual.dev === expected.dev &&
        actual.ino === expected.ino
      );
    } finally {
      closeQuietly(opened.fd);
    }
  }
  return (
    matches(rootFd, "evidence", evidenceFd) &&
    matches(evidenceFd, "published", publishedFd) &&
    matches(evidenceFd, "staging", stagingFd)
  );
}

/**
 * Runs the read-only ADR-0003 doctor evidence check over one data directory.
 * Never writes, repairs, deletes, creates, migrates, or chmods anything; the
 * SQLite file is opened read-only without migrations. Verifies every
 * evidence_artifacts row against exactly `published/{artifactId}` (regular
 * file, managed-root device, control-plane owner, mode 0600, nlink 1,
 * streaming SHA-256 and size), every published entry has a row, every
 * staging entry belongs to an unexpired in_progress grant, and SQLite
 * foreign keys hold. Output carries IDs only, never paths.
 */
export async function runEvidenceDoctor(input: EvidenceDoctorInput): Promise<DoctorOutcome> {
  const getCurrentUid = input.getCurrentUid ?? (() =>
    typeof process.getuid === "function" ? process.getuid() : undefined);
  const uid = getCurrentUid();
  if (uid === undefined) return { status: "error", code: "storage_unavailable" };

  const native = loadEvidenceNative();
  if (!native.ok) return { status: "error", code: "storage_unavailable" };
  const binding = input.nativeBinding ?? native.binding;

  const tree = openManagedTree(input.dataDirectory, binding, uid);
  if (!tree.ok) {
    if (tree.escape) {
      return {
        status: "report",
        report: {
          profile: "d3-v1",
          healthy: false,
          fatal: true,
          findings: [{ code: "path_escape" }],
        },
      };
    }
    return { status: "error", code: "managed_directory_invalid" };
  }
  const { rootFd, evidenceFd, publishedFd, stagingFd, rootDev } = tree;

  let sqlite: ReadOnlySqlite;
  try {
    sqlite = openReadOnlyEngagementDatabase(input.dataDirectory);
  } catch {
    closeQuietly(publishedFd);
    closeQuietly(stagingFd);
    closeQuietly(evidenceFd);
    closeQuietly(rootFd);
    return { status: "error", code: "database_unavailable" };
  }

  try {
    const nowIso = (input.now ?? new Date()).toISOString();
    const foreignKeyViolations = sqlite.pragma("foreign_key_check") as unknown[];
    if (foreignKeyViolations.length > 0) {
      return { status: "error", code: "database_foreign_key_violation" };
    }

    // Any read failure here (corrupt schema, truncated page) fails closed
    // into a typed error instead of throwing past the caller.
    let artifactRows: ArtifactRow[];
    let unexpiredUploads: Set<string>;
    try {
      artifactRows = sqlite
        .prepare(
          "select artifact_id as artifactId, size_bytes as sizeBytes, digest as digest, relative_path as relativePath from evidence_artifacts order by artifact_id",
        )
        .all() as ArtifactRow[];

      const stagingGrants = sqlite
        .prepare(
          "select g.upload_id as uploadId, l.expires_at as leaseExpiresAt " +
            "from evidence_grants g " +
            "left join run_leases l on l.lease_id = g.lease_id and l.run_id = g.run_id and l.current = 1 " +
            "where g.state = 'in_progress'",
        )
        .all() as StagingGrant[];
      unexpiredUploads = new Set(
        stagingGrants
          .filter((grant) => grant.leaseExpiresAt !== null && grant.leaseExpiresAt > nowIso)
          .map((grant) => grant.uploadId),
      );
    } catch {
      return { status: "error", code: "database_unavailable" };
    }

    const scan = new DoctorScan();
    const seenArtifacts = new Set<string>();

    for (const row of artifactRows) {
      seenArtifacts.add(row.artifactId);
      // Containment first: the row must name exactly published/{artifactId}
      // with a safe single-segment ID. Anything else is a traversal attempt
      // even if the bytes themselves are intact.
      if (!isManagedSegment(row.artifactId) || row.relativePath !== `published/${row.artifactId}`) {
        scan.add({ code: "path_escape", ...(isManagedSegment(row.artifactId) ? { artifactId: row.artifactId } : {}) });
        continue;
      }
      const defect = await inspectPublishedFile(binding, publishedFd, {
        artifactId: row.artifactId,
        expectedSizeBytes: row.sizeBytes,
        expectedDigest: row.digest,
        rootDev,
        uid,
      });
      if (defect !== undefined) {
        scan.add({ code: defect, artifactId: row.artifactId });
      }
    }

    const publishedListed = binding.readDirNames(publishedFd);
    if (!publishedListed.ok) {
      return { status: "error", code: "evidence_scan_failed" };
    }
    for (const name of publishedListed.names) {
      // Rows already went through the full openat/fstat/hash inspection;
      // skipping them avoids duplicate defects for the same inode.
      if (seenArtifacts.has(name)) continue;
      const idFields = isManagedSegment(name) ? { artifactId: name } : {};
      const inspection = inspectEnumeratedEntry(binding, publishedFd, name, uid, rootDev);
      if (inspection.status === "escape") {
        scan.add({ code: "path_escape", ...idFields });
        continue;
      }
      if (inspection.status === "vanished") {
        return { status: "error", code: "storage_changed_during_scan" };
      }
      if (inspection.status === "io") {
        return { status: "error", code: "evidence_scan_failed" };
      }
      // Untracked published entries stay extras regardless of metadata, but
      // hard-linking or tampered owner/mode reports its own defect too.
      if (inspection.regular && inspection.nlink !== 1) {
        scan.add({ code: "unsafe_link_count", ...idFields });
      }
      if (inspection.regular && !inspection.ownedAndSealed) {
        scan.add({ code: "unsafe_ownership", ...idFields });
      }
      scan.add({ code: "extra_artifact", ...idFields });
    }

    const stagingListed = binding.readDirNames(stagingFd);
    if (!stagingListed.ok) {
      return { status: "error", code: "evidence_scan_failed" };
    }
    for (const name of stagingListed.names) {
      // Every enumerated staging entry is reopened through the held staging
      // descriptor: a grant never vouches for a name the kernel has not
      // proven to be a managed regular file.
      const idFields = isManagedSegment(name) ? { uploadId: name } : {};
      const inspection = inspectEnumeratedEntry(binding, stagingFd, name, uid, rootDev);
      if (inspection.status === "escape") {
        scan.add({ code: "path_escape", ...idFields });
        continue;
      }
      if (inspection.status === "vanished") {
        return { status: "error", code: "storage_changed_during_scan" };
      }
      if (inspection.status === "io") {
        return { status: "error", code: "evidence_scan_failed" };
      }
      // A live unexpired in_progress grant keeps an entry out of the
      // findings only when it is a regular managed file with nlink 1,
      // control-plane owner, and mode 0600; anything else is never healthy.
      if (!inspection.regular || !unexpiredUploads.has(name)) {
        scan.add({ code: "orphan_staging", ...idFields });
        continue;
      }
      if (inspection.nlink !== 1) {
        scan.add({ code: "unsafe_link_count", ...idFields });
      }
      if (!inspection.ownedAndSealed) {
        scan.add({ code: "unsafe_ownership", ...idFields });
      }
    }

    // A replaced managed directory after scanning means the verdict was
    // formed over a tree the control plane no longer holds: fail closed.
    if (!treeIdentityMatches(binding, rootFd, evidenceFd, publishedFd, stagingFd)) {
      return { status: "error", code: "storage_changed_during_scan" };
    }

    return { status: "report", report: scan.report() };
  } finally {
    sqlite.close();
    closeQuietly(publishedFd);
    closeQuietly(stagingFd);
    closeQuietly(evidenceFd);
    closeQuietly(rootFd);
  }
}

// Revalidates one enumerated name through the held directory descriptor with
// openat(O_NOFOLLOW|O_NONBLOCK) and fstat, exactly as the assignment
// requires. Enumeration names are untrusted; nothing here touches a path.
// Vanished entries and other errnos fail closed into error outcomes at the
// call sites so a mutating tree can never yield a misleading report.
type EnumeratedEntryInspection =
  | { status: "ok"; regular: boolean; nlink: number; ownedAndSealed: boolean }
  // Symlink at the leaf or an inode off the managed-root device: the entry
  // cannot be proven to stay inside the managed root.
  | { status: "escape" }
  // The name disappeared between enumeration and reopen: concurrent tree
  // mutation invalidates the whole verdict.
  | { status: "vanished" }
  // Any other errno or stat failure.
  | { status: "io" };

function inspectEnumeratedEntry(
  binding: NativeBinding,
  dirFd: number,
  name: string,
  uid: number,
  rootDev: number,
): EnumeratedEntryInspection {
  const opened = binding.openAt(dirFd, name, READ_FLAGS, 0);
  if (!opened.ok) {
    if (opened.errno === ERRNO.ENOENT) return { status: "vanished" };
    if (opened.errno === ERRNO.ELOOP) return { status: "escape" };
    return { status: "io" };
  }
  try {
    const stats = statOf(opened.fd);
    if (stats === undefined) return { status: "io" };
    if (!stats.isFile()) return { status: "ok", regular: false, nlink: stats.nlink, ownedAndSealed: false };
    // Off-device inodes cannot be proven to stay inside the managed root.
    if (stats.dev !== rootDev) return { status: "escape" };
    return {
      status: "ok",
      regular: true,
      nlink: stats.nlink,
      ownedAndSealed: stats.uid === uid && (stats.mode & 0o777) === 0o600,
    };
  } finally {
    closeQuietly(opened.fd);
  }
}

// Maps race and IO inspection failures to fail-closed error outcomes so a
// mutating tree can never yield a misleading report. Vanished entries become
// `storage_changed_during_scan`; other errnos become `evidence_scan_failed`.

async function inspectPublishedFile(
  binding: NativeBinding,
  publishedFd: number,
  input: {
    artifactId: string;
    expectedSizeBytes: number;
    expectedDigest: string;
    rootDev: number;
    uid: number;
  },
): Promise<DoctorFinding["code"] | undefined> {
  const opened = binding.openAt(publishedFd, input.artifactId, READ_FLAGS, 0);
  if (!opened.ok) {
    if (opened.errno === ERRNO.ENOENT) return "missing_artifact";
    if (opened.errno === ERRNO.ELOOP) return "path_escape";
    return "corrupt_artifact";
  }
  try {
    const stats = statOf(opened.fd);
    if (stats === undefined) return "corrupt_artifact";
    if (!stats.isFile()) return "corrupt_artifact";
    if (stats.dev !== input.rootDev) return "path_escape";
    if (stats.nlink !== 1) return "unsafe_link_count";
    if (stats.uid !== input.uid || (stats.mode & 0o777) !== 0o600) return "unsafe_ownership";
    if (stats.size !== input.expectedSizeBytes) return "corrupt_artifact";
    const hashed = await hashDescriptor(opened.fd);
    if (hashed.sizeBytes !== input.expectedSizeBytes || hashed.digest !== input.expectedDigest) {
      return "corrupt_artifact";
    }
    return undefined;
  } catch {
    return "corrupt_artifact";
  } finally {
    closeQuietly(opened.fd);
  }
}
