import type { ReportBundle } from "@blackglass/contracts";

import { maskReportBundle } from "./report-mask.js";
import {
  renderOutlineMarkdown,
  type OutlineMaterial,
  type ReportOutline,
} from "./report-outline.js";

/**
 * Sharing preview and portable bundle (STONE-7).
 * The sharing preview shows the exact inclusion before anything leaves the
 * machine: entry captions and filenames, with scratchpad, secret values,
 * note history, and raw artifact bytes out by default. Raw artifacts need
 * an explicit opt-in. The portable workspace bundle is a distinct manifest
 * for moving work between machines, not a client report.
 */

export interface SharingOptions {
  readonly maskSecrets: boolean;
  readonly includeRawArtifacts: boolean;
  readonly includeNoteHistory: boolean;
  readonly includeScratchpad: boolean;
}

export const DEFAULT_SHARING_OPTIONS: SharingOptions = {
  maskSecrets: true,
  includeRawArtifacts: false,
  includeNoteHistory: false,
  includeScratchpad: false,
};

export interface SharingEntry {
  readonly caption: string;
  readonly filename?: string;
}

export interface SharingPreview {
  readonly included: readonly SharingEntry[];
  readonly excluded: readonly string[];
  readonly markdown: string;
  readonly maskedFields: number;
}

export interface SharingInput {
  readonly bundle: ReportBundle;
  readonly outline: ReportOutline;
  readonly options?: Partial<SharingOptions>;
}

function toMaterial(bundle: ReportBundle): OutlineMaterial {
  return {
    findings: bundle.findings,
    evidence: bundle.evidenceArtifacts.rows.map((artifact) => ({
      artifactId: artifact.artifactId,
      digest: artifact.digest,
    })),
    notesMarkdown: bundle.notesMarkdown,
  };
}

// One builder feeds the on-screen preview and the downloaded artifact, so
// the preview always matches the file exactly.
export function buildSharingPreview(input: SharingInput): SharingPreview {
  const options: SharingOptions = { ...DEFAULT_SHARING_OPTIONS, ...input.options };
  const masked = options.maskSecrets ? maskReportBundle(input.bundle) : null;
  const view = masked?.bundle ?? input.bundle;
  const markdown = renderOutlineMarkdown(toMaterial(view), input.outline);
  const included: SharingEntry[] = [];
  for (const item of input.outline.items) {
    if (item.kind === "finding") {
      const finding = view.findings.find((entry) => entry.id === item.refId);
      included.push({
        caption: finding === undefined ? `Finding ${item.refId} (missing)` : `Finding: ${finding.title}`,
      });
    } else if (item.kind === "lead") {
      included.push({ caption: `Lead: ${item.caption}` });
    } else if (item.kind === "evidence") {
      included.push(
        options.includeRawArtifacts
          ? { caption: `Raw artifact ${item.refId}`, filename: `assets/${item.refId}` }
          : { caption: `Evidence digest for ${item.refId} (bytes excluded)` },
      );
    } else {
      included.push({ caption: "Engagement notes excerpt" });
    }
  }
  const excluded: string[] = [
    "Scratchpad drafts are never part of a report.",
    options.maskSecrets
      ? `Secret-shaped values masked (${masked?.maskedFields ?? 0} fields). Heuristic only.`
      : "Secret masking OFF: the export contains original stored text.",
    "Note history is never exported; only the current notes text.",
  ];
  if (!options.includeRawArtifacts) {
    excluded.push("Raw artifact bytes excluded; enable explicitly to include them.");
  }
  if (!options.includeNoteHistory) {
    excluded.push("Note history excluded.");
  }
  if (!options.includeScratchpad) {
    excluded.push("Scratchpad excluded.");
  }
  return {
    included,
    excluded,
    markdown,
    maskedFields: masked?.maskedFields ?? 0,
  };
}

// The exact artifact bytes for the preview above. Same string, no second
// renderer, so preview and export cannot drift.
export function exportSharingMarkdown(preview: SharingPreview): string {
  return preview.markdown;
}

export interface PortableBundleManifest {
  readonly kind: "blackglass-portable-bundle-v1";
  readonly engagementId: string;
  readonly generatedAt: string;
  readonly template: string;
  readonly outlineKeys: readonly string[];
  readonly findingIds: readonly string[];
  readonly evidence: readonly { readonly artifactId: string; readonly digest: string }[];
  readonly notesIncluded: boolean;
  readonly excludes: readonly string[];
}

// Portable workspace bundle: a manifest for moving work, distinct from the
// client-facing report markdown. Digests only, never secret values, scratch
// history, or ambient state.
export function buildPortableBundleManifest(input: SharingInput): PortableBundleManifest {
  return {
    kind: "blackglass-portable-bundle-v1",
    engagementId: input.bundle.engagement.id,
    generatedAt: input.bundle.generatedAt,
    template: input.outline.template,
    outlineKeys: input.outline.items.map((item) => item.key),
    findingIds: input.outline.items
      .filter((item) => item.kind === "finding")
      .map((item) => item.refId),
    evidence: input.bundle.evidenceArtifacts.rows.map((artifact) => ({
      artifactId: artifact.artifactId,
      digest: artifact.digest,
    })),
    notesIncluded: input.outline.items.some((item) => item.kind === "note"),
    excludes: [
      "scratchpad",
      "secret values",
      "note history",
      "raw artifact bytes (referenced by digest)",
      "advisor turn history",
    ],
  };
}
