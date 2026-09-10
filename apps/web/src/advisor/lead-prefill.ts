import type { CreateFindingInput } from "../engagements/findings-query.js";

/**
 * Lead to finding prefill (STONE-7).
 * A lead becomes a correctable finding draft: title and narrative carry
 * over verbatim for the operator to fix, confidence is recorded separately
 * from severity, and scanner-sourced leads stay marked as uninterpreted
 * observations until the operator interprets them. This module consumes
 * leads through a narrow structural interface so the STONE-4 lead API can
 * wire in with a small adapter.
 */

export type LeadSource = "operator" | "model" | "scanner";

export type LeadConfidence = "low" | "medium" | "high";

export interface LeadRef {
  readonly id: string;
  readonly title: string;
  readonly narrative: string;
  readonly confidence: LeadConfidence | null;
  readonly source: LeadSource;
  readonly evidenceArtifactIds: readonly string[];
}

export interface FindingPrefill extends CreateFindingInput {
  readonly leadId: string;
  readonly needsInterpretation: boolean;
}

export function leadToFindingPrefill(lead: LeadRef): FindingPrefill {
  const confidenceLine =
    lead.confidence === null
      ? "Confidence: unassessed (operator assessment; independent of severity)."
      : `Confidence: ${lead.confidence} (operator assessment; independent of severity).`;
  const sourceLine = `Source: lead ${lead.id} (${lead.source}).`;
  const needsInterpretation = lead.source === "scanner";
  const header = needsInterpretation
    ? "Observation (uninterpreted scanner result). Interpret before treating as a finding.\n\n"
    : "";
  return {
    leadId: lead.id,
    needsInterpretation,
    title: lead.title,
    severity: needsInterpretation ? "info" : "medium",
    body: `${header}${lead.narrative}\n\n${sourceLine}\n${confidenceLine}`,
    evidenceArtifactIds: [...lead.evidenceArtifactIds],
  };
}
