import { useState } from "react";

import type {
  Lead,
  LeadAttempt,
  Objective,
  ObjectiveKind,
  Secret,
} from "@blackglass/contracts";
import { SECRET_STORAGE_COPY } from "@blackglass/domain";
import {
  Button,
  LoadingRegion,
  RecoverableError,
  Skeleton,
  StaleDataState,
} from "@blackglass/ui";

import {
  LeadsQueryError,
  useCaptureObjectiveMutation,
  useCreateLeadMutation,
  useCreateObjectiveMutation,
  useCreateSecretMutation,
  useLeadAttemptsQuery,
  useLeadOutlineQuery,
  useLeadTransitionMutation,
  useLeadsQuery,
  useObjectiveTransitionMutation,
  useObjectivesQuery,
  useParkLeadMutation,
  useRecordAttemptMutation,
  useRecordVerificationMutation,
  useSecretsQuery,
  useSuggestRevisitMutation,
} from "./leads-query.js";
import { formatEngagementTimestamp } from "./format.js";

const LEAD_SOURCE_KINDS = [
  "nmap_service",
  "http_probe",
  "ffuf_result",
  "run_output",
  "manual",
] as const;

const ATTEMPT_OUTCOMES = [
  "observed",
  "ruled_out",
  "inconclusive",
  "interrupted",
] as const;

const ATTEMPT_OUTCOME_LABELS: Record<(typeof ATTEMPT_OUTCOMES)[number], string> = {
  observed: "observed",
  ruled_out: "ruled out under conditions",
  inconclusive: "inconclusive",
  interrupted: "interrupted (tool finished, hypothesis undecided)",
};

const OBJECTIVE_KINDS: readonly ObjectiveKind[] = [
  "user_flag",
  "root_flag",
  "single_proof",
  "custom",
];

function parseEvidenceInput(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function mutationMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function EngagementLeadsSection({
  archived,
  engagementId,
}: {
  archived: boolean;
  engagementId: string;
}) {
  const leads = useLeadsQuery(engagementId);
  const retry = () => void leads.refetch();
  const hasData = leads.data !== undefined;
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);

  const body = (
    <LeadsBody
      archived={archived}
      engagementId={engagementId}
      leads={leads.data ?? []}
      selectedLeadId={selectedLeadId}
      onSelectLead={setSelectedLeadId}
    />
  );

  return (
    <section aria-label="Leads" className="mt-5 border-t border-border pt-4">
      <header className="mb-3">
        <h2 className="m-0 text-[13px] font-semibold">Leads</h2>
        <p className="mt-1 mb-0 text-[12px] leading-5 text-muted-foreground">
          Bookmark-effort questions attached to results. No severity, no estimates.
        </p>
      </header>
      {!hasData && leads.isFetching ? (
        <LoadingRegion label="Loading leads" className="space-y-3">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-14 w-full" />
        </LoadingRegion>
      ) : null}
      {!hasData && leads.isError ? (
        <RecoverableError
          title="Leads unavailable"
          description={
            leads.error instanceof LeadsQueryError
              ? leads.error.message
              : "The leads could not be loaded from the local control plane."
          }
          onRetry={retry}
        />
      ) : null}
      {hasData && leads.isError ? (
        <StaleDataState
          title="Showing the last successful leads"
          description="The latest refresh failed. Existing leads are still available."
          onRetry={retry}
        >
          {body}
        </StaleDataState>
      ) : null}
      {hasData && !leads.isError ? body : null}
    </section>
  );
}

function LeadsBody({
  archived,
  engagementId,
  leads,
  selectedLeadId,
  onSelectLead,
}: {
  archived: boolean;
  engagementId: string;
  leads: Lead[];
  selectedLeadId: string | null;
  onSelectLead: (leadId: string | null) => void;
}) {
  const create = useCreateLeadMutation(engagementId);
  const [title, setTitle] = useState("");
  const [target, setTarget] = useState("");
  const [sourceKind, setSourceKind] =
    useState<(typeof LEAD_SOURCE_KINDS)[number]>("manual");
  const [sourceRef, setSourceRef] = useState("");
  const [nextStep, setNextStep] = useState("");
  const [formError, setFormError] = useState<string | undefined>(undefined);

  const selected = leads.find((lead) => lead.id === selectedLeadId) ?? null;
  const openCount = leads.filter((lead) => lead.disposition === "open").length;
  const mutationError = create.isError ? mutationMessage(create.error, "The leads request failed.") : formError;

  const canSubmit = !archived && !create.isPending && title.trim().length > 0 && sourceRef.trim().length > 0;

  const submit = () => {
    setFormError(undefined);
    if (create.isError) create.reset();
    if (title.trim().length === 0) {
      setFormError("Enter a lead title.");
      return;
    }
    if (sourceRef.trim().length === 0) {
      setFormError("Enter the source evidence reference.");
      return;
    }
    create.mutate(
      {
        title: title.trim(),
        ...(target.trim().length === 0 ? {} : { target: target.trim() }),
        source: { kind: sourceKind, ref: sourceRef.trim() },
        ...(nextStep.trim().length === 0 ? {} : { nextStep: nextStep.trim() }),
      },
      {
        onSuccess: (lead) => {
          setTitle("");
          setTarget("");
          setSourceRef("");
          setNextStep("");
          onSelectLead(lead.id);
        },
      },
    );
  };

  return (
    <div className="grid gap-4">
      <div>
        {leads.length === 0 ? (
          <div className="border border-border px-4 py-8 text-center">
            <h3 className="m-0 text-[13px] font-semibold">No leads yet</h3>
            <p className="mx-auto mt-2 mb-0 max-w-md text-[13px] leading-5 text-muted-foreground">
              Bookmark the first open question with its source evidence.
            </p>
          </div>
        ) : (
          <div>
            <p className="m-0 mb-2 text-[12px] text-muted-foreground" aria-live="polite">
              {openCount} open of {leads.length} leads
            </p>
            <ul className="m-0 grid list-none gap-2 p-0">
              {leads.map((lead) => (
                <li key={lead.id} className="border border-border px-3 py-2.5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="m-0 truncate text-[13px] font-semibold" title={lead.title}>
                        {lead.title}
                      </p>
                      <p className="m-0 mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                        <span>{lead.disposition}</span>
                        {lead.target !== null ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono">{lead.target}</span>
                          </>
                        ) : null}
                        <span aria-hidden="true">·</span>
                        <span className="font-mono">
                          {lead.source.kind}:{lead.source.ref}
                        </span>
                      </p>
                      {lead.disposition === "parked" && lead.revisitSuggestion !== null && !lead.revisitSuggestion.dismissed ? (
                        <p className="m-0 mt-1 text-[12px] leading-5 text-muted-foreground">
                          Revisit suggestion ({lead.revisitSuggestion.trigger}): {lead.revisitSuggestion.reason}
                        </p>
                      ) : null}
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => onSelectLead(selected?.id === lead.id ? null : lead.id)}
                    >
                      {selected?.id === lead.id ? "Hide" : "Detail"}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
        {mutationError ? (
          <p className="mt-2 mb-0 text-[13px] text-destructive" role="alert">
            {mutationError}
          </p>
        ) : null}
      </div>

      {selected !== null ? (
        <LeadDetail archived={archived} engagementId={engagementId} lead={selected} />
      ) : null}

      <div className="border border-border">
        <div className="border-b border-border px-3 py-2">
          <h3 className="m-0 text-[13px] font-semibold">New lead</h3>
        </div>
        <div className="grid gap-3 px-3 py-3">
          <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="lead-title">
            <span>Title</span>
            <input
              id="lead-title"
              value={title}
              disabled={archived || create.isPending}
              placeholder="Odd login form on port 8080"
              maxLength={120}
              className="w-full border border-input bg-transparent px-2.5 py-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="lead-target">
              <span>Target, optional</span>
              <input
                id="lead-target"
                value={target}
                disabled={archived || create.isPending}
                placeholder="192.0.2.10"
                spellCheck={false}
                className="w-full border border-input bg-transparent px-2.5 py-2 font-mono text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) => setTarget(event.target.value)}
              />
            </label>
            <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="lead-source-kind">
              <span>Source kind</span>
              <select
                id="lead-source-kind"
                value={sourceKind}
                disabled={archived || create.isPending}
                className="w-full border border-input bg-transparent px-2.5 py-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) => setSourceKind(event.target.value as typeof sourceKind)}
              >
                {LEAD_SOURCE_KINDS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="lead-source-ref">
            <span>Source evidence reference</span>
            <input
              id="lead-source-ref"
              value={sourceRef}
              disabled={archived || create.isPending}
              placeholder="probe artifact id or service key"
              spellCheck={false}
              className="w-full border border-input bg-transparent px-2.5 py-2 font-mono text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => setSourceRef(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="lead-next-step">
            <span>Next step, optional</span>
            <input
              id="lead-next-step"
              value={nextStep}
              disabled={archived || create.isPending}
              placeholder="Try default credentials over TLS"
              maxLength={500}
              className="w-full border border-input bg-transparent px-2.5 py-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => setNextStep(event.target.value)}
            />
          </label>
          {archived ? (
            <p className="m-0 text-[12px] leading-5 text-muted-foreground">
              This engagement is archived. Leads can be viewed but not changed.
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button type="button" disabled={!canSubmit} onClick={submit}>
              {create.isPending ? "Saving" : "Create lead"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function LeadDetail({
  archived,
  engagementId,
  lead,
}: {
  archived: boolean;
  engagementId: string;
  lead: Lead;
}) {
  const attempts = useLeadAttemptsQuery(engagementId, lead.id);
  const outline = useLeadOutlineQuery(engagementId, lead.id);
  const park = useParkLeadMutation(engagementId);
  const transition = useLeadTransitionMutation(engagementId, "reopen");
  const close = useLeadTransitionMutation(engagementId, "close");
  const dismiss = useLeadTransitionMutation(engagementId, "revisit/dismiss");
  const suggest = useSuggestRevisitMutation(engagementId);
  const record = useRecordAttemptMutation(engagementId, lead.id);

  const [parkReason, setParkReason] = useState("");
  const [testedConditions, setTestedConditions] = useState("");
  const [summary, setSummary] = useState("");
  const [outcome, setOutcome] =
    useState<(typeof ATTEMPT_OUTCOMES)[number]>("observed");
  const [conditions, setConditions] = useState("");
  const [evidence, setEvidence] = useState("");
  const [detailError, setDetailError] = useState<string | undefined>(undefined);

  const records = attempts.data ?? [];
  const error =
    detailError ??
    (park.isError || transition.isError || close.isError || dismiss.isError || suggest.isError || record.isError
      ? mutationMessage(
          park.error ?? transition.error ?? close.error ?? dismiss.error ?? suggest.error ?? record.error,
          "The leads request failed.",
        )
      : undefined);

  const doPark = () => {
    setDetailError(undefined);
    if (parkReason.trim().length === 0) {
      setDetailError("Parking needs a reason.");
      return;
    }
    park.mutate({
      leadId: lead.id,
      reason: parkReason.trim(),
      ...(testedConditions.trim().length === 0 ? {} : { testedConditions: testedConditions.trim() }),
    });
  };

  const doRecord = () => {
    setDetailError(undefined);
    if (summary.trim().length === 0) {
      setDetailError("Describe the attempt.");
      return;
    }
    record.mutate(
      {
        summary: summary.trim(),
        outcome,
        ...(conditions.trim().length === 0 ? {} : { conditions: conditions.trim() }),
        evidenceArtifactIds: parseEvidenceInput(evidence),
      },
      {
        onSuccess: () => {
          setSummary("");
          setConditions("");
          setEvidence("");
        },
      },
    );
  };

  return (
    <div className="grid gap-3 border border-border px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 text-[13px] font-semibold">Lead detail</h3>
        <div className="flex flex-wrap gap-2">
          {lead.disposition !== "open" ? (
            <Button
              type="button"
              variant="secondary"
              disabled={archived || transition.isPending}
              onClick={() => transition.mutate({ leadId: lead.id })}
            >
              Reopen
            </Button>
          ) : null}
          {lead.disposition !== "closed" ? (
            <Button
              type="button"
              variant="secondary"
              disabled={archived || close.isPending}
              onClick={() => close.mutate({ leadId: lead.id })}
            >
              Close
            </Button>
          ) : null}
        </div>
      </div>

      {lead.disposition === "parked" ? (
        <div className="grid gap-2">
          <p className="m-0 text-[12px] leading-5 text-muted-foreground">
            Parked: {lead.parkReason ?? "no reason recorded"}
            {lead.testedConditions !== null ? ` Tested under: ${lead.testedConditions}.` : ""}
          </p>
          {lead.revisitSuggestion !== null && !lead.revisitSuggestion.dismissed ? (
            <div className="flex flex-wrap items-start justify-between gap-2 border border-border px-2.5 py-2">
              <p className="m-0 min-w-0 flex-1 text-[12px] leading-5 text-muted-foreground">
                Quiet suggestion ({lead.revisitSuggestion.trigger}): {lead.revisitSuggestion.reason} The lead stays parked.
              </p>
              <Button
                type="button"
                variant="secondary"
                disabled={archived || dismiss.isPending}
                onClick={() => dismiss.mutate({ leadId: lead.id })}
              >
                Dismiss
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div>
        <h4 className="m-0 mb-2 text-[12px] font-semibold">Attempts</h4>
        {attempts.isFetching && records.length === 0 ? (
          <LoadingRegion label="Loading attempts">
            <Skeleton className="h-10 w-full" />
          </LoadingRegion>
        ) : null}
        {records.length === 0 && !attempts.isFetching ? (
          <p className="m-0 text-[12px] text-muted-foreground">No attempts recorded.</p>
        ) : (
          <ul className="m-0 grid list-none gap-2 p-0">
            {records.map((attempt: LeadAttempt) => (
              <li key={attempt.id} className="border border-border px-2.5 py-2">
                <p className="m-0 text-[12px] font-semibold">
                  {attempt.sequence}. {attempt.summary}
                </p>
                <p className="m-0 mt-1 text-[11px] text-muted-foreground">
                  {ATTEMPT_OUTCOME_LABELS[attempt.outcome]}
                  {attempt.conditions !== null ? ` under ${attempt.conditions}` : ""}
                  {attempt.evidenceArtifactIds.length > 0 ? (
                    <span className="font-mono"> · {attempt.evidenceArtifactIds.join(", ")}</span>
                  ) : null}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      {outline.data !== undefined && outline.data.length > 0 ? (
        <div>
          <h4 className="m-0 mb-2 text-[12px] font-semibold">Chain outline</h4>
          <pre className="m-0 overflow-x-auto border border-border px-2.5 py-2 font-mono text-[11px] leading-5 whitespace-pre-wrap text-muted-foreground">
            {outline.data}
          </pre>
        </div>
      ) : null}

      {error ? (
        <p className="m-0 text-[13px] text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {!archived && lead.disposition === "open" ? (
        <div className="grid gap-2">
          <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={`park-reason-${lead.id}`}>
            <span>Park reason</span>
            <input
              id={`park-reason-${lead.id}`}
              value={parkReason}
              disabled={park.isPending}
              placeholder="No working credentials yet"
              maxLength={500}
              className="w-full border border-input bg-transparent px-2.5 py-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => setParkReason(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={`park-conditions-${lead.id}`}>
            <span>Tested conditions, optional</span>
            <input
              id={`park-conditions-${lead.id}`}
              value={testedConditions}
              disabled={park.isPending}
              placeholder="Only checked without authentication"
              maxLength={500}
              className="w-full border border-input bg-transparent px-2.5 py-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => setTestedConditions(event.target.value)}
            />
          </label>
          <div className="flex justify-end">
            <Button type="button" variant="secondary" disabled={park.isPending} onClick={doPark}>
              {park.isPending ? "Parking" : "Park with reason"}
            </Button>
          </div>
        </div>
      ) : null}

      {!archived ? (
        <div className="grid gap-2 border-t border-border pt-3">
          <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={`attempt-summary-${lead.id}`}>
            <span>Attempt summary</span>
            <input
              id={`attempt-summary-${lead.id}`}
              value={summary}
              disabled={record.isPending}
              placeholder="Checked default credentials"
              maxLength={2000}
              className="w-full border border-input bg-transparent px-2.5 py-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => setSummary(event.target.value)}
            />
          </label>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={`attempt-outcome-${lead.id}`}>
              <span>Outcome</span>
              <select
                id={`attempt-outcome-${lead.id}`}
                value={outcome}
                disabled={record.isPending}
                className="w-full border border-input bg-transparent px-2.5 py-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) => setOutcome(event.target.value as typeof outcome)}
              >
                {ATTEMPT_OUTCOMES.map((option) => (
                  <option key={option} value={option}>
                    {ATTEMPT_OUTCOME_LABELS[option]}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={`attempt-evidence-${lead.id}`}>
              <span>Evidence artifact ids, comma separated</span>
              <input
                id={`attempt-evidence-${lead.id}`}
                value={evidence}
                disabled={record.isPending}
                placeholder="shared-capture-1"
                spellCheck={false}
                className="w-full border border-input bg-transparent px-2.5 py-2 font-mono text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) => setEvidence(event.target.value)}
              />
            </label>
          </div>
          <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={`attempt-conditions-${lead.id}`}>
            <span>Conditions, optional</span>
            <input
              id={`attempt-conditions-${lead.id}`}
              value={conditions}
              disabled={record.isPending}
              placeholder="Only checked without authentication"
              maxLength={500}
              className="w-full border border-input bg-transparent px-2.5 py-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => setConditions(event.target.value)}
            />
          </label>
          <div className="flex justify-end">
            <Button type="button" disabled={record.isPending} onClick={doRecord}>
              {record.isPending ? "Saving" : "Record attempt"}
            </Button>
          </div>
        </div>
      ) : null}

      <p className="m-0 text-[11px] leading-5 text-muted-foreground">
        Attempts record what was tried and what was observed. A finished tool run never proves the idea was right.
      </p>
    </div>
  );
}

export function EngagementObjectivesSection({
  archived,
  engagementId,
}: {
  archived: boolean;
  engagementId: string;
}) {
  const objectives = useObjectivesQuery(engagementId);
  const retry = () => void objectives.refetch();
  const hasData = objectives.data !== undefined;

  return (
    <section aria-label="Objectives" className="mt-5 border-t border-border pt-4">
      <header className="mb-3">
        <h2 className="m-0 text-[13px] font-semibold">Objectives</h2>
        <p className="mt-1 mb-0 text-[12px] leading-5 text-muted-foreground">
          Named goals. Captured means the proof was obtained. Submitted means you recorded its submission. No scores.
        </p>
      </header>
      {!hasData && objectives.isFetching ? (
        <LoadingRegion label="Loading objectives" className="space-y-3">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-14 w-full" />
        </LoadingRegion>
      ) : null}
      {!hasData && objectives.isError ? (
        <RecoverableError
          title="Objectives unavailable"
          description="The objectives could not be loaded from the local control plane."
          onRetry={retry}
        />
      ) : null}
      {hasData && objectives.isError ? (
        <StaleDataState
          title="Showing the last successful objectives"
          description="The latest refresh failed. Existing objectives are still available."
          onRetry={retry}
        >
          <ObjectivesBody archived={archived} engagementId={engagementId} records={objectives.data ?? []} />
        </StaleDataState>
      ) : null}
      {hasData && !objectives.isError ? (
        <ObjectivesBody archived={archived} engagementId={engagementId} records={objectives.data ?? []} />
      ) : null}
    </section>
  );
}

function ObjectivesBody({
  archived,
  engagementId,
  records,
}: {
  archived: boolean;
  engagementId: string;
  records: Objective[];
}) {
  const create = useCreateObjectiveMutation(engagementId);
  const capture = useCaptureObjectiveMutation(engagementId);
  const submit = useObjectiveTransitionMutation(engagementId, "submit");
  const reopen = useObjectiveTransitionMutation(engagementId, "reopen");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ObjectiveKind>("user_flag");
  const [proofs, setProofs] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | undefined>(undefined);

  const mutationError =
    create.isError || capture.isError || submit.isError || reopen.isError
      ? mutationMessage(
          create.error ?? capture.error ?? submit.error ?? reopen.error,
          "The objectives request failed.",
        )
      : formError;

  const canSubmit = !archived && !create.isPending && name.trim().length > 0;

  return (
    <div className="grid gap-4">
      <div>
        {records.length === 0 ? (
          <div className="border border-border px-4 py-8 text-center">
            <h3 className="m-0 text-[13px] font-semibold">No objectives yet</h3>
            <p className="mx-auto mt-2 mb-0 max-w-md text-[13px] leading-5 text-muted-foreground">
              Name the first goal. Values stay masked and copy is deliberate.
            </p>
          </div>
        ) : (
          <ul className="m-0 grid list-none gap-2 p-0">
            {records.map((objective) => (
              <li key={objective.id} className="border border-border px-3 py-2.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="m-0 truncate text-[13px] font-semibold" title={objective.name}>
                      {objective.name}
                    </p>
                    <p className="m-0 mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                      <span>{objective.kind}</span>
                      <span aria-hidden="true">·</span>
                      <span>{objective.state}</span>
                      {objective.proofHint !== null ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono">[masked] {objective.proofHint}</span>
                        </>
                      ) : null}
                    </p>
                    {objective.state === "open" && !archived ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <label className="grid min-w-0 flex-1 gap-1 text-[11px] text-muted-foreground" htmlFor={`proof-${objective.id}`}>
                          <span>Proof value, hashed on capture and never stored</span>
                          <input
                            id={`proof-${objective.id}`}
                            type="password"
                            value={proofs[objective.id] ?? ""}
                            disabled={capture.isPending}
                            autoComplete="off"
                            spellCheck={false}
                            className="w-full border border-input bg-transparent px-2.5 py-2 font-mono text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            onChange={(event) =>
                              setProofs((current) => ({ ...current, [objective.id]: event.target.value }))
                            }
                          />
                        </label>
                        <Button
                          type="button"
                          disabled={capture.isPending || (proofs[objective.id] ?? "").length === 0}
                          onClick={() => {
                            const value = proofs[objective.id] ?? "";
                            if (value.length === 0) {
                              setFormError("Enter the proof value to capture.");
                              return;
                            }
                            capture.mutate(
                              { objectiveId: objective.id, proofValue: value },
                              {
                                onSuccess: () =>
                                  setProofs((current) => ({ ...current, [objective.id]: "" })),
                              },
                            );
                          }}
                        >
                          Capture
                        </Button>
                      </div>
                    ) : null}
                  </div>
                  <div className="flex gap-2">
                    {objective.state === "captured" ? (
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={archived || submit.isPending}
                        onClick={() => submit.mutate(objective.id)}
                      >
                        Submit
                      </Button>
                    ) : null}
                    {objective.state !== "open" ? (
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={archived || reopen.isPending}
                        onClick={() => reopen.mutate(objective.id)}
                      >
                        Reopen
                      </Button>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        {mutationError ? (
          <p className="mt-2 mb-0 text-[13px] text-destructive" role="alert">
            {mutationError}
          </p>
        ) : null}
      </div>

      <div className="border border-border">
        <div className="border-b border-border px-3 py-2">
          <h3 className="m-0 text-[13px] font-semibold">New objective</h3>
        </div>
        <div className="grid gap-3 px-3 py-3 sm:grid-cols-2">
          <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="objective-name">
            <span>Name</span>
            <input
              id="objective-name"
              value={name}
              disabled={archived || create.isPending}
              placeholder="user flag"
              maxLength={120}
              className="w-full border border-input bg-transparent px-2.5 py-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="objective-kind">
            <span>Kind</span>
            <select
              id="objective-kind"
              value={kind}
              disabled={archived || create.isPending}
              className="w-full border border-input bg-transparent px-2.5 py-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => setKind(event.target.value as ObjectiveKind)}
            >
              {OBJECTIVE_KINDS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex justify-end px-3 pb-3">
          <Button
            type="button"
            disabled={!canSubmit}
            onClick={() => {
              setFormError(undefined);
              create.mutate(
                { name: name.trim(), kind },
                { onSuccess: () => setName("") },
              );
            }}
          >
            {create.isPending ? "Saving" : "Create objective"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function EngagementSecretsSection({
  archived,
  engagementId,
}: {
  archived: boolean;
  engagementId: string;
}) {
  const secrets = useSecretsQuery(engagementId);
  const retry = () => void secrets.refetch();
  const hasData = secrets.data !== undefined;

  return (
    <section aria-label="Secrets" className="mt-5 border-t border-border pt-4">
      <header className="mb-3">
        <h2 className="m-0 text-[13px] font-semibold">Secrets</h2>
        <p className="mt-1 mb-0 text-[12px] leading-5 text-muted-foreground">
          Explicit sensitive records, one service each. {SECRET_STORAGE_COPY} Secrets stay out of
          search, AI context, logs, reports, screenshots, and command previews. Details reveal per
          item only.
        </p>
      </header>
      {!hasData && secrets.isFetching ? (
        <LoadingRegion label="Loading secrets" className="space-y-3">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-14 w-full" />
        </LoadingRegion>
      ) : null}
      {!hasData && secrets.isError ? (
        <RecoverableError
          title="Secrets unavailable"
          description="The secrets could not be loaded from the local control plane."
          onRetry={retry}
        />
      ) : null}
      {hasData && secrets.isError ? (
        <StaleDataState
          title="Showing the last successful secrets"
          description="The latest refresh failed. Existing secrets are still available."
          onRetry={retry}
        >
          <SecretsBody archived={archived} engagementId={engagementId} records={secrets.data ?? []} />
        </StaleDataState>
      ) : null}
      {hasData && !secrets.isError ? (
        <SecretsBody archived={archived} engagementId={engagementId} records={secrets.data ?? []} />
      ) : null}
    </section>
  );
}

function SecretsBody({
  archived,
  engagementId,
  records,
}: {
  archived: boolean;
  engagementId: string;
  records: Secret[];
}) {
  const create = useCreateSecretMutation(engagementId);
  const verify = useRecordVerificationMutation(engagementId);
  const [label, setLabel] = useState("");
  const [username, setUsername] = useState("");
  const [serviceRef, setServiceRef] = useState("");
  const [secretRef, setSecretRef] = useState("");
  const [hint, setHint] = useState("");
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [methods, setMethods] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState<string | null>(null);

  const mutationError =
    create.isError || verify.isError
      ? mutationMessage(create.error ?? verify.error, "The secrets request failed.")
      : formError;

  const canSubmit =
    !archived && !create.isPending && label.trim().length > 0 && serviceRef.trim().length > 0 && secretRef.trim().length > 0;

  const copyReference = (secretId: string, value: string) => {
    if (navigator.clipboard === undefined) {
      setFormError("Clipboard copy is unavailable here. Read the reference from the revealed details.");
      return;
    }
    void navigator.clipboard
      .writeText(value)
      .then(() => setCopied(secretId))
      .catch(() => setFormError("Clipboard copy failed."));
  };

  return (
    <div className="grid gap-4">
      <div>
        {records.length === 0 ? (
          <div className="border border-border px-4 py-8 text-center">
            <h3 className="m-0 text-[13px] font-semibold">No secrets yet</h3>
            <p className="mx-auto mt-2 mb-0 max-w-md text-[13px] leading-5 text-muted-foreground">
              Record the first credential as a reference. Plaintext values are never stored.
            </p>
          </div>
        ) : (
          <ul className="m-0 grid list-none gap-2 p-0">
            {records.map((secret) => {
              const isRevealed = revealed[secret.id] === true;
              return (
                <li key={secret.id} className="border border-border px-3 py-2.5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="m-0 truncate text-[13px] font-semibold" title={secret.label}>
                        {secret.label}
                      </p>
                      <p className="m-0 mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                        <span className="font-mono">{secret.serviceRef}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono">[masked]</span>
                        <span aria-hidden="true">·</span>
                        <span>{secret.verifications.length} verifications</span>
                      </p>
                      {isRevealed ? (
                        <div className="mt-2 grid gap-1 text-[12px] leading-5 text-muted-foreground">
                          {secret.username !== null ? <p className="m-0 font-mono">user {secret.username}</p> : null}
                          <p className="m-0 font-mono">ref {secret.secretRef}</p>
                          {secret.hint !== null ? <p className="m-0">Hint: {secret.hint}</p> : null}
                          {secret.verifications.length > 0 ? (
                            <ul className="m-0 grid list-none gap-1 p-0">
                              {secret.verifications.map((verification, index) => (
                                <li key={`${verification.at}-${index}`} className="font-mono text-[11px]">
                                  {verification.result} by {verification.method} at{" "}
                                  {formatEngagementTimestamp(verification.at)}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="m-0">No verifications recorded for this service.</p>
                          )}
                          {!archived ? (
                            <div className="flex flex-wrap items-center gap-2">
                              <label className="grid min-w-0 flex-1 gap-1 text-[11px]" htmlFor={`verify-method-${secret.id}`}>
                                <span>Verification method</span>
                                <input
                                  id={`verify-method-${secret.id}`}
                                  value={methods[secret.id] ?? ""}
                                  disabled={verify.isPending}
                                  placeholder="ssh login"
                                  maxLength={120}
                                  className="w-full border border-input bg-transparent px-2.5 py-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                  onChange={(event) =>
                                    setMethods((current) => ({ ...current, [secret.id]: event.target.value }))
                                  }
                                />
                              </label>
                              <Button
                                type="button"
                                variant="secondary"
                                disabled={verify.isPending || (methods[secret.id] ?? "").trim().length === 0}
                                onClick={() => {
                                  const method = (methods[secret.id] ?? "").trim();
                                  if (method.length === 0) {
                                    setFormError("Enter how the secret was checked.");
                                    return;
                                  }
                                  verify.mutate({ secretId: secret.id, result: "verified", method });
                                }}
                              >
                                Mark verified
                              </Button>
                              <Button
                                type="button"
                                disabled={archived}
                                onClick={() => copyReference(secret.id, secret.secretRef)}
                              >
                                {copied === secret.id ? "Copied" : "Copy reference"}
                              </Button>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() =>
                        setRevealed((current) => ({ ...current, [secret.id]: !isRevealed }))
                      }
                    >
                      {isRevealed ? "Hide" : "Reveal"}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {mutationError ? (
          <p className="mt-2 mb-0 text-[13px] text-destructive" role="alert">
            {mutationError}
          </p>
        ) : null}
      </div>

      <div className="border border-border">
        <div className="border-b border-border px-3 py-2">
          <h3 className="m-0 text-[13px] font-semibold">New secret</h3>
        </div>
        <div className="grid gap-3 px-3 py-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="secret-label">
              <span>Label</span>
              <input
                id="secret-label"
                value={label}
                disabled={archived || create.isPending}
                placeholder="SSH password for app host"
                maxLength={120}
                className="w-full border border-input bg-transparent px-2.5 py-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
            <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="secret-username">
              <span>Username, optional</span>
              <input
                id="secret-username"
                value={username}
                disabled={archived || create.isPending}
                placeholder="operator"
                spellCheck={false}
                className="w-full border border-input bg-transparent px-2.5 py-2 font-mono text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="secret-service">
              <span>Service, exactly one</span>
              <input
                id="secret-service"
                value={serviceRef}
                disabled={archived || create.isPending}
                placeholder="192.0.2.10:22/ssh"
                spellCheck={false}
                className="w-full border border-input bg-transparent px-2.5 py-2 font-mono text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) => setServiceRef(event.target.value)}
              />
            </label>
            <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="secret-ref">
              <span>Secret reference, never a value</span>
              <input
                id="secret-ref"
                value={secretRef}
                disabled={archived || create.isPending}
                placeholder="vault:stone/lab-app-ssh"
                spellCheck={false}
                className="w-full border border-input bg-transparent px-2.5 py-2 font-mono text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) => setSecretRef(event.target.value)}
              />
            </label>
          </div>
          <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="secret-hint">
            <span>Masked hint, optional</span>
            <input
              id="secret-hint"
              value={hint}
              disabled={archived || create.isPending}
              placeholder="12 chars"
              maxLength={64}
              className="w-full border border-input bg-transparent px-2.5 py-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => setHint(event.target.value)}
            />
          </label>
          <div className="flex justify-end">
            <Button
              type="button"
              disabled={!canSubmit}
              onClick={() => {
                setFormError(undefined);
                create.mutate(
                  {
                    label: label.trim(),
                    ...(username.trim().length === 0 ? {} : { username: username.trim() }),
                    serviceRef: serviceRef.trim(),
                    secretRef: secretRef.trim(),
                    ...(hint.trim().length === 0 ? {} : { hint: hint.trim() }),
                  },
                  {
                    onSuccess: () => {
                      setLabel("");
                      setUsername("");
                      setServiceRef("");
                      setSecretRef("");
                      setHint("");
                    },
                  },
                );
              }}
            >
              {create.isPending ? "Saving" : "Create secret"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
