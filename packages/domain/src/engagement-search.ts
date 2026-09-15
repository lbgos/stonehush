/**
 * STONE-6 engagement search domain helper. Pure substring search over an
 * injected corpus assembled read-only from existing stores. Secrets are
 * excluded: values matching known secret shapes are never indexed and
 * snippets containing them are redacted. Unindexed material is reported by
 * kind so the UI can label it instead of silently dropping it.
 */

import { ENGAGEMENT_SEARCH_MAX_PER_GROUP } from "@stonehush/contracts";
import type { EngagementSearchResult, EngagementSearchResultKind } from "@stonehush/contracts";

export interface SearchCorpusEntry {
  readonly kind: EngagementSearchResultKind;
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly anchor: string;
  /** True when the source has no excerpt index (label, still searchable by name). */
  readonly unindexed?: boolean;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /flag\{[^}]*\}/gi,
  /AKIA[0-9A-Z]{16}/g,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /bearer\s+[A-Za-z0-9._~+/-]{8,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export const SEARCH_SECRET_REDACTION = "[redacted]" as const;

export function redactSecretsForSnippet(value: string): string {
  let redacted = value;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, SEARCH_SECRET_REDACTION);
  }
  return redacted;
}

function containsSecret(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

export function buildSnippet(text: string, matchIndex: number, matchLength: number): string {
  const points = Array.from(text);
  const startPoint = Math.max(0, matchIndex - 40);
  const endPoint = Math.min(points.length, matchIndex + matchLength + 80);
  const prefix = startPoint > 0 ? "..." : "";
  const suffix = endPoint < points.length ? "..." : "";
  return `${prefix}${points.slice(startPoint, endPoint).join("")}${suffix}`;
}

/**
 * Case-insensitive substring offset in code points (not UTF-16 units), so
 * snippet windows and note anchors stay exact on non-BMP text. Returns the
 * code-point index of the match start and the match length in code points,
 * or null when absent. Case expansion under lowercasing (e.g. Turkish dot)
 * stays approximate; astral-plane text is exact.
 */
export function findMatchOffset(
  haystack: string,
  needle: string,
): { index: number; length: number } | null {
  const trimmed = needle.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  const utf16Index = haystack.toLowerCase().indexOf(trimmed);
  if (utf16Index < 0) return null;
  return {
    index: Array.from(haystack.slice(0, utf16Index)).length,
    length: Array.from(trimmed).length,
  };
}

export interface SearchCorpusOptions {
  readonly perGroupLimit?: number;
}

/**
 * Case-insensitive substring search. Entries whose searchable text holds a
 * secret value are skipped entirely; matching snippets are redacted before
 * return. Results group by kind in corpus order, capped per group.
 */
export function searchCorpus(
  corpus: readonly SearchCorpusEntry[],
  query: string,
  options: SearchCorpusOptions = {},
): { results: EngagementSearchResult[]; unindexedKinds: EngagementSearchResultKind[] } {
  const limit = options.perGroupLimit ?? ENGAGEMENT_SEARCH_MAX_PER_GROUP;
  const needle = query.trim().toLowerCase();
  const results: EngagementSearchResult[] = [];
  const counts = new Map<EngagementSearchResultKind, number>();
  const unindexedKinds = new Set<EngagementSearchResultKind>();
  if (needle.length === 0) return { results, unindexedKinds: [] };
  for (const entry of corpus) {
    if (entry.unindexed === true) unindexedKinds.add(entry.kind);
    if (containsSecret(entry.text) || containsSecret(entry.title)) continue;
    const haystack = `${entry.title}\n${entry.text}`;
    const match = findMatchOffset(haystack, needle);
    if (match === null) continue;
    const used = counts.get(entry.kind) ?? 0;
    if (used >= limit) continue;
    counts.set(entry.kind, used + 1);
    const rawSnippet = buildSnippet(haystack, match.index, match.length);
    results.push({
      kind: entry.kind,
      id: entry.id,
      title: entry.title.slice(0, 300),
      snippet: redactSecretsForSnippet(rawSnippet).slice(0, 500),
      anchor: entry.anchor,
      unindexed: entry.unindexed ?? false,
    });
  }
  return { results, unindexedKinds: [...unindexedKinds] };
}
