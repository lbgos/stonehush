import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { chmod, link, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import type { ActionSnapshot, RunnerLease } from "@stonehush/contracts";
import {
  EngagementRepository,
  EvidenceGrantRepository,
  RunRepository,
  bindActionSnapshot,
  openEngagementDatabase,
  openReadOnlyEngagementDatabase,
} from "@stonehush/db";
import { loadEvidenceNative } from "@stonehush/evidence-native";
import { afterEach, describe, expect, it } from "vitest";

import { runEvidenceDoctor, type DoctorOutcome } from "./doctor.js";
import { EvidenceStore } from "./evidence-store.js";

const ARTIFACT_BYTES = "artifact-evidence-bytes";
const sha256 = (bytes: Buffer | string) =>
  `sha256:${createHash("sha256").update(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)).digest("hex")}`;
const ARTIFACT_DIGEST = sha256(ARTIFACT_BYTES);
const DOCTOR_NOW = new Date("2026-08-09T12:01:00.000Z");

const directories: string[] = [];

interface Fixture {
  readonly directory: string;
  readonly sqlite: ReturnType<typeof openEngagementDatabase>["sqlite"];
  readonly engagements: EngagementRepository;
  readonly runs: RunRepository;
  readonly grants: EvidenceGrantRepository;
  close(): void;
}

function createLayout(directory: string): void {
  const native = loadEvidenceNative();
  if (!native.ok) throw new Error(`native binding unavailable: ${native.reason}`);
  const storeResult = EvidenceStore.open(directory, native.binding);
  if (!storeResult.ok) throw new Error(`store open failed: ${storeResult.code}`);
  storeResult.store.close();
}

function createFixture(): Fixture {
  const directory = mkdtempSync(path.join(tmpdir(), "evidence-doctor-"));
  chmodSync(directory, 0o700);
  directories.push(directory);
  createLayout(directory);
  const database = openEngagementDatabase({ dataDirectory: directory });
  let engagementSeq = 0;
  const engagements = new EngagementRepository(database.db, {
    createId: () => `20000000-0000-4000-8000-${String(++engagementSeq).padStart(12, "0")}`,
    now: () => new Date("2026-08-09T12:00:00.000Z"),
  });
  let leaseSeq = 0;
  const runs = new RunRepository(database.db, {
    createId: () => `lease-doctor-${++leaseSeq}`,
    now: () => new Date("2026-08-09T12:00:00.000Z"),
  });
  let grantSeq = 0;
  const grants = new EvidenceGrantRepository(database.db, {
    createId: () => `a0000000-0000-4000-8000-${String(++grantSeq).padStart(12, "0")}`,
  });
  return {
    directory,
    sqlite: database.sqlite,
    engagements,
    runs,
    grants,
    close() {
      database.close();
    },
  };
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory === undefined) continue;
    chmodSync(directory, 0o700);
    rmSync(directory, { recursive: true, force: true });
  }
});

function boundSnapshot(actionId: string): ActionSnapshot {
  const snapshot: ActionSnapshot = {
    normalizationProfile: "d1-v1",
    orchestrationProfile: "d2-v1",
    snapshotId: `snapshot-${actionId}`,
    version: 1,
    binding: ARTIFACT_DIGEST,
    actionId,
    canonicalTargets: [
      { normalizationProfile: "d1-v1", kind: "hostname", hostname: "app.target.test" },
    ],
    concreteDestinations: [
      {
        normalizationProfile: "d1-v1",
        kind: "ip",
        family: 4,
        address: "192.0.2.40",
        zone: null,
      },
    ],
    typedOptions: { fixture: true },
    resolutionSnapshots: [
      {
        canonicalQueryName: "app.target.test",
        resolverMode: "system",
        cnameChain: [],
        answers: [{ address: "192.0.2.40", family: 4, ttlSeconds: 60 }],
        resolvedAt: "2026-08-09T11:59:00.000Z",
      },
    ],
    scopeRevisionId: null,
    warningState: { reasonCodes: [], knownAdditions: [], acknowledgment: null },
  };
  const bound = bindActionSnapshot(snapshot);
  if (!bound.ok) throw new Error(bound.error.code);
  return { ...snapshot, binding: bound.binding };
}

function queuedRunId(fixture: Fixture, actionId: string): string {
  const engagement = fixture.engagements.createEngagement({
    name: "Evidence doctor fixture lab",
    kind: "lab",
    description: null,
    authorizationContext: "Synthetic fixture authorization context",
    autoContinueWarnings: false,
  });
  if (!engagement.ok) throw new Error(engagement.error.code);
  const planned = fixture.engagements.persistPlannedAction({
    engagementId: engagement.value.id,
    snapshot: boundSnapshot(actionId),
    representable: true,
    capabilityErrorCode: null,
    occurredAt: "2026-08-09T12:00:00.000Z",
  });
  if (!planned.ok) throw new Error(planned.error.code);
  const row = fixture.sqlite
    .prepare("select id from runs where action_id = ?")
    .get(actionId) as { id: string } | undefined;
  if (row === undefined) throw new Error("queued run missing");
  return row.id;
}

function acquireLease(fixture: Fixture, runId: string): RunnerLease {
  const acquired = fixture.runs.acquireLease({
    runId,
    runnerId: "runner-doctor-1",
    sessionId: "session-doctor-1",
    serverNow: "2026-08-09T12:00:00.000Z",
  });
  if (!acquired.ok) throw new Error(acquired.error.code);
  return acquired.value.lease;
}

interface SeededArtifact {
  readonly artifactId: string;
  readonly uploadId: string;
  readonly lease: RunnerLease;
}

// Seeds a full chain (engagement -> action -> run -> lease -> in-progress
// grant) plus the published regular file and its committed artifact row.
async function seedPublishedArtifact(
  fixture: Fixture,
  overrides: {
    bytes?: string | Buffer;
    rowDigest?: string;
    rowSizeBytes?: number;
    skipFile?: boolean;
    keepGrantInProgress?: boolean;
  } = {},
): Promise<SeededArtifact> {
  const runId = queuedRunId(fixture, "action-doctor-fixture");
  const lease = acquireLease(fixture, runId);
  const grant = fixture.grants.createGrant({
    runId,
    leaseId: lease.leaseId,
    sessionId: lease.sessionId,
    fence: lease.fence,
    eventSequence: 1,
    artifactSlot: "tool-raw",
    kind: "tool_raw",
    runnerId: lease.runnerId,
    serverNow: "2026-08-09T12:00:01.000Z",
  });
  if (!grant.ok) throw new Error(grant.error.code);
  const { artifactId, uploadId } = grant.value;

  const bytes = overrides.bytes ?? ARTIFACT_BYTES;
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (!overrides.skipFile) {
    await writeFile(path.join(fixture.directory, "evidence/published", artifactId), buffer, {
      mode: 0o600,
    });
    await chmod(path.join(fixture.directory, "evidence/published", artifactId), 0o600);
  }

  fixture.sqlite
    .prepare(
      "insert into evidence_artifacts (contract_version, profile, artifact_id, run_id, fence, event_sequence, artifact_slot, kind, size_bytes, digest, relative_path, completeness, redaction_applied, redaction_boundary, raw_bytes_preserved, created_at) " +
        "values (1, 'd3-v1', ?, ?, ?, 1, 'tool-raw', 'tool_raw', ?, ?, ?, 'complete', 0, 'none', 1, 't')",
    )
    .run(
      artifactId,
      runId,
      lease.fence,
      overrides.rowSizeBytes ?? buffer.length,
      overrides.rowDigest ?? ARTIFACT_DIGEST,
      `published/${artifactId}`,
    );

  if (!overrides.keepGrantInProgress) {
    fixture.sqlite
      .prepare("update evidence_grants set state = 'published' where upload_id = ?")
      .run(uploadId);
  }
  return { artifactId, uploadId, lease };
}

async function runDoctor(
  fixture: Fixture,
  overrides: { now?: Date } = {},
): Promise<DoctorOutcome> {
  fixture.close();
  return runEvidenceDoctor({
    dataDirectory: fixture.directory,
    now: overrides.now ?? DOCTOR_NOW,
  });
}

// Snapshot of every byte in the data directory to prove doctor preserves
// files and database state exactly.
function treeFingerprint(directory: string): Map<string, string> {
  const fingerprint = new Map<string, string>();
  function walk(current: string, relative: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      const entryRelative = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath, entryRelative);
      } else {
        fingerprint.set(entryRelative, readFileSync(entryPath).toString("hex"));
      }
    }
  }
  walk(directory, ".");
  return fingerprint;
}

function findingCodes(outcome: DoctorOutcome): string[] {
  if (outcome.status !== "report") throw new Error(`unexpected error outcome: ${outcome.code}`);
  return outcome.report.findings.map((finding) => finding.code);
}

describe("runEvidenceDoctor", () => {
  it("reports healthy exactly once for a consistent tree and preserves every byte", async () => {
    const fixture = createFixture();
    await seedPublishedArtifact(fixture);
    fixture.close();

    // Fingerprint after the writer closes so the comparison isolates doctor
    // itself: a clean close checkpoints WAL into the database file.
    const before = treeFingerprint(fixture.directory);
    const outcome = await runEvidenceDoctor({
      dataDirectory: fixture.directory,
      now: DOCTOR_NOW,
    });
    const after = treeFingerprint(fixture.directory);

    expect([...before.keys()].sort()).toEqual(
      [...after.keys()].filter((name) => !name.endsWith("-wal") && !name.endsWith("-shm")).sort(),
    );
    for (const [name, hex] of before) {
      // A read-only SQLite connection may materialize empty shared-memory
      // sidecars; it must never change any existing byte on disk.
      if (after.has(name)) expect(after.get(name)).toBe(hex);
    }
    for (const name of ["./stonehush.sqlite3-wal", "./stonehush.sqlite3-shm"]) {
      const sidecar = after.get(name);
      if (sidecar !== undefined) expect(sidecar).toBe("");
    }

    expect(outcome).toEqual({
      status: "report",
      report: {
        profile: "d3-v1",
        healthy: true,
        fatal: false,
        findings: [{ code: "healthy" }],
      },
    });

    const repeat = await runEvidenceDoctor({ dataDirectory: fixture.directory, now: DOCTOR_NOW });
    expect(repeat).toEqual(outcome);
  });

  it("reports missing_artifact for a row whose published file is gone", async () => {
    const fixture = createFixture();
    const seeded = await seedPublishedArtifact(fixture, { skipFile: true });
    const outcome = await runDoctor(fixture);
    expect(outcome.status).toBe("report");
    if (outcome.status !== "report") return;
    expect(outcome.report.findings).toEqual([
      { code: "missing_artifact", artifactId: seeded.artifactId },
    ]);
    // The row is never deleted and the finding stays non-fatal.
    expect(outcome.report.fatal).toBe(false);
    const reader = openReadOnlyEngagementDatabase(fixture.directory);
    try {
      expect(
        reader.prepare("select count(*) as count from evidence_artifacts").get(),
      ).toEqual({ count: 1 });
    } finally {
      reader.close();
    }
  });

  it("reports corrupt_artifact for digest tampering without rewriting bytes", async () => {
    const fixture = createFixture();
    const seeded = await seedPublishedArtifact(fixture, { bytes: "tampered-payload!!!" });
    const filePath = path.join(fixture.directory, "evidence/published", seeded.artifactId);
    const beforeBytes = readFileSync(filePath);
    const outcome = await runDoctor(fixture);
    expect(findingCodes(outcome)).toEqual(["corrupt_artifact"]);
    expect(readFileSync(filePath).equals(beforeBytes)).toBe(true);
  });

  it("reports corrupt_artifact for a size mismatch even when hashing is skipped", async () => {
    const fixture = createFixture();
    await seedPublishedArtifact(fixture, { bytes: ARTIFACT_BYTES, rowSizeBytes: 999 });
    const outcome = await runDoctor(fixture);
    expect(findingCodes(outcome)).toEqual(["corrupt_artifact"]);
  });

  it("reports unsafe_ownership for a mode that is not 0600 without chmodding back", async () => {
    const fixture = createFixture();
    const seeded = await seedPublishedArtifact(fixture);
    const filePath = path.join(fixture.directory, "evidence/published", seeded.artifactId);
    await chmod(filePath, 0o644);
    const outcome = await runDoctor(fixture);
    expect(findingCodes(outcome)).toEqual(["unsafe_ownership"]);
    expect(statSync(filePath).mode & 0o777).toBe(0o644);
  });

  it.runIf(process.getuid?.() === 0)(
    "reports unsafe_ownership for a foreign owner without chowning",
    async () => {
      const fixture = createFixture();
      const seeded = await seedPublishedArtifact(fixture);
      const filePath = path.join(fixture.directory, "evidence/published", seeded.artifactId);
      const { chownSync } = await import("node:fs");
      chownSync(filePath, 65534, 65534);
      const outcome = await runDoctor(fixture);
      expect(findingCodes(outcome)).toEqual(["unsafe_ownership"]);
      expect(statSync(filePath).uid).toBe(65534);
    },
  );

  it("reports unsafe_link_count for a hard-linked published file without unlinking", async () => {
    const fixture = createFixture();
    const seeded = await seedPublishedArtifact(fixture);
    const filePath = path.join(fixture.directory, "evidence/published", seeded.artifactId);
    await link(filePath, path.join(fixture.directory, "evidence/published/twin-link"));
    const outcome = await runDoctor(fixture);
    expect(outcome.status).toBe("report");
    if (outcome.status !== "report") return;
    // Both names sharing the linked inode report their own truthful defect;
    // nothing is unlinked.
    expect(outcome.report.findings).toEqual([
      { code: "extra_artifact", artifactId: "twin-link" },
      { code: "unsafe_link_count", artifactId: seeded.artifactId },
      { code: "unsafe_link_count", artifactId: "twin-link" },
    ]);
    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(path.join(fixture.directory, "evidence/published/twin-link"))).toBe(true);
  });

  it("reports extra_artifact for an untracked published entry and never imports it", async () => {
    const fixture = createFixture();
    await seedPublishedArtifact(fixture);
    const reader = openReadOnlyEngagementDatabase(fixture.directory);
    try {
      expect(
        reader.prepare("select count(*) as count from evidence_artifacts").get(),
      ).toEqual({ count: 1 });
    } finally {
      reader.close();
    }
    await writeFile(
      path.join(fixture.directory, "evidence/published/untracked-extra"),
      "untracked",
      { mode: 0o600 },
    );
    const outcome = await runDoctor(fixture);
    expect(outcome.status).toBe("report");
    if (outcome.status !== "report") return;
    expect(outcome.report.findings).toContainEqual({
      code: "extra_artifact",
      artifactId: "untracked-extra",
    });
    // Doctor invents no rows for extras.
    const afterReader = openReadOnlyEngagementDatabase(fixture.directory);
    try {
      expect(
        afterReader.prepare("select count(*) as count from evidence_artifacts").get(),
      ).toEqual({ count: 1 });
    } finally {
      afterReader.close();
    }
  });

  it("reports orphan_staging for a staging entry without any grant", async () => {
    const fixture = createFixture();
    await seedPublishedArtifact(fixture);
    await mkdir(path.join(fixture.directory, "evidence/staging"), { recursive: true });
    await writeFile(path.join(fixture.directory, "evidence/staging/lost-upload"), "partial", {
      mode: 0o600,
    });
    const outcome = await runDoctor(fixture);
    expect(outcome.status).toBe("report");
    if (outcome.status !== "report") return;
    expect(outcome.report.findings).toContainEqual({
      code: "orphan_staging",
      uploadId: "lost-upload",
    });
    expect(existsSync(path.join(fixture.directory, "evidence/staging/lost-upload"))).toBe(true);
  });

  it("reports orphan_staging once the backing lease expired and never publishes it", async () => {
    const fixture = createFixture();
    await seedPublishedArtifact(fixture, { keepGrantInProgress: true });
    await writeFile(
      path.join(fixture.directory, "evidence/staging/upload-live"),
      "pending-bytes",
      { mode: 0o600 },
    );
    // No grant owns this upload id; the seeded grant's staging name differs.
    const outcome = await runDoctor(fixture, { now: new Date("2030-01-01T00:00:00.000Z") });
    expect(outcome.status).toBe("report");
    if (outcome.status !== "report") return;
    expect(outcome.report.findings).toEqual([
      { code: "orphan_staging", uploadId: "upload-live" },
    ]);
  });

  it("keeps a staging entry backed by an unexpired in_progress grant out of the findings", async () => {
    const fixture = createFixture();
    const seeded = await seedPublishedArtifact(fixture, { keepGrantInProgress: true });
    await writeFile(
      path.join(fixture.directory, "evidence/staging", seeded.uploadId),
      "pending-bytes",
      { mode: 0o600 },
    );
    // The lease lives for 30 seconds from acquisition at 12:00:00.
    const outcome = await runEvidenceDoctor({
      dataDirectory: fixture.directory,
      now: new Date("2026-08-09T12:00:10.000Z"),
    });
    expect(findingCodes(outcome)).toEqual(["healthy"]);
  });

  it("reports a fatal path_escape for a row whose relativePath leaves the managed root", async () => {
    const fixture = createFixture();
    const runId = queuedRunId(fixture, "action-doctor-fixture");
    const lease = acquireLease(fixture, runId);
    // Simulated tampering: bypass table CHECKs exactly like an out-of-band
    // editor would, then verify doctor still catches the containment break.
    fixture.sqlite.pragma("ignore_check_constraints = 1");
    fixture.sqlite
      .prepare(
        "insert into evidence_artifacts (contract_version, profile, artifact_id, run_id, fence, event_sequence, artifact_slot, kind, size_bytes, digest, relative_path, completeness, redaction_applied, redaction_boundary, raw_bytes_preserved, created_at) " +
          "values (1, 'd3-v1', 'escape-row', ?, ?, 1, 'tool-raw', 'tool_raw', 5, ?, 'published/../../outside', 'complete', 0, 'none', 1, 't')",
      )
      .run(runId, lease.fence, ARTIFACT_DIGEST);
    fixture.sqlite.pragma("ignore_check_constraints = 0");

    const outcome = await runDoctor(fixture);
    expect(outcome.status).toBe("report");
    if (outcome.status !== "report") return;
    expect(outcome.report.findings).toEqual([{ code: "path_escape", artifactId: "escape-row" }]);
    expect(outcome.report.fatal).toBe(true);
  });

  it("reports a fatal path_escape for a symlink planted at the published name", async () => {
    const fixture = createFixture();
    const seeded = await seedPublishedArtifact(fixture, { skipFile: true });
    const outside = path.join(fixture.directory, "outside-secret");
    await writeFile(outside, "outside-bytes", { mode: 0o600 });
    symlinkSync(outside, path.join(fixture.directory, "evidence/published", seeded.artifactId));
    const outcome = await runDoctor(fixture);
    expect(outcome.status).toBe("report");
    if (outcome.status !== "report") return;
    expect(outcome.report.findings).toEqual([
      { code: "path_escape", artifactId: seeded.artifactId },
    ]);
    expect(outcome.report.fatal).toBe(true);
    // The symlink itself is untouched.
    expect(
      lstatSync(path.join(fixture.directory, "evidence/published", seeded.artifactId)).isSymbolicLink(),
    ).toBe(true);
  });

  it("fails closed with corrupt_artifact for a non-regular published entry", async () => {
    const fixture = createFixture();
    const seeded = await seedPublishedArtifact(fixture);
    const fifoPath = path.join(fixture.directory, "evidence/published", seeded.artifactId);
    unlinkSync(fifoPath);
    execFileSync("mkfifo", [fifoPath]);
    const outcome = await runDoctor(fixture);
    expect(findingCodes(outcome)).toEqual(["corrupt_artifact"]);
  });

  it("reports a fatal path_escape when a managed directory was replaced by a symlink", async () => {
    const fixture = createFixture();
    await seedPublishedArtifact(fixture);
    fixture.close();
    const publishedDir = path.join(fixture.directory, "evidence/published");
    const staged = path.join(fixture.directory, "evidence/moved-published");
    renameSync(publishedDir, staged);
    symlinkSync(staged, publishedDir);
    const outcome = await runEvidenceDoctor({ dataDirectory: fixture.directory, now: DOCTOR_NOW });
    expect(outcome).toEqual({
      status: "report",
      report: {
        profile: "d3-v1",
        healthy: false,
        fatal: true,
        findings: [{ code: "path_escape" }],
      },
    });
  });

  it("errors on a missing managed directory instead of creating one", async () => {
    const fixture = createFixture();
    await seedPublishedArtifact(fixture);
    fixture.close();
    rmSync(path.join(fixture.directory, "evidence/staging"), { recursive: true });
    const outcome = await runEvidenceDoctor({ dataDirectory: fixture.directory, now: DOCTOR_NOW });
    expect(outcome).toEqual({ status: "error", code: "managed_directory_invalid" });
    expect(existsSync(path.join(fixture.directory, "evidence/staging"))).toBe(false);
  });

  it("errors when the SQLite database is missing entirely", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "evidence-doctor-empty-"));
    chmodSync(directory, 0o700);
    directories.push(directory);
    createLayout(directory);
    const outcome = await runEvidenceDoctor({ dataDirectory: directory, now: DOCTOR_NOW });
    expect(outcome).toEqual({ status: "error", code: "database_unavailable" });
  });

  it("errors closed on SQLite foreign key violations", async () => {
    const fixture = createFixture();
    await seedPublishedArtifact(fixture);
    fixture.sqlite.pragma("foreign_keys = OFF");
    fixture.sqlite
      .prepare(
        "insert into evidence_artifacts (contract_version, profile, artifact_id, run_id, fence, event_sequence, artifact_slot, kind, size_bytes, digest, relative_path, completeness, redaction_applied, redaction_boundary, raw_bytes_preserved, created_at) " +
          "values (1, 'd3-v1', 'fk-orphan-row', 'run-does-not-exist', '1', 9, 'tool-raw', 'tool_raw', 5, ?, 'published/fk-orphan-row', 'complete', 0, 'none', 1, 't')",
      )
      .run(ARTIFACT_DIGEST);
    fixture.sqlite.pragma("foreign_keys = ON");

    const outcome = await runDoctor(fixture);
    expect(outcome).toEqual({ status: "error", code: "database_foreign_key_violation" });
  });

  it("reports a fatal path_escape for an extra published symlink", async () => {
    const fixture = createFixture();
    await seedPublishedArtifact(fixture);
    const outside = path.join(fixture.directory, "outside-extra");
    await writeFile(outside, "outside-bytes", { mode: 0o600 });
    symlinkSync(
      outside,
      path.join(fixture.directory, "evidence/published/planted-link"),
    );
    const outcome = await runDoctor(fixture);
    expect(outcome.status).toBe("report");
    if (outcome.status !== "report") return;
    // A symlink is a containment failure, never a plain extra_artifact.
    expect(outcome.report.findings).toEqual([
      { code: "path_escape", artifactId: "planted-link" },
    ]);
    expect(outcome.report.fatal).toBe(true);
  });

  it("reports a fatal path_escape for a staging symlink behind an unexpired grant", async () => {
    const fixture = createFixture();
    const seeded = await seedPublishedArtifact(fixture, { keepGrantInProgress: true });
    const outside = path.join(fixture.directory, "outside-staged");
    await writeFile(outside, "outside-bytes", { mode: 0o600 });
    symlinkSync(
      outside,
      path.join(fixture.directory, "evidence/staging", seeded.uploadId),
    );
    // Lease acquired at 12:00:00 lives 30 seconds; doctor runs inside it.
    const outcome = await runEvidenceDoctor({
      dataDirectory: fixture.directory,
      now: new Date("2026-08-09T12:00:10.000Z"),
    });
    fixture.close();
    expect(outcome.status).toBe("report");
    if (outcome.status !== "report") return;
    // The live grant cannot vouch for a name the kernel proves is a symlink.
    expect(outcome.report.findings).toEqual([
      { code: "path_escape", uploadId: seeded.uploadId },
    ]);
    expect(outcome.report.fatal).toBe(true);
    expect(lstatSync(path.join(fixture.directory, "evidence/staging", seeded.uploadId)).isSymbolicLink()).toBe(true);
  });

  it("never treats a non-regular staging entry as healthy even with a live grant", async () => {
    const fixture = createFixture();
    const seeded = await seedPublishedArtifact(fixture, { keepGrantInProgress: true });
    const fifoPath = path.join(fixture.directory, "evidence/staging", seeded.uploadId);
    execFileSync("mkfifo", [fifoPath]);
    const outcome = await runEvidenceDoctor({
      dataDirectory: fixture.directory,
      now: new Date("2026-08-09T12:00:10.000Z"),
    });
    fixture.close();
    expect(outcome.status).toBe("report");
    if (outcome.status !== "report") return;
    expect(outcome.report.findings).toEqual([
      { code: "orphan_staging", uploadId: seeded.uploadId },
    ]);
    expect(outcome.report.healthy).toBe(false);
  });

  it("reports unsafe_ownership for a grant-backed staging file that is not mode 0600", async () => {
    const fixture = createFixture();
    const seeded = await seedPublishedArtifact(fixture, { keepGrantInProgress: true });
    const stagedPath = path.join(fixture.directory, "evidence/staging", seeded.uploadId);
    await writeFile(stagedPath, "pending-bytes", { mode: 0o600 });
    await chmod(stagedPath, 0o644);
    const outcome = await runEvidenceDoctor({
      dataDirectory: fixture.directory,
      now: new Date("2026-08-09T12:00:10.000Z"),
    });
    fixture.close();
    expect(outcome.status).toBe("report");
    if (outcome.status !== "report") return;
    expect(outcome.report.findings).toEqual([
      { code: "unsafe_ownership", uploadId: seeded.uploadId },
    ]);
    expect(statSync(stagedPath).mode & 0o777).toBe(0o644);
  });

  it("reports unsafe_link_count for a hard-linked grant-backed staging file", async () => {
    const fixture = createFixture();
    const seeded = await seedPublishedArtifact(fixture, { keepGrantInProgress: true });
    const stagedPath = path.join(fixture.directory, "evidence/staging", seeded.uploadId);
    await writeFile(stagedPath, "pending-bytes", { mode: 0o600 });
    await link(stagedPath, path.join(fixture.directory, "evidence/staging/stage-twin"));
    const outcome = await runEvidenceDoctor({
      dataDirectory: fixture.directory,
      now: new Date("2026-08-09T12:00:10.000Z"),
    });
    fixture.close();
    expect(outcome.status).toBe("report");
    if (outcome.status !== "report") return;
    // The twin has no grant (orphan) and both names carry nlink 2.
    expect(outcome.report.findings).toEqual([
      { code: "orphan_staging", uploadId: "stage-twin" },
      { code: "unsafe_link_count", uploadId: seeded.uploadId },
    ]);
    expect(existsSync(stagedPath)).toBe(true);
  });

  it("errors closed when an enumerated published entry vanishes mid-scan", async () => {
    const fixture = createFixture();
    await seedPublishedArtifact(fixture);
    const plantedPath = path.join(fixture.directory, "evidence/published/vanishing-extra");
    await writeFile(plantedPath, "here-then-gone", { mode: 0o600 });
    fixture.close();

    // Wrap the native binding so the extra exists at readdir time but is
    // gone before its revalidating openat, deterministically emulating the
    // disappearance race window.
    const native = loadEvidenceNative();
    if (!native.ok) throw new Error(`native binding unavailable: ${native.reason}`);
    let deletedAfterListing = false;
    const racingBinding = {
      ...native.binding,
      readDirNames: (dirfd: number) => {
        const listed = native.binding.readDirNames(dirfd);
        if (listed.ok && !deletedAfterListing && existsSync(plantedPath)) {
          unlinkSync(plantedPath);
          deletedAfterListing = true;
        }
        return listed;
      },
    };
    const outcome = await runEvidenceDoctor({
      dataDirectory: fixture.directory,
      now: DOCTOR_NOW,
      nativeBinding: racingBinding,
    });
    expect(deletedAfterListing).toBe(true);
    expect(outcome).toEqual({ status: "error", code: "storage_changed_during_scan" });
  });
});
