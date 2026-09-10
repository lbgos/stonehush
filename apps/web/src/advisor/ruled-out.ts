/**
 * Ruled-out suggestion handling (STONE-7).
 * The advisor remembers dead ends: a suggestion already ruled out under the
 * same conditions is dropped, unless it carries a new reason, in which case
 * the new reason is shown explicitly. Otherwise the suggestion moves on
 * unchanged. Recorded attempts include access context in their conditions,
 * so the same check under different access is a different check.
 */

export type AttemptOutcome = "ruled-out" | "supported" | "open";

export interface RecordedAttempt {
  readonly summary: string;
  readonly conditions: string;
  readonly outcome: AttemptOutcome;
}

export interface AdvisorSuggestion {
  readonly id: string;
  readonly summary: string;
  readonly conditions: string;
  readonly newReason?: string;
}

export type SuggestionVerdict =
  | { readonly verdict: "keep"; readonly id: string }
  | { readonly verdict: "drop"; readonly id: string; readonly reason: string }
  | { readonly verdict: "annotate"; readonly id: string; readonly note: string };

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function filterRuledOutSuggestions(
  suggestions: readonly AdvisorSuggestion[],
  attempts: readonly RecordedAttempt[],
): SuggestionVerdict[] {
  const ruledOut = attempts.filter((attempt) => attempt.outcome === "ruled-out");
  return suggestions.map((suggestion) => {
    const summary = normalize(suggestion.summary);
    const conditions = normalize(suggestion.conditions);
    const prior = ruledOut.find(
      (attempt) =>
        normalize(attempt.summary) === summary &&
        normalize(attempt.conditions) === conditions,
    );
    if (prior === undefined) return { verdict: "keep", id: suggestion.id };
    const reason = suggestion.newReason?.trim() ?? "";
    if (reason.length > 0) {
      return {
        verdict: "annotate",
        id: suggestion.id,
        note: `Previously ruled out under the same conditions; new reason to retry: ${reason}`,
      };
    }
    return {
      verdict: "drop",
      id: suggestion.id,
      reason: `Already ruled out under the same conditions (${suggestion.conditions.trim()}): moving on.`,
    };
  });
}
