import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BACKUP_INCOMPLETE_MARKER_FILENAME,
  BACKUP_MANIFEST_FILENAME,
  BackupManifestSchema,
  formatRunnerAuthorization,
  type ActionSnapshot,
  type RunnerLease,
} from "@stonehush/contracts";
import {
  DATABASE_SCHEMA_VERSION,
  bindActionSnapshot,
  EngagementRepository,
  EvidenceGrantRepository,
  OperatorCommandRepository,
  openEngagementDatabase,
  RunRepository,
  RunnerRepository,
} from "@stonehush/db";
import { loadEvidenceNative } from "@stonehush/evidence-native";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { runEvidenceDoctor } from "./doctor.js";
import { BackupLock } from "./backup-lock.js";
import { runBackup, runRestore } from "./backup-restore.js";
import { EvidencePublicationService } from "./evidence-publication.js";
import { EvidenceStore } from "./evidence-store.js";

const fixtureFingerprint =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const directories: string[] = [];
const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await chmod(directory, 0o700).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

function sha256(bytes: string | Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function boundSnapshot(actionId: string): ActionSnapshot {
  const snapshot: ActionSnapshot = {
    normalizationProfile: "d1-v1",
    orchestrationProfile: "d2-v1",
    snapshotId: `snapshot-${actionId}`,
    version: 1,
    binding: `sha256:${"a".repeat(64)}`,
    actionId,
    canonicalTargets: [
      {
        normalizationProfile: "d1-v1",
        kind: "hostname",
        hostname: "app.target.test",
      },
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
    warningState: {
      reasonCodes: [],
      knownAdditions: [],
      acknowledgment: null,
    },
  };
  const bound = bindActionSnapshot(snapshot);
  if (!bound.ok) throw new Error(bound.error.code);
  return { ...snapshot, binding: bound.binding };
}

interface Harness {
  directory: string;
  app: ReturnType<typeof buildApp>;
  database: ReturnType<typeof openEngagementDatabase>;
  engagementRepository: EngagementRepository;
  runRepository: RunRepository;
  lock: BackupLock;
}

async function createLiveTree(): Promise<Harness> {
  const native = loadEvidenceNative();
  if (!native.ok) throw new Error(`native binding unavailable: ${native.reason}`);
  const directory = await mkdtemp(path.join(tmpdir(), "backup-live-"));
  await chmod(directory, 0o700);
  directories.push(directory);
  const storeResult = EvidenceStore.open(directory, native.binding);
  if (!storeResult.ok) throw new Error(`store open failed: ${storeResult.code}`);

  const database = openEngagementDatabase({ dataDirectory: directory });
  let engagementSeq = 0;
  let leaseSeq = 0;
  const clock = () => new Date("2026-08-09T12:00:00.000Z");
  const engagementRepository = new EngagementRepository(database.db, {
    createId: () =>
      `10000000-0000-4000-8000-${String(++engagementSeq).padStart(12, "0")}`,
    now: clock,
  });
  const runRepository = new RunRepository(database.db, {
    createId: () => `lease-fixture-${++leaseSeq}`,
    now: clock,
  });
  const runnerRepository = new RunnerRepository(database.db, { now: clock });
  const evidenceGrantRepository = new EvidenceGrantRepository(database.db, {
    now: clock,
  });
  const lockResult = BackupLock.open(directory, native.binding);
  if (!lockResult.ok) throw new Error("backup lock unavailable");
  const app = buildApp({
    engagementRepository,
    operatorCommandRepository: new OperatorCommandRepository(
      engagementRepository,
      { now: clock },
    ),
    runRepository,
    runnerRepository,
    evidenceGrantRepository,
    evidencePublication: new EvidencePublicationService({
      repository: evidenceGrantRepository,
      store: storeResult.store,
      now: clock,
      quiesceGate: lockResult.lock,
    }),
    storageGate: lockResult.lock,
    getDevelopmentStorageReadiness: () => "ready",
    logger: false,
    now: clock,
  });
  app.addHook("onClose", async () => database.close());
  apps.push(app);
  return {
    directory,
    app,
    database,
    engagementRepository,
    runRepository,
    lock: lockResult.lock,
  };
}

async function setupLeasedRun(
  harness: Harness,
  runnerId: string,
): Promise<RunnerLease> {
  const engagement = harness.engagementRepository.createEngagement({
    name: `Backup lab ${Math.random().toString(36).slice(2)}`,
    kind: "lab",
    description: null,
    authorizationContext: "Synthetic fixture authorization context",
    autoContinueWarnings: false,
  });
  if (!engagement.ok) throw new Error(engagement.error.code);
  const actionId = `action-backup-${Math.random().toString(36).slice(2, 10)}`;
  const planned = harness.engagementRepository.persistPlannedAction({
    engagementId: engagement.value.id,
    snapshot: boundSnapshot(actionId),
    representable: true,
    capabilityErrorCode: null,
    occurredAt: "2026-08-09T12:00:00.000Z",
  });
  if (!planned.ok) throw new Error(planned.error.code);
  const row = harness.database.sqlite
    .prepare("select id from runs where action_id = ?")
    .get(actionId) as { id: string } | undefined;
  if (row === undefined) throw new Error("queued run missing");
  const acquired = harness.runRepository.acquireLease({
    runId: row.id,
    runnerId,
    sessionId: "session-backup-1",
    serverNow: "2026-08-09T12:00:00.500Z",
  });
  if (!acquired.ok) throw new Error(acquired.error.code);
  return acquired.value.lease;
}

let publicationCounter = 0;

// Publishes one artifact through the real grant/PUT/complete flow.
async function publishArtifact(
  harness: Harness,
  enrolled: { runner: { id: string }; secret: string },
  bytes: string,
): Promise<string> {
  const lease = await setupLeasedRun(harness, enrolled.runner.id);
  publicationCounter += 1;
  const grantResponse = await harness.app.inject({
    method: "POST",
    url: "/api/v1/runner/artifacts/grants",
    headers: {
      authorization: formatRunnerAuthorization(enrolled.runner.id, enrolled.secret),
      "idempotency-key": `backup-grant-key-${String(publicationCounter).padStart(16, "0")}`,
    },
    payload: {
      runId: lease.runId,
      leaseId: lease.leaseId,
      sessionId: lease.sessionId,
      fence: lease.fence,
      eventSequence: 1,
      artifactSlot: "stdout",
      kind: "stdout",
    },
  });
  expect(grantResponse.statusCode).toBe(201);
  const { artifactId, uploadId } = grantResponse.json() as {
    artifactId: string;
    uploadId: string;
  };
  const put = await harness.app.inject({
    method: "PUT",
    url: `/api/v1/runner/artifacts/uploads/${uploadId}`,
    headers: {
      authorization: formatRunnerAuthorization(enrolled.runner.id, enrolled.secret),
      "content-type": "application/octet-stream",
    },
    payload: Buffer.from(bytes),
  });
  expect(put.statusCode).toBe(204);
  const complete = await harness.app.inject({
    method: "POST",
    url: `/api/v1/runner/artifacts/uploads/${uploadId}/complete`,
    headers: {
      authorization: formatRunnerAuthorization(enrolled.runner.id, enrolled.secret),
    },
    payload: { uploadId, sizeBytes: bytes.length, digest: sha256(bytes) },
  });
  expect(complete.statusCode).toBe(200);
  return artifactId;
}

async function enroll(app: Harness["app"]) {
  const challenge = await app.inject({
    method: "POST",
    url: "/api/v1/runners/enrollment-challenges",
    headers: { "idempotency-key": "fixture-key-enroll-start-000000" },
    payload: {
      name: "fixture-runner",
      installationFingerprint: fixtureFingerprint,
    },
  });
  expect(challenge.statusCode).toBe(201);
  const confirmed = await app.inject({
    method: "POST",
    url: `/api/v1/runners/enrollment-challenges/${challenge.json().challengeId}/confirm`,
    headers: { "idempotency-key": "fixture-key-enroll-confirm-000000" },
    payload: { ownerConfirmed: true },
  });
  expect(confirmed.statusCode).toBe(201);
  return confirmed.json() as {
    runner: { id: string };
    secret: string;
  };
}

async function makeEmptyDestination(prefix: string): Promise<string> {
  const destination = await mkdtemp(path.join(tmpdir(), prefix));
  await chmod(destination, 0o700);
  directories.push(destination);
  return destination;
}

async function readManifest(backupDirectory: string) {
  const raw = await readFile(
    path.join(backupDirectory, BACKUP_MANIFEST_FILENAME),
    "utf8",
  );
  const parsed = BackupManifestSchema.safeParse(JSON.parse(raw));
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error("manifest invalid");
  return parsed.data;
}

describe("stonehush-backup-v1", () => {
  it("refuses a nonempty backup destination before writing anything", async () => {
    const live = await createLiveTree();
    const destination = await makeEmptyDestination("backup-dest-");
    await writeFile(path.join(destination, "keep.txt"), "preserve-me");

    const outcome = await runBackup({
      dataDirectory: live.directory,
      destinationDirectory: destination,
    });
    expect(outcome).toEqual({ status: "error", code: "backup_destination_not_empty" });
    await expect(readFile(path.join(destination, "keep.txt"))).resolves.toEqual(
      Buffer.from("preserve-me"),
    );
    expect(await readdir(destination)).toEqual(["keep.txt"]);
  });

  it("refuses a restore into a nonempty data directory and preserves existing content", async () => {
    const live = await createLiveTree();
    const destination = await makeEmptyDestination("restore-dest-");
    await writeFile(path.join(destination, "stonehush.sqlite3"), "existing");
    const outcome = await runRestore({
      backupDirectory: live.directory,
      dataDirectory: destination,
    });
    expect(outcome.status === "error" && outcome.code === "restore_destination_not_empty").toBe(true);
    await expect(readFile(path.join(destination, "stonehush.sqlite3"))).resolves.toEqual(
      Buffer.from("existing"),
    );
    expect(await readdir(destination)).toEqual(["stonehush.sqlite3"]);
  });
});

describe("stonehush-backup-v1 roundtrip", () => {
  it("backs up a consistent snapshot and restores it into an empty data directory", async () => {
    const live = await createLiveTree();
    const enrolled = await enroll(live.app);
    const bytes = "synthetic-backup-artifact-bytes";
    const artifactId = await publishArtifact(live, enrolled, bytes);
    // In-flight staging content must never appear in a backup.
    await writeFile(path.join(live.directory, "evidence/staging/in-flight"), "partial");

    const destination = await makeEmptyDestination("backup-roundtrip-");
    const backup = await runBackup({
      dataDirectory: live.directory,
      destinationDirectory: destination,
    });
    expect(backup).toEqual({
      status: "complete",
      protocol: "stonehush-backup-v1",
      artifactCount: 1,
    });

    // Manifest: strict schema, complete state, sorted membership.
    const manifest = await readManifest(destination);
    expect(manifest.state).toBe("complete");
    expect(manifest.completedAt).toBeDefined();
    expect(manifest.schemaVersion).toBe(DATABASE_SCHEMA_VERSION);
    expect(manifest.artifactCount).toBe(1);
    expect(manifest.artifacts).toEqual([
      { artifactId, sizeBytes: bytes.length, digest: sha256(bytes) },
    ]);
    const copiedSqlite = await readFile(
      path.join(destination, "sqlite/stonehush.sqlite3"),
    );
    expect(manifest.sqliteDigest).toBe(sha256(copiedSqlite));

    // Modes everywhere: directories 0700, files 0600.
    for (const directory of [
      destination,
      path.join(destination, "sqlite"),
      path.join(destination, "evidence"),
      path.join(destination, "evidence/published"),
    ]) {
      const stats = await stat(directory);
      expect(stats.mode & 0o777).toBe(0o700);
    }
    for (const file of [
      path.join(destination, BACKUP_MANIFEST_FILENAME),
      path.join(destination, "sqlite/stonehush.sqlite3"),
      path.join(destination, "evidence/published", artifactId),
    ]) {
      const stats = await stat(file);
      expect(stats.mode & 0o777).toBe(0o600);
    }

    // No hardlinks: the copy is a fresh inode with nlink 1.
    const liveStats = await stat(path.join(live.directory, "evidence/published", artifactId));
    const copiedStats = await stat(path.join(destination, "evidence/published", artifactId));
    expect(copiedStats.nlink).toBe(1);
    expect(liveStats.ino).not.toBe(copiedStats.ino);
    await expect(readFile(path.join(destination, "evidence/published", artifactId))).resolves.toEqual(Buffer.from(bytes));

    // Staging is excluded.
    await expect(stat(path.join(destination, "evidence/staging"))).rejects.toThrow();

    // No INCOMPLETE marker survives a complete backup.
    await expect(stat(path.join(destination, BACKUP_INCOMPLETE_MARKER_FILENAME))).rejects.toThrow();

    // Restore into a fresh empty data directory.
    const restored = await makeEmptyDestination("restore-roundtrip-");
    const restoreOutcome = await runRestore({
      backupDirectory: destination,
      dataDirectory: restored,
    });
    expect(restoreOutcome).toEqual({
      status: "complete",
      protocol: "stonehush-backup-v1",
      restoredArtifacts: 1,
    });
    await expect(
      readFile(path.join(restored, "evidence/published", artifactId)),
    ).resolves.toEqual(Buffer.from(bytes));
    const restoredFileStats = await stat(path.join(restored, "evidence/published", artifactId));
    expect(restoredFileStats.mode & 0o777).toBe(0o600);
    const restoredDirStats = await stat(path.join(restored, "evidence"));
    expect(restoredDirStats.mode & 0o777).toBe(0o700);
    await expect(stat(path.join(restored, BACKUP_INCOMPLETE_MARKER_FILENAME))).rejects.toThrow();

    // The restored tree is a healthy live data directory.
    const doctor = await runEvidenceDoctor({ dataDirectory: restored });
    expect(doctor.status === "report" && doctor.report.healthy).toBe(true);
  });

  it("excludes in-flight staging from the snapshot while publishing live artifacts", async () => {
    const live = await createLiveTree();
    const enrolled = await enroll(live.app);
    await publishArtifact(live, enrolled, "published-bytes");
    await writeFile(path.join(live.directory, "evidence/staging/orphan-upload"), "staging");

    const destination = await makeEmptyDestination("backup-staging-");
    const backup = await runBackup({
      dataDirectory: live.directory,
      destinationDirectory: destination,
    });
    expect(backup.status === "complete" && backup.artifactCount === 1).toBe(true);
    const publishedNames = await readdir(path.join(destination, "evidence/published"));
    expect(publishedNames).toHaveLength(1);
  });

  it("refuses to restore an interrupted backup marked INCOMPLETE with zero writes", async () => {
    const live = await createLiveTree();
    const enrolled = await enroll(live.app);
    await publishArtifact(live, enrolled, "interrupted-bytes");
    const destination = await makeEmptyDestination("backup-marker-");
    const backup = await runBackup({
      dataDirectory: live.directory,
      destinationDirectory: destination,
    });
    expect(backup.status).toBe("complete");
    // Simulate an interrupted retry: the marker reappears after completion.
    await writeFile(path.join(destination, BACKUP_INCOMPLETE_MARKER_FILENAME), "");

    const restoreTarget = await makeEmptyDestination("restore-marker-");
    const outcome = await runRestore({
      backupDirectory: destination,
      dataDirectory: restoreTarget,
    });
    expect(outcome).toEqual({ status: "error", code: "backup_incomplete" });
    expect(await readdir(restoreTarget)).toEqual([]);
  });

  it("refuses to restore a manifest whose state is not complete", async () => {
    const live = await createLiveTree();
    const enrolled = await enroll(live.app);
    await publishArtifact(live, enrolled, "started-state-bytes");
    const destination = await makeEmptyDestination("backup-started-");
    expect((await runBackup({
      dataDirectory: live.directory,
      destinationDirectory: destination,
    })).status).toBe("complete");

    const raw = JSON.parse(await readFile(path.join(destination, BACKUP_MANIFEST_FILENAME), "utf8")) as Record<string, unknown>;
    delete raw.completedAt;
    raw.state = "started";
    await writeFile(path.join(destination, BACKUP_MANIFEST_FILENAME), `${JSON.stringify(raw)}\n`);

    const restoreTarget = await makeEmptyDestination("restore-started-");
    const outcome = await runRestore({
      backupDirectory: destination,
      dataDirectory: restoreTarget,
    });
    expect(outcome).toEqual({ status: "error", code: "backup_incomplete" });
    expect(await readdir(restoreTarget)).toEqual([]);
  });

  it("refuses a digest mismatch or membership mismatch with zero writes", async () => {
    const live = await createLiveTree();
    const enrolled = await enroll(live.app);
    const artifactId = await publishArtifact(live, enrolled, "tamper-target-bytes");
    const destination = await makeEmptyDestination("backup-tamper-");
    expect((await runBackup({
      dataDirectory: live.directory,
      destinationDirectory: destination,
    })).status).toBe("complete");
    // Flip one byte inside the backed-up artifact.
    const artifactPath = path.join(destination, "evidence/published", artifactId);
    const pristine = await readFile(artifactPath);
    const corrupted = Buffer.from(pristine);
    corrupted[0] = corrupted[0] === 120 ? 121 : 120;
    await writeFile(artifactPath, corrupted);

    let restoreTarget = await makeEmptyDestination("restore-tamper-");
    let outcome = await runRestore({
      backupDirectory: destination,
      dataDirectory: restoreTarget,
    });
    expect(outcome).toEqual({ status: "error", code: "restore_consistency_mismatch" });
    // Zero writes: the destination is still completely empty.
    expect(await readdir(restoreTarget)).toEqual([]);

    // Restore the byte, then plant an extra unpublished file instead.
    await writeFile(artifactPath, pristine);
    await writeFile(path.join(destination, "evidence/published/extra-file"), "extra");
    restoreTarget = await makeEmptyDestination("restore-extra-");
    outcome = await runRestore({
      backupDirectory: destination,
      dataDirectory: restoreTarget,
    });
    expect(outcome).toEqual({ status: "error", code: "restore_consistency_mismatch" });
    expect(await readdir(restoreTarget)).toEqual([]);

    // A missing artifact fails the exact-membership check too.
    await rm(path.join(destination, "evidence/published/extra-file"), { force: true });
    const names = await readdir(path.join(destination, "evidence/published"));
    await rm(path.join(destination, "evidence/published", names[0] as string), { force: true });
    restoreTarget = await makeEmptyDestination("restore-missing-");
    outcome = await runRestore({
      backupDirectory: destination,
      dataDirectory: restoreTarget,
    });
    expect(outcome).toEqual({ status: "error", code: "restore_consistency_mismatch" });
    expect(await readdir(restoreTarget)).toEqual([]);
  });

  it("refuses a backup from a newer schema with zero writes", async () => {
    const live = await createLiveTree();
    const enrolled = await enroll(live.app);
    await publishArtifact(live, enrolled, "future-schema-bytes");
    const destination = await makeEmptyDestination("backup-schema-");
    expect((await runBackup({
      dataDirectory: live.directory,
      destinationDirectory: destination,
    })).status).toBe("complete");

    const raw = JSON.parse(await readFile(path.join(destination, BACKUP_MANIFEST_FILENAME), "utf8")) as Record<string, unknown>;
    raw.schemaVersion = DATABASE_SCHEMA_VERSION + 1;
    await writeFile(path.join(destination, BACKUP_MANIFEST_FILENAME), `${JSON.stringify(raw)}\n`);

    const restoreTarget = await makeEmptyDestination("restore-schema-");
    const outcome = await runRestore({
      backupDirectory: destination,
      dataDirectory: restoreTarget,
    });
    expect(outcome).toEqual({ status: "error", code: "restore_schema_newer" });
    expect(await readdir(restoreTarget)).toEqual([]);
  });

  it("leaves the INCOMPLETE marker behind when a snapshot fails midway", async () => {
    const live = await createLiveTree();
    const enrolled = await enroll(live.app);
    const artifactId = await publishArtifact(live, enrolled, "corrupt-live-bytes");
    // Corrupt the live published bytes so during-copy verification fails
    // against the row digest; this models a mid-snapshot integrity failure.
    const livePath = path.join(live.directory, "evidence/published", artifactId);
    const corrupted = await readFile(livePath);
    corrupted[0] = corrupted[0] === 99 ? 100 : 99;
    await writeFile(livePath, corrupted);

    const destination = await makeEmptyDestination("backup-interrupt-");
    const outcome = await runBackup({
      dataDirectory: live.directory,
      destinationDirectory: destination,
    });
    expect(outcome.status).toBe("error");
    // The interrupted snapshot stays detectable: marker present, manifest
    // either absent or still state=started.
    await expect(stat(path.join(destination, BACKUP_INCOMPLETE_MARKER_FILENAME))).resolves.toBeTruthy();
    try {
      const manifest = await readManifest(destination);
      expect(manifest.state).toBe("started");
    } catch {
      // No manifest at all is equally refused by restore.
    }
  });

  it("refuses restore when SQLite artifact rows diverge from manifest with zero writes", async () => {
    const live = await createLiveTree();
    const enrolled = await enroll(live.app);
    const artifactId = await publishArtifact(live, enrolled, "sqlite-row-bytes");
    const destination = await makeEmptyDestination("backup-sqlite-row-");
    expect(
      (
        await runBackup({
          dataDirectory: live.directory,
          destinationDirectory: destination,
        })
      ).status,
    ).toBe("complete");

    // Tamper the frozen snapshot's evidence_artifacts row so the manifest
    // no longer matches the database that claims to list it. Recompute the
    // SQLite digest so the outer digest check still passes and the failure
    // must come from the internal rows-vs-manifest verification, proving
    // the restore checks internal SQLite consistency before any write.
    const snapshotPath = path.join(destination, "sqlite/stonehush.sqlite3");
    const handle = openEngagementDatabase({ dataDirectory: path.join(destination, "sqlite") });
    try {
      handle.sqlite
        .prepare("update evidence_artifacts set digest = ? where artifact_id = ?")
        .run("sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", artifactId);
      handle.sqlite.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      handle.close();
    }
    // Keep sqliteDigest consistent with the tampered file so the mismatch is
    // only detectable via the internal artifact rows check.
    const snapshotBytes = await readFile(snapshotPath);
    const newDigest = sha256(snapshotBytes);
    const manifestPath = path.join(destination, BACKUP_MANIFEST_FILENAME);
    const manifestRaw = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifestRaw.sqliteDigest = newDigest;
    await writeFile(manifestPath, `${JSON.stringify(manifestRaw)}\n`);

    const restoreTarget = await makeEmptyDestination("restore-sqlite-row-");
    const outcome = await runRestore({
      backupDirectory: destination,
      dataDirectory: restoreTarget,
    });
    expect(outcome).toEqual({ status: "error", code: "restore_consistency_mismatch" });
    expect(await readdir(restoreTarget)).toEqual([]);
  });

  it("refuses restore when manifest schemaVersion does not match SQLite migration count with zero writes", async () => {
    const live = await createLiveTree();
    const enrolled = await enroll(live.app);
    await publishArtifact(live, enrolled, "sqlite-schema-bytes");
    const destination = await makeEmptyDestination("backup-sqlite-schema-");
    expect(
      (
        await runBackup({
          dataDirectory: live.directory,
          destinationDirectory: destination,
        })
      ).status,
    ).toBe("complete");

    // Make manifest schemaVersion diverge from the SQLite's own
    // __drizzle_migrations count. Both directions must be caught before
    // any destination write.
    const manifestPath = path.join(destination, BACKUP_MANIFEST_FILENAME);
    const raw = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    const originalVersion = raw.schemaVersion as number;
    // Choose a different but still <= running version to exercise the
    // internal consistency check rather than the newer-schema refusal.
    raw.schemaVersion = originalVersion > 0 ? originalVersion - 1 : originalVersion + 1;
    await writeFile(manifestPath, `${JSON.stringify(raw)}\n`);

    let restoreTarget = await makeEmptyDestination("restore-manifest-schema-");
    let outcome = await runRestore({
      backupDirectory: destination,
      dataDirectory: restoreTarget,
    });
    expect(outcome).toEqual({ status: "error", code: "restore_consistency_mismatch" });
    expect(await readdir(restoreTarget)).toEqual([]);

    // Restore the manifest, then corrupt the SQLite migration count itself
    // so the manifest is truthful but the database diverges. Recompute
    // the digest so the outer digest check still passes and the failure
    // must come from the internal schemaVersion-vs-migrations check.
    raw.schemaVersion = originalVersion;
    await writeFile(manifestPath, `${JSON.stringify(raw)}\n`);
    const snapshotPath = path.join(destination, "sqlite/stonehush.sqlite3");
    const handle = openEngagementDatabase({ dataDirectory: path.join(destination, "sqlite") });
    try {
      // Delete one migration row to make count differ from manifest.
      handle.sqlite.prepare("delete from __drizzle_migrations where rowid = 1").run();
      handle.sqlite.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      handle.close();
    }
    const tamperedBytes = await readFile(snapshotPath);
    const tamperedDigest = sha256(tamperedBytes);
    const afterTamperRaw = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    afterTamperRaw.sqliteDigest = tamperedDigest;
    await writeFile(manifestPath, `${JSON.stringify(afterTamperRaw)}\n`);
    restoreTarget = await makeEmptyDestination("restore-sqlite-count-");
    outcome = await runRestore({
      backupDirectory: destination,
      dataDirectory: restoreTarget,
    });
    expect(outcome).toEqual({ status: "error", code: "restore_consistency_mismatch" });
    expect(await readdir(restoreTarget)).toEqual([]);
  });
});
