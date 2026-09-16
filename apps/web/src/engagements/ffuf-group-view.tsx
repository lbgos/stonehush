import {
  groupFfufResults,
  hideFfufGroups,
  labelUnusualFfufResponse,
  restoreAllFfufGroups,
  undoHideFfufGroups,
  visibleFfufGroups,
  type FfufGroupableResult,
  type FfufHideState,
} from "@stonehush/domain";
import { Button } from "@stonehush/ui";
import { useMemo, useState } from "react";

/**
 * STONE-6 standalone discovery group view. Mounts via the STONE-2
 * `discovery.groups` slot after STONE-2 merges. Exact-metadata grouping
 * with basis labels, inspect/hide/undo, hidden counts, and no
 * vulnerability declarations. Wildcard calibration is offered as an
 * explicit action with its extra requests disclosed in context.
 */

export function FfufGroupView({
  results,
  onCalibrate,
}: {
  results: readonly FfufGroupableResult[];
  onCalibrate?: () => void;
}) {
  const groups = useMemo(() => groupFfufResults(results), [results]);
  const [hideState, setHideState] = useState<FfufHideState>({ hiddenBases: [] });
  const [inspected, setInspected] = useState<string | null>(null);
  const { visible, hiddenCount, hiddenMembers } = visibleFfufGroups(groups, hideState);

  return (
    <section aria-label="Discovery groups" className="overflow-hidden rounded-[10px] border border-border bg-card">
      <div className="flex min-h-10 items-center justify-between border-b border-border px-3">
        <h2 className="m-0 text-[13px] font-semibold">Discovery groups</h2>
        {hiddenCount > 0 ? (
          <span className="text-[11px] text-muted-foreground">
            {hiddenCount} hidden ({hiddenMembers} paths)
          </span>
        ) : (
          <span className="hidden text-[11px] text-muted-foreground sm:inline">Grouped by exact response metadata</span>
        )}
      </div>
      <div className="grid gap-2 p-3">
        {onCalibrate !== undefined ? (
          <p className="m-0 text-[12px] leading-5 text-muted-foreground">
            Noisy results may come from a wildcard. Calibration sends a few extra requests to a random path.{" "}
            <Button type="button" variant="quiet" onClick={onCalibrate}>
              Calibrate wildcard
            </Button>
          </p>
        ) : null}
        {visible.length === 0 ? (
          <p className="m-0 text-[12px] leading-5 text-muted-foreground">
            {groups.length === 0 ? "No discovery results yet." : "All groups are hidden."}
          </p>
        ) : null}
        <ul className="m-0 list-none space-y-2 p-0">
          {visible.map((group) => (
            <li key={group.basis} className="rounded-[10px] border border-border px-2 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[11px] text-foreground">
                  {group.basis} ({group.members.length})
                </span>
                <span className="flex gap-1">
                  <Button
                    type="button"
                    variant="quiet"
                    onClick={() => setInspected((current) => (current === group.basis ? null : group.basis))}
                  >
                    {inspected === group.basis ? "Collapse" : "Inspect"}
                  </Button>
                  <Button
                    type="button"
                    variant="quiet"
                    onClick={() => setHideState((current) => hideFfufGroups(current, [group.basis]))}
                  >
                    Hide
                  </Button>
                </span>
              </div>
              {inspected === group.basis ? (
                <ul className="m-0 mt-1 list-none space-y-1 p-0">
                  {group.members.map((member) => {
                    const label = labelUnusualFfufResponse(member);
                    return (
                      <li key={member.url} className="text-[12px] leading-5">
                        <span className="font-mono text-[11px] text-foreground">{member.url}</span>
                        {label !== null ? (
                          <span className="block text-[11px] text-muted-foreground">{label}</span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
        {hiddenCount > 0 ? (
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">
              {hiddenCount} group{hiddenCount === 1 ? "" : "s"} hidden.
            </span>
            <Button type="button" variant="quiet" onClick={() => setHideState(restoreAllFfufGroups())}>
              Undo all
            </Button>
            {hideState.hiddenBases.map((basis) => (
              <Button
                key={basis}
                type="button"
                variant="quiet"
                onClick={() => setHideState((current) => undoHideFfufGroups(current, [basis]))}
              >
                Restore {basis}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
