import { z } from "zod";

import { EngagementSchema } from "./engagement.js";
import {
  PositiveFencingTokenSchema,
  RunnerEventDigestSchema,
  RunnerSequenceSchema,
} from "./runner-control.js";

export const EVIDENCE_PROFILE = "d3-v1" as const;
export const EVIDENCE_CONTRACT_VERSION = 1 as const;

export const EvidenceProfileSchema = z.literal(EVIDENCE_PROFILE);
export const EvidenceContractVersionSchema = z.literal(EVIDENCE_CONTRACT_VERSION);

export const EVIDENCE_EMPTY_SHA256_DIGEST =
  "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" as const;

export const OPAQUE_EVIDENCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,126}$/;

// Single implementation with semantic aliases.
export const OpaqueEvidenceIdSchema = z.string().regex(OPAQUE_EVIDENCE_ID_PATTERN);
export const OpaqueArtifactIdSchema = OpaqueEvidenceIdSchema;
export const OpaqueUploadIdSchema = OpaqueEvidenceIdSchema;
export const OpaqueArtifactSlotSchema = OpaqueEvidenceIdSchema;
export const OpaqueObservationIdSchema = OpaqueEvidenceIdSchema;

const GenericIdentifierSchema = z.string().min(1).max(255);

// Single digest alias (lowercase).
export const EvidenceDigestSchema = RunnerEventDigestSchema;

export const EvidenceArtifactKindSchema = z.enum([
  "stdout",
  "stderr",
  "tool_raw",
  "tool_parsed_input",
]);

// Published artifacts may only be complete/partial/truncated.
// Incomplete is an unpublished slot/grant projection, never stored on a record.
// Missing/corrupt are read-time projections only.
export const PublishedCompletenessSchema = z.enum(["complete", "partial", "truncated"]);
export const IncompleteProjectionSchema = z.literal("incomplete");
export const ReadProjectionSchema = z.enum(["missing", "corrupt"]);

export const EvidenceRedactionBoundarySchema = z.enum(["runner_stream", "none"]);

export const EvidenceRedactionSchema = z
  .strictObject({
    applied: z.boolean(),
    boundary: EvidenceRedactionBoundarySchema,
    rawBytesPreserved: z.boolean(),
  })
  .superRefine((value, context) => {
    if (value.applied === true && value.rawBytesPreserved === true) {
      context.addIssue({
        code: "custom",
        message: "redaction cannot be applied while raw bytes are preserved",
        path: ["rawBytesPreserved"],
      });
    }
    const isStreamRedacted =
      value.applied === true &&
      value.boundary === "runner_stream" &&
      value.rawBytesPreserved === false;
    const isToolRaw =
      value.applied === false &&
      value.boundary === "none" &&
      value.rawBytesPreserved === true;
    if (!isStreamRedacted && !isToolRaw) {
      context.addIssue({
        code: "custom",
        message: "redaction must be either stream-redacted or tool-raw tuple",
        path: ["boundary"],
      });
    }
  });

export function isRedactionValidForKind(
  kind: z.infer<typeof EvidenceArtifactKindSchema>,
  redaction: z.infer<typeof EvidenceRedactionSchema>,
): boolean {
  if (kind === "stdout" || kind === "stderr") {
    return (
      redaction.applied === true &&
      redaction.boundary === "runner_stream" &&
      redaction.rawBytesPreserved === false
    );
  }
  return (
    redaction.applied === false &&
    redaction.boundary === "none" &&
    redaction.rawBytesPreserved === true
  );
}

export const EvidenceGrantIdentitySchema = z.strictObject({
  runId: GenericIdentifierSchema,
  leaseId: GenericIdentifierSchema,
  sessionId: GenericIdentifierSchema,
  fence: PositiveFencingTokenSchema,
  eventSequence: RunnerSequenceSchema,
  artifactSlot: OpaqueArtifactSlotSchema,
});

export const EVIDENCE_DECLARED_SIZE_MAX = 1_073_741_824;
export const EVIDENCE_ORIGINAL_FILENAME_MAX = 255;
export const EVIDENCE_CONTENT_TYPE_MAX = 127;

// Grant request must carry required kind and bounded optional fields.
// Strict object rejects any caller-supplied path/ID fields.
export const CreateEvidenceGrantRequestSchema = z.strictObject({
  runId: GenericIdentifierSchema,
  leaseId: GenericIdentifierSchema,
  sessionId: GenericIdentifierSchema,
  fence: PositiveFencingTokenSchema,
  eventSequence: RunnerSequenceSchema,
  artifactSlot: OpaqueArtifactSlotSchema,
  kind: EvidenceArtifactKindSchema,
  declaredSizeBytes: z
    .number()
    .int()
    .safe()
    .nonnegative()
    .max(EVIDENCE_DECLARED_SIZE_MAX)
    .optional(),
  declaredDigest: EvidenceDigestSchema.optional(),
  originalFileName: z.string().min(1).max(EVIDENCE_ORIGINAL_FILENAME_MAX).optional(),
  declaredContentType: z.string().min(1).max(EVIDENCE_CONTENT_TYPE_MAX).optional(),
});

export const EvidenceGrantResponseSchema = z.strictObject({
  artifactId: OpaqueArtifactIdSchema,
  uploadId: OpaqueUploadIdSchema,
  runId: GenericIdentifierSchema,
  leaseId: GenericIdentifierSchema,
  sessionId: GenericIdentifierSchema,
  fence: PositiveFencingTokenSchema,
  eventSequence: RunnerSequenceSchema,
  artifactSlot: OpaqueArtifactSlotSchema,
  kind: EvidenceArtifactKindSchema,
  declaredSizeBytes: z
    .number()
    .int()
    .safe()
    .nonnegative()
    .max(EVIDENCE_DECLARED_SIZE_MAX)
    .optional(),
  declaredDigest: EvidenceDigestSchema.optional(),
  originalFileName: z.string().min(1).max(EVIDENCE_ORIGINAL_FILENAME_MAX).optional(),
  declaredContentType: z.string().min(1).max(EVIDENCE_CONTENT_TYPE_MAX).optional(),
  createdAt: z.iso.datetime({ offset: true }),
});

export const CompleteEvidenceUploadRequestSchema = z.strictObject({
  uploadId: OpaqueUploadIdSchema,
  sizeBytes: z.number().int().safe().nonnegative().max(EVIDENCE_DECLARED_SIZE_MAX),
  digest: EvidenceDigestSchema,
  completeness: PublishedCompletenessSchema.optional(),
});

// stored_artifact_replayed is a successful disposition, not an error.
export const CompleteEvidenceUploadSuccessSchema = z.strictObject({
  disposition: z.enum(["published", "stored_artifact_replayed"]),
  artifactId: OpaqueArtifactIdSchema,
  sizeBytes: z.number().int().safe().nonnegative(),
  digest: EvidenceDigestSchema,
  completeness: PublishedCompletenessSchema,
});



export const EvidenceArtifactRelativePathSchema = z
  .string()
  .regex(/^published\/[a-z0-9][a-z0-9-]{0,126}$/);

const TimestampSchema = z.iso.datetime({ offset: true });

// Durable artifact identity only: runId, fence, eventSequence, slot.
export const EvidenceArtifactRecordSchema = z
  .strictObject({
    contractVersion: EvidenceContractVersionSchema,
    profile: EvidenceProfileSchema,
    artifactId: OpaqueArtifactIdSchema,
    runId: GenericIdentifierSchema,
    fence: PositiveFencingTokenSchema,
    eventSequence: RunnerSequenceSchema,
    artifactSlot: OpaqueArtifactSlotSchema,
    kind: EvidenceArtifactKindSchema,
    sizeBytes: z.number().int().safe().nonnegative().max(EVIDENCE_DECLARED_SIZE_MAX),
    digest: EvidenceDigestSchema,
    relativePath: EvidenceArtifactRelativePathSchema,
    completeness: PublishedCompletenessSchema,
    redaction: EvidenceRedactionSchema,
    createdAt: TimestampSchema,
  })
  .superRefine((record, context) => {
    if (record.relativePath !== `published/${record.artifactId}`) {
      context.addIssue({
        code: "custom",
        message: "relativePath must equal published/{artifactId}",
        path: ["relativePath"],
      });
    }
    if (!isRedactionValidForKind(record.kind, record.redaction)) {
      context.addIssue({
        code: "custom",
        message: "redaction metadata does not match artifact kind",
        path: ["redaction"],
      });
    }
  });

const BoundedPluginStringSchema = z.string().min(1).max(64);

export const EvidenceObservationReferenceSchema = z
  .strictObject({
    observationId: OpaqueObservationIdSchema,
    runId: GenericIdentifierSchema,
    artifactId: OpaqueArtifactIdSchema,
    artifactDigest: EvidenceDigestSchema,
    byteOffset: z.number().int().safe().nonnegative().optional(),
    byteLength: z.number().int().safe().positive().optional(),
    parserVersion: BoundedPluginStringSchema,
    pluginId: BoundedPluginStringSchema,
    pluginVersion: BoundedPluginStringSchema,
  })
  .superRefine((value, context) => {
    if (value.byteLength !== undefined && value.byteOffset === undefined) {
      context.addIssue({
        code: "custom",
        message: "byteLength requires byteOffset",
        path: ["byteOffset"],
      });
    }
    if (
      value.byteOffset !== undefined &&
      value.byteLength !== undefined &&
      value.byteOffset + value.byteLength > EVIDENCE_DECLARED_SIZE_MAX
    ) {
      context.addIssue({
        code: "custom",
        message: "observation byte range exceeds bounds",
        path: ["byteLength"],
      });
    }
  });

export const EVIDENCE_QUOTA_DEFAULTS = {
  perArtifactBytes: 67_108_864,
  perRunPublishedBytes: 268_435_456,
  totalPublishedBytes: 34_359_738_368,
  maxInFlightStagingBytes: 268_435_456,
  maxConcurrentUploadsPerRunner: 2,
} as const;

export const EVIDENCE_QUOTA_LIMITS = {
  perArtifactBytes: { minimum: 65_536, maximum: 1_073_741_824 },
  perRunPublishedBytes: { minimum: 1_048_576, maximum: 4_294_967_296 },
  totalPublishedBytes: { minimum: 1_073_741_824, maximum: 1_099_511_627_776 },
  maxInFlightStagingBytes: { minimum: 65_536, maximum: 4_294_967_296 },
  maxConcurrentUploadsPerRunner: { minimum: 1, maximum: 8 },
} as const;

export const EVIDENCE_UPLOAD_IDLE_TIMEOUT_SECONDS = 30 as const;
export const EVIDENCE_UPLOAD_ABSOLUTE_TIMEOUT_SECONDS = 600 as const;

export const EvidenceQuotaConfigSchema = z.strictObject({
  perArtifactBytes: z
    .number()
    .int()
    .safe()
    .min(EVIDENCE_QUOTA_LIMITS.perArtifactBytes.minimum)
    .max(EVIDENCE_QUOTA_LIMITS.perArtifactBytes.maximum),
  perRunPublishedBytes: z
    .number()
    .int()
    .safe()
    .min(EVIDENCE_QUOTA_LIMITS.perRunPublishedBytes.minimum)
    .max(EVIDENCE_QUOTA_LIMITS.perRunPublishedBytes.maximum),
  totalPublishedBytes: z
    .number()
    .int()
    .safe()
    .min(EVIDENCE_QUOTA_LIMITS.totalPublishedBytes.minimum)
    .max(EVIDENCE_QUOTA_LIMITS.totalPublishedBytes.maximum),
  maxInFlightStagingBytes: z
    .number()
    .int()
    .safe()
    .min(EVIDENCE_QUOTA_LIMITS.maxInFlightStagingBytes.minimum)
    .max(EVIDENCE_QUOTA_LIMITS.maxInFlightStagingBytes.maximum),
  maxConcurrentUploadsPerRunner: z
    .number()
    .int()
    .safe()
    .min(EVIDENCE_QUOTA_LIMITS.maxConcurrentUploadsPerRunner.minimum)
    .max(EVIDENCE_QUOTA_LIMITS.maxConcurrentUploadsPerRunner.maximum),
});

export const EvidencePublicationErrorCodeSchema = z.enum([
  "artifact_already_published",
  "artifact_digest_mismatch",
  "artifact_identity_conflict",
  "artifact_upload_in_progress",
  "lease_expired",
  "lease_owner_mismatch",
  "runner_identity_required",
  "stale_fence",
]);

export const EvidenceQuotaErrorCodeSchema = z.enum([
  "artifact_quota_exceeded",
  "concurrent_upload_limit",
  "run_quota_exceeded",
  "staging_quota_exceeded",
  "total_quota_exceeded",
  "upload_timeout",
]);

export const EvidencePrivacyErrorCodeSchema = z.enum(["redaction_raw_claim_invalid"]);

export const EvidencePathErrorCodeSchema = z.enum([
  "artifact_not_regular_file",
  "artifact_path_rejected",
  "artifact_published_root_changed",
  "artifact_symlink_rejected",
  "artifact_hardlink_rejected",
  "cross_filesystem_staging",
  "evidence_roots_cross_device",
]);

// The backup quiesce gate pauses new publication without changing any grant,
// lease, or quota state.
export const StorageGateErrorCodeSchema = z.enum(["storage_backup_quiesced"]);

export const CompleteEvidenceUploadErrorCodeSchema = z.enum([
  ...EvidencePublicationErrorCodeSchema.options,
  ...EvidenceQuotaErrorCodeSchema.options,
  ...EvidencePathErrorCodeSchema.options,
  ...StorageGateErrorCodeSchema.options,
]);

export const CompleteEvidenceUploadErrorSchema = z.strictObject({
  code: CompleteEvidenceUploadErrorCodeSchema,
});

export const CompleteEvidenceUploadResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), result: CompleteEvidenceUploadSuccessSchema }),
  z.strictObject({ ok: z.literal(false), error: CompleteEvidenceUploadErrorSchema }),
]);

export const EvidenceErrorCodeSchema = z.enum([
  ...EvidencePublicationErrorCodeSchema.options,
  ...EvidenceQuotaErrorCodeSchema.options,
  ...EvidencePrivacyErrorCodeSchema.options,
  ...EvidencePathErrorCodeSchema.options,
]);

export type EvidenceArtifactKind = z.infer<typeof EvidenceArtifactKindSchema>;
export type PublishedCompleteness = z.infer<typeof PublishedCompletenessSchema>;
export type EvidenceRedaction = z.infer<typeof EvidenceRedactionSchema>;
export type EvidenceGrantIdentity = z.infer<typeof EvidenceGrantIdentitySchema>;
export type CreateEvidenceGrantRequest = z.infer<typeof CreateEvidenceGrantRequestSchema>;
export type EvidenceGrantResponse = z.infer<typeof EvidenceGrantResponseSchema>;
export type CompleteEvidenceUploadRequest = z.infer<
  typeof CompleteEvidenceUploadRequestSchema
>;
export type EvidenceArtifactRecord = z.infer<typeof EvidenceArtifactRecordSchema>;
export type EvidenceObservationReference = z.infer<
  typeof EvidenceObservationReferenceSchema
>;
export type EvidenceQuotaConfig = z.infer<typeof EvidenceQuotaConfigSchema>;
export type CompleteEvidenceUploadErrorCode = z.infer<
  typeof CompleteEvidenceUploadErrorCodeSchema
>;
export type EvidenceErrorCode = z.infer<typeof EvidenceErrorCodeSchema>;

// Operator artifact download: engagement-scoped content route. Both path
// identifiers are validated with existing identifier/opaque schemas.
export const ArtifactContentParamsSchema = z.strictObject({
  engagementId: EngagementSchema.shape.id,
  artifactId: OpaqueArtifactIdSchema,
});

export type ArtifactContentParams = z.infer<typeof ArtifactContentParamsSchema>;

export const ArtifactDownloadErrorSchema = z.union([
  z.strictObject({ code: z.literal("invalid_request") }),
  z.strictObject({ code: z.literal("range_not_supported") }),
  z.strictObject({ code: z.literal("artifact_not_found") }),
  z.strictObject({ code: z.literal("missing_artifact") }),
  z.strictObject({ code: z.literal("corrupt_artifact") }),
]);

export type ArtifactDownloadError = z.infer<typeof ArtifactDownloadErrorSchema>;

const OPERATOR_ARTIFACT_CONTENT_ROUTE_PATTERN =
  /^\/api\/v1\/engagements\/[^/]+\/artifacts\/[^/]+\/content$/;

// Exact operator download route matcher used by the auth hook to refuse
// runner credentials on operator-only content reads. Query strings ignored.
export function isOperatorArtifactContentRoute(url: string): boolean {
  return OPERATOR_ARTIFACT_CONTENT_ROUTE_PATTERN.test(url.split("?")[0] ?? url);
}

// ADR-0003 `stonehush-backup-v1`: the deterministic manifest written into a
// backup directory. Restore consumes it with strict parsing; every field is
// verified against the copied bytes before a restore writes anything.
export const BACKUP_PROTOCOL = "stonehush-backup-v1" as const;
export const BACKUP_MANIFEST_FILENAME = "backup-manifest" as const;
export const BACKUP_INCOMPLETE_MARKER_FILENAME = "INCOMPLETE" as const;

export const BackupStateSchema = z.enum(["started", "complete"]);

export const BackupArtifactEntrySchema = z.strictObject({
  artifactId: OpaqueArtifactIdSchema,
  sizeBytes: z.number().int().safe().nonnegative().max(EVIDENCE_DECLARED_SIZE_MAX),
  digest: EvidenceDigestSchema,
});

const BackupTimestampSchema = z.iso.datetime();

export const BackupManifestSchema = z
  .strictObject({
    protocol: z.literal(BACKUP_PROTOCOL),
    state: BackupStateSchema,
    startedAt: BackupTimestampSchema,
    // Present only once the snapshot is durable and verified.
    completedAt: BackupTimestampSchema.optional(),
    schemaVersion: z.number().int().safe().nonnegative(),
    sqliteDigest: EvidenceDigestSchema,
    artifacts: z.array(BackupArtifactEntrySchema),
    artifactCount: z.number().int().safe().nonnegative(),
  })
  .superRefine((manifest, context) => {
    if (manifest.state === "complete" && manifest.completedAt === undefined) {
      context.addIssue({
        code: "custom",
        message: "a complete backup manifest requires completedAt",
        path: ["completedAt"],
      });
    }
    if (manifest.artifacts.length !== manifest.artifactCount) {
      context.addIssue({
        code: "custom",
        message: "artifactCount must equal the number of artifact entries",
        path: ["artifactCount"],
      });
    }
    for (let index = 1; index < manifest.artifacts.length; index += 1) {
      const previous = manifest.artifacts[index - 1]?.artifactId ?? "";
      const current = manifest.artifacts[index]?.artifactId ?? "";
      if (previous >= current) {
        context.addIssue({
          code: "custom",
          message: "artifact entries must be sorted and unique by artifactId",
          path: ["artifacts"],
        });
        break;
      }
    }
  });

export type BackupState = z.infer<typeof BackupStateSchema>;
export type BackupArtifactEntry = z.infer<typeof BackupArtifactEntrySchema>;
export type BackupManifest = z.infer<typeof BackupManifestSchema>;
