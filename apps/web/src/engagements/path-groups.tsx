import type { FfufProjected } from "@stonehush/contracts";
import { ffufGroupBasis } from "@stonehush/domain";
import { useId, useRef, type Dispatch, type ReactNode, type SetStateAction } from "react";

import { formatEngagementTimestamp } from "./format.js";
import { pathGroupRowKey, pathSelectionKey } from "./inspector.js";

// Path results for one observed origin as one flat list. Results that share
// exact status, length, words and lines within a run and artifact fold under a
// group header. That is equal metadata, not equal bodies, so every member keeps
// its own row, selection key and evidence. Folding and hiding are presentation
// filters only: they fetch nothing, persist nothing and never change the
// records the inspector reads.

/**
 * Ephemeral filter state for every origin on Surface. Keys come from
 * pathGroupKey, so one set serves all engagements, origins and runs without
 * mixing them. Counts intersect the sets with current data, so keys for
 * results that no longer exist are inert.
 */
export interface PathFilters {
  readonly expanded: ReadonlySet<string>;
  readonly hidden: ReadonlySet<string>;
}

export const EMPTY_PATH_FILTERS: PathFilters = { expanded: new Set(), hidden: new Set() };

interface PathGroup {
  readonly key: string;
  readonly rowKey: string;
  readonly basis: string;
  readonly members: readonly FfufProjected[];
}

interface PathContext {
  readonly key: string;
  readonly runId: string;
  readonly artifactId: string;
  readonly latestObservedAt: string;
  readonly singles: readonly FfufProjected[];
  readonly groups: readonly PathGroup[];
  readonly count: number;
}

function pathGroupKey(engagementId: string, result: FfufProjected): string {
  return JSON.stringify([engagementId, pathGroupRowKey(result)]);
}

function observedTime(value: string): number {
  const time = Date.parse(value);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

// Newest context first. Inside a context, unique responses come first in URL
// order, then groups from smallest to largest so the biggest one expands last.
function pathContexts(engagementId: string, paths: readonly FfufProjected[]): PathContext[] {
  const byContext = new Map<string, FfufProjected[]>();
  for (const path of [...paths].sort((left, right) => left.url.localeCompare(right.url))) {
    const key = JSON.stringify([path.runId, path.artifactId]);
    const members = byContext.get(key);
    if (members) members.push(path);
    else byContext.set(key, [path]);
  }
  const contexts: PathContext[] = [];
  for (const [key, members] of byContext) {
    const first = members[0];
    if (first === undefined) continue;
    const byBasis = new Map<string, FfufProjected[]>();
    let latestObservedAt = first.observedAt;
    for (const member of members) {
      if (observedTime(member.observedAt) > observedTime(latestObservedAt)) latestObservedAt = member.observedAt;
      const basis = ffufGroupBasis(member);
      const bucket = byBasis.get(basis);
      if (bucket) bucket.push(member);
      else byBasis.set(basis, [member]);
    }
    const singles: FfufProjected[] = [];
    const groups: PathGroup[] = [];
    for (const [basis, bucket] of byBasis) {
      const head = bucket[0];
      if (head === undefined) continue;
      if (bucket.length === 1) singles.push(head);
      else groups.push({ key: pathGroupKey(engagementId, head), rowKey: pathGroupRowKey(head), basis, members: bucket });
    }
    groups.sort((left, right) => {
      const a = left.members[0];
      const b = right.members[0];
      if (left.members.length !== right.members.length) return left.members.length - right.members.length;
      if (a === undefined || b === undefined) return 0;
      return a.status - b.status || a.length - b.length || a.words - b.words || a.lines - b.lines;
    });
    contexts.push({
      key,
      runId: first.runId,
      artifactId: first.artifactId,
      latestObservedAt,
      singles,
      groups,
      count: members.length,
    });
  }
  return contexts.sort(
    (left, right) =>
      observedTime(right.latestObservedAt) - observedTime(left.latestObservedAt) ||
      left.artifactId.localeCompare(right.artifactId),
  );
}

function toggled(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(set);
  if (!next.delete(key)) next.add(key);
  return next;
}

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

const TEXT_BUTTON =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-sm px-2 text-[12px] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring md:pointer-fine:min-h-8 md:pointer-fine:min-w-0";

export function PathGroups({
  engagementId,
  filters,
  label,
  paths,
  renderPath,
  selectedKey,
  setFilters,
}: {
  engagementId: string;
  filters: PathFilters;
  label: string;
  paths: readonly FfufProjected[];
  renderPath: (path: FfufProjected) => ReactNode;
  /** Resolved, artifact-qualified path key of the open inspector selection. */
  selectedKey: string | undefined;
  setFilters: Dispatch<SetStateAction<PathFilters>>;
}) {
  const baseId = useId();
  const countRef = useRef<HTMLDivElement>(null);
  const contexts = pathContexts(engagementId, paths);
  const groups = contexts.flatMap((context) => context.groups);
  const hiddenCount = groups.reduce(
    (total, group) => (filters.hidden.has(group.key) ? total + group.members.length : total),
    0,
  );
  const labelled = contexts.length > 1;
  const contextTimes = contexts.map((context) => formatEngagementTimestamp(context.latestObservedAt));

  const showAll = () => {
    setFilters((current) => {
      const hidden = new Set(current.hidden);
      for (const group of groups) hidden.delete(group.key);
      return { ...current, hidden };
    });
    // Show all unmounts itself. The count line keeps focus in place.
    countRef.current?.focus({ preventScroll: true });
  };

  return (
    <section aria-label={`Path results for ${label}`} className="border-t border-border">
      <div
        ref={countRef}
        tabIndex={-1}
        className="flex min-h-11 flex-wrap items-center gap-x-3 px-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset md:pointer-fine:min-h-8"
      >
        <span className="text-[12px] font-semibold">
          {plural(paths.length, "path", "paths")}
          {groups.length > 0 ? ` · ${plural(groups.length, "group", "groups")}` : null}
        </span>
        <span aria-live="polite" aria-atomic="true" className="ml-auto text-[12px] tabular-nums">
          {hiddenCount > 0 ? `${String(hiddenCount)} hidden` : null}
        </span>
        {hiddenCount > 0 ? (
          <button type="button" onClick={showAll} className={`${TEXT_BUTTON} font-semibold text-foreground`}>
            Show all
          </button>
        ) : null}
      </div>
      {contexts.map((context, contextIndex) => (
        <div key={context.key} className="border-t border-border">
          {labelled ? (
            <div
              className="flex min-h-8 flex-wrap items-baseline justify-between gap-x-3 px-2.5 py-1.5"
              title={`run ${context.runId} · artifact ${context.artifactId}`}
            >
              <h4 className="m-0 text-[12px] font-semibold">
                Run {contextTimes[contextIndex]}
                {contextTimes.filter((time) => time === contextTimes[contextIndex]).length > 1
                  ? ` · result ${String(contextIndex + 1)}` : null}
              </h4>
              <span className="font-mono text-[11px] tabular-nums">
                {plural(context.count, "path", "paths")}
              </span>
            </div>
          ) : null}
          <ul className={`m-0 list-none divide-y divide-border p-0 ${labelled ? "border-t border-border" : ""}`}>
            {context.singles.map(renderPath)}
            {context.groups.map((group, groupIndex) => (
              <PathGroupItem
                key={group.key}
                expanded={filters.expanded.has(group.key)}
                group={group}
                hidden={filters.hidden.has(group.key)}
                id={`${baseId}-${String(contextIndex)}-${String(groupIndex)}`}
                onToggleExpanded={() =>
                  setFilters((current) => ({ ...current, expanded: toggled(current.expanded, group.key) }))
                }
                onToggleHidden={() =>
                  setFilters((current) => ({ ...current, hidden: toggled(current.hidden, group.key) }))
                }
                renderPath={renderPath}
                selectedKey={selectedKey}
              />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function PathGroupItem({
  expanded,
  group,
  hidden,
  id,
  onToggleExpanded,
  onToggleHidden,
  renderPath,
  selectedKey,
}: {
  expanded: boolean;
  group: PathGroup;
  hidden: boolean;
  id: string;
  onToggleExpanded: () => void;
  onToggleHidden: () => void;
  renderPath: (path: FfufProjected) => ReactNode;
  selectedKey: string | undefined;
}) {
  const count = group.members.length;
  // A collapsed group still shows the selected member so the operator can see
  // which row the inspector holds. A hidden group shows only its header.
  const members = hidden
    ? []
    : expanded
      ? group.members
      : group.members.filter((member) => pathSelectionKey(member.url, member.artifactId) === selectedKey);
  const basisClass =
    "flex min-h-11 w-full min-w-0 items-center gap-1.5 text-left font-mono text-[12px] sm:w-auto sm:flex-1 md:pointer-fine:min-h-8";
  return (
    <li className="min-w-0">
      <div data-surface-row={group.rowKey} className="flex flex-wrap items-center gap-x-2 px-2.5">
        {hidden ? (
          <span key="basis" className={`${basisClass} text-muted-foreground`}>
            <span aria-hidden="true" className="w-4 shrink-0" />
            <span className="min-w-0 [overflow-wrap:anywhere]">{group.basis}</span>
          </span>
        ) : (
          <button
            key="disclosure"
            type="button"
            aria-controls={id}
            aria-describedby={`${id}-count`}
            aria-expanded={expanded}
            onClick={onToggleExpanded}
            className={`${basisClass} rounded-sm text-foreground outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring`}
          >
            <span aria-hidden="true" className="w-4 shrink-0 text-center">
              {expanded ? "▾" : "▸"}
            </span>
            <span className="min-w-0 [overflow-wrap:anywhere]">{group.basis}</span>
          </button>
        )}
        <span
          key="count"
          id={`${id}-count`}
          className="ml-auto min-w-20 text-right font-mono text-[11px] tabular-nums"
        >
          {hidden ? `${String(count)} hidden` : `${String(count)} paths`}
        </span>
        {/* One node for both states so focus survives Hide and Restore. */}
        <button
          key="action"
          type="button"
          aria-label={`${hidden ? "Restore" : "Hide"} ${group.basis}`}
          onClick={onToggleHidden}
          className={`${TEXT_BUTTON} ${hidden ? "font-semibold text-foreground" : "font-medium text-muted-foreground hover:text-foreground"}`}
        >
          {hidden ? "Restore" : "Hide"}
        </button>
      </div>
      <ul
        id={id}
        className="m-0 list-none divide-y divide-border border-t border-border p-0 pl-3 empty:hidden sm:pl-6"
      >
        {members.map(renderPath)}
      </ul>
    </li>
  );
}
