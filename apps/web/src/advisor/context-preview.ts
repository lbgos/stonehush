import type { AdvisorPartitionedCitation } from "@blackglass/contracts";

/**
 * Context preview before send (STONE-7).
 * The preview lists exactly what the turn request carries: the question,
 * chosen excerpt ids, and chosen finding ids with titles. Scratchpad text,
 * credential values, secret values, note history, raw artifact bytes, and
 * prior turn history are never part of the request and cannot appear here:
 * pickPreviewContext drops every other key at runtime, so even a caller
 * holding ambient state cannot leak it into the model context.
 */

export interface PreviewExcerpt {
  readonly id: string;
}

export interface PreviewFinding {
  readonly id: string;
  readonly title?: string;
}

export interface ContextPreviewInput {
  readonly question: string;
  readonly excerpts: readonly PreviewExcerpt[];
  readonly findings: readonly PreviewFinding[];
}

export interface ContextPreview {
  readonly lines: readonly string[];
  readonly excerptCount: number;
  readonly findingCount: number;
}

const PREVIEW_ALLOWED_KEYS = new Set(["question", "excerpts", "findings"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Allow-list a raw caller object down to previewable fields. Anything else
// (scratchpad, credentials, secretValues, noteHistory, rawArtifacts,
// history) is dropped, never rendered, never sent.
export function pickPreviewContext(raw: unknown): ContextPreviewInput {
  const fallback: ContextPreviewInput = { question: "", excerpts: [], findings: [] };
  if (!isRecord(raw)) return fallback;
  const picked: Record<string, unknown> = {};
  for (const key of PREVIEW_ALLOWED_KEYS) {
    if (key in raw) picked[key] = raw[key];
  }
  const question = typeof picked["question"] === "string" ? picked["question"] : "";
  const excerpts = Array.isArray(picked["excerpts"])
    ? picked["excerpts"]
        .filter(isRecord)
        .filter((entry) => typeof entry["id"] === "string")
        .map((entry) => ({ id: entry["id"] as string }))
    : [];
  const findings = Array.isArray(picked["findings"])
    ? picked["findings"]
        .filter(isRecord)
        .filter((entry) => typeof entry["id"] === "string")
        .map((entry) => ({
          id: entry["id"] as string,
          ...(typeof entry["title"] === "string" ? { title: entry["title"] } : {}),
        }))
    : [];
  return { question, excerpts, findings };
}

export function buildContextPreview(input: ContextPreviewInput): ContextPreview {
  const lines: string[] = [`Question: ${input.question}`];
  if (input.excerpts.length === 0) {
    lines.push("Excerpts: none selected");
  } else {
    lines.push(`Excerpts (${input.excerpts.length}):`);
    for (const excerpt of input.excerpts) {
      lines.push(`- artifact ${excerpt.id}`);
    }
  }
  if (input.findings.length === 0) {
    lines.push("Findings: none selected");
  } else {
    lines.push(`Findings (${input.findings.length}):`);
    for (const finding of input.findings) {
      lines.push(
        finding.title !== undefined
          ? `- ${finding.title} (${finding.id})`
          : `- ${finding.id}`,
      );
    }
  }
  lines.push("Excluded by default: scratchpad, credentials, note history, raw artifact bytes.");
  return {
    lines,
    excerptCount: input.excerpts.length,
    findingCount: input.findings.length,
  };
}

// Human basis line for a stored turn. Rendered from the turn's own stored
// citations so old answers keep their original basis when live target data
// changes.
export function storedTurnBasis(
  citations: readonly AdvisorPartitionedCitation[],
): string {
  if (citations.length === 0) return "Basis: no cited evidence.";
  const kinds = new Map<string, number>();
  for (const citation of citations) {
    if (!citation.valid) continue;
    kinds.set(citation.kind, (kinds.get(citation.kind) ?? 0) + 1);
  }
  if (kinds.size === 0) return "Basis: no verified citations.";
  const parts: string[] = [];
  for (const [kind, count] of kinds) {
    parts.push(`${count} ${kind}${count === 1 ? "" : "s"}`);
  }
  return `Basis: ${parts.join(", ")}.`;
}
