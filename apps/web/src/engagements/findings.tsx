import { useState } from "react";

import type { Finding } from "@stonehush/contracts";
import {
  Button,
  LoadingRegion,
  RecoverableError,
  Skeleton,
  StaleDataState,
} from "@stonehush/ui";
import { useQueryClient } from "@tanstack/react-query";

import { findingMutationMessage, isFindingRevisionConflict } from "./errors.js";
import {
  useCreateFindingMutation,
  useFindingTransitionMutation,
  useFindingsQuery,
  useUpdateFindingMutation,
  findingsQueryKey,
} from "./findings-query.js";
import { formatEngagementTimestamp } from "./format.js";

const SEVERITY_OPTIONS = ["info", "low", "medium", "high", "critical"] as const;

function parseEvidenceInput(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function EngagementFindingsSection({
  archived,
  engagementId,
  selection,
}: {
  archived: boolean;
  engagementId: string;
  selection?:
    | {
        selectedIds: readonly string[];
        onToggleFinding: (findingId: string) => void;
      }
    | undefined;
}) {
  const findings = useFindingsQuery(engagementId);
  const retry = () => void findings.refetch();
  const hasData = findings.data !== undefined;

  const body = (
    <FindingsBody archived={archived} engagementId={engagementId} selection={selection} />
  );

  return (
    <section aria-label="Findings" className="mt-5 border-t border-border pt-4">
      <header className="mb-3">
        <h2 className="m-0 text-[13px] font-semibold">Findings</h2>
        <p className="mt-1 mb-0 text-[12px] leading-5 text-muted-foreground">
          Compact finding list for CTF reporting. Create, edit, resolve, and reopen per
          engagement.
        </p>
      </header>
      {!hasData && findings.isFetching ? (
        <LoadingRegion label="Loading findings" className="space-y-3">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </LoadingRegion>
      ) : null}
      {!hasData && findings.isError ? (
        <RecoverableError
          title="Findings unavailable"
          description="The findings could not be loaded from the local control plane."
          onRetry={retry}
        />
      ) : null}
      {hasData && findings.isError ? (
        <StaleDataState
          title="Showing the last successful findings"
          description="The latest refresh failed. Existing findings are still available."
          onRetry={retry}
        >
          {body}
        </StaleDataState>
      ) : null}
      {hasData && !findings.isError ? body : null}
    </section>
  );
}

function FindingsBody({
  archived,
  engagementId,
  selection,
}: {
  archived: boolean;
  engagementId: string;
  selection?:
    | {
        selectedIds: readonly string[];
        onToggleFinding: (findingId: string) => void;
      }
    | undefined;
}) {
  const findings = useFindingsQuery(engagementId);
  const create = useCreateFindingMutation(engagementId);
  const resolve = useFindingTransitionMutation(engagementId, "resolve");
  const reopen = useFindingTransitionMutation(engagementId, "reopen");
  const [title, setTitle] = useState("");
  const [severity, setSeverity] =
    useState<(typeof SEVERITY_OPTIONS)[number]>("medium");
  const [body, setBody] = useState("");
  const [evidence, setEvidence] = useState("");
  const [formError, setFormError] = useState<string | undefined>(undefined);

  const records = findings.data ?? [];
  const openCount = records.filter((finding) => finding.status === "open").length;
  const mutationError =
    create.isError || resolve.isError || reopen.isError
      ? findingMutationMessage(
          create.error ?? resolve.error ?? reopen.error,
        )
      : formError;

  const canSubmit =
    !archived && !create.isPending && title.trim().length > 0;

  const submit = () => {
    setFormError(undefined);
    if (create.isError) create.reset();
    const trimmedTitle = title.trim();
    if (trimmedTitle.length === 0) {
      setFormError("Enter a finding title.");
      return;
    }
    create.mutate(
      {
        title: trimmedTitle,
        severity,
        body,
        evidenceArtifactIds: parseEvidenceInput(evidence),
      },
      {
        onSuccess: () => {
          setTitle("");
          setBody("");
          setEvidence("");
          setSeverity("medium");
        },
      },
    );
  };

  return (
    <div className="grid gap-4">
      <div>
        {records.length === 0 ? (
          <div className="rounded-[10px] border border-border px-4 py-8 text-center">
            <h3 className="m-0 text-[13px] font-semibold">No findings yet</h3>
            <p className="mx-auto mt-2 mb-0 max-w-md text-[13px] leading-5 text-muted-foreground">
              Record the first finding for this engagement with a title, severity, and notes.
            </p>
          </div>
        ) : (
          <div>
            <p className="m-0 mb-2 text-[12px] text-muted-foreground" aria-live="polite">
              {openCount} open of {records.length} findings
            </p>
            <ul className="m-0 grid list-none gap-2 p-0">
              {records.map((finding) => (
                <FindingRow
                  key={finding.id}
                  archived={archived}
                  engagementId={engagementId}
                  finding={finding}
                  pending={resolve.isPending || reopen.isPending}
                  selectedForAdvisor={
                    selection === undefined ? undefined : selection.selectedIds.includes(finding.id)
                  }
                  onToggleAdvisor={
                    selection === undefined
                      ? undefined
                      : () => selection.onToggleFinding(finding.id)
                  }
                  onResolve={() => {
                    if (resolve.isError) resolve.reset();
                    if (reopen.isError) reopen.reset();
                    resolve.mutate(finding.id);
                  }}
                  onReopen={() => {
                    if (resolve.isError) resolve.reset();
                    if (reopen.isError) reopen.reset();
                    reopen.mutate(finding.id);
                  }}
                />
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

      <div className="rounded-[10px] border border-border">
        <div className="border-b border-border px-3 py-2">
          <h3 className="m-0 text-[13px] font-semibold">New finding</h3>
        </div>
        <div className="grid gap-3 px-3 py-3">
          <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="finding-title">
            <span>Title</span>
            <input
              id="finding-title"
              value={title}
              disabled={archived || create.isPending}
              placeholder="Default credentials on admin panel"
              maxLength={120}
              className="w-full rounded-md border border-input bg-transparent px-2.5 py-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="finding-severity">
              <span>Severity</span>
              <select
                id="finding-severity"
                value={severity}
                disabled={archived || create.isPending}
                className="w-full rounded-md border border-input bg-transparent px-2.5 py-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) =>
                  setSeverity(event.target.value as typeof severity)
                }
              >
                {SEVERITY_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="finding-evidence">
              <span>Evidence artifact ids, comma separated</span>
              <input
                id="finding-evidence"
                value={evidence}
                disabled={archived || create.isPending}
                placeholder="nmap-xml-1"
                spellCheck={false}
                className="w-full rounded-md border border-input bg-transparent px-2.5 py-2 font-mono text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) => setEvidence(event.target.value)}
              />
            </label>
          </div>
          <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="finding-body">
            <span>Notes Markdown</span>
            <textarea
              id="finding-body"
              value={body}
              rows={5}
              disabled={archived || create.isPending}
              placeholder="# impact&#10;# remediation"
              spellCheck={false}
              className="min-h-24 w-full rounded-md border border-input bg-transparent px-2.5 py-2 font-mono text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => setBody(event.target.value)}
            />
          </label>
          {archived ? (
            <p className="m-0 text-[12px] leading-5 text-muted-foreground">
              This engagement is archived. Findings can be viewed but not changed.
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button
              type="button"
              disabled={!canSubmit}
              onClick={submit}
            >
              {create.isPending ? "Saving" : "Create finding"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function FindingRow({
  archived,
  engagementId,
  finding,
  pending,
  onResolve,
  onReopen,
  selectedForAdvisor,
  onToggleAdvisor,
}: {
  archived: boolean;
  engagementId: string;
  finding: Finding;
  pending: boolean;
  onResolve: () => void;
  onReopen: () => void;
  selectedForAdvisor?: boolean | undefined;
  onToggleAdvisor?: (() => void) | undefined;
}) {
  const update = useUpdateFindingMutation(engagementId);
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftSeverity, setDraftSeverity] =
    useState<(typeof SEVERITY_OPTIONS)[number]>("medium");
  const [draftBody, setDraftBody] = useState("");
  const [baseRevision, setBaseRevision] = useState(0);
  const [localError, setLocalError] = useState<string | undefined>(undefined);
  const isOpen = finding.status === "open";

  const openEditor = () => {
    setDraftTitle(finding.title);
    setDraftSeverity(finding.severity);
    setDraftBody(finding.body);
    setBaseRevision(finding.revision);
    setLocalError(undefined);
    if (update.isError) update.reset();
    setEditing(true);
  };
  const closeEditor = () => {
    setEditing(false);
    setLocalError(undefined);
    if (update.isError) update.reset();
  };
  // Reload refetches the list and seeds the draft from the latest loaded
  // row. Background refreshes never touch the draft while editing; only
  // this explicit action does.
  const reloadFromServer = () => {
    update.reset();
    setLocalError(undefined);
    void queryClient
      .invalidateQueries({ queryKey: findingsQueryKey(engagementId) })
      .then(() => {
        const fresh = queryClient
          .getQueryData<Finding[]>(findingsQueryKey(engagementId))
          ?.find((entry) => entry.id === finding.id);
        if (fresh === undefined) {
          setLocalError("The latest finding could not be loaded. Try again.");
          return;
        }
        setDraftTitle(fresh.title);
        setDraftSeverity(fresh.severity);
        setDraftBody(fresh.body);
        setBaseRevision(fresh.revision);
      });
  };

  const saveEdit = () => {
    if (update.isPending) return;
    setLocalError(undefined);
    if (update.isError) update.reset();
    const trimmedTitle = draftTitle.trim();
    if (trimmedTitle.length === 0) {
      setLocalError("Enter a finding title.");
      return;
    }
    update.mutate(
      {
        findingId: finding.id,
        title: trimmedTitle,
        severity: draftSeverity,
        body: draftBody,
        expectedRevision: baseRevision,
      },
      { onSuccess: () => setEditing(false) },
    );
  };

  const editError = update.isError ? findingMutationMessage(update.error) : localError;
  const showReload = update.isError && isFindingRevisionConflict(update.error);
  return (
    <li className="rounded-[10px] border border-border px-3 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="m-0 flex items-start gap-2 truncate text-[13px] font-semibold" title={finding.title}>
            {onToggleAdvisor !== undefined ? (
              <input
                type="checkbox"
                checked={selectedForAdvisor === true}
                disabled={archived}
                onChange={onToggleAdvisor}
                aria-label={`Select finding ${finding.title} for advisor`}
                className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary"
              />
            ) : null}
            <span className="min-w-0 flex-1 truncate">{finding.title}</span>
          </p>
          <p className="m-0 mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
            <span>{finding.severity}</span>
            <span aria-hidden="true">·</span>
            <span>{finding.status}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono">{formatEngagementTimestamp(finding.updatedAt)}</span>
            {finding.evidenceArtifactIds.length > 0 ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono">
                  {finding.evidenceArtifactIds.length} evidence
                </span>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {!archived && !editing ? (
            <Button
              type="button"
              variant="secondary"
              disabled={pending || update.isPending}
              onClick={openEditor}
            >
              Edit
            </Button>
          ) : null}
          {isOpen ? (
            <Button
              type="button"
              variant="secondary"
              disabled={archived || pending}
              onClick={() => {
                closeEditor();
                onResolve();
              }}
            >
              Resolve
            </Button>
          ) : (
            <Button
              type="button"
              variant="secondary"
              disabled={archived || pending}
              onClick={() => {
                closeEditor();
                onReopen();
              }}
            >
              Reopen
            </Button>
          )}
        </div>
      </div>
      {finding.body.length > 0 ? (
        <p className="m-0 mt-2 whitespace-pre-wrap break-words text-[12px] leading-5 text-muted-foreground">
          {finding.body}
        </p>
      ) : null}
      {finding.evidenceArtifactIds.length > 0 ? (
        <p className="m-0 mt-1 truncate font-mono text-[11px] text-muted-foreground" title={finding.evidenceArtifactIds.join(", ")}>
          {finding.evidenceArtifactIds.join(", ")}
        </p>
      ) : null}
      {editing ? (
        <div className="mt-3 grid gap-3 border-t border-border pt-3">
          <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={`finding-edit-title-${finding.id}`}>
            <span>Title</span>
            <input
              id={`finding-edit-title-${finding.id}`}
              value={draftTitle}
              disabled={update.isPending}
              maxLength={120}
              className="w-full rounded-md border border-input bg-transparent px-2.5 py-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => setDraftTitle(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={`finding-edit-severity-${finding.id}`}>
            <span>Severity</span>
            <select
              id={`finding-edit-severity-${finding.id}`}
              value={draftSeverity}
              disabled={update.isPending}
              className="w-full rounded-md border border-input bg-transparent px-2.5 py-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) =>
                setDraftSeverity(event.target.value as typeof draftSeverity)
              }
            >
              {SEVERITY_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={`finding-edit-body-${finding.id}`}>
            <span>Notes Markdown</span>
            <textarea
              id={`finding-edit-body-${finding.id}`}
              value={draftBody}
              rows={5}
              disabled={update.isPending}
              spellCheck={false}
              className="min-h-24 w-full rounded-md border border-input bg-transparent px-2.5 py-2 font-mono text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => setDraftBody(event.target.value)}
            />
          </label>
          <p className="m-0 text-[11px] text-muted-foreground">
            Evidence references stay unchanged by edits.
          </p>
          {editError ? (
            <p className="m-0 text-[13px] text-destructive" role="alert">
              {editError}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            {showReload ? (
              <Button type="button" variant="secondary" onClick={reloadFromServer}>
                Reload
              </Button>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              disabled={update.isPending}
              onClick={closeEditor}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={update.isPending || draftTitle.trim().length === 0}
              onClick={saveEdit}
            >
              {update.isPending ? "Saving" : "Save edit"}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
