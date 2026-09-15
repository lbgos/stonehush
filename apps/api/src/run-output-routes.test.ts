import { chmod, mkdtemp, rm } from "node:fs/promises";
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
  RunOutputRepository,
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
    warningState: { reasonCodes: [], knownAdditions: [], acknowledgment: null },
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
}

async function createHarness(): Promise<Harness> {
  const native = loadEvidenceNative();
  if (!native.ok) throw new Error(`native binding unavailable: ${native.reason}`);
  const directory = await mkdtemp(path.join(tmpdir(), "run-output-"));
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
    runOutputRepository: new RunOutputRepository(database.db),
    getDevelopmentStorageReadiness: () => "ready",
    logger: false,
    now: clock,
  });
  app.addHook("onClose", async () => database.close());
  apps.push(app);
  return { app, database, engagementRepository, runRepository };
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
    name: `Output lab ${actionId}`,
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
    sessionId: "session-output-1",
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

function ensureStarted(
  harness: Harness,
  enrolled: { runner: { id: string }; secret: string },
  lease: RunnerLease,
): void {
  const started = harness.runRepository.appendEvent({
    presented: {
      runId: lease.runId,
      leaseId: lease.leaseId,
      runnerId: enrolled.runner.id,
      sessionId: lease.sessionId,
      fence: lease.fence,
    },
    sequence: 1,
    type: "started",
    serverNow: "2026-08-09T12:00:01.000Z",
  });
  if (!started.ok) throw new Error(`started failed: ${started.error.code}`);
}

async function publishStream(
  harness: Harness,
  enrolled: { runner: { id: string }; secret: string },
  lease: RunnerLease,
  slot: string,
  bytes: string,
): Promise<void> {
  const grantResponse = await harness.app.inject({
    method: "POST",
    url: "/api/v1/runner/artifacts/grants",
    headers: {
      authorization: formatRunnerAuthorization(enrolled.runner.id, enrolled.secret),
      "idempotency-key": `output-grant-${slot}-${++grantKeyCounter}-${Math.random().toString(36).slice(2, 10)}`,
    },
    payload: {
      runId: lease.runId,
      leaseId: lease.leaseId,
      sessionId: lease.sessionId,
      fence: lease.fence,
      eventSequence: 2,
      artifactSlot: slot,
      kind: slot,
    },
  });
  expect(grantResponse.statusCode).toBe(201);
  const { uploadId } = grantResponse.json() as {
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
    payload: {
      uploadId,
      sizeBytes: Buffer.byteLength(bytes),
      digest: sha256(bytes),
    },
  });
  expect(complete.statusCode).toBe(200);
}

function completeTerminal(
  harness: Harness,
  lease: RunnerLease,
  runnerId: string,
  terminalKind: "succeeded" | "failed" | "cancelled",
): void {
  const completed = harness.runRepository.completeRun({
    presented: {
      runId: lease.runId,
      leaseId: lease.leaseId,
      runnerId,
      sessionId: lease.sessionId,
      fence: lease.fence,
    },
    sequence: 2,
    terminalKind,
    reason: terminalKind === "succeeded" ? null : "operator_cancelled",
    serverNow: "2026-08-09T12:00:10.000Z",
  });
  expect(completed.ok).toBe(true);
}

describe("operator run output routes", () => {
  it("serves exact preserved stdout and stderr for the latest terminal run", async () => {
    const harness = await createHarness();
    const enrolled = await enroll(harness.app);
    const target = await setupLeasedRun(harness, enrolled.runner.id, "action-out-good");
    ensureStarted(harness, enrolled, target.lease);
    await publishStream(harness, enrolled, target.lease, "stdout", "hello-stdout-bytes");
    await publishStream(harness, enrolled, target.lease, "stderr", "hello-stderr-bytes");
    completeTerminal(harness, target.lease, enrolled.runner.id, "succeeded");

    const latest = await harness.app.inject({
      method: "GET",
      url: `/api/v1/engagements/${target.engagementId}/runs/latest/output`,
    });
    expect(latest.statusCode).toBe(200);
    const body = latest.json() as {
      run: { id: string; state: string };
      stdout: { present: boolean; content: string; truncated: boolean };
      stderr: { present: boolean; content: string; truncated: boolean };
    };
    expect(body.run.id).toBe(target.runId);
    expect(body.run.state).toBe("succeeded");
    expect(body.stdout).toMatchObject({
      present: true,
      content: "hello-stdout-bytes",
      truncated: false,
    });
    expect(body.stderr).toMatchObject({
      present: true,
      content: "hello-stderr-bytes",
      truncated: false,
    });

    const perRun = await harness.app.inject({
      method: "GET",
      url: `/api/v1/engagements/${target.engagementId}/runs/${target.runId}/output`,
    });
    expect(perRun.statusCode).toBe(200);
    expect(perRun.json()).toEqual(body);
  });

  it("reports absent streams when no stdout or stderr artifact exists", async () => {
    const harness = await createHarness();
    const enrolled = await enroll(harness.app);
    const target = await setupLeasedRun(harness, enrolled.runner.id, "action-out-absent");
    ensureStarted(harness, enrolled, target.lease);
    harness.database.sqlite.prepare("update runs set state = 'cancel_requested' where id = ?").run(target.runId);
    completeTerminal(harness, target.lease, enrolled.runner.id, "cancelled");

    const response = await harness.app.inject({
      method: "GET",
      url: `/api/v1/engagements/${target.engagementId}/runs/latest/output`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      stdout: { present: false, truncated: false, content: "" },
      stderr: { present: false, truncated: false, content: "" },
    });
  });

  it("truncates oversized output with a truthful truncated flag", async () => {
    const harness = await createHarness();
    const enrolled = await enroll(harness.app);
    const target = await setupLeasedRun(harness, enrolled.runner.id, "action-out-big");
    ensureStarted(harness, enrolled, target.lease);
    const big = `x`.repeat(70 * 1024);
    await publishStream(harness, enrolled, target.lease, "stdout", big);
    completeTerminal(harness, target.lease, enrolled.runner.id, "failed");

    const response = await harness.app.inject({
      method: "GET",
      url: `/api/v1/engagements/${target.engagementId}/runs/${target.runId}/output`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      stdout: { present: boolean; truncated: boolean; content: string; sizeBytes: number };
    };
    expect(body.stdout.present).toBe(true);
    expect(body.stdout.truncated).toBe(true);
    expect(body.stdout.content.length).toBe(64 * 1024);
    expect(body.stdout.sizeBytes).toBe(70 * 1024);
    expect(big.startsWith(body.stdout.content)).toBe(true);
  });

  it("returns no_terminal_run before any terminal run and hides non-terminal runs", async () => {
    const harness = await createHarness();
    const enrolled = await enroll(harness.app);
    const target = await setupLeasedRun(harness, enrolled.runner.id, "action-out-pending");

    const latest = await harness.app.inject({
      method: "GET",
      url: `/api/v1/engagements/${target.engagementId}/runs/latest/output`,
    });
    expect(latest.statusCode).toBe(404);
    expect(latest.json()).toEqual({ code: "no_terminal_run" });

    const perRun = await harness.app.inject({
      method: "GET",
      url: `/api/v1/engagements/${target.engagementId}/runs/${target.runId}/output`,
    });
    expect(perRun.statusCode).toBe(404);
    expect(perRun.json()).toEqual({ code: "run_not_found" });
  });

  it("rejects unknown engagement, unknown run, and malformed ids", async () => {
    const harness = await createHarness();
    const enrolled = await enroll(harness.app);
    const target = await setupLeasedRun(harness, enrolled.runner.id, "action-out-404");
    ensureStarted(harness, enrolled, target.lease);
    await publishStream(harness, enrolled, target.lease, "stdout", "bytes");
    completeTerminal(harness, target.lease, enrolled.runner.id, "succeeded");

    const unknownEngagement = await harness.app.inject({
      method: "GET",
      url: `/api/v1/engagements/10000000-0000-4000-8000-000000000099/runs/latest/output`,
    });
    expect(unknownEngagement.statusCode).toBe(404);
    expect(unknownEngagement.json()).toEqual({ code: "engagement_not_found" });

    const unknownRun = await harness.app.inject({
      method: "GET",
      url: `/api/v1/engagements/${target.engagementId}/runs/run-does-not-exist/output`,
    });
    expect(unknownRun.statusCode).toBe(404);
    expect(unknownRun.json()).toEqual({ code: "run_not_found" });

    const malformed = await harness.app.inject({
      method: "GET",
      url: `/api/v1/engagements/not-a-uuid/runs/latest/output`,
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({ code: "invalid_request" });
  });

  it("refuses runner credentials on both output routes and rejects Range", async () => {
    const harness = await createHarness();
    const enrolled = await enroll(harness.app);
    const target = await setupLeasedRun(harness, enrolled.runner.id, "action-out-auth");
    ensureStarted(harness, enrolled, target.lease);
    await publishStream(harness, enrolled, target.lease, "stdout", "auth-bytes");
    completeTerminal(harness, target.lease, enrolled.runner.id, "succeeded");

    for (const url of [
      `/api/v1/engagements/${target.engagementId}/runs/latest/output`,
      `/api/v1/engagements/${target.engagementId}/runs/${target.runId}/output`,
    ]) {
      const withRunner = await harness.app.inject({
        method: "GET",
        url,
        headers: {
          authorization: formatRunnerAuthorization(enrolled.runner.id, enrolled.secret),
        },
      });
      expect(withRunner.statusCode).toBe(403);
      expect(withRunner.json()).toEqual({ code: "operator_identity_required" });

      const withRange = await harness.app.inject({
        method: "GET",
        url,
        headers: { range: "bytes=0-3" },
      });
      expect(withRange.statusCode).toBe(400);
      expect(withRange.json()).toEqual({ code: "invalid_request" });
    }
  });
});
