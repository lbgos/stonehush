import { Button, LoadingRegion, RecoverableError, Skeleton, StaleDataState } from "@stonehush/ui";
import type { Attachment } from "@stonehush/contracts";
import { useEffect, useId, useRef, useState, type RefObject } from "react";

import { engagementNotesMutationMessage, isNotesRevisionConflict } from "./errors.js";
import { useNotesDraftGuard } from "./notes-guard.js";
import { useEngagementNotesEditor } from "./notes-query.js";
import { createAttachmentRequest, fetchAttachments } from "./run-output-query.js";

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
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentsRef = useRef<{ acceptFiles: (files: readonly File[]) => void } | null>(null);
  // Latest draft for async insert: an upload resolving after the operator
  // kept typing must insert into the newest text, never overwrite it with a
  // stale render closure.
  const valueRef = useRef(value);
  valueRef.current = value;

  const insertIntoDraft = (snippet: string) => {
    const element = editorRef.current;
    const latest = valueRef.current;
    if (element !== null && typeof element.selectionStart === "number") {
      const start = Math.min(element.selectionStart, latest.length);
      const end = Math.min(element.selectionEnd, latest.length);
      setDraft(`${latest.slice(0, start)}${snippet}${latest.slice(end)}`);
      const cursor = start + snippet.length;
      requestAnimationFrame(() => {
        element.focus();
        element.setSelectionRange(cursor, cursor);
      });
      return;
    }
    setDraft(latest.length === 0 ? snippet : `${latest}\n${snippet}`);
  };
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
      editorRef={editorRef}
      onPasteFiles={(files) => attachmentsRef.current?.acceptFiles(files)}
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
      {hasData ? (
        <NoteAttachmentsSection
          archived={archived}
          engagementId={engagementId}
          attachmentsHandleRef={attachmentsRef}
          onInsert={(snippet) => insertIntoDraft(snippet)}
        />
      ) : null}
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
  editorRef,
  onPasteFiles,
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
  editorRef: RefObject<HTMLTextAreaElement | null>;
  onPasteFiles: (files: readonly File[]) => void;
  onChange: (next: string) => void;
  onSave: () => void;
  onLoadServer: () => void;
  onKeepMine: () => void;
  onRetryRecovery: () => void;
}) {
  return (
    <div
      onPaste={(event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
          file.type.startsWith("image/"),
        );
        if (files.length === 0) return;
        event.preventDefault();
        onPasteFiles(files);
      }}
      onDragOver={(event) => {
        if (Array.from(event.dataTransfer?.types ?? []).includes("Files")) {
          event.preventDefault();
        }
      }}
      onDrop={(event) => {
        const files = Array.from(event.dataTransfer?.files ?? []).filter((file) =>
          file.type.startsWith("image/"),
        );
        if (files.length === 0) return;
        event.preventDefault();
        onPasteFiles(files);
      }}
    >
      <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="engagement-notes-editor">
        <span>Markdown</span>
        <textarea
          id="engagement-notes-editor"
          ref={editorRef}
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

// ---- STONE-3 capture parts: image paste/drop, captions, derived crops ----
// Capture only. No next-step, resume, or search UI lives here.

const ATTACHMENT_MIME_ALLOWLIST = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
type AttachmentMime = (typeof ATTACHMENT_MIME_ALLOWLIST)[number];
// Raw bytes stay below the stored Base64 limit: Base64 expands by 4/3, so
// 1.5M raw fits the 2M content_base64 column and contract bound. Accepting a
// full 2M raw file would always fail at persistence with no successful retry.
const ATTACHMENT_RAW_MAX_BYTES = 1_500_000;

function isAttachmentMime(value: string): value is AttachmentMime {
  return (ATTACHMENT_MIME_ALLOWLIST as readonly string[]).includes(value);
}

// Structural validation for attachment payloads over the network. The web
// layer carries no zod dependency by convention (see report-mask.ts), so
// this guard mirrors the contract bounds instead: untrusted content is
// never cast blindly into the render path. The server remains the schema
// authority via AttachmentSchema.
function parseAttachmentPayload(value: unknown): Attachment {
  if (typeof value !== "object" || value === null) throw new Error("invalid attachment");
  const record = value as Record<string, unknown>;
  const text = (field: string, min: number, max: number): string => {
    const candidate = record[field];
    if (typeof candidate !== "string" || candidate.length < min || candidate.length > max) {
      throw new Error(`invalid attachment field ${field}`);
    }
    return candidate;
  };
  const nullableText = (field: string, min: number, max: number): string | null => {
    const candidate = record[field];
    if (candidate === null) return null;
    if (typeof candidate !== "string" || candidate.length < min || candidate.length > max) {
      throw new Error(`invalid attachment field ${field}`);
    }
    return candidate;
  };
  if (record["contractVersion"] !== 1) throw new Error("invalid attachment version");
  const mime = record["mime"];
  if (typeof mime !== "string" || !isAttachmentMime(mime)) {
    throw new Error("invalid attachment mime");
  }
  const sizeBytes = record["sizeBytes"];
  if (
    typeof sizeBytes !== "number" ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 1
  ) {
    throw new Error("invalid attachment size");
  }
  const digest = record["digest"];
  if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error("invalid attachment digest");
  }
  const crop = record["crop"];
  let parsedCrop: Attachment["crop"] = null;
  if (crop !== null) {
    if (typeof crop !== "object" || crop === null) throw new Error("invalid attachment crop");
    const rect = crop as Record<string, unknown>;
    const edges: { x: number; y: number; width: number; height: number } = {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    };
    for (const field of ["x", "y"] as const) {
      const candidate = rect[field];
      if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) {
        throw new Error("invalid attachment crop");
      }
      edges[field] = candidate;
    }
    for (const field of ["width", "height"] as const) {
      const candidate = rect[field];
      if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 1) {
        throw new Error("invalid attachment crop");
      }
      edges[field] = candidate;
    }
    parsedCrop = edges;
  }
  return {
    contractVersion: 1,
    id: text("id", 1, 255),
    engagementId: text("engagementId", 1, 255),
    filename: text("filename", 1, 128),
    mime,
    sizeBytes,
    digest,
    caption: text("caption", 0, 280),
    targetLabel: nullableText("targetLabel", 1, 120),
    parentAttachmentId: nullableText("parentAttachmentId", 1, 255),
    crop: parsedCrop,
    createdAt: text("createdAt", 1, 255),
  };
}

function attachmentContentUrl(engagementId: string, attachmentId: string): string {
  return `/api/v1/engagements/${encodeURIComponent(engagementId)}/attachments/${encodeURIComponent(attachmentId)}/content`;
}

interface PendingUpload {
  readonly clientId: number;
  readonly dataUrl: string;
  readonly mime: AttachmentMime;
  readonly proves: string;
  caption: string;
  targetLabel: string;
  status: "ready" | "uploading" | "failed";
  error: string | undefined;
}

let pendingUploadSeq = 0;

async function patchAttachmentCaption(
  engagementId: string,
  attachmentId: string,
  caption: string,
): Promise<Attachment> {
  const response = await fetch(
    `/api/v1/engagements/${encodeURIComponent(engagementId)}/attachments/${encodeURIComponent(attachmentId)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ caption }),
    },
  );
  const payload: unknown = await response.json().catch(() => undefined);
  if (response.status !== 200) {
    throw new Error("caption save failed");
  }
  return parseAttachmentPayload(payload);
}

async function deriveAttachment(
  engagementId: string,
  attachmentId: string,
  input: { caption: string; crop?: { x: number; y: number; width: number; height: number } },
): Promise<Attachment> {
  const response = await fetch(
    `/api/v1/engagements/${encodeURIComponent(engagementId)}/attachments/${encodeURIComponent(attachmentId)}/derived`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  const payload: unknown = await response.json().catch(() => undefined);
  if (response.status !== 201) {
    throw new Error("derived copy failed");
  }
  return parseAttachmentPayload(payload);
}

function NoteAttachmentsSection({
  archived,
  engagementId,
  attachmentsHandleRef,
  onInsert,
}: {
  archived: boolean;
  engagementId: string;
  attachmentsHandleRef: RefObject<{ acceptFiles: (files: readonly File[]) => void } | null>;
  onInsert: (snippet: string) => void;
}) {
  const [attachments, setAttachments] = useState<Attachment[] | undefined>(undefined);
  const [loadError, setLoadError] = useState(false);
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [engagementName, setEngagementName] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Tracks the engagement this section currently shows. Async FileReader and
  // upload completions capture their starting engagement and ignore stale
  // resolutions after navigation, so A's bytes never land under B.
  const engagementIdRef = useRef(engagementId);
  engagementIdRef.current = engagementId;

  // Union by id so a slow initial fetch never drops an attachment an upload
  // just added. Server rows win on conflicts; order stays by creation.
  const mergeAttachmentRows = (current: Attachment[] | undefined, incoming: Attachment[]) => {
    const byId = new Map<string, Attachment>();
    for (const row of current ?? []) byId.set(row.id, row);
    for (const row of incoming) byId.set(row.id, row);
    return [...byId.values()].sort((left, right) =>
      left.createdAt === right.createdAt
        ? (left.id < right.id ? -1 : 1)
        : (left.createdAt < right.createdAt ? -1 : 1),
    );
  };

  useEffect(() => {
    let cancelled = false;
    setAttachments(undefined);
    setLoadError(false);
    // Clear per-engagement capture state: a paste queued for A must not
    // persist A's target label or bytes under B after navigation.
    setPending([]);
    setEngagementName("");
    void fetchAttachments(engagementId)
      .then((rows) => {
        if (cancelled) return;
        // Merge instead of replacing: an upload that finished while this
        // fetch was in flight already appended to current state.
        setAttachments((current) => mergeAttachmentRows(current, rows));
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    // Engagement name seeds the target context on pasted screenshots. The
    // operator can edit it per image; it is stored as an operator label.
    void fetch(`/api/v1/engagements/${encodeURIComponent(engagementId)}`)
      .then((response) => (response.status === 200 ? response.json() : undefined))
      .then((payload: unknown) => {
        if (cancelled || typeof payload !== "object" || payload === null) return;
        const engagement = (payload as Record<string, unknown>)["engagement"];
        const name =
          typeof engagement === "object" && engagement !== null
            ? (engagement as Record<string, unknown>)["name"]
            : undefined;
        if (typeof name === "string" && name.length > 0) setEngagementName(name);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [engagementId]);

  const acceptFiles = (files: readonly File[]) => {
    if (archived) return;
    const startedEngagementId = engagementIdRef.current;
    const startedEngagementName = engagementName;
    for (const file of files) {
      const mime = file.type;
      if (!isAttachmentMime(mime)) continue;
      if (file.size < 1 || file.size > ATTACHMENT_RAW_MAX_BYTES) continue;
      const reader = new FileReader();
      const clientId = ++pendingUploadSeq;
      const proves = file.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 128);
      reader.onload = () => {
        // Drop pastes that finished reading after navigation away.
        if (engagementIdRef.current !== startedEngagementId) return;
        const dataUrl = typeof reader.result === "string" ? reader.result : "";
        if (dataUrl.length === 0) return;
        setPending((current) => [
          ...current,
          {
            clientId,
            dataUrl,
            mime,
            proves: proves.length > 0 ? proves : "evidence",
            caption: "",
            targetLabel: startedEngagementName,
            status: "ready",
            error: undefined,
          },
        ]);
      };
      reader.readAsDataURL(file);
    }
  };

  useEffect(() => {
    attachmentsHandleRef.current = { acceptFiles };
    return () => {
      attachmentsHandleRef.current = null;
    };
  });

  const uploadPending = (clientId: number) => {
    setPending((current) =>
      current.map((entry) =>
        entry.clientId === clientId ? { ...entry, status: "uploading", error: undefined } : entry,
      ),
    );
    const entry = pending.find((candidate) => candidate.clientId === clientId);
    if (entry === undefined) return;
    // Bind this upload to its starting engagement. If navigation happens
    // before the POST resolves, the completion below is ignored so A's bytes
    // never append to or insert into B.
    const startedEngagementId = engagementIdRef.current;
    const startedEngagementName = engagementName;
    const base64 = entry.dataUrl.split(",", 2)[1] ?? "";
    // Fall back to the current engagement context when the paste landed
    // before the engagement name finished loading.
    const targetLabel =
      entry.targetLabel.length > 0 ? entry.targetLabel : startedEngagementName;
    // The filename always comes from what the image proves. The caption is a
    // separate display field; using it as the filename loses the evidence
    // name the operator typed.
    const filename = entry.proves.length > 0 ? entry.proves : "evidence";
    void createAttachmentRequest(startedEngagementId, {
      filename,
      mime: entry.mime,
      contentBase64: base64,
      caption: entry.caption,
      ...(targetLabel.length > 0 ? { targetLabel } : {}),
    })
      .then((saved) => {
        if (engagementIdRef.current !== startedEngagementId) return;
        setPending((current) => current.filter((candidate) => candidate.clientId !== clientId));
        setAttachments((current) => mergeAttachmentRows(current, [saved]));
        onInsert(
          `![${saved.caption.length > 0 ? saved.caption : saved.filename}](attachment:${saved.id})`,
        );
      })
      .catch(() => {
        if (engagementIdRef.current !== startedEngagementId) return;
        // The pasted bytes stay local with a retry action; nothing is lost.
        setPending((current) =>
          current.map((candidate) =>
            candidate.clientId === clientId
              ? { ...candidate, status: "failed", error: "Upload failed. The image is kept below. Retry." }
              : candidate,
          ),
        );
      });
  };

  const discardPending = (clientId: number) => {
    setPending((current) => current.filter((candidate) => candidate.clientId !== clientId));
  };

  const reload = () => {
    setLoadError(false);
    void fetchAttachments(engagementId)
      .then((rows) => setAttachments((current) => mergeAttachmentRows(current, rows)))
      .catch(() => setLoadError(true));
  };

  return (
    <div className="mt-4 border-t border-border pt-3">
      <h3 className="m-0 text-[12px] font-semibold">Evidence images</h3>
      <p className="mt-1 mb-0 text-[12px] leading-5 text-muted-foreground">
        Paste or drop screenshots where notes are written. Name each by what it proves, add a
        caption, and insert it into the note. Cropped copies keep the original.
      </p>
      {!archived ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => fileInputRef.current?.click()}
          >
            Attach image
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            className="hidden"
            aria-label="Attach image file"
            onChange={(event) => {
              acceptFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
        </div>
      ) : null}
      {pending.map((entry) => (
        <div key={entry.clientId} className="mt-2 grid gap-2 rounded-md border border-border px-2.5 py-2">
          <img src={entry.dataUrl} alt={entry.caption.length > 0 ? entry.caption : entry.proves} className="max-h-40 w-auto" />
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            <span>Proves (names the file)</span>
            <input
              value={entry.proves}
              disabled={entry.status === "uploading"}
              maxLength={128}
              className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-[12px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) =>
                setPending((current) =>
                  current.map((candidate) =>
                    candidate.clientId === entry.clientId
                      ? { ...candidate, proves: event.target.value }
                      : candidate,
                  ),
                )
              }
            />
          </label>
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            <span>Caption</span>
            <input
              value={entry.caption}
              disabled={entry.status === "uploading"}
              maxLength={280}
              className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-[12px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) =>
                setPending((current) =>
                  current.map((candidate) =>
                    candidate.clientId === entry.clientId
                      ? { ...candidate, caption: event.target.value }
                      : candidate,
                  ),
                )
              }
            />
          </label>
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            <span>Target context</span>
            <input
              value={entry.targetLabel}
              disabled={entry.status === "uploading"}
              maxLength={120}
              className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-[12px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) =>
                setPending((current) =>
                  current.map((candidate) =>
                    candidate.clientId === entry.clientId
                      ? { ...candidate, targetLabel: event.target.value }
                      : candidate,
                  ),
                )
              }
            />
          </label>
          {entry.status === "failed" ? (
            <p className="m-0 text-[12px] text-destructive" role="alert">
              {entry.error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={entry.status === "uploading"}
              onClick={() => uploadPending(entry.clientId)}
            >
              {entry.status === "uploading"
                ? "Uploading"
                : entry.status === "failed"
                  ? "Retry upload"
                  : "Save image"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={entry.status === "uploading"}
              onClick={() => discardPending(entry.clientId)}
            >
              Discard
            </Button>
          </div>
        </div>
      ))}
      {loadError ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p className="m-0 text-[12px] text-muted-foreground">
            Attached images could not be loaded.
          </p>
          <Button type="button" variant="quiet" className="h-7 px-2 text-[12px]" onClick={reload}>
            Retry
          </Button>
        </div>
      ) : null}
      {(attachments ?? []).map((attachment) => (
        <AttachmentCard
          key={attachment.id}
          archived={archived}
          engagementId={engagementId}
          attachment={attachment}
          onChanged={(next) =>
            setAttachments((current) =>
              (current ?? []).map((row) => (row.id === next.id ? next : row)),
            )
          }
          onDerived={(child) => setAttachments((current) => [...(current ?? []), child])}
          onInsert={onInsert}
        />
      ))}
    </div>
  );
}

function AttachmentCard({
  archived,
  engagementId,
  attachment,
  onChanged,
  onDerived,
  onInsert,
}: {
  archived: boolean;
  engagementId: string;
  attachment: Attachment;
  onChanged: (next: Attachment) => void;
  onDerived: (child: Attachment) => void;
  onInsert: (snippet: string) => void;
}) {
  const [caption, setCaption] = useState(attachment.caption);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [crop, setCrop] = useState({ x: "0", y: "0", width: "100", height: "60" });
  const [deriving, setDeriving] = useState(false);
  const [deriveError, setDeriveError] = useState<string | undefined>(undefined);
  const [natural, setNatural] = useState<{ width: number; height: number } | undefined>(undefined);

  const saveCaption = () => {
    if (saving) return;
    setSaving(true);
    setSaveError(undefined);
    void patchAttachmentCaption(engagementId, attachment.id, caption)
      .then(onChanged)
      .catch(() => setSaveError("Caption could not be saved. Retry."))
      .finally(() => setSaving(false));
  };

  const derive = () => {
    if (deriving) return;
    const rect = {
      x: Number(crop.x),
      y: Number(crop.y),
      width: Number(crop.width),
      height: Number(crop.height),
    };
    if (
      !Number.isSafeInteger(rect.x) ||
      !Number.isSafeInteger(rect.y) ||
      !Number.isSafeInteger(rect.width) ||
      !Number.isSafeInteger(rect.height) ||
      rect.x < 0 ||
      rect.y < 0 ||
      rect.width < 1 ||
      rect.height < 1
    ) {
      setDeriveError("Enter a valid crop rectangle in image pixels.");
      return;
    }
    setDeriving(true);
    setDeriveError(undefined);
    void deriveAttachment(engagementId, attachment.id, {
      caption: caption.length > 0 ? `Crop: ${caption}` : `Crop of ${attachment.filename}`,
      crop: rect,
    })
      .then(onDerived)
      .catch(() => setDeriveError("The derived copy could not be saved. Retry."))
      .finally(() => setDeriving(false));
  };

  const clip =
    attachment.crop !== null && natural !== undefined && natural.width > 0 && natural.height > 0
      ? {
          clipPath: `inset(${(attachment.crop.y / natural.height) * 100}% ${
            Math.max(0, 100 - ((attachment.crop.x + attachment.crop.width) / natural.width) * 100)
          }% ${Math.max(0, 100 - ((attachment.crop.y + attachment.crop.height) / natural.height) * 100)}% ${
            (attachment.crop.x / natural.width) * 100
          }%)`,
        }
      : undefined;

  return (
    <div className="mt-2 grid gap-2 rounded-md border border-border px-2.5 py-2">
      <img
        src={attachmentContentUrl(engagementId, attachment.id)}
        alt={attachment.caption.length > 0 ? attachment.caption : attachment.filename}
        className="max-h-40 w-auto"
        style={clip}
        onLoad={(event) =>
          setNatural({
            width: event.currentTarget.naturalWidth,
            height: event.currentTarget.naturalHeight,
          })
        }
      />
      <p className="m-0 font-mono text-[11px] text-muted-foreground">
        {attachment.filename}
        {attachment.targetLabel !== null ? ` · target: ${attachment.targetLabel}` : ""}
        {attachment.parentAttachmentId !== null ? " · derived copy, original kept" : ""}
        {attachment.crop !== null
          ? ` · crop ${attachment.crop.x},${attachment.crop.y} ${attachment.crop.width}x${attachment.crop.height}`
          : ""}
      </p>
      {!archived ? (
        <>
          <label className="grid gap-1 text-[11px] text-muted-foreground">
            <span>Caption</span>
            <input
              value={caption}
              disabled={saving}
              maxLength={280}
              aria-label={`Caption for ${attachment.filename}`}
              className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-[12px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => setCaption(event.target.value)}
            />
          </label>
          {saveError !== undefined ? (
            <p className="m-0 text-[12px] text-destructive" role="alert">
              {saveError}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-muted-foreground">Crop in image pixels:</span>
            {(["x", "y", "width", "height"] as const).map((key) => (
              <label key={key} className="grid gap-1 text-[11px] text-muted-foreground">
                <span>{key}</span>
                <input
                  value={crop[key]}
                  disabled={deriving}
                  inputMode="numeric"
                  aria-label={`${key} of crop for ${attachment.filename}`}
                  className="w-20 rounded-md border border-input bg-transparent px-2 py-1.5 text-[12px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onChange={(event) =>
                    setCrop((current) => ({ ...current, [key]: event.target.value }))
                  }
                />
              </label>
            ))}
          </div>
          {deriveError !== undefined ? (
            <p className="m-0 text-[12px] text-destructive" role="alert">
              {deriveError}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" disabled={saving} onClick={saveCaption}>
              {saving ? "Saving" : "Save caption"}
            </Button>
            <Button type="button" variant="secondary" disabled={deriving} onClick={derive}>
              {deriving ? "Copying" : "Create cropped copy"}
            </Button>
            <Button
              type="button"
              variant="quiet"
              className="h-7 px-2 text-[12px]"
              onClick={() =>
                onInsert(
                  `![${attachment.caption.length > 0 ? attachment.caption : attachment.filename}](attachment:${attachment.id})`,
                )
              }
            >
              Insert into note
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
