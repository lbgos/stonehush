import type { RunHistorySummary, RunOutputResponse } from "@stonehush/contracts";
import { isTerminalRunState } from "@stonehush/domain";
import { Button, LoadingRegion, RecoverableError, Skeleton } from "@stonehush/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { persistedActionQueryOptions } from "./action-query.js";
import { formatEngagementTimestamp } from "./format.js";
import {
  engagementFfufResultsQueryOptions,
  engagementHttpProbesQueryOptions,
  engagementServicesQueryOptions,
} from "./query.js";
import {
  actionBindingSummary,
  actionOptionsSummary,
  buildRunCompareInput,
  describeRunOutcome,
  resolveRunComparison,
  runSideComplete,
  stableStringifyOptions,
} from "./run-compare.js";
import { RunDiffView } from "./run-diff-view.js";
import { useRunOutputQuery } from "./run-output-query.js";

export function priorComparisonRuns(runs: readonly RunHistorySummary[], selected: RunHistorySummary) {
  // The history endpoint uses createdAt/id descending as its stable order.
  return runs.filter((run) => isTerminalRunState(run.state) && (
    run.createdAt < selected.createdAt || (run.createdAt === selected.createdAt && run.id < selected.id)
  ));
}

// Use the history's admitted rows, before local filters, so held-back arrivals
// cannot move the picker. Fetch execution context only after an explicit pick.
export function RunCompareSection({ engagementId, loadedRuns, selectedOutput, sourceStale }: {
  engagementId: string;
  loadedRuns: readonly RunHistorySummary[];
  selectedOutput: RunOutputResponse;
  sourceStale: boolean;
}) {
  const selectedRun = loadedRuns.find((run) => run.id === selectedOutput.run.id);
  const [priorRunId, setPriorRunId] = useState("");
  if (selectedRun === undefined || !isTerminalRunState(selectedRun.state)) return null;
  const candidates = priorComparisonRuns(loadedRuns, selectedRun);
  const priorRun = candidates.find((run) => run.id === priorRunId);
  return (
    <section aria-label="Compare runs" className="mt-4 border-t border-border pt-3">
      <h3 className="m-0 text-[13px] font-semibold">Compare runs</h3>
      {candidates.length === 0 ? (
        <p className="mt-1 mb-0 text-[12px] text-muted-foreground">Load an earlier finished run to compare.</p>
      ) : (
        <label className="mt-2 grid gap-1 text-[11px] text-muted-foreground" htmlFor="run-compare-prior">
          <span>Prior run</span>
          <select id="run-compare-prior" value={priorRunId}
            className="min-h-8 min-w-0 w-full border border-input bg-background px-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) => setPriorRunId(event.target.value)}>
            <option value="">Choose a prior run</option>
            {candidates.map((run) => (
              <option key={run.id} value={run.id}>
                {run.id} · {describeRunOutcome(run)} · {formatEngagementTimestamp(run.createdAt)}
              </option>
            ))}
          </select>
        </label>
      )}
      {priorRunId !== "" ? (
        <div className="mt-3 grid gap-2">
          {sourceStale ? (
            <p role="status" className="m-0 text-[12px] text-warning">Refresh the run history and selected output before comparing.</p>
          ) : priorRun === undefined ? (
            <p role="alert" className="m-0 text-[12px] text-warning">That prior run is no longer available in the loaded history.</p>
          ) : (
            <ChosenComparison key={`${engagementId}:${selectedRun.id}:${priorRun.id}`}
              engagementId={engagementId} selectedRun={selectedRun} priorRun={priorRun} selectedOutput={selectedOutput} />
          )}
          <Button variant="quiet" className="h-8 w-fit px-2 text-[12px]" onClick={() => setPriorRunId("")}>Clear comparison</Button>
        </div>
      ) : null}
    </section>
  );
}

function ChosenComparison({ engagementId, selectedRun, priorRun, selectedOutput }: {
  engagementId: string;
  selectedRun: RunHistorySummary;
  priorRun: RunHistorySummary;
  selectedOutput: RunOutputResponse;
}) {
  const selectedAction = useQuery({ ...persistedActionQueryOptions(engagementId, selectedRun.actionId), retry: false, refetchOnMount: "always" });
  const priorAction = useQuery({ ...persistedActionQueryOptions(engagementId, priorRun.actionId), retry: false, refetchOnMount: "always" });
  const priorOutput = useRunOutputQuery(engagementId, priorRun.id);
  const services = useQuery({ ...engagementServicesQueryOptions(engagementId), retry: false, refetchOnMount: "always" });
  const probes = useQuery({ ...engagementHttpProbesQueryOptions(engagementId), retry: false, refetchOnMount: "always" });
  const results = useQuery({ ...engagementFfufResultsQueryOptions(engagementId), retry: false, refetchOnMount: "always" });
  const queries = [selectedAction, priorAction, priorOutput, services, probes, results];
  const retry = () => { for (const query of queries) void query.refetch(); };
  if (queries.some((query) => query.isError)) {
    return <RecoverableError title="Comparison unavailable" description="Run output, recorded context or observations could not be refreshed." onRetry={retry} />;
  }
  if (queries.some((query) => query.isFetching) || selectedAction.data === undefined || priorAction.data === undefined || priorOutput.data === undefined ||
    services.data === undefined || probes.data === undefined || results.data === undefined) {
    return <LoadingRegion label="Loading comparison" className="space-y-2"><Skeleton className="h-12 w-full" /></LoadingRegion>;
  }
  const projections = { services: services.data, probes: probes.data, results: results.data };
  const before = resolveRunComparison(priorRun, projections, priorAction.data, engagementId);
  const after = resolveRunComparison(selectedRun, projections, selectedAction.data, engagementId);
  if (!before.ok || !after.ok || priorOutput.data.run.id !== priorRun.id || priorOutput.data.run.actionId !== priorRun.actionId ||
    selectedOutput.run.id !== selectedRun.id || selectedOutput.run.actionId !== selectedRun.actionId) {
    const reason = !before.ok ? before.reason : !after.ok ? after.reason : "Run output does not match the chosen pair.";
    return <RecoverableError title="Not directly comparable" description={reason} onRetry={retry} />;
  }
  const context = (resolved: typeof before.value) => ({
    tool: resolved.tool, origin: resolved.origin,
    optionsSummary: actionOptionsSummary(resolved.snapshot),
    binding: actionBindingSummary(resolved.snapshot),
    ports: null, authSummary: null,
  });
  const beforeContext = context(before.value);
  const afterContext = context(after.value);
  const otherOptionsChanged = beforeContext.optionsSummary === afterContext.optionsSummary &&
    stableStringifyOptions(before.value.snapshot.typedOptions) !== stableStringifyOptions(after.value.snapshot.typedOptions);
  const input = buildRunCompareInput({
    before: { run: priorRun, context: beforeContext, complete: runSideComplete(priorRun, priorOutput.data) },
    after: { run: selectedRun, context: afterContext, complete: runSideComplete(selectedRun, selectedOutput) },
    projections,
  });
  return <div className="grid gap-2">
    <p className="m-0 text-[12px] leading-5 text-muted-foreground [overflow-wrap:anywhere]">
      Prior run {priorRun.id} at {formatEngagementTimestamp(priorRun.createdAt)}: {describeRunOutcome(priorRun)}.
      Recorded options: {beforeContext.optionsSummary}.
    </p>
    <RunDiffView input={input} coverageCaveat={`Observation coverage is unknown. Missing or capped projections may omit results. Absence disproves nothing. Authentication context is not recorded here.${otherOptionsChanged ? " Other recorded options differ beyond this summary." : ""}`} />
  </div>;
}
