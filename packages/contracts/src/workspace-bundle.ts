import { z } from "zod";

import { EngagementKindSchema, EngagementNameSchema } from "./engagement.js";
import { OpaqueArtifactIdSchema } from "./evidence.js";
import { EvidenceArtifactKindSchema, EvidenceDigestSchema } from "./evidence.js";
import { PublishedCompletenessSchema } from "./evidence.js";
import { ExcerptSchema, AttachmentSchema } from "./excerpts.js";
import { FindingSchema } from "./findings.js";
import { LeadAttemptSchema, LeadSchema } from "./leads.js";
import { ObjectiveSchema } from "./objectives.js";
import { SecretSchema } from "./secrets.js";

/**
 * Portable workspace bundle (stone-9).
 * One file for continuing work on another machine as a NEW engagement. This
 * is not a client report: it carries working records plus evidence bytes so
 * the imported engagement keeps its leads, excerpts, findings, and
 * byte-identical evidence. Hashes are checked on import; ids are always
 * remapped so two imports of the same file never collide.
 *
 * Default exports exclude credentials, flags, and client identifiers.
 * `privateCopy: true` is an explicit opt-in that additionally carries the
 * engagement description, authorization context, secret records, and
 * objective proof metadata (digests and hints only, never proof values,
 * which the server never stores).
 */

export const WORKSPACE_BUNDLE_KIND = "stonehush-workspace-bundle-v1";
export const WORKSPACE_BUNDLE_VERSION = 1;

// Transport bounds. Raw evidence bytes cap the work before any byte is read;
// the JSON bound covers Base64 inflation plus the surrounding records. The
// import route enforces the JSON bound as its body limit so oversized
// uploads are rejected before unbounded memory use.
export const WORKSPACE_BUNDLE_MAX_JSON_BYTES = 32 * 1024 * 1024;
export const WORKSPACE_BUNDLE_MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
export const WORKSPACE_BUNDLE_MAX_EVIDENCE_FILE_BYTES = 8 * 1024 * 1024;
export const WORKSPACE_BUNDLE_MAX_LEADS = 1000;
export const WORKSPACE_BUNDLE_MAX_ATTEMPTS = 5000;
export const WORKSPACE_BUNDLE_MAX_EXCERPTS = 2000;
export const WORKSPACE_BUNDLE_MAX_ATTACHMENTS = 200;
export const WORKSPACE_BUNDLE_MAX_FINDINGS = 1000;
export const WORKSPACE_BUNDLE_MAX_EVIDENCE_FILES = 500;
export const WORKSPACE_BUNDLE_MAX_SECRETS = 500;
export const WORKSPACE_BUNDLE_MAX_OBJECTIVES = 200;

// Base64 of the largest portable evidence file, with slack for padding.
export const WORKSPACE_BUNDLE_EVIDENCE_BASE64_MAX =
  (WORKSPACE_BUNDLE_MAX_EVIDENCE_FILE_BYTES * 4) / 3 + 1024;

const UtcTimestampSchema = z.iso.datetime({ offset: true });
const EngagementIdentifierSchema = z.uuid({ version: "v4" });

// Client identifiers travel only in an explicit private copy. Bounds mirror
// the engagement contract loosely; the bundle never widens stored data.
const BundleClientTextSchema = z.string().max(16_384).nullable();

export const WorkspaceBundleEngagementSchema = z.strictObject({
  name: EngagementNameSchema,
  kind: EngagementKindSchema,
  deadlineAt: z.iso.datetime().nullable(),
  description: BundleClientTextSchema,
  authorizationContext: BundleClientTextSchema,
});

export type WorkspaceBundleEngagement = z.infer<
  typeof WorkspaceBundleEngagementSchema
>;

export const WorkspaceBundleNotesSchema = z.strictObject({
  markdown: z.string().max(1_048_576),
  updatedAt: UtcTimestampSchema,
});

// One evidence file with its bytes inline. The digest is the integrity
// anchor: import recomputes it from the decoded bytes and rejects any
// mismatch. artifactSlot is preserved so discovery projections re-derive on
// import; every other storage identity (artifact id, run id, fence,
// sequence) is remapped to fresh values.
export const WorkspaceBundleEvidenceSchema = z.strictObject({
  artifactId: OpaqueArtifactIdSchema,
  kind: EvidenceArtifactKindSchema,
  sizeBytes: z
    .number()
    .int()
    .safe()
    .nonnegative()
    .max(WORKSPACE_BUNDLE_MAX_EVIDENCE_FILE_BYTES),
  digest: EvidenceDigestSchema,
  completeness: PublishedCompletenessSchema,
  artifactSlot: OpaqueArtifactIdSchema,
  originalRunId: z.string().min(1).max(255),
  contentBase64: z.string().min(1).max(WORKSPACE_BUNDLE_EVIDENCE_BASE64_MAX),
});

export type WorkspaceBundleEvidence = z.infer<
  typeof WorkspaceBundleEvidenceSchema
>;

// Attachments carry their image bytes inline (Base64 bound matches the
// excerpt contract). The digest is rechecked on import like evidence.
export const WorkspaceBundleAttachmentSchema = AttachmentSchema.extend({
  contentBase64: z.string().min(1).max(2_000_000),
});

export type WorkspaceBundleAttachment = z.infer<
  typeof WorkspaceBundleAttachmentSchema
>;

export const WorkspaceBundleSchema = z
  .strictObject({
    kind: z.literal(WORKSPACE_BUNDLE_KIND),
    bundleVersion: z.literal(WORKSPACE_BUNDLE_VERSION),
    exportedAt: UtcTimestampSchema,
    sourceEngagementId: EngagementIdentifierSchema,
    sourceEngagementName: z.string().min(1).max(120),
    // Explicit private-copy opt-in. False means no secrets, no objectives,
    // and no client identifiers anywhere in this file.
    privateCopy: z.boolean(),
    engagement: WorkspaceBundleEngagementSchema,
    notes: WorkspaceBundleNotesSchema,
    leads: z.array(LeadSchema).max(WORKSPACE_BUNDLE_MAX_LEADS),
    attempts: z.array(LeadAttemptSchema).max(WORKSPACE_BUNDLE_MAX_ATTEMPTS),
    excerpts: z.array(ExcerptSchema).max(WORKSPACE_BUNDLE_MAX_EXCERPTS),
    attachments: z
      .array(WorkspaceBundleAttachmentSchema)
      .max(WORKSPACE_BUNDLE_MAX_ATTACHMENTS),
    findings: z.array(FindingSchema).max(WORKSPACE_BUNDLE_MAX_FINDINGS),
    evidence: z
      .array(WorkspaceBundleEvidenceSchema)
      .max(WORKSPACE_BUNDLE_MAX_EVIDENCE_FILES),
    secrets: z.array(SecretSchema).max(WORKSPACE_BUNDLE_MAX_SECRETS),
    objectives: z.array(ObjectiveSchema).max(WORKSPACE_BUNDLE_MAX_OBJECTIVES),
  })
  .superRefine((bundle, context) => {
    if (bundle.privateCopy) return;
    if (bundle.secrets.length > 0) {
      context.addIssue({
        code: "custom",
        message: "default bundles carry no secret records",
        path: ["secrets"],
      });
    }
    if (bundle.objectives.length > 0) {
      context.addIssue({
        code: "custom",
        message: "default bundles carry no objective records",
        path: ["objectives"],
      });
    }
    if (bundle.engagement.description !== null) {
      context.addIssue({
        code: "custom",
        message: "default bundles carry no description",
        path: ["engagement", "description"],
      });
    }
    if (bundle.engagement.authorizationContext !== null) {
      context.addIssue({
        code: "custom",
        message: "default bundles carry no authorization context",
        path: ["engagement", "authorizationContext"],
      });
    }
  });

export type WorkspaceBundle = z.infer<typeof WorkspaceBundleSchema>;

// Minimal pre-parse for a clear version error. A bundle with an unknown
// kind or version is rejected as unsupported before full validation runs.
// Non-strict on purpose: the probe sees the whole bundle and reads only
// these two fields.
export const WorkspaceBundleVersionProbeSchema = z.object({
  kind: z.string(),
  bundleVersion: z.number(),
});

export const WorkspaceBundleExportQuerySchema = z.strictObject({
  // Only the exact string "true" opts in, matching the labeled checkbox.
  // Absent or anything else exports the default bundle without private data.
  privateCopy: z.enum(["true"]).optional(),
});

export type WorkspaceBundleExportQuery = z.infer<
  typeof WorkspaceBundleExportQuerySchema
>;

export const WorkspaceBundleSummarySchema = z.strictObject({
  leads: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  excerpts: z.number().int().nonnegative(),
  attachments: z.number().int().nonnegative(),
  findings: z.number().int().nonnegative(),
  evidence: z.number().int().nonnegative(),
  secrets: z.number().int().nonnegative(),
  objectives: z.number().int().nonnegative(),
  privateCopy: z.boolean(),
});

export type WorkspaceBundleSummary = z.infer<
  typeof WorkspaceBundleSummarySchema
>;

export const WorkspaceBundleImportResponseSchema = z.strictObject({
  engagementId: EngagementIdentifierSchema,
  summary: WorkspaceBundleSummarySchema,
});

export type WorkspaceBundleImportResponse = z.infer<
  typeof WorkspaceBundleImportResponseSchema
>;

export const WorkspaceBundleErrorSchema = z.union([
  z.strictObject({ code: z.literal("invalid_request") }),
  z.strictObject({ code: z.literal("engagement_not_found") }),
  z.strictObject({ code: z.literal("storage_busy") }),
  z.strictObject({ code: z.literal("invalid_persisted_data") }),
  z.strictObject({ code: z.literal("unsupported_bundle_version") }),
  z.strictObject({ code: z.literal("bundle_digest_mismatch") }),
  z.strictObject({ code: z.literal("bundle_too_large") }),
]);

export type WorkspaceBundleError = z.infer<typeof WorkspaceBundleErrorSchema>;

// Raw evidence total from bundle metadata alone, before any byte is
// decoded. Import and export both refuse totals above the byte cap.
export function workspaceBundleRawBytes(
  evidence: readonly { sizeBytes: number }[],
): number {
  let total = 0;
  for (const entry of evidence) total += entry.sizeBytes;
  return total;
}
