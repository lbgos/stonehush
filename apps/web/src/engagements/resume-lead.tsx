import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import { exactLeadRead, useLeadQuery } from "./leads-query.js";
import {
  browserWorkspaceStateStore,
  loadWorkspaceState,
  saveWorkspaceState,
  type WorkspaceStateStore,
} from "./workspace-state.js";

// The last lead this browser opened and validated in one engagement, shown
// as a row in the Surface Resume band. Only the lead id is stored, in the
// engagement's workspace state. Title and disposition always come from a
// fresh read; a pointer is never resolved by title, order, or recency.

export interface RememberedLead {
  readonly leadId: string | null;
  // Stores the id after a validated read. The pointer changes only when the
  // write succeeded, so the row never claims a lead the next reload loses.
  readonly remember: (engagementId: string, leadId: string) => void;
  // Clears the pointer only while it still names this lead.
  readonly forget: (engagementId: string, leadId: string) => void;
}

export function useRememberedLead(engagementId: string, store?: WorkspaceStateStore): RememberedLead {
  const resolved = useMemo(() => store ?? browserWorkspaceStateStore(), [store]);
  const [pointer, setPointer] = useState(() => ({
    engagementId,
    leadId: loadWorkspaceState(resolved, engagementId).lastLeadId,
  }));
  // Switch during render so engagement B never renders with A's pointer.
  let current = pointer;
  if (pointer.engagementId !== engagementId) {
    current = { engagementId, leadId: loadWorkspaceState(resolved, engagementId).lastLeadId };
    setPointer(current);
  }
  const engagementRef = useRef(engagementId);
  useLayoutEffect(() => {
    engagementRef.current = engagementId;
  }, [engagementId]);

  const remember = useCallback((owner: string, leadId: string) => {
    // A late read for an engagement the operator already left changes nothing.
    if (owner !== engagementRef.current) return;
    const saved = loadWorkspaceState(resolved, owner);
    const stored = saved.lastLeadId === leadId ||
      saveWorkspaceState(resolved, owner, { ...saved, lastLeadId: leadId, updatedAt: new Date().toISOString() });
    if (!stored) return;
    setPointer((prev) => (prev.engagementId === owner ? { engagementId: owner, leadId } : prev));
  }, [resolved]);

  const forget = useCallback((owner: string, leadId: string) => {
    if (owner !== engagementRef.current) return;
    const saved = loadWorkspaceState(resolved, owner);
    if (saved.lastLeadId === leadId) {
      saveWorkspaceState(resolved, owner, { ...saved, lastLeadId: null, updatedAt: new Date().toISOString() });
    }
    setPointer((prev) => (prev.engagementId === owner && prev.leadId === leadId ? { engagementId: owner, leadId: null } : prev));
  }, [resolved]);

  return { leadId: current.leadId, remember, forget };
}

// Same columns as the next-step and deadline rows above it.
const LEAD_ROW = "grid min-w-0 grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-x-3";
const LEAD_LABEL = "pt-1.5 text-[12px] leading-5 font-medium text-foreground";
const INLINE_ACTION =
  "inline-flex min-h-11 items-center rounded-md px-1.5 text-[12px] font-medium text-foreground underline underline-offset-2 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 md:pointer-fine:min-h-7";

export interface ResumeLeadRowProps {
  readonly engagementId: string;
  readonly leadId: string;
  readonly onOpen: (leadId: string, trigger: HTMLElement) => void;
  readonly onForget: (leadId: string) => void;
}

/** A new pointer is a new fresh read. */
export function ResumeLeadRow(props: ResumeLeadRowProps) {
  return <ResumeLeadRowState key={`${props.engagementId}:${props.leadId}`} {...props} />;
}

function ResumeLeadRowState({ engagementId, leadId, onOpen, onForget }: ResumeLeadRowProps) {
  const query = useLeadQuery(engagementId, leadId);
  const read = exactLeadRead(query, engagementId, leadId);
  const retry = (
    <button type="button" onClick={() => void query.refetch()} disabled={query.isFetching} className={INLINE_ACTION}>
      Retry
    </button>
  );

  let body;
  if (read.state === "ready") {
    const { lead } = read;
    const suffix = lead.id.slice(-8);
    body = (
      <p className="m-0 flex min-h-8 min-w-0 flex-wrap items-center gap-x-2 text-[12px] leading-5 text-muted-foreground">
        <button
          type="button"
          data-resume-lead-open=""
          aria-haspopup="dialog"
          aria-label={`${lead.title} ${suffix}, ${lead.disposition}`}
          title={lead.title}
          onClick={(event) => onOpen(lead.id, event.currentTarget)}
          className="min-h-11 max-w-full min-w-0 truncate rounded-sm text-left text-[13px] text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring md:pointer-fine:min-h-8"
        >
          {lead.title}
        </button>
        <span>{lead.disposition}</span>
        <span className="font-mono text-[11px]" title={lead.id}>{suffix}</span>
        {read.stale ? (
          <span className="flex items-center gap-x-1 text-warning" role="status">
            Refresh failed. {retry}
          </span>
        ) : null}
      </p>
    );
  } else if (read.state === "missing") {
    body = (
      <p className="m-0 flex min-h-8 flex-wrap items-center gap-x-2 text-[12px] text-muted-foreground" role="alert">
        Lead unavailable.
        <button
          type="button"
          className={INLINE_ACTION}
          onClick={(event) => {
            const band = event.currentTarget.closest<HTMLElement>("[data-resume-band]");
            onForget(leadId);
            band?.focus({ preventScroll: true });
          }}
        >
          Forget
        </button>
      </p>
    );
  } else if (read.state === "failed") {
    body = (
      <p className="m-0 flex min-h-8 flex-wrap items-center gap-x-2 text-[12px] text-muted-foreground" role="alert">
        Lead not loaded. {retry}
      </p>
    );
  } else {
    body = (
      <p className="m-0 flex min-h-8 items-center text-[12px] text-muted-foreground" role="status" aria-label="Loading lead">
        Loading
      </p>
    );
  }

  return (
    <section aria-label="Last lead" className={LEAD_ROW}>
      <span className={LEAD_LABEL}>Lead</span>
      {body}
    </section>
  );
}
