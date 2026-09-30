import { EngagementNextStepSchema, type EngagementResumeResponse } from "@stonehush/contracts";
import { Button, LoadingRegion, RecoverableError, Skeleton } from "@stonehush/ui";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { engagementResumeQueryKey, EngagementNextStepMutationError, fetchEngagementResume, useEngagementResumeQuery, useSaveNextStepMutation } from "./resume-query.js";

function changeKindLabel(kind: string): string {
  switch (kind) {
    case "note":
      return "Note";
    case "finding":
      return "Finding";
    case "run":
      return "Run";
    case "service":
      return "Service";
    case "scope":
      return "Scope";
    case "ffuf":
      return "ffuf";
    case "probe":
      return "Probe";
    case "artifact":
      return "Evidence";
    default:
      return kind;
  }
}

export function ResumeChangeList({ resume }: { resume: EngagementResumeResponse }) {
  if (resume.changes.length === 0) {
    return <p className="m-0 text-[12px] leading-5 text-muted-foreground">No changes recorded yet.</p>;
  }
  return (
    <ul className="m-0 list-none space-y-1 p-0">
      {resume.changes.map((change) => (
        <li key={`${change.kind}:${change.id}`} className="flex items-baseline gap-2 text-[12px] leading-5">
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{changeKindLabel(change.kind)}</span>
          <span className="min-w-0 flex-1 truncate text-foreground">{change.summary}</span>
          {change.snapshot ? (
            <span className="shrink-0 text-[11px] text-muted-foreground">snapshot</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function EngagementResumeView({
  engagementId,
  archived,
}: {
  engagementId: string;
  archived: boolean;
}) {
  const resume = useEngagementResumeQuery(engagementId);
  const data = resume.data;

  return (
    <section aria-label="Resume" className="overflow-hidden rounded-[10px] border border-border bg-card">
      <div className="flex min-h-10 items-center justify-between border-b border-border px-3">
        <h2 className="m-0 text-[13px] font-semibold">Resume</h2>
        <span className="hidden text-[11px] text-muted-foreground sm:inline">Next step and recent changes</span>
      </div>
      <div className="grid gap-3 p-3">
        {resume.isFetching && data === undefined ? (
          <LoadingRegion label="Loading resume" className="space-y-2">
            <Skeleton className="h-8 w-full" />
          </LoadingRegion>
        ) : null}
        {resume.isError ? <RecoverableError title="Resume is unavailable." description="The resume request failed." onRetry={() => void resume.refetch()} /> : null}
        {data !== undefined ? (
          <>
            <NextStepEditor
              key={engagementId}
              engagementId={engagementId}
              archived={archived}
              nextStep={data.nextStep}
              revision={data.nextStepRevision}
            />
            <ResumeChangeList resume={data} />
            {data.complete === false ? (
              <p className="m-0 text-[11px] leading-5 text-muted-foreground">Older changes not listed.</p>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

type NextStepEditorProps = {
  engagementId: string;
  archived: boolean;
  nextStep: string | null;
  revision: number;
};

/** Remount even when a host forgets to key the editor by engagement. */
export function NextStepEditor(props: NextStepEditorProps) {
  return <NextStepEditorState key={props.engagementId} {...props} />;
}

function NextStepEditorState({ engagementId, archived, nextStep, revision }: NextStepEditorProps) {
  const save = useSaveNextStepMutation(engagementId);
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<{ value: string; baseRevision: number }>();
  const [confirmedRevision, setConfirmedRevision] = useState<number>();
  const [conflict, setConflict] = useState<{ saved?: EngagementResumeResponse; loading: boolean; failed: boolean }>();
  const [error, setError] = useState<EngagementNextStepMutationError>();
  const value = draft?.value ?? nextStep ?? "";
  const valid = EngagementNextStepSchema.safeParse(value.trim()).success;
  const waitingForSaved = confirmedRevision !== undefined && revision < confirmedRevision;
  const readOnly = archived || error?.detail?.code === "engagement_archived";
  const disabled = readOnly || save.isPending || waitingForSaved;

  useEffect(() => {
    if (confirmedRevision !== undefined && revision >= confirmedRevision) {
      setDraft(undefined);
      setConfirmedRevision(undefined);
    }
  }, [confirmedRevision, revision]);

  async function loadConflict() {
    setConflict({ loading: true, failed: false });
    try {
      const saved = await fetchEngagementResume(engagementId);
      queryClient.setQueryData(engagementResumeQueryKey(engagementId), saved);
      setConflict({ saved, loading: false, failed: false });
    } catch {
      setConflict({ loading: false, failed: true });
    }
  }

  function submit(next: string | null, expectedRevision: number) {
    setDraft({ value: next === null ? "" : value, baseRevision: expectedRevision });
    setError(undefined);
    // A new race needs a new response before the operator can overwrite it.
    setConflict(undefined);
    save.mutate({ nextStep: next, expectedRevision }, {
      onSuccess: (result) => {
        setDraft({ value: next ?? "", baseRevision: result.revision });
        setConfirmedRevision(result.revision);
      },
      onError: (failure) => {
        const typed = failure instanceof EngagementNextStepMutationError
          ? failure : new EngagementNextStepMutationError();
        setError(typed);
        if (typed.detail?.code === "revision_conflict") void loadConflict();
      },
    });
  }

  return (
    <div className="grid gap-1">
      <label htmlFor="engagement-next-step" className="text-[12px] font-medium text-foreground">Next step, optional</label>
      <div className="flex gap-2">
        <input
          id="engagement-next-step"
          type="text"
          value={value}
          disabled={disabled}
          placeholder="One sentence, e.g. probe port 8080 next."
          onChange={(event) => {
            setDraft({ value: event.target.value, baseRevision: draft?.baseRevision ?? revision });
          }}
          className="h-9 min-w-0 flex-1 rounded-[10px] border border-border bg-background px-2 text-[12px] text-foreground"
        />
        <Button type="button" disabled={disabled || !valid || conflict !== undefined}
          onClick={() => submit(value.trim(), draft?.baseRevision ?? revision)}>Save</Button>
        {nextStep !== null || draft !== undefined ? (
          <Button type="button" variant="quiet" disabled={disabled || conflict !== undefined}
            onClick={() => submit(null, draft?.baseRevision ?? revision)}>Clear</Button>
        ) : null}
      </div>
      {readOnly ? <p>Archived, read only.</p> : null}
      {draft !== undefined && value.length > 0 && !valid ? <p role="alert">Use one line with 1 to 280 characters.</p> : null}
      {error ? <p role="alert">{error.message}</p> : null}
      {conflict ? (
        <div>
          {conflict.loading ? <p>Loading saved next step.</p> : null}
          {conflict.failed ? <Button type="button" onClick={() => void loadConflict()}>Retry saved next step</Button> : null}
          {conflict.saved ? <>
            <p>Saved: {conflict.saved.nextStep ?? "cleared"}</p>
            <p>Yours: {value || "cleared"}</p>
            <Button type="button" disabled={disabled || (value !== "" && !valid)}
              onClick={() => {
                if (conflict.saved) submit(value === "" ? null : value.trim(), conflict.saved.nextStepRevision);
              }}>Save mine</Button>
            <Button type="button" disabled={disabled} onClick={() => {
              if (!conflict.saved) return;
              // Keep this exact fresh value until the host query catches up.
              setDraft({ value: conflict.saved.nextStep ?? "", baseRevision: conflict.saved.nextStepRevision });
              setConfirmedRevision(conflict.saved.nextStepRevision);
              setConflict(undefined);
              setError(undefined);
            }}>Use saved</Button>
          </> : null}
        </div>
      ) : null}
    </div>
  );
}
