import { z } from "zod";

import { EngagementSchema } from "./engagement.js";
import { EvidenceDigestSchema, OpaqueArtifactIdSchema } from "./evidence.js";

export const EXCERPT_CONTRACT_VERSION = 1 as const;
export const EXCERPT_MAX_BYTES = 8_192 as const;
export const EXCERPT_CONTENT_MAX_CHARS = 16_384 as const;
export const EXCERPT_DECLARED_SIZE_MAX = 1_073_741_824 as const;
export const EXCERPT_TARGET_NOTE_MAX = 120 as const;
export const EXCERPT_SEARCH_QUERY_MAX = 120 as const;
export const EXCERPT_SEARCH_MATCHES_MAX = 20 as const;
export const EXCERPT_SEARCH_SCAN_MAX_BYTES = 262_144 as const;
export const ATTACHMENT_CONTENT_BASE64_MAX = 2_000_000 as const;
export const ATTACHMENT_CAPTION_MAX = 280 as const;
export const ATTACHMENT_FILENAME_MAX = 128 as const;
export const ATTACHMENT_TARGET_LABEL_MAX = 120 as const;

const EngagementIdentifierSchema = EngagementSchema.shape.id;
const RunIdentifierSchema = z.string().min(1).max(255);

export const ExcerptStreamSchema = z.enum(["stdout", "stderr"]);

// Stable reference to preserved source bytes. The digest is always resolved
// server-side from the stored artifact; callers never supply it, so an
// invented digest, offset, or content claim cannot become an excerpt.
export const ExcerptSourceSchema = z.strictObject({
  engagementId: EngagementIdentifierSchema,
  runId: RunIdentifierSchema,
  artifactId: OpaqueArtifactIdSchema,
  artifactDigest: EvidenceDigestSchema,
  stream: ExcerptStreamSchema,
  byteOffset: z.number().int().safe().nonnegative(),
  byteLength: z.number().int().safe().positive().max(EXCERPT_MAX_BYTES),
});

export const CreateExcerptRequestSchema = z
  .strictObject({
    runId: RunIdentifierSchema,
    artifactId: OpaqueArtifactIdSchema,
    stream: ExcerptStreamSchema,
    byteOffset: z.number().int().safe().nonnegative(),
    byteLength: z.number().int().safe().positive().max(EXCERPT_MAX_BYTES),
    // Operator annotation only, stored verbatim and labelled as such in the
    // finding prefill. It is never treated as verified source metadata.
    targetNote: z.string().min(1).max(EXCERPT_TARGET_NOTE_MAX).optional(),
  })
  .superRefine((value, context) => {
    if (value.byteOffset + value.byteLength > EXCERPT_DECLARED_SIZE_MAX) {
      context.addIssue({
        code: "custom",
        message: "excerpt byte range exceeds bounds",
        path: ["byteLength"],
      });
    }
  });

export const ExcerptSchema = z.strictObject({
  contractVersion: z.literal(EXCERPT_CONTRACT_VERSION),
  id: EngagementIdentifierSchema,
  engagementId: EngagementIdentifierSchema,
  runId: RunIdentifierSchema,
  artifactId: OpaqueArtifactIdSchema,
  artifactDigest: EvidenceDigestSchema,
  stream: ExcerptStreamSchema,
  byteOffset: z.number().int().safe().nonnegative(),
  byteLength: z.number().int().safe().positive().max(EXCERPT_MAX_BYTES),
  // Masked at creation with the shared advisor redactor. Raw secret values
  // are never persisted on an excerpt.
  content: z.string().max(EXCERPT_CONTENT_MAX_CHARS),
  redactions: z.number().int().safe().nonnegative(),
  targetNote: z.string().min(1).max(EXCERPT_TARGET_NOTE_MAX).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});

export const ExcerptListResponseSchema = z.array(ExcerptSchema);

export const ExcerptErrorSchema = z.union([
  z.strictObject({ code: z.literal("invalid_request") }),
  z.strictObject({ code: z.literal("engagement_not_found") }),
  z.strictObject({ code: z.literal("engagement_archived") }),
  z.strictObject({ code: z.literal("run_not_found") }),
  z.strictObject({ code: z.literal("artifact_not_found") }),
  z.strictObject({ code: z.literal("range_rejected") }),
  z.strictObject({ code: z.literal("missing_artifact") }),
  z.strictObject({ code: z.literal("corrupt_artifact") }),
  z.strictObject({ code: z.literal("invalid_persisted_data") }),
  z.strictObject({ code: z.literal("storage_busy") }),
]);

export const ExcerptSearchQuerySchema = z.strictObject({
  q: z.string().min(1).max(EXCERPT_SEARCH_QUERY_MAX),
  stream: ExcerptStreamSchema.optional(),
  limit: z.number().int().safe().min(1).max(EXCERPT_SEARCH_MATCHES_MAX).optional().default(10),
});

export const ExcerptSearchMatchSchema = z.strictObject({
  artifactId: OpaqueArtifactIdSchema,
  stream: ExcerptStreamSchema,
  byteOffset: z.number().int().safe().nonnegative(),
  byteLength: z.number().int().safe().positive(),
  // Masked snippet centered on the match. Never the full artifact.
  snippet: z.string().max(EXCERPT_CONTENT_MAX_CHARS),
  redactions: z.number().int().safe().nonnegative(),
});

export const ExcerptSearchResponseSchema = z.strictObject({
  matches: z.array(ExcerptSearchMatchSchema).max(EXCERPT_SEARCH_MATCHES_MAX),
  searchedBytes: z.number().int().safe().nonnegative(),
  // True when the scan stopped at the byte cap before covering every
  // candidate artifact, so absence of a match is not proof of absence.
  scanCapped: z.boolean(),
  // Artifact ids skipped because their bytes are currently unavailable.
  // Resolve them through the excerpt-sources endpoint for retry metadata.
  unavailableArtifactIds: z.array(OpaqueArtifactIdSchema),
});

// Byte-level artifact references for one run. Served from stored metadata
// only, so a failed download still leaves a reference plus retry context.
export const ExcerptSourceRefSchema = z.strictObject({
  artifactId: OpaqueArtifactIdSchema,
  kind: z.string().min(1).max(32),
  sizeBytes: z.number().int().safe().nonnegative().max(EXCERPT_DECLARED_SIZE_MAX),
  digest: EvidenceDigestSchema,
  completeness: z.string().min(1).max(16),
});

export const ExcerptSourceListResponseSchema = z.array(ExcerptSourceRefSchema);

export const AttachmentMimeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export const AttachmentCropSchema = z.strictObject({
  x: z.number().int().safe().nonnegative(),
  y: z.number().int().safe().nonnegative(),
  width: z.number().int().safe().positive(),
  height: z.number().int().safe().positive(),
});

export const CreateAttachmentRequestSchema = z.strictObject({
  // Operator name for what the image proves. Slugified server-side; the
  // stored filename is echoed back.
  filename: z.string().min(1).max(ATTACHMENT_FILENAME_MAX),
  mime: AttachmentMimeSchema,
  contentBase64: z.string().min(1).max(ATTACHMENT_CONTENT_BASE64_MAX),
  caption: z.string().max(ATTACHMENT_CAPTION_MAX).optional().default(""),
  targetLabel: z.string().min(1).max(ATTACHMENT_TARGET_LABEL_MAX).optional(),
});

export const CreateDerivedAttachmentRequestSchema = z.strictObject({
  caption: z.string().max(ATTACHMENT_CAPTION_MAX).optional().default(""),
  crop: AttachmentCropSchema.optional(),
});

export const UpdateAttachmentRequestSchema = z.strictObject({
  caption: z.string().max(ATTACHMENT_CAPTION_MAX),
});

export const AttachmentSchema = z.strictObject({
  contractVersion: z.literal(EXCERPT_CONTRACT_VERSION),
  id: EngagementIdentifierSchema,
  engagementId: EngagementIdentifierSchema,
  filename: z.string().min(1).max(ATTACHMENT_FILENAME_MAX),
  mime: AttachmentMimeSchema,
  sizeBytes: z.number().int().safe().positive().max(ATTACHMENT_CONTENT_BASE64_MAX),
  digest: EvidenceDigestSchema,
  caption: z.string().max(ATTACHMENT_CAPTION_MAX),
  targetLabel: z.string().min(1).max(ATTACHMENT_TARGET_LABEL_MAX).nullable(),
  // Null for originals. Derived crops and annotations point at the kept
  // original; originals are never mutated by derivation.
  parentAttachmentId: EngagementIdentifierSchema.nullable(),
  crop: AttachmentCropSchema.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});

export const AttachmentListResponseSchema = z.array(AttachmentSchema);

export const AttachmentErrorSchema = z.union([
  z.strictObject({ code: z.literal("invalid_request") }),
  z.strictObject({ code: z.literal("engagement_not_found") }),
  z.strictObject({ code: z.literal("engagement_archived") }),
  z.strictObject({ code: z.literal("attachment_not_found") }),
  z.strictObject({ code: z.literal("invalid_persisted_data") }),
  z.strictObject({ code: z.literal("storage_busy") }),
]);

export type ExcerptStream = z.infer<typeof ExcerptStreamSchema>;
export type ExcerptSource = z.infer<typeof ExcerptSourceSchema>;
export type CreateExcerptRequest = z.infer<typeof CreateExcerptRequestSchema>;
export type Excerpt = z.infer<typeof ExcerptSchema>;
export type ExcerptError = z.infer<typeof ExcerptErrorSchema>;
export type ExcerptSearchMatch = z.infer<typeof ExcerptSearchMatchSchema>;
export type ExcerptSearchResponse = z.infer<typeof ExcerptSearchResponseSchema>;
export type ExcerptSourceRef = z.infer<typeof ExcerptSourceRefSchema>;
export type AttachmentCrop = z.infer<typeof AttachmentCropSchema>;
export type CreateAttachmentRequest = z.infer<typeof CreateAttachmentRequestSchema>;
export type Attachment = z.infer<typeof AttachmentSchema>;
export type AttachmentError = z.infer<typeof AttachmentErrorSchema>;
