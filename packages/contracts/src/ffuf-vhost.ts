import { z } from "zod";

import { EngagementSchema } from "./engagement.js";
import { EvidenceDigestSchema, OpaqueArtifactIdSchema } from "./evidence.js";
import { FFUF_DEFAULT_MATCH_CODES } from "./ffuf.js";

/**
 * ffuf vhost discovery lane (T1).
 * Discovers virtual hosts on an explicit IP by fuzzing the Host header with
 * the shipped ffuf binary and JSON output contract. No new binaries.
 * Wordlist entries are sent verbatim as the Host header value.
 * Results are candidate hostnames that propose hostname associations into
 * the stone target identity. Machines are never auto-merged.
 */

export const FFUF_VHOST_PARSER_VERSION = "ffuf-vhost-v1" as const;
export const FFUF_VHOST_DEFAULT_PORT = 80 as const;

function hasPathTraversal(value: string): boolean {
  return value.split("/").includes("..");
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") && !value.includes("\0");
}

const AbsoluteManagedPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(isAbsolutePath, { message: "path must be absolute" })
  .refine((value) => !hasPathTraversal(value), { message: "path traversal rejected" });

const VhostAddressSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes("\0"), { message: "address must not contain NUL" })
  .refine((value) => value.trim() === value, { message: "address must not have surrounding whitespace" });

export const FfufVhostActionOptionsSchema = z.strictObject({
  address: VhostAddressSchema,
  port: z.number().int().min(1).max(65_535).default(FFUF_VHOST_DEFAULT_PORT),
  tls: z.boolean().default(false),
  wordlistPath: AbsoluteManagedPathSchema,
  outputJsonPath: AbsoluteManagedPathSchema,
  rate: z.number().int().min(1).max(10_000).default(100),
  threads: z.number().int().min(1).max(200).default(40),
  timeoutSeconds: z.number().int().min(1).max(120).default(10),
  maxTimeSeconds: z.number().int().min(5).max(1800).default(120),
  matchStatusCodes: z
    .array(z.number().int().min(100).max(599))
    .min(1)
    .default([...FFUF_DEFAULT_MATCH_CODES]),
});

export type FfufVhostActionOptions = z.infer<typeof FfufVhostActionOptionsSchema>;

/**
 * Operator surface. The JSON output path is runner-owned host state derived
 * from the controlled run directory, never an operator option.
 */
export const FfufVhostDiscoveryOptionsSchema = FfufVhostActionOptionsSchema.omit({
  outputJsonPath: true,
});

export type FfufVhostDiscoveryOptions = z.infer<typeof FfufVhostDiscoveryOptionsSchema>;

export const FfufVhostDiscoveryLaunchSchema = z.strictObject({
  expectedEngagementRevision: z.number().int().positive(),
  expectedActiveScopeRevisionId: EngagementSchema.shape.id.nullable(),
  address: FfufVhostDiscoveryOptionsSchema.shape.address,
  port: FfufVhostDiscoveryOptionsSchema.shape.port,
  tls: FfufVhostDiscoveryOptionsSchema.shape.tls,
  wordlistPath: FfufVhostDiscoveryOptionsSchema.shape.wordlistPath,
  rate: FfufVhostDiscoveryOptionsSchema.shape.rate,
  threads: FfufVhostDiscoveryOptionsSchema.shape.threads,
  timeoutSeconds: FfufVhostDiscoveryOptionsSchema.shape.timeoutSeconds,
  maxTimeSeconds: FfufVhostDiscoveryOptionsSchema.shape.maxTimeSeconds,
  matchStatusCodes: FfufVhostDiscoveryOptionsSchema.shape.matchStatusCodes,
});

export type FfufVhostDiscoveryLaunch = z.infer<typeof FfufVhostDiscoveryLaunchSchema>;

const OptionalWordlistPathSchema = z
  .string()
  .max(1024)
  .refine(
    (value) => value === "" || (isAbsolutePath(value) && !hasPathTraversal(value)),
    { message: "path must be absolute or empty" },
  )
  .optional();

export const FfufVhostDiscoveryLaunchRequestSchema = z.strictObject({
  expectedEngagementRevision: FfufVhostDiscoveryLaunchSchema.shape.expectedEngagementRevision,
  expectedActiveScopeRevisionId:
    FfufVhostDiscoveryLaunchSchema.shape.expectedActiveScopeRevisionId,
  address: FfufVhostDiscoveryLaunchSchema.shape.address,
  port: z.number().int().min(1).max(65_535).optional(),
  tls: z.boolean().optional(),
  wordlistPath: OptionalWordlistPathSchema,
  rate: z.number().int().min(1).max(10_000).optional(),
  threads: z.number().int().min(1).max(200).optional(),
  timeoutSeconds: z.number().int().min(1).max(120).optional(),
  maxTimeSeconds: z.number().int().min(5).max(1800).optional(),
  matchStatusCodes: z.array(z.number().int().min(100).max(599)).min(1).optional(),
});

export type FfufVhostDiscoveryLaunchRequest = z.infer<
  typeof FfufVhostDiscoveryLaunchRequestSchema
>;

/** Raw ffuf -of json output for a vhost run is preserved as tool_raw under this slot. */
export const FFUF_VHOST_ARTIFACT_SLOT = "vhost-json" as const;

export function isVhostArtifactSlot(slot: string): boolean {
  return slot === FFUF_VHOST_ARTIFACT_SLOT;
}

export const FfufVhostParserVersionSchema = z.literal(FFUF_VHOST_PARSER_VERSION);

export const FfufVhostProjectedSchema = z.strictObject({
  source: z.literal("ffuf-vhost"),
  parserVersion: FfufVhostParserVersionSchema,
  hostname: z.string().min(1).max(2048),
  baseUrl: z.string().min(1).max(2048),
  status: z.number().int().min(100).max(599),
  length: z.number().int().min(0),
  words: z.number().int().min(0),
  lines: z.number().int().min(0),
  runId: z.string().min(1).max(255),
  artifactId: OpaqueArtifactIdSchema,
  artifactDigest: EvidenceDigestSchema,
  observedAt: z.iso.datetime({ offset: true }),
});

export type FfufVhostProjected = z.infer<typeof FfufVhostProjectedSchema>;

export const EngagementVhostResultsParamsSchema = z.strictObject({
  engagementId: EngagementSchema.shape.id,
});
export const EngagementVhostResultsResponseSchema = z.array(FfufVhostProjectedSchema);

export type EngagementVhostResultsParams = z.infer<typeof EngagementVhostResultsParamsSchema>;

/**
 * Build the request base URL for an explicit IP target.
 * IPv6 literals are bracketed. The Host header carries the fuzzed hostname,
 * never this URL host.
 */
export function vhostBaseUrl(input: { address: string; port: number; tls: boolean }): string {
  const scheme = input.tls ? "https" : "http";
  const host = input.address.includes(":") ? `[${input.address}]` : input.address;
  return `${scheme}://${host}:${input.port}/`;
}
