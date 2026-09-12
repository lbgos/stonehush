import { describe, expect, it } from "vitest";

import {
  AttachmentSchema,
  ATTACHMENT_CAPTION_MAX,
  CreateAttachmentRequestSchema,
  CreateDerivedAttachmentRequestSchema,
  CreateExcerptRequestSchema,
  ExcerptErrorSchema,
  ExcerptSchema,
  ExcerptSearchQuerySchema,
  ExcerptSearchResponseSchema,
} from "./excerpts.js";

const DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ENGAGEMENT_ID = "10000000-0000-4000-8000-000000000001";
const EXCERPT_ID = "20000000-0000-4000-8000-000000000001";

function validExcerpt() {
  return {
    contractVersion: 1 as const,
    id: EXCERPT_ID,
    engagementId: ENGAGEMENT_ID,
    runId: "run-1",
    artifactId: "artifact-stdout",
    artifactDigest: DIGEST,
    stream: "stdout" as const,
    byteOffset: 0,
    byteLength: 128,
    content: "masked content",
    redactions: 0,
    targetNote: null,
    createdAt: "2026-08-12T12:00:00.000Z",
  };
}

describe("excerpt contracts", () => {
  it("accepts a bounded create request with an operator target note", () => {
    expect(
      CreateExcerptRequestSchema.safeParse({
        runId: "run-1",
        artifactId: "artifact-stdout",
        stream: "stdout",
        byteOffset: 1024,
        byteLength: 256,
        targetNote: "web on 10.0.0.5",
      }).success,
    ).toBe(true);
  });

  it.each([
    ["artifactDigest", DIGEST],
    ["content", "invented bytes"],
    ["digest", DIGEST],
    ["target", "10.0.0.5"],
    ["engagementId", ENGAGEMENT_ID],
  ])("rejects invented metadata field %j", (field, value) => {
    expect(
      CreateExcerptRequestSchema.safeParse({
        runId: "run-1",
        artifactId: "artifact-stdout",
        stream: "stdout",
        byteOffset: 0,
        byteLength: 16,
        [field]: value,
      } as unknown as Record<string, unknown>).success,
    ).toBe(false);
  });

  it.each([[0], [-1], [8_193]])("rejects bad byteLength %j", (byteLength) => {
    expect(
      CreateExcerptRequestSchema.safeParse({
        runId: "run-1",
        artifactId: "artifact-stdout",
        stream: "stdout",
        byteOffset: 0,
        byteLength,
      } as unknown as Record<string, unknown>).success,
    ).toBe(false);
  });

  it("rejects ranges past the declared size bound", () => {
    expect(
      CreateExcerptRequestSchema.safeParse({
        runId: "run-1",
        artifactId: "artifact-stdout",
        stream: "stdout",
        byteOffset: 1_073_741_824,
        byteLength: 1,
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown stream", () => {
    expect(
      CreateExcerptRequestSchema.safeParse({
        runId: "run-1",
        artifactId: "artifact-stdout",
        stream: "tool_raw",
        byteOffset: 0,
        byteLength: 16,
      } as unknown as Record<string, unknown>).success,
    ).toBe(false);
  });

  it("parses stored excerpts and the full error set", () => {
    expect(ExcerptSchema.safeParse(validExcerpt()).success).toBe(true);
    for (const code of [
      "invalid_request",
      "run_not_found",
      "artifact_not_found",
      "range_rejected",
      "missing_artifact",
      "corrupt_artifact",
    ] as const) {
      expect(ExcerptErrorSchema.safeParse({ code }).success).toBe(true);
    }
    expect(ExcerptErrorSchema.safeParse({ code: "stored_artifact_replayed" }).success).toBe(false);
  });

  it("rejects empty and overlong search queries", () => {
    expect(ExcerptSearchQuerySchema.safeParse({ q: "" }).success).toBe(false);
    expect(
      ExcerptSearchQuerySchema.safeParse({ q: "x".repeat(121) }).success,
    ).toBe(false);
    expect(
      ExcerptSearchQuerySchema.safeParse({ q: "login", limit: 25 }).success,
    ).toBe(false);
    const parsed = ExcerptSearchQuerySchema.safeParse({ q: "login" });
    expect(parsed.success && parsed.data.limit).toBe(10);
  });

  it("parses search responses with unavailable refs for retry", () => {
    expect(
      ExcerptSearchResponseSchema.safeParse({
        matches: [
          {
            artifactId: "artifact-stdout",
            stream: "stdout",
            byteOffset: 10,
            byteLength: 5,
            snippet: "a login b",
            redactions: 0,
          },
        ],
        searchedBytes: 1024,
        scanCapped: false,
        unavailableArtifactIds: ["artifact-stderr"],
      }).success,
    ).toBe(true);
  });
});

describe("attachment contracts", () => {
  it("accepts an image upload with caption and target label", () => {
    expect(
      CreateAttachmentRequestSchema.safeParse({
        filename: "admin login as sa",
        mime: "image/png",
        contentBase64: "aGVsbG8=",
        caption: "login form",
        targetLabel: "web on 10.0.0.5",
      }).success,
    ).toBe(true);
  });

  it.each([["image/svg+xml"], ["application/pdf"], ["text/plain"]])(
    "rejects non-image mime %j",
    (mime) => {
      expect(
        CreateAttachmentRequestSchema.safeParse({
          filename: "proof",
          mime,
          contentBase64: "aGVsbG8=",
        } as unknown as Record<string, unknown>).success,
      ).toBe(false);
    },
  );

  it("rejects overlong captions and derived crops with zero size", () => {
    expect(
      CreateAttachmentRequestSchema.safeParse({
        filename: "proof",
        mime: "image/png",
        contentBase64: "aGVsbG8=",
        caption: "x".repeat(ATTACHMENT_CAPTION_MAX + 1),
      } as unknown as Record<string, unknown>).success,
    ).toBe(false);
    expect(
      CreateDerivedAttachmentRequestSchema.safeParse({
        crop: { x: 0, y: 0, width: 0, height: 10 },
      } as unknown as Record<string, unknown>).success,
    ).toBe(false);
    expect(
      CreateDerivedAttachmentRequestSchema.safeParse({
        caption: "crop of login form",
        crop: { x: 4, y: 4, width: 100, height: 60 },
      }).success,
    ).toBe(true);
  });

  it("parses stored attachments with parent lineage", () => {
    expect(
      AttachmentSchema.safeParse({
        contractVersion: 1 as const,
        id: EXCERPT_ID,
        engagementId: ENGAGEMENT_ID,
        filename: "admin-login-as-sa",
        mime: "image/png",
        sizeBytes: 5,
        digest: DIGEST,
        caption: "login form",
        targetLabel: null,
        parentAttachmentId: null,
        crop: null,
        createdAt: "2026-08-12T12:00:00.000Z",
      }).success,
    ).toBe(true);
  });
});
