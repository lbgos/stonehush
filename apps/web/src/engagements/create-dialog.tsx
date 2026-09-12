import {
  CreateEngagementRequestSchema,
  EngagementKindSchema,
  type CreateEngagementInput,
  type Engagement,
  type EngagementKind,
  type SavedScopeRule,
} from "@stonehush/contracts";
import { normalizeTarget } from "@stonehush/domain";
import { Button, cn } from "@stonehush/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { createActionRequest } from "./action-mutations.js";
import { parsePlannedTargets } from "./action-targets.js";
import {
  EngagementMutationClientError,
  engagementMutationMessage,
  EngagementNotesMutationClientError,
  engagementNotesMutationMessage,
  isRevisionConflict,
} from "./errors.js";
import {
  browserStorage,
  buildChallengeNotes,
  mergeStartDescription,
  parseDeadlineDraft,
  splitStartTargets,
  storeLastEngagementId,
  suggestEngagementName,
} from "./first-action.js";
import { ENGAGEMENT_KIND_LABELS } from "./format.js";
import { createIntentKeyHolder, requestFingerprint } from "./idempotency.js";
import {
  appendScopeRevisionRequest,
  upsertEngagementInCache,
  useCreateEngagementMutation,
} from "./mutations.js";
import { fetchEngagementDetail } from "./query.js";
import { fetchEngagementNotes, saveEngagementNotesRequest } from "./notes-query.js";
import { runHistoryQueryKey } from "./run-history-query.js";
import { createDraftScopeRule } from "./scope-rules.js";
import { useEngagementWorkspace } from "./workspace-context.js";

const KIND_OPTIONS = EngagementKindSchema.options;

const CHALLENGE_FILE_MAX_BYTES = 256 * 1024;
const CHALLENGE_TEXT_MAX_CHARS = 70_000;

interface CreateEngagementDialogProps {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

interface FormFields {
  authorizationContext: string;
  autoContinueWarnings: boolean;
  deadline: string;
  description: string;
  kind: EngagementKind;
  name: string;
  platformUrl: string;
  saveAsScope: boolean;
  targetInput: string;
}

interface ChallengeDraft {
  name: string;
  text: string;
  truncated: boolean;
}

// Progress across the start phases. Creation, scope save, and the first scan
// run in order; once the engagement exists, retries resume the follow-up
// phases instead of creating a duplicate engagement.
interface StartedProgress {
  engagement: Engagement;
  revision: number;
  scopeId: string | null;
  scopeDone: boolean;
}

type FieldKey =
  | "authorizationContext"
  | "deadline"
  | "description"
  | "name"
  | "platformUrl"
  | "targetInput";

const emptyForm: FormFields = {
  authorizationContext: "",
  autoContinueWarnings: false,
  deadline: "",
  description: "",
  kind: "ctf",
  name: "",
  platformUrl: "",
  saveAsScope: false,
  targetInput: "",
};

function optionalContext(value: string): string | null {
  return value.trim() === "" ? null : value;
}

function fieldError(message: string | undefined): string | undefined {
  if (message === undefined) return undefined;
  if (message.includes("leading or trailing")) {
    return "Name cannot start or end with spaces.";
  }
  if (message.includes("between 1 and 120")) {
    return "Name must be between 1 and 120 characters.";
  }
  if (message.includes("at most 4096")) {
    return "This field must be at most 4096 characters.";
  }
  return "Check this field and try again.";
}

function submitMessage(error: unknown): string {
  if (error instanceof EngagementMutationClientError) return error.message;
  if (error instanceof EngagementNotesMutationClientError) {
    return engagementNotesMutationMessage(error);
  }
  if (error instanceof Error && error.message !== "") return error.message;
  return engagementMutationMessage(error);
}

export function CreateEngagementDialog({ onOpenChange, open }: CreateEngagementDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const nameId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [fields, setFields] = useState<FormFields>(emptyForm);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [challenge, setChallenge] = useState<ChallengeDraft | null>(null);
  const [challengeError, setChallengeError] = useState<string | undefined>(undefined);
  const [fileKey, setFileKey] = useState(0);
  // Sequence guard for async file reads. A slow read from an earlier file
  // (or a read that finishes after the dialog closed) must not overwrite or
  // repopulate the current attachment.
  const challengeReadRef = useRef(0);
  const [submitError, setSubmitError] = useState<string | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const [started, setStarted] = useState<StartedProgress | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const createEngagement = useCreateEngagementMutation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { announce } = useEngagementWorkspace();
  // One key per scope and action intent. Unchanged retries reuse the key so a
  // committed operation with a lost response replays; a changed body gets a
  // new key. Engagement creation already uses its holder inside the mutation.
  const scopeKeys = useRef(createIntentKeyHolder());
  const actionKeys = useRef(createIntentKeyHolder());
  const retained = started !== null;
  const scopeLocked = started?.scopeDone === true;
  const hasOptionErrors =
    fieldErrors.platformUrl !== undefined ||
    fieldErrors.deadline !== undefined ||
    fieldErrors.description !== undefined ||
    fieldErrors.authorizationContext !== undefined;

  useEffect(() => {
    if (hasOptionErrors) setOptionsOpen(true);
  }, [hasOptionErrors]);

  useEffect(() => {
    if (!open) {
      createEngagement.reset();
      setFields(emptyForm);
      setFieldErrors({});
      setChallenge(null);
      setChallengeError(undefined);
      setSubmitError(undefined);
      setStarting(false);
      setStarted(null);
      setOptionsOpen(false);
      // Invalidate any in-flight file read so a late completion cannot
      // repopulate the attachment after the reset.
      challengeReadRef.current += 1;
      setFileKey((current) => current + 1);
      const returnFocus = returnFocusRef.current;
      returnFocusRef.current = null;
      if (returnFocus && document.contains(returnFocus)) {
        returnFocus.focus();
      }
      return;
    }
    const active = document.activeElement;
    returnFocusRef.current = active instanceof HTMLElement ? active : null;
    const frame = window.requestAnimationFrame(() => nameRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  if (!open) return null;

  const pending = createEngagement.isPending || starting;
  const suggestedName = suggestEngagementName(splitStartTargets(fields.targetInput));
  const showSuggestion = fields.name.trim() === "" && fields.targetInput.trim() !== "";

  const onChallengeFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > CHALLENGE_FILE_MAX_BYTES) {
      setChallenge(null);
      setChallengeError("That file is larger than 256 KB. Paste the relevant part instead.");
      setFileKey((current) => current + 1);
      return;
    }
    challengeReadRef.current += 1;
    const readSeq = challengeReadRef.current;
    void file
      .text()
      .then((text) => {
        if (challengeReadRef.current !== readSeq) return;
        const truncated = text.length > CHALLENGE_TEXT_MAX_CHARS;
        setChallenge({
          name: file.name,
          text: truncated ? text.slice(0, CHALLENGE_TEXT_MAX_CHARS) : text,
          truncated,
        });
        setChallengeError(undefined);
      })
      .catch(() => {
        if (challengeReadRef.current !== readSeq) return;
        setChallenge(null);
        setChallengeError("That file could not be read.");
        setFileKey((current) => current + 1);
      });
  };

  const clearChallenge = () => {
    // A pending read for the removed file must not repopulate the attachment.
    challengeReadRef.current += 1;
    setChallenge(null);
    setChallengeError(undefined);
    setFileKey((current) => current + 1);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void runSubmit();
  };

  const runSubmit = async () => {
    if (pending) return;
    const nextErrors: Partial<Record<FieldKey, string>> = {};

    // Targets accept an IP, hostname, URL, or a pasted list. Empty is only
    // valid with a challenge file, which starts note-taking without a scan.
    const rawTargets = fields.targetInput.trim();
    let targets: string[] = [];
    if (rawTargets !== "") {
      const parsedTargets = parsePlannedTargets(fields.targetInput);
      if (!parsedTargets.ok) {
        nextErrors.targetInput = parsedTargets.message;
      } else {
        targets = parsedTargets.targets;
      }
    }

    let platformUrl = "";
    if (fields.platformUrl.trim() !== "") {
      const normalized = normalizeTarget(fields.platformUrl.trim());
      if (!normalized.ok || normalized.target.kind !== "url") {
        nextErrors.platformUrl = "Enter a valid URL, for example https://host.test/.";
      } else {
        platformUrl = fields.platformUrl.trim();
      }
    }

    let deadlineIso: string | null = null;
    const deadline = parseDeadlineDraft(fields.deadline);
    if (deadline.kind === "error") {
      nextErrors.deadline = deadline.message;
    } else if (deadline.kind === "iso") {
      deadlineIso = deadline.iso;
    }

    const name = fields.name.trim() === "" ? suggestedName : fields.name.trim();
    const description = mergeStartDescription({
      challengeNote: challenge ? `Challenge file: ${challenge.name}` : undefined,
      description: fields.description,
      platformUrl,
    });
    const input: CreateEngagementInput = {
      authorizationContext: optionalContext(fields.authorizationContext),
      autoContinueWarnings: fields.autoContinueWarnings,
      description,
      kind: fields.kind,
      name,
      ...(deadlineIso === null ? {} : { deadlineAt: deadlineIso }),
    };
    const parsed = CreateEngagementRequestSchema.safeParse(input);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (key === "name" || key === "description" || key === "authorizationContext") {
          const message = fieldError(issue.message);
          if (message !== undefined) nextErrors[key] = message;
        } else if (key === "deadlineAt") {
          nextErrors.deadline = "The deadline must be within 10 years.";
        }
      }
    }

    if (targets.length === 0 && challenge === null && nextErrors.targetInput === undefined) {
      nextErrors.targetInput = "Enter at least one target or attach a challenge file.";
    }

    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0 || !parsed.success) return;

    setSubmitError(undefined);
    setStarting(true);
    let attempted: StartedProgress | null = started;
    try {
      // Creation, scope save, and the first scan are separate phases. Once
      // the engagement exists, retries resume the follow-up phases on it
      // instead of creating a duplicate engagement.
      let progress = started;
      if (progress === null) {
        const engagement: Engagement = await createEngagement.mutateAsync(parsed.data);
        storeLastEngagementId(browserStorage(), engagement.id);
        progress = {
          engagement,
          revision: engagement.revision,
          scopeId: engagement.activeScopeRevisionId,
          scopeDone: !(fields.saveAsScope && targets.length > 0),
        };
        setStarted(progress);
      }
      attempted = progress;

      if (fields.saveAsScope && targets.length > 0 && !progress.scopeDone) {
        const rules: SavedScopeRule[] = [];
        for (const target of targets) {
          const drafted = createDraftScopeRule({
            includeSubdomains: false,
            portRanges: "",
            rawTarget: target,
          });
          if (!drafted.ok) throw new Error(drafted.message);
          rules.push(drafted.rule);
        }
        const scopeBody = { expectedRevision: progress.revision, rules };
        // Fingerprint the stable scope intent (targets), not the rule ids:
        // createDraftScopeRule mints a fresh id per build, so fingerprinting
        // rules would give every retry a new key and defeat replay.
        const scopeIntent = requestFingerprint({
          engagementId: progress.engagement.id,
          expectedRevision: scopeBody.expectedRevision,
          targets,
        });
        const scopeRevision = await appendScopeRevisionRequest(
          progress.engagement.id,
          scopeBody,
          scopeKeys.current.keyFor(scopeIntent),
        );
        scopeKeys.current.reset(scopeIntent);
        progress = {
          ...progress,
          revision: progress.revision + 1,
          scopeId: scopeRevision.id,
          scopeDone: true,
        };
        setStarted(progress);
        upsertEngagementInCache(queryClient, {
          ...progress.engagement,
          revision: progress.revision,
          activeScopeRevisionId: progress.scopeId,
          updatedAt: scopeRevision.createdAt,
        });
        attempted = progress;
      }

      if (targets.length > 0) {
        const actionBody = {
          expectedEngagementRevision: progress.revision,
          expectedActiveScopeRevisionId: progress.scopeId,
          targets,
          declaredPorts: null,
        } as const;
        const actionIntent = requestFingerprint({
          engagementId: progress.engagement.id,
          ...actionBody,
        });
        const action = await createActionRequest(
          progress.engagement.id,
          {
            expectedEngagementRevision: actionBody.expectedEngagementRevision,
            expectedActiveScopeRevisionId: actionBody.expectedActiveScopeRevisionId,
            targets: [...actionBody.targets],
            declaredPorts: actionBody.declaredPorts,
          },
          actionKeys.current.keyFor(actionIntent),
        );
        actionKeys.current.reset(actionIntent);
        // The readiness summary reads run history, so refresh it after the
        // action is persisted instead of leaving "no runs yet" until a remount.
        void queryClient.invalidateQueries({
          queryKey: runHistoryQueryKey(progress.engagement.id),
        });
        const paused = action.action.state === "paused_for_warning";
        if (paused) {
          announce(`Action ${action.action.actionId} needs one warning before it runs.`);
        } else {
          announce(
            `Engagement ${progress.engagement.name} created. First scan queued for ${targets[0] ?? ""}.`,
          );
        }
        onOpenChange(false);
        void navigate({
          to: "/engagements/$engagementId",
          params: { engagementId: progress.engagement.id },
          // A paused scan carries its action id along so the planner can load
          // the warning card. Without it Continue would be unreachable.
          ...(paused ? { search: { action: action.action.actionId } } : {}),
        });
        return;
      }

      if (challenge !== null) {
        try {
          const notes = await fetchEngagementNotes(progress.engagement.id);
          const fileNotes = buildChallengeNotes(challenge.name, challenge.text, challenge.truncated);
          const markdown =
            notes.markdown.trim() === "" ? fileNotes : `${notes.markdown}\n\n${fileNotes}`;
          await saveEngagementNotesRequest(progress.engagement.id, {
            markdown,
            expectedRevision: notes.revision,
          });
        } catch {
          announce(
            `Engagement ${progress.engagement.name} created. Challenge notes were not saved; re-attach ${challenge.name} from the notes tab.`,
          );
        }
      }
      onOpenChange(false);
      void navigate({
        to: "/engagements/$engagementId",
        params: { engagementId: progress.engagement.id },
        search: { tab: "notes" },
      });
    } catch (error) {
      setSubmitError(submitMessage(error));
      if (error instanceof EngagementMutationClientError) {
        if (error.code === "engagement_not_found" || error.code === "engagement_archived") {
          // The retained engagement is gone; the next submit starts over.
          setStarted(null);
        } else if (isRevisionConflict(error)) {
          // Refresh both concurrency values together from the server. Keeping
          // a fresh revision with a stale scope id stays blocked.
          const retainedProgress = attempted;
          if (retainedProgress !== null) {
            try {
              const detail = await fetchEngagementDetail(retainedProgress.engagement.id);
              if (detail.engagement.status === "archived") {
                setStarted(null);
              } else {
                setStarted((current) =>
                  current === null
                    ? current
                    : {
                        ...current,
                        engagement: {
                          ...current.engagement,
                          revision: detail.engagement.revision,
                          activeScopeRevisionId: detail.engagement.activeScopeRevisionId,
                          updatedAt: detail.engagement.updatedAt,
                        },
                        revision: detail.engagement.revision,
                        scopeId: detail.engagement.activeScopeRevisionId,
                      },
                );
                upsertEngagementInCache(queryClient, {
                  ...retainedProgress.engagement,
                  revision: detail.engagement.revision,
                  activeScopeRevisionId: detail.engagement.activeScopeRevisionId,
                  updatedAt: detail.engagement.updatedAt,
                });
              }
            } catch {
              // Keep retained values on refresh failure. The next retry
              // refetches again; a gone engagement clears via not_found above.
            }
          }
        }
      }
    } finally {
      setStarting(false);
    }
  };

  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!pending) onOpenChange(false);
      return;
    }
    if (event.key !== "Tab") return;
    const root = dialogRef.current;
    if (!root) return;
    const focusable = Array.from(
      root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((node) => !node.hasAttribute("disabled"));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const mutationError = createEngagement.isError
    ? engagementMutationMessage(createEngagement.error)
    : undefined;

  return createPortal(
    <div className="fixed inset-0 z-[70] grid place-items-center p-6">
      <button
        type="button"
        aria-label="Dismiss dialog"
        className="absolute inset-0 bg-black/62"
        onClick={() => {
          if (!pending) onOpenChange(false);
        }}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="relative max-h-[calc(100vh-3rem)] w-full max-w-[520px] overflow-y-auto rounded-[10px] border border-border bg-popover p-5 text-popover-foreground shadow-[0_24px_64px_rgba(0,0,0,0.6)] backdrop-blur-glass"
        data-keybinding-capture=""
        onKeyDown={onDialogKeyDown}
      >
        <p className="m-0 text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
          New engagement
        </p>
        <h2 id={titleId} className="mt-2 mb-1 text-lg font-semibold tracking-[-0.03em]">
          Start an engagement
        </h2>
        <p id={descriptionId} className="mt-0 mb-4 text-sm text-muted-foreground">
          Paste a target to queue the first scan, or attach a challenge file to start with notes.
        </p>
        <form className="grid gap-3" onSubmit={submit}>
          <Field
            {...(fieldErrors.name ? { error: fieldErrors.name } : {})}
            htmlFor={nameId}
            label="Name"
            hint="Optional. A name is suggested from the first target."
          >
            <input
              ref={nameRef}
              id={nameId}
              name="name"
              value={fields.name}
              maxLength={120}
              placeholder={suggestedName}
              disabled={pending || retained}
              className={fieldClassName(fieldErrors.name !== undefined)}
              onChange={(event) => setFields((current) => ({ ...current, name: event.target.value }))}
            />
            {showSuggestion && (
              <span className="text-muted-foreground">Suggested name: {suggestedName}</span>
            )}
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Type" htmlFor={`${nameId}-kind`}>
              <select
                id={`${nameId}-kind`}
                name="kind"
                value={fields.kind}
                disabled={pending || retained}
                className={fieldClassName(false)}
                onChange={(event) =>
                  setFields((current) => ({
                    ...current,
                    kind: event.target.value as EngagementKind,
                  }))
                }
              >
                {KIND_OPTIONS.map((kind) => (
                  <option key={kind} value={kind}>
                    {ENGAGEMENT_KIND_LABELS[kind]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Challenge file" htmlFor={`${nameId}-challenge`}>
              <input
                key={fileKey}
                id={`${nameId}-challenge`}
                name="challengeFile"
                type="file"
                accept=".txt,.md,.markdown,.text,text/plain"
                className="min-h-11 w-full text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-8"
                onChange={onChallengeFile}
              />
              {challenge && (
                <span className="flex flex-wrap items-center gap-2 text-foreground">
                  <span>{challenge.name}</span>
                  <Button
                    type="button"
                    variant="quiet"
                    onClick={(event) => {
                      event.preventDefault();
                      clearChallenge();
                    }}
                  >
                    Remove
                  </Button>
                </span>
              )}
              {challengeError && (
                <span className="text-destructive" role="alert">
                  {challengeError}
                </span>
              )}
            </Field>
          </div>
          <Field
            {...(fieldErrors.targetInput ? { error: fieldErrors.targetInput } : {})}
            htmlFor={`${nameId}-targets`}
            label="Targets"
            hint="IP, hostname, URL, or a pasted list. Leave empty only with a challenge file."
          >
            <textarea
              id={`${nameId}-targets`}
              name="targets"
              value={fields.targetInput}
              rows={3}
              placeholder={"192.0.2.10\n198.51.100.10"}
              autoComplete="off"
              spellCheck={false}
              disabled={pending || scopeLocked}
              className={cn(fieldClassName(fieldErrors.targetInput !== undefined), "min-h-20 py-2 font-mono")}
              onChange={(event) =>
                setFields((current) => ({ ...current, targetInput: event.target.value }))
              }
            />
          </Field>
          <details
            open={optionsOpen}
            onToggle={(event) => setOptionsOpen(event.currentTarget.open)}
          >
            <summary className="min-h-11 cursor-pointer text-[12px] font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-8">
              More options
            </summary>
            <div className="grid gap-3 pt-2">
              <Field
                {...(fieldErrors.platformUrl ? { error: fieldErrors.platformUrl } : {})}
                htmlFor={`${nameId}-platform`}
                label="Platform URL"
                hint="Optional link kept as context, for example the challenge page."
              >
                <input
                  id={`${nameId}-platform`}
                  name="platformUrl"
                  value={fields.platformUrl}
                  placeholder="https://host.test/challenge"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={pending || retained}
                  className={cn(fieldClassName(fieldErrors.platformUrl !== undefined), "font-mono")}
                  onChange={(event) =>
                    setFields((current) => ({ ...current, platformUrl: event.target.value }))
                  }
                />
              </Field>
              <Field
                {...(fieldErrors.deadline ? { error: fieldErrors.deadline } : {})}
                htmlFor={`${nameId}-deadline`}
                label="Deadline"
                hint="Optional. Shown as a countdown in the workspace."
              >
                <input
                  id={`${nameId}-deadline`}
                  name="deadline"
                  type="datetime-local"
                  value={fields.deadline}
                  disabled={pending || retained}
                  className={fieldClassName(fieldErrors.deadline !== undefined)}
                  onChange={(event) =>
                    setFields((current) => ({ ...current, deadline: event.target.value }))
                  }
                />
              </Field>
              <Field
                {...(fieldErrors.description ? { error: fieldErrors.description } : {})}
                htmlFor={`${nameId}-description`}
                label="Description"
              >
                <textarea
                  id={`${nameId}-description`}
                  name="description"
                  value={fields.description}
                  rows={3}
                  placeholder="Optional context for this engagement"
                  disabled={pending || retained}
                  className={cn(fieldClassName(fieldErrors.description !== undefined), "min-h-20 py-2")}
                  onChange={(event) =>
                    setFields((current) => ({ ...current, description: event.target.value }))
                  }
                />
              </Field>
              <Field
                {...(fieldErrors.authorizationContext
                  ? { error: fieldErrors.authorizationContext }
                  : {})}
                htmlFor={`${nameId}-authorization`}
                label="Authorization context"
              >
                <textarea
                  id={`${nameId}-authorization`}
                  name="authorizationContext"
                  value={fields.authorizationContext}
                  rows={3}
                  placeholder="Optional authorization notes"
                  disabled={pending || retained}
                  className={cn(
                    fieldClassName(fieldErrors.authorizationContext !== undefined),
                    "min-h-20 py-2",
                  )}
                  onChange={(event) =>
                    setFields((current) => ({
                      ...current,
                      authorizationContext: event.target.value,
                    }))
                  }
                />
              </Field>
              <label className="flex min-h-11 items-start gap-3 text-sm text-foreground">
                <input
                  type="checkbox"
                  name="saveAsScope"
                  checked={fields.saveAsScope}
                  disabled={pending || scopeLocked}
                  className="mt-1 size-4 accent-primary"
                  onChange={(event) =>
                    setFields((current) => ({ ...current, saveAsScope: event.target.checked }))
                  }
                />
                <span>Also save these targets as scope</span>
              </label>
              <label className="flex min-h-11 items-start gap-3 text-sm text-foreground">
                <input
                  type="checkbox"
                  name="autoContinueWarnings"
                  checked={fields.autoContinueWarnings}
                  disabled={pending || retained}
                  className="mt-1 size-4 accent-primary"
                  onChange={(event) =>
                    setFields((current) => ({
                      ...current,
                      autoContinueWarnings: event.target.checked,
                    }))
                  }
                />
                <span>Always continue warnings for this engagement</span>
              </label>
            </div>
          </details>
          {mutationError && (
            <p className="m-0 text-[13px] text-destructive" role="alert">
              {mutationError}
            </p>
          )}
          {submitError && (
            <p className="m-0 text-sm text-destructive" role="alert">
              {submitError}
            </p>
          )}
          {started !== null ? (
            <p className="m-0 text-[12px] leading-5 text-muted-foreground">
              Engagement {started.engagement.name} is created. Retry continues on it, so
              name, type, and saved options stay fixed here.{" "}
              <button
                type="button"
                className="cursor-pointer text-foreground underline outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  onOpenChange(false);
                  void navigate({
                    to: "/engagements/$engagementId",
                    params: { engagementId: started.engagement.id },
                  });
                }}
              >
                Open engagement
              </button>{" "}
              <button
                type="button"
                className="cursor-pointer text-foreground underline outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setStarted(null)}
              >
                Discard and start over
              </button>
            </p>
          ) : null}
          <div className="mt-1 flex flex-wrap gap-2">
            <Button disabled={pending} type="submit">
              {pending ? "Starting" : "Start engagement"}
            </Button>
            <Button
              disabled={pending}
              type="button"
              variant="quiet"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

function Field({
  children,
  error,
  hint,
  htmlFor,
  label,
}: {
  children: ReactNode;
  error?: string;
  hint?: string;
  htmlFor: string;
  label: string;
}) {
  return (
    <label className="grid gap-1 text-xs text-muted-foreground" htmlFor={htmlFor}>
      <span>{label}</span>
      {children}
      {hint && !error && <span>{hint}</span>}
      {error && (
        <span className="text-destructive" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

function fieldClassName(invalid: boolean) {
  return cn(
    "min-h-11 w-full rounded-md border bg-transparent px-2.5 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-8",
    invalid ? "border-destructive" : "border-input",
  );
}
