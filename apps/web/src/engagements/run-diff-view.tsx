import { describePriorAttempt, diffRuns, type PriorAttemptInput, type RunDiffInput } from "@stonehush/domain";
import { useMemo } from "react";

/**
 * STONE-6 standalone run-diff view. Mounts via the STONE-2
 * `discovery.diff` slot after STONE-2 merges. Highlights new/changed
 * services, responses, and paths plus ports/options/auth/binding context.
 * Unscanned is never reported as closed; incomplete never disproves.
 * Bounded next steps carry a visible rationale and never auto-expand.
 */

export function RunDiffView({
  input,
  priorAttempt,
  nextSteps = [],
}: {
  input: RunDiffInput;
  priorAttempt?: PriorAttemptInput;
  nextSteps?: readonly { readonly label: string; readonly rationale: string }[];
}) {
  const diff = useMemo(() => diffRuns(input), [input]);
  return (
    <section aria-label="Run diff" className="overflow-hidden rounded-[10px] border border-border bg-card">
      <div className="flex min-h-10 items-center justify-between border-b border-border px-3">
        <h2 className="m-0 text-[13px] font-semibold">What changed</h2>
        <span className="hidden text-[11px] text-muted-foreground sm:inline">
          {diff.comparable ? "Compatible prior run" : "Not directly comparable"}
        </span>
      </div>
      <div className="grid gap-2 p-3 text-[12px] leading-5">
        {priorAttempt !== undefined ? (
          <p className="m-0 text-muted-foreground">{describePriorAttempt(priorAttempt)}</p>
        ) : null}
        {diff.contextNotes.map((note) => (
          <p key={note} className="m-0 text-muted-foreground">
            {note}
          </p>
        ))}
        {diff.newServices.map((line) => (
          <p key={line} className="m-0 text-foreground">
            {line}
          </p>
        ))}
        {diff.changedServices.map((line) => (
          <p key={line} className="m-0 text-foreground">
            {line}
          </p>
        ))}
        {diff.removedFromView.map((line) => (
          <p key={line} className="m-0 text-muted-foreground">
            {line}
          </p>
        ))}
        {diff.newResponses.map((line) => (
          <p key={line} className="m-0 text-foreground">
            {line}
          </p>
        ))}
        {diff.changedResponses.map((line) => (
          <p key={line} className="m-0 text-foreground">
            {line}
          </p>
        ))}
        {diff.newPaths.map((line) => (
          <p key={line} className="m-0 text-foreground">
            {line}
          </p>
        ))}
        {diff.changedPaths.map((line) => (
          <p key={line} className="m-0 text-foreground">
            {line}
          </p>
        ))}
        {diff.caveats.map((line) => (
          <p key={line} className="m-0 text-[11px] text-muted-foreground">
            {line}
          </p>
        ))}
        {nextSteps.length > 0 ? (
          <div className="grid gap-1 border-t border-border pt-2">
            <h3 className="m-0 text-[12px] font-semibold text-foreground">Bounded next steps</h3>
            <ul className="m-0 list-none space-y-1 p-0">
              {nextSteps.map((step) => (
                <li key={step.label} className="text-muted-foreground">
                  <span className="text-foreground">{step.label}</span> ({step.rationale})
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}
