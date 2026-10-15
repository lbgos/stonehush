import { z } from "zod";

import {
  CanonicalHostnameSchema,
  CanonicalIpTargetSchema,
  CanonicalIpv4AddressSchema,
  CanonicalIpv6AddressSchema,
  CanonicalTargetSchema,
  CanonicalUrlTargetSchema,
  NormalizationProfileSchema,
} from "./target-normalization.js";

export const ACTION_ORCHESTRATION_PROFILE = "d2-v1" as const;

const IdentifierSchema = z.string().min(1).max(255);
const TimestampSchema = z.iso.datetime({ offset: true });

// Domain and D1 warning-flow fixtures keep this opaque textual binding shape.
// Persisted bindings must be action-snapshot-json-v1 SHA-256 digests.
export const ActionSnapshotBindingSchema = z
  .string()
  .min("sha256:x".length)
  .max(262)
  .regex(/^sha256:[A-Za-z0-9._-]+$/);

export const ResolutionAnswerSchema = z
  .strictObject({
    address: z.union([CanonicalIpv4AddressSchema, CanonicalIpv6AddressSchema]),
    family: z.union([z.literal(4), z.literal(6)]),
    ttlSeconds: z.number().int().nonnegative().nullable(),
  })
  .superRefine((answer, context) => {
    const addressFamily = answer.address.includes(":") ? 6 : 4;
    if (addressFamily !== answer.family) {
      context.addIssue({ code: "custom", message: "address family mismatch" });
    }
  });

export const ResolutionSnapshotSchema = z.strictObject({
  canonicalQueryName: CanonicalHostnameSchema,
  resolverMode: z.enum(["system"]),
  cnameChain: z.array(CanonicalHostnameSchema),
  answers: z.array(ResolutionAnswerSchema),
  resolvedAt: TimestampSchema,
});

export const WarningReasonCodeSchema = z.enum([
  "outside_scope",
  "large_target_set",
  "risk_tier_t0",
  "risk_tier_t1",
  "risk_tier_t2",
  "risk_tier_t3",
  "risk_tier_t4",
]);

const UniqueWarningReasonsSchema = z
  .array(WarningReasonCodeSchema)
  .superRefine((reasons, context) => {
    if (new Set(reasons).size !== reasons.length) {
      context.addIssue({ code: "custom", message: "duplicate warning reason" });
    }
  });

export const WarningContextAdditionSchema = z.union([
  z.strictObject({
    hostname: CanonicalHostnameSchema,
    address: z.union([CanonicalIpv4AddressSchema, CanonicalIpv6AddressSchema]),
  }),
  z.strictObject({
    origin: CanonicalUrlTargetSchema.shape.origin,
    resolvedAddress: z.union([
      CanonicalIpv4AddressSchema,
      CanonicalIpv6AddressSchema,
    ]),
  }),
  z.strictObject({ estimatedConcreteTargets: z.literal(4_097) }),
]);

export const WarningAcknowledgmentSourceSchema = z.enum([
  "operator_continue",
  "add_scope_and_run",
  "engagement_policy",
]);

export const WarningAcknowledgmentSchema = z.strictObject({
  actionId: IdentifierSchema,
  snapshotId: IdentifierSchema,
  snapshotVersion: z.number().int().positive(),
  snapshotBinding: ActionSnapshotBindingSchema,
  scopeRevisionId: IdentifierSchema.nullable(),
  reasonCodes: UniqueWarningReasonsSchema,
  knownAdditions: z.array(WarningContextAdditionSchema),
  source: WarningAcknowledgmentSourceSchema,
  acknowledgedAt: TimestampSchema,
  pendingEventId: z.number().int().positive().nullable(),
  coveredDestinations: z.array(WarningContextAdditionSchema),
});

const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const TypedActionOptionsSchema = z.record(z.string(), JsonValueSchema);

export const ActionSnapshotSchema = z.strictObject({
  normalizationProfile: NormalizationProfileSchema,
  orchestrationProfile: z.literal(ACTION_ORCHESTRATION_PROFILE),
  snapshotId: IdentifierSchema,
  version: z.number().int().positive(),
  binding: ActionSnapshotBindingSchema,
  actionId: IdentifierSchema,
  canonicalTargets: z.array(CanonicalTargetSchema).min(1),
  concreteDestinations: z.array(CanonicalIpTargetSchema),
  typedOptions: TypedActionOptionsSchema,
  resolutionSnapshots: z.array(ResolutionSnapshotSchema),
  scopeRevisionId: IdentifierSchema.nullable(),
  warningState: z.strictObject({
    reasonCodes: UniqueWarningReasonsSchema,
    knownAdditions: z.array(WarningContextAdditionSchema),
    acknowledgment: z.null(),
  }),
});

export const ActionStateSchema = z.enum([
  "planning",
  "paused_for_warning",
  "queued",
  "active",
  "active_paused_for_warning",
  "succeeded",
  "failed",
  "cancelled",
  "capability_error",
]);

export const PlanningRunStateSchema = z.enum(["running", "cancel_requested"]);

export const PendingWarningSchema = z.strictObject({
  reasonCodes: UniqueWarningReasonsSchema.min(1),
  knownAdditions: z.array(WarningContextAdditionSchema),
  pendingEventId: z.number().int().positive().nullable(),
});

export const ActionPlanningAggregateSchema = z
  .strictObject({
    orchestrationProfile: z.literal(ACTION_ORCHESTRATION_PROFILE),
    actionId: IdentifierSchema,
    state: ActionStateSchema,
    snapshots: z.array(ActionSnapshotSchema).min(1),
    queuedSnapshotVersion: z.number().int().positive().nullable(),
    warningAcknowledgment: WarningAcknowledgmentSchema.nullable(),
    pendingWarning: PendingWarningSchema.nullable(),
    coveredDestinations: z.array(WarningContextAdditionSchema),
    warningInteractions: z.number().int().min(0).max(1),
    runState: PlanningRunStateSchema.nullable(),
    resumeRequested: z.boolean(),
    cleanupRequired: z.boolean(),
    capabilityErrorCode: z
      .enum([
        "capability_error",
        "required_resolution_unavailable",
        "target_set_unrepresentable",
      ])
      .nullable(),
  })
  .superRefine((action, context) => {
    const versions = action.snapshots.map(({ version }) => version);
    if (new Set(versions).size !== versions.length) {
      context.addIssue({ code: "custom", message: "duplicate snapshot version" });
    }
    if (action.snapshots.some((snapshot) => snapshot.actionId !== action.actionId)) {
      context.addIssue({ code: "custom", message: "snapshot action mismatch" });
    }
    if (
      action.queuedSnapshotVersion !== null &&
      !versions.includes(action.queuedSnapshotVersion)
    ) {
      context.addIssue({ code: "custom", message: "unknown queued snapshot" });
    }
    if (
      [
        "queued",
        "active",
        "active_paused_for_warning",
        "succeeded",
        "failed",
      ].includes(action.state) &&
      action.queuedSnapshotVersion === null
    ) {
      context.addIssue({ code: "custom", message: "missing queued snapshot" });
    }
    if (
      ["planning", "paused_for_warning", "capability_error"].includes(
        action.state,
      ) &&
      action.queuedSnapshotVersion !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "unexpected queued snapshot",
      });
    }
    const acknowledgment = action.warningAcknowledgment;
    if (acknowledgment !== null) {
      const acknowledgedSnapshot = action.snapshots.find(
        ({ version }) => version === acknowledgment.snapshotVersion,
      );
      if (
        acknowledgment.actionId !== action.actionId ||
        acknowledgedSnapshot === undefined ||
        acknowledgedSnapshot.snapshotId !== acknowledgment.snapshotId ||
        acknowledgedSnapshot.binding !== acknowledgment.snapshotBinding ||
        acknowledgedSnapshot.scopeRevisionId !== acknowledgment.scopeRevisionId
      ) {
        context.addIssue({
          code: "custom",
          message: "warning acknowledgment snapshot mismatch",
        });
      }
      if (
        action.queuedSnapshotVersion !== null &&
        acknowledgment.snapshotVersion !== action.queuedSnapshotVersion
      ) {
        context.addIssue({
          code: "custom",
          message: "acknowledgment does not bind queued snapshot",
        });
      }
      if (action.pendingWarning !== null) {
        context.addIssue({
          code: "custom",
          message: "acknowledged action cannot have a pending warning",
        });
      }
    }
    if (
      action.state === "capability_error" &&
      (action.capabilityErrorCode === null ||
        action.queuedSnapshotVersion !== null)
    ) {
      context.addIssue({ code: "custom", message: "invalid capability state" });
    }
    if (
      action.state !== "capability_error" &&
      action.capabilityErrorCode !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "capability error outside capability state",
      });
    }
    if (
      action.state === "paused_for_warning" &&
      (action.pendingWarning === null ||
        action.pendingWarning.pendingEventId !== null)
    ) {
      context.addIssue({ code: "custom", message: "invalid planning warning" });
    }
    if (
      action.state === "active_paused_for_warning" &&
      (action.pendingWarning === null ||
        action.pendingWarning.pendingEventId === null ||
        action.runState === null)
    ) {
      context.addIssue({ code: "custom", message: "invalid active warning" });
    }
    if (
      action.state !== "paused_for_warning" &&
      action.state !== "active_paused_for_warning" &&
      action.pendingWarning !== null
    ) {
      context.addIssue({ code: "custom", message: "unexpected pending warning" });
    }
    if (
      (action.state === "active" ||
        action.state === "active_paused_for_warning") !==
      (action.runState !== null)
    ) {
      context.addIssue({ code: "custom", message: "invalid planning run state" });
    }
    if (
      action.cleanupRequired !==
      ((action.state === "active" || action.state === "active_paused_for_warning") &&
        action.runState === "cancel_requested")
    ) {
      context.addIssue({ code: "custom", message: "invalid cleanup state" });
    }
    if (
      action.resumeRequested &&
      (action.state !== "active" || action.runState !== "running")
    ) {
      context.addIssue({ code: "custom", message: "invalid resume state" });
    }
  });

export const ActionPlanningErrorSchema = z.strictObject({
  code: z.enum([
    "action_already_queued",
    "capability_error_not_overridable",
    "invalid_action_planning_input",
    "invalid_action_transition",
    "invalid_run_transition",
    "run_not_retryable",
    "snapshot_binding_mismatch",
  ]),
});

export const ActionPlanningResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    action: ActionPlanningAggregateSchema,
  }),
  z.strictObject({
    ok: z.literal(false),
    error: ActionPlanningErrorSchema,
  }),
]);

export const ResolutionSnapshotInputSchema = z.strictObject({
  canonicalQueryName: CanonicalHostnameSchema,
  resolverResult: z.strictObject({
    resolverMode: z.enum(["system"]),
    cnameChain: z.array(CanonicalHostnameSchema),
    answers: z.array(ResolutionAnswerSchema),
    resolvedAt: TimestampSchema,
  }),
  actionRequiresConcreteAddresses: z.boolean(),
});

export const ResolutionSnapshotResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), snapshot: ResolutionSnapshotSchema }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({
      code: z.enum([
        "invalid_action_planning_input",
        "required_resolution_unavailable",
      ]),
    }),
  }),
]);

export const PlanActionInputSchema = z.strictObject({
  snapshot: ActionSnapshotSchema,
  engagementAutoContinue: z.boolean(),
  representable: z.boolean(),
  capabilityErrorCode: z
    .enum([
      "capability_error",
      "required_resolution_unavailable",
      "target_set_unrepresentable",
    ])
    .nullable(),
  occurredAt: TimestampSchema,
});

export const ContinueActionInputSchema = z.strictObject({
  action: ActionPlanningAggregateSchema,
  snapshotVersion: z.number().int().positive(),
  snapshotBinding: ActionSnapshotBindingSchema,
  occurredAt: TimestampSchema,
});

export const AddScopeAndRunInputSchema = z.strictObject({
  action: ActionPlanningAggregateSchema,
  recheckedSnapshot: ActionSnapshotSchema,
  occurredAt: TimestampSchema,
});

export const LateWarningInputSchema = z.strictObject({
  action: ActionPlanningAggregateSchema,
  runState: z.literal("running"),
  snapshotVersion: z.number().int().positive(),
  snapshotBinding: ActionSnapshotBindingSchema,
  reasonCodes: UniqueWarningReasonsSchema.min(1),
  addition: WarningContextAdditionSchema,
  pendingEventId: z.number().int().positive(),
  engagementAutoContinue: z.boolean(),
  occurredAt: TimestampSchema,
});

export const ContinueLateWarningInputSchema = z.strictObject({
  action: ActionPlanningAggregateSchema,
  snapshotVersion: z.number().int().positive(),
  snapshotBinding: ActionSnapshotBindingSchema,
  pendingEventId: z.number().int().positive(),
  occurredAt: TimestampSchema,
});

export const ActionCommandInputSchema = z.strictObject({
  action: ActionPlanningAggregateSchema,
});

export const RetryActionContextInputSchema = z.strictObject({
  action: ActionPlanningAggregateSchema,
  warningAcknowledgmentId: IdentifierSchema.nullable(),
});

export const RetryActionContextSchema = z.strictObject({
  actionId: IdentifierSchema,
  snapshotId: IdentifierSchema,
  snapshotVersion: z.number().int().positive(),
  snapshotBinding: ActionSnapshotBindingSchema,
  warningAcknowledgment: WarningAcknowledgmentSchema.nullable(),
  warningAcknowledgmentId: IdentifierSchema.nullable(),
  resolutionRefreshed: z.literal(false),
  newWarningBudget: z.literal(false),
});

export const RetryActionContextResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), context: RetryActionContextSchema }),
  z.strictObject({
    ok: z.literal(false),
    error: ActionPlanningErrorSchema,
  }),
]);

export type ResolutionSnapshot = z.infer<typeof ResolutionSnapshotSchema>;
export type WarningReasonCode = z.infer<typeof WarningReasonCodeSchema>;
export type WarningContextAddition = z.infer<
  typeof WarningContextAdditionSchema
>;
export type WarningAcknowledgmentSource = z.infer<
  typeof WarningAcknowledgmentSourceSchema
>;
export type WarningAcknowledgment = z.infer<
  typeof WarningAcknowledgmentSchema
>;
export type ActionSnapshot = z.infer<typeof ActionSnapshotSchema>;
export type ActionState = z.infer<typeof ActionStateSchema>;
export type PlanningRunState = z.infer<typeof PlanningRunStateSchema>;
export type PendingWarning = z.infer<typeof PendingWarningSchema>;
export type ActionPlanningAggregate = z.infer<
  typeof ActionPlanningAggregateSchema
>;
export type ActionPlanningError = z.infer<typeof ActionPlanningErrorSchema>;
export type ActionPlanningResult = z.infer<typeof ActionPlanningResultSchema>;
export type ResolutionSnapshotResult = z.infer<
  typeof ResolutionSnapshotResultSchema
>;
export type RetryActionContext = z.infer<typeof RetryActionContextSchema>;
export type RetryActionContextResult = z.infer<
  typeof RetryActionContextResultSchema
>;
