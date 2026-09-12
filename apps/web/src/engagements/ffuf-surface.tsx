import {
  FFUF_MAX_TIME_SECONDS_DEFAULT,
  FFUF_RATE_DEFAULT,
  FFUF_THREADS_DEFAULT,
  FFUF_TIMEOUT_SECONDS_DEFAULT,
  type FfufProjected,
  type PersistedAction,
  type SavedScopeRule,
} from "@stonehush/contracts";
import { Button, LoadingRegion, RecoverableError, Skeleton } from "@stonehush/ui";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useRunnerSettingsQuery } from "../settings/runner-settings.js";
import { WarningCard } from "./action-planner.js";
import { useCancelActionMutation } from "./action-mutations.js";
import { actionLifecycleStatusCopy, isTerminalActionState, persistedActionQueryOptions } from "./action-query.js";
import { latestActionSnapshot } from "./action-targets.js";
import { engagementMutationMessage } from "./errors.js";
import { type FfufDiscoveryInput, useLaunchFfufDiscoveryMutation } from "./ffuf-mutations.js";
import { formatEngagementTimestamp } from "./format.js";
import { isPathRowSelected, pathInspectorRecord, pathSelectionKey, PausedRunWarning, type ExtraRowActions } from "./inspector.js";
import {
  engagementFfufResultsQueryKey,
  useEngagementDetailQuery,
  useEngagementFfufResultsQuery,
} from "./query.js";
import { copyTextToClipboard } from "./report-query.js";
import { reportQueryKey } from "./report-query.js";

const DEFAULT_MATCH_CODES = "200, 204, 301, 302, 307, 308, 401, 403";

function parsePositiveInt(raw: string, field: string): { ok: true; value: number } | { ok: false; message: string } {
  const value = Number.parseInt(raw.trim(), 10);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value) || value < 1) {
    return { ok: false, message: `${field} must be a positive integer.` };
  }
  return { ok: true, value };
}

function parseMatchCodes(raw: string): { ok: true; value: number[] } | { ok: false; message: string } {
  const values: number[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const code = Number.parseInt(trimmed, 10);
    if (!/^\d+$/.test(trimmed) || code < 100 || code > 599) {
      return { ok: false, message: `Match code "${trimmed}" must be an integer in 100-599.` };
    }
    values.push(code);
  }
  if (values.length === 0) return { ok: false, message: "Match codes need at least one status code." };
  return { ok: true, value: values };
}

export function EngagementFfufSection({
  archived,
  engagementId,
  extraRowActions,
  onSelectKey,
  selectedKey,
}: {
  archived: boolean;
  engagementId: string;
  extraRowActions?: ExtraRowActions | undefined;
  onSelectKey?: ((key: string) => void) | undefined;
  selectedKey?: string | undefined;
}) {
  const detail = useEngagementDetailQuery(engagementId);
  const hasDetail = detail.data !== undefined;

  return (
    <section aria-label="ffuf discovery" className="overflow-hidden rounded-[10px] border border-border bg-card">
      <div className="flex min-h-10 items-center justify-between border-b border-border px-3">
        <h2 className="m-0 text-[13px] font-semibold">ffuf discovery</h2>
        <span className="hidden text-[11px] text-muted-foreground sm:inline">T2 content discovery</span>
      </div>
      <div className="grid gap-4 p-3">
        {!hasDetail && detail.isFetching ? (
          <LoadingRegion label="Loading ffuf discovery" className="space-y-3">
            <Skeleton className="h-20 w-full" />
          </LoadingRegion>
        ) : null}
        {!hasDetail && detail.isError ? (
          <p className="m-0 text-[12px] leading-5 text-muted-foreground">
            ffuf discovery is unavailable until engagement detail loads.
          </p>
        ) : null}
        {hasDetail ? (
          <FfufDiscoveryBody
            key={engagementId}
            archived={archived}
            engagementId={engagementId}
            expectedActiveScopeRevisionId={detail.data.activeScopeRevision?.id ?? null}
            expectedEngagementRevision={detail.data.engagement.revision}
            scopeRules={detail.data.activeScopeRevision?.rules ?? []}
          />
        ) : null}
        <FfufResultsList
          engagementId={engagementId}
          extraRowActions={extraRowActions}
          onSelectKey={onSelectKey}
          selectedKey={selectedKey}
        />
      </div>
    </section>
  );
}

function FfufDiscoveryBody({
  archived,
  engagementId,
  expectedActiveScopeRevisionId,
  expectedEngagementRevision,
  scopeRules,
}: {
  archived: boolean;
  engagementId: string;
  expectedActiveScopeRevisionId: string | null;
  expectedEngagementRevision: number;
  scopeRules: readonly SavedScopeRule[];
}) {
  const formId = useId();
  const queryClient = useQueryClient();
  const runnerDefaults = useRunnerSettingsQuery();
  const [origin, setOrigin] = useState("");
  const [wordlistPath, setWordlistPath] = useState("");
  const [rate, setRate] = useState(String(FFUF_RATE_DEFAULT));
  const [threads, setThreads] = useState(String(FFUF_THREADS_DEFAULT));
  const [timeoutSeconds, setTimeoutSeconds] = useState(String(FFUF_TIMEOUT_SECONDS_DEFAULT));
  const [maxTimeSeconds, setMaxTimeSeconds] = useState(String(FFUF_MAX_TIME_SECONDS_DEFAULT));
  const [matchCodes, setMatchCodes] = useState(DEFAULT_MATCH_CODES);
  // Stored defaults prefill fields the operator has not touched yet; explicit
  // per-run values always win. A failed settings read keeps shipped defaults.
  const editedFields = useRef(new Set<string>());
  const markEdited = (field: string) => {
    editedFields.current.add(field);
  };
  const storedDefaults = runnerDefaults.data;
  useEffect(() => {
    if (storedDefaults === undefined) return;
    if (!editedFields.current.has("wordlistPath")) setWordlistPath(storedDefaults.ffufWordlistPath);
    if (!editedFields.current.has("rate")) setRate(String(storedDefaults.ffufRate));
    if (!editedFields.current.has("threads")) setThreads(String(storedDefaults.ffufThreads));
    if (!editedFields.current.has("timeoutSeconds")) setTimeoutSeconds(String(storedDefaults.ffufTimeoutSeconds));
    if (!editedFields.current.has("maxTimeSeconds")) setMaxTimeSeconds(String(storedDefaults.ffufMaxTimeSeconds));
  }, [storedDefaults]);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [result, setResult] = useState<PersistedAction | undefined>(undefined);
  const [lastInputs, setLastInputs] = useState<FfufDiscoveryInput | undefined>(undefined);
  const [trackedActionId, setTrackedActionId] = useState<string | undefined>(undefined);
  const hasInvalidatedFfufRef = useRef<string | null>(null);

  const launch = useLaunchFfufDiscoveryMutation();
  const cancelAction = useCancelActionMutation();

  const polledActionQuery = useQuery({
    ...persistedActionQueryOptions(engagementId, trackedActionId),
    refetchInterval: (query) => {
      const data = query.state.data as PersistedAction | undefined;
      if (data !== undefined && isTerminalActionState(data.action.state)) return false;
      if (query.state.error) return false;
      return 1500;
    },
    retry: false,
  });

  const displayAction = trackedActionId !== undefined ? (polledActionQuery.data ?? result) : result;

  useEffect(() => {
    hasInvalidatedFfufRef.current = null;
  }, [trackedActionId]);

  useEffect(() => {
    const action = polledActionQuery.data;
    if (action === undefined || trackedActionId === undefined) return;
    if (action.action.actionId !== trackedActionId) return;
    if (!isTerminalActionState(action.action.state)) return;
    if (hasInvalidatedFfufRef.current === trackedActionId) return;
    hasInvalidatedFfufRef.current = trackedActionId;
    void queryClient.invalidateQueries({ queryKey: engagementFfufResultsQueryKey(engagementId) });
    void queryClient.invalidateQueries({ queryKey: reportQueryKey(engagementId) });
  }, [engagementId, polledActionQuery.data, queryClient, trackedActionId]);

  const mutationError =
    launch.isError
      ? engagementMutationMessage(launch.error)
      : cancelAction.isError
        ? engagementMutationMessage(cancelAction.error)
        : undefined;
  const canLaunch = !archived && !launch.isPending;

  const trackLaunched = (action: PersistedAction) => {
    setResult(action);
    setTrackedActionId(
      isTerminalActionState(action.action.state) ? undefined : action.action.actionId,
    );
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canLaunch) return;
    launch.reset();
    cancelAction.reset();
    setResult(undefined);
    setTrackedActionId(undefined);
    if (origin.trim().length === 0) {
      setFieldError("Origin must be an http or https URL.");
      return;
    }
    if (wordlistPath.trim().length === 0) {
      setFieldError("Wordlist path must be an absolute managed path.");
      return;
    }
    const parsed = {
      rate: parsePositiveInt(rate, "Rate"),
      threads: parsePositiveInt(threads, "Threads"),
      timeout: parsePositiveInt(timeoutSeconds, "Timeout"),
      maxTime: parsePositiveInt(maxTimeSeconds, "Duration"),
      codes: parseMatchCodes(matchCodes),
    };
    const failure = [parsed.rate, parsed.threads, parsed.timeout, parsed.maxTime, parsed.codes].find(
      (entry) => !entry.ok,
    );
    if (failure !== undefined && !failure.ok) {
      setFieldError(failure.message);
      return;
    }
    if (!parsed.rate.ok || !parsed.threads.ok || !parsed.timeout.ok || !parsed.maxTime.ok || !parsed.codes.ok) return;
    setFieldError(undefined);
    const inputs: FfufDiscoveryInput = {
      engagementId,
      expectedEngagementRevision,
      expectedActiveScopeRevisionId,
      origin: origin.trim(),
      wordlistPath: wordlistPath.trim(),
      rate: parsed.rate.value,
      threads: parsed.threads.value,
      timeoutSeconds: parsed.timeout.value,
      maxTimeSeconds: parsed.maxTime.value,
      matchStatusCodes: parsed.codes.value,
    };
    setLastInputs(inputs);
    launch.mutate(inputs, { onSuccess: trackLaunched });
  };

  const rerun = () => {
    if (!canLaunch || lastInputs === undefined) return;
    launch.reset();
    cancelAction.reset();
    setResult(undefined);
    setTrackedActionId(undefined);
    launch.mutate(lastInputs, { onSuccess: trackLaunched });
  };

  const stop = () => {
    if (displayAction === undefined || cancelAction.isPending) return;
    cancelAction.mutate(
      {
        engagementId,
        actionId: displayAction.action.actionId,
        expectedRevision: displayAction.revision,
      },
      { onSuccess: (action) => trackLaunched(action) },
    );
  };

  const snapshot = displayAction !== undefined ? latestActionSnapshot(displayAction) : undefined;
  const terminal = displayAction !== undefined && isTerminalActionState(displayAction.action.state);
  const stoppable =
    displayAction !== undefined &&
    !terminal &&
    (displayAction.action.state === "queued" || displayAction.action.state === "active_paused_for_warning");

  const numericFields = [
    { id: `${formId}-rate`, label: "Rate", value: rate, onChange: setRate, field: "rate" },
    { id: `${formId}-threads`, label: "Threads", value: threads, onChange: setThreads, field: "threads" },
    { id: `${formId}-timeout`, label: "Timeout s", value: timeoutSeconds, onChange: setTimeoutSeconds, field: "timeoutSeconds" },
    { id: `${formId}-maxtime`, label: "Duration s", value: maxTimeSeconds, onChange: setMaxTimeSeconds, field: "maxTimeSeconds" },
  ];

  return (
    <div>
      {archived && (
        <p className="mb-3 text-[12px] leading-5 text-muted-foreground">
          This engagement is archived. ffuf discoveries cannot be launched.
        </p>
      )}
      <form className="grid gap-3" onSubmit={submit}>
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            { id: `${formId}-origin`, label: "Origin", value: origin, onChange: setOrigin, placeholder: "http://127.0.0.1:8080", field: "origin" },
            { id: `${formId}-wordlist`, label: "Wordlist path", value: wordlistPath, onChange: setWordlistPath, placeholder: "/wordlists/smoke.txt", field: "wordlistPath" },
          ].map((field) => (
            <label key={field.id} className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={field.id}>
              <span>{field.label}</span>
              <input
                id={field.id}
                value={field.value}
                placeholder={field.placeholder}
                autoComplete="off"
                spellCheck={false}
                disabled={archived || launch.isPending}
                className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 font-mono text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) => {
                  markEdited(field.field);
                  field.onChange(event.target.value);
                }}
              />
            </label>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {numericFields.map((field) => (
            <label key={field.id} className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={field.id}>
              <span>{field.label}</span>
              <input
                id={field.id}
                value={field.value}
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                disabled={archived || launch.isPending}
                className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 font-mono text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) => {
                  markEdited(field.field);
                  field.onChange(event.target.value);
                }}
              />
            </label>
          ))}
        </div>
        <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={`${formId}-codes`}>
          <span>Match status codes</span>
          <input
            id={`${formId}-codes`}
            value={matchCodes}
            autoComplete="off"
            spellCheck={false}
            disabled={archived || launch.isPending}
            className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 font-mono text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) => setMatchCodes(event.target.value)}
          />
        </label>
        {runnerDefaults.isError && (
          <p className="m-0 text-[12px] leading-5 text-muted-foreground">
            Stored runner defaults are unavailable. Using shipped defaults.
          </p>
        )}
        {fieldError && (
          <p className="m-0 text-[13px] text-destructive" role="alert">
            {fieldError}
          </p>
        )}
        {mutationError && (
          <p className="m-0 text-[13px] text-destructive" role="alert">
            {mutationError}
          </p>
        )}
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button type="submit" disabled={!canLaunch}>
            {launch.isPending ? "Launching" : "Launch discovery"}
          </Button>
          {lastInputs !== undefined && terminal ? (
            <Button type="button" variant="secondary" disabled={!canLaunch} onClick={rerun}>
              Run again
            </Button>
          ) : null}
          {stoppable ? (
            <Button type="button" variant="quiet" disabled={cancelAction.isPending} onClick={stop}>
              {cancelAction.isPending ? "Stopping" : "Stop"}
            </Button>
          ) : null}
        </div>
      </form>

      {displayAction?.action.state === "paused_for_warning" ? (
        <WarningCard
          action={displayAction}
          engagementId={engagementId}
          expectedEngagementRevision={expectedEngagementRevision}
          plannedTargets={[lastInputs?.origin ?? origin.trim()]}
          scopeRules={scopeRules}
          onAddScopeAndRun={trackLaunched}
          onCancel={trackLaunched}
          onContinue={trackLaunched}
        />
      ) : null}

      {displayAction?.action.state === "active_paused_for_warning" ? (
        <PausedRunWarning
          action={displayAction}
          engagementId={engagementId}
          onContinued={trackLaunched}
        />
      ) : null}

      {displayAction !== undefined &&
      displayAction.action.state !== "paused_for_warning" &&
      displayAction.action.state !== "active_paused_for_warning" ? (
        <p className="mt-4 mb-0 text-[13px] text-foreground" role="status">
          {actionLifecycleStatusCopy(displayAction.action)}{" "}
          <span className="font-mono text-[12px] text-muted-foreground">
            {displayAction.action.actionId}
            {snapshot !== undefined ? ` · snapshot ${snapshot.version}` : ""}
          </span>
        </p>
      ) : null}
    </div>
  );
}

function FfufResultsList({
  engagementId,
  extraRowActions,
  onSelectKey,
  selectedKey,
}: {
  engagementId: string;
  extraRowActions: ExtraRowActions | undefined;
  onSelectKey: ((key: string) => void) | undefined;
  selectedKey: string | undefined;
}) {
  const resultsQuery = useEngagementFfufResultsQuery(engagementId);
  const hasData = resultsQuery.data !== undefined;
  const retry = () => void resultsQuery.refetch();

  if (!hasData && resultsQuery.isError) {
    return (
      <RecoverableError
        title="ffuf results unavailable"
        description="The ffuf results could not be loaded from the local control plane."
        onRetry={retry}
      />
    );
  }
  if (!hasData) {
    return (
      <LoadingRegion label="Loading ffuf results" className="space-y-3">
        <Skeleton className="h-14 w-full" />
      </LoadingRegion>
    );
  }

  const results = [...resultsQuery.data].sort((left, right) => {
    const url = left.url.localeCompare(right.url);
    return url !== 0 ? url : left.artifactId.localeCompare(right.artifactId);
  });
  if (results.length === 0) {
    return (
      <div className="rounded-md border border-border px-4 py-6 text-center">
        <h3 className="m-0 text-[13px] font-semibold">No ffuf results yet</h3>
        <p className="mx-auto mt-2 mb-0 max-w-md text-[13px] leading-5 text-muted-foreground">
          Launch a discovery above. Matched paths are listed here with byte-identical raw JSON evidence.
        </p>
      </div>
    );
  }

  return (
    <ul className="m-0 grid list-none gap-2 p-0">
      {results.map((result) => (
        <FfufResultRow
          key={`${result.url}:${result.artifactId}`}
          engagementId={engagementId}
          extraRowActions={extraRowActions}
          onSelectKey={onSelectKey}
          result={result}
          selected={isPathRowSelected(result, selectedKey, results)}
        />
      ))}
    </ul>
  );
}

function FfufResultRow({
  engagementId,
  extraRowActions,
  onSelectKey,
  result,
  selected,
}: {
  engagementId: string;
  extraRowActions: ExtraRowActions | undefined;
  onSelectKey: ((key: string) => void) | undefined;
  result: FfufProjected;
  selected: boolean;
}) {
  const [copied, setCopied] = useState<string | undefined>(undefined);
  const key = pathSelectionKey(result.url, result.artifactId);
  const copyValue = (label: string, value: string) => {
    void copyTextToClipboard(value).then((ok) => {
      if (ok) setCopied(label);
    });
  };
  return (
    <li
      data-surface-row={key}
      className="min-w-0 rounded-md border border-border px-3 py-2"
    >
      {onSelectKey === undefined ? (
        <div className="truncate font-mono text-[13px] font-semibold tracking-[-0.02em]" title={result.url}>
          {result.url}
        </div>
      ) : (
        <button
          type="button"
          aria-current={selected ? "true" : undefined}
          onClick={() => onSelectKey(key)}
          className="block w-full truncate text-left font-mono text-[13px] font-semibold tracking-[-0.02em] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          title={result.url}
        >
          {result.url}
        </button>
      )}
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
        <span>{result.status}</span>
        <span>{result.length} bytes</span>
        <span>{result.words} words</span>
        <span>{result.lines} lines</span>
        <span className="truncate" title={result.fuzz}>
          {result.fuzz}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        <span className="font-mono">{formatEngagementTimestamp(result.observedAt)}</span>
        <a
          className="inline-flex min-h-11 items-center text-[12px] font-semibold text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring md:min-h-8"
          href={`/api/v1/engagements/${engagementId}/artifacts/${result.artifactId}/content`}
          download
        >
          Raw evidence
        </a>
        {onSelectKey === undefined ? null : (
          <button
            type="button"
            onClick={() => onSelectKey(key)}
            className="inline-flex min-h-11 items-center text-[12px] font-semibold text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring md:min-h-8"
          >
            Inspect
          </button>
        )}
        <button
          type="button"
          onClick={() => copyValue("copy", result.url)}
          className="inline-flex min-h-11 items-center text-[12px] font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring md:min-h-8"
        >
          {copied === "copy" ? "Copied" : "Copy"}
        </button>
        <button
          type="button"
          onClick={() => copyValue("note", pathInspectorRecord(result, engagementId).noteReference)}
          className="inline-flex min-h-11 items-center text-[12px] font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring md:min-h-8"
        >
          {copied === "note" ? "Copied" : "Copy note reference"}
        </button>
        {extraRowActions === undefined ? null : (
          <span>{extraRowActions({ kind: "path", key, title: result.url, target: result.url })}</span>
        )}
      </div>
    </li>
  );
}
