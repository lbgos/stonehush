import type { Excerpt, RunOutputResponse } from "@stonehush/contracts";
import { formatExcerptSourceLabel, selectionBytesFromText } from "@stonehush/domain";
import { Button, LoadingRegion, RecoverableError, Skeleton } from "@stonehush/ui";
import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import {
  NoTerminalRunError,
  RunNotFoundError,
  RunOutputUnavailableError,
  requestFindingFromExcerpt,
  searchRunOutput,
  selectEngagementIdFromPathname,
  selectRunIdFromSearch,
  useCreateExcerptMutation,
  useExcerptSourcesQuery,
  useExcerptsQuery,
  useLatestRunOutputQuery,
  useRunOutputQuery,
} from "./run-output-query.js";
import { fetchRunHistoryPage } from "./run-history-query.js";
import { useEngagementWorkspace } from "./workspace-context.js";

export function RawOutputPanel({
  onAddToLead,
}: {
  // STONE-4 stub: when provided, kept excerpts can be handed to lead
  // capture. Until then the menu shows a disabled, truthfully labelled
  // action instead of a dead end.
  onAddToLead?: ((excerpt: Excerpt) => void) | undefined;
}) {
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
  return (
    <RawOutputBody
      engagementId={engagementId}
      selectedRunId={selectedRunId}
      onAddToLead={onAddToLead}
    />
  );
}

// Common selected-run view. With no explicit ?run= selection this keeps the
// existing latest-terminal-run behavior. With a selection it reuses the exact
// selected-run query (same key the Runs tab uses, so no extra fetch and no
// duplicated renderer) and labels the source truthfully. An unknown selected
// run reports unavailable instead of silently falling back to latest.
function RawOutputBody({
  engagementId,
  selectedRunId,
  onAddToLead,
}: {
  engagementId: string;
  selectedRunId: string | undefined;
  onAddToLead: ((excerpt: Excerpt) => void) | undefined;
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
  // Failed downloads keep their evidence reference plus retry context instead
  // of collapsing to a generic error. The stored metadata (artifact id, size,
  // digest, completeness) survives the missing bytes.
  if (
    !hasData &&
    query.error instanceof RunOutputUnavailableError &&
    selectedRunId !== undefined
  ) {
    return (
      <FailedDownloadPanel
        engagementId={engagementId}
        runId={selectedRunId}
        reason={query.error.code}
        onRetry={retry}
      />
    );
  }
  // The default latest-run view loses the run id when its bytes fail
  // verification (the 409 body carries only the code), so without extra work
  // it collapses to a generic error without reference metadata or combined
  // retry. Resolve the latest terminal run through history and render the
  // same reference panel; fall back to the generic error when unresolvable.
  if (!hasData && query.error instanceof RunOutputUnavailableError) {
    return (
      <LatestUnavailablePanel
        engagementId={engagementId}
        reason={query.error.code}
        onRetry={retry}
      />
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
      engagementId={engagementId}
      output={query.data}
      onRefresh={retry}
      source={selectedRunId === undefined ? "latest" : "selected"}
      onAddToLead={onAddToLead}
    />
  );
}

function FailedDownloadPanel({
  engagementId,
  runId,
  reason,
  onRetry,
}: {
  engagementId: string;
  runId: string;
  reason: string;
  onRetry: () => void;
}) {
  const sources = useExcerptSourcesQuery(engagementId, runId);
  const retryAll = () => {
    void sources.refetch();
    onRetry();
  };
  return (
    <div className="grid gap-2">
      <p className="m-0 text-[13px] font-semibold">Raw output unavailable</p>
      <p className="m-0 text-[12px] text-muted-foreground">
        The preserved bytes for this run failed verification (
        {reason === "missing_artifact" ? "missing file" : "corrupt file"}). The evidence
        reference below is kept; retry to attempt the verified read again.
      </p>
      {sources.data !== undefined ? (
        <ul className="m-0 grid list-none gap-1 p-0">
          {sources.data.map((source) => (
            <li
              key={source.artifactId}
              className="rounded-md border border-border px-2.5 py-2 font-mono text-[11px] text-muted-foreground"
            >
              {source.artifactId} · {source.kind} · {source.sizeBytes} bytes ·{" "}
              {source.digest.slice(0, 19)} · {source.completeness}
            </li>
          ))}
        </ul>
      ) : null}
      {sources.isError ? (
        <p className="m-0 text-[12px] text-muted-foreground">
          Reference metadata could not be loaded either. Retry to attempt both reads again.
        </p>
      ) : null}
      <div>
        <Button type="button" variant="quiet" className="h-7 px-2 text-[12px]" onClick={retryAll}>
          Retry
        </Button>
      </div>
    </div>
  );
}

// Latest-run unavailable path: the 409 carries only the verification code,
// so the run id comes from history. The newest terminal run by updatedAt is
// the same row the latest-output endpoint used. While resolving, keep a
// loading state; when unresolvable, fall back to the generic retry.
function LatestUnavailablePanel({
  engagementId,
  reason,
  onRetry,
}: {
  engagementId: string;
  reason: string;
  onRetry: () => void;
}) {
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setRunId(undefined);
    setFailed(false);
    void fetchRunHistoryPage(engagementId, { limit: 25 })
      .then((page) => {
        if (cancelled) return;
        const terminal = page.runs
          .filter((run) => run.state === "succeeded" || run.state === "failed" || run.state === "cancelled")
          .sort((left, right) =>
            left.updatedAt === right.updatedAt
              ? (left.id < right.id ? 1 : -1)
              : (left.updatedAt < right.updatedAt ? 1 : -1),
          )[0];
        if (terminal === undefined) setFailed(true);
        else setRunId(terminal.id);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [engagementId]);
  if (runId !== undefined) {
    return <FailedDownloadPanel engagementId={engagementId} runId={runId} reason={reason} onRetry={onRetry} />;
  }
  if (failed) {
    return (
      <RecoverableError
        title="Raw output unavailable"
        description="Preserved raw output could not be loaded from the local control plane."
        onRetry={onRetry}
      />
    );
  }
  return (
    <LoadingRegion label="Loading raw output" className="space-y-2">
      <Skeleton className="h-3 w-40" />
      <Skeleton className="h-24 w-full" />
    </LoadingRegion>
  );
}

function RawOutputContent({
  engagementId,
  output,
  onRefresh,
  source,
  onAddToLead,
}: {
  engagementId: string;
  output: RunOutputResponse;
  onRefresh: () => void;
  source: "latest" | "selected";
  onAddToLead: ((excerpt: Excerpt) => void) | undefined;
}) {
  const { openAdvisor } = useEngagementWorkspace();
  const [searchActive, setSearchActive] = useState(false);
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
      <RunOutputSearch
        engagementId={engagementId}
        runId={output.run.id}
        onAddToLead={onAddToLead}
        onActiveChange={setSearchActive}
      />
      {searchActive ? null : (
        <>
          <RawStream
            engagementId={engagementId}
            label="stdout"
            stream={output.stdout}
            runId={output.run.id}
            onAddToLead={onAddToLead}
          />
          <RawStream
            engagementId={engagementId}
            label="stderr"
            stream={output.stderr}
            runId={output.run.id}
            onAddToLead={onAddToLead}
          />
        </>
      )}
      <KeptExcerptsSection
        engagementId={engagementId}
        runId={output.run.id}
        onAddToLead={onAddToLead}
      />
    </div>
  );
}

// Server-side search within this run's preserved text output. Matches carry
// masked snippets with byte offsets for Keep excerpt; while a query is
// active the full streams stay hidden so long output is never rendered to
// search it.
function RunOutputSearch({
  engagementId,
  runId,
  onAddToLead,
  onActiveChange,
}: {
  engagementId: string;
  runId: string;
  onAddToLead: ((excerpt: Excerpt) => void) | undefined;
  onActiveChange: (active: boolean) => void;
}) {
  const [input, setInput] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [searchState, setSearchState] = useState<
    | { status: "idle" }
    | { status: "pending" }
    | { status: "error" }
    | {
        status: "ready";
        matches: Awaited<ReturnType<typeof searchRunOutput>>["matches"];
        searchedBytes: number;
        scanCapped: boolean;
      }
  >({ status: "idle" });
  const create = useCreateExcerptMutation(engagementId);
  const { announce } = useEngagementWorkspace();
  // Binds each search to its query and run. A slow `foo` resolving after
  // `bar` was submitted must not overwrite bar's matches, and matches from a
  // previous run must never be kept with a new run id.
  const requestSeq = useRef(0);

  useEffect(() => {
    onActiveChange(activeQuery.length > 0);
  }, [activeQuery, onActiveChange]);

  // Reset search when the run changes so stale matches with old artifact ids
  // cannot be submitted under a new run.
  useEffect(() => {
    requestSeq.current += 1;
    setInput("");
    setActiveQuery("");
    setSearchState({ status: "idle" });
  }, [engagementId, runId]);

  const submit = () => {
    const query = input.trim();
    if (query.length === 0) {
      requestSeq.current += 1;
      setActiveQuery("");
      setSearchState({ status: "idle" });
      return;
    }
    const seq = ++requestSeq.current;
    const submittedRunId = runId;
    const submittedQuery = query;
    setActiveQuery(query);
    setSearchState({ status: "pending" });
    void searchRunOutput(engagementId, submittedRunId, submittedQuery)
      .then((result) => {
        if (requestSeq.current !== seq) return;
        setSearchState({
          status: "ready",
          matches: result.matches,
          searchedBytes: result.searchedBytes,
          scanCapped: result.scanCapped,
        });
      })
      .catch(() => {
        if (requestSeq.current !== seq) return;
        setSearchState({ status: "error" });
      });
  };

  const clear = () => {
    requestSeq.current += 1;
    setInput("");
    setActiveQuery("");
    setSearchState({ status: "idle" });
    if (create.isError) create.reset();
  };

  const keepMatch = (match: {
    artifactId: string;
    stream: "stdout" | "stderr";
    byteOffset: number;
    byteLength: number;
  }) => {
    if (create.isError) create.reset();
    create.mutate(
      {
        runId,
        artifactId: match.artifactId,
        stream: match.stream,
        byteOffset: match.byteOffset,
        byteLength: match.byteLength,
      },
      {
        onSuccess: () => announce("Excerpt kept. Open the Findings tab to create a linked finding."),
        onError: () => undefined,
      },
    );
  };

  return (
    <section aria-label="Search within output" className="grid gap-2">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="grid min-w-40 flex-1 gap-1 text-[11px] text-muted-foreground" htmlFor="run-output-search">
          <span>Search within output</span>
          <input
            id="run-output-search"
            value={input}
            spellCheck={false}
            placeholder="error, login, 10.0.0"
            className="w-full rounded-md border border-input bg-transparent px-2.5 py-1.5 font-mono text-[12px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) => setInput(event.target.value)}
          />
        </label>
        <Button type="submit" variant="quiet" className="h-7 self-end px-2 text-[12px]">
          Search
        </Button>
        {activeQuery.length > 0 ? (
          <Button type="button" variant="quiet" className="h-7 self-end px-2 text-[12px]" onClick={clear}>
            Clear
          </Button>
        ) : null}
      </form>
      {searchState.status === "pending" ? (
        <LoadingRegion label="Searching preserved output" className="space-y-2">
          <Skeleton className="h-3 w-40" />
        </LoadingRegion>
      ) : null}
      {searchState.status === "error" ? (
        <RecoverableError
          title="Search unavailable"
          description="The preserved output could not be searched from the local control plane."
          onRetry={() => submit()}
        />
      ) : null}
      {searchState.status === "ready" ? (
        <div className="grid gap-2">
          <p className="m-0 text-[11px] text-muted-foreground" aria-live="polite">
            {searchState.matches.length === 0
              ? `No matches for ${activeQuery} in the first ${searchState.searchedBytes} searched bytes.`
              : `${searchState.matches.length} match${searchState.matches.length === 1 ? "" : "es"} for ${activeQuery} in ${searchState.searchedBytes} searched bytes.`}{" "}
            {searchState.scanCapped ? "Scan stopped at the byte cap." : ""}
          </p>
          {create.isError ? (
            <p className="m-0 text-[12px] text-destructive" role="alert">
              The excerpt could not be kept. Retry from the match below.
            </p>
          ) : null}
          <ul className="m-0 grid list-none gap-2 p-0">
            {searchState.matches.map((match) => (
              <li
                key={`${match.artifactId}:${match.byteOffset}`}
                data-testid="run-output-search-match"
                className="grid gap-1 rounded-md border border-border px-2.5 py-2"
              >
                <p className="m-0 font-mono text-[11px] text-muted-foreground">
                  {match.stream} @{match.byteOffset}+{match.byteLength} · {match.artifactId}
                </p>
                <pre className="m-0 max-h-24 overflow-auto font-mono text-[12px] leading-5 break-all whitespace-pre-wrap">
                  {match.snippet}
                </pre>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="quiet"
                    className="h-7 px-2 text-[12px]"
                    disabled={create.isPending}
                    onClick={() => keepMatch(match)}
                  >
                    {create.isPending ? "Keeping" : "Keep excerpt"}
                  </Button>
                  <AddToLeadButton excerpt={null} onAddToLead={onAddToLead} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function CreateFindingButton({
  engagementId,
  kept,
}: {
  engagementId: string;
  kept: Excerpt | null;
}) {
  const { announce } = useEngagementWorkspace();
  if (kept === null) {
    return null;
  }
  return (
    <Button
      type="button"
      variant="quiet"
      className="h-7 px-2 text-[12px]"
      onClick={() => {
        requestFindingFromExcerpt(engagementId, kept);
        announce("Excerpt staged. Open the Findings tab to create a linked finding.");
      }}
    >
      Create finding
    </Button>
  );
}

function AddToLeadButton({
  excerpt,
  onAddToLead,
}: {
  excerpt: Excerpt | null;
  onAddToLead: ((excerpt: Excerpt) => void) | undefined;
}) {
  if (excerpt === null || onAddToLead === undefined) {
    return (
      <Button
        type="button"
        variant="quiet"
        className="h-7 px-2 text-[12px]"
        disabled
        title="Leads arrive in STONE-4"
      >
        Add to lead
      </Button>
    );
  }
  return (
    <Button
      type="button"
      variant="quiet"
      className="h-7 px-2 text-[12px]"
      onClick={() => onAddToLead(excerpt)}
    >
      Add to lead
    </Button>
  );
}

const OUTPUT_WINDOW_LINES = 200;

function KeptExcerptsSection({
  engagementId,
  runId,
  onAddToLead,
}: {
  engagementId: string;
  runId: string;
  onAddToLead: ((excerpt: Excerpt) => void) | undefined;
}) {
  const kept = useExcerptsQuery(engagementId);
  const rows = (kept.data ?? []).filter((excerpt) => excerpt.runId === runId);
  if (rows.length === 0) return null;
  return (
    <section aria-label="Kept excerpts" className="grid gap-2">
      <h3 className="m-0 text-[12px] font-semibold">Kept excerpts</h3>
      <ul className="m-0 grid list-none gap-2 p-0">
        {rows.map((excerpt) => (
          <li key={excerpt.id} className="grid gap-1 rounded-md border border-border px-2.5 py-2">
            <p className="m-0 font-mono text-[11px] text-muted-foreground">
              {formatExcerptSourceLabel(excerpt)}
            </p>
            {excerpt.targetNote !== null ? (
              <p className="m-0 text-[11px] text-muted-foreground">
                Target note: {excerpt.targetNote}
              </p>
            ) : null}
            <pre className="m-0 max-h-24 overflow-auto font-mono text-[12px] leading-5 break-all whitespace-pre-wrap">
              {excerpt.content}
            </pre>
            <div className="flex flex-wrap gap-2">
              <CreateFindingButton engagementId={engagementId} kept={excerpt} />
              <AddToLeadButton excerpt={excerpt} onAddToLead={onAddToLead} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RawStream({
  engagementId,
  label,
  runId,
  stream,
  onAddToLead,
}: {
  engagementId: string;
  label: "stdout" | "stderr";
  runId: string;
  stream: RunOutputResponse["stdout"];
  onAddToLead: ((excerpt: Excerpt) => void) | undefined;
}) {
  const [page, setPage] = useState(0);
  const [selection, setSelection] = useState<
    { byteOffset: number; byteLength: number; text: string } | null
  >(null);
  const create = useCreateExcerptMutation(engagementId);
  const { announce } = useEngagementWorkspace();
  const streamArtifactId = stream.present ? stream.artifactId : null;

  // A selection holds byte offsets for one specific run and artifact.
  // Navigating runs without clearing it would submit the old range under the
  // new run id, keeping unrelated bytes or failing validation.
  useEffect(() => {
    setPage(0);
    setSelection(null);
  }, [engagementId, runId, streamArtifactId]);

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

  const lines = stream.content.split("\n");
  const pageCount = Math.max(1, Math.ceil(lines.length / OUTPUT_WINDOW_LINES));
  const safePage = Math.min(page, pageCount - 1);
  const windowLines = lines.slice(
    safePage * OUTPUT_WINDOW_LINES,
    (safePage + 1) * OUTPUT_WINDOW_LINES,
  );
  const windowCharStart = Array.from(
    lines.slice(0, safePage * OUTPUT_WINDOW_LINES).join("\n") +
      (safePage === 0 ? "" : "\n"),
  ).length;

  const onSelect = (container: HTMLElement | null) => {
    if (container === null) return;
    const browserSelection = window.getSelection();
    if (
      browserSelection === null ||
      browserSelection.isCollapsed ||
      browserSelection.rangeCount === 0
    ) {
      setSelection(null);
      return;
    }
    const range = browserSelection.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) {
      setSelection(null);
      return;
    }
    const before = document.createRange();
    before.selectNodeContents(container);
    before.setEnd(range.startContainer, range.startOffset);
    const start = windowCharStart + Array.from(before.toString()).length;
    const selectedText = range.toString();
    const end = start + Array.from(selectedText).length;
    const mapped = selectionBytesFromText(stream.content, start, end);
    if (!mapped.ok) {
      setSelection(null);
      return;
    }
    setSelection({
      byteOffset: mapped.byteOffset,
      byteLength: mapped.byteLength,
      text: selectedText,
    });
  };

  const keepSelection = () => {
    if (selection === null || create.isPending) return;
    if (create.isError) create.reset();
    create.mutate(
      {
        runId,
        artifactId: stream.artifactId,
        stream: label,
        byteOffset: selection.byteOffset,
        byteLength: selection.byteLength,
      },
      {
        onSuccess: () => {
          setSelection(null);
          announce("Excerpt kept. Open the Findings tab to create a linked finding.");
        },
        onError: () => undefined,
      },
    );
  };

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
      {pageCount > 1 ? (
        <p className="mt-1 mb-0 text-[11px] text-muted-foreground" aria-live="polite">
          Lines {safePage * OUTPUT_WINDOW_LINES + 1} to{" "}
          {Math.min(lines.length, (safePage + 1) * OUTPUT_WINDOW_LINES)} of {lines.length}.{" "}
          Select text to keep an excerpt, or search above without rendering the whole file.
        </p>
      ) : null}
      <pre
        className="mt-1 mb-0 max-h-64 overflow-auto rounded-md border border-border bg-muted/30 px-2.5 py-2 font-mono text-[12px] leading-5 break-all whitespace-pre-wrap"
        data-testid={`raw-output-${label}`}
        onMouseUp={(event) => onSelect(event.currentTarget)}
      >
        {windowLines.join("\n")}
      </pre>
      {pageCount > 1 ? (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="quiet"
            className="h-7 px-2 text-[12px]"
            disabled={safePage === 0}
            onClick={() => {
              setPage(safePage - 1);
              setSelection(null);
            }}
          >
            Previous lines
          </Button>
          <Button
            type="button"
            variant="quiet"
            className="h-7 px-2 text-[12px]"
            disabled={safePage >= pageCount - 1}
            onClick={() => {
              setPage(safePage + 1);
              setSelection(null);
            }}
          >
            Next lines
          </Button>
        </div>
      ) : null}
      {selection !== null ? (
        <div className="mt-2 flex flex-wrap items-center gap-2" aria-live="polite">
          <span className="font-mono text-[11px] text-muted-foreground">
            Selected {selection.byteLength} bytes at offset {selection.byteOffset}.
          </span>
          <Button
            type="button"
            variant="quiet"
            className="h-7 px-2 text-[12px]"
            disabled={create.isPending}
            onClick={keepSelection}
          >
            {create.isPending ? "Keeping" : "Keep excerpt"}
          </Button>
          <CreateFindingButtonAfterKeep
            engagementId={engagementId}
            runId={runId}
            artifactId={stream.artifactId}
            stream={label}
            selection={selection}
            create={create}
          />
          <AddToLeadButton excerpt={null} onAddToLead={onAddToLead} />
        </div>
      ) : null}
      {create.isError && selection !== null ? (
        <p className="mt-1 mb-0 text-[12px] text-destructive" role="alert">
          The excerpt could not be kept. Retry from the selection above.
        </p>
      ) : null}
    </section>
  );
}

// Creates the excerpt first when the operator goes straight from a text
// selection to a finding, then stages the kept excerpt for the Findings tab.
// The staged object is the server response, never the local selection text.
// Shares the parent Keep mutation so the two actions stay mutually exclusive:
// clicking Create finding while Keep is pending no longer posts the same
// range a second time and creates a duplicate persisted excerpt.
function CreateFindingButtonAfterKeep({
  engagementId,
  runId,
  artifactId,
  stream,
  selection,
  create,
}: {
  engagementId: string;
  runId: string;
  artifactId: string;
  stream: "stdout" | "stderr";
  selection: { byteOffset: number; byteLength: number };
  create: ReturnType<typeof useCreateExcerptMutation>;
}) {
  const { announce } = useEngagementWorkspace();
  return (
    <Button
      type="button"
      variant="quiet"
      className="h-7 px-2 text-[12px]"
      disabled={create.isPending}
      onClick={() => {
        create.mutate(
          {
            runId,
            artifactId,
            stream,
            byteOffset: selection.byteOffset,
            byteLength: selection.byteLength,
          },
          {
            onSuccess: (excerpt) => {
              requestFindingFromExcerpt(engagementId, excerpt);
              announce("Excerpt kept. Open the Findings tab to create a linked finding.");
            },
            onError: () => undefined,
          },
        );
      }}
    >
      {create.isPending ? "Keeping" : "Create finding"}
    </Button>
  );
}
