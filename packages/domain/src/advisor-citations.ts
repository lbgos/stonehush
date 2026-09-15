import type {
  AdvisorEvidenceKind,
  AdvisorPartitionedCitation,
  AdvisorSuppliedEvidenceId,
} from "@stonehush/contracts";

/**
 * Pure citation partition for read-only evidence explanations.
 * Cited identifiers must exactly match evidence supplied for the same turn;
 * engagement ownership of the supplied set is verified by the route slice
 * before any model call. Anything unmatched is invalid and must render as
 * inert plain text, never as a link or trust signal.
 *
 * Supplied ids are unique per turn by contract (AdvisorEvidenceBlockListSchema
 * rejects duplicates), so there is no kind conflict to resolve. The first-wins
 * map below is deterministic defense in depth for pre-validated inputs only.
 */

export interface AdvisorCitationPartition {
  readonly valid: readonly AdvisorPartitionedCitation[];
  readonly invalid: readonly string[];
}

export function partitionAdvisorCitations(
  supplied: readonly AdvisorSuppliedEvidenceId[],
  cited: readonly string[],
): AdvisorCitationPartition {
  const kinds = new Map<string, AdvisorEvidenceKind>();
  for (const item of supplied) {
    if (!kinds.has(item.id)) kinds.set(item.id, item.kind);
  }
  const valid: AdvisorPartitionedCitation[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of cited) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    const kind = kinds.get(raw);
    if (kind === undefined) {
      invalid.push(raw);
    } else {
      valid.push({ raw, valid: true, kind });
    }
  }
  return { valid, invalid };
}
