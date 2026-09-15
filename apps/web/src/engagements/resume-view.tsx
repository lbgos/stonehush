import type { EngagementResumeResponse } from "@stonehush/contracts";
import { Button, LoadingRegion, RecoverableError, Skeleton } from "@stonehush/ui";
import { useState } from "react";

import { useEngagementResumeQuery, useSaveNextStepMutation } from "./resume-query.js";

/**
 * STONE-6 standalone resume view. Ships as a new file and mounts via the
 * STONE-2 `engagement.resume` extension slot after STONE-2 merges; it is
 * not wired into workspace.tsx in this slice. Shows the saved next step
 * (optional, never blocking), the inspected context, and the factual
 * change list with snapshot labels. No fabricated timelines.
 */

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
              <p className="m-0 text-[11px] leading-5 text-muted-foreground">Showing the 200 most recent changes.</p>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Next-step editor. Keyed by engagement so an unsaved draft never leaks
 * into another engagement when the host switches without remounting.
 */
export function NextStepEditor({
  engagementId,
  archived,
  nextStep,
  revision,
}: {
  engagementId: string;
  archived: boolean;
  nextStep: string | null;
  revision: number;
}) {
  const save = useSaveNextStepMutation(engagementId);
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const value = draft ?? nextStep ?? "";

  return (
    <div className="grid gap-1">
      <label htmlFor="engagement-next-step" className="text-[12px] font-medium text-foreground">
        Next step, optional
      </label>
      <div className="flex gap-2">
        <input
          id="engagement-next-step"
          type="text"
          value={value}
          maxLength={280}
          disabled={archived || save.isPending}
          placeholder="One sentence, e.g. probe port 8080 next."
          onChange={(event) => {
            setDraft(event.target.value);
            if (save.isError) save.reset();
          }}
          className="h-9 min-w-0 flex-1 rounded-[10px] border border-border bg-background px-2 text-[12px] text-foreground"
        />
        <Button
          type="button"
          disabled={archived || save.isPending || value.trim().length === 0}
          onClick={() =>
            save.mutate(
              { nextStep: value.trim(), expectedRevision: revision },
              { onSuccess: () => setDraft(undefined) },
            )
          }
        >
          Save
        </Button>
        {nextStep !== null ? (
          <Button
            type="button"
            variant="quiet"
            disabled={archived || save.isPending}
            onClick={() => {
              save.mutate(
                { nextStep: null, expectedRevision: revision },
                { onSuccess: () => setDraft(undefined) },
              );
            }}
          >
            Clear
          </Button>
        ) : null}
      </div>
      {save.isError ? (
        <p className="m-0 text-[12px] leading-5 text-destructive">The next step was not saved. Try again.</p>
      ) : null}
    </div>
  );
}
