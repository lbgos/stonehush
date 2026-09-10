import {
  HOSTS_FILE_EDIT_POLICY,
  RUNNER_HOST_MAPPING_NOTE,
  RUNNER_MAPPING_NEXT_STEP,
} from "@blackglass/contracts";

import { normalizeTarget } from "./normalize-target.js";

export const REDIRECT_HOSTS_FILE_EDIT_POLICY = HOSTS_FILE_EDIT_POLICY;
export const REDIRECT_RUNNER_ONLY_NOTE = RUNNER_HOST_MAPPING_NOTE;
export const REDIRECT_MAPPING_NEXT_STEP = RUNNER_MAPPING_NEXT_STEP;

export interface RedirectHostnameOffer {
  readonly associationId: string;
  readonly targetId: string;
  readonly engagementId: string;
  readonly connectionAddress: string;
  readonly requestedHostname: string;
  readonly httpHost: string;
  readonly tlsServerName: string;
  readonly runnerOnlyNote: typeof RUNNER_HOST_MAPPING_NOTE;
  readonly nextStep: typeof RUNNER_MAPPING_NEXT_STEP;
  readonly hostsFileEdited: false;
  readonly createdAt: string;
}

export type ProposeRedirectHostnameErrorCode =
  | "invalid_connection_address"
  | "invalid_requested_hostname";

export type ProposeRedirectHostnameResult =
  | { ok: true; offer: RedirectHostnameOffer }
  | { ok: false; error: { code: ProposeRedirectHostnameErrorCode } };

// A redirect that reveals a hostname produces an associate-with-target offer.
// Both the connection address and the requested host stay visible; HTTP and
// TLS keep the intended hostname; the runner-only name mapping limitation is
// explained with a practical next step; the OS hosts file is never edited.
export function proposeRedirectHostnameAssociation(input: {
  associationId: string;
  targetId: string;
  engagementId: string;
  connectionAddress: string;
  requestedHostname: string;
  createdAt: string;
}): ProposeRedirectHostnameResult {
  const connection = normalizeTarget(input.connectionAddress.trim());
  if (!connection.ok) {
    return { ok: false, error: { code: "invalid_connection_address" } };
  }
  const requested = normalizeTarget(input.requestedHostname.trim());
  if (!requested.ok || requested.target.kind !== "hostname") {
    return { ok: false, error: { code: "invalid_requested_hostname" } };
  }
  const hostname = requested.target.hostname;
  return {
    ok: true,
    offer: {
      associationId: input.associationId,
      targetId: input.targetId,
      engagementId: input.engagementId,
      connectionAddress: input.connectionAddress.trim(),
      requestedHostname: hostname,
      httpHost: hostname,
      tlsServerName: hostname,
      runnerOnlyNote: RUNNER_HOST_MAPPING_NOTE,
      nextStep: RUNNER_MAPPING_NEXT_STEP,
      hostsFileEdited: false,
      createdAt: input.createdAt,
    },
  };
}

export type DecideRedirectHostnameResult =
  | { ok: true; status: "associated" | "declined"; decidedAt: string }
  | { ok: false; error: { code: "invalid_decision" } };

export function decideRedirectHostnameAssociation(
  decision: string,
  now: string,
): DecideRedirectHostnameResult {
  if (decision === "associated") return { ok: true, status: "associated", decidedAt: now };
  if (decision === "declined") return { ok: true, status: "declined", decidedAt: now };
  return { ok: false, error: { code: "invalid_decision" } };
}

// Negative-test guard: no planned operator or runner action may silently edit
// the OS hosts file. Returns the offending descriptions, empty when clean.
export function findHostsFileEdits(
  plannedActions: readonly { description: string }[],
): string[] {
  const offending: string[] = [];
  for (const action of plannedActions) {
    const text = action.description.toLowerCase();
    if (text.includes("hosts") && /edit|write|modify|append|patch/.test(text)) {
      offending.push(action.description);
    }
  }
  return offending;
}
