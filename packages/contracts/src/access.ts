import { z } from "zod";

import { EngagementSchema } from "./engagement.js";

export const ACCESS_CONTRACT_VERSION = 1 as const;
export const ACCESS_ACCOUNT_MAX_CHARS = 120 as const;
export const ACCESS_CONTEXT_MAX_CHARS = 500 as const;

function hasCodePointLength(value: string, minimum: number, maximum: number): boolean {
  const length = Array.from(value).length;
  return length >= minimum && length <= maximum;
}

// The access type names the recorded mechanism, never a live connection
// state. A manually recorded session is not proof of a live shell.
export const AccessTypeSchema = z.enum([
  "ssh",
  "web_session",
  "database",
  "shell",
  "other",
]);

export const ACCESS_TYPE_LABELS: Record<z.infer<typeof AccessTypeSchema>, string> = {
  ssh: "SSH",
  web_session: "web session",
  database: "database",
  shell: "shell",
  other: "other",
};

// Recorded wording, never a connection indicator: "Recorded SSH access".
export function formatAccessRecordLabel(accessType: z.infer<typeof AccessTypeSchema>): string {
  return `Recorded ${ACCESS_TYPE_LABELS[accessType]} access`;
}

export const AccessAccountSchema = z
  .string()
  .refine((value) => value === value.trim(), {
    message: "must not have leading or trailing whitespace",
  })
  .refine((value) => hasCodePointLength(value, 1, ACCESS_ACCOUNT_MAX_CHARS), {
    message: "must contain between 1 and 120 Unicode code points",
  });

export const AccessContextNoteSchema = z
  .string()
  .refine((value) => value === value.trim(), {
    message: "must not have leading or trailing whitespace",
  })
  .refine((value) => hasCodePointLength(value, 1, ACCESS_CONTEXT_MAX_CHARS), {
    message: "must contain between 1 and 500 Unicode code points",
  });

// An access record answers target, account, access type, source lead, and
// last confirmed. Secrets travel by id only: there is no value field, so no
// view, search index, export, or copied command built from this record can
// carry a secret value.
export const AccessRecordSchema = z.strictObject({
  contractVersion: z.literal(ACCESS_CONTRACT_VERSION),
  id: EngagementSchema.shape.id,
  engagementId: EngagementSchema.shape.id,
  targetId: EngagementSchema.shape.id,
  account: AccessAccountSchema,
  accessType: AccessTypeSchema,
  sourceLeadId: EngagementSchema.shape.id,
  secretId: EngagementSchema.shape.id.nullable(),
  context: AccessContextNoteSchema.nullable(),
  lastConfirmedAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const CreateAccessRequestSchema = z.strictObject({
  targetId: EngagementSchema.shape.id,
  account: AccessAccountSchema,
  accessType: AccessTypeSchema,
  sourceLeadId: EngagementSchema.shape.id,
  secretId: EngagementSchema.shape.id.optional(),
  context: AccessContextNoteSchema.optional(),
});

export const AccessIdParamsSchema = z.strictObject({
  engagementId: EngagementSchema.shape.id,
  accessId: EngagementSchema.shape.id,
});

export const AccessResponseSchema = AccessRecordSchema;
export const AccessListResponseSchema = z.array(AccessRecordSchema);

export const AccessQueryErrorSchema = z.union([
  z.strictObject({ code: z.literal("invalid_request") }),
  z.strictObject({ code: z.literal("engagement_not_found") }),
  z.strictObject({ code: z.literal("access_not_found") }),
  z.strictObject({ code: z.literal("invalid_persisted_data") }),
  z.strictObject({ code: z.literal("storage_busy") }),
]);

export const AccessMutationErrorSchema = z.union([
  z.strictObject({ code: z.literal("invalid_request") }),
  z.strictObject({ code: z.literal("engagement_not_found") }),
  z.strictObject({ code: z.literal("access_not_found") }),
  z.strictObject({ code: z.literal("target_not_found") }),
  z.strictObject({ code: z.literal("lead_not_found") }),
  z.strictObject({ code: z.literal("secret_not_found") }),
  z.strictObject({ code: z.literal("engagement_archived") }),
  z.strictObject({ code: z.literal("invalid_persisted_data") }),
  z.strictObject({ code: z.literal("storage_busy") }),
]);

export type AccessType = z.infer<typeof AccessTypeSchema>;
export type AccessRecord = z.infer<typeof AccessRecordSchema>;
export type CreateAccessRequest = z.infer<typeof CreateAccessRequestSchema>;
export type AccessQueryError = z.infer<typeof AccessQueryErrorSchema>;
export type AccessMutationError = z.infer<typeof AccessMutationErrorSchema>;
