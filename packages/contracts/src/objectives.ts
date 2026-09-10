import { z } from "zod";

import { EngagementSchema } from "./engagement.js";

export const OBJECTIVE_CONTRACT_VERSION = 1 as const;
export const OBJECTIVE_PROOF_VALUE_MAX_CHARS = 4096 as const;

function hasCodePointLength(value: string, minimum: number, maximum: number): boolean {
  const length = Array.from(value).length;
  return length >= minimum && length <= maximum;
}

export const ObjectiveKindSchema = z.enum([
  "user_flag",
  "root_flag",
  "single_proof",
  "custom",
]);

// Captured and Submitted are distinct operator-recorded states. Captured
// means the proof was obtained; Submitted means the operator recorded its
// submission. Submission is never inferred. No scores are tracked.
export const ObjectiveStateSchema = z.enum(["open", "captured", "submitted"]);

export const ObjectiveNameSchema = z
  .string()
  .refine((value) => value === value.trim(), {
    message: "must not have leading or trailing whitespace",
  })
  .refine((value) => hasCodePointLength(value, 1, 120), {
    message: "must contain between 1 and 120 Unicode code points",
  });

const Sha256DigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, { message: "must be a sha256 digest" });

export const ObjectiveSchema = z.strictObject({
  contractVersion: z.literal(OBJECTIVE_CONTRACT_VERSION),
  id: EngagementSchema.shape.id,
  engagementId: EngagementSchema.shape.id,
  name: ObjectiveNameSchema,
  kind: ObjectiveKindSchema,
  state: ObjectiveStateSchema,
  // Proof values are never returned. Capture stores only a digest plus a
  // short masked hint; list and detail responses carry those, never the value.
  proofHint: z
    .string()
    .refine((value) => hasCodePointLength(value, 1, 64), {
      message: "must contain between 1 and 64 Unicode code points",
    })
    .nullable(),
  proofDigest: Sha256DigestSchema.nullable(),
  capturedAt: z.iso.datetime().nullable(),
  submittedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const CreateObjectiveRequestSchema = z.strictObject({
  name: ObjectiveNameSchema,
  kind: ObjectiveKindSchema,
});

// The raw proof value travels in this request only. It is hashed server-side
// and never persisted or echoed back.
export const CaptureObjectiveRequestSchema = z.strictObject({
  proofValue: z
    .string()
    .refine((value) => hasCodePointLength(value, 1, OBJECTIVE_PROOF_VALUE_MAX_CHARS), {
      message: "must contain between 1 and 4096 Unicode code points",
    }),
});

export const SubmitObjectiveRequestSchema = z.strictObject({});

export const ObjectiveIdParamsSchema = z.strictObject({
  engagementId: EngagementSchema.shape.id,
  objectiveId: EngagementSchema.shape.id,
});

export const ObjectiveResponseSchema = ObjectiveSchema;
export const ObjectiveListResponseSchema = z.array(ObjectiveSchema);

export const ObjectiveQueryErrorSchema = z.union([
  z.strictObject({ code: z.literal("invalid_request") }),
  z.strictObject({ code: z.literal("engagement_not_found") }),
  z.strictObject({ code: z.literal("objective_not_found") }),
  z.strictObject({ code: z.literal("invalid_persisted_data") }),
  z.strictObject({ code: z.literal("storage_busy") }),
]);

export const ObjectiveMutationErrorSchema = z.union([
  z.strictObject({ code: z.literal("invalid_request") }),
  z.strictObject({ code: z.literal("engagement_not_found") }),
  z.strictObject({ code: z.literal("objective_not_found") }),
  z.strictObject({ code: z.literal("engagement_archived") }),
  z.strictObject({ code: z.literal("invalid_objective_transition") }),
  z.strictObject({ code: z.literal("invalid_persisted_data") }),
  z.strictObject({ code: z.literal("storage_busy") }),
]);

export type ObjectiveKind = z.infer<typeof ObjectiveKindSchema>;
export type ObjectiveState = z.infer<typeof ObjectiveStateSchema>;
export type Objective = z.infer<typeof ObjectiveSchema>;
export type CreateObjectiveRequest = z.infer<typeof CreateObjectiveRequestSchema>;
export type CaptureObjectiveRequest = z.infer<typeof CaptureObjectiveRequestSchema>;
export type SubmitObjectiveRequest = z.infer<typeof SubmitObjectiveRequestSchema>;
export type ObjectiveQueryError = z.infer<typeof ObjectiveQueryErrorSchema>;
export type ObjectiveMutationError = z.infer<typeof ObjectiveMutationErrorSchema>;
