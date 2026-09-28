import {
  LEAD_ATTEMPT_SUMMARY_MAX_CHARS,
  LEAD_CONDITIONS_MAX_CHARS,
  LEAD_EVIDENCE_REFS_MAX,
  type AttemptOutcome,
  type Lead,
  type RunOutputResponse,
} from "@stonehush/contracts";
import { Button } from "@stonehush/ui";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

import { formatEngagementTimestamp } from "./format.js";
import { ATTEMPT_OUTCOME_LABELS, ATTEMPT_OUTCOMES } from "./leads.js";
import {
  LEAD_MUTATION_ERROR_MESSAGE,
  LeadMutationClientError,
  useLeadsQuery,
  useRecordLeadAttemptMutation,
} from "./leads-query.js";

// Add a finished run to a lead: records one attempt whose evidence is the
// run's preserved stdout and stderr. The attempt stores those artifacts only;
// it keeps no link back to the run itself.

type RunStream = "stdout" | "stderr";

export interface RunLeadEvidence {
  readonly stream: RunStream;
  readonly artifactId: string;
  readonly sizeBytes: number;
  readonly completeness: "complete" | "partial" | "truncated";
}

const ATTACHABLE_STATES = new Set(["succeeded", "failed", "cancelled"]);

// Only published streams of a finished run count. Missing streams are never
// replaced, and a shared artifact is listed once.
export function runLeadEvidence(output: RunOutputResponse): RunLeadEvidence[] {
  if (!ATTACHABLE_STATES.has(output.run.state)) return [];
  const evidence: RunLeadEvidence[] = [];
  const seen = new Set<string>();
  for (const stream of ["stdout", "stderr"] as const) {
    const value = output[stream];
    if (!value.present || seen.has(value.artifactId)) continue;
    seen.add(value.artifactId);
    evidence.push({
      stream,
      artifactId: value.artifactId,
      sizeBytes: value.sizeBytes,
      completeness: value.completeness,
    });
  }
  return evidence.slice(0, LEAD_EVIDENCE_REFS_MAX);
}

// A finished tool is not a verdict on the idea, so succeeded and failed runs
// both start as inconclusive. Only an explicit cancellation reads as
// interrupted.
export function defaultRunAttemptOutcome(state: RunOutputResponse["run"]["state"]): AttemptOutcome {
  return state === "cancelled" ? "interrupted" : "inconclusive";
}

function shortRunId(runId: string): string {
  return runId.length > 12 ? runId.slice(0, 8) : runId;
}

export function defaultRunAttemptSummary(
  run: RunOutputResponse["run"],
  evidence: readonly RunLeadEvidence[],
): string {
  const reason =
    run.state === "failed" && run.terminalReason !== null ? ` (${run.terminalReason})` : "";
  const streams = evidence.map((entry) => entry.stream).join(" and ");
  return `Run ${shortRunId(run.id)} ${run.state}${reason} at ${formatEngagementTimestamp(run.updatedAt)}, preserved ${streams} attached`;
}

function describeEvidence(entry: RunLeadEvidence): string {
  const detail = entry.completeness === "complete" ? "" : `, ${entry.completeness}`;
  return `${entry.stream} · ${entry.sizeBytes} bytes${detail}`;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function leadOptionLabel(lead: Lead): string {
  return lead.disposition === "parked" ? `${lead.title} (parked)` : lead.title;
}

export interface RunLeadAttemptFormProps {
  readonly archived: boolean;
  readonly engagementId: string;
  readonly output: RunOutputResponse;
  readonly onClose: () => void;
  readonly onRecorded: (message: string) => void;
}

// Opens over the workspace like the Start a lead form, so the console tray
// never covers it. Render keyed by engagement and run so a draft never
// follows the selection.
export function RunLeadAttemptForm({
  archived,
  engagementId,
  output,
  onClose,
  onRecorded,
}: RunLeadAttemptFormProps) {
  const formId = useId();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const leads = useLeadsQuery(engagementId);
  const record = useRecordLeadAttemptMutation(engagementId);
  const [evidence] = useState(() => runLeadEvidence(output));
  const [initialSummary] = useState(() => defaultRunAttemptSummary(output.run, evidence));
  const [leadId, setLeadId] = useState("");
  const [summary, setSummary] = useState(initialSummary);
  const [initialOutcome] = useState(() => defaultRunAttemptOutcome(output.run.state));
  const [outcome, setOutcome] = useState<AttemptOutcome>(initialOutcome);
  const [conditions, setConditions] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const summaryRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    summaryRef.current?.focus({ preventScroll: true });
  }, []);

  const candidates = (leads.data ?? []).filter((lead) => lead.disposition !== "closed");
  const dirty =
    leadId !== "" ||
    outcome !== initialOutcome ||
    summary.trim() !== initialSummary ||
    conditions.trim().length > 0;

  // Any choice or typed text only goes away through the Discard button.
  const attemptClose = () => {
    if (record.isPending) return;
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (archived || record.isPending) return;
    const lead = candidates.find((entry) => entry.id === leadId);
    if (lead === undefined) {
      setFieldError("Choose an open or parked lead.");
      return;
    }
    const trimmedSummary = summary.trim();
    if (trimmedSummary.length === 0) {
      setFieldError("Describe the attempt.");
      return;
    }
    if (Array.from(trimmedSummary).length > LEAD_ATTEMPT_SUMMARY_MAX_CHARS) {
      setFieldError(`Keep the summary under ${LEAD_ATTEMPT_SUMMARY_MAX_CHARS} characters.`);
      return;
    }
    const trimmedConditions = conditions.trim();
    if (Array.from(trimmedConditions).length > LEAD_CONDITIONS_MAX_CHARS) {
      setFieldError(`Keep the conditions under ${LEAD_CONDITIONS_MAX_CHARS} characters.`);
      return;
    }
    if (evidence.length === 0) {
      setFieldError("This run has no preserved output to attach.");
      return;
    }
    setFieldError(undefined);
    setConfirmDiscard(false);
    record.mutate(
      {
        leadId: lead.id,
        summary: trimmedSummary,
        outcome,
        ...(trimmedConditions.length === 0 ? {} : { conditions: trimmedConditions }),
        evidenceArtifactIds: evidence.map((entry) => entry.artifactId),
      },
      {
        onError: () => summaryRef.current?.focus(),
        onSuccess: (attempt) => {
          onRecorded(
            `Recorded as attempt ${attempt.sequence} on "${lead.title}". Open the Leads tab to see it.`,
          );
        },
      },
    );
  };

  const mutationError = record.isError
    ? record.error instanceof LeadMutationClientError
      ? record.error.message
      : LEAD_MUTATION_ERROR_MESSAGE
    : undefined;

  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      attemptClose();
      return;
    }
    if (event.key !== "Tab") return;
    const root = dialogRef.current;
    if (!root) return;
    const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const fieldClass =
    "w-full rounded-md border border-input bg-transparent px-2.5 py-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return createPortal(
    <div className="fixed inset-0 z-[70] grid place-items-center p-6">
      <button
        type="button"
        aria-label="Dismiss attempt form"
        className="absolute inset-0 bg-black/62"
        onClick={attemptClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-labelledby={titleId}
        className="relative grid max-h-full w-full max-w-[560px] gap-3 overflow-y-auto rounded-[10px] border border-border bg-popover p-5 text-popover-foreground shadow-[0_24px_64px_rgba(0,0,0,0.6)]"
        data-keybinding-capture=""
        onKeyDown={onDialogKeyDown}
      >
        <h2 id={titleId} className="m-0 text-[15px] font-semibold tracking-[-0.02em]">
          Add run to lead
        </h2>
        {confirmDiscard ? (
          <div className="rounded-md border border-border px-3 py-2" role="alert">
            <p className="m-0 text-[12px] text-foreground">Discard this attempt draft?</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>
                Discard
              </Button>
              <Button
                type="button"
                variant="quiet"
                onClick={() => {
                  setConfirmDiscard(false);
                  summaryRef.current?.focus();
                }}
              >
                Keep editing
              </Button>
            </div>
          </div>
        ) : null}
        {archived ? (
          <p className="m-0 text-[12px] leading-5 text-muted-foreground">
            This engagement is archived. Leads can be viewed but not changed.
          </p>
        ) : null}
        <form className="grid gap-3" onSubmit={submit}>
          {leads.data === undefined && leads.isFetching ? (
            <p className="m-0 text-[12px] text-muted-foreground">Loading leads.</p>
          ) : null}
          {leads.data === undefined && leads.isError ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="m-0 text-[12px] text-muted-foreground">Leads could not be loaded.</p>
              <Button
                type="button"
                variant="quiet"
                className="h-7 px-2 text-[12px]"
                onClick={() => void leads.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : null}
          {leads.data !== undefined && candidates.length === 0 ? (
            <p className="m-0 text-[12px] leading-5 text-muted-foreground">
              No open or parked leads. Start one from a Surface result or the Leads tab.
            </p>
          ) : null}
          {candidates.length > 0 ? (
            <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={`${formId}-lead`}>
              <span>Lead</span>
              <select
                id={`${formId}-lead`}
                value={leadId}
                disabled={archived}
                className={fieldClass}
                onChange={(event) => setLeadId(event.target.value)}
              >
                <option value="">Choose a lead</option>
                {candidates.map((lead) => (
                  <option key={lead.id} value={lead.id}>
                    {leadOptionLabel(lead)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={`${formId}-summary`}>
            <span>Attempt summary</span>
            <input
              ref={summaryRef}
              id={`${formId}-summary`}
              value={summary}
              autoComplete="off"
              disabled={archived}
              readOnly={record.isPending}
              maxLength={LEAD_ATTEMPT_SUMMARY_MAX_CHARS}
              className={fieldClass}
              onChange={(event) => setSummary(event.target.value)}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={`${formId}-outcome`}>
              <span>Outcome</span>
              <select
                id={`${formId}-outcome`}
                value={outcome}
                disabled={archived || record.isPending}
                className={fieldClass}
                onChange={(event) => setOutcome(event.target.value as AttemptOutcome)}
              >
                {ATTEMPT_OUTCOMES.map((option) => (
                  <option key={option} value={option}>
                    {ATTEMPT_OUTCOME_LABELS[option]}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={`${formId}-conditions`}>
              <span>Conditions, optional</span>
              <input
                id={`${formId}-conditions`}
                value={conditions}
                autoComplete="off"
                disabled={archived}
                readOnly={record.isPending}
                maxLength={LEAD_CONDITIONS_MAX_CHARS}
                placeholder="Only checked without authentication"
                className={fieldClass}
                onChange={(event) => setConditions(event.target.value)}
              />
            </label>
          </div>
          <div className="grid gap-1">
            <p className="m-0 text-[11px] text-muted-foreground">Preserved output attached</p>
            <ul className="m-0 grid list-none gap-0.5 p-0">
              {evidence.map((entry) => (
                <li key={entry.artifactId} className="font-mono text-[12px] text-foreground">
                  {describeEvidence(entry)}
                </li>
              ))}
            </ul>
            <p className="m-0 text-[11px] leading-5 text-muted-foreground">
              A finished run does not prove the idea. Pick the outcome you actually observed.
            </p>
          </div>
          {fieldError !== undefined ? (
            <p className="m-0 text-[13px] text-destructive" role="alert">
              {fieldError}
            </p>
          ) : null}
          {mutationError !== undefined ? (
            <p className="m-0 text-[13px] text-destructive" role="alert">
              {mutationError}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              disabled={archived || record.isPending || candidates.length === 0 || evidence.length === 0}
            >
              {record.isPending ? "Saving" : "Record attempt"}
            </Button>
            <Button type="button" variant="quiet" disabled={record.isPending} onClick={attemptClose}>
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
