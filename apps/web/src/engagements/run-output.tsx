import type { RunOutputResponse } from "@stonehush/contracts";
import { Button, LoadingRegion, RecoverableError, Skeleton } from "@stonehush/ui";
import { useRouterState } from "@tanstack/react-router";

import {
  NoTerminalRunError,
  RunNotFoundError,
  selectEngagementIdFromPathname,
  selectRunIdFromSearch,
  useLatestRunOutputQuery,
  useRunOutputQuery,
} from "./run-output-query.js";
import { useEngagementWorkspace } from "./workspace-context.js";

export function RawOutputPanel() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const search = useRouterState({ select: (state) => state.location.search });
  const engagementId = selectEngagementIdFromPathname(pathname);
  const selectedRunId = selectRunIdFromSearch(search);
  if (engagementId === undefined) {
    return (
      <div>
        <p className="m-0 text-[13px] font-semibold">Raw output</p>
        <p className="mt-1 mb-0 text-[13px] text-muted-foreground">
          Open an engagement to view preserved raw output.
        </p>
      </div>
    );
  }
  return <RawOutputBody engagementId={engagementId} selectedRunId={selectedRunId} />;
}

// Common selected-run view. With no explicit ?run= selection this keeps the
// existing latest-terminal-run behavior. With a selection it reuses the exact
// selected-run query (same key the Runs tab uses, so no extra fetch and no
// duplicated renderer) and labels the source truthfully. An unknown selected
// run reports unavailable instead of silently falling back to latest.
function RawOutputBody({
  engagementId,
  selectedRunId,
}: {
  engagementId: string;
  selectedRunId: string | undefined;
}) {
  const latest = useLatestRunOutputQuery(selectedRunId === undefined ? engagementId : undefined);
  const selected = useRunOutputQuery(engagementId, selectedRunId);
  const query = selectedRunId === undefined ? latest : selected;
  const retry = () => void query.refetch();
  const hasData = query.data !== undefined;

  if (!hasData && query.isFetching) {
    return (
      <LoadingRegion label="Loading raw output" className="space-y-2">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-24 w-full" />
      </LoadingRegion>
    );
  }
  if (!hasData && selectedRunId !== undefined && query.error instanceof RunNotFoundError) {
    return (
      <div>
        <p className="m-0 text-[13px] font-semibold">Raw output</p>
        <p className="mt-1 mb-0 text-[13px] text-muted-foreground">
          The selected run is no longer available. Pick another run from Run history.
        </p>
      </div>
    );
  }
  if (!hasData && query.error instanceof NoTerminalRunError) {
    return (
      <div>
        <p className="m-0 text-[13px] font-semibold">Raw output</p>
        <p className="mt-1 mb-0 text-[13px] text-muted-foreground">
          No finished or cancelled runs yet. Queue an action to produce preserved output.
        </p>
      </div>
    );
  }
  if (!hasData && query.isError) {
    return (
      <RecoverableError
        title="Raw output unavailable"
        description="Preserved raw output could not be loaded from the local control plane."
        onRetry={retry}
      />
    );
  }
  if (!hasData) {
    return (
      <LoadingRegion label="Loading raw output" className="space-y-2">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-24 w-full" />
      </LoadingRegion>
    );
  }
  return (
    <RawOutputContent
      output={query.data}
      onRefresh={retry}
      source={selectedRunId === undefined ? "latest" : "selected"}
    />
  );
}

function RawOutputContent({
  output,
  onRefresh,
  source,
}: {
  output: RunOutputResponse;
  onRefresh: () => void;
  source: "latest" | "selected";
}) {
  const { openAdvisor } = useEngagementWorkspace();
  // Only real published artifact IDs from this run's preserved streams
  // seed the advisor draft. A run ID is never an excerpt.
  const askIds = [output.stdout, output.stderr].flatMap((stream) =>
    stream.present ? [stream.artifactId] : [],
  );
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 text-[13px] font-semibold">
          Raw output{" "}
          <span className="font-mono text-[11px] font-normal text-muted-foreground">
            {source === "selected" ? `Selected run ${output.run.id}` : output.run.id} ·{" "}
            {output.run.state}
          </span>
        </p>
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
          <Button type="button" variant="quiet" className="h-7 px-2 text-[12px]" onClick={onRefresh}>
            Refresh
          </Button>
        </div>
      </div>
      <RawStream label="stdout" stream={output.stdout} runId={output.run.id} />
      <RawStream label="stderr" stream={output.stderr} runId={output.run.id} />
    </div>
  );
}

function RawStream({
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
        <h3 className="m-0 font-mono text-[11px] font-semibold tracking-[0.08em] uppercase">
          {label}
        </h3>
        <p className="mt-1 mb-0 text-[12px] text-muted-foreground">
          No preserved {label} for this run.
        </p>
      </section>
    );
  }
  return (
    <section aria-label={`${label} for run ${runId}`}>
      <h3 className="m-0 font-mono text-[11px] font-semibold tracking-[0.08em] uppercase">
        {label}
      </h3>
      {stream.truncated ? (
        <p className="mt-1 mb-0 text-[11px] text-muted-foreground">
          Truncated to the first 65536 bytes of {stream.sizeBytes} bytes.
        </p>
      ) : null}
      <pre
        className="mt-1 mb-0 max-h-64 overflow-auto rounded-md border border-border bg-muted/30 px-2.5 py-2 font-mono text-[12px] leading-5 break-all whitespace-pre-wrap"
        data-testid={`raw-output-${label}`}
      >
        {stream.content}
      </pre>
    </section>
  );
}
