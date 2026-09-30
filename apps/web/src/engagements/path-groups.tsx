import type { FfufProjected } from "@stonehush/contracts";
import {
  ffufGroupBasis,
  groupFfufResults,
  hideFfufGroups,
  restoreAllFfufGroups,
  undoHideFfufGroups,
  visibleFfufGroups,
  type FfufHideState,
} from "@stonehush/domain";
import { useId, useState, type ReactNode } from "react";

const CONTROL = "min-h-11 px-2 text-[12px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring md:pointer-fine:min-h-8";

/** Presentation filters only. Full projected records stay available to the inspector. */
export function PathGroups({ paths, renderPath }: {
  paths: readonly FfufProjected[];
  renderPath: (path: FfufProjected) => ReactNode;
}) {
  const contexts = new Map<string, FfufProjected[]>();
  for (const path of paths) {
    const key = JSON.stringify([path.runId, path.artifactId]);
    const members = contexts.get(key);
    if (members) members.push(path);
    else contexts.set(key, [path]);
  }
  return <div className="border-t border-border p-2.5">
    <p className="m-0 text-[11px] text-muted-foreground">Grouped by exact response metadata.</p>
    {[...contexts].map(([key, members]) => (
      <PathGroupContext key={key} paths={members} renderPath={renderPath} />
    ))}
  </div>;
}

function PathGroupContext({ paths, renderPath }: {
  paths: readonly FfufProjected[];
  renderPath: (path: FfufProjected) => ReactNode;
}) {
  const [hidden, setHidden] = useState<FfufHideState>({ hiddenBases: [] });
  const [expanded, setExpanded] = useState<readonly string[]>([]);
  const listId = useId();
  // The domain helper owns basis and group order. Keep full typed projections
  // beside its metadata-only member type, rather than casting the members.
  const membersByBasis = new Map<string, FfufProjected[]>();
  for (const path of paths) {
    const basis = ffufGroupBasis(path);
    const members = membersByBasis.get(basis);
    if (members) members.push(path);
    else membersByBasis.set(basis, [path]);
  }
  const groups = groupFfufResults(paths);
  const { hiddenMembers: hiddenCount } = visibleFfufGroups(groups, hidden);
  const hiddenBases = new Set(hidden.hiddenBases);
  const expandedBases = new Set(expanded);
  const context = paths[0];
  if (!context) return null;
  return <section aria-label={`Path responses from run ${context.runId}, artifact ${context.artifactId}`} className="min-w-0">
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[12px]">Run {context.runId}</span>
      <span className="text-[11px] text-muted-foreground">{paths.length} results · {hiddenCount} hidden</span>
      <button type="button" className={CONTROL} onClick={() => {
        setHidden(restoreAllFfufGroups());
        setExpanded(groups.map((group) => group.basis));
      }}>Show all results</button>
    </div>
    {hiddenCount === paths.length ? <p className="text-[12px]">All results hidden.</p> : null}
    <ul className="m-0 grid list-none gap-1 p-0">
      {groups.map((group, index) => {
        const members = membersByBasis.get(group.basis) ?? [];
        const isHidden = hiddenBases.has(group.basis);
        const isExpanded = expandedBases.has(group.basis);
        const repeated = members.length > 1;
        const id = `${listId}-${index}`;
        if (!repeated && !isHidden) return members.map(renderPath);
        return <li key={group.basis} className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px]">{members.length} results · {group.basis}</span>
            {!isHidden ? <button type="button" aria-expanded={isExpanded} aria-controls={id} className={CONTROL}
              onClick={() => setExpanded((current) => isExpanded ? current.filter((basis) => basis !== group.basis) : [...current, group.basis])}>
              {isExpanded ? "Collapse" : "Expand"}
            </button> : null}
            <button type="button" className={CONTROL} onClick={() => {
              setHidden((current) => isHidden ? undoHideFfufGroups(current, [group.basis]) : hideFfufGroups(current, [group.basis]));
            }}>{isHidden ? "Restore" : "Hide"}</button>
          </div>
          <ul id={id} className="m-0 grid list-none gap-1 p-0" hidden={isHidden || !isExpanded}>
            {!isHidden && isExpanded ? members.map(renderPath) : null}
          </ul>
        </li>;
      })}
    </ul>
  </section>;
}
