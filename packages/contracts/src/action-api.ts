import { z } from "zod";

import {
  ActionSnapshotBindingSchema,
  RetryActionContextSchema,
} from "./action-planning.js";
import { PersistedActionSchema } from "./action-persistence.js";
import { EngagementSchema } from "./engagement.js";
import { DeclaredPortsSchema, SavedScopeRuleSchema } from "./saved-scope.js";

export const RAW_ACTION_TARGET_MAX_UTF8_BYTES = 4_096;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export const ActionIdParamsSchema = z.strictObject({
  engagementId: EngagementSchema.shape.id,
  actionId: EngagementSchema.shape.id,
});

export const ActionMutationQuerySchema = z.strictObject({});

export const RawActionTargetSchema = z
  .string()
  .refine((value) => utf8ByteLength(value) <= RAW_ACTION_TARGET_MAX_UTF8_BYTES);

export const CreateActionRequestSchema = z.strictObject({
  expectedEngagementRevision: z.number().int().positive(),
  expectedActiveScopeRevisionId: EngagementSchema.shape.id.nullable(),
  targets: z
    .array(RawActionTargetSchema)
    .min(1)
    .superRefine((targets, context) => {
      if (new Set(targets).size !== targets.length) {
        context.addIssue({ code: "custom", message: "duplicate target" });
      }
    }),
  declaredPorts: DeclaredPortsSchema.optional().default(null),
});

export const ContinueActionRequestSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  snapshotVersion: z.number().int().positive(),
  snapshotBinding: ActionSnapshotBindingSchema,
});

export const ContinueLateWarningActionRequestSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  snapshotVersion: z.number().int().positive(),
  snapshotBinding: ActionSnapshotBindingSchema,
  pendingEventId: z.number().int().positive(),
});

export const AddScopeAndRunActionRequestSchema = z.strictObject({
  expectedEngagementRevision: z.number().int().positive(),
  expectedActionRevision: z.number().int().positive(),
  rules: z.array(SavedScopeRuleSchema),
});

export const CancelActionRequestSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
});

export const ActionResponseSchema = PersistedActionSchema;
export const ActionRetryContextResponseSchema = RetryActionContextSchema;

const ActionRevisionConflictSchema = z.strictObject({
  code: z.literal("revision_conflict"),
  resourceType: z.enum(["engagement", "action"]),
  resourceId: EngagementSchema.shape.id,
  currentRevision: z.number().int().positive(),
});

export const ActionMutationErrorSchema = z.union([
  z.strictObject({ code: z.literal("invalid_request") }),
  z.strictObject({ code: z.literal("invalid_ffuf_action_contract") }),
  z.strictObject({ code: z.literal("engagement_not_found") }),
  z.strictObject({ code: z.literal("action_not_found") }),
  z.strictObject({ code: z.literal("engagement_archived") }),
  z.strictObject({ code: z.literal("invalid_action_transition") }),
  z.strictObject({ code: z.literal("action_already_queued") }),
  z.strictObject({ code: z.literal("capability_error_not_overridable") }),
  z.strictObject({ code: z.literal("snapshot_binding_mismatch") }),
  z.strictObject({ code: z.literal("invalid_run_transition") }),
  z.strictObject({ code: z.literal("run_not_retryable") }),
  z.strictObject({ code: z.literal("idempotency_conflict") }),
  ActionRevisionConflictSchema,
  z.strictObject({ code: z.literal("invalid_persisted_data") }),
  z.strictObject({ code: z.literal("storage_busy") }),
]);

export const ActionQueryErrorSchema = z.union([
  z.strictObject({ code: z.literal("invalid_request") }),
  z.strictObject({ code: z.literal("engagement_not_found") }),
  z.strictObject({ code: z.literal("action_not_found") }),
  z.strictObject({ code: z.literal("invalid_action_transition") }),
  z.strictObject({ code: z.literal("run_not_retryable") }),
  z.strictObject({ code: z.literal("invalid_persisted_data") }),
  z.strictObject({ code: z.literal("storage_busy") }),
]);

export type ActionIdParams = z.infer<typeof ActionIdParamsSchema>;
export type CreateActionRequest = z.infer<typeof CreateActionRequestSchema>;
export type CreateActionRequestInput = z.input<typeof CreateActionRequestSchema>;
export type ContinueActionRequest = z.infer<typeof ContinueActionRequestSchema>;
export type ContinueLateWarningActionRequest = z.infer<
  typeof ContinueLateWarningActionRequestSchema
>;
export type AddScopeAndRunActionRequest = z.infer<
  typeof AddScopeAndRunActionRequestSchema
>;
export type CancelActionRequest = z.infer<typeof CancelActionRequestSchema>;
export type ActionResponse = z.infer<typeof ActionResponseSchema>;
export type ActionRetryContextResponse = z.infer<
  typeof ActionRetryContextResponseSchema
>;
export type ActionMutationError = z.infer<typeof ActionMutationErrorSchema>;
export type ActionQueryError = z.infer<typeof ActionQueryErrorSchema>;
