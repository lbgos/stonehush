import { FindingIdParamsSchema, type Finding } from "@stonehush/contracts";

import { fetchFindings } from "./findings-query.js";
import { resolveFindingMatch, type FindingSearchDestination } from "./search-destination.js";

export interface ResumeFindingDestination {
  readonly source: "resume";
  readonly kind: "finding";
  readonly nonce: number;
  readonly engagementId: string;
  readonly findingId: string;
}

// Search keeps its passage signature. Resume names the saved record alone.
export type FindingDestination =
  | (FindingSearchDestination & { readonly source: "search" })
  | ResumeFindingDestination;

export function createResumeFindingDestination(input: {
  readonly engagementId: string;
  readonly findingId: unknown;
  readonly nonce: number;
}): ResumeFindingDestination | null {
  const identity = FindingIdParamsSchema.safeParse({
    engagementId: input.engagementId,
    findingId: input.findingId,
  });
  if (!identity.success || !Number.isSafeInteger(input.nonce) || input.nonce < 1) return null;
  return { source: "resume", kind: "finding", ...identity.data, nonce: input.nonce };
}

export type FindingDestinationRead =
  | { readonly status: "error" }
  | { readonly status: "missing" | "changed"; readonly records: readonly Finding[] }
  | { readonly status: "found"; readonly records: readonly Finding[]; readonly finding: Finding };

/** Classify a schema-validated list without choosing a substitute record. */
export function resolveFindingDestination(
  records: readonly Finding[],
  destination: FindingDestination,
  engagementId: string,
): FindingDestinationRead {
  if (
    destination.engagementId !== engagementId ||
    records.some((finding) => finding.engagementId !== engagementId) ||
    new Set(records.map((finding) => finding.id)).size !== records.length
  ) return { status: "error" };
  const finding = records.find((record) => record.id === destination.findingId);
  if (finding === undefined) return { status: "missing", records };
  if (destination.source === "search" && !resolveFindingMatch(finding, destination)) {
    return { status: "changed", records };
  }
  return { status: "found", records, finding };
}

/**
 * Read fresh for this arrival. Null means it was cancelled or belongs to a
 * different engagement. The caller aborts on destination change/unmount and
 * updates the findings cache only from results containing validated records.
 */
export async function readFindingDestination(
  engagementId: string,
  destination: FindingDestination,
  signal: AbortSignal,
): Promise<FindingDestinationRead | null> {
  if (signal.aborted || destination.engagementId !== engagementId) return null;
  if (!FindingIdParamsSchema.safeParse({ engagementId, findingId: destination.findingId }).success) {
    return { status: "error" };
  }
  try {
    const records = await fetchFindings(engagementId, signal);
    if (signal.aborted) return null;
    return resolveFindingDestination(records, destination, engagementId);
  } catch {
    return signal.aborted ? null : { status: "error" };
  }
}
