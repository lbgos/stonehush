import { z } from "zod";

import { EngagementSchema } from "./engagement.js";

export const SECRET_CONTRACT_VERSION = 1 as const;

function hasCodePointLength(value: string, minimum: number, maximum: number): boolean {
  const length = Array.from(value).length;
  return length >= minimum && length <= maximum;
}

export const SecretVerificationResultSchema = z.enum(["verified", "failed"]);

export const SecretVerificationSchema = z.strictObject({
  at: z.iso.datetime(),
  result: SecretVerificationResultSchema,
  method: z
    .string()
    .refine((value) => value === value.trim(), {
      message: "must not have leading or trailing whitespace",
    })
    .refine((value) => hasCodePointLength(value, 1, 120), {
      message: "must contain between 1 and 120 Unicode code points",
    }),
  note: z
    .string()
    .refine((value) => hasCodePointLength(value, 1, 500), {
      message: "must contain between 1 and 500 Unicode code points",
    })
    .nullable(),
});

// Explicit sensitive records. A secret belongs to exactly one service:
// serviceRef scopes every verification, so a password proven for one service
// never marks another service tested. The plaintext value is never stored or
// returned; secretRef points at the operator's own vault or environment, and
// hint is a short masked reminder at most.
export const SecretLabelSchema = z
  .string()
  .refine((value) => value === value.trim(), {
    message: "must not have leading or trailing whitespace",
  })
  .refine((value) => hasCodePointLength(value, 1, 120), {
    message: "must contain between 1 and 120 Unicode code points",
  });

export const SecretServiceRefSchema = z
  .string()
  .refine((value) => value === value.trim(), {
    message: "must not have leading or trailing whitespace",
  })
  .refine((value) => hasCodePointLength(value, 1, 253), {
    message: "must contain between 1 and 253 Unicode code points",
  });

export const SecretSchema = z.strictObject({
  contractVersion: z.literal(SECRET_CONTRACT_VERSION),
  id: EngagementSchema.shape.id,
  engagementId: EngagementSchema.shape.id,
  label: SecretLabelSchema,
  username: z
    .string()
    .refine((value) => hasCodePointLength(value, 1, 253), {
      message: "must contain between 1 and 253 Unicode code points",
    })
    .nullable(),
  serviceRef: SecretServiceRefSchema,
  secretRef: SecretServiceRefSchema,
  hint: z
    .string()
    .refine((value) => hasCodePointLength(value, 1, 64), {
      message: "must contain between 1 and 64 Unicode code points",
    })
    .nullable(),
  verifications: z.array(SecretVerificationSchema).max(64),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const CreateSecretRequestSchema = z.strictObject({
  label: SecretLabelSchema,
  username: SecretSchema.shape.username.optional(),
  serviceRef: SecretServiceRefSchema,
  secretRef: SecretServiceRefSchema,
  hint: SecretSchema.shape.hint.optional(),
});

export const RecordSecretVerificationRequestSchema = z.strictObject({
  result: SecretVerificationResultSchema,
  method: SecretVerificationSchema.shape.method,
  note: SecretVerificationSchema.shape.note.optional(),
});

export const SecretIdParamsSchema = z.strictObject({
  engagementId: EngagementSchema.shape.id,
  secretId: EngagementSchema.shape.id,
});

export const SecretResponseSchema = SecretSchema;
export const SecretListResponseSchema = z.array(SecretSchema);

export const SecretQueryErrorSchema = z.union([
  z.strictObject({ code: z.literal("invalid_request") }),
  z.strictObject({ code: z.literal("engagement_not_found") }),
  z.strictObject({ code: z.literal("secret_not_found") }),
  z.strictObject({ code: z.literal("invalid_persisted_data") }),
  z.strictObject({ code: z.literal("storage_busy") }),
]);

export const SecretMutationErrorSchema = z.union([
  z.strictObject({ code: z.literal("invalid_request") }),
  z.strictObject({ code: z.literal("engagement_not_found") }),
  z.strictObject({ code: z.literal("secret_not_found") }),
  z.strictObject({ code: z.literal("engagement_archived") }),
  z.strictObject({ code: z.literal("invalid_persisted_data") }),
  z.strictObject({ code: z.literal("storage_busy") }),
]);

export type SecretVerificationResult = z.infer<typeof SecretVerificationResultSchema>;
export type SecretVerification = z.infer<typeof SecretVerificationSchema>;
export type Secret = z.infer<typeof SecretSchema>;
export type CreateSecretRequest = z.infer<typeof CreateSecretRequestSchema>;
export type RecordSecretVerificationRequest = z.infer<
  typeof RecordSecretVerificationRequestSchema
>;
export type SecretQueryError = z.infer<typeof SecretQueryErrorSchema>;
export type SecretMutationError = z.infer<typeof SecretMutationErrorSchema>;
