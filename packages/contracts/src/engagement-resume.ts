import { z } from "zod";

import { EngagementSchema } from "./engagement.js";

/**
 * STONE-6 engagement next-step and resume contracts.
 * One optional sentence per engagement, set while leaving, never blocking.
 * The factual change list underlies resume; AI summary stays out of scope.
 */

function hasCodePointLength(value: string, minimum: number, maximum: number): boolean {
  const length = Array.from(value).length;
  return length >= minimum && length <= maximum;
}

export const ENGAGEMENT_NEXT_STEP_MAX_CHARS = 280 as const;

/** One sentence, trimmed, single line, 1 to 280 Unicode code points. */
export const EngagementNextStepSchema = z
  .string()
  .refine((value) => value === value.trim(), {
    message: "must not have leading or trailing whitespace",
  })
  .refine((value) => value.includes("\n") === false && value.includes("\r") === false, {
    message: "must be a single line",
  })
  .refine((value) => hasCodePointLength(value, 1, ENGAGEMENT_NEXT_STEP_MAX_CHARS), {
    message: "must contain between 1 and 280 Unicode code points",
  });

export type EngagementNextStep = z.infer<typeof EngagementNextStepSchema>;

export const EngagementNextStepRecordSchema = z.strictObject({
  engagementId: EngagementSchema.shape.id,
  nextStep: EngagementNextStepSchema.nullable(),
  updatedAt: z.iso.datetime(),
  revision: z.number().int().safe().nonnegative(),
});

export type EngagementNextStepRecord = z.infer<typeof EngagementNextStepRecordSchema>;

/** Null clears the step; the key itself is required. Never a blocking form. */
export const UpdateEngagementNextStepRequestSchema = z.strictObject({
  nextStep: EngagementNextStepSchema.nullable(),
  expectedRevision: z.number().int().safe().nonnegative(),
});

export type UpdateEngagementNextStepRequest = z.infer<
  typeof UpdateEngagementNextStepRequestSchema
>;

export const EngagementResumeChangeKindSchema = z.enum([
  "note",
  "finding",
  "run",
  "service",
  "scope",
  "ffuf",
  "probe",
  "artifact",
]);

export type EngagementResumeChangeKind = z.infer<typeof EngagementResumeChangeKindSchema>;

/**
 * One factual change. `snapshot` is true when the record predates event
 * capture and is read as a point-in-time snapshot, never a timeline claim.
 */
export const EngagementResumeChangeSchema = z.strictObject({
  kind: EngagementResumeChangeKindSchema,
  id: z.string().min(1).max(255),
  at: z.iso.datetime(),
  summary: z.string().min(1).max(500),
  snapshot: z.boolean(),
});

export type EngagementResumeChange = z.infer<typeof EngagementResumeChangeSchema>;

export const EngagementResumeResponseSchema = z.strictObject({
  engagementId: EngagementSchema.shape.id,
  nextStep: EngagementNextStepSchema.nullable(),
  nextStepUpdatedAt: z.iso.datetime().nullable(),
  nextStepRevision: z.number().int().safe().nonnegative(),
  changes: z.array(EngagementResumeChangeSchema).max(200),
  complete: z.boolean(),
});

export type EngagementResumeResponse = z.infer<typeof EngagementResumeResponseSchema>;

export const EngagementResumeErrorSchema = z.union([
  z.strictObject({ code: z.literal("invalid_request") }),
  z.strictObject({ code: z.literal("engagement_not_found") }),
  z.strictObject({ code: z.literal("engagement_archived") }),
  z.strictObject({
    code: z.literal("revision_conflict"),
    resourceType: z.literal("engagement_next_step"),
    resourceId: EngagementSchema.shape.id,
    currentRevision: z.number().int().safe().nonnegative(),
  }),
  z.strictObject({ code: z.literal("invalid_persisted_data") }),
  z.strictObject({ code: z.literal("storage_busy") }),
]);

export type EngagementResumeError = z.infer<typeof EngagementResumeErrorSchema>;

/** Strict `since` parsing: only `since` is known; ISO datetime or absent. */
export function parseEngagementResumeQuery(
  query: unknown,
): { ok: true; value: { since?: string } } | { ok: false } {
  if (typeof query !== "object" || query === null || Array.isArray(query)) {
    return { ok: false };
  }
  const record = query as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "since") return { ok: false };
  }
  if (!("since" in record)) return { ok: true, value: {} };
  const raw = record["since"];
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 64) {
    return { ok: false };
  }
  if (!isStrictIsoDatetime(raw)) return { ok: false };
  return { ok: true, value: { since: raw } };
}

/**
 * ISO 8601 datetime with an explicit timezone, mirroring z.iso.datetime:
 * date-only and local-time values are rejected so the resume threshold is
 * always one unambiguous instant, never an implementation-defined parse.
 */
function isStrictIsoDatetime(value: string): boolean {
  if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/.test(value) === false
  ) {
    return false;
  }
  return Number.isNaN(Date.parse(value)) === false;
}
