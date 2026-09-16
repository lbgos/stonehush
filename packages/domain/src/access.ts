/**
 * Access-record rules: recognizing leads parked for lack of access and
 * wording the quiet revisit suggestion that cites the new access.
 * Suggestions never reopen the lead and never claim the access works
 * anywhere beyond the recorded target.
 */

import { formatAccessRecordLabel, type AccessType } from "@stonehush/contracts";

// Parked language that means "I lacked a working login". Matched
// case-insensitively against the park reason plus tested conditions.
const LACK_OF_ACCESS_MARKERS = [
  "access",
  "credential",
  "auth",
  "login",
  "password",
  "passphrase",
  "unauthenticated",
  "anonymous",
  "permission",
  "forbidden",
  "unauthorized",
  "401",
  "403",
] as const;

export function parkedForLackOfAccess(
  parkReason: string | null,
  testedConditions: string | null,
): boolean {
  if (parkReason === null && testedConditions === null) return false;
  const haystack = `${parkReason ?? ""}\n${testedConditions ?? ""}`.toLowerCase();
  return LACK_OF_ACCESS_MARKERS.some((marker) => haystack.includes(marker));
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
