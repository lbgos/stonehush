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

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

// Short masked hint recorded at capture time, for example "26 bytes". The
// hint carries the value length only: no characters of the value itself are
// persisted or displayed, so masked output stays masked.
export function proofHintForValue(value: string): string {
  return `${utf8ByteLength(value)} bytes`;
}

export const SECRET_STORAGE_COPY =
  "Secrets store references only, never plaintext values. Masked display is not encryption: anyone who can read the database file can read the references." as const;
