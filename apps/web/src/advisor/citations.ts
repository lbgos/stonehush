import type { AdvisorPartitionedCitation } from "@blackglass/contracts";

/**
 * Citation passage links (STONE-7).
 * Valid artifact citations open the saved passage through the operator
 * artifact download route. Every other citation (findings, services,
 * probes, unknown, or invalid) renders as inert text, never as a link or
 * trust signal.
 */

export function citationPassageHref(
  engagementId: string,
  citation: AdvisorPartitionedCitation,
): string | null {
  if (!citation.valid || citation.kind !== "artifact") return null;
  return `/api/v1/engagements/${encodeURIComponent(engagementId)}/artifacts/${encodeURIComponent(citation.raw)}/content`;
}

export function isOpenableCitation(citation: AdvisorPartitionedCitation): boolean {
  return citation.valid && citation.kind === "artifact";
}
