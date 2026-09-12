import type { RunOutputResponse } from "@stonehush/contracts";
import { RunStateSchema } from "@stonehush/contracts";
import { isTerminalRunState } from "@stonehush/domain";
import {
  Button,
  LoadingRegion,
  RecoverableError,
  Skeleton,
  StaleDataState,
} from "@stonehush/ui";
import { useEffect, useRef, useState } from "react";

import { formatEngagementTimestamp } from "./format.js";
import { useRunHistoryQuery } from "./run-history-query.js";
import { RunNotFoundError, useRunOutputQuery } from "./run-output-query.js";
import { useEngagementWorkspace } from "./workspace-context.js";
import { splitHeldBackIds } from "./workspace-tabs.js";

export interface RunHistoryPanelProps {
  readonly engagementId: string | undefined;
  readonly limit?: number;
  readonly onSelect: (runId: string) => void;
  readonly selectedRunId: string | undefined;
}

// Bounded auto-checking for a selected run that the loaded history still
// shows as non-terminal. The output endpoint answers those runs with the same
// 404 as a missing run, so the panel reports progress from the listed row
// instead of fetching output until the row turns terminal.
const PENDING_POLL_INTERVAL_MS = 2_000;
const PENDING_POLL_MAX_ROUNDS = 30;

// Read-only engagement run history. The list renders in API order
// (newest first) without client-side resorting. Selection is fully
// caller-controlled: this panel only reports clicks through onSelect and
// never auto-selects the newest run. Paging uses the scoped infinite query
// and Load more forwards the opaque cursor verbatim.
export function RunHistoryPanel({
  engagementId,
  limit,
  onSelect,
  selectedRunId,
}: RunHistoryPanelProps) {
  const history = useRunHistoryQuery(engagementId, limit);
  const hasHistoryData = history.data !== undefined;
  // One polling session per engagement + selection. The budget resets
  // synchronously during render on session change so the next paint never
  // shows the previous session's count or paused copy.
  const sessionKey = `${engagementId ?? ""}::${selectedRunId ?? ""}`;
  const [poll, setPoll] = useState({ key: sessionKey, used: 0, locked: false });
  // Bumped on every manual history restart so the interval below restarts a
  // fresh 2s phase even when eligibility stays true. Never poll.used: that
  // would churn the timer on every auto round.
  const [restartEpoch, setRestartEpoch] = useState(0);
  const pollRef = useRef(poll);
  const fetchingRef = useRef(false);
  const historyRef = useRef(history);
  const inFlightRef = useRef<number | null>(null);
  const callSeqRef = useRef(0);
  // Stable-order baseline: ids visible the last time the operator opted into
  // fresh results. New arrivals stay held back behind Show new results so rows
  // never shift while reading or selecting text. Updates to already visible
  // rows still render immediately. Explicit refreshes and Load more merge.
  const [held, setHeld] = useState<
    { key: string; baseline: readonly string[] | undefined } | undefined
  >(undefined);
  const mergeNextRef = useRef(false);
  const listRef = useRef<HTMLUListElement>(null);
  const focusListAfterMergeRef = useRef(false);
  const heldKey = engagementId ?? "";
  if (held !== undefined && held.key !== heldKey) {
    setHeld(undefined);
  }
  if (poll.key !== sessionKey) {
    const fresh = { key: sessionKey, used: 0, locked: false };
    pollRef.current = fresh;
    setPoll(fresh);
  }
  // List filters are caller-visible state, not query state: a refetch or a
  // new page never clears them, while switching engagements restarts them.
  // They match loaded rows only. Run history carries no per-run tool or
  // target fields and the list endpoint takes no filter params, so the
  // controls cover run state plus run/action ID text.
  const [filters, setFilters] = useState({ engagementId, runState: "all", text: "" });
  if (filters.engagementId !== engagementId) {
    setFilters({ engagementId, runState: "all", text: "" });
  }
  const resetPollBudget = () => {
    const fresh = { key: sessionKey, used: 0, locked: false };
    pollRef.current = fresh;
    setPoll(fresh);
  };
  const startManualRefetch = () => {
    mergeNextRef.current = true;
    const callId = callSeqRef.current + 1;
    callSeqRef.current = callId;
    inFlightRef.current = callId;
    void historyRef.current.refetch().finally(() => {
      if (inFlightRef.current === callId) inFlightRef.current = null;
    });
  };
  const restartAutoChecks = () => {
    resetPollBudget();
    setRestartEpoch((epoch) => epoch + 1);
    startManualRefetch();
  };
  const retryHistory = () => {
    restartAutoChecks();
  };
  useEffect(() => {
    fetchingRef.current = history.isFetching;
    historyRef.current = history;
  });
  useEffect(() => {
    if (history.data === undefined) return;
    const ids = history.data.pages.flatMap((page) => page.runs).map((run) => run.id);
    if (held === undefined || held.key !== heldKey) {
      mergeNextRef.current = false;
      setHeld({ key: heldKey, baseline: ids });
      return;
    }
    if (mergeNextRef.current && !history.isFetching && !history.isFetchingNextPage) {
      mergeNextRef.current = false;
      setHeld({ key: heldKey, baseline: ids });
    }
  });
  const currentRuns = history.data?.pages.flatMap((page) => page.runs) ?? [];
  const olderPageIds = new Set(
    history.data?.pages.slice(1).flatMap((page) => page.runs).map((run) => run.id) ?? [],
  );
  const baselineWithOlder =
    held?.baseline === undefined ? undefined : [...held.baseline, ...olderPageIds];
  const split = splitHeldBackIds(
    currentRuns.map((run) => run.id),
    baselineWithOlder,
    selectedRunId,
  );
  const visibleIds = new Set(split.visibleIds);
  const loadedRuns = currentRuns.filter((run) => visibleIds.has(run.id));
  const heldBackCount = split.heldBackCount;
  const showNewResults = () => {
    if (history.data === undefined) return;
    focusListAfterMergeRef.current = true;
    setHeld({
      key: heldKey,
      baseline: history.data.pages.flatMap((page) => page.runs).map((run) => run.id),
    });
  };
  useEffect(() => {
    if (focusListAfterMergeRef.current && heldBackCount === 0) {
      focusListAfterMergeRef.current = false;
      listRef.current?.focus({ preventScroll: true });
    }
  });
  const selectedRow =
    selectedRunId === undefined
      ? undefined
      : loadedRuns.find((run) => run.id === selectedRunId);
  const selectedPendingRow =
    selectedRow !== undefined && !isTerminalRunState(selectedRow.state)
      ? selectedRow
      : undefined;
  const autoPollEligible =
    selectedPendingRow !== undefined &&
    !history.isError &&
    (history.data?.pages.length ?? 1) === 1 &&
    !poll.locked &&
    poll.used < PENDING_POLL_MAX_ROUNDS;
  useEffect(() => {
    if (!autoPollEligible) return;
    const timer = window.setInterval(() => {
      const snapshot = pollRef.current;
      if (snapshot.used >= PENDING_POLL_MAX_ROUNDS) return;
      if (fetchingRef.current) return;
      if (inFlightRef.current !== null) return;
      const current = historyRef.current;
      if ((current.data?.pages.length ?? 1) > 1) return;
      // Reserve synchronously before the call so delayed responses can never
      // push starts past the budget; late completions clear only their own
      // call lock and touch nothing else.
      const next = { ...snapshot, used: snapshot.used + 1 };
      pollRef.current = next;
      setPoll(next);
      const callId = callSeqRef.current + 1;
      callSeqRef.current = callId;
      inFlightRef.current = callId;
      void current.refetch().finally(() => {
        if (inFlightRef.current === callId) inFlightRef.current = null;
      });
    }, PENDING_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [autoPollEligible, engagementId, selectedRunId, restartEpoch]);

  if (engagementId === undefined) {
    return (
      <section aria-label="Run history">
        <h2 className="m-0 text-[13px] font-semibold">Run history</h2>
        <p className="mt-1 mb-0 text-[12px] leading-5 text-muted-foreground">
          Open an engagement to view its preserved run history.
        </p>
      </section>
    );
  }

  if (!hasHistoryData && history.isFetching) {
    return (
      <section aria-label="Run history">
        <h2 className="m-0 text-[13px] font-semibold">Run history</h2>
        <LoadingRegion label="Loading run history" className="mt-3 space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </LoadingRegion>
      </section>
    );
  }

  if (!hasHistoryData && history.isError) {
    return (
      <section aria-label="Run history">
        <h2 className="m-0 text-[13px] font-semibold">Run history</h2>
        <div className="mt-3">
          <RecoverableError
            title="Run history unavailable"
            description="The run history could not be loaded from the local control plane."
            onRetry={retryHistory}
          />
        </div>
      </section>
    );
  }

  if (!hasHistoryData) {
    return (
      <section aria-label="Run history">
        <h2 className="m-0 text-[13px] font-semibold">Run history</h2>
        <LoadingRegion label="Loading run history" className="mt-3 space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </LoadingRegion>
      </section>
    );
  }

  const runs = loadedRuns;
  const filterText = filters.text.trim().toLowerCase();
  const filtersActive = filters.runState !== "all" || filterText !== "";
  const visibleRuns = runs.filter(
    (run) =>
      (filters.runState === "all" || run.state === filters.runState) &&
      (filterText === "" ||
        run.id.toLowerCase().includes(filterText) ||
        run.actionId.toLowerCase().includes(filterText)),
  );
  const clearFilters = () => {
    setFilters({ engagementId, runState: "all", text: "" });
  };
  const heldBackBanner =
    heldBackCount > 0 ? (
      <div className="mb-2 flex flex-wrap items-center gap-2" aria-live="polite">
        <span className="text-[12px] text-muted-foreground">
          {heldBackCount} new {heldBackCount === 1 ? "run" : "runs"} arrived. Order stays
          stable until you opt in.
        </span>
        <Button type="button" variant="secondary" onClick={showNewResults}>
          Show new results
        </Button>
      </div>
    ) : null;
  const listBody =
    runs.length === 0 && !filtersActive ? (
      <div>
        <h3 className="m-0 text-[13px] font-semibold">No runs yet</h3>
        <p className="mt-1 mb-0 text-[12px] leading-5 text-muted-foreground">
          Queue an action to produce preserved runs for this engagement.
        </p>
        {heldBackBanner}
      </div>
    ) : (
      <div>
        <RunHistoryFilters
          runState={filters.runState}
          text={filters.text}
          onRunStateChange={(runState) => setFilters({ engagementId, runState, text: filters.text })}
          onTextChange={(text) => setFilters({ engagementId, runState: filters.runState, text })}
        />
        <p className="m-0 mb-2 text-[12px] text-muted-foreground" aria-live="polite">
          {filtersActive
            ? `${visibleRuns.length} of ${runs.length} ${runs.length === 1 ? "run" : "runs"} shown, newest first. Filters match loaded runs only.`
            : `${runs.length} ${runs.length === 1 ? "run" : "runs"} shown, newest first`}
        </p>
        {heldBackBanner}
        {visibleRuns.length === 0 ? (
          <div>
            <h3 className="m-0 text-[13px] font-semibold">No matching runs</h3>
            <p className="mt-1 mb-0 text-[12px] leading-5 text-muted-foreground">
              No loaded runs match these filters.
            </p>
            <div className="mt-3">
              <Button type="button" variant="secondary" onClick={clearFilters}>
                Clear filters
              </Button>
            </div>
          </div>
        ) : (
          <ul ref={listRef} tabIndex={-1} className="m-0 list-none divide-y divide-border border-y border-border p-0 outline-none">
            {visibleRuns.map((run) => {
            const selected = run.id === selectedRunId;
            return (
              <li key={run.id}>
                <button
                  type="button"
                  aria-current={selected ? "true" : undefined}
                  onClick={() => onSelect(run.id)}
                  className={`flex min-h-11 w-full items-center justify-between gap-3 px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    selected ? "bg-accent" : "hover:bg-accent/60"
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[12px] font-semibold" title={run.id}>
                      {run.id}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                      {run.state} · attempt {run.attempt}
                    </span>
                  </span>
                  <span
                    className="shrink-0 font-mono text-[11px] text-muted-foreground"
                    title={run.updatedAt}
                  >
                    {formatEngagementTimestamp(run.updatedAt)}
                  </span>
                </button>
              </li>
            );
          })}
          </ul>
        )}
        {history.hasNextPage ? (
          <div className="mt-3">
            <Button
              type="button"
              variant="secondary"
              disabled={!history.hasNextPage || history.isFetchingNextPage}
              onClick={() => {
                // A second loaded page ends single-page auto-checking before
                // it can refetch; further updates come from manual refresh.
                // The lock persists (even if the page fetch fails) until a
                // manual Refresh restarts the session. Loading more is an
                // explicit opt-in, so newly paged rows merge immediately.
                const locked = { ...pollRef.current, locked: true };
                pollRef.current = locked;
                setPoll(locked);
                mergeNextRef.current = true;
                void history.fetchNextPage();
              }}
            >
              {history.isFetchingNextPage ? "Loading more" : "Load more"}
            </Button>
          </div>
        ) : null}
      </div>
    );

  const pageCount = history.data?.pages.length ?? 1;
  // Explicit stopped reason: never claim auto-checking while inactive, and
  // never blame the 30-check budget for other stop causes.
  let pendingStatus: string;
  if (history.isError) {
    pendingStatus = "Auto-check paused: history request failed.";
  } else if (pageCount > 1) {
    pendingStatus = "Auto-check paused: more than one page loaded.";
  } else if (history.isFetchingNextPage) {
    pendingStatus = "Loading more history…";
  } else if (poll.locked) {
    pendingStatus = "Loading more history failed.";
  } else if (poll.used >= PENDING_POLL_MAX_ROUNDS) {
    pendingStatus = "Auto-check paused after 30 checks.";
  } else {
    pendingStatus = `Auto-checking every 2 seconds (check ${poll.used + 1} of 30).`;
  }

  return (
    <section aria-label="Run history">
      <h2 className="m-0 text-[13px] font-semibold">Run history</h2>
      <p className="mt-1 mb-0 text-[12px] leading-5 text-muted-foreground">
        Newest first. Selection stays where you put it.
      </p>
      <div className="mt-3">
        {history.isError ? (
          <StaleDataState
            title="Showing the last successful run history"
            description="The latest refresh failed. Existing runs are still available."
            onRetry={retryHistory}
          >
            {listBody}
          </StaleDataState>
        ) : (
          listBody
        )}
      </div>
      <div className="mt-4 border-t border-border pt-3">
        {selectedPendingRow !== undefined ? (
          <PendingSelectedRun
            runId={selectedPendingRow.id}
            runState={selectedPendingRow.state}
            statusLine={pendingStatus}
            onRefresh={restartAutoChecks}
          />
        ) : (
          <SelectedRunOutput
            engagementId={engagementId}
            selectedRunId={selectedRunId}
            onManualRetry={resetPollBudget}
          />
        )}
      </div>
    </section>
  );
}

function RunHistoryFilters({
  onRunStateChange,
  onTextChange,
  runState,
  text,
}: {
  onRunStateChange: (runState: string) => void;
  onTextChange: (text: string) => void;
  runState: string;
  text: string;
}) {
  return (
    <div className="mb-2 flex flex-wrap gap-2">
      <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="run-history-state">
        <span>State</span>
        <select
          id="run-history-state"
          value={runState}
          className="min-h-8 rounded-md border border-input bg-transparent px-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onChange={(event) => onRunStateChange(event.target.value)}
        >
          <option value="all">All states</option>
          {RunStateSchema.options.map((state) => (
            <option key={state} value={state}>
              {state}
            </option>
          ))}
        </select>
      </label>
      <label
        className="grid min-w-40 flex-1 gap-1 text-[11px] text-muted-foreground"
        htmlFor="run-history-search"
      >
        <span>Search loaded runs</span>
        <input
          id="run-history-search"
          type="search"
          value={text}
          placeholder="Run or action ID"
          aria-label="Search loaded runs by run or action ID"
          className="min-h-8 w-full rounded-md border border-input bg-transparent px-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onChange={(event) => onTextChange(event.target.value)}
        />
      </label>
    </div>
  );
}

function PendingSelectedRun({
  onRefresh,
  runId,
  runState,
  statusLine,
}: {
  onRefresh: () => void;
  runId: string;
  runState: string;
  statusLine: string;
}) {
  return (
    <section aria-label="Selected run output">
      <h3 className="m-0 text-[13px] font-semibold">Selected run output</h3>
      <p className="mt-1 mb-0 text-[12px] leading-5 text-muted-foreground">
        Run{" "}
        <span className="font-mono" title={runId}>
          {runId}
        </span>{" "}
        is still {runState}. Preserved output appears automatically when the run finishes.
      </p>
      <p className="mt-1 mb-0 text-[12px] text-muted-foreground" aria-live="polite">
        {statusLine}
      </p>
      <div className="mt-3">
        <Button type="button" variant="secondary" onClick={onRefresh}>
          Refresh
        </Button>
      </div>
    </section>
  );
}

function SelectedRunOutput({
  engagementId,
  onManualRetry,
  selectedRunId,
}: {
  engagementId: string;
  onManualRetry: () => void;
  selectedRunId: string | undefined;
}) {
  const output = useRunOutputQuery(engagementId, selectedRunId);
  const hasOutputData = output.data !== undefined;
  const retryOutput = () => {
    void output.refetch();
    onManualRetry();
  };

  if (selectedRunId === undefined || selectedRunId.length === 0) {
    return (
      <section aria-label="Selected run output">
        <h3 className="m-0 text-[13px] font-semibold">Selected run output</h3>
        <p className="mt-1 mb-0 text-[12px] leading-5 text-muted-foreground">
          Select a run to view its exact preserved output.
        </p>
      </section>
    );
  }

  if (!hasOutputData && output.isFetching) {
    return (
      <section aria-label="Selected run output">
        <h3 className="m-0 text-[13px] font-semibold">Selected run output</h3>
        <LoadingRegion label="Loading selected run output" className="mt-3 space-y-2">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-24 w-full" />
        </LoadingRegion>
      </section>
    );
  }

  if (!hasOutputData && output.error instanceof RunNotFoundError) {
    return (
      <section aria-label="Selected run output">
        <h3 className="m-0 text-[13px] font-semibold">Selected run output</h3>
        <div className="mt-3">
          <RecoverableError
            title="Run unavailable"
            description="That run is no longer available. Pick another run from the history."
            onRetry={retryOutput}
          />
        </div>
      </section>
    );
  }

  if (!hasOutputData && output.isError) {
    return (
      <section aria-label="Selected run output">
        <h3 className="m-0 text-[13px] font-semibold">Selected run output</h3>
        <div className="mt-3">
          <RecoverableError
            title="Selected output unavailable"
            description="Preserved output for the selected run could not be loaded from the local control plane."
            onRetry={retryOutput}
          />
        </div>
      </section>
    );
  }

  if (!hasOutputData) {
    return (
      <section aria-label="Selected run output">
        <h3 className="m-0 text-[13px] font-semibold">Selected run output</h3>
        <LoadingRegion label="Loading selected run output" className="mt-3 space-y-2">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-24 w-full" />
        </LoadingRegion>
      </section>
    );
  }

  const content = <SelectedRunContent output={output.data} onRefresh={retryOutput} />;
  if (output.isError) {
    return (
      <StaleDataState
        title="Showing the last successful output"
        description="The latest refresh failed. Existing output is still available."
        onRetry={retryOutput}
      >
        {content}
      </StaleDataState>
    );
  }
  return content;
}

function SelectedRunContent({
  onRefresh,
  output,
}: {
  onRefresh: () => void;
  output: RunOutputResponse;
}) {
  const { openAdvisor } = useEngagementWorkspace();
  // Only real published artifact IDs from this run's preserved streams
  // seed the advisor draft. A run ID is never an excerpt.
  const askIds = [output.stdout, output.stderr].flatMap((stream) =>
    stream.present ? [stream.artifactId] : [],
  );
  return (
    <section aria-label="Selected run output">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 text-[13px] font-semibold">
          Selected run output{" "}
          <span className="font-mono text-[11px] font-normal text-muted-foreground">
            {output.run.id} · {output.run.state}
          </span>
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          {askIds.length > 0 ? (
            <Button
              type="button"
              variant="quiet"
              className="h-7 px-2 text-[12px]"
              onClick={() => openAdvisor(askIds, [])}
            >
              Ask about this run
            </Button>
          ) : null}
          <Button
            type="button"
            variant="quiet"
            className="h-7 px-2 text-[12px]"
            onClick={onRefresh}
          >
            Refresh
          </Button>
        </div>
      </div>
      <div className="mt-3 grid gap-3">
        <SelectedRunStream label="stdout" runId={output.run.id} stream={output.stdout} />
        <SelectedRunStream label="stderr" runId={output.run.id} stream={output.stderr} />
      </div>
    </section>
  );
}

function SelectedRunStream({
  label,
  runId,
  stream,
}: {
  label: "stdout" | "stderr";
  runId: string;
  stream: RunOutputResponse["stdout"];
}) {
  if (!stream.present) {
    return (
      <section aria-label={`${label} for run ${runId}`}>
        <h4 className="m-0 font-mono text-[11px] font-semibold tracking-[0.08em] uppercase">
          {label}
        </h4>
        <p className="mt-1 mb-0 text-[12px] text-muted-foreground">
          No preserved {label} for this run.
        </p>
      </section>
    );
  }
  return (
    <section aria-label={`${label} for run ${runId}`}>
      <h4 className="m-0 font-mono text-[11px] font-semibold tracking-[0.08em] uppercase">
        {label}
      </h4>
      {stream.truncated ? (
        <p className="mt-1 mb-0 text-[11px] text-muted-foreground">
          Truncated to the first 65536 bytes of {stream.sizeBytes} bytes.
        </p>
      ) : null}
      <pre
        className="mt-1 mb-0 max-h-64 overflow-auto rounded-md border border-border bg-muted/30 px-2.5 py-2 font-mono text-[12px] leading-5 break-all whitespace-pre-wrap"
        data-testid={`run-history-${label}`}
      >
        {stream.content}
      </pre>
    </section>
  );
}
