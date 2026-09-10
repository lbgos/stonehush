import { z } from "zod";

import { EngagementSchema } from "./engagement.js";

export const STONE_CAPTURE_CONTRACT_VERSION = 1 as const;

const IdentifierSchema = z.uuid({ version: "v4" });
const UtcTimestampSchema = z.iso.datetime({ offset: true });

function hasCodePointLength(value: string, minimum: number, maximum: number): boolean {
  const length = Array.from(value).length;
  return length >= minimum && length <= maximum;
}

export const StoneCaptureKindSchema = z.enum([
  "pasted_terminal",
  "dropped_file",
  "screenshot",
  "nmap_xml",
  "ffuf_json",
]);

export const StoneCaptureOriginSchema = z.enum(["pasted", "imported"]);

export const StoneContentDigestSchema = z
  .string()
  .length(71)
  .regex(/^sha256:[0-9a-f]{64}$/);

// Operator capture creation must never invent runner execution facts.
// These fields are rejected at the boundary when present.
export const INVENTED_EXECUTION_FACT_FIELDS = [
  "startedAt",
  "finishedAt",
  "exitCode",
  "exitStatus",
  "executedCommand",
  "runnerTarget",
] as const;

export type InventedExecutionFactField =
  (typeof INVENTED_EXECUTION_FACT_FIELDS)[number];

export function findInventedExecutionFacts(body: unknown): InventedExecutionFactField[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return [];
  const record = body as Record<string, unknown>;
  const found: InventedExecutionFactField[] = [];
  for (const field of INVENTED_EXECUTION_FACT_FIELDS) {
    if (record[field] !== undefined) found.push(field);
  }
  return found;
}

const SingleLineObservationSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => !value.includes("\n") && !value.includes("\r"), {
    message: "must be a single line",
  });

export const CreateStoneCaptureRequestSchema = z.strictObject({
  engagementId: EngagementSchema.shape.id,
  targetId: IdentifierSchema.nullable().optional().default(null),
  leadId: z.string().min(1).max(255).nullable().optional().default(null),
  kind: StoneCaptureKindSchema,
  title: z
    .string()
    .refine((value) => value === value.trim(), {
      message: "must not have leading or trailing whitespace",
    })
    .refine((value) => hasCodePointLength(value, 1, 120), {
      message: "must contain between 1 and 120 Unicode code points",
    }),
  command: z.string().min(1).max(2048).optional(),
  observation: SingleLineObservationSchema.optional(),
  contentText: z.string().min(1).max(65_536).optional(),
  contentDigest: StoneContentDigestSchema.optional(),
  fileName: z.string().min(1).max(255).optional(),
  byteSize: z.number().int().min(0).max(67_108_864).optional(),
});

export const StoneCaptureSchema = z.strictObject({
  contractVersion: z.literal(STONE_CAPTURE_CONTRACT_VERSION),
  id: IdentifierSchema,
  engagementId: EngagementSchema.shape.id,
  targetId: IdentifierSchema.nullable(),
  leadId: z.string().min(1).max(255).nullable(),
  kind: StoneCaptureKindSchema,
  originLabel: StoneCaptureOriginSchema,
  title: z.string().min(1).max(120),
  command: z.string().min(1).max(2048).nullable(),
  observation: z.string().min(1).max(2048).nullable(),
  contentDigest: StoneContentDigestSchema,
  provenanceExistingId: IdentifierSchema.nullable(),
  byteSize: z.number().int().min(0),
  createdAt: UtcTimestampSchema,
});

export const StoneImportDedupeResultSchema = z.strictObject({
  deduplicated: z.boolean(),
  capture: StoneCaptureSchema,
});

export function originLabelForKind(
  kind: z.infer<typeof StoneCaptureKindSchema>,
): z.infer<typeof StoneCaptureOriginSchema> {
  if (kind === "pasted_terminal" || kind === "dropped_file" || kind === "screenshot") {
    return "pasted";
  }
  return "imported";
}

export function proposeCaptureTitle(input: {
  kind: z.infer<typeof StoneCaptureKindSchema>;
  command?: string;
  targetLabel?: string;
  fileName?: string;
}): string {
  const target = input.targetLabel?.trim() ?? "";
  if (input.command !== undefined && input.command.trim().length > 0) {
    const firstToken = input.command.trim().split(/\s+/)[0] ?? "command";
    const base = target.length > 0 ? `${firstToken} on ${target}` : `${firstToken} output`;
    return base.slice(0, 120);
  }
  if (input.fileName !== undefined && input.fileName.trim().length > 0) {
    const base =
      target.length > 0 ? `${input.fileName.trim()} for ${target}` : input.fileName.trim();
    return base.slice(0, 120);
  }
  const kindLabel =
    input.kind === "nmap_xml"
      ? "Nmap import"
      : input.kind === "ffuf_json"
        ? "Ffuf import"
        : input.kind === "screenshot"
          ? "Screenshot"
          : input.kind === "dropped_file"
            ? "Dropped file"
            : "Pasted terminal output";
  return (target.length > 0 ? `${kindLabel} for ${target}` : kindLabel).slice(0, 120);
}

export const StoneCaptureListResponseSchema = z.array(StoneCaptureSchema);

const StoneTargetIdSchema = z.uuid({ version: "v4" });

// Import request boundary. Counts are derived server-side by parsing the
// presented content, so no client count field exists here: a rawCount member
// is rejected by the strict object rather than accepted and dropped.
export const StoneImportBodySchema = z.strictObject({
  targetId: StoneTargetIdSchema.nullable().optional().default(null),
  leadId: z.string().min(1).max(255).nullable().optional().default(null),
  title: z.string().min(1).max(120).optional(),
  command: z.string().min(1).max(2048).optional(),
  observation: SingleLineObservationSchema.optional(),
  contentText: z.string().min(1).max(67_108_864).optional(),
  contentDigest: StoneContentDigestSchema.optional(),
  fileName: z.string().min(1).max(255).optional(),
  byteSize: z.number().int().min(0).max(67_108_864).optional(),
});

export const StoneCaptureErrorSchema = z.union([
  z.strictObject({ code: z.literal("invalid_request") }),
  z.strictObject({ code: z.literal("engagement_not_found") }),
  z.strictObject({ code: z.literal("target_not_found") }),
  z.strictObject({ code: z.literal("invalid_persisted_data") }),
  z.strictObject({ code: z.literal("storage_busy") }),
]);

export type StoneCaptureKind = z.infer<typeof StoneCaptureKindSchema>;
export type StoneCaptureOrigin = z.infer<typeof StoneCaptureOriginSchema>;
export type CreateStoneCaptureRequest = z.infer<typeof CreateStoneCaptureRequestSchema>;
export type StoneCapture = z.infer<typeof StoneCaptureSchema>;
export type StoneImportDedupeResult = z.infer<typeof StoneImportDedupeResultSchema>;
export type StoneCaptureError = z.infer<typeof StoneCaptureErrorSchema>;
