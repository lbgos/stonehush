/**
 * STONE-6 ffuf grouping helper. Exact-metadata grouping with basis labels,
 * inspect/hide/undo, and hidden counts. No vulnerability declarations:
 * unusual responses stay visible with a neutral label. Pure, tested.
 */

export interface FfufGroupableResult {
  readonly url: string;
  readonly status: number;
  readonly length: number;
  readonly words: number;
  readonly lines: number;
  readonly fuzz: string;
  readonly redirectlocation?: string | null;
}

export interface FfufResultGroup {
  /** Exact-metadata basis, e.g. "status 200, length 512, words 40, lines 12". */
  readonly basis: string;
  readonly status: number;
  readonly length: number;
  readonly words: number;
  readonly lines: number;
  readonly members: readonly FfufGroupableResult[];
}

export function ffufGroupBasis(input: Pick<FfufGroupableResult, "status" | "length" | "words" | "lines">): string {
  return `status ${input.status}, length ${input.length}, words ${input.words}, lines ${input.lines}`;
}

/**
 * Group by exact (status, length, words, lines). Largest groups first with
 * a stable basis tie-break. Every visible member keeps its exact URL.
 */
export function groupFfufResults(results: readonly FfufGroupableResult[]): FfufResultGroup[] {
  const buckets = new Map<string, FfufGroupableResult[]>();
  for (const result of results) {
    const key = `${result.status}|${result.length}|${result.words}|${result.lines}`;
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [result]);
    else bucket.push(result);
  }
  const groups: FfufResultGroup[] = [];
  for (const members of buckets.values()) {
    const first = members[0];
    if (first === undefined) continue;
    groups.push({
      basis: ffufGroupBasis(first),
      status: first.status,
      length: first.length,
      words: first.words,
      lines: first.lines,
      members,
    });
  }
  groups.sort((a, b) => {
    if (b.members.length !== a.members.length) return b.members.length - a.members.length;
    return a.basis < b.basis ? -1 : a.basis > b.basis ? 1 : 0;
  });
  return groups;
}

export interface FfufHideState {
  readonly hiddenBases: readonly string[];
}

/** Hide whole groups by basis. Returns the state; the change list is exact. */
export function hideFfufGroups(state: FfufHideState, bases: readonly string[]): FfufHideState {
  const merged = new Set(state.hiddenBases);
  for (const basis of bases) merged.add(basis);
  return { hiddenBases: [...merged].sort() };
}

export function undoHideFfufGroups(state: FfufHideState, bases: readonly string[]): FfufHideState {
  const remove = new Set(bases);
  return { hiddenBases: state.hiddenBases.filter((basis) => remove.has(basis) === false) };
}

export function restoreAllFfufGroups(): FfufHideState {
  return { hiddenBases: [] };
}

export function visibleFfufGroups(
  groups: readonly FfufResultGroup[],
  state: FfufHideState,
): { visible: FfufResultGroup[]; hiddenCount: number; hiddenMembers: number } {
  const hidden = new Set(state.hiddenBases);
  const visible = groups.filter((group) => hidden.has(group.basis) === false);
  const hiddenGroups = groups.filter((group) => hidden.has(group.basis));
  return {
    visible,
    hiddenCount: hiddenGroups.length,
    hiddenMembers: hiddenGroups.reduce((total, group) => total + group.members.length, 0),
  };
}

/**
 * Neutral label for unusual responses. Reported as observed, never as a
 * vulnerability claim.
 */
export function labelUnusualFfufResponse(result: FfufGroupableResult): string | null {
  if (result.status === 401 || result.status === 403) {
    return "Unusual response: access refused. Observed behavior only, not a vulnerability claim.";
  }
  if (result.status >= 500) {
    return "Unusual response: server error. Observed behavior only, not a vulnerability claim.";
  }
  if (result.length === 0) {
    return "Unusual response: empty body. Observed behavior only, not a vulnerability claim.";
  }
  return null;
}
