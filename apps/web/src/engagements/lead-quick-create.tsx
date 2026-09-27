import { Button } from "@stonehush/ui";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

import {
  focusSurfaceRow,
  leadCreateInput,
  leadFieldFits,
  restoreSurfacePosition,
  type LeadStartContext,
  type SurfaceLeadSourceKind,
} from "./inspector.js";
import {
  LEAD_MUTATION_ERROR_MESSAGE,
  LeadMutationClientError,
  useCreateLeadMutation,
} from "./leads-query.js";

// Start a lead from a surface row: one title field over the row's source.
// Opens like the action launchers and returns focus and scroll to the row
// or inspector button that opened it.

const SOURCE_KIND_LABELS: Record<SurfaceLeadSourceKind, string> = {
  nmap_service: "Nmap service",
  http_probe: "HTTP probe",
  ffuf_result: "Path discovery",
};

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface LeadQuickCreateProps {
  readonly archived: boolean;
  readonly context: LeadStartContext;
  readonly engagementId: string;
  readonly onClose: () => void;
}

export function LeadQuickCreate({ archived, context, engagementId, onClose }: LeadQuickCreateProps) {
  const titleId = useId();
  const inputId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Captured during the first render, before focus moves into the dialog.
  const [returnTo] = useState(() => ({
    element: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    scrollY: window.scrollY,
  }));
  const [title, setTitle] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const create = useCreateLeadMutation(engagementId);
  const dirty = title.trim().length > 0;

  useEffect(() => {
    (inputRef.current?.disabled === false ? inputRef.current : dialogRef.current)?.focus({
      preventScroll: true,
    });
  }, []);

  const close = () => {
    onClose();
    requestAnimationFrame(() => {
      restoreSurfacePosition(returnTo.scrollY, undefined);
      if (returnTo.element !== null && document.contains(returnTo.element)) {
        returnTo.element.focus({ preventScroll: true });
      } else {
        focusSurfaceRow(context.sourceKey);
      }
    });
  };

  // A typed title only goes away through the Discard button.
  const attemptClose = () => {
    if (create.isPending) return;
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    close();
  };

  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      attemptClose();
      return;
    }
    if (event.key !== "Tab") return;
    const root = dialogRef.current;
    if (!root) return;
    const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
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

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (archived || create.isPending) return;
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      setFieldError("Enter a lead title.");
      return;
    }
    setFieldError(undefined);
    setConfirmDiscard(false);
    create.mutate(leadCreateInput(context, trimmed), {
      onError: () => inputRef.current?.focus(),
      onSuccess: close,
    });
  };

  const mutationError = create.isError
    ? create.error instanceof LeadMutationClientError
      ? create.error.message
      : LEAD_MUTATION_ERROR_MESSAGE
    : undefined;

  return createPortal(
    <div className="fixed inset-0 z-[70] grid place-items-center p-6">
      <button
        type="button"
        aria-label="Dismiss lead form"
        className="absolute inset-0 bg-black/62"
        onClick={attemptClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-labelledby={titleId}
        className="relative max-h-full w-full max-w-[520px] overflow-y-auto rounded-[10px] border border-border bg-popover p-5 text-popover-foreground shadow-[0_24px_64px_rgba(0,0,0,0.6)]"
        data-keybinding-capture=""
        onKeyDown={onDialogKeyDown}
      >
        <div className="flex items-start justify-between gap-2">
          <h2 id={titleId} className="m-0 text-[15px] font-semibold tracking-[-0.02em]">
            Start a lead
          </h2>
          <Button type="button" variant="quiet" className="h-7 px-2 text-[12px]" onClick={attemptClose}>
            Close
          </Button>
        </div>
        {confirmDiscard ? (
          <div className="mt-3 rounded-md border border-border px-3 py-2" role="alert">
            <p className="m-0 text-[12px] text-foreground">Discard this lead title?</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button type="button" variant="secondary" onClick={close}>
                Discard
              </Button>
              <Button
                type="button"
                variant="quiet"
                onClick={() => {
                  setConfirmDiscard(false);
                  inputRef.current?.focus();
                }}
              >
                Keep editing
              </Button>
            </div>
          </div>
        ) : null}
        <form className="mt-4 grid gap-3" onSubmit={submit}>
          {archived ? (
            <p className="m-0 text-[12px] leading-5 text-muted-foreground">
              This engagement is archived. Leads can be viewed but not changed.
            </p>
          ) : null}
          <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={inputId}>
            <span>Title</span>
            <input
              ref={inputRef}
              id={inputId}
              value={title}
              autoComplete="off"
              maxLength={120}
              disabled={archived}
              readOnly={create.isPending}
              placeholder="Does this origin expose a login?"
              className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <dl className="m-0 grid gap-2">
            <ContextField
              term={`Source · ${SOURCE_KIND_LABELS[context.sourceKind]}`}
              value={context.sourceText}
            />
            <ContextField
              stored={leadFieldFits(context.target)}
              term="Target"
              value={context.target}
            />
            <ContextField
              stored={leadFieldFits(context.serviceRef)}
              term="Service"
              value={context.serviceRef}
            />
          </dl>
          {fieldError !== undefined ? (
            <p className="m-0 text-[13px] text-destructive" role="alert">
              {fieldError}
            </p>
          ) : null}
          {mutationError !== undefined ? (
            <p className="m-0 text-[13px] text-destructive" role="alert">
              {mutationError}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={archived || create.isPending}>
              {create.isPending ? "Saving" : "Save lead"}
            </Button>
            <Button type="button" variant="quiet" disabled={create.isPending} onClick={attemptClose}>
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

// Shows the full observed value. A target or service the lead contract
// cannot hold is still shown, with a note that the lead will not store it.
function ContextField({
  stored = true,
  term,
  value,
}: {
  stored?: boolean;
  term: string;
  value: string | null;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] tracking-[0.04em] text-muted-foreground uppercase">{term}</dt>
      <dd
        className="mt-0.5 mb-0 line-clamp-3 break-all font-mono text-[12px] text-foreground"
        title={value ?? undefined}
      >
        {value ?? "None"}
      </dd>
      {value !== null && !stored ? (
        <p className="m-0 mt-0.5 text-[11px] text-muted-foreground">
          {Array.from(value).length > 253
            ? "Not saved on the lead: longer than 253 characters."
            : "Not saved on the lead."}
        </p>
      ) : null}
    </div>
  );
}
