import {
  FFUF_MAX_TIME_SECONDS_DEFAULT,
  FFUF_RATE_DEFAULT,
  FFUF_THREADS_DEFAULT,
  FFUF_TIMEOUT_SECONDS_DEFAULT,
  FFUF_VHOST_DEFAULT_PORT,
  type FfufVhostProjected,
  type PersistedAction,
  type SavedScopeRule,
  type StoneHostnameAssociation,
} from "@stonehush/contracts";
import { calibrateVhostResultsByArtifact as calibrateDomain } from "@stonehush/domain";
import { Button, LoadingRegion, RecoverableError, Skeleton } from "@stonehush/ui";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useRunnerSettingsQuery } from "../settings/runner-settings.js";
import { WarningCard } from "./action-planner.js";
import { useCancelActionMutation } from "./action-mutations.js";
import { actionLifecycleStatusCopy, isTerminalActionState, persistedActionQueryOptions } from "./action-query.js";
import { latestActionSnapshot } from "./action-targets.js";
import { engagementMutationMessage } from "./errors.js";
import { FfufWordlistView } from "./ffuf-wordlist-view.js";
import { formatEngagementTimestamp } from "./format.js";
import { isLauncherStoppable, PausedRunWarning, selectDisplayAction } from "./inspector.js";
import {
  engagementVhostResultsQueryKey,
  useEngagementDetailQuery,
  useEngagementVhostResultsQuery,
} from "./query.js";
import { copyTextToClipboard } from "./report-query.js";
import { reportQueryKey } from "./report-query.js";
import {
  decideStoneHostnameRequest,
  proposeStoneHostnameRequest,
  useStoneTargetsQuery,
} from "./target-context-query.js";
import {
  parseVhostPositiveInt,
  useLaunchVhostDiscoveryMutation,
  validateVhostAddress,
  validateVhostWordlistPath,
  type VhostDiscoveryInput,
} from "./vhost-mutations.js";

const DEFAULT_MATCH_CODES = "200, 204, 301, 302, 307, 308, 401, 403";

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

function hostFromBaseUrl(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl);
    return parsed.hostname.replace(/^\[(.*)\]$/, "$1");
  } catch {
    return baseUrl;
  }
}

function offerKey(hostname: string, artifactId: string, targetId: string): string {
  return `${hostname} ${artifactId} ${targetId}`;
}

export function EngagementVhostSection({
  archived,
  engagementId,
}: {
  archived: boolean;
  engagementId: string;
}) {
  const detail = useEngagementDetailQuery(engagementId);
  const hasDetail = detail.data !== undefined;

  return (
    <section aria-label="vhost discovery" className="overflow-hidden rounded-[10px] border border-border bg-card">
      <div className="flex min-h-10 items-center justify-between border-b border-border px-3">
        <h2 className="m-0 text-[13px] font-semibold">vhost discovery</h2>
        <span className="hidden text-[11px] text-muted-foreground sm:inline">T1 Host header discovery</span>
      </div>
      <div className="grid gap-4 p-3">
        {!hasDetail && detail.isFetching ? (
          <LoadingRegion label="Loading vhost discovery" className="space-y-3">
            <Skeleton className="h-20 w-full" />
          </LoadingRegion>
        ) : null}
        {!hasDetail && detail.isError ? (
          <p className="m-0 text-[12px] leading-5 text-muted-foreground">
            vhost discovery is unavailable until engagement detail loads.
          </p>
        ) : null}
        {hasDetail ? (
          <VhostDiscoveryBody
            key={engagementId}
            archived={archived}
            engagementId={engagementId}
            expectedActiveScopeRevisionId={detail.data.activeScopeRevision?.id ?? null}
            expectedEngagementRevision={detail.data.engagement.revision}
            scopeRules={detail.data.activeScopeRevision?.rules ?? []}
          />
        ) : null}
        <VhostResultsList engagementId={engagementId} />
      </div>
    </section>
  );
}

function VhostDiscoveryBody({
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
  const [address, setAddress] = useState("");
  const [port, setPort] = useState(String(FFUF_VHOST_DEFAULT_PORT));
  const [tls, setTls] = useState(false);
  const [wordlistPath, setWordlistPath] = useState("");
  const [rate, setRate] = useState(String(FFUF_RATE_DEFAULT));
  const [threads, setThreads] = useState(String(FFUF_THREADS_DEFAULT));
  const [timeoutSeconds, setTimeoutSeconds] = useState(String(FFUF_TIMEOUT_SECONDS_DEFAULT));
  const [maxTimeSeconds, setMaxTimeSeconds] = useState(String(FFUF_MAX_TIME_SECONDS_DEFAULT));
  const [matchCodes, setMatchCodes] = useState(DEFAULT_MATCH_CODES);
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
  const [lastInputs, setLastInputs] = useState<VhostDiscoveryInput | undefined>(undefined);
  const [trackedActionId, setTrackedActionId] = useState<string | undefined>(undefined);
  const hasInvalidatedRef = useRef<string | null>(null);

  const launch = useLaunchVhostDiscoveryMutation();
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

  const displayAction =
    trackedActionId !== undefined
      ? selectDisplayAction(polledActionQuery.data ?? undefined, result)
      : result;

  useEffect(() => {
    hasInvalidatedRef.current = null;
  }, [trackedActionId]);

  useEffect(() => {
    const action = polledActionQuery.data;
    if (action === undefined || trackedActionId === undefined) return;
    if (action.action.actionId !== trackedActionId) return;
    if (!isTerminalActionState(action.action.state)) return;
    if (hasInvalidatedRef.current === trackedActionId) return;
    hasInvalidatedRef.current = trackedActionId;
    void queryClient.invalidateQueries({ queryKey: engagementVhostResultsQueryKey(engagementId) });
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
    const target = validateVhostAddress(address);
    if (!target.ok) {
      setFieldError(target.message);
      return;
    }
    const wordlist = validateVhostWordlistPath(wordlistPath);
    if (!wordlist.ok) {
      setFieldError(wordlist.message);
      return;
    }
    const parsed = {
      port: parseVhostPositiveInt(port, "port", "Port"),
      rate: parseVhostPositiveInt(rate, "rate", "Rate"),
      threads: parseVhostPositiveInt(threads, "threads", "Threads"),
      timeout: parseVhostPositiveInt(timeoutSeconds, "timeoutSeconds", "Timeout"),
      maxTime: parseVhostPositiveInt(maxTimeSeconds, "maxTimeSeconds", "Duration"),
      codes: parseMatchCodes(matchCodes),
    };
    const failure = [parsed.port, parsed.rate, parsed.threads, parsed.timeout, parsed.maxTime, parsed.codes].find(
      (entry) => !entry.ok,
    );
    if (failure !== undefined && !failure.ok) {
      setFieldError(failure.message);
      return;
    }
    if (!parsed.port.ok || !parsed.rate.ok || !parsed.threads.ok || !parsed.timeout.ok || !parsed.maxTime.ok || !parsed.codes.ok) return;
    launch.reset();
    cancelAction.reset();
    setResult(undefined);
    setTrackedActionId(undefined);
    setFieldError(undefined);
    const inputs: VhostDiscoveryInput = {
      engagementId,
      expectedEngagementRevision,
      expectedActiveScopeRevisionId,
      address: target.value,
      port: parsed.port.value,
      tls,
      wordlistPath: wordlist.value,
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
  const stoppable = isLauncherStoppable(displayAction);

  const numericFields = [
    { id: `${formId}-port`, label: "Port", value: port, onChange: setPort, field: "port" },
    { id: `${formId}-rate`, label: "Rate", value: rate, onChange: setRate, field: "rate" },
    { id: `${formId}-threads`, label: "Threads", value: threads, onChange: setThreads, field: "threads" },
    { id: `${formId}-timeout`, label: "Timeout s", value: timeoutSeconds, onChange: setTimeoutSeconds, field: "timeoutSeconds" },
    { id: `${formId}-maxtime`, label: "Duration s", value: maxTimeSeconds, onChange: setMaxTimeSeconds, field: "maxTimeSeconds" },
  ];

  return (
    <div>
      {archived && (
        <p className="mb-3 text-[12px] leading-5 text-muted-foreground">
          This engagement is archived. vhost discoveries cannot be launched.
        </p>
      )}
      <FfufWordlistView
        ffufVersion={null}
        exists={() => true}
        onResolve={(resolvedPath) => {
          markEdited("wordlistPath");
          setWordlistPath(resolvedPath);
        }}
      />
      <form className="mt-3 grid gap-3" onSubmit={submit}>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={`${formId}-address`}>
            <span>Target IP</span>
            <input
              id={`${formId}-address`}
              value={address}
              placeholder="192.0.2.10"
              autoComplete="off"
              spellCheck={false}
              disabled={archived || launch.isPending}
              className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 font-mono text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => {
                markEdited("address");
                setAddress(event.target.value);
              }}
            />
          </label>
          <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={`${formId}-wordlist`}>
            <span>Wordlist path</span>
            <input
              id={`${formId}-wordlist`}
              value={wordlistPath}
              placeholder="/wordlists/hosts.txt"
              autoComplete="off"
              spellCheck={false}
              disabled={archived || launch.isPending}
              className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 font-mono text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => {
                markEdited("wordlistPath");
                setWordlistPath(event.target.value);
              }}
            />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
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
        <label className="flex min-h-11 items-center gap-2 text-[12px] text-muted-foreground md:min-h-8" htmlFor={`${formId}-tls`}>
          <input
            id={`${formId}-tls`}
            type="checkbox"
            checked={tls}
            disabled={archived || launch.isPending}
            onChange={(event) => setTls(event.target.checked)}
          />
          <span>Use TLS (https)</span>
        </label>
        <p className="m-0 text-[11px] leading-5 text-muted-foreground">
          Wordlist entries are sent verbatim as the Host header. The request URL stays the explicit IP.
          Rate is stored for forward compatibility and is not sent to ffuf 1.1.0.
        </p>
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
          plannedTargets={[lastInputs?.address ?? address.trim()]}
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

function VhostResultsList({ engagementId }: { engagementId: string }) {
  const resultsQuery = useEngagementVhostResultsQuery(engagementId);
  const targetsQuery = useStoneTargetsQuery(engagementId);
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [offers, setOffers] = useState<Record<string, StoneHostnameAssociation>>({});
  const [offerError, setOfferError] = useState<string | null>(null);
  const [offerBusy, setOfferBusy] = useState(false);
  const hasData = resultsQuery.data !== undefined;
  const retry = () => void resultsQuery.refetch();

  const calibration = useMemo(
    () => calibrateDomain(resultsQuery.data ?? []),
    [resultsQuery.data],
  );

  if (!hasData && resultsQuery.isError) {
    return (
      <RecoverableError
        title="vhost results unavailable"
        description="The vhost results could not be loaded from the local control plane."
        onRetry={retry}
      />
    );
  }
  if (!hasData) {
    return (
      <LoadingRegion label="Loading vhost results" className="space-y-3">
        <Skeleton className="h-14 w-full" />
      </LoadingRegion>
    );
  }

  const results = [...resultsQuery.data].sort((left, right) => {
    const host = left.hostname.localeCompare(right.hostname);
    return host !== 0 ? host : left.artifactId.localeCompare(right.artifactId);
  });
  // Baselines differ per run target, so calibration runs per artifact: one
  // artifact's wildcard never hides another artifact's candidates.
  const candidateKeys = new Set(
    calibration.candidates.map((entry) => `${entry.hostname} ${entry.artifactId}`),
  );
  const candidates = results.filter((entry) =>
    candidateKeys.has(`${entry.hostname} ${entry.artifactId}`),
  );
  const candidateRowKeys = new Set(
    candidates.map((entry) => `${entry.hostname} ${entry.artifactId}`),
  );
  const filtered = results.filter(
    (entry) => candidateRowKeys.has(`${entry.hostname} ${entry.artifactId}`) === false,
  );
  const activeTargetId = selectedTargetId ?? targetsQuery.data?.[0]?.id ?? null;

  const onPropose = async (result: FfufVhostProjected) => {
    if (activeTargetId === null || offerBusy) return;
    const proposedTargetId = activeTargetId;
    setOfferBusy(true);
    setOfferError(null);
    try {
      const association = await proposeStoneHostnameRequest(engagementId, proposedTargetId, {
        connectionAddress: hostFromBaseUrl(result.baseUrl),
        requestedHostname: result.hostname,
      });
      setOffers((current) => ({
        ...current,
        [offerKey(result.hostname, result.artifactId, proposedTargetId)]: association,
      }));
    } catch {
      setOfferError("The hostname offer was not accepted. Check the target and try again.");
    } finally {
      setOfferBusy(false);
    }
  };

  const onDecide = async (
    hostname: string,
    artifactId: string,
    targetId: string,
    decision: "associated" | "declined",
  ) => {
    const key = offerKey(hostname, artifactId, targetId);
    const offer = offers[key];
    if (offer === undefined || offerBusy) return;
    setOfferBusy(true);
    setOfferError(null);
    try {
      const decided = await decideStoneHostnameRequest(engagementId, offer.id, decision);
      setOffers((current) => ({ ...current, [key]: decided }));
    } catch {
      setOfferError("The decision was not recorded. Try again.");
    } finally {
      setOfferBusy(false);
    }
  };

  if (results.length === 0) {
    return (
      <div className="rounded-md border border-border px-4 py-6 text-center">
        <h3 className="m-0 text-[13px] font-semibold">No vhost results yet</h3>
        <p className="mx-auto mt-2 mb-0 max-w-md text-[13px] leading-5 text-muted-foreground">
          Launch a discovery above. Candidate hostnames are listed here with byte-identical raw JSON evidence.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      {calibration.notes.map((note) => (
        <p key={note} className="m-0 text-[12px] leading-5 text-muted-foreground" role="status">
          {note}
        </p>
      ))}
      <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="vhost-target-select">
        <span>Propose associations on target</span>
        <select
          id="vhost-target-select"
          className="min-h-11 w-full rounded-md border border-input bg-transparent px-2.5 text-[13px] text-foreground md:min-h-8"
          value={activeTargetId ?? ""}
          onChange={(event) => setSelectedTargetId(event.target.value)}
        >
          {(targetsQuery.data ?? []).map((target) => (
            <option key={target.id} value={target.id}>
              {target.label}
            </option>
          ))}
        </select>
      </label>
      {offerError !== null ? (
        <p className="m-0 text-[13px] text-destructive" role="alert">
          {offerError}
        </p>
      ) : null}
      {candidates.length === 0 ? (
        <p className="m-0 text-[12px] leading-5 text-muted-foreground">
          Every response matched the baseline. No candidates remain; filtered responses stay listed
          below with raw evidence.
        </p>
      ) : null}
      <ul className="m-0 grid list-none gap-2 p-0">
        {candidates.map((result) => {
          const offer =
            activeTargetId === null
              ? undefined
              : offers[offerKey(result.hostname, result.artifactId, activeTargetId)];
          return (
            <VhostResultRow
              key={`${result.hostname}:${result.artifactId}`}
              engagementId={engagementId}
              result={result}
              offer={offer}
              offerBusy={offerBusy}
              canPropose={activeTargetId !== null}
              onPropose={() => void onPropose(result)}
              onDecide={(decision) =>
                activeTargetId === null
                  ? undefined
                  : void onDecide(result.hostname, result.artifactId, activeTargetId, decision)
              }
            />
          );
        })}
        {filtered.map((result) => (
          <VhostResultRow
            key={`filtered:${result.hostname}:${result.artifactId}`}
            engagementId={engagementId}
            result={result}
            offer={undefined}
            offerBusy={false}
            canPropose={false}
            filtered
            onPropose={() => undefined}
            onDecide={() => undefined}
          />
        ))}
      </ul>
    </div>
  );
}

function VhostResultRow({
  engagementId,
  result,
  offer,
  offerBusy,
  canPropose,
  filtered = false,
  onPropose,
  onDecide,
}: {
  engagementId: string;
  result: FfufVhostProjected;
  offer: StoneHostnameAssociation | undefined;
  offerBusy: boolean;
  canPropose: boolean;
  filtered?: boolean;
  onPropose: () => void;
  onDecide: (decision: "associated" | "declined") => void;
}) {
  const [copied, setCopied] = useState<string | undefined>(undefined);
  const copyValue = (label: string, value: string) => {
    void copyTextToClipboard(value).then((ok) => {
      if (ok) setCopied(label);
    });
  };
  return (
    <li className="min-w-0 rounded-md border border-border px-3 py-2">
      <div className="truncate font-mono text-[13px] font-semibold tracking-[-0.02em]" title={result.hostname}>
        {result.hostname}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
        <span>{result.status}</span>
        <span>{result.length} bytes</span>
        <span>{result.words} words</span>
        <span>{result.lines} lines</span>
        <span className="truncate" title={result.baseUrl}>
          {result.baseUrl}
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
        <button
          type="button"
          onClick={() => copyValue("copy", result.hostname)}
          className="inline-flex min-h-11 items-center text-[12px] font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring md:min-h-8"
        >
          {copied === "copy" ? "Copied" : "Copy"}
        </button>
        {filtered ? (
          <span className="inline-flex min-h-11 items-center text-[12px] text-muted-foreground md:min-h-8">
            Filtered by baseline
          </span>
        ) : offer === undefined ? (
          <button
            type="button"
            disabled={!canPropose || offerBusy}
            onClick={onPropose}
            className="inline-flex min-h-11 items-center text-[12px] font-semibold text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring md:min-h-8"
          >
            Propose association
          </button>
        ) : (
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
            <span>Status: {offer.status}.</span>
            {offer.status === "proposed" ? (
              <>
                <button
                  type="button"
                  disabled={offerBusy}
                  onClick={() => onDecide("associated")}
                  className="inline-flex min-h-11 items-center font-semibold text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring md:min-h-8"
                >
                  Associate
                </button>
                <button
                  type="button"
                  disabled={offerBusy}
                  onClick={() => onDecide("declined")}
                  className="inline-flex min-h-11 items-center font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring md:min-h-8"
                >
                  Decline
                </button>
              </>
            ) : null}
          </span>
        )}
      </div>
      {offer !== undefined ? (
        <p className="mt-1 mb-0 text-[11px] leading-5 text-muted-foreground">
          {offer.runnerOnlyNote} {offer.nextStep} Machines are never merged automatically.
        </p>
      ) : null}
    </li>
  );
}
