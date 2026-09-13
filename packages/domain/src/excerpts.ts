import { ADVISOR_REDACTION_TOKEN, containsPrivateKeyBeginMarker, containsPrivateKeyEndMarker, findAdvisorSecretSpans, findUnterminatedPrivateKeyStarts, redactAdvisorText } from "./advisor-redact.js";
import type { Excerpt } from "@stonehush/contracts";

/**
 * Pure excerpt helpers for the STONE-3 fast-capture slice. Byte ranges are
 * validated against the stored artifact size so invented offsets can never
 * address bytes outside the preserved source. Secret masking reuses the
 * shared advisor redactor: excerpt content, search snippets, and finding
 * prefill text all pass through it before persistence or display.
 */

export const EXCERPT_RANGE_MAX_BYTES = 8_192 as const;
export const EXCERPT_SNIPPET_RADIUS_CHARS = 160 as const;
// Bytes of original evidence read on each side of a requested excerpt range
// so redaction sees secret wrappers the selection alone would strip. 8192
// covers the widest bounded policy shape (4096-char key blocks plus
// markers) with margin; unbounded token values rely on the token-continuity
// check below when this window is cut short of the artifact edge.
export const EXCERPT_REDACTION_CONTEXT_BYTES = 8_192 as const;
// Chars of already-scanned output kept on each side of a search snippet for
// the same purpose. Snippets reuse this projection, never narrow masking.
export const EXCERPT_REDACTION_CONTEXT_CHARS = 8_192 as const;

export function validateExcerptRange(
  totalBytes: number,
  byteOffset: number,
  byteLength: number,
): { ok: true } | { ok: false; code: "range_rejected" } {
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes < 0 ||
    !Number.isSafeInteger(byteOffset) ||
    byteOffset < 0 ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 1 ||
    byteLength > EXCERPT_RANGE_MAX_BYTES
  ) {
    return { ok: false, code: "range_rejected" };
  }
  if (byteOffset + byteLength > totalBytes) {
    return { ok: false, code: "range_rejected" };
  }
  return { ok: true };
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

// Maps a char range inside displayed text to UTF-8 byte offsets for the
// server range request. Out-of-order or empty selections are rejected so a
// misclick can never produce a zero-length excerpt. When the displayed text
// contains a replacement character before the selection end, the original
// bytes may have been invalid UTF-8 (one source byte decoding to U+FFFD,
// which re-encodes to three bytes). Without the original bytes the exact
// mapping is unavailable, so the range is rejected rather than risking
// offsets that point at other evidence.
export function selectionBytesFromText(
  fullText: string,
  charStart: number,
  charEnd: number,
):
  | { ok: true; byteOffset: number; byteLength: number }
  | { ok: false; code: "range_rejected" } {
  const points = Array.from(fullText).length;
  if (
    !Number.isSafeInteger(charStart) ||
    !Number.isSafeInteger(charEnd) ||
    charStart < 0 ||
    charEnd <= charStart ||
    charEnd > points
  ) {
    return { ok: false, code: "range_rejected" };
  }
  const chars = Array.from(fullText);
  if (chars.slice(0, charEnd).join("").includes("�")) {
    return { ok: false, code: "range_rejected" };
  }
  const byteOffset = utf8ByteLength(chars.slice(0, charStart).join(""));
  const byteLength = utf8ByteLength(chars.slice(charStart, charEnd).join(""));
  if (byteLength < 1 || byteLength > EXCERPT_RANGE_MAX_BYTES) {
    return { ok: false, code: "range_rejected" };
  }
  return { ok: true, byteOffset, byteLength };
}

export interface MaskedExcerptText {
  readonly text: string;
  readonly redactions: number;
}

// Masked before persistence or display. The redactor is heuristic
// defense-in-depth, documented in advisor-redact.ts; structural bounds are
// the primary boundary.
export function maskExcerptText(value: string): MaskedExcerptText {
  const result = redactAdvisorText(value);
  return { text: result.text, redactions: result.redactions };
}

// Characters that can continue a secret token value (bearer material, sk
// values, base64 key bodies, long hashes, percent-encoded bytes). Pattern
// syntax such as braces, quotes, whitespace, and replacement characters are
// not in this class, so they always count as boundaries. Colons stay out:
// `host:port` and timestamp keeps must not read as token continuations.
const SECRET_CONTINUATION_PATTERN = /^[A-Za-z0-9\-_.~+/=%]$/;

export function isSecretContinuationChar(char: string): boolean {
  return SECRET_CONTINUATION_PATTERN.test(char);
}

// True when a truncated lookback cannot prove the selection starts at a
// safe boundary: the char before the selection and the first selected char
// are both token characters, so a secret prefix (for example `bearer ` or
// `sk-`) may sit beyond the visible window. Callers reject the range rather
// than risk persisting an inner slice of a secret value.
export function selectionStartsMidToken(prefixText: string, requestedText: string): boolean {
  const prefixPoints = Array.from(prefixText);
  const requestedPoints = Array.from(requestedText);
  if (prefixPoints.length === 0 || requestedPoints.length === 0) return false;
  const before = prefixPoints[prefixPoints.length - 1];
  const first = requestedPoints[0];
  if (before === undefined || first === undefined) return false;
  return isSecretContinuationChar(before) && isSecretContinuationChar(first);
}

// True when a cut lookback cannot rule out a hidden assignment key. The
// credential pattern spans arbitrary whitespace between key and value, so a
// key such as `password` may sit beyond the truncated window while the
// selection holds only the value side (`password` + 9000 spaces +
// `=hunter2` keeping `=hunter2`, or keeping `hunter2` right after a visible
// `=`). Neither the mid-token check nor span projection can see the key,
// and narrow masking alone persists the value raw. Callers reject rather
// than guess. Four shapes count as value-side, mirroring the policy's own
// assignment operators: a selection opening with `=`-led or `:`-led value
// syntax (JSON `"key": "value"` keeping `: "value"`), a value starting
// immediately after a visible `=` or `:` (`"key":"value"` keeping
// `value`), and a quoted value after a spaced separator (`"key": "value"`
// keeping `"value"`). Bare values after a spaced separator (`count = 42`
// keeping `42`) carry no assignment shape of their own and stay allowed:
// without the key they are indistinguishable from ordinary evidence, and
// the full-context policy itself needs the key to recognize them. That
// line keeps ordinary evidence working; widening a rejected selection left
// to a boundary fixes it.
export function selectionLooksLikeHiddenAssignmentValue(
  prefixText: string,
  requestedText: string,
): boolean {
  if (/^\s*=\s*\S/.test(requestedText)) return true;
  if (/^\s*:\s*\S/.test(requestedText)) return true;
  if (/[:=]$/.test(prefixText) && /^\S/.test(requestedText)) return true;
  if (/[:=]\s+$/.test(prefixText) && /^["']/.test(requestedText)) return true;
  // Whole-window gap: the full bounded lookback holds only whitespace
  // (plus one optional trailing separator) while the selection is
  // value-shaped. No key candidate is visible, so an assignment key may sit
  // beyond the cut no matter which side the separator fell on. Callers only
  // invoke this with a full cut lookback, where the precondition holds.
  // Ordinary keeps always show non-whitespace inside 8192 bytes.
  if (/^["']?\S/.test(requestedText) && /^[\s\uFFFD]*[:=]*[\s\uFFFD]*$/.test(prefixText)) {
    return true;
  }
  return false;
}

// True when the selection holds a private-key END marker but no BEGIN
// marker: the block's head sits beyond a cut lookback, so no span can cover
// the body and narrow masking persists it raw. Selections holding a
// complete block (both markers) mask through the block span instead.
export function selectionHasDanglingKeyEnd(requestedText: string): boolean {
  return (
    containsPrivateKeyEndMarker(requestedText) && !containsPrivateKeyBeginMarker(requestedText)
  );
}

export interface SelectionMaskProjection {
  readonly text: string;
  readonly redactions: number;
  readonly overlapped: boolean;
}

// Masks a requested char range using secret spans found in a wider expanded
// context. Offsets are code points, matching findTextMatches and theSnippet
// windowing. Policy patterns cap some values (credential assignments at 256
// chars), so each span extends rightward while token characters continue: a
// selection past the cap is still the same secret value and must mask, not
// persist verbatim. Extension only ever masks more; ordinary text beside a
// boundary still passes through narrow masking unchanged. A private-key
// BEGIN marker with no END after it extends to the context end when
// truncatedAfter is set: the block may continue past the visible window,
// and a body-line selection would otherwise persist raw. Callers pass
// truncatedAfter only when more bytes exist beyond the context; a dangling
// BEGIN in fully visible text is a policy miss too, so extending there
// would mask ordinary trailing text the policy leaves alone.
// Non-overlapping selections come back byte-identical to narrow masking;
// overlapping ones keep ordinary prefix and suffix text while each
// contiguous secret overlap becomes one redaction token. Never invents
// bytes: output derives only from the requested substring.
export function projectMaskedSelection(
  expandedText: string,
  requestedStart: number,
  requestedLength: number,
  truncatedAfter = false,
): SelectionMaskProjection {
  const points = Array.from(expandedText);
  const start = Math.max(0, requestedStart);
  const end = Math.min(points.length, start + Math.max(0, requestedLength));
  const requestedPoints = points.slice(start, end);
  const requestedText = requestedPoints.join("");
  const toCodePoints = (utf16: number): number =>
    Array.from(expandedText.slice(0, Math.max(0, utf16))).length;
  const overlaps: { start: number; end: number }[] = [];
  for (const span of findAdvisorSecretSpans(expandedText)) {
    let spanEnd = toCodePoints(span.end);
    while (spanEnd < points.length && isSecretContinuationChar(points[spanEnd] ?? "")) {
      spanEnd += 1;
    }
    const spanStart = toCodePoints(span.start);
    const clipStart = Math.max(spanStart, start) - start;
    const clipEnd = Math.min(spanEnd, end) - start;
    if (clipEnd > clipStart) overlaps.push({ start: clipStart, end: clipEnd });
  }
  if (truncatedAfter) {
    for (const begin of findUnterminatedPrivateKeyStarts(expandedText)) {
      const beginStart = toCodePoints(begin);
      const clipStart = Math.max(beginStart, start) - start;
      const clipEnd = end - start;
      if (clipEnd > clipStart) overlaps.push({ start: clipStart, end: clipEnd });
    }
  }
  overlaps.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: { start: number; end: number }[] = [];
  for (const region of overlaps) {
    const last = merged[merged.length - 1];
    if (last !== undefined && region.start <= last.end) {
      if (region.end > last.end) last.end = region.end;
    } else {
      merged.push({ start: region.start, end: region.end });
    }
  }
  if (overlaps.length === 0) {
    const narrow = redactAdvisorText(requestedText);
    return { text: narrow.text, redactions: narrow.redactions, overlapped: false };
  }
  let text = "";
  let redactions = 0;
  let cursor = 0;
  for (const region of merged) {
    if (region.start > cursor) {
      const plain = requestedPoints.slice(cursor, region.start).join("");
      const masked = redactAdvisorText(plain);
      text += masked.text;
      redactions += masked.redactions;
    }
    text += ADVISOR_REDACTION_TOKEN;
    redactions += 1;
    cursor = region.end;
  }
  if (cursor < requestedPoints.length) {
    const plain = requestedPoints.slice(cursor).join("");
    const masked = redactAdvisorText(plain);
    text += masked.text;
    redactions += masked.redactions;
  }
  return { text, redactions, overlapped: true };
}

export interface TextMatch {
  readonly charOffset: number;
  readonly charLength: number;
}

// Case-insensitive non-overlapping substring search over decoded text.
// Empty queries match nothing; the route rejects them as invalid_request.
// Offsets are reported in original coordinates: the search runs against the
// original string with a case-insensitive pattern, so Unicode case
// expansions (for example U+0130 lowercasing to two code points) cannot
// shift the reported match into other evidence. The matched length comes
// from the original substring, not the query.
function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findTextMatches(
  haystack: string,
  query: string,
  maxMatches: number,
): TextMatch[] {
  if (query.length === 0 || maxMatches < 1) return [];
  let pattern: RegExp;
  try {
    pattern = new RegExp(escapeRegExpLiteral(query), "giu");
  } catch {
    return [];
  }
  const matches: TextMatch[] = [];
  for (;;) {
    if (matches.length >= maxMatches) break;
    const found = pattern.exec(haystack);
    if (found === null) break;
    if (found[0].length === 0) {
      pattern.lastIndex += 1;
      continue;
    }
    matches.push({
      charOffset: Array.from(haystack.slice(0, found.index)).length,
      charLength: Array.from(found[0]).length,
    });
  }
  return matches;
}

export interface TextSnippet {
  readonly snippet: string;
  readonly truncatedBefore: boolean;
  readonly truncatedAfter: boolean;
}

// Bounded window centered on a match so long output is excerptable without
// rendering the whole file. Boundaries fall on code points, never mid-char.
export function windowSnippetFromChars(
  text: string,
  charOffset: number,
  charLength: number,
  radius: number = EXCERPT_SNIPPET_RADIUS_CHARS,
): TextSnippet {
  const points = Array.from(text);
  const start = Math.max(0, charOffset - radius);
  const end = Math.min(points.length, charOffset + charLength + radius);
  const window = points.slice(start, end).join("");
  const prefix = start > 0 ? "..." : "";
  const suffix = end < points.length ? "..." : "";
  return {
    snippet: `${prefix}${window}${suffix}`,
    truncatedBefore: start > 0,
    truncatedAfter: end < points.length,
  };
}

// Byte offset of a char offset, for reporting server-style match positions
// from decoded scan text. Callers must only pass text decoded from bytes
// already validated as strict UTF-8; otherwise a replacement character from
// malformed input re-encodes to three bytes while occupying one source byte
// and the result points at other evidence. The search route validates with
// a fatal decoder before calling this.
export function byteOffsetOfCharOffset(text: string, charOffset: number): number {
  return utf8ByteLength(Array.from(text).slice(0, Math.max(0, charOffset)).join(""));
}

// Attachment filename derived from what the image proves. Lowercase slug;
// anything unusable falls back to the neutral default so uploads never fail
// on naming alone.
export function deriveAttachmentName(proof: string, fallback: string): string {
  const slug = proof
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128);
  if (slug.length > 0) return slug;
  const fallbackSlug = fallback
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128);
  return fallbackSlug.length > 0 ? fallbackSlug : "evidence-image";
}

export interface CropRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// Display-space crop metadata only; the original bytes are always kept and
// derivation records the parent id, so a crop can never destroy evidence.
export function isCropRectValid(rect: CropRect): boolean {
  for (const value of [rect.x, rect.y, rect.width, rect.height]) {
    if (!Number.isSafeInteger(value) || value < 0) return false;
  }
  if (rect.width < 1 || rect.height < 1) return false;
  if (rect.width > 100_000 || rect.height > 100_000) return false;
  return true;
}

function shortId(value: string): string {
  return value.length <= 8 ? value : value.slice(0, 8);
}

function shortDigest(digest: string): string {
  const hex = digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
  return hex.slice(0, 12);
}

export function formatExcerptSourceLabel(excerpt: Pick<
  Excerpt,
  "runId" | "stream" | "byteOffset" | "byteLength" | "artifactId" | "artifactDigest"
>): string {
  return `run ${shortId(excerpt.runId)} ${excerpt.stream} @${excerpt.byteOffset}+${excerpt.byteLength} (${excerpt.artifactId}, ${shortDigest(excerpt.artifactDigest)})`;
}

// Finding prefill shared by the web layer. Target context is the operator
// annotation when present and labelled as such; the stable server-verified
// reference (run, stream, offsets, artifact id, digest) is always included
// so the finding never depends on retyping or an artifact-ID field.
export function buildFindingPrefillBody(
  excerpt: Pick<
    Excerpt,
    "runId" | "stream" | "byteOffset" | "byteLength" | "artifactId" | "artifactDigest" | "content" | "targetNote"
  >,
): string {
  const lines = [
    `Source: ${formatExcerptSourceLabel(excerpt)}`,
    excerpt.targetNote === null
      ? "Target: operator note unavailable"
      : `Target (operator note): ${excerpt.targetNote}`,
    "Excerpt:",
    excerpt.content,
  ];
  return lines.join("\n");
}
