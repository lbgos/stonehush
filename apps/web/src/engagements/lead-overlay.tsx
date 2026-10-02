import type { Lead } from "@stonehush/contracts";
import { Button, LoadingRegion, RecoverableError, Skeleton } from "@stonehush/ui";
import { useBlocker } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { focusSurfaceRow, restoreSurfacePosition, type LeadOpenRequest } from "./inspector.js";
import { LeadDetail, type LeadDraftState } from "./leads.js";
import { exactLeadRead, useLeadQuery } from "./leads-query.js";

// Continue a lead over Surface, from an inspector's linked lead button or from
// the Resume band. Surface stays mounted underneath with its route unchanged.
// The overlay reads the exact lead again before showing its detail, reuses
// the Leads tab detail for attempts and park, and returns focus to its
// opener. An unsaved draft, an in-flight write, or a failed held route guards
// Close, Escape, the backdrop, and route changes.

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const NO_DRAFT: LeadDraftState = { dirty: false, pending: false, failed: false };

// Who opened the overlay. A Surface opener names the evidence the lead must
// still reference and the row focus returns to. Resume names only the lead
// and its button; it never stands in for an inspector selection.
export type LeadOverlayOrigin =
  | { readonly kind: "surface"; readonly request: LeadOpenRequest }
  | {
      readonly kind: "resume";
      readonly leadId: string;
      readonly trigger: HTMLElement | null;
      // Drops the remembered pointer after the server says the lead is gone.
      readonly onForget: () => void;
    };

export function overlayLeadId(origin: LeadOverlayOrigin): string {
  return origin.kind === "surface" ? origin.request.leadId : origin.leadId;
}

type LeadView = ReturnType<typeof exactLeadRead> | { readonly state: "moved" };

// The query belongs to this opening. A different id or engagement, or a
// Surface lead whose source no longer names its evidence, cannot become
// editable.
function leadView(
  query: ReturnType<typeof useLeadQuery>,
  origin: LeadOverlayOrigin,
  engagementId: string,
): LeadView {
  const read = exactLeadRead(query, engagementId, overlayLeadId(origin));
  if (read.state === "ready" && origin.kind === "surface" && read.lead.source.ref !== origin.request.artifactId) {
    return { state: "moved" };
  }
  return read;
}

export interface LeadOverlayProps {
  readonly archived: boolean;
  readonly engagementId: string;
  readonly origin: LeadOverlayOrigin;
  readonly onClose: () => void;
  // Called with the lead each time a fresh read validates for this origin.
  readonly onValidRead?: ((lead: Lead) => void) | undefined;
}

export function LeadOverlay({ archived, engagementId, origin, onClose, onValidRead }: LeadOverlayProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const resumeFocusRef = useRef<HTMLElement | null>(null);
  const acknowledgedNavigationRef = useRef<(() => void) | undefined>(undefined);
  const [scrollY] = useState(() => window.scrollY);
  const [draft, setDraft] = useState<LeadDraftState>(NO_DRAFT);
  const [confirmClose, setConfirmClose] = useState(false);
  const [failedNavigation, setFailedNavigation] = useState(false);
  const query = useLeadQuery(engagementId, overlayLeadId(origin));
  const view = leadView(query, origin, engagementId);
  const validatedLead = useRef<Lead | undefined>(undefined);
  if (view.state === "ready") validatedLead.current = view.lead;
  // Keep the mounted form and its draft during later invalid reads, but
  // disable writes until this exact evidence association validates again.
  const lead = view.state === "ready" ? view.lead : validatedLead.current;
  // Draft state belongs to the mounted detail; without it nothing is held.
  const held = lead === undefined ? NO_DRAFT : draft;
  const guarded = held.dirty || held.pending || failedNavigation;
  const fresh = view.state === "ready" && !view.stale && !query.isFetching ? view.lead : undefined;

  useEffect(() => {
    if (fresh !== undefined) onValidRead?.(fresh);
  }, [fresh, onValidRead]);

  const shouldBlockFn = useCallback(() => guarded, [guarded]);
  const blocker = useBlocker({
    shouldBlockFn,
    enableBeforeUnload: guarded,
    disabled: !guarded,
    withResolver: true as const,
  });
  const navigationBlocked = blocker.status === "blocked";
  const prompt = confirmClose || navigationBlocked;

  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true });
  }, []);

  // A route change held only for an in-flight write continues once the
  // write lands and nothing typed remains. A failed write keeps the prompt.
  useEffect(() => {
    if (!navigationBlocked || held.pending) return;
    if (blocker.reset === acknowledgedNavigationRef.current) return;
    if (held.failed) {
      if (!held.dirty) setFailedNavigation(true);
    } else if (!held.dirty) {
      blocker.proceed?.();
      onClose();
    }
  }, [navigationBlocked, held.dirty, held.pending, held.failed, blocker, onClose]);

  // Surface: the opening button first, then the inspector it lived in, then
  // its row. Resume: its lead button, then the Resume band.
  const close = () => {
    onClose();
    requestAnimationFrame(() => {
      restoreSurfacePosition(scrollY, undefined);
      if (origin.kind === "resume") {
        const target = origin.trigger?.isConnected === true
          ? origin.trigger
          : document.querySelector<HTMLElement>("[data-resume-lead-open]") ?? document.querySelector<HTMLElement>("[data-resume-band]");
        target?.focus({ preventScroll: true });
        return;
      }
      const request = origin.request;
      const context = request.returnContext;
      if (context?.trigger?.isConnected !== true) {
        const inspector = document.querySelector<HTMLElement>('[aria-label="Selection inspector"]');
        if (inspector !== null) {
          inspector.focus({ preventScroll: true });
          return;
        }
      }
      focusSurfaceRow(request.sourceKey, request.fallbackKey, context);
    });
  };

  const attemptClose = () => {
    if (held.pending) return;
    if (held.dirty || navigationBlocked) {
      resumeFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setConfirmClose(true);
      return;
    }
    close();
  };

  const stay = () => {
    if (navigationBlocked) {
      // The resolver becomes idle asynchronously. Do not hold this same
      // canceled navigation again while that update is still settling.
      acknowledgedNavigationRef.current = blocker.reset;
      blocker.reset?.();
    }
    setFailedNavigation(false);
    setConfirmClose(false);
    const resume = resumeFocusRef.current;
    resumeFocusRef.current = null;
    (resume?.isConnected === true ? resume : dialogRef.current)?.focus({ preventScroll: true });
  };

  const discard = () => {
    if (held.pending) return;
    if (navigationBlocked) {
      blocker.proceed?.();
      onClose();
      return;
    }
    close();
  };

  const onDialogKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (prompt) stay();
      else attemptClose();
      return;
    }
    if (event.key !== "Tab") return;
    const root = dialogRef.current;
    if (!root) return;
    const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => !element.matches(":disabled"));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (first === undefined || last === undefined || !root.contains(active) || (!event.shiftKey && active === root)) {
      event.preventDefault();
      event.stopPropagation();
      (event.shiftKey ? last : first)?.focus({ preventScroll: true });
      if (first === undefined) root.focus({ preventScroll: true });
      return;
    }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === root)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  // Disabling a focused mutation button can send native focus to body.
  // Keep Tab and Escape owned by this foreground dialog even in that gap.
  useLayoutEffect(() => {
    const root = dialogRef.current;
    if (root === null) return;
    const recoverFocus = () => {
      const active = document.activeElement;
      if (!root.contains(active) || active?.matches(":disabled")) {
        root.focus({ preventScroll: true });
      }
    };
    recoverFocus();
    document.addEventListener("keydown", onDialogKeyDown, true);
    document.addEventListener("focusin", recoverFocus, true);
    return () => {
      document.removeEventListener("keydown", onDialogKeyDown, true);
      document.removeEventListener("focusin", recoverFocus, true);
    };
  });

  const retry = () => void query.refetch();
  // The lead is gone, so the pointer goes at once. A draft still asks first.
  const forget = () => {
    if (origin.kind !== "resume" || held.pending) return;
    origin.onForget();
    attemptClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-[70] grid place-items-center p-4 sm:p-6">
      <button
        type="button"
        aria-label="Dismiss lead"
        tabIndex={-1}
        onPointerDown={(event) => event.preventDefault()}
        onMouseDown={(event) => event.preventDefault()}
        className="absolute inset-0 bg-black/62"
        onClick={() => {
          if (!prompt) attemptClose();
        }}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-labelledby={titleId}
        className="relative max-h-full w-full max-w-[560px] overflow-y-auto rounded-[10px] border border-border bg-popover p-5 text-popover-foreground shadow-[0_24px_64px_rgba(0,0,0,0.6)] outline-none"
        data-keybinding-capture=""
      >
        <div className="flex items-start justify-between gap-2">
          <h2 id={titleId} className="m-0 min-w-0 text-[15px] font-semibold tracking-[-0.02em] break-words">
            {lead?.title ?? "Lead"}
          </h2>
          <Button
            type="button"
            variant="quiet"
            className="shrink-0 px-2 text-[12px]"
            disabled={held.pending}
            onClick={attemptClose}
          >
            Close
          </Button>
        </div>
        <p className="m-0 mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
          {lead !== undefined ? (
            <>
              <span>{lead.disposition}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono" title={lead.id}>
                {(origin.kind === "surface" ? origin.request.idSuffix : undefined) ?? lead.id.slice(-8)}
              </span>
              {origin.kind === "surface" ? <span aria-hidden="true">·</span> : null}
            </>
          ) : null}
          {origin.kind === "surface" ? (
            <span className="min-w-0 break-all font-mono">evidence {origin.request.artifactId}</span>
          ) : null}
        </p>
        {origin.kind === "surface" ? (
          <p className="m-0 mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={origin.request.sourceText}>
            Opened from {origin.request.sourceText}
          </p>
        ) : (
          <p className="m-0 mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
            Opened from Resume
            {lead !== undefined ? ` · saved source ${lead.source.label ?? `${lead.source.kind}:${lead.source.ref}`}` : null}
          </p>
        )}

        {prompt ? (
          <div className="mt-3 rounded-md border border-border px-3 py-2" role="alert">
            <p className="m-0 text-[12px] text-foreground">
              {held.pending
                ? "Saving. Leaving continues after the save finishes."
                : failedNavigation && !held.dirty
                  ? "The change failed. Leave without applying it?"
                  : "Discard unsaved lead edits?"}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button type="button" variant="secondary" autoFocus onClick={stay}>
                Stay
              </Button>
              {held.pending ? null : (
                <Button type="button" variant="quiet" onClick={discard}>
                  {failedNavigation && !held.dirty ? "Leave" : "Discard"}
                </Button>
              )}
            </div>
          </div>
        ) : null}

        {archived ? (
          <p className="m-0 mt-3 text-[12px] leading-5 text-muted-foreground">
            This engagement is archived. Leads can be viewed but not changed.
          </p>
        ) : null}

        <div className="mt-4">
          {view.state === "loading" ? (
            <LoadingRegion label="Loading lead" className="space-y-2">
              <Skeleton className="h-3 w-40" />
              <Skeleton className="h-16 w-full" />
            </LoadingRegion>
          ) : null}
          {view.state === "missing" && origin.kind === "surface" ? (
            <RecoverableError
              title="Lead not found"
              description="This lead is no longer in this engagement. Close to return to the inspector."
              onRetry={retry}
            />
          ) : null}
          {view.state === "missing" && origin.kind === "resume" ? (
            <RecoverableError
              title="Lead not found"
              description="This remembered lead is no longer in this engagement."
              retryLabel="Forget lead"
              onRetry={forget}
            />
          ) : null}
          {view.state === "moved" && origin.kind === "surface" ? (
            <RecoverableError
              title="Lead source changed"
              description={`This lead no longer references evidence ${origin.request.artifactId}.`}
              onRetry={retry}
            />
          ) : null}
          {view.state === "failed" ? (
            <RecoverableError
              title="Lead unavailable"
              description="The lead could not be read from the local control plane."
              onRetry={retry}
            />
          ) : null}
          {view.state === "ready" && view.stale ? (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2" role="status">
              <p className="m-0 text-[12px] text-muted-foreground">Refresh failed. Showing the lead as last read.</p>
              <Button type="button" variant="secondary" onClick={retry}>
                Retry
              </Button>
            </div>
          ) : null}
          {lead !== undefined ? (
            <LeadDetail
              key={lead.id}
              archived={archived}
              readOnly={view.state !== "ready" || view.stale || query.isFetching}
              engagementId={engagementId}
              lead={lead}
              overlay
              onDraftChange={setDraft}
            />
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
