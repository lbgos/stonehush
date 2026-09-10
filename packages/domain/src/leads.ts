/**
 * Pure lead rules: disposition transitions, the quiet revisit-suggestion rule,
 * attempt attach rules, service-scoped credential checks, and the successful
 * chain outline. Creation is never forced and suggestions never reopen.
 */

import type {
  AttemptOutcome,
  Lead,
  LeadAttempt,
  RevisitTrigger,
} from "@blackglass/contracts";

export type LeadTransitionErrorCode = "invalid_lead_transition";

export interface LeadTransition {
  readonly disposition: Lead["disposition"];
  readonly parkReason: string | null;
  readonly testedConditions: string | null;
  readonly closedNote: string | null;
}

export type LeadTransitionResult =
  | { ok: true; value: LeadTransition }
  | { ok: false; error: { code: LeadTransitionErrorCode } };

function invalid(): LeadTransitionResult {
  return { ok: false, error: { code: "invalid_lead_transition" } };
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// Open -> Parked requires a reason and preserves optional tested conditions.
// Open/Parked -> Closed records an optional dead-end note. Parked/Closed ->
// Open is an explicit operator reopen only. Closed never transitions to
// Parked, and no transition happens without an explicit operator action.
export function transitionLeadDisposition(
  current: Pick<Lead, "disposition">,
  operation: "park" | "reopen" | "close",
  input: {
    reason?: string | undefined;
    testedConditions?: string | undefined;
    note?: string | undefined;
  } = {},
): LeadTransitionResult {
  if (operation === "park") {
    if (current.disposition !== "open") return invalid();
    if (!nonEmpty(input.reason)) return invalid();
    return {
      ok: true,
      value: {
        disposition: "parked",
        parkReason: input.reason,
        testedConditions:
          input.testedConditions !== undefined && nonEmpty(input.testedConditions)
            ? input.testedConditions
            : null,
        closedNote: null,
      },
    };
  }
  if (operation === "reopen") {
    if (current.disposition === "open") return invalid();
    return {
      ok: true,
      value: {
        disposition: "open",
        parkReason: null,
        testedConditions: null,
        closedNote: null,
      },
    };
  }
  if (current.disposition === "closed") return invalid();
  return {
    ok: true,
    value: {
      disposition: "closed",
      parkReason: null,
      testedConditions: null,
      closedNote:
        input.note !== undefined && nonEmpty(input.note) ? input.note : null,
    },
  };
}

export type RevisitSuppressReason =
  | "lead_active"
  | "lead_closed"
  | "already_suggested"
  | "identical_anonymous_conditions";

export interface RevisitTriggerInput {
  readonly trigger: RevisitTrigger;
  readonly reason: string;
  readonly anonymous: boolean;
  readonly conditions?: string | undefined;
}

export type SuggestRevisitResult =
  | {
      ok: true;
      value: {
        readonly trigger: RevisitTrigger;
        readonly reason: string;
        readonly createdAt: string;
        readonly dismissed: false;
      };
    }
  | { ok: false; error: { code: "revisit_suppressed"; reason: RevisitSuppressReason } }
  | { ok: false; error: { code: "invalid_revisit_input" } };

// Two condition descriptions match when they normalize identically. Empty on
// either side never matches: unknown conditions cannot suppress a suggestion.
export function anonymousConditionsMatch(
  parked: string | null,
  candidate: string | undefined,
): boolean {
  if (parked === null || candidate === undefined) return false;
  const normalize = (value: string): string => value.trim().replace(/\s+/g, " ").toLowerCase();
  const left = normalize(parked);
  const right = normalize(candidate);
  return left.length > 0 && left === right;
}

function suppressed(reason: RevisitSuppressReason): SuggestRevisitResult {
  return { ok: false, error: { code: "revisit_suppressed", reason } };
}

// Exactly one quiet revisit suggestion per parked lead. New access, hostname,
// or service changes produce at most one suggestion carrying a reason; the
// lead disposition is never changed here. Identical anonymous checks against
// preserved tested conditions are suppressed, never re-suggested.
export function suggestLeadRevisit(
  lead: Pick<Lead, "disposition" | "testedConditions" | "revisitSuggestion">,
  input: RevisitTriggerInput,
  now: () => Date = () => new Date(),
): SuggestRevisitResult {
  if (!nonEmpty(input.reason)) {
    return { ok: false, error: { code: "invalid_revisit_input" } };
  }
  if (lead.disposition === "open") return suppressed("lead_active");
  if (lead.disposition === "closed") return suppressed("lead_closed");
  if (lead.revisitSuggestion !== null && !lead.revisitSuggestion.dismissed) {
    return suppressed("already_suggested");
  }
  if (
    input.anonymous &&
    anonymousConditionsMatch(lead.testedConditions, input.conditions)
  ) {
    return suppressed("identical_anonymous_conditions");
  }
  return {
    ok: true,
    value: {
      trigger: input.trigger,
      reason: input.reason,
      createdAt: now().toISOString(),
      dismissed: false as const,
    },
  };
}

export type AttemptLeadLink =
  | { readonly leadId: string; readonly mode: "auto-linked" }
  | { readonly leadId: string; readonly mode: "attached-afterward" }
  | { readonly leadId: null; readonly mode: "unlinked" };

// Launching from a lead auto-links; launching elsewhere allows
// attach-afterward; creation is never forced, so a missing link is a valid
// unlinked attempt, never an error.
export function resolveAttemptLeadLink(input: {
  readonly launchLeadId?: string | null | undefined;
  readonly attachLeadId?: string | null | undefined;
}): AttemptLeadLink {
  if (
    input.launchLeadId !== undefined &&
    input.launchLeadId !== null &&
    input.launchLeadId.length > 0
  ) {
    return { leadId: input.launchLeadId, mode: "auto-linked" };
  }
  if (
    input.attachLeadId !== undefined &&
    input.attachLeadId !== null &&
    input.attachLeadId.length > 0
  ) {
    return { leadId: input.attachLeadId, mode: "attached-afterward" };
  }
  return { leadId: null, mode: "unlinked" };
}

// A credential proven for one service never marks another service tested.
// Service refs match exactly after trimming; anything else is untested.
export function isServiceTestedBySecret(
  secretServiceRef: string,
  candidateServiceRef: string,
): boolean {
  const left = secretServiceRef.trim();
  const right = candidateServiceRef.trim();
  return left.length > 0 && left === right;
}

const OUTCOME_LABELS: Record<AttemptOutcome, string> = {
  observed: "observed",
  ruled_out: "ruled out under conditions",
  inconclusive: "inconclusive",
  interrupted: "interrupted (tool finished, hypothesis undecided)",
};

// A successful chain of attempts to a finding or access record renders as a
// writeup outline: lead, ordered attempts with outcomes and conditions, then
// the establishing links back to their attempts.
export function buildLeadOutline(
  lead: Pick<Lead, "title" | "target" | "serviceRef" | "disposition" | "parkReason">,
  attempts: readonly Pick<
    LeadAttempt,
    "sequence" | "summary" | "outcome" | "conditions" | "linkedFindingId" | "linkedObjectiveId"
  >[],
): string {
  const lines: string[] = [`Lead: ${lead.title}`];
  if (lead.target !== null) lines.push(`Target: ${lead.target}`);
  if (lead.serviceRef !== null) lines.push(`Service: ${lead.serviceRef}`);
  lines.push(`Disposition: ${lead.disposition}`);
  if (lead.disposition === "parked" && lead.parkReason !== null) {
    lines.push(`Parked: ${lead.parkReason}`);
  }
  const ordered = [...attempts].sort((a, b) => a.sequence - b.sequence);
  if (ordered.length === 0) {
    lines.push("Attempts: none recorded");
    return lines.join("\n");
  }
  lines.push("Attempts:");
  for (const attempt of ordered) {
    lines.push(`  ${attempt.sequence}. ${attempt.summary} [${OUTCOME_LABELS[attempt.outcome]}]`);
    if (attempt.conditions !== null) {
      lines.push(`     Conditions: ${attempt.conditions}`);
    }
    if (attempt.linkedFindingId !== null) {
      lines.push(`     Establishes finding ${attempt.linkedFindingId}`);
    }
    if (attempt.linkedObjectiveId !== null) {
      lines.push(`     Establishes objective ${attempt.linkedObjectiveId}`);
    }
  }
  return lines.join("\n");
}
