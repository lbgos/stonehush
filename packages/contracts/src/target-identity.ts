import { z } from "zod";

import { EngagementSchema } from "./engagement.js";

export const STONE_TARGET_CONTRACT_VERSION = 1 as const;

const IdentifierSchema = z.uuid({ version: "v4" });
const UtcTimestampSchema = z.iso.datetime({ offset: true });

function hasCodePointLength(value: string, minimum: number, maximum: number): boolean {
  const length = Array.from(value).length;
  return length >= minimum && length <= maximum;
}

export const StoneTargetLabelSchema = z
  .string()
  .refine((value) => value === value.trim(), {
    message: "must not have leading or trailing whitespace",
  })
  .refine((value) => hasCodePointLength(value, 1, 120), {
    message: "must contain between 1 and 120 Unicode code points",
  });

export const StoneBindingKindSchema = z.enum(["ip", "hostname"]);

export const StoneAddressBindingStatusSchema = z.enum(["current", "historical"]);

export const StoneAddressBindingSchema = z.strictObject({
  contractVersion: z.literal(STONE_TARGET_CONTRACT_VERSION),
  id: IdentifierSchema,
  engagementId: EngagementSchema.shape.id,
  targetId: IdentifierSchema,
  bindingKind: StoneBindingKindSchema,
  addressText: z.string().min(1).max(512),
  status: StoneAddressBindingStatusSchema,
  createdAt: UtcTimestampSchema,
  supersededAt: UtcTimestampSchema.nullable(),
});

export const StoneServiceOriginSchema = z.strictObject({
  scheme: z.enum(["http", "https"]),
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65_535),
  origin: z.string().min(1).max(2048),
});

export const StoneHostnameAssociationStatusSchema = z.enum([
  "proposed",
  "associated",
  "declined",
]);

export const RUNNER_HOST_MAPPING_NOTE =
  "This name mapping applies to the runner only. An ordinary browser will not resolve it." as const;

export const RUNNER_MAPPING_NEXT_STEP =
  "Next step: share the intended hostname with the operator and use it for HTTP host and TLS server name; do not edit the OS hosts file." as const;

export const HOSTS_FILE_EDIT_POLICY = "never_silent" as const;

export const StoneHostnameAssociationSchema = z.strictObject({
  contractVersion: z.literal(STONE_TARGET_CONTRACT_VERSION),
  id: IdentifierSchema,
  engagementId: EngagementSchema.shape.id,
  targetId: IdentifierSchema,
  connectionAddress: z.string().min(1).max(512),
  requestedHostname: z.string().min(1).max(253),
  status: StoneHostnameAssociationStatusSchema,
  runnerOnlyNote: z.literal(RUNNER_HOST_MAPPING_NOTE),
  nextStep: z.literal(RUNNER_MAPPING_NEXT_STEP),
  hostsFileEdited: z.literal(false),
  createdAt: UtcTimestampSchema,
  decidedAt: UtcTimestampSchema.nullable(),
});

export const StoneTargetSchema = z.strictObject({
  contractVersion: z.literal(STONE_TARGET_CONTRACT_VERSION),
  id: IdentifierSchema,
  engagementId: EngagementSchema.shape.id,
  label: StoneTargetLabelSchema,
  revision: z.number().int().positive(),
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
});

export const StoneTargetContextSchema = z.strictObject({
  target: StoneTargetSchema,
  currentBinding: StoneAddressBindingSchema.nullable(),
  historicalBindings: z.array(StoneAddressBindingSchema),
  origins: z.array(StoneServiceOriginSchema),
  accountRef: z.string().min(1).max(256).nullable(),
  connectionRef: z.string().min(1).max(256).nullable(),
  lastConfirmedAt: UtcTimestampSchema.nullable(),
  sessionLabel: z.literal("Recorded"),
});

export const ChangeTargetAddressRequestSchema = z.strictObject({
  targetId: IdentifierSchema,
  newAddress: z.string().min(1).max(512),
  reason: z.string().min(1).max(512).optional(),
});

export const DecideHostnameAssociationRequestSchema = z.strictObject({
  decision: z.enum(["associated", "declined"]),
});

export const StoneCopyKindSchema = z.enum(["address", "hostname", "url", "command"]);

export const STONE_COPY_ACTION_LABELS: Record<
  z.infer<typeof StoneCopyKindSchema>,
  string
> = {
  address: "Copy address",
  hostname: "Copy hostname",
  url: "Copy URL",
  command: "Copy command",
};

export const StoneCommandRecipeSchema = z.strictObject({
  id: z.string().min(1).max(128),
  title: z
    .string()
    .refine((value) => value === value.trim(), {
      message: "must not have leading or trailing whitespace",
    })
    .refine((value) => hasCodePointLength(value, 1, 120), {
      message: "must contain between 1 and 120 Unicode code points",
    }),
  commandTemplate: z.string().min(1).max(2048),
  requiredInputs: z
    .array(z.enum(["address", "hostname", "origin", "account", "connection"]))
    .max(8),
  contextSnapshot: z.strictObject({
    address: z.string().min(1).max(512).nullable(),
    hostname: z.string().min(1).max(253).nullable(),
    origin: z.string().min(1).max(2048).nullable(),
    accountRef: z.string().min(1).max(256).nullable(),
    connectionRef: z.string().min(1).max(256).nullable(),
  }),
});

export const StoneTargetListResponseSchema = z.array(StoneTargetSchema);

export const StoneAddressBindingListSchema = z.array(StoneAddressBindingSchema);

export const StoneEngagementIdParamsSchema = z.strictObject({
  engagementId: EngagementSchema.shape.id,
});

export const StoneTargetIdParamsSchema = z.strictObject({
  engagementId: EngagementSchema.shape.id,
  targetId: EngagementSchema.shape.id,
});

export const StoneAssociationIdParamsSchema = z.strictObject({
  engagementId: EngagementSchema.shape.id,
  associationId: EngagementSchema.shape.id,
});

export const CreateStoneTargetBodySchema = z.strictObject({
  label: StoneTargetLabelSchema,
  initialAddress: z.string().min(1).max(512),
});

export const ProposeStoneAssociationBodySchema = z.strictObject({
  connectionAddress: z.string().min(1).max(512),
  requestedHostname: z.string().min(1).max(253),
});
export const StoneTargetErrorSchema = z.union([
  z.strictObject({ code: z.literal("invalid_request") }),
  z.strictObject({ code: z.literal("engagement_not_found") }),
  z.strictObject({ code: z.literal("target_not_found") }),
  z.strictObject({ code: z.literal("invalid_persisted_data") }),
  z.strictObject({ code: z.literal("storage_busy") }),
]);

export function formatRecordedSessionLabel(lastConfirmedAt: string | null): string {
  if (lastConfirmedAt === null) return "Recorded";
  return `Recorded, Last confirmed ${lastConfirmedAt}`;
}

export type StoneTargetLabel = z.infer<typeof StoneTargetLabelSchema>;
export type StoneBindingKind = z.infer<typeof StoneBindingKindSchema>;
export type StoneAddressBindingStatus = z.infer<typeof StoneAddressBindingStatusSchema>;
export type StoneAddressBinding = z.infer<typeof StoneAddressBindingSchema>;
export type StoneServiceOrigin = z.infer<typeof StoneServiceOriginSchema>;
export type StoneHostnameAssociationStatus = z.infer<
  typeof StoneHostnameAssociationStatusSchema
>;
export type StoneHostnameAssociation = z.infer<typeof StoneHostnameAssociationSchema>;
export type StoneTarget = z.infer<typeof StoneTargetSchema>;
export type StoneTargetContext = z.infer<typeof StoneTargetContextSchema>;
export type ChangeTargetAddressRequest = z.infer<typeof ChangeTargetAddressRequestSchema>;
export type DecideHostnameAssociationRequest = z.infer<
  typeof DecideHostnameAssociationRequestSchema
>;
export type StoneCopyKind = z.infer<typeof StoneCopyKindSchema>;
export type StoneCommandRecipe = z.infer<typeof StoneCommandRecipeSchema>;
export type StoneTargetError = z.infer<typeof StoneTargetErrorSchema>;
