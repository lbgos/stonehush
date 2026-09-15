import { createHash } from "node:crypto";
import { chmodSync, constants } from "node:fs";
import { chmod, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AdvisorTurnsRepository,
  EngagementRepository,
  EvidenceGrantRepository,
  SettingsRepository,
  openEngagementDatabase,
} from "@stonehush/db";
import { ADVISOR_EXPLANATION_PROFILE } from "@stonehush/contracts";
import { loadEvidenceNative } from "@stonehush/evidence-native";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AdvisorTransportRawResponse,
  AdvisorTransportRequestFn,
  AdvisorTransportRequestOptions,
} from "./advisor-transport.js";
import { buildApp } from "../app.js";
import { EvidenceStore } from "../evidence/evidence-store.js";
import { buildStorageBackedApp } from "../runtime.js";

const KEY_ENV_VAR = "STONEHUSH_ADVISOR_TURNS_TEST_KEY";
const KEY_VALUE = "lab-advisor-key-value";

const temporaryDirectories: string[] = [];
const openApps: ReturnType<typeof buildApp>[] = [];
const openDatabases: ReturnType<typeof openEngagementDatabase>[] = [];

afterEach(async () => {
  delete process.env[KEY_ENV_VAR];
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
  for (const database of openDatabases.splice(0)) {
    if (database.sqlite.open) database.close();
  }
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  vi.restoreAllMocks();
});

interface FakeTransport {
  readonly requestFn: AdvisorTransportRequestFn;
  hits(): number;
  authorizations(): Array<string | undefined>;
  bodies(): Buffer[];
  hold(): void;
  release(): void;
  waitForHits(count: number): Promise<void>;
  waitForServerAbort(timeoutMs?: number): Promise<void>;
}

function createFakeTransport(
  respond: (body: Buffer) => AdvisorTransportRawResponse,
): FakeTransport {
  let hits = 0;
  const authorizations: Array<string | undefined> = [];
  const bodies: Buffer[] = [];
  let gate: Promise<void> = Promise.resolve();
  let releaseGate: () => void = () => {};
  const waiters: Array<() => void> = [];
  const signals: AbortSignal[] = [];
  const notify = () => {
    for (const waiter of waiters.splice(0)) waiter();
  };
  return {
    requestFn: (async (options: AdvisorTransportRequestOptions) => {
      hits += 1;
      const authorization = options.headers.authorization;
      authorizations.push(typeof authorization === "string" ? authorization : undefined);
      bodies.push(options.body);
      if (options.signal !== undefined) signals.push(options.signal);
      notify();
      await gate;
      if (options.signal?.aborted) {
        throw Object.assign(new Error("aborted"), { code: "cancelled" });
      }
      return respond(options.body);
    }) as AdvisorTransportRequestFn,
    hits: () => hits,
    authorizations: () => [...authorizations],
    bodies: () => [...bodies],
    hold: () => {
      gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
    },
    release: () => releaseGate(),
    waitForHits: (count: number) =>
      new Promise<void>((resolve) => {
        if (hits >= count) {
          resolve();
          return;
        }
        const check = () => {
          if (hits >= count) resolve();
          else waiters.push(check);
        };
        waiters.push(check);
      }),
    // Resolves once a signal handed to the fake has actually aborted, so
    // the test only releases a held provider after the server observed
    // the disconnect. Bounded: rejects instead of hanging teardown.
    waitForServerAbort: (timeoutMs = 5_000): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const done = () => {
          for (const signal of signals) signal.removeEventListener("abort", onAbort);
          clearTimeout(timer);
        };
        const onAbort = () => {
          done();
          resolve();
        };
        const timer = setTimeout(() => {
          done();
          reject(new Error("timed out waiting for server-side abort"));
        }, timeoutMs);
        for (const signal of signals) signal.addEventListener("abort", onAbort, { once: true });
        if (signals.some((signal) => signal.aborted)) {
          done();
          resolve();
        }
      }),
  };
}

function completionResponse(explanation: unknown): AdvisorTransportRawResponse {
  return {
    statusCode: 200,
    contentType: "application/json",
    body: Buffer.from(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(explanation) } }] }),
      "utf8",
    ),
  };
}

function successExplanation(artifactId: string, citations?: string[]) {
  return {
    profile: "advisor-explanation-v1",
    answer: `Evidence shows service on ${artifactId}.`,
    uncertainty: "",
    citations: citations ?? [artifactId],
    abstained: false,
  };
}

interface Harness {
  app: ReturnType<typeof buildApp>;
  database: ReturnType<typeof openEngagementDatabase>;
  directory: string;
  engagementId: string;
  engagementRepository: EngagementRepository;
  settingsRepository: SettingsRepository;
  clock: { now: Date };
  transport: FakeTransport;
}

async function createHarness(options?: {
  respond?: (body: Buffer) => AdvisorTransportRawResponse;
  env?: NodeJS.ProcessEnv;
}): Promise<Harness> {
  const directory = await mkdtemp(path.join(tmpdir(), "stonehush-advisor-turns-test-"));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  const native = loadEvidenceNative();
  if (!native.ok) throw new Error(`native binding unavailable: ${native.reason}`);
  const storeResult = EvidenceStore.open(directory, native.binding);
  if (!storeResult.ok) throw new Error(`store open failed: ${storeResult.code}`);
  const database = openEngagementDatabase({ dataDirectory: directory });
  openDatabases.push(database);
  const clock = { now: new Date("2026-08-09T12:00:00.000Z") };
  const engagementRepository = new EngagementRepository(database.db);
  const turnsRepository = new AdvisorTurnsRepository(database.db, {
    now: () => new Date(clock.now),
  });
  const settingsRepository = new SettingsRepository(database.db);
  const evidenceGrantRepository = new EvidenceGrantRepository(database.db);
  const created = engagementRepository.createEngagement({
    name: "Turns lab",
    kind: "lab",
    autoContinueWarnings: false,
  });
  if (!created.ok) throw new Error("engagement fixture failed");
  const settings = settingsRepository.updateAdvisorSettings({
    endpointBaseUrl: "http://127.0.0.1:9/v1",
    modelId: "test-model",
    apiKeyEnvVar: "",
    publicEndpointOptIn: false,
  });
  if (!settings.ok) throw new Error("settings fixture failed");
  const transport = createFakeTransport(
    options?.respond ??
      (() => completionResponse(successExplanation("00000000-0000-4000-8000-000000000001"))),
  );
  const app = buildApp({
    engagementRepository,
    getDevelopmentStorageReadiness: () => "ready",
    evidenceGrantRepository,
    evidenceStore: storeResult.store,
    settingsRepository,
    advisorTurnsRepository: turnsRepository,
    advisorTurns: {
      transport: { requestFn: transport.requestFn },
      ...(options?.env === undefined ? {} : { env: options.env }),
    },
    logger: false,
    now: () => new Date(clock.now),
  });
  app.addHook("onClose", async () => database.close());
  openApps.push(app);
  return {
    app,
    database,
    directory,
    engagementId: created.value.id,
    engagementRepository,
    settingsRepository,
    clock,
    transport,
  };
}

async function writeArtifact(
  directory: string,
  database: ReturnType<typeof openEngagementDatabase>,
  engagementId: string,
  artifactId: string,
  bytes: Buffer,
  actionId: string,
  runId: string,
): Promise<void> {
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const now = new Date().toISOString();
  database.sqlite
    .prepare(
      `insert into actions (id, contract_version, engagement_id, revision, state, queued_snapshot_version, warning_interactions, run_state, resume_requested, cleanup_required, capability_error_code, pending_warning_json, created_at, updated_at) values (?,1,?,1,'active',1,0,'running',0,0,null,null,?,?)`,
    )
    .run(actionId, engagementId, now, now);
  database.sqlite
    .prepare(
      `insert into runs (id, contract_version, action_id, engagement_id, attempt, state, current_lease_id, current_fence, terminal_kind, terminal_reason, created_at, updated_at) values (?,1,?, ?,1,'running','lease-1','1',null,null,?,?)`,
    )
    .run(runId, actionId, engagementId, now, now);
  const filePath = path.join(directory, "evidence", "published", artifactId);
  const handle = await open(filePath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
  await handle.write(bytes);
  await handle.sync();
  await handle.close();
  chmodSync(filePath, 0o600);
  database.sqlite
    .prepare(
      `insert into evidence_artifacts (artifact_id, contract_version, profile, run_id, fence, event_sequence, artifact_slot, kind, size_bytes, digest, relative_path, completeness, redaction_applied, redaction_boundary, raw_bytes_preserved, created_at) values (?,1,'d3-v1',?,'1',1,'http-probe-raw','tool_raw',?,?,?, 'complete',0,'none',1,?)`,
    )
    .run(artifactId, runId, bytes.length, digest, `published/${artifactId}`, now);
}

function postTurn(
  app: ReturnType<typeof buildApp>,
  engagementId: string,
  key: string,
  artifactId: string,
  overrides: Record<string, unknown> = {},
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/engagements/${engagementId}/advisor/turns`,
    headers: { "idempotency-key": key },
    payload: {
      engagementId,
      question: "What does this evidence show?",
      excerptArtifactIds: [artifactId],
      findingIds: [],
      ...overrides,
    },
  });
}

describe("advisor turn routes", () => {
  it("exposes routes and rejects missing keys without writes", async () => {
    const harness = await createHarness();
    const listed = await harness.app.inject({
      method: "GET",
      url: `/api/v1/engagements/${harness.engagementId}/advisor/turns`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ turns: [], nextCursor: null });
    const rejected = await harness.app.inject({
      method: "POST",
      url: `/api/v1/engagements/${harness.engagementId}/advisor/turns`,
      payload: {
        engagementId: harness.engagementId,
        question: "What does this evidence show?",
        excerptArtifactIds: ["00000000-0000-4000-8000-000000000001"],
        findingIds: [],
      },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toEqual({ code: "invalid_request" });
    const malformed = await harness.app.inject({
      method: "POST",
      url: `/api/v1/engagements/${harness.engagementId}/advisor/turns`,
      headers: { "idempotency-key": "short" },
      payload: {
        engagementId: harness.engagementId,
        question: "What does this evidence show?",
        excerptArtifactIds: ["00000000-0000-4000-8000-000000000001"],
        findingIds: [],
      },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({ code: "invalid_request" });
    const relisted = await harness.app.inject({
      method: "GET",
      url: `/api/v1/engagements/${harness.engagementId}/advisor/turns`,
    });
    expect(relisted.json()).toEqual({ turns: [], nextCursor: null });
  });

  it("completes one provider call with valid citations and redaction", async () => {
    const artifactId = "00000000-0000-4000-8000-000000000001";
    let citedIds = [artifactId];
    const harness = await createHarness({
      respond: () => completionResponse(successExplanation(artifactId, citedIds)),
    });
    await writeArtifact(
      harness.directory,
      harness.database,
      harness.engagementId,
      artifactId,
      Buffer.from("synthetic http probe body"),
      "act-turn-1",
      "run-turn-1",
    );
    const created = harness.engagementRepository.createFinding(harness.engagementId, {
      title: "Open banner",
      severity: "medium",
      body: "Synthetic finding body.",
    });
    if (!created.ok) throw new Error("finding fixture failed");
    citedIds = [artifactId, created.value.id];
    const response = await postTurn(
      harness.app,
      harness.engagementId,
      "fixture-key-turn-happy-path-00",
      artifactId,
      {
        question: "deploy token sk-test-synthetic-secret-000 ?",
        findingIds: [created.value.id],
      },
    );
    expect(response.statusCode).toBe(200);
    const turn = response.json() as {
      id: string;
      status: string;
      answer: string;
      question: string;
      citations: Array<{ raw: string; valid: boolean; kind: string }>;
      redactions: number;
      modelId: string;
    };
    expect(turn.status).toBe("succeeded");
    expect(turn.answer).toContain(artifactId);
    expect(turn.question).toContain("[redacted]");
    expect(turn.question).not.toContain("sk-test-synthetic-secret-000");
    expect(turn.citations).toEqual([
      { raw: artifactId, valid: true, kind: "artifact" },
      { raw: created.value.id, valid: true, kind: "finding" },
    ]);
    expect(turn.redactions).toBeGreaterThan(0);
    expect(turn.modelId).toBe("test-model");
    expect(harness.transport.hits()).toBe(1);
  });

  it("sends the output contract in the assembled system prompt", async () => {
    const harness = await createHarness();
    const artifactId = "00000000-0000-4000-8000-000000000001";
    await writeArtifact(
      harness.directory,
      harness.database,
      harness.engagementId,
      artifactId,
      Buffer.from("synthetic http probe body"),
      "act-turn-contract-1",
      "run-turn-contract-1",
    );
    const response = await postTurn(
      harness.app,
      harness.engagementId,
      "fixture-key-turn-output-contract",
      artifactId,
    );
    expect(response.statusCode).toBe(200);
    const raw = harness.transport.bodies()[0];
    if (raw === undefined) throw new Error("transport request body was not captured");
    const sent = JSON.parse(raw.toString("utf8")) as {
      messages?: Array<{ role?: unknown; content?: unknown }>;
    };
    const system = sent.messages?.[0]?.content;
    expect(typeof system).toBe("string");
    if (typeof system !== "string") throw new Error("system message missing from transport body");
    expect(system).toContain("exactly one JSON object");
    expect(system).toContain("no fences");
    expect(system).toContain(ADVISOR_EXPLANATION_PROFILE);
    for (const field of ["answer", "citations", "abstained", "uncertainty"]) {
      expect(system).toContain(`"${field}"`);
    }
  });

  it("replays after settings changes with zero further provider calls", async () => {
    const harness = await createHarness();
    const artifactId = "00000000-0000-4000-8000-000000000001";
    await writeArtifact(
      harness.directory,
      harness.database,
      harness.engagementId,
      artifactId,
      Buffer.from("synthetic http probe body"),
      "act-turn-1",
      "run-turn-1",
    );
    const key = "fixture-key-turn-replay-00000";
    const first = await postTurn(harness.app, harness.engagementId, key, artifactId);
    expect(first.statusCode).toBe(200);
    const firstId = (first.json() as { id: string }).id;
    const updated = harness.settingsRepository.updateAdvisorSettings({ modelId: "other-model" });
    if (!updated.ok) throw new Error("settings update failed");
    const second = await postTurn(harness.app, harness.engagementId, key, artifactId);
    expect(second.statusCode).toBe(200);
    expect((second.json() as { id: string }).id).toBe(firstId);
    expect(harness.transport.hits()).toBe(1);
  });

  it("lets exactly one concurrent duplicate call the provider", async () => {
    const harness = await createHarness();
    const artifactId = "00000000-0000-4000-8000-000000000001";
    await writeArtifact(
      harness.directory,
      harness.database,
      harness.engagementId,
      artifactId,
      Buffer.from("synthetic http probe body"),
      "act-turn-1",
      "run-turn-1",
    );
    harness.transport.hold();
    const key = "fixture-key-turn-race-winner-00";
    const first = postTurn(harness.app, harness.engagementId, key, artifactId);
    await harness.transport.waitForHits(1);
    const second = await postTurn(harness.app, harness.engagementId, key, artifactId);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ code: "turn_in_progress" });
    harness.transport.release();
    const settled = await first;
    expect(settled.statusCode).toBe(200);
    expect(harness.transport.hits()).toBe(1);
  });

  it("rejects unknown and foreign evidence without provider calls", async () => {
    const harness = await createHarness();
    const foreign = await createHarness();
    const artifactId = "00000000-0000-4000-8000-000000000009";
    await writeArtifact(
      foreign.directory,
      foreign.database,
      foreign.engagementId,
      artifactId,
      Buffer.from("foreign bytes"),
      "act-foreign-1",
      "run-foreign-1",
    );
    const unknown = await postTurn(
      harness.app,
      harness.engagementId,
      "fixture-key-turn-unknown-00000",
      "00000000-0000-4000-8000-000000000099",
    );
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ code: "unknown_artifact" });
    const crossed = await postTurn(
      harness.app,
      harness.engagementId,
      "fixture-key-turn-foreign-00000",
      artifactId,
    );
    expect(crossed.statusCode).toBe(404);
    expect(crossed.json()).toEqual({ code: "unknown_artifact" });
    expect(harness.transport.hits()).toBe(0);
  });

  it("stores provider failures as terminal resources", async () => {
    const harness = await createHarness({
      respond: () => ({
        statusCode: 500,
        contentType: "application/json",
        body: Buffer.from("{}", "utf8"),
      }),
    });
    const artifactId = "00000000-0000-4000-8000-000000000001";
    await writeArtifact(
      harness.directory,
      harness.database,
      harness.engagementId,
      artifactId,
      Buffer.from("synthetic http probe body"),
      "act-turn-1",
      "run-turn-1",
    );
    const response = await postTurn(
      harness.app,
      harness.engagementId,
      "fixture-key-turn-failure-0000",
      artifactId,
    );
    expect(response.statusCode).toBe(200);
    const turn = response.json() as { status: string; errorCode: string };
    expect(turn.status).toBe("provider_error");
    expect(turn.errorCode).toBe("provider_unreachable");
    expect(harness.transport.hits()).toBe(1);
  });

  it("stores malformed model output as parse errors", async () => {
    const harness = await createHarness({
      respond: () => completionResponse({ profile: "advisor-explanation-v1", answer: 42 }),
    });
    const artifactId = "00000000-0000-4000-8000-000000000001";
    await writeArtifact(
      harness.directory,
      harness.database,
      harness.engagementId,
      artifactId,
      Buffer.from("synthetic http probe body"),
      "act-turn-1",
      "run-turn-1",
    );
    const response = await postTurn(
      harness.app,
      harness.engagementId,
      "fixture-key-turn-malformed-000",
      artifactId,
    );
    expect(response.statusCode).toBe(200);
    const turn = response.json() as { status: string; errorCode: string };
    expect(turn.status).toBe("parse_error");
    expect(turn.errorCode).toBe("provider_parse_error");
  });

  it("keeps invalid model references inert", async () => {
    const harness = await createHarness({
      respond: () =>
        completionResponse({
          profile: "advisor-explanation-v1",
          answer: "See elsewhere.",
          uncertainty: "",
          citations: ["no-such-evidence"],
          abstained: false,
        }),
    });
    const artifactId = "00000000-0000-4000-8000-000000000001";
    await writeArtifact(
      harness.directory,
      harness.database,
      harness.engagementId,
      artifactId,
      Buffer.from("synthetic http probe body"),
      "act-turn-1",
      "run-turn-1",
    );
    const response = await postTurn(
      harness.app,
      harness.engagementId,
      "fixture-key-turn-inert-cite-00",
      artifactId,
    );
    expect(response.statusCode).toBe(200);
    const turn = response.json() as {
      status: string;
      citations: Array<{ raw: string; valid: boolean; kind: string }>;
    };
    expect(turn.status).toBe("succeeded");
    expect(turn.citations).toEqual([{ raw: "no-such-evidence", valid: false, kind: "unknown" }]);
  });

  it("requires the key env var without ever returning it", async () => {
    const harness = await createHarness({ env: {} });
    const updated = harness.settingsRepository.updateAdvisorSettings({
      apiKeyEnvVar: KEY_ENV_VAR,
    });
    if (!updated.ok) throw new Error("settings update failed");
    const artifactId = "00000000-0000-4000-8000-000000000001";
    await writeArtifact(
      harness.directory,
      harness.database,
      harness.engagementId,
      artifactId,
      Buffer.from("synthetic http probe body"),
      "act-turn-1",
      "run-turn-1",
    );
    const unset = await postTurn(harness.app, harness.engagementId, "fixture-key-turn-unset-0000", artifactId);
    expect(unset.statusCode).toBe(409);
    expect(unset.json()).toEqual({ code: "key_unset" });
    expect(harness.transport.hits()).toBe(0);
    const keyed = await createHarness({ env: { [KEY_ENV_VAR]: KEY_VALUE } });
    const keyedUpdated = keyed.settingsRepository.updateAdvisorSettings({
      apiKeyEnvVar: KEY_ENV_VAR,
    });
    if (!keyedUpdated.ok) throw new Error("settings update failed");
    await writeArtifact(
      keyed.directory,
      keyed.database,
      keyed.engagementId,
      artifactId,
      Buffer.from("synthetic http probe body"),
      "act-turn-1",
      "run-turn-1",
    );
    const response = await postTurn(keyed.app, keyed.engagementId, "fixture-key-turn-keyed-00000", artifactId);
    expect(response.statusCode).toBe(200);
    expect(keyed.transport.authorizations()).toEqual([`Bearer ${KEY_VALUE}`]);
    expect(JSON.stringify(response.json())).not.toContain(KEY_VALUE);
  });

  it("rejects public endpoints without opt-in and no provider call", async () => {
    const harness = await createHarness();
    const updated = harness.settingsRepository.updateAdvisorSettings({
      endpointBaseUrl: "https://example.com/v1",
      publicEndpointOptIn: false,
    });
    if (!updated.ok) throw new Error("settings update failed");
    const artifactId = "00000000-0000-4000-8000-000000000001";
    await writeArtifact(
      harness.directory,
      harness.database,
      harness.engagementId,
      artifactId,
      Buffer.from("synthetic http probe body"),
      "act-turn-1",
      "run-turn-1",
    );
    const response = await postTurn(
      harness.app,
      harness.engagementId,
      "fixture-key-turn-public-00000",
      artifactId,
    );
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: "public_not_opted_in" });
    expect(harness.transport.hits()).toBe(0);
  });

  it("expires stale keys to terminal state without new provider calls", async () => {
    const harness = await createHarness();
    const artifactId = "00000000-0000-4000-8000-000000000001";
    await writeArtifact(
      harness.directory,
      harness.database,
      harness.engagementId,
      artifactId,
      Buffer.from("synthetic http probe body"),
      "act-turn-1",
      "run-turn-1",
    );
    harness.transport.hold();
    const key = "fixture-key-turn-expiry-0000";
    const first = postTurn(harness.app, harness.engagementId, key, artifactId);
    await harness.transport.waitForHits(1);
    harness.clock.now = new Date(harness.clock.now.getTime() + 200_000);
    const second = await postTurn(harness.app, harness.engagementId, key, artifactId);
    expect(second.statusCode).toBe(200);
    expect((second.json() as { status: string }).status).toBe("expired");
    expect(harness.transport.hits()).toBe(1);
    harness.transport.release();
    const settled = await first;
    expect(settled.statusCode).toBe(200);
    expect((settled.json() as { status: string }).status).toBe("expired");
  });

  it("finalizes rows as cancelled on client disconnect", async () => {
    const harness = await createHarness();
    const artifactId = "00000000-0000-4000-8000-000000000001";
    await writeArtifact(
      harness.directory,
      harness.database,
      harness.engagementId,
      artifactId,
      Buffer.from("synthetic http probe body"),
      "act-turn-1",
      "run-turn-1",
    );
    const address = await harness.app.listen({ port: 0, host: "127.0.0.1" });
    harness.transport.hold();
    const key = "fixture-key-turn-abort-000000";
    const controller = new AbortController();
    const pending = fetch(`${address}/api/v1/engagements/${harness.engagementId}/advisor/turns`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({
        engagementId: harness.engagementId,
        question: "What does this evidence show?",
        excerptArtifactIds: [artifactId],
        findingIds: [],
      }),
      signal: controller.signal,
    });
    const clientSettled = pending.then(
      () => "fulfilled" as const,
      () => "rejected" as const,
    );
    try {
      await harness.transport.waitForHits(1);
      // The reservation must exist as pending before the disconnect.
      const before = await harness.app.inject({
        method: "GET",
        url: `/api/v1/engagements/${harness.engagementId}/advisor/turns`,
      });
      expect(
        (before.json() as { turns: Array<{ status: string }> }).turns.map((turn) => turn.status),
      ).toEqual(["pending"]);
      controller.abort();
      expect(await clientSettled).toBe("rejected");
      // Only release the held provider after the server-side transport
      // signal actually aborted; releasing earlier permits a legitimate
      // succeeded race and would weaken the assertion.
      await harness.transport.waitForServerAbort();
      harness.transport.release();
      const deadline = Date.now() + 5_000;
      let turn: { status: string; answer: string; citations: unknown[] } | undefined;
      while (Date.now() < deadline) {
        const listed = await harness.app.inject({
          method: "GET",
          url: `/api/v1/engagements/${harness.engagementId}/advisor/turns`,
        });
        const turns = (listed.json() as { turns: Array<typeof turn & object> }).turns;
        if (turns.length > 0 && turns[0]?.status === "cancelled") {
          turn = turns[0] as typeof turn & object;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(turn?.status).toBe("cancelled");
      expect(turn?.answer).toBe("");
      expect(turn?.citations).toEqual([]);
      // No resurrection after the late provider response settles.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const reread = await harness.app.inject({
        method: "GET",
        url: `/api/v1/engagements/${harness.engagementId}/advisor/turns`,
      });
      expect(
        (reread.json() as { turns: Array<{ status: string }> }).turns.map((t) => t.status),
      ).toEqual(["cancelled"]);
    } finally {
      harness.transport.release();
    }
  }, 15000);

  it("reads archived and paged history", async () => {
    const harness = await createHarness();
    const artifactId = "00000000-0000-4000-8000-000000000001";
    await writeArtifact(
      harness.directory,
      harness.database,
      harness.engagementId,
      artifactId,
      Buffer.from("synthetic http probe body"),
      "act-turn-1",
      "run-turn-1",
    );
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      harness.clock.now = new Date(harness.clock.now.getTime() + 1_000);
      const response = await postTurn(
        harness.app,
        harness.engagementId,
        `fixture-key-turn-page-${String(index).padStart(5, "0")}`,
        artifactId,
      );
      expect(response.statusCode).toBe(200);
      ids.push((response.json() as { id: string }).id);
    }
    const first = await harness.app.inject({
      method: "GET",
      url: `/api/v1/engagements/${harness.engagementId}/advisor/turns?limit=2`,
    });
    expect(first.statusCode).toBe(200);
    const firstPage = first.json() as { turns: Array<{ id: string }>; nextCursor: unknown };
    expect(firstPage.turns.map((turn) => turn.id)).toEqual([ids[2], ids[1]]);
    expect(firstPage.nextCursor).not.toBeNull();
    const cursor = firstPage.nextCursor as { createdAt: string; id: string };
    const second = await harness.app.inject({
      method: "GET",
      url:
        `/api/v1/engagements/${harness.engagementId}/advisor/turns?limit=2` +
        `&beforeCreatedAt=${encodeURIComponent(cursor.createdAt)}&beforeId=${cursor.id}`,
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { turns: Array<{ id: string }> }).turns.map((turn) => turn.id)).toEqual([
      ids[0],
    ]);
    const detail = harness.engagementRepository.getEngagement(harness.engagementId);
    if (!detail.ok) throw new Error("engagement fixture failed");
    const archived = harness.engagementRepository.archive(harness.engagementId, detail.value.engagement.revision);
    if (!archived.ok) throw new Error("archive fixture failed");
    const reread = await harness.app.inject({
      method: "GET",
      url: `/api/v1/engagements/${harness.engagementId}/advisor/turns`,
    });
    expect(reread.statusCode).toBe(200);
    expect((reread.json() as { turns: Array<unknown> }).turns).toHaveLength(3);
    const blocked = await postTurn(harness.app, harness.engagementId, "fixture-key-turn-archived-0", artifactId);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ code: "engagement_archived" });
  });

  it("mounts turn routes through the storage-backed runtime factory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "stonehush-advisor-turns-runtime-"));
    temporaryDirectories.push(directory);
    await chmod(directory, 0o700);
    const app = await buildStorageBackedApp(directory);
    openApps.push(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/engagements",
      headers: { "idempotency-key": "runtime-fixture-engagement-000" },
      payload: { name: "Runtime lab", kind: "lab", autoContinueWarnings: false },
    });
    expect(created.statusCode).toBe(201);
    const engagementId = (created.json() as { id: string }).id;
    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${engagementId}/advisor/turns`,
    });
    // 200 with an empty page proves the routes are mounted by the real
    // factory; an unmounted path would 404 with a route-not-found body.
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ turns: [], nextCursor: null });
  });
});
