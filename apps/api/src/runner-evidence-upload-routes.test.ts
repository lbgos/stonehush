import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  EVIDENCE_EMPTY_SHA256_DIGEST,
  EvidenceGrantResponseSchema,
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

import { buildApp } from "./app.js";
import { EvidencePublicationService } from "./evidence/evidence-publication.js";
import { EvidenceStore } from "./evidence/evidence-store.js";

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
  app: ReturnType<typeof buildApp>;
  database: ReturnType<typeof openEngagementDatabase>;
  engagementRepository: EngagementRepository;
  runRepository: RunRepository;
  setNow: (value: string) => void;
}

async function createHarness(options: { quota?: unknown } = {}): Promise<Harness> {
  const native = loadEvidenceNative();
  if (!native.ok) throw new Error(`native binding unavailable: ${native.reason}`);
  const directory = await mkdtemp(path.join(tmpdir(), "evidence-publication-"));
  await chmod(directory, 0o700);
  directories.push(directory);
  const storeResult = EvidenceStore.open(directory, native.binding);
  if (!storeResult.ok) throw new Error(`store open failed: ${storeResult.code}`);

  const database = openEngagementDatabase({ dataDirectory: directory });
  let engagementSeq = 0;
  let leaseSeq = 0;
  let runnerSeq = 0;
  let now = new Date("2026-08-09T12:00:00.000Z");
  const clock = () => new Date(now);
  const engagementRepository = new EngagementRepository(database.db, {
    createId: () =>
      `10000000-0000-4000-8000-${String(++engagementSeq).padStart(12, "0")}`,
    now: clock,
  });
  const runRepository = new RunRepository(database.db, {
    createId: () => `lease-fixture-${++leaseSeq}`,
    now: clock,
  });
  const runnerRepository = new RunnerRepository(database.db, {
    createId: () => {
      runnerSeq += 1;
      return runnerSeq === 2 ? "runner-fixture-1" : `runner-id-${runnerSeq}`;
    },
    now: clock,
  });
  const evidenceGrantRepository = new EvidenceGrantRepository(database.db, {
    now: clock,
    ...(options.quota === undefined ? {} : { quota: options.quota }),
  });
  const operatorCommandRepository = new OperatorCommandRepository(
    engagementRepository,
    { now: clock },
  );
  const publication = new EvidencePublicationService({
    repository: evidenceGrantRepository,
    store: storeResult.store,
    now: clock,
  });
  const app = buildApp({
    engagementRepository,
    operatorCommandRepository,
    runRepository,
    runnerRepository,
    evidenceGrantRepository,
    evidencePublication: publication,
    getDevelopmentStorageReadiness: () => "ready",
    logger: false,
    now: clock,
  });
  app.addHook("onClose", async () => database.close());
  apps.push(app);
  return {
    app,
    database,
    engagementRepository,
    runRepository,
    setNow(value: string) {
      now = new Date(value);
    },
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
    runner: { id: string; revision: number };
    secret: string;
  };
}

function runnerHeaders(runnerId: string, secret: string): Record<string, string> {
  return {
    authorization: formatRunnerAuthorization(runnerId, secret),
    "content-type": "application/octet-stream",
  };
}

// Queues a run for a fresh engagement plus action, then leases it to the
// enrolled runner so grants bind a current lease.
async function setupLeasedRun(
  harness: Harness,
  enrolled: { runner: { id: string }; secret: string },
  actionId: string,
): Promise<{ runId: string; lease: RunnerLease }> {
  const engagement = harness.engagementRepository.createEngagement({
    name: `Publication lab ${actionId}`,
    kind: "lab",
    description: null,
    authorizationContext: "Synthetic fixture authorization context",
    autoContinueWarnings: false,
  });
  if (!engagement.ok) throw new Error(engagement.error.code);
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
    sessionId: "session-publication-1",
    serverNow: "2026-08-09T12:00:00.500Z",
  });
  if (!acquired.ok) throw new Error(acquired.error.code);
  return { runId: row.id, lease: acquired.value.lease };
}

async function admitGrant(
  harness: Harness,
  enrolled: { runner: { id: string }; secret: string },
  lease: RunnerLease,
  overrides: Record<string, unknown> = {},
): Promise<{ artifactId: string; uploadId: string }> {
  let keySeq = 0;
  const response = await harness.app.inject({
    method: "POST",
    url: "/api/v1/runner/artifacts/grants",
    headers: {
      authorization: formatRunnerAuthorization(enrolled.runner.id, enrolled.secret),
      "idempotency-key": `publication-grant-key-${actionIdTag(lease.runId)}-${++keySeq}-${Math.random().toString(36).slice(2, 10)}`,
    },
    payload: {
      runId: lease.runId,
      leaseId: lease.leaseId,
      sessionId: lease.sessionId,
      fence: lease.fence,
      eventSequence: 1,
      artifactSlot: "stdout",
      kind: "stdout",
      ...overrides,
    },
  });
  expect(response.statusCode).toBe(201);
  const parsed = EvidenceGrantResponseSchema.safeParse(response.json());
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error("grant response invalid");
  return { artifactId: parsed.data.artifactId, uploadId: parsed.data.uploadId };
}

let actionTagCounter = 0;
function actionIdTag(runId: string): string {
  actionTagCounter += 1;
  void runId;
  return String(actionTagCounter).padStart(4, "0");
}

describe("runner artifact publication routes", () => {
  it("publishes an admitted upload with metadata after the durable file", async () => {
    const harness = await createHarness();
    const enrolled = await enroll(harness.app);
    const { lease } = await setupLeasedRun(harness, enrolled, "action-pub-happy");
    const { artifactId, uploadId } = await admitGrant(harness, enrolled, lease);

    const bytes = "synthetic-evidence-bytes";
    const put = await harness.app.inject({
      method: "PUT",
      url: `/api/v1/runner/artifacts/uploads/${uploadId}`,
      headers: runnerHeaders(enrolled.runner.id, enrolled.secret),
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
    expect(complete.json()).toEqual({
      disposition: "published",
      artifactId,
      sizeBytes: bytes.length,
      digest: sha256(bytes),
      completeness: "complete",
    });

    // Durable published file with exact permissions and content.
    const dataDirectory = directories[directories.length - 1] as string;
    const publishedPath = path.join(dataDirectory, "evidence/published", artifactId);
    const stats = await stat(publishedPath);
    expect(stats.isFile()).toBe(true);
    expect(stats.mode & 0o777).toBe(0o600);
    expect(stats.nlink).toBe(1);
    await expect(readFile(publishedPath)).resolves.toEqual(Buffer.from(bytes));
    await expect(
      stat(path.join(dataDirectory, "evidence/staging", uploadId)),
    ).rejects.toThrow();

    // Metadata row committed only after the durable rename.
    const row = harness.database.sqlite
      .prepare("select digest, size_bytes, relative_path, completeness from evidence_artifacts where artifact_id = ?")
      .get(artifactId) as
      | { digest: string; size_bytes: number; relative_path: string; completeness: string }
      | undefined;
    expect(row).toMatchObject({
      digest: sha256(bytes),
      size_bytes: bytes.length,
      relative_path: `published/${artifactId}`,
      completeness: "complete",
    });

    // Redaction metadata is derived from the stream kind.
    const redaction = harness.database.sqlite
      .prepare("select redaction_applied, redaction_boundary, raw_bytes_preserved from evidence_artifacts where artifact_id = ?")
      .get(artifactId) as Record<string, number | string>;
    expect(redaction).toEqual({
      redaction_applied: 1,
      redaction_boundary: "runner_stream",
      raw_bytes_preserved: 0,
    });

    // Grant left the in-progress state.
    const grantState = harness.database.sqlite
      .prepare("select state, put_finalized from evidence_grants where upload_id = ?")
      .get(uploadId) as { state: string; put_finalized: number };
    expect(grantState).toEqual({ state: "published", put_finalized: 1 });
  });

  it("replays the same upload completion without touching the destination", async () => {
    const harness = await createHarness();
    const enrolled = await enroll(harness.app);
    const { lease } = await setupLeasedRun(harness, enrolled, "action-pub-replay");
    const { artifactId, uploadId } = await admitGrant(harness, enrolled, lease);
    const bytes = "replay-bytes";
    expect(
      (
        await harness.app.inject({
          method: "PUT",
          url: `/api/v1/runner/artifacts/uploads/${uploadId}`,
          headers: runnerHeaders(enrolled.runner.id, enrolled.secret),
          payload: Buffer.from(bytes),
        })
      ).statusCode,
    ).toBe(204);
    const body = { uploadId, sizeBytes: bytes.length, digest: sha256(bytes) };
    const first = await harness.app.inject({
      method: "POST",
      url: `/api/v1/runner/artifacts/uploads/${uploadId}/complete`,
      headers: {
        authorization: formatRunnerAuthorization(enrolled.runner.id, enrolled.secret),
      },
      payload: body,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().disposition).toBe("published");

    const replay = await harness.app.inject({
      method: "POST",
      url: `/api/v1/runner/artifacts/uploads/${uploadId}/complete`,
      headers: {
        authorization: formatRunnerAuthorization(enrolled.runner.id, enrolled.secret),
      },
      payload: body,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({
      disposition: "stored_artifact_replayed",
      artifactId,
      sizeBytes: bytes.length,
      digest: sha256(bytes),
      completeness: "complete",
    });
    const rows = harness.database.sqlite
      .prepare("select count(*) as c from evidence_artifacts")
      .get() as { c: number };
    expect(rows.c).toBe(1);
  });

  it("conflicts on different declared bytes for an already published identity", async () => {
    const harness = await createHarness();
    const enrolled = await enroll(harness.app);
    const { lease } = await setupLeasedRun(harness, enrolled, "action-pub-conflict");
    const original = await admitGrant(harness, enrolled, lease);
    const bytesA = "identity-original-bytes";
    await harness.app.inject({
      method: "PUT",
      url: `/api/v1/runner/artifacts/uploads/${original.uploadId}`,
      headers: runnerHeaders(enrolled.runner.id, enrolled.secret),
      payload: Buffer.from(bytesA),
    });
    await harness.app.inject({
      method: "POST",
      url: `/api/v1/runner/artifacts/uploads/${original.uploadId}/complete`,
      headers: {
        authorization: formatRunnerAuthorization(enrolled.runner.id, enrolled.secret),
      },
      payload: {
        uploadId: original.uploadId,
        sizeBytes: bytesA.length,
        digest: sha256(bytesA),
      },
    });

    // A later grant for the same identity is admitted after publication.
    const conflicting = await admitGrant(harness, enrolled, lease);
    const bytesB = "totally-different!";
    await harness.app.inject({
      method: "PUT",
      url: `/api/v1/runner/artifacts/uploads/${conflicting.uploadId}`,
      headers: runnerHeaders(enrolled.runner.id, enrolled.secret),
      payload: Buffer.from(bytesB),
    });
    const complete = await harness.app.inject({
      method: "POST",
      url: `/api/v1/runner/artifacts/uploads/${conflicting.uploadId}/complete`,
      headers: {
        authorization: formatRunnerAuthorization(enrolled.runner.id, enrolled.secret),
      },
      payload: {
        uploadId: conflicting.uploadId,
        sizeBytes: bytesB.length,
        digest: sha256(bytesB),
      },
    });
    expect(complete.statusCode).toBe(409);
    expect(complete.json()).toEqual({ code: "artifact_identity_conflict" });

    // The original artifact is preserved untouched.
    const rows = harness.database.sqlite
      .prepare("select artifact_id, digest from evidence_artifacts")
      .all() as Array<{ artifact_id: string; digest: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ artifact_id: original.artifactId, digest: sha256(bytesA) });
  });

  it("rejects a declared mismatch, releases the identity, and never publishes", async () => {
    const harness = await createHarness();
    const enrolled = await enroll(harness.app);
    const { lease } = await setupLeasedRun(harness, enrolled, "action-pub-mismatch");
    const { artifactId, uploadId } = await admitGrant(harness, enrolled, lease);
    const bytes = "mismatch-case-bytes";
    await harness.app.inject({
      method: "PUT",
      url: `/api/v1/runner/artifacts/uploads/${uploadId}`,
      headers: runnerHeaders(enrolled.runner.id, enrolled.secret),
      payload: Buffer.from(bytes),
    });
    const complete = await harness.app.inject({
      method: "POST",
      url: `/api/v1/runner/artifacts/uploads/${uploadId}/complete`,
      headers: {
        authorization: formatRunnerAuthorization(enrolled.runner.id, enrolled.secret),
      },
      payload: {
        uploadId,
        sizeBytes: bytes.length,
        digest: `sha256:${"b".repeat(64)}`,
      },
    });
    expect(complete.statusCode).toBe(409);
    expect(complete.json()).toEqual({ code: "artifact_digest_mismatch" });

    const grantState = harness.database.sqlite
      .prepare("select state from evidence_grants where upload_id = ?")
      .get(uploadId) as { state: string };
    expect(grantState.state).toBe("upload_interrupted");
    const artifacts = harness.database.sqlite
      .prepare("select count(*) as c from evidence_artifacts")
      .get() as { c: number };
    expect(artifacts.c).toBe(0);

    // Identity released: a fresh grant for the same identity is admitted.
    const regranted = await admitGrant(harness, enrolled, lease);
    expect(regranted.artifactId).not.toBe(artifactId);
  });

  it("publishes an empty artifact with the pinned empty digest", async () => {
    const harness = await createHarness();
    const enrolled = await enroll(harness.app);
    const { lease } = await setupLeasedRun(harness, enrolled, "action-pub-empty");
    const { artifactId, uploadId } = await admitGrant(harness, enrolled, lease);
    await harness.app.inject({
      method: "PUT",
      url: `/api/v1/runner/artifacts/uploads/${uploadId}`,
      headers: runnerHeaders(enrolled.runner.id, enrolled.secret),
      payload: Buffer.alloc(0),
    });
    const complete = await harness.app.inject({
      method: "POST",
      url: `/api/v1/runner/artifacts/uploads/${uploadId}/complete`,
      headers: {
        authorization: formatRunnerAuthorization(enrolled.runner.id, enrolled.secret),
      },
      payload: { uploadId, sizeBytes: 0, digest: EVIDENCE_EMPTY_SHA256_DIGEST },
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json()).toMatchObject({
      disposition: "published",
      artifactId,
      sizeBytes: 0,
      digest: EVIDENCE_EMPTY_SHA256_DIGEST,
    });
  });

  it("bounds streaming at the admission reservation and fails closed on overflow", async () => {
    const tinyQuota = {
      perArtifactBytes: 65_536,
      perRunPublishedBytes: 268_435_456,
      totalPublishedBytes: 34_359_738_368,
      maxInFlightStagingBytes: 65_536,
      maxConcurrentUploadsPerRunner: 2,
    };
    const harness = await createHarness({ quota: tinyQuota });
    const enrolled = await enroll(harness.app);
    const { lease } = await setupLeasedRun(harness, enrolled, "action-pub-overflow");
    const { uploadId } = await admitGrant(harness, enrolled, lease);

    const oversized = Buffer.alloc(70_000, 0x41);
    const put = await harness.app.inject({
      method: "PUT",
      url: `/api/v1/runner/artifacts/uploads/${uploadId}`,
      headers: runnerHeaders(enrolled.runner.id, enrolled.secret),
      payload: oversized,
    });
    expect(put.statusCode).toBe(413);
    expect(put.json()).toEqual({ code: "artifact_quota_exceeded" });

    const grantState = harness.database.sqlite
      .prepare("select state, put_finalized from evidence_grants where upload_id = ?")
      .get(uploadId) as { state: string; put_finalized: number };
    expect(grantState.state).toBe("upload_interrupted");
    expect(grantState.put_finalized).toBe(0);
    const artifacts = harness.database.sqlite
      .prepare("select count(*) as c from evidence_artifacts")
      .get() as { c: number };
    expect(artifacts.c).toBe(0);
  });

  it("refuses completion after lease expiry instead of publishing", async () => {
    const harness = await createHarness();
    const enrolled = await enroll(harness.app);
    const { lease } = await setupLeasedRun(harness, enrolled, "action-pub-expired");
    const { uploadId } = await admitGrant(harness, enrolled, lease);
    const bytes = "expired-lease-bytes";
    await harness.app.inject({
      method: "PUT",
      url: `/api/v1/runner/artifacts/uploads/${uploadId}`,
      headers: runnerHeaders(enrolled.runner.id, enrolled.secret),
      payload: Buffer.from(bytes),
    });
    harness.setNow("2026-08-20T00:00:00.000Z");
    const complete = await harness.app.inject({
      method: "POST",
      url: `/api/v1/runner/artifacts/uploads/${uploadId}/complete`,
      headers: {
        authorization: formatRunnerAuthorization(enrolled.runner.id, enrolled.secret),
      },
      payload: { uploadId, sizeBytes: bytes.length, digest: sha256(bytes) },
    });
    expect(complete.statusCode).toBe(409);
    expect(complete.json()).toEqual({ code: "lease_expired" });
    const artifacts = harness.database.sqlite
      .prepare("select count(*) as c from evidence_artifacts")
      .get() as { c: number };
    expect(artifacts.c).toBe(0);
  });

  it("requires runner credentials and known uploads on both routes", async () => {
    const harness = await createHarness();
    const enrolled = await enroll(harness.app);
    const operatorBlocked = await harness.app.inject({
      method: "PUT",
      url: "/api/v1/runner/artifacts/uploads/00000000-0000-4000-8000-000000000000",
      headers: {
        authorization: "Bearer local-operator-token-placeholder",
        "content-type": "application/octet-stream",
      },
      payload: Buffer.from("x"),
    });
    expect(operatorBlocked.statusCode).toBe(403);
    expect(operatorBlocked.json()).toEqual({ code: "runner_identity_required" });

    const anonymous = await harness.app.inject({
      method: "PUT",
      url: "/api/v1/runner/artifacts/uploads/00000000-0000-4000-8000-000000000000",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("x"),
    });
    expect(anonymous.statusCode).toBe(401);

    const notFoundPut = await harness.app.inject({
      method: "PUT",
      url: "/api/v1/runner/artifacts/uploads/10000000-0000-4000-8000-000000009999",
      headers: runnerHeaders(enrolled.runner.id, enrolled.secret),
      payload: Buffer.from("x"),
    });
    expect(notFoundPut.statusCode).toBe(404);

    const traversal = encodeURI("/api/v1/runner/artifacts/uploads/../other-run/uploads/x");
    const traversalPut = await harness.app.inject({
      method: "PUT",
      url: "/api/v1/runner/artifacts/uploads/%2E%2E%2Fescape",
      headers: runnerHeaders(enrolled.runner.id, enrolled.secret),
      payload: Buffer.from("x"),
    });
    expect(traversalPut.statusCode).toBe(400);
    expect(traversalPut.json()).toEqual({ code: "invalid_request" });
    void traversal;

    const otherRunner = await enroll(harness.app);
    void otherRunner;
    const notFoundComplete = await harness.app.inject({
      method: "POST",
      url: "/api/v1/runner/artifacts/uploads/10000000-0000-4000-8000-000000009999/complete",
      headers: {
        authorization: formatRunnerAuthorization(enrolled.runner.id, enrolled.secret),
      },
      payload: {
        uploadId: "10000000-0000-4000-8000-000000009999",
        sizeBytes: 1,
        digest: sha256("x"),
      },
    });
    expect(notFoundComplete.statusCode).toBe(404);
  });

  it("keeps the durable file when metadata commit fails (metadata-after-file)", async () => {
    const harness = await createHarness();
    const enrolled = await enroll(harness.app);
    const { lease } = await setupLeasedRun(harness, enrolled, "action-pub-ordering");
    const { artifactId, uploadId } = await admitGrant(harness, enrolled, lease);
    const bytes = "ordering-proof-bytes";
    await harness.app.inject({
      method: "PUT",
      url: `/api/v1/runner/artifacts/uploads/${uploadId}`,
      headers: runnerHeaders(enrolled.runner.id, enrolled.secret),
      payload: Buffer.from(bytes),
    });
    // Simulate a persistence fault between the durable rename and commit:
    // reads keep working but every artifact insert aborts.
    harness.database.sqlite.exec(
      "create trigger evidence_artifacts_insert_block before insert on evidence_artifacts begin select raise(abort, 'fixture blocked'); end",
    );
    const complete = await harness.app.inject({
      method: "POST",
      url: `/api/v1/runner/artifacts/uploads/${uploadId}/complete`,
      headers: {
        authorization: formatRunnerAuthorization(enrolled.runner.id, enrolled.secret),
      },
      payload: { uploadId, sizeBytes: bytes.length, digest: sha256(bytes) },
    });
    expect(complete.statusCode).toBe(500);
    expect(complete.json()).toEqual({ code: "invalid_persisted_data" });

    // The file is already durable under the managed tree; no row exists.
    const dataDirectory = directories[directories.length - 1] as string;
    await expect(
      readFile(path.join(dataDirectory, "evidence/published", artifactId)),
    ).resolves.toEqual(Buffer.from(bytes));
  });
});
