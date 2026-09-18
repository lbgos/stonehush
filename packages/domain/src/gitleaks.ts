import {
  GITLEAKS_MAX_FINDINGS,
  GITLEAKS_MAX_JSON_BYTES,
  GitleaksMatchSchema,
  type GitleaksMatch,
} from "@stonehush/contracts";

/**
 * Redacting parser for `gitleaks detect -f json` output.
 *
 * This is the redaction boundary: gitleaks reports candidate secret VALUES
 * in Secret and Match fields, and this parser never copies them anywhere.
 * Each stored match keeps the rule id, file, and line plus a dedupe
 * fingerprint. The fingerprint is FNV-1a 64 over rule, file, line, and the
 * secret text: a non-cryptographic handle that distinguishes identical hits
 * across rescans without revealing anything. A hash collision only hides a
 * duplicate row, never leaks a value.
 *
 * Strict on shape: one malformed record fails the whole parse with
 * gitleaks_parse_error instead of silently dropping a hit. Oversized input
 * fails with gitleaks_output_too_large so callers bound persistence before
 * touching the database. Empty or whitespace-only output means the detector
 * reported nothing.
 */

const UNIT_SEPARATOR = String.fromCharCode(31);

export type ParseGitleaksResult =
  | { ok: true; matches: GitleaksMatch[]; truncated: boolean; rawCount: number }
  | { ok: false; error: { code: "gitleaks_parse_error" | "gitleaks_output_too_large" } };

function fnv1a64Hex(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  const bytes = new TextEncoder().encode(value);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

function fingerprintFor(ruleId: string, file: string, line: number, secret: string): string {
  return fnv1a64Hex([ruleId, file, String(line), secret].join(UNIT_SEPARATOR));
}

function projectRawFinding(candidate: unknown): GitleaksMatch | null {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return null;
  }
  const record = candidate as Record<string, unknown>;
  const { RuleID, File, StartLine } = record;
  if (typeof RuleID !== "string" || RuleID.length === 0 || RuleID.length > 128) return null;
  if (typeof File !== "string" || File.length === 0 || File.length > 1024) return null;
  // Line 0 means the detector gave no line; the contract keeps 0 visible
  // instead of inventing a line number. A missing or non-integer line
  // fails the record: silently placing a hit somewhere is worse than
  // failing the scan.
  if (typeof StartLine !== "number" || !Number.isInteger(StartLine) || StartLine < 0) {
    return null;
  }
  const line = StartLine;
  const secret =
    typeof record.Secret === "string"
      ? record.Secret
      : typeof record.Match === "string"
        ? record.Match
        : "";
  const projected = {
    ruleId: RuleID,
    file: File,
    line,
    fingerprint: fingerprintFor(RuleID, File, line, secret),
  };
  const validated = GitleaksMatchSchema.safeParse(projected);
  return validated.success ? validated.data : null;
}

export function parseGitleaksJson(bytes: Uint8Array): ParseGitleaksResult {
  try {
    if (bytes.length > GITLEAKS_MAX_JSON_BYTES) {
      return { ok: false, error: { code: "gitleaks_output_too_large" } };
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
    if (text.length === 0) {
      return { ok: true, matches: [], truncated: false, rawCount: 0 };
    }
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      return { ok: false, error: { code: "gitleaks_parse_error" } };
    }
    const matches: GitleaksMatch[] = [];
    for (const candidate of parsed) {
      const match = projectRawFinding(candidate);
      if (match === null) return { ok: false, error: { code: "gitleaks_parse_error" } };
      matches.push(match);
    }
    const truncated = matches.length > GITLEAKS_MAX_FINDINGS;
    return {
      ok: true,
      matches: matches.slice(0, GITLEAKS_MAX_FINDINGS),
      truncated,
      rawCount: matches.length,
    };
  } catch {
    return { ok: false, error: { code: "gitleaks_parse_error" } };
  }
}
