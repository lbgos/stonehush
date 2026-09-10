import { redactAdvisorText } from "@blackglass/domain";
import type { Finding } from "@blackglass/contracts";

import type { ReportOutline } from "./report-outline.js";

/**
 * Report review panel (STONE-7).
 * A finishing aid, not a compliance form: flags selected findings with
 * missing proof, ambiguous reproduction, unsupported high-severity claims,
 * and accidental sensitive material. Detection reuses the existing
 * heuristic advisor redactor (consumed, never modified), so secret flags
 * are best-effort and say so.
 */

export const REVIEW_CODES = [
  "missing-proof",
  "ambiguous-repro",
  "unsupported-claim",
  "possible-secret",
] as const;

export type ReviewCode = (typeof REVIEW_CODES)[number];

export interface ReviewFlag {
  readonly code: ReviewCode;
  readonly itemKey: string | null;
  readonly detail: string;
}

// Absolute impact language that needs evidence behind it.
const IMPACT_PATTERN =
  /\b(remote code execution|\brce\b|privilege escalation|domain takeover|account takeover|always|never|all hosts|complete compromise)\b/i;

// Explicit reproduction markers: ordered lists, bullets, or code spans.
const REPRO_MARKER_PATTERN = /(^|\n)\s*(\d+[.)]|[-*]|```|`[^`]+`)/;

export interface ReviewInput {
  readonly outline: ReportOutline;
  readonly findings: readonly Finding[];
  readonly notesMarkdown: string;
}

function hasSecret(value: string): boolean {
  return redactAdvisorText(value).redactions > 0;
}

export function reviewOutline(input: ReviewInput): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  const selectedFindings = input.outline.items.filter((item) => item.kind === "finding");
  for (const item of selectedFindings) {
    const finding = input.findings.find((entry) => entry.id === item.refId);
    if (finding === undefined) {
      flags.push({
        code: "missing-proof",
        itemKey: item.key,
        detail: `Selected finding ${item.refId} is no longer available; remove it or reselect.`,
      });
      continue;
    }
    if (finding.evidenceArtifactIds.length === 0) {
      flags.push({
        code: "missing-proof",
        itemKey: item.key,
        detail: `Finding "${finding.title}" cites no evidence artifacts.`,
      });
    }
    if (
      (finding.severity === "high" || finding.severity === "critical") &&
      finding.evidenceArtifactIds.length === 0 &&
      IMPACT_PATTERN.test(finding.body)
    ) {
      flags.push({
        code: "unsupported-claim",
        itemKey: item.key,
        detail: `Finding "${finding.title}" makes an absolute impact claim with no cited evidence.`,
      });
    }
    if (finding.body.trim().length > 0 && !REPRO_MARKER_PATTERN.test(finding.body)) {
      flags.push({
        code: "ambiguous-repro",
        itemKey: item.key,
        detail: `Finding "${finding.title}" has no explicit reproduction steps (ordered list, bullets, or commands).`,
      });
    }
    if (hasSecret(finding.title) || hasSecret(finding.body)) {
      flags.push({
        code: "possible-secret",
        itemKey: item.key,
        detail: `Finding "${finding.title}" may contain sensitive material; mask or remove it before sharing. Heuristic only.`,
      });
    }
  }
  const notesSelected = input.outline.items.some((item) => item.kind === "note");
  if (notesSelected && hasSecret(input.notesMarkdown)) {
    flags.push({
      code: "possible-secret",
      itemKey: null,
      detail: "Selected notes may contain sensitive material; mask or remove it before sharing. Heuristic only.",
    });
  }
  return flags;
}
