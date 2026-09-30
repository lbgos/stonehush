import { EngagementNextStepSchema, type EngagementResumeResponse } from "@stonehush/contracts";
import { Button } from "@stonehush/ui";
import { useEffect, useId, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { EngagementDeadlineSection } from "./deadline.js";
import { formatEngagementTimestamp } from "./format.js";
import { engagementResumeQueryKey, EngagementNextStepMutationError, fetchEngagementResume, useEngagementResumeQuery, useSaveNextStepMutation } from "./resume-query.js";

// Resume band at the top of Surface: the saved next step and the deadline on
// the left, the factual change list on the right. It is flat and scrolls
// away with the page so it never competes with the inspector or the console.
// Every state keeps the same two rows and list header, so loading, failure,
// and archived views do not shift the results below.

const RECENT_LIMIT = 8;
// Shared with the deadline row so both labels sit in one column.
const FIELD_ROW = "grid min-w-0 grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-x-3";
const FIELD_LABEL = "pt-1.5 text-[12px] leading-5 font-medium text-foreground";

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

function RecentChangesHeader({ children }: { children?: ReactNode }) {
  return (
    <div className="flex min-h-7 flex-wrap items-center gap-x-3">
      <h2 className="m-0 text-[12px] leading-5 font-medium text-foreground">Recent changes</h2>
      {children}
    </div>
  );
}

/**
 * Newest changes first, eight by default. The toggle sits above the list so
 * collapsing a long list keeps it, and its focus, in place. Run ids are the
 * run store ids the Runs tab selects by, so run rows open that run; other
 * kinds have no exact destination and stay plain.
 */
export function ResumeChangeList({
  resume,
  onOpenRun,
  status,
}: {
  resume: EngagementResumeResponse;
  onOpenRun?: ((runId: string) => void) | undefined;
  status?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const total = resume.changes.length;
  const collapsible = total > RECENT_LIMIT;
  const visible = expanded || !collapsible ? resume.changes : resume.changes.slice(0, RECENT_LIMIT);

  return (
    <div className="min-w-0">
      <RecentChangesHeader>
        {total > 0 ? (
          <span className="font-mono text-[11px] text-muted-foreground">
            {collapsible && !expanded ? `${RECENT_LIMIT} of ${total}` : total}
          </span>
        ) : null}
        {collapsible ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={() => setExpanded((open) => !open)}
            className="inline-flex min-h-7 items-center rounded-md px-1.5 text-[12px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {expanded ? `Show newest ${RECENT_LIMIT}` : `Show all ${total}`}
          </button>
        ) : null}
        {status}
      </RecentChangesHeader>
      {total === 0 ? (
        <p className="m-0 text-[12px] leading-5 text-muted-foreground">No changes recorded.</p>
      ) : (
        <ol id={listId} className="m-0 list-none p-0">
          {visible.map((change) => (
            <li
              key={`${change.kind}:${change.id}`}
              className="grid min-w-0 grid-cols-[3.5rem_minmax(0,1fr)_auto] items-baseline gap-x-3 text-[12px] leading-[22px]"
            >
              <span className="text-muted-foreground">{changeKindLabel(change.kind)}</span>
              {change.kind === "run" && onOpenRun !== undefined ? (
                <button
                  type="button"
                  title={change.summary}
                  onClick={() => onOpenRun(change.id)}
                  className="min-w-0 truncate rounded-sm text-left text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {change.summary}
                </button>
              ) : (
                <span className="min-w-0 truncate text-foreground" title={change.summary}>
                  {change.summary}
                </span>
              )}
              <span className="flex shrink-0 items-baseline gap-2 font-mono text-[11px] text-muted-foreground">
                {change.snapshot ? <span title="Point-in-time observation">snapshot</span> : null}
                <time dateTime={change.at}>{formatEngagementTimestamp(change.at)}</time>
              </span>
            </li>
          ))}
        </ol>
      )}
      {resume.complete === false && visible.length === total ? (
        <p className="m-0 text-[11px] leading-5 text-muted-foreground">Older changes are not listed.</p>
      ) : null}
    </div>
  );
}

export function EngagementResumeView({
  engagementId,
  archived,
  onOpenRun,
}: {
  engagementId: string;
  archived: boolean;
  onOpenRun?: ((runId: string) => void) | undefined;
}) {
  const resume = useEngagementResumeQuery(engagementId);
  const data = resume.data;
  const retry = () => void resume.refetch();
  const retryButton = (
    <button
      type="button"
      onClick={retry}
      disabled={resume.isFetching}
      className="inline-flex min-h-7 items-center rounded-md px-1.5 text-[12px] font-medium text-foreground underline underline-offset-2 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
    >
      Retry
    </button>
  );

  return (
    <section
      aria-label="Resume"
      className="grid min-w-0 gap-x-8 gap-y-3 border-b border-border pb-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]"
    >
      <div className="grid min-w-0 content-start gap-2">
        {data !== undefined ? (
          <NextStepEditor
            engagementId={engagementId}
            archived={archived}
            nextStep={data.nextStep}
            revision={data.nextStepRevision}
            updatedAt={data.nextStepUpdatedAt}
          />
        ) : (
          <div className={FIELD_ROW}>
            <span className={FIELD_LABEL}>Next step</span>
            {resume.isError ? (
              <p className="m-0 flex min-h-8 flex-wrap items-center gap-x-2 text-[12px] text-muted-foreground" role="alert">
                Resume unavailable. {retryButton}
              </p>
            ) : (
              <p className="m-0 flex min-h-8 items-center text-[12px] text-muted-foreground" role="status">
                Loading
              </p>
            )}
          </div>
        )}
        <EngagementDeadlineSection archived={archived} engagementId={engagementId} />
        {archived ? (
          <p className="m-0 text-[12px] leading-5 text-muted-foreground">Archived, read only.</p>
        ) : null}
      </div>
      <div className="min-w-0 xl:border-l xl:border-border xl:pl-8">
        {data !== undefined ? (
          <ResumeChangeList
            key={engagementId}
            resume={data}
            onOpenRun={onOpenRun}
            status={
              resume.isError ? (
                <span className="flex items-center gap-x-1 text-[12px] text-warning" role="status">
                  Refresh failed. {retryButton}
                </span>
              ) : null
            }
          />
        ) : (
          <>
            <RecentChangesHeader />
            <p className="m-0 text-[12px] leading-5 text-muted-foreground">
              {resume.isError ? "Not loaded." : "Loading"}
            </p>
          </>
        )}
      </div>
    </section>
  );
}

type NextStepEditorProps = {
  engagementId: string;
  archived: boolean;
  nextStep: string | null;
  revision: number;
  updatedAt?: string | null | undefined;
};

/** Remount even when a host forgets to key the editor by engagement. */
export function NextStepEditor(props: NextStepEditorProps) {
  return <NextStepEditorState key={props.engagementId} {...props} />;
}

function NextStepEditorState({ engagementId, archived, nextStep, revision, updatedAt }: NextStepEditorProps) {
  const save = useSaveNextStepMutation(engagementId);
  const queryClient = useQueryClient();
  const inputId = useId();
  const [draft, setDraft] = useState<{ value: string; baseRevision: number }>();
  const [confirmedRevision, setConfirmedRevision] = useState<number>();
  const [conflict, setConflict] = useState<{ saved?: EngagementResumeResponse; loading: boolean; failed: boolean }>();
  const [error, setError] = useState<EngagementNextStepMutationError>();
  const value = draft?.value ?? nextStep ?? "";
  const valid = EngagementNextStepSchema.safeParse(value.trim()).success;
  const waitingForSaved = confirmedRevision !== undefined && revision < confirmedRevision;
  const readOnly = archived || error?.detail?.code === "engagement_archived";
  const disabled = readOnly || save.isPending || waitingForSaved;
  const saveDisabled = disabled || !valid || conflict !== undefined;

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

  // An archived engagement with nothing typed reads as text, not a dead input.
  if (archived && draft === undefined) {
    return (
      <div className={FIELD_ROW}>
        <span className={FIELD_LABEL}>Next step</span>
        <p className={`m-0 py-1.5 text-[13px] leading-5 break-words ${nextStep === null ? "text-muted-foreground" : "text-foreground"}`}>
          {nextStep ?? "None saved."}
        </p>
      </div>
    );
  }

  const unsaved = draft !== undefined && draft.value !== (nextStep ?? "") && !save.isPending && !waitingForSaved && conflict === undefined;
  let meta: ReactNode = null;
  if (save.isPending || waitingForSaved) meta = "Saving";
  else if (unsaved) meta = "Not saved";
  else if (nextStep !== null && updatedAt) {
    meta = <>Saved <time dateTime={updatedAt}>{formatEngagementTimestamp(updatedAt)}</time></>;
  }

  return (
    <div className={FIELD_ROW}>
      <label htmlFor={inputId} className={FIELD_LABEL}>Next step</label>
      <div className="grid min-w-0 gap-1">
        <form
          className="flex min-w-0 flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!saveDisabled) submit(value.trim(), draft?.baseRevision ?? revision);
          }}
        >
          <input
            id={inputId}
            type="text"
            value={value}
            disabled={disabled}
            autoComplete="off"
            placeholder="One line, e.g. probe port 8080 next"
            onChange={(event) => {
              setDraft({ value: event.target.value, baseRevision: draft?.baseRevision ?? revision });
            }}
            className="h-11 min-w-[12rem] flex-1 rounded-md md:h-8 border border-input bg-transparent px-2.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          />
          <Button type="submit" disabled={saveDisabled}>Save</Button>
          {nextStep !== null || draft !== undefined ? (
            <Button type="button" variant="quiet" disabled={disabled || conflict !== undefined}
              onClick={() => submit(null, draft?.baseRevision ?? revision)}>Clear</Button>
          ) : null}
        </form>
        {meta !== null ? (
          <p className="m-0 font-mono text-[11px] leading-4 text-muted-foreground">{meta}</p>
        ) : null}
        {draft !== undefined && value.length > 0 && !valid ? (
          <p className="m-0 text-[12px] leading-5 text-destructive" role="alert">Use one line with 1 to 280 characters.</p>
        ) : null}
        {error ? (
          <p
            className={`m-0 text-[12px] leading-5 ${error.detail?.code === "revision_conflict" ? "text-warning" : "text-destructive"}`}
            role="alert"
          >
            {error.message}
          </p>
        ) : null}
        {conflict ? (
          <div role="group" aria-label="Next step conflict" className="grid gap-1.5 border-l-2 border-warning/60 py-0.5 pl-3">
            {conflict.loading ? <p className="m-0 text-[12px] leading-5 text-muted-foreground" role="status">Loading saved next step.</p> : null}
            {conflict.failed ? (
              <div>
                <Button type="button" variant="secondary" onClick={() => void loadConflict()}>Retry saved next step</Button>
              </div>
            ) : null}
            {conflict.saved ? (
              <>
                <dl className="m-0 grid grid-cols-[3rem_minmax(0,1fr)] gap-x-3 text-[12px] leading-5">
                  <dt className="text-muted-foreground">Saved</dt>
                  <dd className="m-0 min-w-0 break-words text-foreground">
                    {conflict.saved.nextStep ?? <span className="text-muted-foreground">Cleared</span>}
                    {conflict.saved.nextStepUpdatedAt ? (
                      <time dateTime={conflict.saved.nextStepUpdatedAt} className="ml-2 font-mono text-[11px] text-muted-foreground">
                        {formatEngagementTimestamp(conflict.saved.nextStepUpdatedAt)}
                      </time>
                    ) : null}
                  </dd>
                  <dt className="text-muted-foreground">Yours</dt>
                  <dd className="m-0 min-w-0 break-words text-foreground">
                    {value || <span className="text-muted-foreground">Cleared</span>}
                  </dd>
                </dl>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="secondary" disabled={disabled || (value !== "" && !valid)}
                    onClick={() => {
                      if (conflict.saved) submit(value === "" ? null : value.trim(), conflict.saved.nextStepRevision);
                    }}>Keep yours</Button>
                  <Button type="button" variant="quiet" disabled={disabled} onClick={() => {
                    if (!conflict.saved) return;
                    // Keep this exact fresh value until the host query catches up.
                    setDraft({ value: conflict.saved.nextStep ?? "", baseRevision: conflict.saved.nextStepRevision });
                    setConfirmedRevision(conflict.saved.nextStepRevision);
                    setConflict(undefined);
                    setError(undefined);
                  }}>Use saved</Button>
                </div>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
