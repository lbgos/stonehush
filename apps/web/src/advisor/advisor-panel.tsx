import {
  ADVISOR_EXCERPT_IDS_MAX,
  ADVISOR_FINDING_IDS_MAX,
  ADVISOR_QUESTION_MAX_BYTES,
  type AdvisorTurn,
} from "@stonehush/contracts";
import { Button } from "@stonehush/ui";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { useAdvisorStatusQuery } from "../advisor-status-query.js";
import { createIdempotencyKey } from "../engagements/idempotency.js";
import { useFindingsQuery } from "../engagements/findings-query.js";
import {
  AdvisorTurnRequestError,
  useAdvisorTurnsQuery,
  useRequestAdvisorTurnMutation,
  type RequestAdvisorTurnInput,
} from "./turn-query.js";

const REFETCH_AFTER_CONFLICT_MS = 3_000;
const PENDING_POLL_INTERVAL_MS = 5_000;
const PENDING_POLL_MAX_ROUNDS = 12;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function fingerprint(input: RequestAdvisorTurnInput): string {
  return JSON.stringify({
    question: input.question,
    excerpts: [...input.excerptArtifactIds],
    findings: [...input.findingIds],
  });
}

const TERMINAL_FAILURE_COPY: Record<string, string> = {
  parse_error: "The model reply could not be understood as an explanation.",
  provider_timeout: "The model endpoint timed out before answering.",
  provider_unreachable: "The model endpoint did not answer.",
  provider_response_too_large: "The model reply was too large to keep.",
  provider_redirect_rejected: "The model endpoint redirected unexpectedly.",
  provider_parse_error: "The model reply could not be understood as an explanation.",
  context_too_large: "The selected evidence is too large. Remove an excerpt or finding.",
  unknown_artifact: "A selected excerpt is no longer available. Adjust the selection.",
  unknown_finding: "A selected finding is no longer available. Adjust the selection.",
  missing_artifact: "A selected excerpt is no longer available. Adjust the selection.",
  corrupt_artifact: "A selected excerpt failed verification. Adjust the selection.",
  engagement_archived: "This engagement is archived.",
  engagement_not_found: "That engagement is no longer available.",
  idempotency_conflict: "This request did not match a previous attempt. Try again.",
};

const SETUP_REASONS = new Set([
  "unconfigured",
  "missing_key_env",
  "key_unset",
  "public_not_opted_in",
]);

function friendlyFailure(main: string, detail?: string): string {
  // Prefer the terminal code: TurnCard passes the stored errorCode, so a
  // provider_error turn reports its actual endpoint message.
  if (detail !== undefined) {
    const exact = TERMINAL_FAILURE_COPY[detail];
    if (exact !== undefined) return exact;
  }
  return TERMINAL_FAILURE_COPY[main] ?? "The advisor request failed.";
}

export interface AdvisorPanelProps {
  readonly engagementId: string;
  readonly archived: boolean;
  readonly excerpts: readonly string[];
  readonly findingIds: readonly string[];
  readonly onExcerptsChange: (ids: string[]) => void;
  readonly onFindingIdsChange: (ids: string[]) => void;
  readonly onClose: () => void;
}

interface Attempt {
  readonly input: RequestAdvisorTurnInput;
  readonly key: string;
}

// Drawer over the engagement detail for asking grounded questions about
// explicitly selected evidence. The parent owns evidence selection; this
// component owns the draft question, the idempotency key lifecycle, and
// turn rendering. Nothing sends without an explicit Ask click.
export function AdvisorPanel({
  engagementId,
  archived,
  excerpts,
  findingIds,
  onExcerptsChange,
  onFindingIdsChange,
  onClose,
}: AdvisorPanelProps) {
  const [question, setQuestion] = useState("");
  const [lastAttempt, setLastAttempt] = useState<Attempt | null>(null);
  const [lastError, setLastError] = useState<AdvisorTurnRequestError | null>(null);
  const [pollCycle, setPollCycle] = useState(0);
  const keyRef = useRef<{ key: string; fingerprint: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const conflictTimer = useRef<number | undefined>(undefined);
  const pollRounds = useRef(0);

  const findings = useFindingsQuery(engagementId);
  const history = useAdvisorTurnsQuery(engagementId);
  const advisorStatus = useAdvisorStatusQuery();
  const ask = useRequestAdvisorTurnMutation(engagementId);
  const historyRef = useRef(history);
  historyRef.current = history;

  // Non-modal drawer focus: capture the trigger, focus the panel, and
  // restore focus on unmount. No trap: background stays interactive.
  useEffect(() => {
    const active = document.activeElement;
    returnFocusRef.current = active instanceof HTMLElement ? active : null;
    const frame = window.requestAnimationFrame(() => panelRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      abortRef.current?.abort();
      if (conflictTimer.current !== undefined) {
        window.clearTimeout(conflictTimer.current);
        conflictTimer.current = undefined;
      }
      const returnFocus = returnFocusRef.current;
      returnFocusRef.current = null;
      if (returnFocus && document.contains(returnFocus)) {
        returnFocus.focus();
      }
    };
  }, []);

  const turns = history.data?.pages.flatMap((page) => page.turns) ?? [];
  const visiblePending = turns.some((turn) => turn.status === "pending");

  // Bounded reconciliation for visible pending turns: refetch history on
  // an interval, stop after a finite number of rounds. Never re-POSTs.
  // The budget resets only when this effect re-runs: pending appears, the
  // engagement changes, or an explicit owned attempt bumps pollCycle in
  // send(). Refetches never re-run it, so one continuously visible pending
  // turn can never poll forever, while every new attempt gets a fresh
  // interval with a full budget.
  useEffect(() => {
    pollRounds.current = 0;
    if (!visiblePending) return;
    const timer = window.setInterval(() => {
      if (pollRounds.current >= PENDING_POLL_MAX_ROUNDS) {
        window.clearInterval(timer);
        return;
      }
      pollRounds.current += 1;
      void historyRef.current.refetch();
    }, PENDING_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [visiblePending, engagementId, pollCycle]);

  const normalizedQuestion = question.trim();
  const questionBytes = utf8Length(normalizedQuestion);
  const excerptCount = excerpts.length;
  const findingCount = findingIds.length;
  const needsExcerpt = findingCount > 0 && excerptCount === 0;
  const setupNeeded =
    advisorStatus.data !== undefined && SETUP_REASONS.has(advisorStatus.data.reason);
  const canAsk =
    !archived &&
    !setupNeeded &&
    !ask.isPending &&
    normalizedQuestion.length > 0 &&
    questionBytes <= ADVISOR_QUESTION_MAX_BYTES &&
    excerptCount >= 1 &&
    excerptCount <= ADVISOR_EXCERPT_IDS_MAX &&
    findingCount <= ADVISOR_FINDING_IDS_MAX;

  function keyFor(input: RequestAdvisorTurnInput): string {
    const print = fingerprint(input);
    const held = keyRef.current;
    if (held !== null && held.fingerprint === print) return held.key;
    const fresh = createIdempotencyKey();
    keyRef.current = { key: fresh, fingerprint: print };
    return fresh;
  }

  function send(input: RequestAdvisorTurnInput, idempotencyKey: string) {
    if (archived) return;
    // Recreate the reconciliation interval with a full budget, even when a
    // previous cycle exhausted and self-cleared it while pending is still
    // visible. Refetches alone never restart it.
    setPollCycle((cycle) => cycle + 1);
    abortRef.current?.abort();
    window.clearTimeout(conflictTimer.current);
    conflictTimer.current = undefined;
    const controller = new AbortController();
    abortRef.current = controller;
    setLastError(null);
    setLastAttempt({ input, key: idempotencyKey });
    ask.mutate(
      { input, idempotencyKey, signal: controller.signal },
      {
        onError: (error) => {
          if (controller.signal.aborted) return;
          if (error instanceof AdvisorTurnRequestError) {
            setLastError(error);
            if (error.code === "turn_in_progress") {
              window.clearTimeout(conflictTimer.current);
              conflictTimer.current = window.setTimeout(() => {
                void history.refetch();
              }, REFETCH_AFTER_CONFLICT_MS);
            }
          } else {
            setLastError(new AdvisorTurnRequestError());
          }
        },
      },
    );
  }

  function buildDraftInput(): RequestAdvisorTurnInput | undefined {
    if (
      archived ||
      normalizedQuestion.length === 0 ||
      questionBytes > ADVISOR_QUESTION_MAX_BYTES ||
      excerptCount < 1 ||
      excerptCount > ADVISOR_EXCERPT_IDS_MAX ||
      findingCount > ADVISOR_FINDING_IDS_MAX
    ) {
      return undefined;
    }
    return {
      question: normalizedQuestion,
      excerptArtifactIds: [...excerpts],
      findingIds: [...findingIds],
    };
  }

  function handleAsk() {
    const input = buildDraftInput();
    if (input === undefined) return;
    send(input, keyFor(input));
  }

  function handleRetry() {
    if (archived || lastAttempt === null) return;
    send(lastAttempt.input, lastAttempt.key);
  }

  function handleNewAttempt() {
    const input = buildDraftInput();
    if (input === undefined) return;
    keyRef.current = null;
    send(input, keyFor(input));
  }

  function handleCancel() {
    abortRef.current?.abort();
    void history.refetch();
  }

  function toggleFinding(id: string) {
    if (archived) return;
    if (findingIds.includes(id)) {
      onFindingIdsChange(findingIds.filter((entry) => entry !== id));
      return;
    }
    if (findingIds.length >= ADVISOR_FINDING_IDS_MAX) return;
    onFindingIdsChange([...findingIds, id]);
  }

  function removeExcerpt(id: string) {
    if (archived) return;
    onExcerptsChange(excerpts.filter((entry) => entry !== id));
  }

  const retryable =
    !archived &&
    lastError !== null &&
    lastAttempt !== null &&
    (lastError.code === "request_failed" || lastError.code === "turn_in_progress") &&
    fingerprint(lastAttempt.input) ===
      fingerprint({
        question: normalizedQuestion,
        excerptArtifactIds: [...excerpts],
        findingIds: [...findingIds],
      });
  const showSetupLink =
    setupNeeded ||
    (lastError !== null &&
      (lastError.code === "advisor_unconfigured" ||
        lastError.code === "missing_key_env" ||
        lastError.code === "key_unset" ||
        lastError.code === "public_not_opted_in"));

  return (
    <section
      ref={panelRef}
      role="dialog"
      aria-label="Advisor"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      className="mt-5 rounded-[10px] border border-border px-3 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="m-0 text-[13px] font-semibold">Advisor</h2>
        <Button type="button" variant="quiet" className="h-7 px-2 text-[12px]" onClick={onClose}>
          Close
        </Button>
      </div>
      {archived ? (
        <p className="mt-1 mb-0 text-[12px] text-muted-foreground" role="status">
          Archived engagements are read-only. Previous explanations stay visible below.
        </p>
      ) : null}

      <div className="mt-3 grid gap-3">
        <div>
          <p className="m-0 text-[12px] font-semibold">
            Evidence excerpts ({excerptCount} of {ADVISOR_EXCERPT_IDS_MAX})
          </p>
          {excerptCount === 0 ? (
            <p className="mt-1 mb-0 text-[12px] text-muted-foreground">
              No excerpts selected. Open a run and choose “Ask about this run”.
            </p>
          ) : (
            <ul className="mt-1 mb-0 list-none space-y-1 p-0">
              {excerpts.map((id) => (
                <li key={id} className="flex min-h-8 items-center justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={id}>
                    {id}
                  </span>
                  {!archived ? (
                    <Button
                      type="button"
                      variant="quiet"
                      className="h-7 shrink-0 px-2 text-[12px]"
                      onClick={() => removeExcerpt(id)}
                      aria-label={`Remove excerpt ${id}`}
                    >
                      Remove
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <p className="m-0 text-[12px] font-semibold">
            Findings ({findingCount} of {ADVISOR_FINDING_IDS_MAX})
          </p>
          <FindingPicker
            archived={archived}
            findings={findings.data}
            isLoading={findings.isFetching && findings.data === undefined}
            selectedIds={findingIds}
            disabled={archived || findingCount >= ADVISOR_FINDING_IDS_MAX}
            onToggle={toggleFinding}
          />
          {needsExcerpt && !archived ? (
            <p className="mt-1 mb-0 text-[12px] text-muted-foreground" role="status">
              Finding-only questions need at least one evidence excerpt.
            </p>
          ) : null}
        </div>

        <div>
          <label
            className="mb-1 block text-[12px] font-semibold"
            htmlFor="advisor-question"
          >
            Question ({questionBytes}/{ADVISOR_QUESTION_MAX_BYTES} bytes)
          </label>
          <textarea
            id="advisor-question"
            value={question}
            rows={3}
            disabled={archived}
            placeholder="Ask about the selected evidence…"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setQuestion(event.target.value)}
            className="min-h-20 w-full rounded-md border border-input bg-transparent px-2.5 py-2 font-mono text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          />
          <div className="mt-1.5 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="quiet"
              className="h-7 px-2 text-[12px]"
              disabled={archived}
              onClick={() => setQuestion("Summarize the selected evidence. What stands out?")}
            >
              Summarize this run
            </Button>
            <Button
              type="button"
              variant="quiet"
              className="h-7 px-2 text-[12px]"
              disabled={archived}
              onClick={() => setQuestion("Explain what failed in the selected evidence and why.")}
            >
              Explain this failure
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" disabled={!canAsk} onClick={handleAsk}>
            {ask.isPending ? "Asking" : "Ask"}
          </Button>
          {ask.isPending ? (
            <Button type="button" variant="secondary" onClick={handleCancel}>
              Cancel
            </Button>
          ) : null}
          {!ask.isPending && retryable ? (
            <Button type="button" variant="secondary" onClick={handleRetry}>
              Retry
            </Button>
          ) : null}
          {!ask.isPending && !archived && lastAttempt !== null ? (
            <Button type="button" variant="quiet" onClick={handleNewAttempt}>
              New attempt
            </Button>
          ) : null}
        </div>

        {ask.isPending ? (
          <p className="m-0 text-[12px] text-muted-foreground" role="status" aria-live="polite">
            Waiting for the local model. Cancel stops only this request.
          </p>
        ) : null}
        {lastError !== null && !ask.isPending ? (
          <p className="m-0 text-[12px] text-muted-foreground" role="alert">
            {friendlyFailure(lastError.code)}
            {lastError.code === "turn_in_progress"
              ? " Use Check again or Retry with the same attempt."
              : null}
          </p>
        ) : null}
        {showSetupLink ? (
          <p className="m-0 text-[12px]">
            <Link
              to="/settings"
              className="text-[12px] font-semibold text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              Open Advisor settings
            </Link>
          </p>
        ) : null}

        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="m-0 text-[12px] font-semibold">History</h3>
            <Button
              type="button"
              variant="quiet"
              className="h-7 px-2 text-[12px]"
              onClick={() => void history.refetch()}
            >
              Check again
            </Button>
          </div>
          {history.data === undefined && history.isFetching ? (
            <p className="m-0 text-[12px] text-muted-foreground">Loading explanations…</p>
          ) : null}
          {history.data === undefined && history.isError ? (
            <p className="m-0 text-[12px] text-muted-foreground" role="alert">
              Previous explanations could not be loaded.
            </p>
          ) : null}
          {/* Background refetch failure with cached data. Suppressed when
              the failure came from fetchNextPage so only the
              operation-specific action below shows. */}
          {history.data !== undefined && history.isError && !history.isFetchNextPageError ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <p className="m-0 text-[12px] text-muted-foreground" role="alert">
                Showing saved explanations; refresh failed.
              </p>
              <Button
                type="button"
                variant="quiet"
                className="h-7 px-2 text-[12px]"
                onClick={() => void history.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : null}
          <ul className="m-0 list-none space-y-3 p-0">
            {turns.map((turn) => (
              <TurnCard key={turn.id} turn={turn} />
            ))}
          </ul>
          {history.isFetchNextPageError ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <p className="m-0 text-[12px] text-muted-foreground" role="alert">
                Could not load more explanations.
              </p>
              <Button
                type="button"
                variant="quiet"
                className="h-7 px-2 text-[12px]"
                onClick={() => void history.fetchNextPage()}
              >
                Retry
              </Button>
            </div>
          ) : null}
          {history.hasNextPage ? (
            <div className="mt-2">
              <Button
                type="button"
                variant="quiet"
                className="h-7 px-2 text-[12px]"
                disabled={history.isFetchingNextPage}
                onClick={() => void history.fetchNextPage()}
              >
                {history.isFetchingNextPage ? "Loading" : "Load more"}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function FindingPicker({
  archived,
  findings,
  isLoading,
  selectedIds,
  disabled,
  onToggle,
}: {
  archived: boolean;
  findings: ReadonlyArray<{ id: string; title: string }> | undefined;
  isLoading: boolean;
  selectedIds: readonly string[];
  disabled: boolean;
  onToggle: (findingId: string) => void;
}) {
  if (isLoading) {
    return <p className="mt-1 mb-0 text-[12px] text-muted-foreground">Loading findings…</p>;
  }
  if (findings === undefined || findings.length === 0) {
    return (
      <p className="mt-1 mb-0 text-[12px] text-muted-foreground">
        No findings in this engagement yet.
      </p>
    );
  }
  return (
    <ul className="mt-1 mb-0 list-none space-y-1 p-0">
      {findings.map((finding) => {
        const selected = selectedIds.includes(finding.id);
        return (
          <li key={finding.id}>
            <label className="flex min-h-8 cursor-pointer items-start gap-2 text-[12px]">
              <input
                type="checkbox"
                checked={selected}
                disabled={(disabled && !selected) || archived}
                onChange={() => onToggle(finding.id)}
                className="mt-1 size-4 shrink-0 cursor-pointer accent-primary"
              />
              <span className="min-w-0">
                <span className="block truncate font-medium" title={finding.title}>
                  {finding.title}
                </span>
                <span className="block truncate font-mono text-[11px] text-muted-foreground" title={finding.id}>
                  {finding.id}
                </span>
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

function TurnCard({ turn }: { turn: AdvisorTurn }) {
  return (
    <li className="rounded-[10px] border border-border px-3 py-2.5">
      <p className="m-0 text-[12px] font-semibold">Q: {turn.question}</p>
      {turn.status === "pending" ? (
        <p className="mt-1 mb-0 text-[12px] text-muted-foreground" role="status">
          Running…
        </p>
      ) : null}
      {turn.status === "succeeded" ? (
        <div className="mt-1.5">
          {turn.abstained ? (
            <p className="m-0 mb-1 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
              Abstained — guidance, not fact
            </p>
          ) : null}
          <p className="m-0 whitespace-pre-wrap break-words text-[12px] leading-5">{turn.answer}</p>
          {turn.uncertainty.length > 0 ? (
            <div className="mt-2">
              <p className="m-0 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                Uncertainty
              </p>
              <p className="m-0 mt-0.5 whitespace-pre-wrap break-words text-[12px] leading-5 text-muted-foreground">
                {turn.uncertainty}
              </p>
            </div>
          ) : null}
          {turn.citations.length > 0 ? (
            <ul className="mt-2 mb-0 list-none space-y-1 p-0" aria-label="Citations">
              {turn.citations.map((citation, index) => (
                <li key={`${citation.raw}-${index}`}>
                  {citation.valid && citation.kind !== "unknown" ? (
                    <span className="inline-block rounded-md bg-accent px-2 py-0.5 font-mono text-[11px]">
                      {citation.kind}: {citation.raw}
                    </span>
                  ) : (
                    <span className="inline-block rounded-md border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                      unverified: {citation.raw}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {turn.status === "parse_error" || turn.status === "provider_error" ? (
        <p className="mt-1 mb-0 text-[12px] text-muted-foreground" role="status">
          {friendlyFailure(turn.status, turn.errorCode)}
        </p>
      ) : null}
      {turn.status === "cancelled" || turn.status === "expired" ? (
        <p className="mt-1 mb-0 text-[12px] text-muted-foreground" role="status">
          {turn.status === "cancelled" ? "Cancelled." : "Expired. Ask again with a new attempt."}
        </p>
      ) : null}
    </li>
  );
}
