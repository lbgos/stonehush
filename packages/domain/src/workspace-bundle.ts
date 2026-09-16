import {
  WORKSPACE_BUNDLE_MAX_ATTACHMENTS,
  WORKSPACE_BUNDLE_MAX_ATTEMPTS,
  WORKSPACE_BUNDLE_MAX_EVIDENCE_BYTES,
  WORKSPACE_BUNDLE_MAX_EVIDENCE_FILES,
  WORKSPACE_BUNDLE_MAX_EXCERPTS,
  WORKSPACE_BUNDLE_MAX_FINDINGS,
  WORKSPACE_BUNDLE_MAX_LEADS,
  WORKSPACE_BUNDLE_MAX_OBJECTIVES,
  WORKSPACE_BUNDLE_MAX_SECRETS,
  workspaceBundleRawBytes,
  type WorkspaceBundle,
  type WorkspaceBundleSummary,
} from "@stonehush/contracts";

/**
 * Portable bundle rules (stone-9).
 * Pure helpers for the export/import boundary: record summaries, transport
 * bounds from metadata alone, and the id remapping plan that keeps every
 * import an independent engagement. No I/O, no id generation.
 */

export function summarizeWorkspaceBundle(
  bundle: Pick<
    WorkspaceBundle,
    | "leads"
    | "attempts"
    | "excerpts"
    | "attachments"
    | "findings"
    | "evidence"
    | "secrets"
    | "objectives"
    | "privateCopy"
  >,
): WorkspaceBundleSummary {
  return {
    leads: bundle.leads.length,
    attempts: bundle.attempts.length,
    excerpts: bundle.excerpts.length,
    attachments: bundle.attachments.length,
    findings: bundle.findings.length,
    evidence: bundle.evidence.length,
    secrets: bundle.secrets.length,
    objectives: bundle.objectives.length,
    privateCopy: bundle.privateCopy,
  };
}

export type BundleBoundsErrorCode = "bundle_too_large";

// Bounds from metadata only, so an oversized bundle is refused before any
// content byte is decoded or stored.
export function checkWorkspaceBundleBounds(bundle: Pick<
  WorkspaceBundle,
  | "leads"
  | "attempts"
  | "excerpts"
  | "attachments"
  | "findings"
  | "evidence"
  | "secrets"
  | "objectives"
>): { ok: true } | { ok: false; code: BundleBoundsErrorCode } {
  if (
    bundle.leads.length > WORKSPACE_BUNDLE_MAX_LEADS ||
    bundle.attempts.length > WORKSPACE_BUNDLE_MAX_ATTEMPTS ||
    bundle.excerpts.length > WORKSPACE_BUNDLE_MAX_EXCERPTS ||
    bundle.attachments.length > WORKSPACE_BUNDLE_MAX_ATTACHMENTS ||
    bundle.findings.length > WORKSPACE_BUNDLE_MAX_FINDINGS ||
    bundle.evidence.length > WORKSPACE_BUNDLE_MAX_EVIDENCE_FILES ||
    bundle.secrets.length > WORKSPACE_BUNDLE_MAX_SECRETS ||
    bundle.objectives.length > WORKSPACE_BUNDLE_MAX_OBJECTIVES
  ) {
    return { ok: false, code: "bundle_too_large" };
  }
  if (
    workspaceBundleRawBytes(bundle.evidence) > WORKSPACE_BUNDLE_MAX_EVIDENCE_BYTES
  ) {
    return { ok: false, code: "bundle_too_large" };
  }
  return { ok: true };
}

// Zip old ids to fresh ones. Length mismatch fails closed: every carried
// record must have exactly one new identity, so a repeated import can never
// reuse an id from an earlier import.
export function planIdRemap(
  oldIds: readonly string[],
  newIds: readonly string[],
): ReadonlyMap<string, string> | undefined {
  if (oldIds.length !== newIds.length) return undefined;
  const remap = new Map<string, string>();
  for (let index = 0; index < oldIds.length; index += 1) {
    const oldId = oldIds[index] as string;
    const newId = newIds[index] as string;
    if (remap.has(oldId)) return undefined;
    remap.set(oldId, newId);
  }
  return remap;
}

// Rewrite stored references through the remap. Unknown ids pass through
// unchanged: reference lists are advisory and must never block an import
// that already verified every carried byte.
export function remapStoredRefs(
  ids: readonly string[],
  remap: ReadonlyMap<string, string>,
): string[] {
  return ids.map((id) => remap.get(id) ?? id);
}
