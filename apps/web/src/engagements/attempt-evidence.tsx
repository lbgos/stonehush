import { useEffect, useId, useRef, useState } from "react";

import {
  LEAD_EVIDENCE_REFS_MAX,
  type ReportEvidenceArtifact,
} from "@stonehush/contracts";
import { Button } from "@stonehush/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { ReportQueryError } from "./errors.js";
import { fetchReportBundle } from "./report-query.js";

// Optional saved-evidence picker for a new lead attempt. The evidence text
// field stays the only draft: rows read the IDs it holds, and Add or Remove
// rewrite it. Choosing never posts, fetches artifact content or checks that a
// typed ID exists; the server stores references as before.

export const EVIDENCE_PICKER_PAGE = 50;

export function parseEvidenceInput(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function uniqueEvidence(value: string): string[] {
  return [...new Set(parseEvidenceInput(value))];
}

// Adds one exact ID after every other entry, once. Undefined when the field
// already holds the attempt limit of distinct IDs.
export function addEvidenceId(value: string, artifactId: string): string | undefined {
  const ids = uniqueEvidence(value);
  if (ids.includes(artifactId)) return value;
  if (ids.length >= LEAD_EVIDENCE_REFS_MAX) return undefined;
  return [...ids, artifactId].join(", ");
}

export function removeEvidenceId(value: string, artifactId: string): string {
  return uniqueEvidence(value)
    .filter((entry) => entry !== artifactId)
    .join(", ");
}

export interface EvidenceCatalog {
  readonly rows: readonly ReportEvidenceArtifact[];
  readonly total: number;
  readonly truncated: boolean;
}

// The report's capped artifact section, accepted only for the exact
// engagement and with unique artifact IDs.
export async function fetchAttemptEvidenceCatalog(
  engagementId: string,
  signal?: AbortSignal,
): Promise<EvidenceCatalog> {
  const bundle = await fetchReportBundle(engagementId, signal);
  const section = bundle.evidenceArtifacts;
  if (
    bundle.engagement.id !== engagementId ||
    new Set(section.rows.map((row) => row.artifactId)).size !== section.rows.length
  ) {
    throw new ReportQueryError();
  }
  return section;
}

// One picker's private read. It never runs on mount; opening the picker and
// Retry start it, and hiding the picker aborts it. The key is per picker, so
// another form or engagement cannot hand its answer to this one. Each answer
// carries the number of the read that produced it.
function useAttemptEvidenceCatalogQuery(engagementId: string) {
  const readId = useId();
  const reads = useRef(0);
  const queryClient = useQueryClient();
  const queryKey = ["engagements", engagementId, "attempt-evidence", readId] as const;
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const read = reads.current;
      return { read, catalog: await fetchAttemptEvidenceCatalog(engagementId, signal) };
    },
    enabled: false,
    gcTime: 0,
    retry: false,
  });
  return {
    query,
    read: () => {
      reads.current += 1;
      void query.refetch();
      return reads.current;
    },
    cancel: () => void queryClient.cancelQueries({ queryKey, exact: true }),
  };
}

const KIND_LABELS: Record<ReportEvidenceArtifact["kind"], string> = {
  stdout: "stdout",
  stderr: "stderr",
  tool_raw: "tool raw output",
  tool_parsed_input: "tool parsed input",
};

function matchesFilter(row: ReportEvidenceArtifact, filter: string): boolean {
  if (filter === "") return true;
  return [row.artifactId, row.runId, row.kind, KIND_LABELS[row.kind], row.completeness].some((field) =>
    field.toLowerCase().includes(filter),
  );
}

export function AttemptEvidencePicker({
  engagementId,
  evidenceInputId,
  value,
  disabled,
  onChange,
}: {
  engagementId: string;
  evidenceInputId: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const panelId = useId();
  const filterId = useId();
  const catalogRead = useAttemptEvidenceCatalogQuery(engagementId);
  const query = catalogRead.query;
  const [open, setOpen] = useState(false);
  // The read this opening or its latest Retry started.
  const [currentRead, setCurrentRead] = useState(0);
  const [filter, setFilter] = useState("");
  const [shown, setShown] = useState(EVIDENCE_PICKER_PAGE);
  const [focusRow, setFocusRow] = useState<number>();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const restoreToggle = useRef(false);

  useEffect(() => {
    if (open) filterRef.current?.focus();
    else if (restoreToggle.current) toggleRef.current?.focus();
    restoreToggle.current = false;
  }, [open]);

  useEffect(() => {
    if (focusRow === undefined) return;
    const row = listRef.current?.children[focusRow];
    if (row instanceof HTMLElement) {
      const button = row.querySelector<HTMLButtonElement>("button");
      if (button !== null && !button.disabled) button.focus();
      else row.focus();
    }
    setFocusRow(undefined);
  }, [focusRow]);

  const read = () => setCurrentRead(catalogRead.read());
  const toggle = () => {
    if (open) {
      restoreToggle.current = true;
      catalogRead.cancel();
      setOpen(false);
      return;
    }
    setOpen(true);
    read();
  };

  const selected = uniqueEvidence(value);
  const selectedSet = new Set(selected);
  const atLimit = selected.length >= LEAD_EVIDENCE_REFS_MAX;
  const catalog = query.data?.catalog;
  // Rows from an earlier opening or a failed refresh stay visible but cannot
  // be added until a read started by this opening succeeds.
  const fresh =
    catalog !== undefined && !query.isFetching && !query.isError && query.data?.read === currentRead;
  const listed = new Set(catalog?.rows.map((row) => row.artifactId));
  const unlisted = catalog === undefined ? 0 : selected.filter((id) => !listed.has(id)).length;
  const needle = filter.trim().toLowerCase();
  const matches = catalog === undefined ? [] : catalog.rows.filter((row) => matchesFilter(row, needle));
  const visible = matches.slice(0, shown);

  let status: { text: string; retry: boolean } | undefined;
  if (catalog === undefined) {
    status = query.isError && !query.isFetching
      ? { text: "Saved evidence could not be read. Typed IDs can still be recorded.", retry: true }
      : { text: "Loading saved evidence", retry: false };
  } else if (query.isFetching) {
    status = { text: "Checking saved evidence. Showing the list as last read.", retry: false };
  } else if (query.isError) {
    status = { text: "Refresh failed. Showing the list as last read. Retry to add from it.", retry: true };
  } else if (!fresh) {
    status = { text: "Showing the list as last read. Retry to add from it.", retry: true };
  }

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          ref={toggleRef}
          type="button"
          variant="secondary"
          className="min-h-11 md:min-h-11"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          disabled={disabled && !open}
          onClick={toggle}
        >
          {open ? "Hide saved evidence" : "Choose saved evidence"}
        </Button>
        {selected.length > 0 ? (
          <p className="m-0 text-[11px] text-muted-foreground" aria-live="polite">
            {selected.length} of {LEAD_EVIDENCE_REFS_MAX} evidence IDs
          </p>
        ) : null}
      </div>
      {open ? (
        <div id={panelId} role="group" aria-label="Saved evidence" className="grid gap-2 border-t border-border pt-2">
          <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={filterId}>
            <span>Filter saved evidence</span>
            <input
              ref={filterRef}
              id={filterId}
              type="search"
              value={filter}
              placeholder="run, kind or artifact id"
              spellCheck={false}
              autoComplete="off"
              className="min-h-11 w-full border border-input bg-transparent px-2.5 py-2 font-mono text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => {
                setFilter(event.target.value);
                setShown(EVIDENCE_PICKER_PAGE);
              }}
            />
          </label>
          {status !== undefined ? (
            <div className="flex flex-wrap items-center justify-between gap-2" role="status">
              <p className="m-0 min-w-0 flex-1 text-[11px] leading-5 text-muted-foreground">{status.text}</p>
              {status.retry ? (
                <Button
                  type="button"
                  variant="secondary"
                  className="min-h-11 md:min-h-11"
                  onClick={(event) => {
                    if (document.activeElement === event.currentTarget) filterRef.current?.focus();
                    read();
                  }}
                >
                  Retry saved evidence
                </Button>
              ) : null}
            </div>
          ) : null}
          {catalog !== undefined ? (
            <p className="m-0 text-[11px] leading-5 text-muted-foreground" aria-live="polite">
              {catalog.total === 0
                ? "No saved artifacts in this engagement."
                : catalog.truncated
                  ? `Showing ${catalog.rows.length} of ${catalog.total} saved artifacts. The list is incomplete. Type other IDs in the evidence field.`
                  : `${catalog.total} saved ${catalog.total === 1 ? "artifact" : "artifacts"}.`}
              {needle !== "" && catalog.total > 0 ? ` ${matches.length} matching.` : ""}
              {unlisted > 0
                ? ` ${unlisted} typed ${unlisted === 1 ? "ID is not in this list and stays" : "IDs are not in this list and stay"} as typed.`
                : ""}
            </p>
          ) : null}
          {atLimit ? (
            <p className="m-0 text-[11px] leading-5 text-foreground" role="status">
              Evidence holds at most {LEAD_EVIDENCE_REFS_MAX} IDs. Remove one before adding another.
            </p>
          ) : null}
          {visible.length > 0 ? (
            <ul ref={listRef} aria-label="Saved artifacts" className="m-0 grid list-none p-0">
              {visible.map((row) => {
                const chosen = selectedSet.has(row.artifactId);
                return (
                  <li
                    key={row.artifactId}
                    tabIndex={-1}
                    className={`flex items-center justify-between gap-2 border-b border-l-2 border-b-border py-1.5 pr-0 pl-2 outline-none focus-visible:ring-2 focus-visible:ring-ring ${chosen ? "border-l-foreground" : "border-l-transparent"}`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="m-0 text-[12px] text-foreground">
                        {chosen ? "Selected · " : ""}
                        {KIND_LABELS[row.kind]} · {row.sizeBytes} bytes · {row.completeness}
                      </p>
                      <p className="m-0 font-mono text-[11px] break-all text-muted-foreground">
                        run {row.runId}
                      </p>
                      <p className="m-0 font-mono text-[11px] break-all text-foreground">{row.artifactId}</p>
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      className="min-h-11 shrink-0 md:min-h-11"
                      aria-label={`${chosen ? "Remove" : "Add"} ${row.artifactId}`}
                      aria-controls={evidenceInputId}
                      disabled={disabled || (!chosen && (!fresh || atLimit))}
                      onClick={(event) => {
                        if (chosen) {
                          if (!fresh && document.activeElement === event.currentTarget) {
                            event.currentTarget.closest<HTMLLIElement>("li")?.focus();
                          }
                          onChange(removeEvidenceId(value, row.artifactId));
                          return;
                        }
                        const next = addEvidenceId(value, row.artifactId);
                        if (next !== undefined) onChange(next);
                      }}
                    >
                      {chosen ? "Remove" : "Add"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {matches.length > visible.length ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="m-0 text-[11px] text-muted-foreground">
                Showing {visible.length} of {matches.length}
              </p>
              <Button
                type="button"
                variant="secondary"
                className="min-h-11 md:min-h-11"
                onClick={() => {
                  setFocusRow(visible.length);
                  setShown((current) => current + EVIDENCE_PICKER_PAGE);
                }}
              >
                Show {Math.min(EVIDENCE_PICKER_PAGE, matches.length - visible.length)} more
              </Button>
            </div>
          ) : null}
          {catalog !== undefined && catalog.total > 0 && needle !== "" && matches.length === 0 ? (
            <p className="m-0 text-[11px] text-muted-foreground">No saved artifacts match this filter.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
