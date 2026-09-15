import { Button, LoadingRegion, RecoverableError, Skeleton, StaleDataState } from "@stonehush/ui";
import { useId } from "react";

import { engagementNotesMutationMessage, isNotesRevisionConflict } from "./errors.js";
import { useNotesDraftGuard } from "./notes-guard.js";
import { useEngagementNotesEditor } from "./notes-query.js";

export function EngagementNotesSection({
  archived,
  engagementId,
}: {
  archived: boolean;
  engagementId: string;
}) {
  const {
    query,
    save,
    value,
    dirty,
    setDraft,
    conflictServer,
    recoveryError,
    recovering,
    onSave,
    loadServerVersion,
    keepMine,
    retryRecovery,
  } = useEngagementNotesEditor(engagementId);
  const retry = () => void query.refetch();
  const hasData = query.data !== undefined;
  const guardActive = dirty && !archived && hasData;
  const draftBlocker = useNotesDraftGuard(guardActive);
  const blocked = draftBlocker.status === "blocked";
  const titleId = useId();
  const copyId = useId();
  const isConflict =
    conflictServer !== null ||
    (save.isError && isNotesRevisionConflict(save.error)) ||
    recovering ||
    recoveryError;
  const conflictError = save.isError ? engagementNotesMutationMessage(save.error) : undefined;
  const body = (
    <NotesEditorBody
      archived={archived}
      value={value}
      dirty={dirty}
      pending={save.isPending}
      error={save.isError && !isNotesRevisionConflict(save.error) ? conflictError : undefined}
      conflictServer={conflictServer}
      recoveryError={recoveryError}
      recovering={recovering}
      showConflict={isConflict}
      onChange={(next) => {
        setDraft(next);
      }}
      onSave={onSave}
      onLoadServer={loadServerVersion}
      onKeepMine={keepMine}
      onRetryRecovery={retryRecovery}
    />
  );

  return (
    <section aria-label="Engagement notes" className="mt-5 border-t border-border pt-4">
      <header className="mb-3">
        <h2 className="m-0 text-[13px] font-semibold">Notes</h2>
        <p className="mt-1 mb-0 text-[12px] leading-5 text-muted-foreground">
          One Markdown scratchpad per engagement for creds, flags, and observations.
        </p>
      </header>
      {blocked ? (
        <section
          role="alertdialog"
          aria-labelledby={titleId}
          aria-describedby={copyId}
          className="mb-3 rounded-[10px] border border-border px-3 py-3"
        >
          <h3 id={titleId} className="m-0 text-[13px] font-semibold text-foreground">
            Unsaved notes
          </h3>
          <p id={copyId} className="mt-1 mb-0 text-[12px] leading-5 text-muted-foreground">
            You have unsaved notes. Leaving now will discard them.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" autoFocus onClick={() => draftBlocker.reset?.()}>
              Stay
            </Button>
            <Button type="button" variant="secondary" onClick={() => draftBlocker.proceed?.()}>
              Leave
            </Button>
          </div>
        </section>
      ) : null}
      {!hasData && query.isFetching ? (
        <LoadingRegion label="Loading notes" className="space-y-3">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-32 w-full" />
        </LoadingRegion>
      ) : null}
      {!hasData && query.isError ? (
        <RecoverableError
          title="Notes unavailable"
          description="The engagement notes could not be loaded from the local control plane."
          onRetry={retry}
        />
      ) : null}
      {hasData && query.isError ? (
        <StaleDataState
          title="Showing the last successful notes"
          description="The latest refresh failed. Existing notes are still available."
          onRetry={retry}
        >
          {body}
        </StaleDataState>
      ) : null}
      {hasData && !query.isError ? body : null}
    </section>
  );
}

function NotesEditorBody({
  archived,
  value,
  dirty,
  pending,
  error,
  conflictServer,
  recoveryError,
  recovering,
  showConflict,
  onChange,
  onSave,
  onLoadServer,
  onKeepMine,
  onRetryRecovery,
}: {
  archived: boolean;
  value: string;
  dirty: boolean;
  pending: boolean;
  error: string | undefined;
  conflictServer: { markdown: string; updatedAt: string; revision: number } | null;
  recoveryError: boolean;
  recovering: boolean;
  showConflict: boolean;
  onChange: (next: string) => void;
  onSave: () => void;
  onLoadServer: () => void;
  onKeepMine: () => void;
  onRetryRecovery: () => void;
}) {
  return (
    <div>
      <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="engagement-notes-editor">
        <span>Markdown</span>
        <textarea
          id="engagement-notes-editor"
          value={value}
          rows={10}
          disabled={archived || pending}
          placeholder={"# creds\n# flags\n# observations"}
          spellCheck={false}
          className="min-h-32 w-full rounded-md border border-input bg-transparent px-2.5 py-2 font-mono text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      {archived ? (
        <p className="mt-3 mb-0 text-[12px] leading-5 text-muted-foreground">
          This engagement is archived. Notes can be viewed but not changed.
        </p>
      ) : null}
      {error ? (
        <p className="mt-2 mb-0 text-[13px] text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {showConflict ? (
        <div className="mt-3 rounded-[10px] border border-border px-3 py-3" role="alert">
          <p className="m-0 text-[13px] font-semibold text-foreground">Notes changed elsewhere</p>
          <p className="mt-1 mb-0 text-[12px] leading-5 text-muted-foreground">
            Your edits are kept. Load the server version to discard yours, or keep yours to
            overwrite the server version.
          </p>
          {recovering && conflictServer === null && !recoveryError ? (
            <p className="mt-2 mb-0 text-[12px] text-muted-foreground">Checking server version…</p>
          ) : null}
          {recoveryError && conflictServer === null ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <p className="m-0 text-[12px] text-destructive">
                Could not load the server version. Your edits are kept.
              </p>
              <Button type="button" variant="secondary" disabled={archived} onClick={onRetryRecovery}>
                Retry loading server
              </Button>
            </div>
          ) : null}
          {conflictServer !== null ? (
            <div className="mt-2">
              <p className="m-0 text-[12px] text-muted-foreground">
                Server revision {conflictServer.revision} saved {conflictServer.updatedAt}
              </p>
              <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-input bg-transparent px-2.5 py-2 font-mono text-[12px] text-foreground">
                {conflictServer.markdown === "" ? "(empty notes)" : conflictServer.markdown}
              </pre>
              {recoveryError ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <p className="m-0 text-[12px] text-destructive">
                    Could not refresh the server version. Your edits are kept.
                  </p>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={archived}
                    onClick={onRetryRecovery}
                  >
                    Retry loading server
                  </Button>
                </div>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={archived || pending || recovering}
                  onClick={onLoadServer}
                >
                  Load server version
                </Button>
                <Button
                  type="button"
                  disabled={archived || pending || recovering}
                  onClick={onKeepMine}
                  title={`Overwrite server revision ${conflictServer.revision} with your edits`}
                >
                  Keep mine
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 text-[12px] text-muted-foreground" aria-live="polite">
          {pending ? "Saving" : dirty ? "Unsaved changes" : "Saved"}
        </p>
        <Button type="button" disabled={archived || !dirty || pending} onClick={onSave}>
          {pending ? "Saving" : "Save notes"}
        </Button>
      </div>
    </div>
  );
}
