import { isTerminalRunState } from "@stonehush/domain";
import { useEffect, useRef, useState } from "react";

import { useRunHistoryQuery } from "./run-history-query.js";

// Execution tray and stable-order helpers for STONE-2.
//
// The tray is a compact read-only strip: it shows active work and adds a
// quiet finished indicator when background runs complete. It never steals
// focus, never opens output over reading material, and issues no model or
// mutation requests. Result order stays stable in the run history panel:
// newly arrived runs are held back behind an explicit Show new results
// affordance instead of shifting rows while the operator reads or selects
// text. Updates to already visible rows (state changes, removals) still
// render immediately so progress and exact-output fetching keep working.

export interface HeldBackSplit {
  readonly heldBackCount: number;
  readonly visibleIds: readonly string[];
}

export function splitHeldBackIds(
  currentIds: readonly string[],
  baselineIds: readonly string[] | undefined,
  pinnedId: string | undefined,
): HeldBackSplit {
  if (baselineIds === undefined) return { heldBackCount: 0, visibleIds: currentIds };
  const baseline = new Set(baselineIds);
  return {
    heldBackCount: currentIds.filter((id) => !baseline.has(id) && id !== pinnedId).length,
    visibleIds: currentIds.filter((id) => baseline.has(id) || id === pinnedId),
  };
}

function shortRunId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

export interface ExecutionTrayProps {
  readonly engagementId: string;
  readonly onOpenRun: (runId: string) => void;
}

export function ExecutionTray({ engagementId, onOpenRun }: ExecutionTrayProps) {
  const history = useRunHistoryQuery(engagementId);
  const [baseline, setBaseline] = useState<
    { engagementId: string; terminalIds: readonly string[]; pageCount: number } | undefined
  >(undefined);
  if (baseline !== undefined && baseline.engagementId !== engagementId) {
    setBaseline(undefined);
  }

  const pageCount = history.data?.pages.length ?? 0;
  useEffect(() => {
    if (history.data === undefined) return;
    const pages = history.data.pages;
    if (baseline === undefined) {
      setBaseline({
        engagementId,
        terminalIds: pages
          .flatMap((page) => page.runs)
          .filter((run) => isTerminalRunState(run.state))
          .map((run) => run.id),
        pageCount: pages.length,
      });
      return;
    }
    if (baseline.engagementId !== engagementId) return;
    // Older pages appended by fetchNextPage are history, not newly finished
    // work: fold their terminals into the baseline so only state transitions
    // on already watched rows surface as finished. Refetches never change
    // pageCount, so genuine completions still surface.
    if (pages.length > baseline.pageCount) {
      const addedTerminalIds = pages
        .slice(baseline.pageCount)
        .flatMap((page) => page.runs)
        .filter((run) => isTerminalRunState(run.state))
        .map((run) => run.id)
        .filter((id) => !baseline.terminalIds.includes(id));
      setBaseline({
        engagementId: baseline.engagementId,
        terminalIds:
          addedTerminalIds.length === 0
            ? baseline.terminalIds
            : [...baseline.terminalIds, ...addedTerminalIds],
        pageCount: pages.length,
      });
    }
  }, [baseline, engagementId, history.data]);

  // Bounded automatic walk of the newest history. The walk must not stop at
  // the first active run: older concurrent actives would silently vanish and
  // lose polling. The list endpoint offers no state filter (limit/before
  // only), so the tray pages newest-first up to MAX_TRAY_PAGES and says so
  // honestly when older history remains unchecked.
  const MAX_TRAY_PAGES = 8;
  const runs = history.data?.pages.flatMap((page) => page.runs) ?? [];
  const active = runs.filter((run) => !isTerminalRunState(run.state));
  const canFetchMore =
    history.data !== undefined &&
    history.hasNextPage === true &&
    !history.isFetchingNextPage &&
    !history.isError &&
    pageCount < MAX_TRAY_PAGES;

  useEffect(() => {
    if (canFetchMore) {
      void history.fetchNextPage();
    }
  }, [canFetchMore, history]);
  // Auto paging is exhausted but older history exists: coverage is partial.
  // Never silently declare the full picture; offer an explicit continue.
  const partialCoverage =
    history.data !== undefined &&
    !history.isError &&
    history.hasNextPage === true &&
    pageCount >= MAX_TRAY_PAGES;
  const checkOlderRuns = () => {
    void history.fetchNextPage();
  };
  const baselineTerminal = baseline === undefined ? undefined : new Set(baseline.terminalIds);
  // Terminals on pages appended after the baseline snapshot are history, not
  // newly finished work: exclude them until the baseline effect folds them
  // in, so the live region never announces an old run as new. Active runs on
  // those pages stay tracked, so a later completion still surfaces once the
  // baseline covers the page.
  const watchedIds =
    baseline === undefined || history.data === undefined
      ? new Set<string>()
      : new Set(
          history.data.pages
            .slice(0, baseline.pageCount)
            .flatMap((page) => page.runs)
            .map((run) => run.id),
        );
  const finished =
    baselineTerminal === undefined
      ? []
      : runs.filter(
          (run) =>
            isTerminalRunState(run.state) &&
            !baselineTerminal.has(run.id) &&
            watchedIds.has(run.id),
        );

  const refetchRef = useRef(history.refetch);
  useEffect(() => {
    refetchRef.current = history.refetch;
  });
  const hasActive = active.length > 0;
  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(() => {
      void refetchRef.current();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [engagementId, hasActive]);

  if (history.data === undefined || history.isError) return null;
  if (active.length === 0 && finished.length === 0 && !partialCoverage) return null;

  // Runs arrive newest-first, so the first finished entry is the most recent.
  const latestFinished = finished[0];

  return (
    <section
      aria-label="Execution tray"
      className="mt-5 overflow-hidden rounded-[10px] border border-border bg-card"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
        <p className="m-0 text-[12px] text-muted-foreground" aria-live="polite">
          {active.length} active
          {finished.length > 0 ? (
            <>
              {" · "}
              {finished.length} finished
              {latestFinished === undefined ? null : (
                <button
                  type="button"
                  title={latestFinished.id}
                  onClick={() => onOpenRun(latestFinished.id)}
                  className="font-mono text-foreground underline underline-offset-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring rounded px-0.5"
                >
                  {" "}
                  ({shortRunId(latestFinished.id)})
                </button>
              )}
            </>
          ) : null}
        </p>
        {active.slice(0, 3).map((run) => (
          <button
            key={run.id}
            type="button"
            title={run.id}
            onClick={() => onOpenRun(run.id)}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-border px-2 font-mono text-[11px] text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span>{run.state}</span>
            <span className="text-muted-foreground">{shortRunId(run.id)}</span>
          </button>
        ))}
        {active.length > 3 ? (
          <span className="font-mono text-[11px] text-muted-foreground">
            +{active.length - 3} more
          </span>
        ) : null}
        {partialCoverage ? (
          <span className="inline-flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-muted-foreground">
            <span>
              Newest {runs.length} runs checked; older history unchecked.
            </span>
            <button
              type="button"
              disabled={history.isFetchingNextPage}
              onClick={checkOlderRuns}
              className="inline-flex min-h-8 items-center rounded-md border border-border px-2 text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            >
              {history.isFetchingNextPage ? "Checking…" : "Check older runs"}
            </button>
          </span>
        ) : null}
      </div>
    </section>
  );
}
