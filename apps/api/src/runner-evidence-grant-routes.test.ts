import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
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
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

const fixtureFingerprint =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const digestA = `sha256:${"a".repeat(64)}`;

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const directories: string[] = [];
const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
  await Promise.all(
    directories.splice(0).map(async (directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function boundSnapshot(actionId: string): ActionSnapshot {
  const snapshot: ActionSnapshot = {
    normalizationProfile: "d1-v1",
    orchestrationProfile: "d2-v1",
    snapshotId: `snapshot-${actionId}`,
    version: 1,
    binding: digestA,
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

async function createHarness() {
  const directory = await mkdtemp(path.join(tmpdir(), "stonehush-grant-api-"));
  directories.push(directory);
  await chmod(directory, 0o700);
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
  });
  const operatorCommandRepository = new OperatorCommandRepository(
    engagementRepository,
    { now: clock },
  );
  const app = buildApp({
    engagementRepository,
    operatorCommandRepository,
    runRepository,
    runnerRepository,
    evidenceGrantRepository,
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

async function enroll(app: ReturnType<typeof buildApp>) {
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

function runnerHeaders(runnerId: string, secret: string, key?: string) {
  return {
    authorization: formatRunnerAuthorization(runnerId, secret),
    ...(key === undefined ? {} : { "idempotency-key": key }),
  };
}

function queueRun(
  harness: Awaited<ReturnType<typeof createHarness>>,
  actionId: string,
): string {
  const engagement = harness.engagementRepository.createEngagement({
    name: "Grant fixture lab",
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
  return row.id;
}

async function leaseQueuedRun(
  harness: Awaited<ReturnType<typeof createHarness>>,
  runId: string,
  sessionId = "session-fixture-1",
) {
  const acquired = harness.runRepository.acquireLease({
    runId,
    runnerId: "runner-fixture-1",
    sessionId,
    serverNow: "2026-08-09T12:00:00.500Z",
  });
  if (!acquired.ok) throw new Error(acquired.error.code);
  return acquired.value.lease;
}

function grantPayload(
  lease: RunnerLease,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    runId: lease.runId,
    leaseId: lease.leaseId,
    sessionId: lease.sessionId,
    fence: lease.fence,
    eventSequence: 1,
    artifactSlot: "stdout",
    kind: "stdout",
    ...overrides,
  };
}

describe("POST /api/v1/runner/artifacts/grants", () => {
  it("admits an authenticated current-lease grant and returns generated upload identities", async () => {
    const harness = await createHarness();
    const enrolled = await enroll(harness.app);
    const runId = queueRun(harness, "action-fixture-grant-happy");
    const lease = await leaseQueuedRun(harness, runId);
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/runner/artifacts/grants",
      headers: runnerHeaders(enrolled.runner.id, enrolled.secret, "grant-key-happy-0000000000"),
      payload: grantPayload(lease),
    });
    expect(response.statusCode).toBe(201);
    const parsed = EvidenceGrantResponseSchema.safeParse(response.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.artifactId).toMatch(UUID_V4_PATTERN);
    expect(parsed.data.uploadId).toMatch(UUID_V4_PATTERN);
    expect(parsed.data.artifactId).not.toBe(parsed.data.uploadId);
    // The caller never chose identity fields and none are echoed back.
    expect(JSON.stringify(response.json())).not.toContain("caller");
  });

  it("replays the stored response for a repeated key and conflicts on a changed body", async () => {
    const harness = await createHarness();
    const enrolled = await enroll(harness.app);
    const runId = queueRun(harness, "action-fixture-grant-replay");
    const lease = await leaseQueuedRun(harness, runId);
    const first = await harness.app.inject({
      method: "POST",
      url: "/api/v1/runner/artifacts/grants",
      headers: runnerHeaders(enrolled.runner.id, enrolled.secret, "grant-key-replay-00000000"),
      payload: grantPayload(lease),
    });
    expect(first.statusCode).toBe(201);
    const replay = await harness.app.inject({
      method: "POST",
      url: "/api/v1/runner/artifacts/grants",
      headers: runnerHeaders(enrolled.runner.id, enrolled.secret, "grant-key-replay-00000000"),
      payload: grantPayload(lease),
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    const conflict = await harness.app.inject({
      method: "POST",
      url: "/api/v1/runner/artifacts/grants",
      headers: runnerHeaders(enrolled.runner.id, enrolled.secret, "grant-key-replay-00000000"),
      payload: grantPayload(lease, { artifactSlot: "tool-raw", kind: "tool_raw" }),
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ code: "idempotency_conflict" });
    // leaseId is part of the canonical digest: changing only it conflicts
    // instead of replaying the stored grant response.
    const leaseIdConflict = await harness.app.inject({
      method: "POST",
      url: "/api/v1/runner/artifacts/grants",
      headers: runnerHeaders(enrolled.runner.id, enrolled.secret, "grant-key-replay-00000000"),
      payload: grantPayload(lease, { leaseId: "lease-fixture-other" }),
    });
    expect(leaseIdConflict.statusCode).toBe(409);
    expect(leaseIdConflict.json()).toEqual({ code: "idempotency_conflict" });
    const rows = harness.database.sqlite
      .prepare("select count(*) as c from evidence_grants")
      .get() as { c: number };
    expect(rows.c).toBe(1);
  });

  it("rejects missing idempotency keys, operator credentials, and anonymous calls", async () => {
    const harness = await createHarness();
    const enrolled = await enroll(harness.app);
    const runId = queueRun(harness, "action-fixture-grant-authz");
    const lease = await leaseQueuedRun(harness, runId);
    const noKey = await harness.app.inject({
      method: "POST",
      url: "/api/v1/runner/artifacts/grants",
      headers: runnerHeaders(enrolled.runner.id, enrolled.secret),
      payload: grantPayload(lease),
    });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json()).toEqual({ code: "invalid_request" });
    const operatorCredential = await harness.app.inject({
      method: "POST",
      url: "/api/v1/runner/artifacts/grants",
      headers: {
        authorization: "Bearer local-operator-token-placeholder",
        "idempotency-key": "grant-key-operator-000000000",
      },
      payload: grantPayload(lease),
    });
    expect(operatorCredential.statusCode).toBe(403);
    expect(operatorCredential.json()).toEqual({ code: "runner_identity_required" });
    const anonymous = await harness.app.inject({
      method: "POST",
      url: "/api/v1/runner/artifacts/grants",
      headers: { "idempotency-key": "grant-key-anon-000000000000" },
      payload: grantPayload(lease),
    });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toEqual({ code: "runner_unauthorized" });
  });

  it("rejects caller-supplied identities, paths, and malformed bodies before mutation", async () => {
    const harness = await createHarness();
    const enrolled = await enroll(harness.app);
    const runId = queueRun(harness, "action-fixture-grant-badbody");
    const lease = await leaseQueuedRun(harness, runId);
    for (const [index, payload] of [
      grantPayload(lease, { artifactId: "caller-chosen-id" }),
      grantPayload(lease, { uploadId: "caller-chosen-upload" }),
      grantPayload(lease, { stagingPath: "published/x" }),
      grantPayload(lease, { artifactSlot: "../escape" }),
      grantPayload(lease, { declaredSizeBytes: -5 }),
      grantPayload(lease, { kind: "mystery" }),
    ].entries()) {
      const response = await harness.app.inject({
        method: "POST",
        url: "/api/v1/runner/artifacts/grants",
        headers: runnerHeaders(
          enrolled.runner.id,
          enrolled.secret,
          `grant-key-invalid-${String(index).padStart(10, "0")}`,
        ),
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ code: "invalid_request" });
    }
    const rows = harness.database.sqlite
      .prepare("select count(*) as c from evidence_grants")
      .get() as { c: number };
    expect(rows.c).toBe(0);
  });

  it("fails closed on wrong fence, wrong session, duplicate in-flight identity, and terminal runs", async () => {
    const harness = await createHarness();
    const enrolled = await enroll(harness.app);
    const runId = queueRun(harness, "action-fixture-grant-failclosed");
    const lease = await leaseQueuedRun(harness, runId);
    let keySeq = 0;
    const post = async (payload: Record<string, unknown>) => {
      keySeq += 1;
      return harness.app.inject({
        method: "POST",
        url: "/api/v1/runner/artifacts/grants",
        headers: runnerHeaders(
          enrolled.runner.id,
          enrolled.secret,
          `grant-key-failclosed-${String(keySeq).padStart(8, "0")}`,
        ),
        payload,
      });
    };
    const staleFence = await post(grantPayload(lease, { fence: "999" }));
    expect(staleFence.statusCode).toBe(409);
    expect(staleFence.json()).toEqual({ code: "stale_fence" });
    const gap = await post(grantPayload(lease, { eventSequence: 2 }));
    expect(gap.statusCode).toBe(409);
    expect(gap.json()).toEqual({ code: "event_sequence_gap", expectedSequence: 1 });
    const imposterSession = await post(
      grantPayload(lease, { sessionId: "session-imposter" }),
    );
    expect(imposterSession.statusCode).toBe(403);
    expect(imposterSession.json()).toEqual({ code: "lease_owner_mismatch" });
    const admitted = await post(grantPayload(lease));
    expect(admitted.statusCode).toBe(201);
    const admittedArtifactId = EvidenceGrantResponseSchema.safeParse(
      admitted.json(),
    );
    expect(admittedArtifactId.success).toBe(true);
    if (!admittedArtifactId.success) return;
    const duplicate = await post(grantPayload(lease));
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ code: "artifact_upload_in_progress" });

    // The admitted in-progress grant binds and blocks sequence 1 while the
    // cursor is 0, so completion at sequence 1 cannot proceed until the upload
    // leaves the in-progress state.
    harness.database.sqlite
      .prepare("update evidence_grants set state = 'upload_interrupted' where artifact_id = ?")
      .run(admittedArtifactId.data.artifactId);
    const completed = harness.runRepository.completeRun({
      presented: {
        runId: lease.runId,
        leaseId: lease.leaseId,
        runnerId: lease.runnerId,
        sessionId: lease.sessionId,
        fence: lease.fence,
      },
      sequence: 1,
      terminalKind: "failed",
      reason: "runner_lost",
      serverNow: "2026-08-09T12:00:10.000Z",
    });
    expect(completed.ok).toBe(true);
    // The terminal event consumed sequence 1, so a late grant must bind
    // sequence 2 and still fail closed against the terminal run.
    const afterTerminal = await post(
      grantPayload(lease, {
        eventSequence: 2,
        artifactSlot: "late-slot",
        kind: "tool_raw",
      }),
    );
    expect(afterTerminal.statusCode).toBe(409);
    expect(afterTerminal.json()).toEqual({ code: "run_already_terminal" });
  });
});
