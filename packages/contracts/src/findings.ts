import { z } from "zod";

import { EngagementSchema } from "./engagement.js";

export const FINDING_CONTRACT_VERSION = 1 as const;
export const FINDING_BODY_MAX_BYTES = 65_536 as const;
export const FINDING_EVIDENCE_REFS_MAX = 32 as const;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function hasCodePointLength(value: string, minimum: number, maximum: number): boolean {
  const length = Array.from(value).length;
  return length >= minimum && length <= maximum;
}

export const FindingSeveritySchema = z.enum([
  "info",
  "low",
  "medium",
  "high",
  "critical",
]);

export const FindingStatusSchema = z.enum(["open", "resolved"]);

export const FindingTitleSchema = z
  .string()
  .refine((value) => value === value.trim(), {
    message: "must not have leading or trailing whitespace",
  })
  .refine((value) => hasCodePointLength(value, 1, 120), {
    message: "must contain between 1 and 120 Unicode code points",
  });

export const FindingBodySchema = z
  .string()
  .refine((value) => utf8ByteLength(value) <= FINDING_BODY_MAX_BYTES, {
    message: "must contain at most 65536 UTF-8 bytes",
  });

export const FindingEvidenceArtifactIdSchema = z
  .string()
  .min(1)
  .max(127)
  .regex(/^[a-z0-9][a-z0-9-]*$/, {
    message: "must be a managed artifact id",
  });

export const FindingEvidenceRefsSchema = z
  .array(FindingEvidenceArtifactIdSchema)
  .max(FINDING_EVIDENCE_REFS_MAX);

export const FindingSchema = z.strictObject({
  contractVersion: z.literal(FINDING_CONTRACT_VERSION),
  id: EngagementSchema.shape.id,
  engagementId: EngagementSchema.shape.id,
  title: FindingTitleSchema,
  severity: FindingSeveritySchema,
  status: FindingStatusSchema,
  body: FindingBodySchema,
  evidenceArtifactIds: FindingEvidenceRefsSchema,
  revision: z.number().int().safe().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const FindingIdParamsSchema = z.strictObject({
  engagementId: EngagementSchema.shape.id,
  findingId: EngagementSchema.shape.id,
});

export const CreateFindingRequestSchema = z.strictObject({
  title: FindingTitleSchema,
  severity: FindingSeveritySchema,
  body: FindingBodySchema,
  evidenceArtifactIds: FindingEvidenceRefsSchema.optional().default([]),
});

export const UpdateFindingRequestSchema = z.strictObject({
  title: FindingTitleSchema,
  severity: FindingSeveritySchema,
  body: FindingBodySchema,
  expectedRevision: z.number().int().safe().nonnegative(),
});

export const FindingResponseSchema = FindingSchema;
export const FindingListResponseSchema = z.array(FindingSchema);

export const FindingQueryErrorSchema = z.union([
  z.strictObject({ code: z.literal("invalid_request") }),
  z.strictObject({ code: z.literal("engagement_not_found") }),
  z.strictObject({ code: z.literal("finding_not_found") }),
  z.strictObject({ code: z.literal("invalid_persisted_data") }),
  z.strictObject({ code: z.literal("storage_busy") }),
]);

export const FindingMutationErrorSchema = z.union([
  z.strictObject({ code: z.literal("invalid_request") }),
  z.strictObject({ code: z.literal("engagement_not_found") }),
  z.strictObject({ code: z.literal("finding_not_found") }),
  z.strictObject({ code: z.literal("engagement_archived") }),
  z.strictObject({ code: z.literal("invalid_finding_transition") }),
  z.strictObject({
    code: z.literal("revision_conflict"),
    resourceType: z.literal("finding"),
    resourceId: EngagementSchema.shape.id,
    currentRevision: z.number().int().safe().nonnegative(),
  }),
  z.strictObject({ code: z.literal("invalid_persisted_data") }),
  z.strictObject({ code: z.literal("storage_busy") }),
]);

export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;
export type FindingStatus = z.infer<typeof FindingStatusSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type CreateFindingRequest = z.infer<typeof CreateFindingRequestSchema>;
export type UpdateFindingRequest = z.infer<typeof UpdateFindingRequestSchema>;
export type FindingQueryError = z.infer<typeof FindingQueryErrorSchema>;
export type FindingMutationError = z.infer<typeof FindingMutationErrorSchema>;
