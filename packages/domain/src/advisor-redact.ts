/**
 * Pure redaction helpers for the read-only evidence explanation slice.
 * Every string assembled for a model prompt passes through redactAdvisorText
 * (wired into the prompt builder, not left to a future route) before use.
 * Replacement counts feed audit metadata; matched secret values are never
 * logged, persisted, or echoed elsewhere.
 *
 * Heuristic limits, not guarantees: these patterns catch common secret
 * shapes (flags, key blocks, bearer/token assignments, sk- material) but
 * cannot recognize novel formats, secrets split across lines, or values
 * already encoded or obfuscated. Structural exclusion of fields and caps is
 * the primary boundary; redaction is defense in depth. Prompt wording alone
 * is not a safety boundary either: safety rests on read-only handling with
 * no tool execution, plus citation and budget validation.
 */

export const ADVISOR_REDACTION_TOKEN = "[redacted]" as const;
export const ADVISOR_CONTEXT_MAX_BYTES = 16_384 as const;

const FLAG_PATTERN = /(?:flag|ctf)\{[^}\r\n]{1,256}\}/gi;
const PRIVATE_KEY_BLOCK_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]{0,4096}?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const PRIVATE_KEY_BEGIN_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g;
const SECRET_KEY_PATTERN = /sk-[A-Za-z0-9\-_]{8,}/g;
const BEARER_PATTERN = /bearer\s+[A-Za-z0-9\-_.~+/=]{8,}/gi;
// Matches bare, single-quoted, and double-quoted assigned values, including
// values with spaces inside quotes. Unbalanced quotes redact from the opening
// quote to end of line at most.
const CREDENTIAL_ASSIGNMENT_PATTERN =
  /(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*("[^"\r\n]{0,256}"|'[^'\r\n]{0,256}'|\S{1,256})/gi;
const URL_USERINFO_PATTERN = /(https?:\/\/)[^/\s?#]+@([^\s]*)/gi;

export interface AdvisorRedaction {
  readonly text: string;
  readonly redactions: number;
}

export interface AdvisorSecretSpan {
  readonly start: number;
  readonly end: number;
}

function countMatches(pattern: RegExp, value: string): number {
  pattern.lastIndex = 0;
  const matches = value.match(pattern);
  return matches === null ? 0 : matches.length;
}

function replaceCounted(pattern: RegExp, value: string, replacement: string): AdvisorRedaction {
  const redactions = countMatches(pattern, value);
  pattern.lastIndex = 0;
  return { text: value.replace(pattern, replacement), redactions };
}

// Redact secret-shaped values. Order matters: full key blocks first so a lone
// BEGIN line never survives when its END marker is missing.
export function redactAdvisorText(value: string): AdvisorRedaction {
  let text = value;
  let redactions = 0;
  const apply = (result: AdvisorRedaction): void => {
    text = result.text;
    redactions += result.redactions;
  };
  apply(replaceCounted(PRIVATE_KEY_BLOCK_PATTERN, text, ADVISOR_REDACTION_TOKEN));
  apply(replaceCounted(PRIVATE_KEY_BEGIN_PATTERN, text, ADVISOR_REDACTION_TOKEN));
  apply(replaceCounted(FLAG_PATTERN, text, ADVISOR_REDACTION_TOKEN));
  apply(replaceCounted(SECRET_KEY_PATTERN, text, ADVISOR_REDACTION_TOKEN));
  apply(replaceCounted(BEARER_PATTERN, text, ADVISOR_REDACTION_TOKEN));
  CREDENTIAL_ASSIGNMENT_PATTERN.lastIndex = 0;
  const assignments = text.match(CREDENTIAL_ASSIGNMENT_PATTERN);
  redactions += assignments === null ? 0 : assignments.length;
  CREDENTIAL_ASSIGNMENT_PATTERN.lastIndex = 0;
  text = text.replace(
    CREDENTIAL_ASSIGNMENT_PATTERN,
    (_match: string, name: string) => `${name}: ${ADVISOR_REDACTION_TOKEN}`,
  );
  return { text, redactions };
}

// Secret span locations for the same policy above, in UTF-16 offsets.
// Masking a narrow slice alone misses secrets whose wrappers fall outside
// the slice (for example keeping only `supersecret` out of
// `flag{supersecret}`). Callers redact a bounded expanded context, locate
// spans with this helper, and project the overlapping spans onto the
// requested range, so inner selections stay masked. Spans merge when they
// touch, so one contiguous secret region counts once. Fresh RegExp objects
// keep the shared module patterns free of lastIndex races.
export function findAdvisorSecretSpans(value: string): AdvisorSecretSpan[] {
  const sources: RegExp[] = [
    PRIVATE_KEY_BLOCK_PATTERN,
    PRIVATE_KEY_BEGIN_PATTERN,
    FLAG_PATTERN,
    SECRET_KEY_PATTERN,
    BEARER_PATTERN,
    CREDENTIAL_ASSIGNMENT_PATTERN,
    URL_USERINFO_PATTERN,
  ];
  const spans: { start: number; end: number }[] = [];
  for (const source of sources) {
    const pattern = new RegExp(source.source, source.flags);
    for (;;) {
      const found = pattern.exec(value);
      if (found === null) break;
      if (found[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      spans.push({ start: found.index, end: found.index + found[0].length });
    }
  }
  spans.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: AdvisorSecretSpan[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start <= last.end) {
      if (span.end > last.end) {
        merged[merged.length - 1] = { start: last.start, end: span.end };
      }
    } else {
      merged.push({ start: span.start, end: span.end });
    }
  }
  return merged;
}

const PRIVATE_KEY_END_PATTERN = /-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

// Starts (UTF-16 offsets) of private-key BEGIN markers with no END marker
// pairing them: no END sits between the BEGIN and the next BEGIN (or the
// text end). The shapes mirror the redaction policy above, so projection
// and policy agree on what counts as a marker. Fresh RegExp objects keep
// the shared module patterns free of lastIndex races.
export function findUnterminatedPrivateKeyStarts(value: string): number[] {
  const beginPattern = new RegExp(PRIVATE_KEY_BEGIN_PATTERN.source, "g");
  const begins: number[] = [];
  for (;;) {
    const found = beginPattern.exec(value);
    if (found === null) break;
    begins.push(found.index);
  }
  const endPattern = new RegExp(PRIVATE_KEY_END_PATTERN.source, "g");
  const ends: number[] = [];
  for (;;) {
    const found = endPattern.exec(value);
    if (found === null) break;
    ends.push(found.index);
  }
  const unterminated: number[] = [];
  let endCursor = 0;
  for (let beginCursor = 0; beginCursor < begins.length; beginCursor += 1) {
    const begin = begins[beginCursor] ?? 0;
    const nextBegin = beginCursor + 1 < begins.length ? (begins[beginCursor + 1] ?? 0) : Number.POSITIVE_INFINITY;
    while (endCursor < ends.length && (ends[endCursor] ?? 0) < begin) endCursor += 1;
    if (endCursor < ends.length && (ends[endCursor] ?? 0) < nextBegin) {
      endCursor += 1;
    } else {
      unterminated.push(begin);
    }
  }
  return unterminated;
}

// Marker tests using the same policy shapes, for selections that hold one
// end of a key block without the other.
export function containsPrivateKeyBeginMarker(value: string): boolean {
  return new RegExp(PRIVATE_KEY_BEGIN_PATTERN.source).test(value);
}

export function containsPrivateKeyEndMarker(value: string): boolean {
  return new RegExp(PRIVATE_KEY_END_PATTERN.source).test(value);
}

// Strip userinfo (credentials) from every http(s) URL occurrence, embedded or
// standalone, any scheme case. Non-URL text, emails without a scheme, and
// `@` inside paths pass through unchanged.
export function stripAdvisorUrlUserinfo(value: string): string {
  URL_USERINFO_PATTERN.lastIndex = 0;
  const stripped = value.replace(
    URL_USERINFO_PATTERN,
    (_match: string, scheme: string, rest: string) => `${scheme}${rest}`,
  );
  URL_USERINFO_PATTERN.lastIndex = 0;
  return stripped;
}

// Quote one evidence block as untrusted data. The block is JSON-encoded with
// `<` escaped, so delimiter text or quotes inside ids and content cannot
// break out of the enclosing tags. Model instructions live elsewhere;
// anything inside these delimiters is data, even when it reads like an
// instruction.
export function quoteAdvisorEvidenceBlock(kind: string, id: string, text: string): string {
  const encoded = JSON.stringify({ kind, id, text }).replace(/</g, "\\u003c");
  return `<evidence>\n${encoded}\n</evidence>`;
}

export function advisorUtf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

// Truncate to a UTF-8 byte budget on code-point boundaries, so multibyte
// sequences are never split. Inputs already within budget pass through.
export function truncateUtf8Bytes(value: string, maxBytes: number): string {
  if (advisorUtf8ByteLength(value) <= maxBytes) return value;
  let bytes = 0;
  let end = 0;
  const points = Array.from(value);
  while (end < points.length) {
    const point = points[end];
    if (point === undefined) break;
    const next = bytes + advisorUtf8ByteLength(point);
    if (next > maxBytes) break;
    bytes = next;
    end += 1;
  }
  return `${points.slice(0, end).join("")}\n[truncated]`;
}

export function isAdvisorContextWithinBudget(value: string, maxBytes: number): boolean {
  return advisorUtf8ByteLength(value) <= maxBytes;
}
