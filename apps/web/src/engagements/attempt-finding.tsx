import { useId, useState } from "react";

import { Button } from "@stonehush/ui";

import type { OpeningFindingsRead } from "./findings-query.js";

// The optional saved finding a new lead attempt names, and how a saved
// attempt shows the finding it named. The attempt stores only the id the
// operator chose. The server does not check it, so the detail resolves it
// against its own fresh read of this engagement's findings and shows that
// finding's current saved title, status and body, never a snapshot.

export type FindingLinkProblem = "checking" | "failed" | "missing";

// A chosen id may be sent only when this opening's latest read succeeded and
// still lists it. No id needs no read.
export function findingLinkProblem(read: OpeningFindingsRead, findingId: string): FindingLinkProblem | undefined {
  if (findingId === "") return undefined;
  if (read.state === "loading" || (read.state === "ready" && read.checking)) return "checking";
  if (read.state === "failed" || read.stale) return "failed";
  return read.findings.some((finding) => finding.id === findingId) ? undefined : "missing";
}

function idSuffix(id: string): string {
  return id.slice(-8);
}

export function AttemptFindingChooser({
  id,
  read,
  value,
  disabled,
  onChange,
  onRetry,
}: {
  id: string;
  read: OpeningFindingsRead;
  value: string;
  disabled: boolean;
  onChange: (findingId: string) => void;
  onRetry: () => void;
}) {
  const findings = read.state === "ready" ? read.findings : [];
  const problem = findingLinkProblem(read, value);
  const titles = new Map<string, number>();
  for (const finding of findings) titles.set(finding.title, (titles.get(finding.title) ?? 0) + 1);
  const listed = findings.some((finding) => finding.id === value);

  // A short suffix normally distinguishes duplicate titles. Keep the full
  // id when two records also share that suffix.
  const choiceId = (finding: (typeof findings)[number]) =>
    findings.some((other) => other.id !== finding.id && other.title === finding.title && idSuffix(other.id) === idSuffix(finding.id))
      ? finding.id
      : idSuffix(finding.id);

  const retry = (
    <Button type="button" variant="secondary" className="min-h-11 md:min-h-11" disabled={read.state === "loading" || (read.state === "ready" && read.checking)} onClick={onRetry}>
      Retry findings
    </Button>
  );
  let status: { text: string; retry: boolean; none: boolean } | undefined;
  if (problem === "failed" || problem === "missing") {
    status = {
      text:
        problem === "missing"
          ? `Finding ${idSuffix(value)} is not in this engagement's current findings. Retry, or choose None to record without a link.`
          : `Finding ${idSuffix(value)} could not be checked. Retry, or choose None to record without a link.`,
      retry: true,
      none: true,
    };
  } else if (read.state === "loading" || (read.state === "ready" && read.checking)) {
    status = { text: "Loading findings", retry: false, none: false };
  } else if (read.state === "failed") {
    status = { text: "Findings could not be read. Attempts without a finding can still be recorded.", retry: true, none: false };
  } else if (read.stale) {
    status = { text: "Findings refresh failed. Showing the list as last read.", retry: true, none: false };
  } else if (findings.length === 0) {
    status = { text: "No saved findings in this engagement.", retry: false, none: false };
  }

  return (
    <div className="grid gap-1">
      <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={id}>
        <span>Finding, optional</span>
        <select
          id={id}
          value={value}
          disabled={disabled || (value === "" && findings.length === 0)}
          className="min-h-11 w-full border border-input bg-transparent px-2.5 py-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">None</option>
          {findings.map((finding) => (
            <option key={finding.id} value={finding.id}>
              {finding.title} · {finding.status}
              {(titles.get(finding.title) ?? 0) > 1 ? ` · ${choiceId(finding)}` : ""}
            </option>
          ))}
          {value !== "" && !listed ? <option value={value}>Finding {idSuffix(value)}, not checked</option> : null}
        </select>
      </label>
      {status !== undefined ? (
        <div className="flex flex-wrap items-center justify-between gap-2" role="status">
          <p className="m-0 min-w-0 flex-1 text-[11px] leading-5 text-muted-foreground">{status.text}</p>
          {status.retry || status.none ? (
            <div className="flex flex-wrap gap-2">
              {status.retry ? retry : null}
              {status.none ? (
                <Button type="button" variant="secondary" className="min-h-11 md:min-h-11" disabled={disabled} onClick={() => onChange("")}>
                  Choose None
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// One saved attempt's finding reference. A failed read says so and offers
// Retry; a successful read without this exact id says unavailable. Neither
// substitutes another finding. The body is the finding's current saved text,
// rendered as plain text.
export function LinkedFinding({
  findingId,
  read,
  onRetry,
}: {
  findingId: string;
  read: OpeningFindingsRead;
  onRetry: () => void;
}) {
  const bodyId = useId();
  const [open, setOpen] = useState(false);
  const reference = (
    <span className="font-mono" title={findingId}>
      {idSuffix(findingId)}
    </span>
  );
  const retry = (
    <Button type="button" variant="secondary" className="min-h-11 md:min-h-11" disabled={read.state === "loading" || (read.state === "ready" && read.checking)} onClick={onRetry}>
      Retry findings
    </Button>
  );

  if (read.state !== "ready") {
    return (
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 min-w-0 flex-1 text-[11px] text-muted-foreground">
          Linked finding {reference} · {read.state === "loading" ? "loading" : "could not be read"}
        </p>
        {read.state === "failed" ? retry : null}
      </div>
    );
  }

  const finding = read.findings.find((entry) => entry.id === findingId);
  return (
    <div className="mt-1 grid gap-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 min-w-0 flex-1 text-[11px] text-muted-foreground">
          Linked finding{" "}
          {finding === undefined ? (
            <>{reference} · {read.stale ? "could not be read" : read.checking ? "checking current findings" : "unavailable in this engagement"}</>
          ) : (
            <>
              <span className="break-words text-foreground">{finding.title}</span> · {finding.status}
            </>
          )}
          {read.stale ? " · refresh failed" : ""}
        </p>
        <div className="flex flex-wrap gap-2">
          {read.stale ? retry : null}
          {finding !== undefined ? (
            <Button
              type="button"
              variant="quiet"
              className="min-h-11 md:min-h-11"
              aria-expanded={open}
              aria-controls={open ? bodyId : undefined}
              onClick={() => setOpen((current) => !current)}
            >
              {open ? "Hide body" : "Show current body"}
            </Button>
          ) : null}
        </div>
      </div>
      {finding !== undefined && open ? (
        <p
          id={bodyId}
          className="m-0 border-l border-border pl-2.5 text-[12px] leading-5 whitespace-pre-wrap break-words text-foreground"
        >
          {finding.body.length > 0 ? finding.body : "No saved body."}
        </p>
      ) : null}
    </div>
  );
}
