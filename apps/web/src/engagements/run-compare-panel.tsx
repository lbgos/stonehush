import type {
  FfufProjected,
  HttpProbeProjected,
  NmapProjectedService,
  PersistedAction,
  RunHistorySummary,
  RunOutputResponse,
} from "@stonehush/contracts";
import { isTerminalRunState } from "@stonehush/domain";
import { LoadingRegion, RecoverableError, Skeleton } from "@stonehush/ui";
import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { persistedActionQueryOptions } from "./action-query.js";
import { formatEngagementTimestamp } from "./format.js";
import {
  useEngagementFfufResultsQuery,
  useEngagementHttpProbesQuery,
  useEngagementServicesQuery,
} from "./query.js";
import { RunDiffView } from "./run-diff-view.js";
import { useRunHistoryQuery } from "./run-history-query.js";
import { useRunOutputQuery } from "./run-output-query.js";
import {
  actionBindingSummary,
  actionOptionsSummary,
  buildPriorAttempt,
  buildRunCompareInput,
  describeRunOutcome,
  resolveRunComparison,
  runSideComplete,
} from "./run-compare.js";

function shortRunId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

interface CompareProjections {
  readonly services: readonly NmapProjectedService[];
  readonly probes: readonly HttpProbeProjected[];
  readonly results: readonly FfufProjected[];
}

// Read-only comparison of the selected terminal run against one explicitly
// chosen prior run from the loaded history. Composes only existing GET query
// data: run history summaries, engagement projections filtered by exact run
// id, exact per-run output, and persisted action snapshots for the two runs.
// Issues no mutation, executes nothing, and never moves the history list,
// filters, held-back baseline, or selection.
export function RunCompareSection({
  engagementId,
  selectedRunId,
  selectedOutput,
}: {
  engagementId: string;
  selectedRunId: string;
  selectedOutput: RunOutputResponse;
}) {
  const contextKey = `${engagementId}::${selectedRunId}`;
  const [renderKey, setRenderKey] = useState(contextKey);
  const [priorRunId, setPriorRunId] = useState<string | null>(null);
  // A new engagement or selected run starts with no prior pick, so a late
  // state update for the previous context never leaks into this one.
  if (renderKey !== contextKey) {
    setRenderKey(contextKey);
    setPriorRunId(null);
  }

  const history = useRunHistoryQuery(engagementId);
  const servicesQuery = useEngagementServicesQuery(engagementId);
  const probesQuery = useEngagementHttpProbesQuery(engagementId);
  const resultsQuery = useEngagementFfufResultsQuery(engagementId);

  const loadedRuns = useMemo(
    () => history.data?.pages.flatMap((page) => page.runs) ?? [],
    [history.data],
  );
  const projections: CompareProjections = useMemo(
    () => ({
      services: servicesQuery.data ?? [],
      probes: probesQuery.data ?? [],
      results: resultsQuery.data ?? [],
    }),
    [servicesQuery.data, probesQuery.data, resultsQuery.data],
  );

  const selectedRun = loadedRuns.find((run) => run.id === selectedRunId);
  const priorRun = priorRunId === null ? undefined : loadedRuns.find((run) => run.id === priorRunId);

  const selectedAction = useQuery(persistedActionQueryOptions(engagementId, selectedRun?.actionId));
  const priorAction = useQuery(persistedActionQueryOptions(engagementId, priorRun?.actionId));
  const priorOutput = useRunOutputQuery(engagementId, priorRun?.id);

  if (history.data === undefined) {
    if (history.isError) {
      return (
        <CompareShell title="Compare runs">
          <RecoverableError
            title="Comparison unavailable"
            description="The run history could not be loaded from the local control plane."
            onRetry={() => void history.refetch()}
          />
        </CompareShell>
      );
    }
    return (
      <CompareShell title="Compare runs">
        <LoadingRegion label="Loading run history for comparison" className="mt-3 space-y-2">
          <Skeleton className="h-8 w-full" />
        </LoadingRegion>
      </CompareShell>
    );
  }

  const projectionsReady =
    servicesQuery.data !== undefined &&
    probesQuery.data !== undefined &&
    resultsQuery.data !== undefined;
  if (!projectionsReady) {
    const failed =
      (servicesQuery.isError && servicesQuery.data === undefined) ||
      (probesQuery.isError && probesQuery.data === undefined) ||
      (resultsQuery.isError && resultsQuery.data === undefined);
    if (failed) {
      return (
        <CompareShell title="Compare runs">
          <RecoverableError
            title="Comparison unavailable"
            description="The observation lists could not be loaded from the local control plane. Comparing without all three lists could mislabel a run."
            onRetry={() => {
              void servicesQuery.refetch();
              void probesQuery.refetch();
              void resultsQuery.refetch();
            }}
          />
        </CompareShell>
      );
    }
    return (
      <CompareShell title="Compare runs">
        <LoadingRegion label="Loading observations for comparison" className="mt-3 space-y-2">
          <Skeleton className="h-8 w-full" />
        </LoadingRegion>
      </CompareShell>
    );
  }

  if (selectedRun === undefined) {
    return (
      <CompareShell title="Compare runs">
        <p className="mt-1 mb-0 text-[12px] leading-5 text-muted-foreground">
          The selected run is not in the loaded history. Load more history or pick a loaded run.
        </p>
      </CompareShell>
    );
  }

  if (!isTerminalRunState(selectedRun.state)) {
    return (
      <CompareShell title="Compare runs">
        <p className="mt-1 mb-0 text-[12px] leading-5 text-muted-foreground">
          Comparison needs a finished selected run. Preserved output appears automatically when the run finishes.
        </p>
      </CompareShell>
    );
  }

  const selectedResolved = resolveRunComparison(selectedRun.id, projections);
  if (selectedResolved.ok === false) {
    return (
      <CompareShell title="Compare runs">
        <p className="mt-1 mb-0 text-[12px] leading-5 text-muted-foreground">
          {selectedResolved.reason}
        </p>
      </CompareShell>
    );
  }

  const candidates = loadedRuns.filter(
    (run) =>
      run.id !== selectedRunId &&
      isTerminalRunState(run.state) &&
      resolveRunComparison(run.id, projections).ok,
  );
  const projectionsStale = servicesQuery.isError || probesQuery.isError || resultsQuery.isError;

  return (
    <CompareShell title="Compare runs">
      <p className="mt-1 mb-0 text-[12px] leading-5 text-muted-foreground">
        Explicit prior run only. Nothing runs, nothing is retried, and the history order never moves.
      </p>
      {projectionsStale ? (
        <p className="mt-1 mb-0 text-[12px] leading-5 text-warning" role="status">
          Showing the last successful observation lists. The latest refresh failed.
        </p>
      ) : null}
      {candidates.length === 0 ? (
        <p className="mt-2 mb-0 text-[12px] leading-5 text-muted-foreground">
          No comparable prior runs loaded. Only finished runs with recorded observations in one tool qualify.
        </p>
      ) : (
        <label className="mt-2 grid gap-1 text-[11px] text-muted-foreground" htmlFor="run-compare-prior">
          <span>Prior run</span>
          <select
            id="run-compare-prior"
            className="min-h-8 rounded-md border border-input bg-transparent px-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={priorRunId ?? ""}
            onChange={(event) => setPriorRunId(event.target.value === "" ? null : event.target.value)}
          >
            <option value="">Choose a prior run</option>
            {candidates.map((run) => {
              const resolved = resolveRunComparison(run.id, projections);
              const detail =
                resolved.ok === false ? "unknown context" : `${resolved.value.tool} · ${resolved.value.origin}`;
              return (
                <option key={run.id} value={run.id} title={run.id}>
                  {shortRunId(run.id)} · {detail} · {describeRunOutcome(run)} ·{" "}
                  {formatEngagementTimestamp(run.updatedAt)}
                </option>
              );
            })}
          </select>
        </label>
      )}
      {priorRunId !== null ? (
        <ChosenComparison
          loadedRuns={loadedRuns}
          projections={projections}
          selectedRun={selectedRun}
          selectedOutput={selectedOutput}
          priorRunId={priorRunId}
          selectedActionPending={selectedAction.isPending}
          priorActionPending={priorAction.isPending}
          priorOutputPending={priorOutput.isFetching && priorOutput.data === undefined}
          priorOutputError={priorOutput.isError}
          selectedActionData={selectedAction.data}
          priorActionData={priorAction.data}
          priorOutputData={priorOutput.data}
          onClear={() => setPriorRunId(null)}
        />
      ) : null}
    </CompareShell>
  );
}

function CompareShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="mt-4 border-t border-border pt-3">
      <h3 className="m-0 text-[13px] font-semibold">{title}</h3>
      {children}
    </section>
  );
}

// Presentational only: every query already runs in the section above, so this
// second validation before the join adds no fetches of its own. The picker
// only offers resolvable terminal runs; each guard below rechecks that the
// chosen id still names a distinct finished run with known context.
function ChosenComparison({
  loadedRuns,
  projections,
  selectedRun,
  selectedOutput,
  priorRunId,
  selectedActionPending,
  priorActionPending,
  priorOutputPending,
  priorOutputError,
  selectedActionData,
  priorActionData,
  priorOutputData,
  onClear,
}: {
  loadedRuns: readonly RunHistorySummary[];
  projections: CompareProjections;
  selectedRun: RunHistorySummary;
  selectedOutput: RunOutputResponse;
  priorRunId: string;
  selectedActionPending: boolean;
  priorActionPending: boolean;
  priorOutputPending: boolean;
  priorOutputError: boolean;
  selectedActionData: PersistedAction | undefined;
  priorActionData: PersistedAction | undefined;
  priorOutputData: RunOutputResponse | undefined;
  onClear: () => void;
}) {
  const priorRun = loadedRuns.find((run) => run.id === priorRunId);
  if (priorRun === undefined) {
    return (
      <div className="mt-3">
        <p className="m-0 text-[12px] leading-5 text-muted-foreground" role="alert">
          That run is no longer in the loaded history. Pick another prior run.
        </p>
        <ClearComparison onClear={onClear} />
      </div>
    );
  }
  if (priorRun.id === selectedRun.id) {
    return (
      <div className="mt-3">
        <p className="m-0 text-[12px] leading-5 text-muted-foreground" role="alert">
          A run cannot be compared with itself. Pick another prior run.
        </p>
        <ClearComparison onClear={onClear} />
      </div>
    );
  }
  if (!isTerminalRunState(priorRun.state)) {
    return (
      <div className="mt-3">
        <p className="m-0 text-[12px] leading-5 text-muted-foreground" role="alert">
          The prior run is no longer finished. Pick another prior run.
        </p>
        <ClearComparison onClear={onClear} />
      </div>
    );
  }

  const selectedResolved = resolveRunComparison(selectedRun.id, projections);
  const priorResolved = resolveRunComparison(priorRun.id, projections);
  if (selectedResolved.ok === false || priorResolved.ok === false) {
    const reason =
      selectedResolved.ok === false ? selectedResolved.reason : (priorResolved as { reason: string }).reason;
    return (
      <div className="mt-3">
        <p className="m-0 text-[12px] leading-5 text-muted-foreground" role="alert">
          {reason} Pick another prior run.
        </p>
        <ClearComparison onClear={onClear} />
      </div>
    );
  }

  if (selectedActionPending || priorActionPending || priorOutputPending) {
    return (
      <div className="mt-3">
        <LoadingRegion label="Loading comparison context" className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-24 w-full" />
        </LoadingRegion>
        <ClearComparison onClear={onClear} />
      </div>
    );
  }

  const beforeOptions = actionOptionsSummary(priorActionData);
  const afterOptions = actionOptionsSummary(selectedActionData);
  const beforeBinding = actionBindingSummary(priorActionData);
  const afterBinding = actionBindingSummary(selectedActionData);
  const optionsKnown = priorActionData !== undefined && selectedActionData !== undefined;
  const conditionsChanged =
    beforeBinding !== afterBinding || beforeOptions !== afterOptions || !optionsKnown;

  const input = buildRunCompareInput({
    before: {
      run: priorRun,
      context: {
        tool: priorResolved.value.tool,
        origin: priorResolved.value.origin,
        ports: null,
        optionsSummary: beforeOptions,
        authSummary: null,
        binding: beforeBinding,
      },
      complete: runSideComplete(priorRun, priorOutputData),
    },
    after: {
      run: selectedRun,
      context: {
        tool: selectedResolved.value.tool,
        origin: selectedResolved.value.origin,
        ports: null,
        optionsSummary: afterOptions,
        authSummary: null,
        binding: afterBinding,
      },
      complete: runSideComplete(selectedRun, selectedOutput),
    },
    projections,
  });

  return (
    <div className="mt-3 grid gap-3">
      {priorOutputError ? (
        <p className="m-0 text-[12px] leading-5 text-warning" role="status">
          Prior run output failed to load, so its side counts as incomplete. Absence disproves nothing.
        </p>
      ) : null}
      {!optionsKnown ? (
        <p className="m-0 text-[12px] leading-5 text-warning" role="status">
          Action records failed to load, so options and binding are unknown. The prior attempt line treats conditions as changed.
        </p>
      ) : null}
      <RunDiffView
        input={input}
        priorAttempt={buildPriorAttempt({
          run: priorRun,
          optionsSummary: beforeOptions,
          conditionsChanged,
        })}
      />
      <div>
        <ClearComparison onClear={onClear} />
      </div>
    </div>
  );
}

function ClearComparison({ onClear }: { onClear: () => void }) {
  return (
    <button
      type="button"
      onClick={onClear}
      className="mt-2 inline-flex min-h-8 items-center rounded-md px-2 text-[12px] font-medium text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      Clear comparison
    </button>
  );
}
