import { z } from "zod";

import { EngagementSchema } from "./engagement.js";

/**
 * Local secret scan over captured engagement evidence with gitleaks.
 * Risk tier T0, read-only: it only reads evidence bytes already in the
 * workspace and never touches live targets.
 *
 * Redaction boundary, stated plainly because it is the whole point of this
 * slice: gitleaks reports candidate secret VALUES (Secret, Match). Those
 * values are dropped at the parse boundary and must never reach the
 * database, API responses, UI, advisor context, logs, or exports. A stored
 * match carries the rule id, file, and line plus a SHA-256 fingerprint used
 * only to dedupe identical hits across rescans. The fingerprint is a dedupe
 * handle, not a secret, and it cannot reveal the value on its own.
 */

export const GITLEAKS_PARSER_VERSION = "gitleaks-json-v1" as const;
export const GITLEAKS_DEFAULT_EXECUTABLE = "/usr/bin/gitleaks" as const;
/** Guard against unbounded detector output; evidence scales with captures. */
export const GITLEAKS_MAX_JSON_BYTES = 8 * 1024 * 1024;
export const GITLEAKS_MAX_FINDINGS = 5_000;
/** Wall-clock ceiling for one local evidence scan. */
export const GITLEAKS_SCAN_TIMEOUT_MS = 120_000;

export const GitleaksRuleIdSchema = z.string().min(1).max(128);

export const GitleaksFileSchema = z.string().min(1).max(1024);

export const GitleaksFingerprintSchema = z.string().regex(/^[0-9a-f]{16}$/);

/**
 * One redacted gitleaks hit. There is deliberately no Secret, Match, or
 * value field: unknown keys are rejected, so a parser that forgets to drop
 * a value fails validation instead of persisting it.
 */
export const GitleaksMatchSchema = z.strictObject({
  ruleId: GitleaksRuleIdSchema,
  file: GitleaksFileSchema,
  line: z.number().int().min(0).max(2_147_483_647),
  fingerprint: GitleaksFingerprintSchema,
});

export type GitleaksMatch = z.infer<typeof GitleaksMatchSchema>;

export const GitleaksScanRequestSchema = z.strictObject({});

export type GitleaksScanRequest = z.infer<typeof GitleaksScanRequestSchema>;

export const GitleaksScanResponseSchema = z.strictObject({
  scanId: EngagementSchema.shape.id,
  engagementId: EngagementSchema.shape.id,
  scannedAt: z.iso.datetime({ offset: true }),
  matchCount: z.number().int().min(0),
  truncated: z.boolean(),
  matches: z.array(GitleaksMatchSchema).max(GITLEAKS_MAX_FINDINGS),
});

export type GitleaksScanResponse = z.infer<typeof GitleaksScanResponseSchema>;

export const GitleaksMatchesResponseSchema = z.array(GitleaksMatchSchema);

export type GitleaksMatchesResponse = z.infer<typeof GitleaksMatchesResponseSchema>;

export const GitleaksErrorCodeSchema = z.enum([
  "invalid_request",
  "engagement_not_found",
  "engagement_archived",
  "gitleaks_missing",
  "gitleaks_failed",
  "gitleaks_output_too_large",
  "evidence_too_large",
  "storage_busy",
  "invalid_persisted_data",
]);

export type GitleaksErrorCode = z.infer<typeof GitleaksErrorCodeSchema>;

export const GitleaksErrorSchema = z.strictObject({
  code: GitleaksErrorCodeSchema,
});

export type GitleaksError = z.infer<typeof GitleaksErrorSchema>;

export const EngagementGitleaksParamsSchema = z.strictObject({
  engagementId: EngagementSchema.shape.id,
});

export type EngagementGitleaksParams = z.infer<
  typeof EngagementGitleaksParamsSchema
>;
