import { z } from "zod";

import { EngagementSchema } from "./engagement.js";

export const LEAD_CONTRACT_VERSION = 1 as const;
export const LEAD_EVIDENCE_REFS_MAX = 32 as const;
export const LEAD_PARK_REASON_MAX_CHARS = 500 as const;
export const LEAD_NOTE_MAX_CHARS = 500 as const;
export const LEAD_NEXT_STEP_MAX_CHARS = 500 as const;
export const LEAD_ATTEMPT_SUMMARY_MAX_CHARS = 2000 as const;
export const LEAD_CONDITIONS_MAX_CHARS = 500 as const;
export const LEAD_SOURCE_REF_MAX_CHARS = 2048 as const;

function hasCodePointLength(value: string, minimum: number, maximum: number): boolean {
  const length = Array.from(value).length;
  return length >= minimum && length <= maximum;
}

export const LeadDispositionSchema = z.enum(["open", "parked", "closed"]);

// Attempt outcomes separate tool completion from hypothesis verdicts: a
// finished tool run is never by itself proof that the idea was correct.
export const AttemptOutcomeSchema = z.enum([
  "observed",
  "ruled_out",
  "inconclusive",
  "interrupted",
]);

export const LeadSourceKindSchema = z.enum([
  "nmap_service",
  "http_probe",
  "ffuf_result",
  "run_output",
  "manual",
]);

export const LeadSourceSchema = z.strictObject({
  kind: LeadSourceKindSchema,
  // Opaque reference to the source evidence (artifact id, service key, or
  // free-form manual origin). Kept opaque so leads never depend on another
  // slice's storage layout.
  ref: z
    .string()
    .refine((value) => hasCodePointLength(value, 1, LEAD_SOURCE_REF_MAX_CHARS), {
      message: "must contain between 1 and 2048 Unicode code points",
    }),
  label: z
    .string()
    .refine((value) => hasCodePointLength(value, 1, 120), {
      message: "must contain between 1 and 120 Unicode code points",
    })
    .optional(),
});

export const LeadTitleSchema = z
  .string()
  .refine((value) => value === value.trim(), {
    message: "must not have leading or trailing whitespace",
  })
  .refine((value) => hasCodePointLength(value, 1, 120), {
    message: "must contain between 1 and 120 Unicode code points",
  });

export const LeadTargetSchema = z
  .string()
  .refine((value) => value === value.trim(), {
    message: "must not have leading or trailing whitespace",
  })
  .refine((value) => hasCodePointLength(value, 1, 253), {
    message: "must contain between 1 and 253 Unicode code points",
  });

export const LeadParkReasonSchema = z
  .string()
  .refine((value) => value === value.trim(), {
    message: "must not have leading or trailing whitespace",
  })
  .refine((value) => hasCodePointLength(value, 1, LEAD_PARK_REASON_MAX_CHARS), {
    message: "must contain between 1 and 500 Unicode code points",
  });

// Tested conditions preserved on a parked lead, for example "Only checked
// without authentication". Used to suppress identical anonymous re-suggestions.
export const LeadConditionsSchema = z
  .string()
  .refine((value) => value === value.trim(), {
    message: "must not have leading or trailing whitespace",
  })
  .refine((value) => hasCodePointLength(value, 1, LEAD_CONDITIONS_MAX_CHARS), {
    message: "must contain between 1 and 500 Unicode code points",
  });

export const RevisitTriggerSchema = z.enum([
  "new_access",
  "hostname_change",
  "service_change",
]);

// Exactly one quiet revisit suggestion per parked lead. It carries a reason,
// never reopens the lead, and is dismissed explicitly.
export const LeadRevisitSuggestionSchema = z.strictObject({
  trigger: RevisitTriggerSchema,
  reason: LeadParkReasonSchema,
  createdAt: z.iso.datetime(),
  dismissed: z.boolean(),
});

export const LeadEvidenceArtifactIdSchema = z
  .string()
  .min(1)
  .max(127)
  .regex(/^[a-z0-9][a-z0-9-]*$/, {
    message: "must be a managed artifact id",
  });

export const LeadEvidenceRefsSchema = z
  .array(LeadEvidenceArtifactIdSchema)
  .max(LEAD_EVIDENCE_REFS_MAX);

export const LeadSchema = z.strictObject({
  contractVersion: z.literal(LEAD_CONTRACT_VERSION),
  id: EngagementSchema.shape.id,
  engagementId: EngagementSchema.shape.id,
  title: LeadTitleSchema,
  target: LeadTargetSchema.nullable(),
  serviceRef: LeadTargetSchema.nullable(),
  source: LeadSourceSchema,
  nextStep: z
    .string()
    .refine((value) => hasCodePointLength(value, 1, LEAD_NEXT_STEP_MAX_CHARS), {
      message: "must contain between 1 and 500 Unicode code points",
    })
    .nullable(),
  disposition: LeadDispositionSchema,
  parkReason: LeadParkReasonSchema.nullable(),
  testedConditions: LeadConditionsSchema.nullable(),
  closedNote: LeadParkReasonSchema.nullable(),
  revisitSuggestion: LeadRevisitSuggestionSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const LeadAttemptSchema = z.strictObject({
  contractVersion: z.literal(LEAD_CONTRACT_VERSION),
  id: EngagementSchema.shape.id,
  engagementId: EngagementSchema.shape.id,
  leadId: EngagementSchema.shape.id,
  sequence: z.number().int().positive(),
  summary: z
    .string()
    .refine((value) => value === value.trim(), {
      message: "must not have leading or trailing whitespace",
    })
    .refine((value) => hasCodePointLength(value, 1, LEAD_ATTEMPT_SUMMARY_MAX_CHARS), {
      message: "must contain between 1 and 2000 Unicode code points",
    }),
  outcome: AttemptOutcomeSchema,
  conditions: LeadConditionsSchema.nullable(),
  evidenceArtifactIds: LeadEvidenceRefsSchema,
  linkedFindingId: EngagementSchema.shape.id.nullable(),
  linkedObjectiveId: EngagementSchema.shape.id.nullable(),
  createdAt: z.iso.datetime(),
});

// Bookmark-effort creation: title plus source evidence. No severity is asked;
// strict parsing rejects severity and any other task-management ceremony.
export const CreateLeadRequestSchema = z.strictObject({
  title: LeadTitleSchema,
  target: LeadTargetSchema.optional(),
  serviceRef: LeadTargetSchema.optional(),
  source: LeadSourceSchema,
  nextStep: z
    .string()
    .refine((value) => hasCodePointLength(value, 1, LEAD_NEXT_STEP_MAX_CHARS), {
      message: "must contain between 1 and 500 Unicode code points",
    })
    .optional(),
});

export const ParkLeadRequestSchema = z.strictObject({
  reason: LeadParkReasonSchema,
  testedConditions: LeadConditionsSchema.optional(),
});

export const CloseLeadRequestSchema = z.strictObject({
  note: LeadParkReasonSchema.optional(),
});

export const SuggestLeadRevisitRequestSchema = z.strictObject({
  trigger: RevisitTriggerSchema,
  reason: LeadParkReasonSchema,
  // True when the newly available check runs under the same anonymous
  // conditions the parked lead already tested. Identical anonymous checks are
  // suppressed, never re-suggested.
  anonymous: z.boolean(),
  conditions: LeadConditionsSchema.optional(),
});

export const CreateLeadAttemptRequestSchema = z.strictObject({
  summary: LeadAttemptSchema.shape.summary,
  outcome: AttemptOutcomeSchema,
  conditions: LeadConditionsSchema.optional(),
  evidenceArtifactIds: LeadEvidenceRefsSchema.optional().default([]),
  linkedFindingId: EngagementSchema.shape.id.optional(),
  linkedObjectiveId: EngagementSchema.shape.id.optional(),
});

// Attach-afterward: an attempt recorded elsewhere can join a lead later.
// The lead link is always optional; launching without a lead never fails.
export const AttachLeadAttemptRequestSchema = z.strictObject({
  leadId: EngagementSchema.shape.id,
});

export const LeadIdParamsSchema = z.strictObject({
  engagementId: EngagementSchema.shape.id,
  leadId: EngagementSchema.shape.id,
});

export const LeadAttemptIdParamsSchema = z.strictObject({
  attemptId: EngagementSchema.shape.id,
});

export const LeadResponseSchema = LeadSchema;
export const LeadListResponseSchema = z.array(LeadSchema);
export const LeadAttemptResponseSchema = LeadAttemptSchema;
export const LeadAttemptListResponseSchema = z.array(LeadAttemptSchema);
export const LeadOutlineResponseSchema = z.strictObject({ outline: z.string() });

export const LeadQueryErrorSchema = z.union([
  z.strictObject({ code: z.literal("invalid_request") }),
  z.strictObject({ code: z.literal("engagement_not_found") }),
  z.strictObject({ code: z.literal("lead_not_found") }),
  z.strictObject({ code: z.literal("attempt_not_found") }),
  z.strictObject({ code: z.literal("invalid_persisted_data") }),
  z.strictObject({ code: z.literal("storage_busy") }),
]);

export const LeadMutationErrorSchema = z.union([
  z.strictObject({ code: z.literal("invalid_request") }),
  z.strictObject({ code: z.literal("engagement_not_found") }),
  z.strictObject({ code: z.literal("lead_not_found") }),
  z.strictObject({ code: z.literal("attempt_not_found") }),
  z.strictObject({ code: z.literal("engagement_archived") }),
  z.strictObject({ code: z.literal("invalid_lead_transition") }),
  z.strictObject({ code: z.literal("revisit_suppressed") }),
  z.strictObject({ code: z.literal("invalid_persisted_data") }),
  z.strictObject({ code: z.literal("storage_busy") }),
]);

export type LeadDisposition = z.infer<typeof LeadDispositionSchema>;
export type AttemptOutcome = z.infer<typeof AttemptOutcomeSchema>;
export type LeadSourceKind = z.infer<typeof LeadSourceKindSchema>;
export type LeadSource = z.infer<typeof LeadSourceSchema>;
export type RevisitTrigger = z.infer<typeof RevisitTriggerSchema>;
export type LeadRevisitSuggestion = z.infer<typeof LeadRevisitSuggestionSchema>;
export type Lead = z.infer<typeof LeadSchema>;
export type LeadAttempt = z.infer<typeof LeadAttemptSchema>;
export type CreateLeadRequest = z.infer<typeof CreateLeadRequestSchema>;
export type ParkLeadRequest = z.infer<typeof ParkLeadRequestSchema>;
export type CloseLeadRequest = z.infer<typeof CloseLeadRequestSchema>;
export type SuggestLeadRevisitRequest = z.infer<typeof SuggestLeadRevisitRequestSchema>;
export type CreateLeadAttemptRequest = z.infer<typeof CreateLeadAttemptRequestSchema>;
export type AttachLeadAttemptRequest = z.infer<typeof AttachLeadAttemptRequestSchema>;
export type LeadQueryError = z.infer<typeof LeadQueryErrorSchema>;
export type LeadMutationError = z.infer<typeof LeadMutationErrorSchema>;
