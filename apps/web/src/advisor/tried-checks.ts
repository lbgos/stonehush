import type { AdvisorTurn } from "@blackglass/contracts";

import type { HintDepthStorage } from "./hint-depth.js";
import { splitAnswerParagraphs, toPrefilledAction } from "./pin-citation.js";
import type {
  AdvisorSuggestion,
  AttemptOutcome,
  RecordedAttempt,
} from "./ruled-out.js";

/**
 * Tried-check store (STONE-7).
 * Gives the ruled-out filter its live production path: candidate checks
 * are extracted from succeeded advisor answers, and the operator records
 * what each check showed under the current access context. Both live in
 * per-engagement localStorage next to hint depth; nothing here touches
 * the network, the turn store, or ambient state. Conditions default to the
 * operator's access-context note so the same check under different access
 * stays a different check.
 */

const TRIED_CHECKS_PREFIX = "blackglass.advisor.tried-checks.";
const ACCESS_CONTEXT_PREFIX = "blackglass.advisor.access-context.";
const TRIED_CHECKS_MAX = 64;

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

const OUTCOMES: readonly AttemptOutcome[] = ["ruled-out", "supported", "open"];

function isRecordedAttempt(value: unknown): value is RecordedAttempt {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as { summary?: unknown; conditions?: unknown; outcome?: unknown };
  return (
    typeof entry.summary === "string" &&
    entry.summary.trim().length > 0 &&
    typeof entry.conditions === "string" &&
    typeof entry.outcome === "string" &&
    (OUTCOMES as readonly string[]).includes(entry.outcome)
  );
}

function readStorage(storage: HintDepthStorage | undefined, key: string): string | null {
  if (storage === undefined) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(
  storage: HintDepthStorage | undefined,
  key: string,
  value: string,
): void {
  if (storage === undefined) return;
  try {
    storage.setItem(key, value);
  } catch {
    // Convenience persistence only; a failing store never blocks asking.
  }
}

export function loadTriedChecks(
  storage: HintDepthStorage | undefined,
  engagementId: string,
): RecordedAttempt[] {
  const raw = readStorage(storage, `${TRIED_CHECKS_PREFIX}${engagementId}`);
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isRecordedAttempt).slice(0, TRIED_CHECKS_MAX);
}

export function saveTriedChecks(
  storage: HintDepthStorage | undefined,
  engagementId: string,
  attempts: readonly RecordedAttempt[],
): void {
  writeStorage(
    storage,
    `${TRIED_CHECKS_PREFIX}${engagementId}`,
    JSON.stringify(attempts.slice(0, TRIED_CHECKS_MAX)),
  );
}

export function loadAccessContext(
  storage: HintDepthStorage | undefined,
  engagementId: string,
): string {
  return readStorage(storage, `${ACCESS_CONTEXT_PREFIX}${engagementId}`) ?? "";
}

export function saveAccessContext(
  storage: HintDepthStorage | undefined,
  engagementId: string,
  context: string,
): void {
  writeStorage(storage, `${ACCESS_CONTEXT_PREFIX}${engagementId}`, context);
}

// Record (or replace) the outcome of one check under the given conditions.
// Matching is normalized the same way the filter compares, so a re-record
// always supersedes the earlier verdict for the same check + conditions.
export function recordTriedCheck(
  attempts: readonly RecordedAttempt[],
  summary: string,
  conditions: string,
  outcome: AttemptOutcome,
): RecordedAttempt[] {
  const normalizedSummary = normalize(summary);
  const normalizedConditions = normalize(conditions);
  const rest = attempts.filter(
    (attempt) =>
      normalize(attempt.summary) !== normalizedSummary ||
      normalize(attempt.conditions) !== normalizedConditions,
  );
  return [...rest, { summary: summary.trim(), conditions: conditions.trim(), outcome }].slice(
    -TRIED_CHECKS_MAX,
  );
}

export function clearTriedCheck(
  attempts: readonly RecordedAttempt[],
  summary: string,
  conditions: string,
): RecordedAttempt[] {
  const normalizedSummary = normalize(summary);
  const normalizedConditions = normalize(conditions);
  return attempts.filter(
    (attempt) =>
      normalize(attempt.summary) !== normalizedSummary ||
      normalize(attempt.conditions) !== normalizedConditions,
  );
}

// Extract candidate checks from succeeded turns: supported single-line
// checks only, deduplicated. Prose and walkthroughs never become
// suggestions. Conditions attach at render time from the live access
// context, so verdicts always reflect the current context.
export function extractSuggestedChecks(
  turns: readonly AdvisorTurn[],
): AdvisorSuggestion[] {
  const seen = new Set<string>();
  const checks: AdvisorSuggestion[] = [];
  for (const turn of turns) {
    if (turn.status !== "succeeded") continue;
    for (const paragraph of splitAnswerParagraphs(turn.answer)) {
      for (const rawLine of paragraph.split("\n")) {
        const line = rawLine.trim().replace(/^\$\s*/, "");
        if (!toPrefilledAction(line).ok) continue;
        const id = normalize(line);
        if (seen.has(id)) continue;
        seen.add(id);
        checks.push({ id, summary: line, conditions: "" });
      }
    }
  }
  return checks;
}

export function withLiveConditions(
  checks: readonly AdvisorSuggestion[],
  conditions: string,
): AdvisorSuggestion[] {
  return checks.map((check) => ({ ...check, conditions }));
}
