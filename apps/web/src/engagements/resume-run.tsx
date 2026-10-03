import { RunOutputParamsSchema, type RunOutputResponse } from "@stonehush/contracts";
import { isTerminalRunState } from "@stonehush/domain";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import { formatEngagementTimestamp } from "./format.js";
import { RunNotFoundError, runOutputQueryOptions } from "./run-output-query.js";
import {
  browserWorkspaceStateStore,
  loadWorkspaceState,
  saveWorkspaceState,
  type WorkspaceStateStore,
} from "./workspace-state.js";

export interface OpenedRun {
  readonly engagementId: string;
  readonly requestedRunId: string;
  readonly run: RunOutputResponse["run"];
}

// Only a matching terminal output read can replace this engagement's pointer.
// Read before each write so remembering a run preserves the lead pointer.
export function useRememberedRun(engagementId: string, store?: WorkspaceStateStore) {
  const resolved = useMemo(() => store ?? browserWorkspaceStateStore(), [store]);
  const [pointer, setPointer] = useState(() => ({
    engagementId,
    runId: loadWorkspaceState(resolved, engagementId).selectedRunId,
  }));
  let current = pointer;
  if (pointer.engagementId !== engagementId) {
    current = { engagementId, runId: loadWorkspaceState(resolved, engagementId).selectedRunId };
    setPointer(current);
  }
  const engagementRef = useRef(engagementId);
  useLayoutEffect(() => {
    engagementRef.current = engagementId;
  }, [engagementId]);

  const remember = useCallback(({ engagementId: owner, requestedRunId, run }: OpenedRun) => {
    if (owner !== engagementRef.current || requestedRunId !== run.id ||
      !isTerminalRunState(run.state) || !RunOutputParamsSchema.shape.runId.safeParse(run.id).success) return;
    const saved = loadWorkspaceState(resolved, owner);
    if (saved.selectedRunId !== run.id &&
      !saveWorkspaceState(resolved, owner, { ...saved, selectedRunId: run.id, updatedAt: new Date().toISOString() })) return;
    setPointer((prev) => prev.engagementId === owner && prev.runId !== run.id
      ? { engagementId: owner, runId: run.id } : prev);
  }, [resolved]);

  const forget = useCallback((owner: string, runId: string) => {
    if (owner !== engagementRef.current) return;
    const saved = loadWorkspaceState(resolved, owner);
    if (saved.selectedRunId === runId &&
      !saveWorkspaceState(resolved, owner, { ...saved, selectedRunId: null, updatedAt: new Date().toISOString() })) return;
    setPointer((prev) => prev.engagementId === owner && prev.runId === runId
      ? { engagementId: owner, runId: null } : prev);
  }, [resolved]);

  return { runId: current.runId, remember, forget };
}

const INLINE_ACTION = "inline-flex min-h-11 items-center rounded-md px-1.5 text-[12px] font-medium text-foreground underline underline-offset-2 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 md:pointer-fine:min-h-7";

export function ResumeRunRow(props: {
  readonly engagementId: string;
  readonly runId: string;
  readonly onOpen: (runId: string) => void;
  readonly onForget: (runId: string) => void;
}) {
  return <ResumeRunRowState key={`${props.engagementId}:${props.runId}`} {...props} />;
}

function ResumeRunRowState({ engagementId, runId, onOpen, onForget }: Parameters<typeof ResumeRunRow>[0]) {
  const query = useQuery({
    ...runOutputQueryOptions(engagementId, runId),
    refetchOnMount: "always",
  });
  const output = query.data;
  const run = output?.run.id === runId && isTerminalRunState(output.run.state) ? output.run : undefined;
  const retry = <button type="button" className={INLINE_ACTION} disabled={query.isFetching} onClick={() => void query.refetch()}>Retry</button>;
  let body;
  if (query.error instanceof RunNotFoundError) {
    body = (
      <p className="m-0 flex min-h-8 flex-wrap items-center gap-x-2 text-[12px] text-muted-foreground" role="alert">
        Run unavailable.
        <button type="button" className={INLINE_ACTION} onClick={(event) => {
          const band = event.currentTarget.closest<HTMLElement>("[data-resume-band]");
          onForget(runId);
          band?.focus({ preventScroll: true });
        }}>Forget</button>
      </p>
    );
  } else if (run !== undefined) {
    body = (
      <p className="m-0 flex min-h-8 min-w-0 flex-wrap items-center gap-x-2 text-[12px] leading-5 text-muted-foreground">
        <button type="button" onClick={() => onOpen(run.id)} title={run.id}
          aria-label={`Open run ${run.id}, ${run.state}`}
          className="min-h-11 max-w-full min-w-0 truncate rounded-sm text-left text-[13px] text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring md:pointer-fine:min-h-8">
          {run.id.slice(-8)}
        </button>
        <span>{run.state}</span>
        <time dateTime={run.updatedAt}>{formatEngagementTimestamp(run.updatedAt)}</time>
        {query.isError ? <span className="flex items-center gap-x-1 text-warning" role="status">Refresh failed. {retry}</span> : null}
      </p>
    );
  } else if (query.isFetching) {
    body = <p className="m-0 flex min-h-8 items-center text-[12px] text-muted-foreground" role="status">Loading</p>;
  } else {
    body = <p className="m-0 flex min-h-8 flex-wrap items-center gap-x-2 text-[12px] text-muted-foreground" role="alert">Run not loaded. {retry}</p>;
  }
  return (
    <section aria-label="Last run" className="grid min-w-0 grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-x-3">
      <span className="pt-1.5 text-[12px] leading-5 font-medium text-foreground">Run</span>
      {body}
    </section>
  );
}
