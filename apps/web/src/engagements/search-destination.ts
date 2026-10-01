import {
  ENGAGEMENT_SEARCH_QUERY_MAX_CHARS,
  type EngagementSearchResult,
  type Finding,
} from "@stonehush/contracts";
import { findMatchOffset, searchCorpus } from "@stonehush/domain";

// Search notes and findings: query bounds, result anchors, and the exact
// destinations a result may open. Only `note:notes@<offset>` and
// `finding:<id>` anchors become destinations. Other anchors are not exact
// enough to open and never reach this workflow.

export const SEARCH_QUERY_MIN_CODE_POINTS = 2;

export type SearchInput =
  | { readonly status: "short" }
  | { readonly status: "long" }
  | { readonly status: "ready"; readonly query: string };

/** Bounds count Unicode code points of the trimmed text, like the API. */
export function parseSearchInput(raw: string): SearchInput {
  const query = raw.trim();
  const points = Array.from(query).length;
  if (points < SEARCH_QUERY_MIN_CODE_POINTS) return { status: "short" };
  if (points > ENGAGEMENT_SEARCH_QUERY_MAX_CHARS) return { status: "long" };
  return { status: "ready", query };
}

export type SearchTarget =
  | { readonly kind: "note"; readonly codePointOffset: number }
  | { readonly kind: "finding"; readonly findingId: string };

/** Exact target for a note or finding result, or null when the anchor is not exact. */
export function parseSearchTarget(result: EngagementSearchResult): SearchTarget | null {
  if (result.kind === "note") {
    const match = /^note:notes@(\d+)$/.exec(result.anchor);
    if (match === null || result.id !== "notes" || !Number.isSafeInteger(Number(match[1]))) return null;
    return { kind: "note", codePointOffset: Number(match[1]) };
  }
  if (result.kind === "finding") {
    if (result.anchor !== `finding:${result.id}`) return null;
    return { kind: "finding", findingId: result.id };
  }
  return null;
}

/** One-shot destination handed from the search dialog to Notes or Findings. */
export type SearchDestination =
  | {
      readonly kind: "note";
      readonly nonce: number;
      readonly engagementId: string;
      readonly query: string;
      readonly result: EngagementSearchResult;
      readonly codePointOffset: number;
    }
  | {
      readonly kind: "finding";
      readonly nonce: number;
      readonly engagementId: string;
      readonly query: string;
      readonly result: EngagementSearchResult;
      readonly findingId: string;
    };

export type NoteSearchDestination = Extract<SearchDestination, { kind: "note" }>;
export type FindingSearchDestination = Extract<SearchDestination, { kind: "finding" }>;

/** UTF-16 index of a code-point offset, or null when the text is shorter. */
export function codePointToUtf16Offset(text: string, codePointOffset: number): number | null {
  let units = 0;
  let points = 0;
  for (const character of text) {
    if (points === codePointOffset) return units;
    units += character.length;
    points += 1;
  }
  return points === codePointOffset ? units : null;
}

export type NotePassage =
  | {
      readonly status: "exact";
      /** UTF-16 range of the match inside the saved notes text. */
      readonly start: number;
      readonly end: number;
      /** 1-based line of the match start. */
      readonly line: number;
    }
  /** The saved text no longer holds the searched passage at its offset. */
  | { readonly status: "changed" }
  /** The query matched the notes title, so the result names no passage. */
  | { readonly status: "title" };

/** Rebuild the selected search signature with the same corpus rules as the API. */
export function sameSearchResult(current: EngagementSearchResult | undefined, selected: EngagementSearchResult): boolean {
  return current !== undefined && current.kind === selected.kind && current.id === selected.id &&
    current.anchor === selected.anchor && current.title === selected.title &&
    current.snippet === selected.snippet && current.unindexed === selected.unindexed;
}

export function resolveFindingMatch(finding: Finding, destination: FindingSearchDestination): boolean {
  if (finding.id !== destination.findingId || finding.engagementId !== destination.engagementId) return false;
  const current = searchCorpus([{ kind: "finding", id: finding.id, title: finding.title,
    text: finding.body, anchor: `finding:${finding.id}` }], destination.query).results[0];
  return sameSearchResult(current, destination.result);
}

export function resolveNotePassage(input: {
  readonly saved: string;
  readonly result: EngagementSearchResult;
  readonly query: string;
  readonly codePointOffset: number;
}): NotePassage {
  if (input.saved.length === 0) return { status: "changed" };
  const title = "Engagement notes";
  const titlePoints = Array.from(title).length;
  const haystack = `${title}\n${input.saved}`;
  const first = findMatchOffset(haystack, input.query);
  if (first === null) return { status: "changed" };
  const offset = first.index <= titlePoints ? 0 : first.index - titlePoints - 1;
  const current = searchCorpus([{ kind: "note", id: "notes", title, text: input.saved,
    anchor: `note:notes@${offset}` }], input.query).results[0];
  if (!sameSearchResult(current, input.result) || offset !== input.codePointOffset) return { status: "changed" };
  if (first.index <= titlePoints) return { status: "title" };
  const start = codePointToUtf16Offset(input.saved, offset);
  const range = sourceMatchRange(haystack, input.query);
  if (start === null || range === null) return { status: "changed" };
  return { status: "exact", start, end: range.end - title.length - 1,
    line: input.saved.slice(0, start).split("\n").length };
}

/** Map the folded match back to source units, including lowercase expansions. */
function sourceMatchRange(text: string, query: string): { start: number; end: number } | null {
  const found = findMatchOffset(text, query);
  if (found === null) return null;
  const fold = (value: string) => value.toLowerCase().replace(/ς/g, "σ");
  const needle = fold(query.trim());
  const foldedEnd = fold(text).indexOf(needle) + needle.length;
  let foldedUnits = 0;
  let sourceUnits = 0;
  for (const point of text) {
    foldedUnits += point.toLowerCase().length;
    sourceUnits += point.length;
    if (foldedUnits >= foldedEnd) break;
  }
  const start = codePointToUtf16Offset(text, found.index);
  return start === null ? null : { start, end: sourceUnits };
}

export interface HighlightedText {
  readonly before: string;
  readonly match: string;
  readonly after: string;
}

/** Split text around the first case-insensitive query match for display. */
export function highlightMatch(text: string, query: string): HighlightedText {
  const range = sourceMatchRange(text, query);
  if (range === null) return { before: text, match: "", after: "" };
  return { before: text.slice(0, range.start), match: text.slice(range.start, range.end), after: text.slice(range.end) };
}

/**
 * The saved line holding a passage, clipped to a readable window around
 * the match by code point so surrogate pairs stay whole.
 */
export function passageLine(saved: string, start: number, end: number): HighlightedText {
  const lineStart = start === 0 ? 0 : saved.lastIndexOf("\n", start - 1) + 1;
  const newline = saved.indexOf("\n", end);
  const lineEnd = newline < 0 ? saved.length : newline;
  const before = Array.from(saved.slice(lineStart, start));
  const after = Array.from(saved.slice(end, lineEnd));
  return {
    before: (before.length > 80 ? "..." : "") + before.slice(-80).join(""),
    match: saved.slice(start, end),
    after: after.slice(0, 160).join("") + (after.length > 160 ? "..." : ""),
  };
}
