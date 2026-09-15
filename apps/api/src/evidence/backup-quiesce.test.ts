import { chmod, mkdtemp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  formatRunnerAuthorization,
  type ActionSnapshot,
  type RunnerLease,
} from "@stonehush/contracts";
import {
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
import { BackupLock } from "./backup-lock.js";
import { EvidencePublicationService } from "./evidence-publication.js";
import { EvidenceStore } from "./evidence-store.js";

// Fixture d3.backup.quiesces-publication and d3.backup.excludes-staging at
// the HTTP boundary: while a snapshot holds the exclusive quiesce lock, new
// grant admissions and completions return an exact 503
// storage_backup_quiesced with no grant or publication change, while an
// already admitted PUT keeps streaming into excluded staging.

const fixtureFingerprint =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const directories: string[] = [];
const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await chmod(directory, 0o700).catch(() => undefined);
      const { rm } = await import("node:fs/promises");
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

async function createHarness(): Promise<Harness> {
  const native = loadEvidenceNative();
  if (!native.ok) throw new Error(`native binding unavailable: ${native.reason}`);
  const directory = await mkdtemp(path.join(tmpdir(), "backup-quiesce-"));
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

async function setupLeasedRun(
  harness: Harness,
  enrolled: { runner: { id: string }; secret: string },
): Promise<RunnerLease> {
  const engagement = harness.engagementRepository.createEngagement({
    name: `Quiesce lab ${Math.random().toString(36).slice(2)}`,
    kind: "lab",
    description: null,
    authorizationContext: "Synthetic fixture authorization context",
    autoContinueWarnings: false,
  });
  if (!engagement.ok) throw new Error(engagement.error.code);
  const actionId = `action-quiesce-${Math.random().toString(36).slice(2, 10)}`;
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
    runnerId: enrolled.runner.id,
    sessionId: "session-quiesce-1",
    serverNow: "2026-08-09T12:00:00.500Z",
  });
  if (!acquired.ok) throw new Error(acquired.error.code);
  return acquired.value.lease;
}

describe("storage_backup_quiesced gate", () => {
  it("returns an exact 503 for grants during a snapshot without creating one", async () => {
    const harness = await createHarness();
    const enrolled = await enroll(harness.app);
    const lease = await setupLeasedRun(harness, enrolled);

    const exclusive = harness.lock.acquireExclusive();
    expect(exclusive.ok).toBe(true);
    try {
      const response = await harness.app.inject({
        method: "POST",
        url: "/api/v1/runner/artifacts/grants",
        headers: {
          authorization: formatRunnerAuthorization(enrolled.runner.id, enrolled.secret),
          "idempotency-key": "quiesce-grant-key-00000000000000001",
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
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ code: "storage_backup_quiesced" });

      // No grant row appeared and the run stays nonterminal and unchanged.
      const rows = harness.database.sqlite
        .prepare("select count(*) as c from evidence_grants")
        .get() as { c: number };
      expect(rows.c).toBe(0);
    } finally {
      if (exclusive.ok) exclusive.release();
    }

    // Publication resumes immediately after the snapshot releases the lock.
    const resumed = await harness.app.inject({
      method: "POST",
      url: "/api/v1/runner/artifacts/grants",
      headers: {
        authorization: formatRunnerAuthorization(enrolled.runner.id, enrolled.secret),
        "idempotency-key": "quiesce-grant-key-00000000000000002",
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
    expect(resumed.statusCode).toBe(201);
  });

  it("pauses complete with 503 but lets staging PUT finish because staging is excluded", async () => {
    const harness = await createHarness();
    const enrolled = await enroll(harness.app);
    const lease = await setupLeasedRun(harness, enrolled);

    const grantResponse = await harness.app.inject({
      method: "POST",
      url: "/api/v1/runner/artifacts/grants",
      headers: {
        authorization: formatRunnerAuthorization(enrolled.runner.id, enrolled.secret),
        "idempotency-key": "quiesce-grant-key-00000000000000003",
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

    const exclusive = harness.lock.acquireExclusive();
    expect(exclusive.ok).toBe(true);
    try {
      const bytes = "staging-excluded-bytes";
      const put = await harness.app.inject({
        method: "PUT",
        url: `/api/v1/runner/artifacts/uploads/${uploadId}`,
        headers: {
          authorization: formatRunnerAuthorization(enrolled.runner.id, enrolled.secret),
          "content-type": "application/octet-stream",
        },
        payload: Buffer.from(bytes),
      });
      // Staging is outside the snapshot: the PUT is never quiesced.
      expect(put.statusCode).toBe(204);

      const complete = await harness.app.inject({
        method: "POST",
        url: `/api/v1/runner/artifacts/uploads/${uploadId}/complete`,
        headers: {
          authorization: formatRunnerAuthorization(enrolled.runner.id, enrolled.secret),
        },
        payload: { uploadId, sizeBytes: bytes.length, digest: sha256(bytes) },
      });
      expect(complete.statusCode).toBe(503);
      expect(complete.json()).toEqual({ code: "storage_backup_quiesced" });

      // Nothing was published under the exclusive lock.
      const rows = harness.database.sqlite
        .prepare("select count(*) as c from evidence_artifacts")
        .get() as { c: number };
      expect(rows.c).toBe(0);
    } finally {
      if (exclusive.ok) exclusive.release();
    }

    // After release the same completion publishes normally.
    const bytes = "staging-excluded-bytes";
    const complete = await harness.app.inject({
      method: "POST",
      url: `/api/v1/runner/artifacts/uploads/${uploadId}/complete`,
      headers: {
        authorization: formatRunnerAuthorization(enrolled.runner.id, enrolled.secret),
      },
      payload: { uploadId, sizeBytes: bytes.length, digest: sha256(bytes) },
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json()).toMatchObject({
      disposition: "published",
      artifactId,
      sizeBytes: bytes.length,
      digest: sha256(bytes),
    });
  });
});
