import type { Lead, LeadAttempt, ReportEvidenceArtifact } from "@stonehush/contracts";

import { maskCopiedText } from "../engagements/lead-technique-draft.js";

export function validateAttemptContext(engagementId: string, leadId: string, lead: Lead, attempts: readonly LeadAttempt[]): void {
  if (lead.engagementId !== engagementId || lead.id !== leadId ||
    attempts.some((attempt) => attempt.engagementId !== engagementId || attempt.leadId !== leadId) ||
    new Set(attempts.map((attempt) => attempt.id)).size !== attempts.length ||
    new Set(attempts.map((attempt) => attempt.sequence)).size !== attempts.length) {
    throw new Error("Saved attempts could not be read unambiguously for this lead.");
  }
}

// Selection names exact saved IDs. All outcomes are allowed, and recorded
// sequence determines display/draft order rather than click order.
export function selectedAttemptContext(lead: Lead, attempts: readonly LeadAttempt[], selectedIds: readonly string[]) {
  if (selectedIds.length === 0 || new Set(selectedIds).size !== selectedIds.length) return undefined;
  const selected = selectedIds.map((id) => attempts.find((attempt) => attempt.id === id));
  if (selected.some((attempt) => attempt === undefined)) return undefined;
  validateAttemptContext(lead.engagementId, lead.id, lead, attempts);
  return selected.filter((attempt) => attempt !== undefined).sort((a, b) => a.sequence - b.sequence);
}

export function draftAttemptContext(lead: Lead, selected: readonly LeadAttempt[]): string {
  const lines = [
    "Recorded lead and attempts, not verified conclusions:",
    `Saved question: ${lead.title}`,
    `Disposition: ${lead.disposition}`,
  ];
  if (lead.nextStep !== null) lines.push(`Saved next step: ${lead.nextStep}`);
  if (lead.parkReason !== null) lines.push(`Parked reason: ${lead.parkReason}`);
  if (lead.testedConditions !== null) lines.push(`Lead tested conditions: ${lead.testedConditions}`);
  if (lead.closedNote !== null) lines.push(`Closed note: ${lead.closedNote}`);
  for (const attempt of selected) {
    lines.push("", `Attempt ${attempt.sequence}: ${attempt.outcome.replaceAll("_", " ")}`,
      `Summary: ${attempt.summary}`, `Recorded conditions: ${attempt.conditions ?? "unknown"}`);
  }
  // Same heuristic as saved-technique copying. Never clip overlong context:
  // the operator edits it under the existing shaped-question byte limit.
  return maskCopiedText(lines.join("\n"));
}

export function attemptEvidenceCandidates(attempts: readonly LeadAttempt[], catalog: readonly ReportEvidenceArtifact[]) {
  const references = [...new Set(attempts.flatMap((attempt) => attempt.evidenceArtifactIds))];
  return references.map((id) => ({
    id,
    artifact: catalog.find((row) => row.artifactId === id),
    sequences: attempts.filter((attempt) => attempt.evidenceArtifactIds.includes(id)).map((attempt) => attempt.sequence),
  }));
}
