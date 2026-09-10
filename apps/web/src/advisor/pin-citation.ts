import { isSupportedCheck } from "@blackglass/domain";
import type { AdvisorPartitionedCitation } from "@blackglass/contracts";

/**
 * Pin-with-citations and prefilled-action handoff (STONE-7).
 * A useful answer paragraph pins into a note draft or a lead draft with its
 * citations attached, and a supported check becomes a prefilled argv action
 * so the operator never retypes prose. Unsupported commands never produce
 * runnable output: they stay plain text. Lead drafts use a narrow
 * structural interface; the STONE-4 lead API can adopt it without further
 * translation.
 */

export interface PinnedParagraph {
  readonly text: string;
  readonly citations: readonly AdvisorPartitionedCitation[];
}

export interface NoteDraft {
  readonly body: string;
}

export interface LeadDraft {
  readonly title: string;
  readonly narrative: string;
  readonly artifactIds: readonly string[];
  readonly findingIds: readonly string[];
  readonly sourceQuestion: string;
}

export type PrefilledAction =
  | { readonly ok: true; readonly argv: readonly string[]; readonly label: string }
  | { readonly ok: false; readonly reason: string };

const PARAGRAPH_MAX = 32;

function citationRefs(paragraph: PinnedParagraph): {
  readonly artifacts: readonly string[];
  readonly findings: readonly string[];
  readonly unverified: readonly string[];
} {
  const artifacts: string[] = [];
  const findings: string[] = [];
  const unverified: string[] = [];
  for (const citation of paragraph.citations) {
    if (!citation.valid) {
      unverified.push(citation.raw);
    } else if (citation.kind === "artifact") {
      artifacts.push(citation.raw);
    } else if (citation.kind === "finding") {
      findings.push(citation.raw);
    }
  }
  return { artifacts, findings, unverified };
}

function sourcesLine(paragraph: PinnedParagraph): string {
  const { artifacts, findings, unverified } = citationRefs(paragraph);
  const parts: string[] = [];
  for (const id of artifacts) parts.push(`artifact ${id}`);
  for (const id of findings) parts.push(`finding ${id}`);
  for (const raw of unverified) parts.push(`unverified ${raw}`);
  if (parts.length === 0) return "";
  return `\n\nSources: ${parts.join(", ")}.`;
}

// Split a stored answer into pinnable paragraphs on blank lines. Bounded
// so pathological answers cannot flood the UI.
export function splitAnswerParagraphs(answer: string): string[] {
  return answer
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .slice(0, PARAGRAPH_MAX);
}

export function pinParagraphToNote(
  paragraph: PinnedParagraph,
  sourceQuestion: string,
): NoteDraft {
  return {
    body: `${paragraph.text}${sourcesLine(paragraph)}\n\nAdvisor question: ${sourceQuestion}`,
  };
}

export function pinParagraphToLead(
  paragraph: PinnedParagraph,
  sourceQuestion: string,
): LeadDraft {
  const { artifacts, findings } = citationRefs(paragraph);
  const firstLine = paragraph.text.split("\n")[0] ?? paragraph.text;
  const title =
    Array.from(firstLine).length > 120
      ? `${Array.from(firstLine).slice(0, 117).join("")}...`
      : firstLine;
  return {
    title,
    narrative: `${paragraph.text}${sourcesLine(paragraph)}`,
    artifactIds: artifacts,
    findingIds: findings,
    sourceQuestion,
  };
}

// A supported single-line check becomes prefilled argv. Anything else is
// refused with a reason so the UI renders it as inert text, never as a
// runnable action.
export function toPrefilledAction(command: string): PrefilledAction {
  if (!isSupportedCheck(command)) {
    return {
      ok: false,
      reason: "Not a runnable check: keep as prose, do not execute.",
    };
  }
  const argv = command.trim().split(/\s+/);
  return { ok: true, argv, label: argv.join(" ") };
}
