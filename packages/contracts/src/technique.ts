import { z } from "zod";

import { EngagementSchema } from "./engagement.js";
import { EngagementIdParamsSchema } from "./engagement-api.js";

/**
 * Saved technique contracts (Stonehush STONE-7).
 * A technique is a reusable operator procedure saved from a useful
 * investigation sequence: when it is useful, its prerequisites, the
 * distinguishing question it answers, the procedure with replayable
 * placeholders, and how to read the result. Placeholders use
 * `{{name}}` with lowercase leading names. Strict Zod, no passthrough.
 */

export const TECHNIQUE_CONTRACT_VERSION = 1 as const;
export const TECHNIQUE_NAME_MIN_CHARS = 1 as const;
export const TECHNIQUE_NAME_MAX_CHARS = 80 as const;
export const TECHNIQUE_WHEN_USEFUL_MAX_BYTES = 2_000 as const;
export const TECHNIQUE_PREREQUISITES_MAX = 8 as const;
export const TECHNIQUE_PREREQUISITE_MIN_CHARS = 1 as const;
export const TECHNIQUE_PREREQUISITE_MAX_CHARS = 280 as const;
export const TECHNIQUE_QUESTION_MAX_BYTES = 2_000 as const;
export const TECHNIQUE_PROCEDURE_STEPS_MAX = 16 as const;
export const TECHNIQUE_STEP_INSTRUCTION_MAX_CHARS = 500 as const;
export const TECHNIQUE_STEP_COMMAND_MAX_CHARS = 500 as const;
export const TECHNIQUE_MEANING_MAX_BYTES = 2_000 as const;
export const TECHNIQUE_PLACEHOLDER_PATTERN = /\{\{([a-z][a-z0-9_]{0,31})\}\}/g;
export const TECHNIQUE_PLACEHOLDER_NAME_MAX_CHARS = 32 as const;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function hasCodePointLength(value: string, minimum: number, maximum: number): boolean {
  const length = Array.from(value).length;
  return length >= minimum && length <= maximum;
}

export const TechniqueNameSchema = z
  .string()
  .refine((value) => value === value.trim(), {
    message: "must not have leading or trailing whitespace",
  })
  .refine(
    (value) =>
      hasCodePointLength(
        value,
        TECHNIQUE_NAME_MIN_CHARS,
        TECHNIQUE_NAME_MAX_CHARS,
      ),
    { message: "must contain between 1 and 80 Unicode code points" },
  );

export const TechniqueWhenUsefulSchema = z
  .string()
  .refine((value) => utf8ByteLength(value) <= TECHNIQUE_WHEN_USEFUL_MAX_BYTES, {
    message: "must contain at most 2000 UTF-8 bytes",
  });

export const TechniquePrerequisiteSchema = z
  .string()
  .refine((value) => value === value.trim(), {
    message: "must not have leading or trailing whitespace",
  })
  .refine(
    (value) =>
      hasCodePointLength(
        value,
        TECHNIQUE_PREREQUISITE_MIN_CHARS,
        TECHNIQUE_PREREQUISITE_MAX_CHARS,
      ),
    { message: "must contain between 1 and 280 Unicode code points" },
  );

export const TechniqueQuestionSchema = z
  .string()
  .refine((value) => value === value.trim(), {
    message: "must not have leading or trailing whitespace",
  })
  .refine((value) => utf8ByteLength(value) >= 1, {
    message: "must contain at least 1 UTF-8 byte",
  })
  .refine((value) => utf8ByteLength(value) <= TECHNIQUE_QUESTION_MAX_BYTES, {
    message: "must contain at most 2000 UTF-8 bytes",
  });

export const TechniqueStepInstructionSchema = z
  .string()
  .refine((value) => value === value.trim(), {
    message: "must not have leading or trailing whitespace",
  })
  .refine(
    (value) =>
      hasCodePointLength(value, 1, TECHNIQUE_STEP_INSTRUCTION_MAX_CHARS),
    { message: "must contain between 1 and 500 Unicode code points" },
  );

export const TechniqueStepCommandSchema = z
  .string()
  .refine((value) => value === value.trim(), {
    message: "must not have leading or trailing whitespace",
  })
  .refine(
    (value) => hasCodePointLength(value, 1, TECHNIQUE_STEP_COMMAND_MAX_CHARS),
    { message: "must contain between 1 and 500 Unicode code points" },
  )
  .refine((value) => !/[\r\n]/.test(value), {
    message: "must be a single line",
  });

export const TechniqueMeaningSchema = z
  .string()
  .refine((value) => utf8ByteLength(value) <= TECHNIQUE_MEANING_MAX_BYTES, {
    message: "must contain at most 2000 UTF-8 bytes",
  });

export const TechniqueStepSchema = z.strictObject({
  instruction: TechniqueStepInstructionSchema,
  command: TechniqueStepCommandSchema.optional(),
});

export type TechniqueStep = z.infer<typeof TechniqueStepSchema>;

export const TechniqueSchema = z.strictObject({
  contractVersion: z.literal(TECHNIQUE_CONTRACT_VERSION),
  id: EngagementSchema.shape.id,
  engagementId: EngagementSchema.shape.id,
  name: TechniqueNameSchema,
  whenUseful: TechniqueWhenUsefulSchema,
  prerequisites: z.array(TechniquePrerequisiteSchema).max(TECHNIQUE_PREREQUISITES_MAX),
  question: TechniqueQuestionSchema,
  procedure: z.array(TechniqueStepSchema).min(1).max(TECHNIQUE_PROCEDURE_STEPS_MAX),
  meaning: TechniqueMeaningSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Technique = z.infer<typeof TechniqueSchema>;

export const CreateTechniqueRequestSchema = z.strictObject({
  name: TechniqueNameSchema,
  whenUseful: TechniqueWhenUsefulSchema.optional().default(""),
  prerequisites: z.array(TechniquePrerequisiteSchema).max(TECHNIQUE_PREREQUISITES_MAX).optional().default([]),
  question: TechniqueQuestionSchema,
  procedure: z.array(TechniqueStepSchema).min(1).max(TECHNIQUE_PROCEDURE_STEPS_MAX),
  meaning: TechniqueMeaningSchema.optional().default(""),
});

export type CreateTechniqueRequest = z.infer<typeof CreateTechniqueRequestSchema>;

export const TechniqueResponseSchema = TechniqueSchema;
export const TechniqueListResponseSchema = z.array(TechniqueSchema);

export const TechniqueIdParamsSchema = EngagementIdParamsSchema.extend({
  techniqueId: EngagementSchema.shape.id,
});

export type TechniqueIdParams = z.infer<typeof TechniqueIdParamsSchema>;

export const TechniqueQueryErrorSchema = z.union([
  z.strictObject({ code: z.literal("invalid_request") }),
  z.strictObject({ code: z.literal("engagement_not_found") }),
  z.strictObject({ code: z.literal("technique_not_found") }),
  z.strictObject({ code: z.literal("invalid_persisted_data") }),
  z.strictObject({ code: z.literal("storage_busy") }),
]);

export type TechniqueQueryError = z.infer<typeof TechniqueQueryErrorSchema>;

export const TechniqueMutationErrorSchema = z.union([
  z.strictObject({ code: z.literal("invalid_request") }),
  z.strictObject({ code: z.literal("engagement_not_found") }),
  z.strictObject({ code: z.literal("engagement_archived") }),
  z.strictObject({ code: z.literal("invalid_persisted_data") }),
  z.strictObject({ code: z.literal("storage_busy") }),
]);

export type TechniqueMutationError = z.infer<typeof TechniqueMutationErrorSchema>;
