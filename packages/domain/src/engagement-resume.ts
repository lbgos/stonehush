/**
 * STONE-6 resume domain helpers: next-step normalization, factual change
 * list construction, snapshot labeling, starred focus, prior-attempt copy.
 * Pure functions, no I/O. Untrusted content passes through untouched except
 * length bounding for display summaries.
 */

import type { EngagementResumeChange, EngagementResumeChangeKind } from "@stonehush/contracts";

export interface ResumeChangeInput {
  readonly kind: EngagementResumeChangeKind;
  readonly id: string;
  readonly at: string;
  readonly summary: string;
  /** True when the source predates run-event capture (read as snapshot). */
  readonly preEventRecord: boolean;
}

export const RESUME_CHANGES_MAX = 200 as const;
export const RESUME_SUMMARY_MAX_CHARS = 200 as const;

function boundSummary(summary: string): string {
  const trimmed = summary.trim();
  if (trimmed.length === 0) return "(no summary)";
  const points = Array.from(trimmed);
  return points.length > RESUME_SUMMARY_MAX_CHARS
    ? `${points.slice(0, RESUME_SUMMARY_MAX_CHARS).join("")}...`
    : trimmed;
}

function isValidTimestamp(value: string): boolean {
  return Number.isNaN(Date.parse(value)) === false;
}

/**
 * Build the factual change list underlying resume. Sorted newest first,
 * capped, never fabricated: pre-event records are labeled snapshot instead
 * of being placed on a claimed timeline position beyond their stored `at`.
 */
export function buildResumeChanges(inputs: readonly ResumeChangeInput[]): EngagementResumeChange[] {
  const valid = inputs.filter(
    (input) =>
      input.id.trim().length > 0 &&
      isValidTimestamp(input.at) &&
      input.summary.trim().length > 0,
  );
  const sorted = [...valid].sort((a, b) => {
    const delta = Date.parse(b.at) - Date.parse(a.at);
    if (delta !== 0) return delta;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return sorted.slice(0, RESUME_CHANGES_MAX).map((input) => ({
    kind: input.kind,
    id: input.id,
    at: input.at,
    summary: boundSummary(input.summary),
    snapshot: input.preEventRecord,
  }));
}

/** Changes since the last visit; snapshot records are included, labeled. */
export function changesSinceLastVisit(
  changes: readonly EngagementResumeChange[],
  since: string | undefined,
): EngagementResumeChange[] {
  if (since === undefined) return [...changes];
  const threshold = Date.parse(since);
  if (Number.isNaN(threshold)) return [...changes];
  return changes.filter((change) => Date.parse(change.at) > threshold);
}

export interface StarredFocusInput {
  readonly id: string;
  readonly starred: boolean;
  readonly hasActiveJob: boolean;
}

/** Toggle one id in a starred-id set; other ids are untouched. */
export function toggleStarred(starredIds: readonly string[], id: string): readonly string[] {
  if (starredIds.includes(id)) return starredIds.filter((entry) => entry !== id);
  return [...starredIds, id];
}

/**
 * Starred focus narrows the list without hiding active jobs and without
 * changing saved data. Pure selection helper; persistence lives in the
 * workspace-state store.
 */
export function applyStarredFocus<T extends StarredFocusInput>(
  items: readonly T[],
  focused: boolean,
): readonly T[] {
  if (focused === false) return items;
  const starred = items.filter((item) => item.starred);
  const activeUnstarred = items.filter((item) => item.starred === false && item.hasActiveJob);
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const item of [...starred, ...activeUnstarred]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return merged;
}

export interface PriorAttemptInput {
  readonly runId: string;
  readonly attemptedAt: string;
  readonly optionsSummary: string;
  readonly outcome: string;
  /** True when current conditions (binding/options/auth/env) differ. */
  readonly conditionsChanged: boolean;
}

/**
 * Pre-retry copy: identical retry first shows the last attempt plus its
 * conditions; environment changes are highlighted, never hidden.
 */
export function describePriorAttempt(input: PriorAttemptInput): string {
  const base = `Last attempt ${input.runId} at ${input.attemptedAt}: ${input.outcome} with ${input.optionsSummary}.`;
  if (input.conditionsChanged) {
    return `${base} Conditions changed since that attempt; review binding, options, and environment before retrying.`;
  }
  return `${base} Conditions match; retrying repeats the same attempt.`;
}
