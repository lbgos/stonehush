import { describe, expect, it } from "vitest";

import publicationFixture from "../../../docs/architecture/fixtures/d3/publication.json" with { type: "json" };
import limitsFixture from "../../../docs/architecture/fixtures/d3/limits.json" with { type: "json" };
import privacyFixture from "../../../docs/architecture/fixtures/d3/privacy-download.json" with { type: "json" };

import {
  CompleteEvidenceUploadErrorCodeSchema,
  CompleteEvidenceUploadRequestSchema,
  CompleteEvidenceUploadResultSchema,
  CompleteEvidenceUploadSuccessSchema,
  CreateEvidenceGrantRequestSchema,
  EVIDENCE_EMPTY_SHA256_DIGEST,
  EVIDENCE_PROFILE,
  EVIDENCE_QUOTA_DEFAULTS,
  EVIDENCE_QUOTA_LIMITS,
  EvidenceArtifactRecordSchema,
  EvidenceDigestSchema,
  EvidenceErrorCodeSchema,
  EvidenceGrantIdentitySchema,
  EvidenceObservationReferenceSchema,
  EvidencePathErrorCodeSchema,
  EvidenceQuotaConfigSchema,
  EvidenceRedactionSchema,
  OpaqueArtifactIdSchema,
  OpaqueArtifactSlotSchema,
  PublishedCompletenessSchema,
  ReadProjectionSchema,
} from "./evidence.js";

const digestLow = "sha256:6e434b5e9602095dd093e45276d34b32cf0071edf1cccf811b7b6a3df226c69f";
const digestAlt = "sha256:b28f2cd8491591f333fd0ba71b87984c43d509cd416766465109f4f082e43f0b";
const artifactId = "artifact-fixture-8";
const uploadId = "upload-fixture-3";

describe("d3-v1 fixture conformance", () => {
  it("pins profile and exact quota constants", () => {
    expect(EVIDENCE_PROFILE).toBe("d3-v1");
    expect((publicationFixture as { profile: string }).profile).toBe(EVIDENCE_PROFILE);
    expect((limitsFixture as { profile: string }).profile).toBe(EVIDENCE_PROFILE);
    expect((privacyFixture as { profile: string }).profile).toBe(EVIDENCE_PROFILE);

    const quota = (limitsFixture as { cases: { id: string; expected: unknown }[] }).cases.find(
      (c) => c.id === "d3.limits.quota-defaults",
    )?.expected as {
      perArtifactBytes: { default: number; minimum: number; maximum: number };
      perRunPublishedBytes: { default: number; minimum: number; maximum: number };
      totalPublishedBytes: { default: number; minimum: number; maximum: number };
      maxInFlightStagingBytes: number;
      maxConcurrentUploadsPerRunner: number;
    };
    expect(quota.perArtifactBytes.default).toBe(EVIDENCE_QUOTA_DEFAULTS.perArtifactBytes);
    expect(quota.maxInFlightStagingBytes).toBe(EVIDENCE_QUOTA_DEFAULTS.maxInFlightStagingBytes);
    expect(EVIDENCE_QUOTA_DEFAULTS.perArtifactBytes).toBe(67_108_864);
    expect(EVIDENCE_QUOTA_LIMITS.perArtifactBytes.minimum).toBe(65_536);
    expect(EVIDENCE_QUOTA_LIMITS.perArtifactBytes.maximum).toBe(1_073_741_824);
    expect(EVIDENCE_EMPTY_SHA256_DIGEST).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("pins required case IDs and redaction tuples", () => {
    const pubIds = new Set((publicationFixture as { cases: { id: string }[] }).cases.map((c) => c.id));
    const privIds = new Set((privacyFixture as { cases: { id: string }[] }).cases.map((c) => c.id));
    for (const id of [
      "d3.publication.successful-upload-digest-fsync",
      "d3.publication.empty-artifact-allowed",
    ])
      expect(pubIds.has(id)).toBe(true);
    for (const id of ["d3.privacy.redacted-stream-metadata", "d3.privacy.raw-tool-metadata"])
      expect(privIds.has(id)).toBe(true);

    expect(
      EvidenceRedactionSchema.safeParse({
        applied: true,
        boundary: "runner_stream",
        rawBytesPreserved: false,
      }).success,
    ).toBe(true);
    expect(
      EvidenceRedactionSchema.safeParse({
        applied: false,
        boundary: "none",
        rawBytesPreserved: true,
      }).success,
    ).toBe(true);
  });

  it("keeps stored_artifact_replayed as disposition not error code", () => {
    expect(EvidenceErrorCodeSchema.safeParse("stored_artifact_replayed").success).toBe(false);
    expect(
      CompleteEvidenceUploadSuccessSchema.safeParse({
        disposition: "stored_artifact_replayed",
        artifactId,
        sizeBytes: 24,
        digest: digestLow,
        completeness: "complete",
      }).success,
    ).toBe(true);
  });
});

describe("adversarial – table-driven", () => {
  it.each([
    "sha256:6E434B5E9602095DD093E45276D34B32CF0071EDF1CCCF811B7B6A3DF226C69F",
    "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  ])("rejects uppercase digest %j", (d) => {
    expect(EvidenceDigestSchema.safeParse(d).success).toBe(false);
  });

  it.each([
    "artifact/fixtures",
    "artifact.fixture",
    "a/b",
    "..",
    ".",
    "",
    "A-B",
    "-leading-hyphen",
    "artifact\0fixture",
    "/etc/passwd",
    "has space",
  ])("rejects bad opaque ID %j", (v) => {
    expect(OpaqueArtifactIdSchema.safeParse(v).success).toBe(false);
    expect(OpaqueArtifactSlotSchema.safeParse(v).success).toBe(false);
  });

  it.each([["artifactId"], ["uploadId"], ["path"], ["stagingPath"], ["publishedPath"], ["relativePath"]])(
    "rejects caller path/ID field %j on grant",
    (field) => {
      const base = {
        runId: "run-fixture-3",
        leaseId: "lease-fixture-1",
        sessionId: "session-fixture-1",
        fence: "1",
        eventSequence: 3,
        artifactSlot: "stdout",
        kind: "stdout" as const,
      };
      expect(
        CreateEvidenceGrantRequestSchema.safeParse({ ...base, [field]: "evil" } as unknown as Record<
          string,
          unknown
        >).success,
      ).toBe(false);
    },
  );

  it.each([
    Number.MAX_SAFE_INTEGER + 1,
    1.5,
    -1,
    1_073_741_825,
  ])("rejects bad declaredSizeBytes %j", (n) => {
    expect(
      CreateEvidenceGrantRequestSchema.safeParse({
        runId: "run-fixture-3",
        leaseId: "lease-fixture-1",
        sessionId: "session-fixture-1",
        fence: "1",
        eventSequence: 3,
        artifactSlot: "stdout",
        kind: "stdout",
        declaredSizeBytes: n,
      } as unknown as Record<string, unknown>).success,
    ).toBe(false);
  });

  it.each([
    { applied: true, boundary: "runner_stream", rawBytesPreserved: true },
    { applied: true, boundary: "none", rawBytesPreserved: false },
    { applied: false, boundary: "runner_stream", rawBytesPreserved: true },
    { applied: false, boundary: "none", rawBytesPreserved: false },
  ])("rejects invalid redaction %j", (r) => {
    expect(EvidenceRedactionSchema.safeParse(r).success).toBe(false);
  });

  it.each([
    ["incomplete", false],
    ["missing", false],
    ["corrupt", false],
    ["complete", true],
    ["partial", true],
    ["truncated", true],
  ] as const)("published completeness %j valid=%j", (v, valid) => {
    expect(PublishedCompletenessSchema.safeParse(v).success).toBe(valid);
    expect(ReadProjectionSchema.safeParse(v).success).toBe(!valid && (v === "missing" || v === "corrupt"));
  });

  it("artifact record and complete request never store incomplete", () => {
    const recordBase = {
      contractVersion: 1 as const,
      profile: "d3-v1" as const,
      artifactId,
      runId: "run-fixture-3",
      fence: "4",
      eventSequence: 7,
      artifactSlot: "tool-raw",
      kind: "tool_raw" as const,
      sizeBytes: 24,
      digest: digestLow,
      relativePath: `published/${artifactId}`,
      redaction: { applied: false, boundary: "none" as const, rawBytesPreserved: true },
      createdAt: "2026-08-16T12:00:00.000Z",
    };
    expect(
      EvidenceArtifactRecordSchema.safeParse({ ...recordBase, completeness: "incomplete" } as unknown as Record<
        string,
        unknown
      >).success,
    ).toBe(false);
    expect(
      EvidenceArtifactRecordSchema.safeParse({ ...recordBase, completeness: "complete" }).success,
    ).toBe(true);
    expect(
      CompleteEvidenceUploadRequestSchema.safeParse({
        uploadId,
        sizeBytes: 24,
        digest: digestLow,
        completeness: "incomplete" as unknown as string,
      } as unknown as Record<string, unknown>).success,
    ).toBe(false);
  });

  it.each([
    "published/artifact-fixture-9",
    "published/../../outside",
    "/var/lib/stonehush/evidence/published/artifact-fixture-8",
    "published/",
    "staging/upload-fixture-3",
  ])("rejects bad relativePath %j", (p) => {
    const base = {
      contractVersion: 1 as const,
      profile: "d3-v1" as const,
      artifactId,
      runId: "run-fixture-3",
      fence: "4",
      eventSequence: 7,
      artifactSlot: "tool-raw",
      kind: "tool_raw" as const,
      sizeBytes: 24,
      digest: digestLow,
      relativePath: p,
      completeness: "complete" as const,
      redaction: { applied: false, boundary: "none" as const, rawBytesPreserved: true },
      createdAt: "2026-08-16T12:00:00.000Z",
    };
    expect(EvidenceArtifactRecordSchema.safeParse(base as unknown as Record<string, unknown>).success).toBe(
      false,
    );
  });

  it("rejects kind/redaction mismatch and grant missing kind/lease fields", () => {
    const toolRedaction = { applied: false, boundary: "none" as const, rawBytesPreserved: true };
    const streamRedaction = { applied: true, boundary: "runner_stream" as const, rawBytesPreserved: false };
    const base = {
      contractVersion: 1 as const,
      profile: "d3-v1" as const,
      artifactId,
      runId: "run-fixture-3",
      fence: "4",
      eventSequence: 7,
      artifactSlot: "stdout",
      sizeBytes: 24,
      digest: digestLow,
      relativePath: `published/${artifactId}`,
      completeness: "complete" as const,
      createdAt: "2026-08-16T12:00:00.000Z",
    };
    expect(
      EvidenceArtifactRecordSchema.safeParse({ ...base, kind: "stdout", redaction: toolRedaction } as unknown as Record<
        string,
        unknown
      >).success,
    ).toBe(false);
    expect(
      EvidenceArtifactRecordSchema.safeParse({ ...base, kind: "tool_raw", redaction: streamRedaction } as unknown as Record<
        string,
        unknown
      >).success,
    ).toBe(false);
    // grant requires kind
    expect(
      CreateEvidenceGrantRequestSchema.safeParse({
        runId: "run-fixture-3",
        leaseId: "lease-fixture-1",
        sessionId: "session-fixture-1",
        fence: "1",
        eventSequence: 3,
        artifactSlot: "stdout",
      } as unknown as Record<string, unknown>).success,
    ).toBe(false);
    // artifact record must not contain leaseId/sessionId
    expect(
      EvidenceArtifactRecordSchema.safeParse({
        ...base,
        kind: "stdout",
        redaction: streamRedaction,
        leaseId: "lease-fixture-1",
      } as unknown as Record<string, unknown>).success,
    ).toBe(false);
  });

  it("observation requires parserVersion and plugin identity", () => {
    const valid = {
      observationId: "observation-fixture-1",
      runId: "run-fixture-3",
      artifactId,
      artifactDigest: digestAlt,
      byteOffset: 0,
      byteLength: 34,
      parserVersion: "nmap-xml-v1",
      pluginId: "nmap",
      pluginVersion: "1.0.0",
    };
    expect(EvidenceObservationReferenceSchema.safeParse(valid).success).toBe(true);
    expect(
      EvidenceObservationReferenceSchema.safeParse({ ...valid, parserVersion: undefined } as unknown as Record<
        string,
        unknown
      >).success,
    ).toBe(false);
    expect(
      EvidenceObservationReferenceSchema.safeParse({ ...valid, pluginId: undefined } as unknown as Record<
        string,
        unknown
      >).success,
    ).toBe(false);
    expect(
      EvidenceObservationReferenceSchema.safeParse({ ...valid, pluginVersion: undefined } as unknown as Record<
        string,
        unknown
      >).success,
    ).toBe(false);
  });

  it("quota validates only per-field bounds (no cross-field)", () => {
    const valid = {
      perArtifactBytes: 67_108_864,
      perRunPublishedBytes: 268_435_456,
      totalPublishedBytes: 34_359_738_368,
      maxInFlightStagingBytes: 65_536,
      maxConcurrentUploadsPerRunner: 2,
    };
    // staging < perArtifact is now allowed (independent ranges)
    expect(EvidenceQuotaConfigSchema.safeParse(valid).success).toBe(true);
    expect(
      EvidenceQuotaConfigSchema.safeParse({ ...valid, perArtifactBytes: 100 } as unknown as Record<string, unknown>)
        .success,
    ).toBe(false);
    expect(
      EvidenceQuotaConfigSchema.safeParse({
        ...valid,
        perArtifactBytes: 67_108_864,
        perRunPublishedBytes: 268_435_456,
        totalPublishedBytes: 34_359_738_368,
        maxInFlightStagingBytes: 268_435_456,
        maxConcurrentUploadsPerRunner: 2,
        unlimited: true,
      } as unknown as Record<string, unknown>).success,
    ).toBe(false);
    expect(
      EvidenceGrantIdentitySchema.safeParse({
        runId: "run-fixture-3",
        leaseId: "lease-fixture-1",
        sessionId: "session-fixture-1",
        fence: "0",
        eventSequence: 7,
        artifactSlot: "stdout",
      } as unknown as Record<string, unknown>).success,
    ).toBe(false);
  });

  it.each([
    "artifact_not_regular_file",
    "artifact_published_root_changed",
    "evidence_roots_cross_device",
  ] as const)("core path code %j in aggregated and complete error", (code) => {
    expect(EvidencePathErrorCodeSchema.safeParse(code).success).toBe(true);
    expect(EvidenceErrorCodeSchema.safeParse(code).success).toBe(true);
    expect(CompleteEvidenceUploadErrorCodeSchema.safeParse(code).success).toBe(true);
  });

  it("complete result parses digest/identity/lease/quota/path/root failures", () => {
    for (const code of [
      "artifact_digest_mismatch",
      "artifact_identity_conflict",
      "lease_expired",
      "run_quota_exceeded",
      "artifact_path_rejected",
      "artifact_not_regular_file",
      "evidence_roots_cross_device",
    ] as const) {
      expect(CompleteEvidenceUploadResultSchema.safeParse({ ok: false, error: { code } }).success).toBe(true);
    }
    expect(CompleteEvidenceUploadResultSchema.safeParse({ ok: true, result: { disposition: "stored_artifact_replayed", artifactId, sizeBytes: 24, digest: digestLow, completeness: "complete" } }).success).toBe(true);
    expect(EvidenceErrorCodeSchema.safeParse("stored_artifact_replayed").success).toBe(false);
  });
});
