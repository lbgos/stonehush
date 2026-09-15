import { chmod, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
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
  directory: string;
  engagementRepository: EngagementRepository;
  runRepository: RunRepository;
}

async function createHarness(): Promise<Harness> {
  const native = loadEvidenceNative();
  if (!native.ok) throw new Error(`native binding unavailable: ${native.reason}`);
  const directory = await mkdtemp(path.join(tmpdir(), "artifact-download-"));
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
    }),
    evidenceStore: storeResult.store,
    getDevelopmentStorageReadiness: () => "ready",
    logger: false,
    now: clock,
  });
  app.addHook("onClose", async () => database.close());
  apps.push(app);
  return { app, database, directory, engagementRepository, runRepository };
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

async function setupLeasedRun(
  harness: Harness,
  runnerId: string,
  actionId: string,
): Promise<{ engagementId: string; runId: string; lease: RunnerLease }> {
  const engagement = harness.engagementRepository.createEngagement({
    name: `Download lab ${actionId}`,
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
    runnerId,
    sessionId: "session-download-1",
    serverNow: "2026-08-09T12:00:00.500Z",
  });
  if (!acquired.ok) throw new Error(acquired.error.code);
  return {
    engagementId: engagement.value.id,
    runId: row.id,
    lease: acquired.value.lease,
  };
}

let grantKeyCounter = 0;

// Full publication through the existing runner flow with an advisory display
// name and declared content type attached to the grant.
async function publishArtifact(
  harness: Harness,
  enrolled: { runner: { id: string }; secret: string },
  lease: RunnerLease,
  options: {
    artifactSlot?: string;
    kind?: string;
    originalFileName?: string;
    declaredContentType?: string;
    bytes?: string;
  } = {},
): Promise<string> {
  const grantResponse = await harness.app.inject({
    method: "POST",
    url: "/api/v1/runner/artifacts/grants",
    headers: {
      authorization: formatRunnerAuthorization(enrolled.runner.id, enrolled.secret),
      "idempotency-key": `download-grant-${++grantKeyCounter}-${Math.random().toString(36).slice(2, 10)}`,
    },
    payload: {
      runId: lease.runId,
      leaseId: lease.leaseId,
      sessionId: lease.sessionId,
      fence: lease.fence,
      eventSequence: 1,
      artifactSlot: options.artifactSlot ?? "stdout",
      kind: options.kind ?? "stdout",
      ...(options.originalFileName === undefined
        ? {}
        : { originalFileName: options.originalFileName }),
      ...(options.declaredContentType === undefined
        ? {}
        : { declaredContentType: options.declaredContentType }),
    },
  });
  expect(grantResponse.statusCode).toBe(201);
  const { artifactId, uploadId } = grantResponse.json() as {
    artifactId: string;
    uploadId: string;
  };
  const bytes = options.bytes ?? "synthetic-download-bytes";
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
    payload: {
      uploadId,
      sizeBytes: Buffer.byteLength(bytes),
      digest: sha256(bytes),
    },
  });
  expect(complete.statusCode).toBe(200);
  return artifactId;
}

function contentUrl(engagementId: string, artifactId: string): string {
  return `/api/v1/engagements/${engagementId}/artifacts/${artifactId}/content`;
}

describe("operator artifact download route", () => {
  it("streams published bytes with safe headers, safe name honored, declared content type ignored", async () => {
    const harness = await createHarness();
    const enrolled = await enroll(harness.app);
    const target = await setupLeasedRun(harness, enrolled.runner.id, "action-dl-good");
    const artifactId = await publishArtifact(harness, enrolled, target.lease, {
      originalFileName: "safe-name_1",
      declaredContentType: "text/html;<script>alert(1)</script>",
      bytes: "expected-artifact-payload",
    });

    const response = await harness.app.inject({
      method: "GET",
      url: contentUrl(target.engagementId, artifactId),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("expected-artifact-payload");
    expect(response.headers["content-type"]).toBe("application/octet-stream");
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="safe-name_1"',
    );
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["content-length"]).toBe(
      String("expected-artifact-payload".length),
    );
    // Hostile advisory metadata must not appear anywhere in the response.
    expect(response.payload).not.toContain("<script>");
  });

  it.each([
    ["unsafe shell name", "../../etc/passwd"],
    ["dotted name", "report.final.txt"],
    ["traversal segments", "..\\..\\secrets"],
    ["overlong name", "x".repeat(129)],
  ])("falls back for a %s", async (_label, hostileName) => {
    const harness = await createHarness();
    const enrolled = await enroll(harness.app);
    const target = await setupLeasedRun(harness, enrolled.runner.id, "action-dl-name");
    const artifactId = await publishArtifact(harness, enrolled, target.lease, {
      originalFileName: hostileName,
      bytes: "name-fallback-bytes",
    });

    const response = await harness.app.inject({
      method: "GET",
      url: contentUrl(target.engagementId, artifactId),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toBe(
      `attachment; filename="artifact-${artifactId}-bin"`,
    );
    // The original hostile name must never leak into the response.
    expect(response.payload).not.toContain(hostileName.slice(0, 12));
  });

  it("treats unknown artifacts and engagement mismatches as the same 404 and rejects malformed ids", async () => {
    const harness = await createHarness();
    const enrolled = await enroll(harness.app);
    const target = await setupLeasedRun(harness, enrolled.runner.id, "action-dl-404");
    const other = await setupLeasedRun(harness, enrolled.runner.id, "action-dl-404-b");
    const artifactId = await publishArtifact(harness, enrolled, target.lease);

    const mismatch = await harness.app.inject({
      method: "GET",
      url: contentUrl(other.engagementId, artifactId),
    });
    const unknown = await harness.app.inject({
      method: "GET",
      url: contentUrl(other.engagementId, "unknown-artifact-id"),
    });
    expect(mismatch.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(mismatch.body).toBe(unknown.body);
    expect(mismatch.json()).toEqual({ code: "artifact_not_found" });

    // Malformed identifiers fail validation without any lookup.
    const badEngagement = await harness.app.inject({
      method: "GET",
      url: contentUrl("not-a-uuid", artifactId),
    });
    const badArtifact = await harness.app.inject({
      method: "GET",
      url: contentUrl(target.engagementId, "Rejected_Id"),
    });
    expect(badEngagement.statusCode).toBe(400);
    expect(badArtifact.statusCode).toBe(400);
    expect(badArtifact.json()).toEqual({ code: "invalid_request" });
  });

  it("reports a vanished published file as missing_artifact", async () => {
    const harness = await createHarness();
    const enrolled = await enroll(harness.app);
    const target = await setupLeasedRun(harness, enrolled.runner.id, "action-dl-miss");
    const artifactId = await publishArtifact(harness, enrolled, target.lease);
    await unlink(path.join(harness.directory, "evidence/published", artifactId));

    const response = await harness.app.inject({
      method: "GET",
      url: contentUrl(target.engagementId, artifactId),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: "missing_artifact" });
  });

  it("reports tampered published bytes as corrupt_artifact without path leakage", async () => {
    const harness = await createHarness();
    const enrolled = await enroll(harness.app);
    const target = await setupLeasedRun(harness, enrolled.runner.id, "action-dl-corrupt");
    const artifactId = await publishArtifact(harness, enrolled, target.lease);
    await writeFile(
      path.join(harness.directory, "evidence/published", artifactId),
      "tampered-content",
      { mode: 0o600 },
    );

    const response = await harness.app.inject({
      method: "GET",
      url: contentUrl(target.engagementId, artifactId),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: "corrupt_artifact" });
    expect(response.payload).not.toContain("evidence");
  });

  it("serves an empty artifact with zero content length", async () => {
    const harness = await createHarness();
    const enrolled = await enroll(harness.app);
    const target = await setupLeasedRun(harness, enrolled.runner.id, "action-dl-empty");
    const artifactId = await publishArtifact(harness, enrolled, target.lease, {
      bytes: "",
    });

    const response = await harness.app.inject({
      method: "GET",
      url: contentUrl(target.engagementId, artifactId),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("");
    expect(response.headers["content-length"]).toBe("0");
  });

  it("rejects runner credentials on the operator download route only", async () => {
    const harness = await createHarness();
    const enrolled = await enroll(harness.app);
    const target = await setupLeasedRun(harness, enrolled.runner.id, "action-dl-runner");
    const artifactId = await publishArtifact(harness, enrolled, target.lease);

    const onDownload = await harness.app.inject({
      method: "GET",
      url: contentUrl(target.engagementId, artifactId),
      headers: {
        authorization: formatRunnerAuthorization(enrolled.runner.id, enrolled.secret),
      },
    });
    expect(onDownload.statusCode).toBe(403);
    expect(onDownload.json()).toEqual({ code: "operator_identity_required" });

    // Existing behavior elsewhere is untouched: operator GET routes still
    // answer normally when a runner credential rides along.
    const elsewhere = await harness.app.inject({
      method: "GET",
      url: "/api/v1/engagements",
      headers: {
        authorization: formatRunnerAuthorization(enrolled.runner.id, enrolled.secret),
      },
    });
    expect(elsewhere.statusCode).toBe(403);
    expect(elsewhere.json()).toEqual({ code: "runner_route_forbidden" });
  });

  it("treats POST on the artifact content URL as a non-operator-GET route", async () => {
    const harness = await createHarness();
    const enrolled = await enroll(harness.app);
    const target = await setupLeasedRun(harness, enrolled.runner.id, "action-dl-post");
    const artifactId = await publishArtifact(harness, enrolled, target.lease);

    const posted = await harness.app.inject({
      method: "POST",
      url: contentUrl(target.engagementId, artifactId),
      headers: {
        authorization: formatRunnerAuthorization(enrolled.runner.id, enrolled.secret),
      },
      payload: {},
    });
    // Not the operator GET surface: the generic runner-credential refusal
    // applies instead of operator_identity_required.
    expect(posted.statusCode).toBe(403);
    expect(posted.json()).toEqual({ code: "runner_route_forbidden" });

    // Without a credential, an unregistered method stays a routing 404.
    const anonymousPost = await harness.app.inject({
      method: "POST",
      url: contentUrl(target.engagementId, artifactId),
      payload: {},
    });
    expect(anonymousPost.statusCode).toBe(404);
  });

  it("does not expose HEAD: no verification runs and no content headers return", async () => {
    const harness = await createHarness();
    const enrolled = await enroll(harness.app);
    const target = await setupLeasedRun(harness, enrolled.runner.id, "action-dl-head");
    const artifactId = await publishArtifact(harness, enrolled, target.lease);

    // Tamper with the published file first: if verification ran, HEAD would
    // surface a 409 rather than a plain routing miss.
    await writeFile(
      path.join(harness.directory, "evidence/published", artifactId),
      "tampered-content",
      { mode: 0o600 },
    );

    const head = await harness.app.inject({
      method: "HEAD",
      url: contentUrl(target.engagementId, artifactId),
    });
    expect(head.statusCode).toBe(404);
    expect(head.headers["content-disposition"]).toBeUndefined();
    expect(head.headers["x-content-type-options"]).toBeUndefined();
    expect(head.headers["content-type"]).not.toBe("application/octet-stream");
    expect(head.body).not.toContain("tampered-content");

    // A runner credential on HEAD keeps the generic refusal: the auth hook
    // runs before routing and never reports operator_identity_required.
    const headWithRunner = await harness.app.inject({
      method: "HEAD",
      url: contentUrl(target.engagementId, artifactId),
      headers: {
        authorization: formatRunnerAuthorization(enrolled.runner.id, enrolled.secret),
      },
    });
    expect(headWithRunner.statusCode).toBe(403);
    expect(headWithRunner.json()).toEqual({ code: "runner_route_forbidden" });
  });

  it("rejects Range requests before lookup with no artifact bytes", async () => {
    const harness = await createHarness();
    const enrolled = await enroll(harness.app);
    const target = await setupLeasedRun(harness, enrolled.runner.id, "action-dl-range");
    const artifactId = await publishArtifact(harness, enrolled, target.lease);

    const known = await harness.app.inject({
      method: "GET",
      url: contentUrl(target.engagementId, artifactId),
      headers: { range: "bytes=0-3" },
    });
    expect(known.statusCode).toBe(400);
    expect(known.json()).toEqual({ code: "range_not_supported" });
    expect(known.body).not.toContain("synthetic-download-bytes");

    // Even an unknown artifact gets the range refusal first.
    const unknownWithRange = await harness.app.inject({
      method: "GET",
      url: contentUrl(target.engagementId, "never-published-id"),
      headers: { range: "bytes=0-3" },
    });
    expect(unknownWithRange.statusCode).toBe(400);
    expect(unknownWithRange.json()).toEqual({ code: "range_not_supported" });
  });

  it("never echoes the authorization header or the hostile original name", async () => {
    const harness = await createHarness();
    const enrolled = await enroll(harness.app);
    const target = await setupLeasedRun(harness, enrolled.runner.id, "action-dl-leak");
    const hostileName = "../../owned-file-name";
    const artifactId = await publishArtifact(harness, enrolled, target.lease, {
      originalFileName: hostileName,
    });

    const response = await harness.app.inject({
      method: "GET",
      url: contentUrl(target.engagementId, artifactId),
      headers: {
        authorization: formatRunnerAuthorization(enrolled.runner.id, enrolled.secret),
      },
    });
    expect(response.statusCode).toBe(403);
    expect(JSON.stringify(response.headers)).not.toContain("authorization");
    expect(response.payload).not.toContain(enrolled.secret);

    const success = await harness.app.inject({
      method: "GET",
      url: contentUrl(target.engagementId, artifactId),
    });
    expect(success.statusCode).toBe(200);
    expect(success.payload).not.toContain(hostileName);
    expect(success.payload).not.toContain("..");
  });
});
