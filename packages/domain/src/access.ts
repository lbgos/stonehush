/**
 * Access-record rules: recognizing leads parked for lack of access and
 * wording the quiet revisit suggestion that cites the new access.
 * Suggestions never reopen the lead and never claim the access works
 * anywhere beyond the recorded target.
 */

import { formatAccessRecordLabel, type AccessType } from "@stonehush/contracts";

// Parked language that means "I lacked a working login". Matched as whole
// words against the park reason plus tested conditions, so "OAuth redirect"
// and "permission to test" do not count: bare "permission" is ambiguous and
// stays out. "auth" matches auth/authenticated/authentication but never the
// "auth" inside "OAuth", where no word boundary exists.
const LACK_OF_ACCESS_PATTERNS: readonly RegExp[] = [
  /\baccess\b/i,
  /\bcredentials?\b/i,
  /\bauth\w*\b/i,
  /\blogins?\b/i,
  /\bpasswords?\b/i,
  /\bpassphrases?\b/i,
  /\bunauthenticated\b/i,
  /\banonymous\b/i,
  /\bforbidden\b/i,
  /\bunauthorized\b/i,
  /\b401\b/,
  /\b403\b/,
];

export function parkedForLackOfAccess(
  parkReason: string | null,
  testedConditions: string | null,
): boolean {
  if (parkReason === null && testedConditions === null) return false;
  const haystack = `${parkReason ?? ""}\n${testedConditions ?? ""}`;
  return LACK_OF_ACCESS_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(haystack);
  });
}

export interface AccessRevisitSource {
  readonly accessType: AccessType;
  readonly account: string;
}

// The reason stored on the fired suggestion. LeadRepository cites the parked
// reason alongside it, bounded to 500 chars. Account and type only: secret
// references and values never enter the suggestion text.
export function accessRevisitReason(source: AccessRevisitSource): string {
  return `${formatAccessRecordLabel(source.accessType)} for account "${source.account}" is now on record. Worth one authenticated retry under the new access.`;
}
