/**
 * Secret redaction util owned by the leads slice. Other slices consume these
 * helpers after merge instead of duplicating masking logic.
 *
 * Storage behavior, stated plainly because display masking is not
 * encryption: Blackglass stores only secret references (vault paths, secret
 * refs) plus short operator-written hints and sha256 digests of captured
 * proofs. Plaintext secret values are never persisted. The SQLite file itself
 * is plaintext protected by filesystem permissions (0600), so anyone who can
 * read the database file can read the references; treat them accordingly.
 * Masked display values hide content in the UI but do not encrypt anything.
 */

export const SECRET_DISPLAY_MASK = "[masked]" as const;
export const SECRET_REDACTION_TOKEN = "[redacted]" as const;

// Surfaces that never carry secret values or references unless the operator
// deliberately reveals one item. Membership here is the default exclusion
// boundary; search, AI context, logs, report text, screenshots, and command
// previews all stay secret-free.
export const SECRET_EXCLUDED_SURFACES = [
  "search",
  "ai_context",
  "logs",
  "report_text",
  "screenshots",
  "command_preview",
] as const;

export type SecretExcludedSurface = (typeof SECRET_EXCLUDED_SURFACES)[number];

export function isSecretExcludedFrom(surface: string): boolean {
  return (SECRET_EXCLUDED_SURFACES as readonly string[]).includes(surface);
}

// Display masking is total: any value becomes the mask token. Lengths are
// not preserved so masked output leaks nothing about the original.
export function maskSecretValue(_value: string): string {
  return SECRET_DISPLAY_MASK;
}

export interface KnownSecretRedaction {
  readonly text: string;
  readonly redactions: number;
}

// Remove known secret values from free text before it reaches logs, AI
// context, reports, or previews. Values shorter than 4 characters are
// skipped: they over-match ordinary words and their redaction proves little.
export function redactKnownSecretsFromText(
  text: string,
  knownValues: readonly string[],
): KnownSecretRedaction {
  let redacted = text;
  let redactions = 0;
  const candidates = [...new Set(knownValues)]
    .filter((value) => value.length >= 4)
    .sort((a, b) => b.length - a.length);
  for (const candidate of candidates) {
    const occurrences = redacted.split(candidate).length - 1;
    if (occurrences <= 0) continue;
    redacted = redacted.split(candidate).join(SECRET_REDACTION_TOKEN);
    redactions += occurrences;
  }
  return { text: redacted, redactions };
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

// Short masked hint recorded at capture time, for example "32 bytes, ends
// ab". The hint is operator-visible by design; keep it short and never put
// the value itself into it.
export function proofHintForValue(value: string): string {
  const bytes = utf8ByteLength(value);
  const points = Array.from(value);
  const tail = points.slice(-2).join("");
  return `${bytes} bytes, ends ${tail}`;
}

export const SECRET_STORAGE_COPY =
  "Secrets store references only, never plaintext values. Masked display is not encryption: anyone who can read the database file can read the references." as const;
