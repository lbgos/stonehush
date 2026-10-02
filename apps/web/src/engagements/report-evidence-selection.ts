import type { Finding, ReportBundle, ReportEvidenceArtifact } from "@stonehush/contracts";

import { addOutlineItem, outlineKey, type ReportOutline } from "./report-outline.js";

/**
 * Finding-with-evidence selection for the Report outline.
 * Joins a finding's saved evidenceArtifactIds to the displayed report
 * catalog by exact ID only. Nothing here infers proof from attempts,
 * titles, runs, or metadata, and nothing writes to the server: the result
 * is a new local outline built through addOutlineItem.
 */

// A response is usable for joining only when it belongs to the requested
// engagement and every finding and catalog artifact has a unique ID.
// Anything else returns a reason and the combined action stays off.
export function reportIdentityIssue(
  bundle: ReportBundle,
  engagementId: string,
): string | null {
  if (bundle.engagement.id !== engagementId) {
    return "This report response belongs to a different engagement.";
  }
  const findingIds = new Set<string>();
  for (const finding of bundle.findings) {
    if (finding.engagementId !== engagementId) {
      return "This report response has a finding from a different engagement.";
    }
    if (findingIds.has(finding.id)) {
      return "This report response has duplicate finding IDs.";
    }
    findingIds.add(finding.id);
  }
  const artifactIds = new Set<string>();
  for (const artifact of bundle.evidenceArtifacts.rows) {
    if (artifactIds.has(artifact.artifactId)) {
      return "This report response has duplicate artifact IDs.";
    }
    artifactIds.add(artifact.artifactId);
  }
  return null;
}

export type FindingEvidenceRefState = "selected" | "pending" | "not-in-catalog";

export interface FindingEvidenceRef {
  readonly artifactId: string;
  readonly state: FindingEvidenceRefState;
  readonly artifact?: ReportEvidenceArtifact;
}

// none: the finding saved no refs, so there is no combined action.
// unavailable: refs exist but none are in this report catalog.
// add / add-remaining: one activation adds the pending refs (and the
// finding itself when it is not selected yet).
// done: every catalog ref is already in the outline.
export type FindingEvidenceAction =
  | "none"
  | "unavailable"
  | "add"
  | "add-remaining"
  | "done";

export interface FindingEvidencePlan {
  readonly findingSelected: boolean;
  // Distinct saved refs in saved order.
  readonly refs: readonly FindingEvidenceRef[];
  readonly inCatalog: number;
  readonly notInCatalog: number;
  readonly pending: readonly string[];
  readonly action: FindingEvidenceAction;
}

export function planFindingEvidence(
  finding: Finding,
  catalog: ReadonlyMap<string, ReportEvidenceArtifact>,
  outline: ReportOutline,
): FindingEvidencePlan {
  const selectedKeys = new Set(outline.items.map((item) => item.key));
  const findingSelected = selectedKeys.has(outlineKey("finding", finding.id));
  const seen = new Set<string>();
  const refs: FindingEvidenceRef[] = [];
  for (const artifactId of finding.evidenceArtifactIds) {
    if (seen.has(artifactId)) continue;
    seen.add(artifactId);
    const artifact = catalog.get(artifactId);
    if (artifact === undefined) {
      refs.push({ artifactId, state: "not-in-catalog" });
    } else {
      refs.push({
        artifactId,
        artifact,
        state: selectedKeys.has(outlineKey("evidence", artifactId)) ? "selected" : "pending",
      });
    }
  }
  const pending = refs.filter((ref) => ref.state === "pending").map((ref) => ref.artifactId);
  const notInCatalog = refs.filter((ref) => ref.state === "not-in-catalog").length;
  const inCatalog = refs.length - notInCatalog;
  let action: FindingEvidenceAction;
  if (refs.length === 0) action = "none";
  else if (inCatalog === 0) action = "unavailable";
  else if (pending.length === 0) action = "done";
  else action = findingSelected ? "add-remaining" : "add";
  return { findingSelected, refs, inCatalog, notInCatalog, pending, action };
}

// Only call after reportIdentityIssue returned null; with duplicate
// artifact IDs the last row would silently win.
export function evidenceCatalog(
  rows: readonly ReportEvidenceArtifact[],
): ReadonlyMap<string, ReportEvidenceArtifact> {
  return new Map(rows.map((artifact) => [artifact.artifactId, artifact]));
}

// Appends the finding (if missing) and then its pending refs in saved
// order. Existing items keep their order and captions. Evidence captions
// keep the existing convention of the artifact ID. When nothing is
// pending the same outline object comes back, so a repeated click cannot
// reorder items or mark an export stale.
export function addFindingWithEvidence(
  outline: ReportOutline,
  finding: Finding,
  plan: FindingEvidencePlan,
): ReportOutline {
  if (plan.pending.length === 0) return outline;
  let next = addOutlineItem(outline, {
    kind: "finding",
    refId: finding.id,
    caption: finding.title,
  });
  for (const artifactId of plan.pending) {
    next = addOutlineItem(next, { kind: "evidence", refId: artifactId, caption: artifactId });
  }
  return next;
}
