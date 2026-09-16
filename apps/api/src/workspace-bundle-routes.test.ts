import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  EngagementRepository,
  ExcerptRepository,
  FfufRepository,
  HttpProbeRepository,
  LeadRepository,
  NmapServiceRepository,
  ObjectiveRepository,
  RunOutputRepository,
  SecretRepository,
  openEngagementDatabase,
} from "@stonehush/db";
import { loadEvidenceNative } from "@stonehush/evidence-native";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { EvidenceStore } from "./evidence/evidence-store.js";
import { FfufProjectionService } from "./evidence/ffuf-projection.js";
import { HttpProbeProjectionService } from "./evidence/http-probe-projection.js";
import { NmapProjectionService } from "./evidence/nmap-projection.js";
import type { WorkspaceBundleDependencies } from "./workspace-bundle-service.js";

const NMAP_XML = `<?xml version="1.0"?><nmaprun><host><address addr="192.0.2.10" addrtype="ipv4"/><hostnames><hostname name="host.test"/></hostnames><ports><port protocol="tcp" portid="80"><state state="open"/><service name="http" product="nginx" version="1.18"/></port></ports></host></nmaprun>`;
const STDOUT_BYTES = "bundle-stdout-bytes-001";
const FLAG_VALUE = "flag{synthetic-bundle-001}";

const temporaryDirectories: string[] = [];
const openApps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function sha256Hex(bytes: string | Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

interface Harness {
  app: ReturnType<typeof buildApp>;
  database: ReturnType<typeof openEngagementDatabase>;
  store: EvidenceStore;
  engagementRepository: EngagementRepository;
  leadRepository: LeadRepository;
  excerptRepository: ExcerptRepository;
  secretRepository: SecretRepository;
  objectiveRepository: ObjectiveRepository;
  runOutputRepository: RunOutputRepository;
  nmapServiceRepository: NmapServiceRepository;
}

async function createHarness(): Promise<Harness> {
  const native = loadEvidenceNative();
  if (!native.ok) throw new Error("native binding unavailable");
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "stonehush-bundle-test-"));
  temporaryDirectories.push(dataDirectory);
  await chmod(dataDirectory, 0o700);
  const storeResult = EvidenceStore.open(dataDirectory, native.binding);
  if (!storeResult.ok) throw new Error(`store open failed: ${storeResult.code}`);
  const database = openEngagementDatabase({ dataDirectory });
  const engagementRepository = new EngagementRepository(database.db);
  const leadRepository = new LeadRepository(database.db);
  const excerptRepository = new ExcerptRepository(database.db);
  const secretRepository = new SecretRepository(database.db);
  const objectiveRepository = new ObjectiveRepository(database.db);
  const runOutputRepository = new RunOutputRepository(database.db);
  const nmapServiceRepository = new NmapServiceRepository(database.db);
  const httpProbeRepository = new HttpProbeRepository(database.db);
  const ffufRepository = new FfufRepository(database.db);
  const bundle: WorkspaceBundleDependencies = {
    engagements: engagementRepository,
    leads: leadRepository,
    excerpts: excerptRepository,
    secrets: secretRepository,
    objectives: objectiveRepository,
    runs: runOutputRepository,
    sqlite: database.sqlite,
    store: storeResult.store,
    nmapProjection: new NmapProjectionService(storeResult.store, nmapServiceRepository),
    httpProbeProjection: new HttpProbeProjectionService(
      storeResult.store,
      httpProbeRepository,
    ),
    ffufProjection: new FfufProjectionService(storeResult.store, ffufRepository),
  };
  const app = buildApp({
    engagementRepository,
    getDevelopmentStorageReadiness: () => "ready",
    nmapServiceRepository,
    httpProbeRepository,
    ffufRepository,
    runOutputRepository,
    leadRepository,
    excerptRepository,
    secretRepository,
    objectiveRepository,
    workspaceBundle: bundle,
  });
  app.addHook("onClose", async () => database.close());
  openApps.push(app);
  return {
    app,
    database,
    store: storeResult.store,
    engagementRepository,
    leadRepository,
    excerptRepository,
    secretRepository,
    objectiveRepository,
    runOutputRepository,
    nmapServiceRepository,
  };
}

async function seedActionRun(
  harness: Harness,
  engagementId: string,
): Promise<void> {
  const now = new Date(Date.UTC(2026, 8, 1, 12, 0)).toISOString();
  harness.database.sqlite
    .prepare(
      "insert into actions (id, contract_version, engagement_id, revision, state, queued_snapshot_version, warning_interactions, run_state, resume_requested, cleanup_required, capability_error_code, pending_warning_json, created_at, updated_at) values ('act-seed-1',1,?,1,'succeeded',null,0,null,0,0,null,null,?,?)",
    )
    .run(engagementId, now, now);
  harness.database.sqlite
    .prepare(
      "insert into runs (id, contract_version, action_id, engagement_id, attempt, state, current_lease_id, current_fence, terminal_kind, terminal_reason, created_at, updated_at) values ('run-seed-1',1,'act-seed-1',?,1,'succeeded',null,'1','succeeded',null,?,?)",
    )
    .run(engagementId, now, now);
}

async function seedArtifact(
  harness: Harness,
  dataDirectory: string,
  input: {
    engagementId: string;
    artifactId: string;
    eventSequence: number;
    slot: string;
    kind: "tool_raw" | "stdout";
    completeness: "complete";
    bytes: Buffer;
  },
): Promise<{ digest: string }> {
  const digest = sha256Hex(input.bytes);
  const now = new Date(Date.UTC(2026, 8, 1, 12, 0)).toISOString();
  const redaction =
    input.kind === "stdout" ? [1, "runner_stream", 0] : [0, "none", 1];
  harness.database.sqlite
    .prepare(
      "insert into evidence_artifacts (artifact_id, contract_version, profile, run_id, fence, event_sequence, artifact_slot, kind, size_bytes, digest, relative_path, completeness, redaction_applied, redaction_boundary, raw_bytes_preserved, created_at) values (?,1,'d3-v1','run-seed-1','1',?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      input.artifactId,
      input.eventSequence,
      input.slot,
      input.kind,
      input.bytes.length,
      digest,
      `published/${input.artifactId}`,
      input.completeness,
      redaction[0],
      redaction[1],
      redaction[2],
      now,
    );
  const publishedFile = path.join(dataDirectory, "evidence", "published", input.artifactId);
  await writeFile(publishedFile, input.bytes);
  await chmod(publishedFile, 0o600);
  return { digest };
}

async function seedEngagement(harness: Harness, dataDirectory: string) {
  const created = harness.engagementRepository.createEngagement({
    name: "Bundle lab",
    kind: "lab",
    description: "synthetic client description",
    authorizationContext: "ROE synthetic",
    autoContinueWarnings: false,
  });
  if (!created.ok) throw new Error(`Fixture failed: ${created.error.code}`);
  const engagementId = created.value.id;
  await seedActionRun(harness, engagementId);
  const noted = harness.engagementRepository.putEngagementNotes(engagementId, {
    markdown: "working notes",
    expectedRevision: 0,
  });
  if (!noted.ok) throw new Error(`Fixture failed: ${noted.error.code}`);

  const xmlDigest = await seedArtifact(harness, dataDirectory, {
    engagementId,
    artifactId: "bundle-xml-1",
    eventSequence: 1,
    slot: "nmap-xml",
    kind: "tool_raw",
    completeness: "complete",
    bytes: Buffer.from(NMAP_XML, "utf8"),
  });
  const outDigest = await seedArtifact(harness, dataDirectory, {
    engagementId,
    artifactId: "bundle-out-1",
    eventSequence: 2,
    slot: "run-stdout",
    kind: "stdout",
    completeness: "complete",
    bytes: Buffer.from(STDOUT_BYTES, "utf8"),
  });

  // Project the seeded nmap artifact so the source report matches the
  // re-derived import report.
  const projection = new NmapProjectionService(harness.store, harness.nmapServiceRepository);
  const projectedResult = await projection.projectForArtifact("bundle-xml-1");
  if (!projectedResult.ok) throw new Error("Fixture projection failed");

  const lead = harness.leadRepository.createLead(engagementId, {
    title: "Check admin panel",
    source: { kind: "manual", ref: "field-notes" },
    nextStep: "Probe port 80",
  });
  if (!lead.ok) throw new Error(`Fixture failed: ${lead.error.code}`);
  const attempt = harness.leadRepository.recordAttempt(engagementId, lead.value.id, {
    summary: "Probed and observed banner",
    outcome: "observed",
    evidenceArtifactIds: ["bundle-xml-1"],
  });
  if (!attempt.ok) throw new Error(`Fixture failed: ${attempt.error.code}`);

  const excerpt = harness.excerptRepository.createExcerpt({
    engagementId,
    runId: "run-seed-1",
    artifactId: "bundle-out-1",
    artifactDigest: outDigest.digest,
    stream: "stdout",
    byteOffset: 0,
    byteLength: 10,
    content: "bundle-std",
    redactions: 0,
    targetNote: null,
  });
  if (!excerpt.ok) throw new Error(`Fixture failed: ${excerpt.error.code}`);

  const attachment = harness.excerptRepository.createAttachment({
    engagementId,
    filename: "shot-1",
    mime: "image/png",
    sizeBytes: 3,
    digest: sha256Hex("img"),
    caption: "synthetic capture",
    targetLabel: null,
    parentAttachmentId: null,
    cropRectJson: null,
    contentBase64: Buffer.from("img").toString("base64"),
  });
  if (!attachment.ok) throw new Error(`Fixture failed: ${attachment.error.code}`);

  const finding = harness.engagementRepository.createFinding(engagementId, {
    title: "Exposed admin panel",
    severity: "high",
    body: "Panel reachable without auth.",
    evidenceArtifactIds: ["bundle-xml-1"],
  });
  if (!finding.ok) throw new Error(`Fixture failed: ${finding.error.code}`);

  const secret = harness.secretRepository.createSecret(engagementId, {
    label: "db account",
    serviceRef: "postgres",
    secretRef: "vault-db",
    hint: "rotated weekly",
  });
  if (!secret.ok) throw new Error(`Fixture failed: ${secret.error.code}`);
  const verified = harness.secretRepository.recordVerification(
    engagementId,
    secret.value.id,
    { result: "verified", method: "login" },
  );
  if (!verified.ok) throw new Error(`Fixture failed: ${verified.error.code}`);

  const objective = harness.objectiveRepository.createObjective(engagementId, {
    name: "user flag",
    kind: "user_flag",
  });
  if (!objective.ok) throw new Error(`Fixture failed: ${objective.error.code}`);
  const captured = harness.objectiveRepository.captureObjective(
    engagementId,
    objective.value.id,
    { proofValue: FLAG_VALUE },
  );
  if (!captured.ok) throw new Error(`Fixture failed: ${captured.error.code}`);

  return { engagementId, xmlDigest: xmlDigest.digest, outDigest: outDigest.digest };
}

async function exportBundle(app: Harness["app"], engagementId: string, privateCopy: boolean) {
  const response = await app.inject({
    method: "GET",
    url:
      privateCopy ?
        `/api/v1/engagements/${engagementId}/workspace-bundle?privateCopy=true`
      : `/api/v1/engagements/${engagementId}/workspace-bundle`,
  });
  expect(response.statusCode).toBe(200);
  return response.json() as Record<string, unknown>;
}

describe("workspace bundle routes", () => {
  it("round-trips leads, excerpts, findings, and byte-identical evidence", async () => {
    const harness = await createHarness();
    const dataDirectory = temporaryDirectories[temporaryDirectories.length - 1] as string;
    const { engagementId, xmlDigest } = await seedEngagement(harness, dataDirectory);

    const bundle = await exportBundle(harness.app, engagementId, false);
    expect(bundle["kind"]).toBe("stonehush-workspace-bundle-v1");
    expect(bundle["privateCopy"]).toBe(false);

    const imported = await harness.app.inject({
      method: "POST",
      url: "/api/v1/workspace-bundles/import",
      payload: bundle,
    });
    expect(imported.statusCode).toBe(201);
    const body = imported.json() as {
      engagementId: string;
      summary: Record<string, number>;
    };
    expect(body.engagementId).not.toBe(engagementId);
    expect(body.summary).toMatchObject({
      leads: 1,
      attempts: 1,
      excerpts: 1,
      attachments: 1,
      findings: 1,
      evidence: 2,
      secrets: 0,
      objectives: 0,
    });

    const leads = harness.leadRepository.listLeads(body.engagementId);
    if (!leads.ok) throw new Error(leads.error.code);
    expect(leads.value).toHaveLength(1);
    const attempts = harness.leadRepository.listAttempts(
      body.engagementId,
      leads.value[0]?.id as string,
    );
    if (!attempts.ok) throw new Error(attempts.error.code);
    expect(attempts.value).toHaveLength(1);
    const excerpts = harness.excerptRepository.listExcerpts(body.engagementId);
    if (!excerpts.ok) throw new Error(excerpts.error.code);
    expect(excerpts.value).toHaveLength(1);
    const findings = harness.engagementRepository.listFindings(body.engagementId);
    if (!findings.ok) throw new Error(findings.error.code);
    expect(findings.value).toHaveLength(1);
    const artifacts = harness.runOutputRepository.listArtifactsForEngagement(
      body.engagementId,
    );
    if (!artifacts.ok) throw new Error(artifacts.code);
    expect(artifacts.artifacts).toHaveLength(2);

    // Byte-identical evidence: every imported digest matches the source and
    // the stored bytes download verbatim under the new artifact id.
    const digests = new Set(artifacts.artifacts.map((row) => row.digest));
    expect(digests.has(xmlDigest)).toBe(true);
    for (const row of artifacts.artifacts) {
      const download = await harness.store.verifiedDownload({
        artifactId: row.artifactId,
        expectedSizeBytes: row.sizeBytes,
        expectedDigest: row.digest,
      });
      expect(download.status).toBe("ready");
      if (download.status !== "ready") continue;
      const chunks: Buffer[] = [];
      for await (const chunk of download.stream) chunks.push(chunk);
      expect(sha256Hex(Buffer.concat(chunks))).toBe(row.digest);
      expect(row.artifactId).not.toBe("bundle-xml-1");
      expect(row.artifactId).not.toBe("bundle-out-1");
    }

    // Discovery projections re-derive from the same bytes.
    const services = harness.nmapServiceRepository.listForEngagement(body.engagementId);
    if (!services.ok) throw new Error(services.code);
    expect(services.value.length).toBeGreaterThan(0);
  });

  it("excludes secrets, flags, and client identifiers by default", async () => {
    const harness = await createHarness();
    const dataDirectory = temporaryDirectories[temporaryDirectories.length - 1] as string;
    const { engagementId } = await seedEngagement(harness, dataDirectory);

    const bundle = await exportBundle(harness.app, engagementId, false);
    const serialized = JSON.stringify(bundle);
    expect(bundle["secrets"]).toEqual([]);
    expect(bundle["objectives"]).toEqual([]);
    expect(
      (bundle["engagement"] as { description: unknown }).description,
    ).toBe(null);
    expect(
      (bundle["engagement"] as { authorizationContext: unknown }).authorizationContext,
    ).toBe(null);
    expect(serialized).not.toContain(FLAG_VALUE);
  });

  it("carries private records only under the labeled opt-in, never values", async () => {
    const harness = await createHarness();
    const dataDirectory = temporaryDirectories[temporaryDirectories.length - 1] as string;
    const { engagementId } = await seedEngagement(harness, dataDirectory);

    const bundle = await exportBundle(harness.app, engagementId, true);
    const serialized = JSON.stringify(bundle);
    expect((bundle["secrets"] as unknown[]).length).toBe(1);
    expect((bundle["objectives"] as unknown[]).length).toBe(1);
    expect(
      (bundle["engagement"] as { description: unknown }).description,
    ).toBe("synthetic client description");
    expect(serialized).not.toContain(FLAG_VALUE);

    const imported = await harness.app.inject({
      method: "POST",
      url: "/api/v1/workspace-bundles/import",
      payload: bundle,
    });
    expect(imported.statusCode).toBe(201);
    const body = imported.json() as { engagementId: string };
    const secrets = harness.secretRepository.listSecrets(body.engagementId);
    if (!secrets.ok) throw new Error(secrets.error.code);
    expect(secrets.value).toHaveLength(1);
    expect(secrets.value[0]?.verifications).toHaveLength(1);
    const objectives = harness.objectiveRepository.listObjectives(body.engagementId);
    if (!objectives.ok) throw new Error(objectives.error.code);
    expect(objectives.value).toHaveLength(1);
    expect(objectives.value[0]?.state).toBe("captured");
    expect(objectives.value[0]?.proofDigest).toBe(sha256Hex(FLAG_VALUE));
  });

  it("imports the same file twice as two independent engagements", async () => {
    const harness = await createHarness();
    const dataDirectory = temporaryDirectories[temporaryDirectories.length - 1] as string;
    const { engagementId } = await seedEngagement(harness, dataDirectory);
    const bundle = await exportBundle(harness.app, engagementId, false);

    const first = await harness.app.inject({
      method: "POST",
      url: "/api/v1/workspace-bundles/import",
      payload: bundle,
    });
    const second = await harness.app.inject({
      method: "POST",
      url: "/api/v1/workspace-bundles/import",
      payload: bundle,
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const firstId = (first.json() as { engagementId: string }).engagementId;
    const secondId = (second.json() as { engagementId: string }).engagementId;
    expect(firstId).not.toBe(secondId);

    const firstArtifacts = harness.runOutputRepository.listArtifactsForEngagement(firstId);
    const secondArtifacts = harness.runOutputRepository.listArtifactsForEngagement(secondId);
    if (!firstArtifacts.ok || !secondArtifacts.ok) throw new Error("artifacts missing");
    expect(firstArtifacts.artifacts).toHaveLength(2);
    expect(secondArtifacts.artifacts).toHaveLength(2);
    const firstIds = new Set(firstArtifacts.artifacts.map((row) => row.artifactId));
    for (const row of secondArtifacts.artifacts) {
      expect(firstIds.has(row.artifactId)).toBe(false);
      expect(row.digest).toBe(
        firstArtifacts.artifacts.find((entry) => entry.sizeBytes === row.sizeBytes)?.digest,
      );
    }
    const firstLeads = harness.leadRepository.listLeads(firstId);
    const secondLeads = harness.leadRepository.listLeads(secondId);
    if (!firstLeads.ok || !secondLeads.ok) throw new Error("leads missing");
    expect(firstLeads.value[0]?.id).not.toBe(secondLeads.value[0]?.id);
  });

  it("rejects tampered bytes, versions, and malformed files with clear errors", async () => {
    const harness = await createHarness();
    const dataDirectory = temporaryDirectories[temporaryDirectories.length - 1] as string;
    const { engagementId } = await seedEngagement(harness, dataDirectory);
    const bundle = (await exportBundle(harness.app, engagementId, false)) as unknown as {
      evidence: { contentBase64: string; digest: string }[];
      bundleVersion: number;
      kind: string;
    };

    const tampered = structuredClone(bundle) as typeof bundle;
    const original = tampered.evidence[0]?.contentBase64 as string;
    const flipped = `${original.slice(0, 4)}${original[4] === "A" ? "B" : "A"}${original.slice(5)}`;
    if (tampered.evidence[0] !== undefined) {
      tampered.evidence[0].contentBase64 = flipped;
    }
    const tamperedResponse = await harness.app.inject({
      method: "POST",
      url: "/api/v1/workspace-bundles/import",
      payload: tampered,
    });
    expect(tamperedResponse.statusCode).toBe(422);
    expect(tamperedResponse.json()).toEqual({ code: "bundle_digest_mismatch" });

    const future = { ...structuredClone(bundle), bundleVersion: 999 };
    const futureResponse = await harness.app.inject({
      method: "POST",
      url: "/api/v1/workspace-bundles/import",
      payload: future,
    });
    expect(futureResponse.statusCode).toBe(415);
    expect(futureResponse.json()).toEqual({ code: "unsupported_bundle_version" });

    const foreign = { ...structuredClone(bundle), kind: "other-bundle-v1" };
    const foreignResponse = await harness.app.inject({
      method: "POST",
      url: "/api/v1/workspace-bundles/import",
      payload: foreign,
    });
    expect(foreignResponse.statusCode).toBe(415);

    const malformed = await harness.app.inject({
      method: "POST",
      url: "/api/v1/workspace-bundles/import",
      payload: { kind: "stonehush-workspace-bundle-v1" },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({ code: "invalid_request" });
  });

  it("rejects oversized bundles before decoding content", async () => {
    const harness = await createHarness();
    const oversized = {
      kind: "stonehush-workspace-bundle-v1",
      bundleVersion: 1,
      exportedAt: "2026-09-01T12:00:00.000Z",
      sourceEngagementId: "10000000-0000-4000-8000-000000000001",
      sourceEngagementName: "Source",
      privateCopy: false,
      engagement: {
        name: "Source",
        kind: "lab",
        deadlineAt: null,
        description: null,
        authorizationContext: null,
      },
      notes: { markdown: "", updatedAt: "2026-09-01T12:00:00.000Z" },
      leads: [],
      attempts: [],
      excerpts: [],
      attachments: [],
      findings: [],
      evidence: [0, 1, 2].map((index) => ({
        artifactId: `oversized-${index}`,
        kind: "tool_raw",
        sizeBytes: 6 * 1024 * 1024,
        digest: sha256Hex(`oversized-${index}`),
        completeness: "complete",
        artifactSlot: "slot-a",
        originalRunId: "run-1",
        contentBase64: "aGk=",
      })),
      secrets: [],
      objectives: [],
    };
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/v1/workspace-bundles/import",
      payload: oversized,
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({ code: "bundle_too_large" });
  });

  it("rejects unknown engagements and malformed ids on export", async () => {
    const harness = await createHarness();
    const missing = await harness.app.inject({
      method: "GET",
      url: "/api/v1/engagements/10000000-0000-4000-8000-000000009999/workspace-bundle",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ code: "engagement_not_found" });

    const malformed = await harness.app.inject({
      method: "GET",
      url: "/api/v1/engagements/not-a-uuid/workspace-bundle",
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({ code: "invalid_request" });
  });
});
