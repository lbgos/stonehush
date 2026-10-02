import type { Engagement, Lead } from "@stonehush/contracts";
import { ADVISOR_FINDING_IDS_MAX } from "@stonehush/contracts";
import {
  Button,
  EmptyState,
  LoadingRegion,
  RecoverableError,
  Skeleton,
  StaleDataState,
} from "@stonehush/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  ENGAGEMENT_KIND_LABELS,
  ENGAGEMENT_STATUS_LABELS,
  formatEngagementTimestamp,
} from "./format.js";
import { partitionEngagements, useEngagementDetailQuery, useEngagementsQuery } from "./query.js";
import { ActionPlanner } from "./action-planner.js";
import { AdvisorPanel } from "../advisor/advisor-panel.js";
import { EngagementFindingsSection } from "./findings.js";
import { EngagementFfufSection } from "./ffuf-surface.js";
import { EngagementGitleaksSection } from "./gitleaks.js";
import type { LeadOpenRequest, LeadStartContext, SurfaceSelectionHandler, SurfaceSelectionReturn } from "./inspector.js";
import { LeadOverlay, overlayLeadId, type LeadOverlayOrigin } from "./lead-overlay.js";
import { LeadQuickCreate } from "./lead-quick-create.js";
import { EngagementVhostSection } from "./vhost-surface.js";
import {
  EngagementLeadsSection,
  EngagementObjectivesSection,
  EngagementSecretsSection,
} from "./leads.js";
import { EngagementAccessSection } from "./access.js";
import { EngagementNotesSection } from "./notes.js";
import { EngagementReportSection } from "./report.js";
import { createResumeFindingDestination, type FindingDestination } from "./finding-arrival.js";
import { ResumeLeadRow, useRememberedLead } from "./resume-lead.js";
import { EngagementResumeView } from "./resume-view.js";
import type { NoteSearchDestination } from "./search-destination.js";
import { EngagementSearchDialog, type SearchSelection } from "./search-view.js";
import { EngagementTechniquesSection } from "./techniques-library.js";
import { RunHistoryPanel } from "./run-history-panel.js";
import { SavedScopeEditor } from "./scope-editor.js";
import { EngagementHttpProbesSection } from "./http-probe-surface.js";
import { EngagementServicesSection } from "./service-surface.js";
import { ExecutionTray } from "./workspace-tabs.js";
import { useEngagementWorkspace } from "./workspace-context.js";

// Engagement detail tabs. Tab and selected-run state live in the route search
// (?tab=, ?run=) so selection survives reload and tab switches. An unknown tab
// resolves to surface; an arbitrary run id flows only into the existing
// encoded run-output query with no latest-run fallback. Tab switches use
// router Links so the merged dirty-notes useBlocker can intercept them.
export const ENGAGEMENT_TABS = [
  { id: "surface", label: "Surface" },
  { id: "runs", label: "Runs" },
  { id: "notes", label: "Notes" },
  { id: "findings", label: "Findings" },
  { id: "leads", label: "Leads" },
  { id: "techniques", label: "Techniques" },
  { id: "report", label: "Report" },
] as const;

export type EngagementTabId = (typeof ENGAGEMENT_TABS)[number]["id"];

export function resolveEngagementTab(raw: unknown): EngagementTabId {
  for (const tab of ENGAGEMENT_TABS) {
    if (tab.id === raw) return tab.id;
  }
  return "surface";
}

export function EngagementWorkspace({
  engagementId,
  pendingActionId,
  selectedItemKey,
  selectedRunId,
  selectedTargetId,
  tab,
}: {
  engagementId?: string | undefined;
  pendingActionId?: string | undefined;
  selectedItemKey?: string | undefined;
  selectedRunId?: string | undefined;
  selectedTargetId?: string | undefined;
  tab?: string | undefined;
}) {
  const engagements = useEngagementsQuery();
  const { openCreate } = useEngagementWorkspace();
  const hasData = engagements.data !== undefined;
  const retry = () => void engagements.refetch();

  if (!hasData && engagements.isFetching) {
    return (
      <main className="min-h-full bg-background px-4 py-5 sm:px-6">
        <div className="mx-auto w-full max-w-3xl">
          <h1 className="m-0 text-[26px] leading-none font-semibold tracking-[-0.04em]">Engagements</h1>
          <LoadingRegion label="Loading engagements" className="mt-5 space-y-3">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-8 w-56 max-w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </LoadingRegion>
        </div>
      </main>
    );
  }

  if (!hasData && engagements.isError) {
    return (
      <main className="min-h-full bg-background px-4 py-5 sm:px-6">
        <div className="mx-auto w-full max-w-3xl">
          <h1 className="mb-5 text-[26px] leading-none font-semibold tracking-[-0.04em]">Engagements</h1>
          <RecoverableError
            variant="page"
            title="Engagements unavailable"
            description="The engagement list could not be loaded from the local control plane."
            onRetry={retry}
          />
        </div>
      </main>
    );
  }

  const records = engagements.data ?? [];
  const selected = engagementId ? records.find((engagement) => engagement.id === engagementId) : undefined;

  if (engagementId !== undefined && selected === undefined) {
    return (
      <main className="min-h-full bg-background px-4 py-5 sm:px-6">
        <div className="mx-auto w-full max-w-3xl">
          <RecoverableError
            variant="page"
            title="Engagement not found"
            description="That engagement is not in the current list. Refresh the list or open Engagements."
            onRetry={retry}
            retryLabel="Refresh list"
          />
          <p className="mt-4 mb-0">
            <Link
              to="/engagements"
              className="inline-flex min-h-11 items-center text-[13px] font-semibold text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              Open Engagements
            </Link>
          </p>
        </div>
      </main>
    );
  }

  const body =
    selected !== undefined ? (
      <EngagementDetail
        engagement={selected}
        pendingActionId={pendingActionId}
        selectedItemKey={selectedItemKey}
        selectedTargetId={selectedTargetId}
        tab={tab}
        selectedRunId={selectedRunId}
      />
    ) : records.length === 0 ? (
      <div>
        <h1 className="mb-5 text-[26px] leading-none font-semibold tracking-[-0.04em]">Engagements</h1>
        <EmptyState
          variant="primary"
          title="No engagements yet"
          description="Create an engagement to start local CTF, lab, or assessment work."
          action={<Button onClick={openCreate}>New engagement</Button>}
        />
      </div>
    ) : (
      <EngagementIndex engagements={records} />
    );

  const isDetail = selected !== undefined;
  const containerClass = isDetail ? "mx-auto w-full max-w-none" : "mx-auto w-full max-w-3xl";

  return (
    <main className="min-h-full bg-background px-4 py-5 sm:px-6">
      <div className={containerClass}>
        {engagements.isError ? (
          <StaleDataState
            title="Showing the last successful engagement list"
            description="The latest refresh failed. Existing engagements are still available."
            onRetry={retry}
          >
            {body}
          </StaleDataState>
        ) : (
          body
        )}
      </div>
    </main>
  );
}

function EngagementIndex({ engagements }: { engagements: readonly Engagement[] }) {
  const { active, archived } = partitionEngagements(engagements);
  return (
    <div>
      <header className="mb-5">
        <h1 className="m-0 text-[26px] leading-none font-semibold tracking-[-0.04em]">Engagements</h1>
      </header>
      {active.length > 0 && (
        <section className="grid gap-1" aria-label="Active engagements">
          {active.map((engagement) => (
            <EngagementSummaryLink key={engagement.id} engagement={engagement} />
          ))}
        </section>
      )}
      {active.length === 0 && (
        <EmptyState
          variant="filtered"
          title="No active engagements"
          description="Archived engagements stay available below. Reopen one or create a new engagement."
        />
      )}
      {archived.length > 0 && (
        <section className="mt-6" aria-label="Archived engagements">
          <h2 className="m-0 text-[11px] font-medium text-muted-foreground">Archived</h2>
          <div className="mt-2 grid gap-1">
            {archived.map((engagement) => (
              <EngagementSummaryLink key={engagement.id} engagement={engagement} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function EngagementSummaryLink({ engagement }: { engagement: Engagement }) {
  return (
    <Link
      to="/engagements/$engagementId"
      params={{ engagementId: engagement.id }}
      className="surface-row flex min-h-14 items-center justify-between gap-3 rounded-[10px] px-3 py-2 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-semibold tracking-[-0.02em]">{engagement.name}</span>
        <span className="mt-0.5 block text-[11px] text-muted-foreground">
          {ENGAGEMENT_KIND_LABELS[engagement.kind]} · {ENGAGEMENT_STATUS_LABELS[engagement.status]}
        </span>
      </span>
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">rev {engagement.revision}</span>
    </Link>
  );
}

// One-shot arrival for Notes (from Search) or Findings (from Search or Resume).
type WorkspaceDestination = NoteSearchDestination | FindingDestination;

function destinationTab(destination: WorkspaceDestination): EngagementTabId {
  return destination.kind === "note" ? "notes" : "findings";
}

function selectDisplayedEngagement(listed: Engagement, detailed: Engagement | undefined): Engagement {
  if (detailed === undefined) return listed;
  return detailed.revision >= listed.revision ? detailed : listed;
}

function EngagementDetail({
  engagement,
  pendingActionId,
  selectedItemKey,
  selectedRunId,
  selectedTargetId,
  tab,
}: {
  engagement: Engagement;
  pendingActionId?: string | undefined;
  selectedItemKey?: string | undefined;
  selectedRunId?: string | undefined;
  selectedTargetId?: string | undefined;
  tab?: string | undefined;
}) {
  const detail = useEngagementDetailQuery(engagement.id);
  const displayed = selectDisplayedEngagement(engagement, detail.data?.engagement);
  const activeTab = resolveEngagementTab(tab);
  const runId = selectedRunId !== undefined && selectedRunId.length > 0 ? selectedRunId : undefined;
  const navigate = useNavigate();
  const archived = displayed.status === "archived";
  // A paused first scan rides along in every workspace navigation so normal
  // tab, run, and selection moves never strand its warning. It clears only
  // when the route drops it, which the planner then reflects.
  const actionSearch = pendingActionId === undefined ? {} : { action: pendingActionId };
  const {
    advisorDraft,
    closeAdvisor,
    setAdvisorExcerpts,
    setAdvisorFindingIds,
  } = useEngagementWorkspace();

  // Advisor selection belongs to one engagement: switching engagements
  // closes the drawer and drops the draft so responses can never leak
  // across engagements.
  useEffect(() => {
    closeAdvisor();
    setAdvisorExcerpts([]);
    setAdvisorFindingIds([]);
  }, [displayed.id, closeAdvisor, setAdvisorExcerpts, setAdvisorFindingIds]);

  // A lead draft belongs to the engagement that opened it. The render guard
  // below hides it at once on a switch; the effect drops it for good.
  const [leadStart, setLeadStart] = useState<
    { engagementId: string; context: LeadStartContext } | null
  >(null);
  useEffect(() => {
    setLeadStart(null);
  }, [displayed.id]);

  // Search notes and findings. The query survives close so Search again
  // and reopen resume it; results always refetch. A chosen result becomes a
  // one-shot destination for Notes or Findings. All of it belongs to one
  // engagement and resets on a switch.
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const searchReturnRef = useRef<HTMLElement | null>(null);
  const searchFocusEpoch = useRef(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [destination, setDestination] = useState<WorkspaceDestination | null>(null);
  const destinationNonce = useRef(0);
  const resumeArrivalContext = useRef({ run: runId, target: selectedTargetId, sel: selectedItemKey, action: pendingActionId });
  // Back to Resume waits here for Surface to commit, then focuses the band.
  // It holds the engagement it was started in and nothing else.
  const [resumeReturn, setResumeReturn] = useState<string | null>(null);
  useEffect(() => {
    searchReturnRef.current = null;
    searchFocusEpoch.current += 1;
    setSearchOpen(false);
    setSearchQuery("");
    setDestination(null);
    setResumeReturn(null);
  }, [displayed.id]);
  // Leaving the destination tab ends the destination, so returning to the
  // tab later never replays it.
  useEffect(() => {
    setDestination((current) =>
      current === null || destinationTab(current) === activeTab ? current : null,
    );
  }, [activeTab]);
  // Resume's return belongs to the investigation that opened it. A committed
  // context change ends it even when the Findings tab remains mounted.
  useEffect(() => {
    const context = resumeArrivalContext.current;
    if (context.run === runId && context.target === selectedTargetId && context.sel === selectedItemKey && context.action === pendingActionId) return;
    setDestination((current) => current?.kind === "finding" && current.source === "resume" ? null : current);
    setResumeReturn(null);
  }, [runId, selectedTargetId, selectedItemKey, pendingActionId]);

  const closeSearch = () => {
    const trigger = searchReturnRef.current ?? searchTriggerRef.current;
    const epoch = ++searchFocusEpoch.current;
    setDestination(null);
    setSearchOpen(false);
    requestAnimationFrame(() => {
      if (epoch !== searchFocusEpoch.current) return;
      const available = trigger?.isConnected ? trigger : searchTriggerRef.current;
      available?.focus({ preventScroll: true });
    });
  };
  const openSearch = (trigger: HTMLElement) => {
    searchFocusEpoch.current += 1;
    searchReturnRef.current = trigger;
    setDestination(null);
    setSearchOpen(true);
  };
  const reopenSearch = (query: string) => {
    searchFocusEpoch.current += 1;
    searchReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDestination(null);
    setSearchQuery(query);
    setSearchOpen(true);
  };
  const openSearchResult = ({ query, result, target }: SearchSelection) => {
    destinationNonce.current += 1;
    const base = { nonce: destinationNonce.current, engagementId: displayed.id, query, result };
    const next: WorkspaceDestination =
      target.kind === "note"
        ? { ...base, kind: "note", codePointOffset: target.codePointOffset }
        : { ...base, kind: "finding", source: "search", findingId: target.findingId };
    setSearchOpen(false);
    setDestination(next);
    const tab = destinationTab(next);
    if (tab === activeTab) return;
    // A dirty notes or finding draft may block navigation; Stay drops the
    // destination through onNavigationStay below.
    void navigate({
      to: "/engagements/$engagementId",
      params: { engagementId: displayed.id },
      search: {
        tab,
        ...(runId === undefined ? {} : { run: runId }),
        ...(selectedTargetId === undefined ? {} : { target: selectedTargetId }),
        ...(selectedItemKey === undefined ? {} : { sel: selectedItemKey }),
        ...actionSearch,
      },
    });
  };
  const dismissDestination = () => setDestination(null);

  // Route context every arrival and return carries unchanged.
  const contextSearch = {
    ...(runId === undefined ? {} : { run: runId }),
    ...(selectedTargetId === undefined ? {} : { target: selectedTargetId }),
    ...(selectedItemKey === undefined ? {} : { sel: selectedItemKey }),
    ...actionSearch,
  };

  // A Resume finding row opens that exact saved finding. Invalid identities
  // never become a destination. Back to Resume exists only for this arrival:
  // leaving Findings any other way, switching engagement or reloading ends it.
  const openResumeFinding = (identity: { engagementId: string; findingId: string }) => {
    if (identity.engagementId !== displayed.id) return;
    const next = createResumeFindingDestination({ ...identity, nonce: destinationNonce.current + 1 });
    if (next === null) return;
    destinationNonce.current = next.nonce;
    resumeArrivalContext.current = { run: runId, target: selectedTargetId, sel: selectedItemKey, action: pendingActionId };
    setResumeReturn(null);
    setDestination(next);
    void navigate({
      to: "/engagements/$engagementId",
      params: { engagementId: displayed.id },
      search: { tab: "findings", ...contextSearch },
    });
  };
  const backToResume = () => {
    setResumeReturn(displayed.id);
    // A finding draft or pending save may hold this; Stay clears the return.
    void navigate({
      to: "/engagements/$engagementId",
      params: { engagementId: displayed.id },
      search: { tab: "surface", ...contextSearch },
    });
  };
  // Stay on a held Back to Resume keeps the arrival; any other Stay drops it.
  const stayOnFindings = () => {
    if (resumeReturn !== null) setResumeReturn(null);
    else dismissDestination();
  };
  useEffect(() => {
    if (resumeReturn === null) return;
    if (resumeReturn !== displayed.id || (activeTab !== "surface" && activeTab !== "findings")) {
      setResumeReturn(null);
      return;
    }
    if (activeTab !== "surface") return;
    setResumeReturn(null);
    document.querySelector<HTMLElement>("[data-resume-band]")?.focus();
  }, [activeTab, displayed.id, resumeReturn]);
  const noteDestination =
    destination?.kind === "note" && destination.engagementId === displayed.id ? destination : undefined;
  const findingDestination =
    destination?.kind === "finding" && destination.engagementId === displayed.id ? destination : undefined;

  // A lead opened from the inspector or the Resume band belongs to that
  // engagement and Surface selection. A route change away from either closes
  // it; the overlay holds such changes itself while it has unsaved or
  // pending work.
  const [leadOpen, setLeadOpen] = useState<
    { engagementId: string; sel: string | undefined; origin: LeadOverlayOrigin } | null
  >(null);
  const leadOpenVisible =
    leadOpen !== null &&
    leadOpen.engagementId === displayed.id &&
    leadOpen.sel === selectedItemKey &&
    activeTab === "surface";
  useEffect(() => {
    if (!leadOpenVisible) setLeadOpen(null);
  }, [leadOpenVisible]);
  const closeLeadOpen = useCallback(() => setLeadOpen(null), []);
  const openSurfaceLead = (request: LeadOpenRequest) =>
    setLeadOpen({ engagementId: displayed.id, sel: selectedItemKey, origin: { kind: "surface", request } });

  // Every validated overlay read, from either opener, becomes this browser's
  // Resume pointer for the lead's engagement.
  const rememberedLead = useRememberedLead(displayed.id);
  const { remember: rememberLeadId, forget: forgetLeadId } = rememberedLead;
  const rememberLead = useCallback((lead: Lead) => rememberLeadId(lead.engagementId, lead.id), [rememberLeadId]);
  const openResumeLead = (leadId: string, trigger: HTMLElement) => {
    const engagementId = displayed.id;
    setLeadOpen({
      engagementId,
      sel: selectedItemKey,
      origin: { kind: "resume", leadId, trigger, onForget: () => forgetLeadId(engagementId, leadId) },
    });
  };

  const toggleAdvisorFinding = (findingId: string) => {
    if (archived) return;
    if (advisorDraft.findingIds.includes(findingId)) {
      setAdvisorFindingIds(advisorDraft.findingIds.filter((id) => id !== findingId));
      return;
    }
    if (advisorDraft.findingIds.length >= ADVISOR_FINDING_IDS_MAX) return;
    setAdvisorFindingIds([...advisorDraft.findingIds, findingId]);
  };

  const selectRun = (nextRunId: string) => {
    void navigate({
      to: "/engagements/$engagementId",
      params: { engagementId: displayed.id },
      search:
        nextRunId.length > 0
          ? {
              tab: activeTab,
              run: nextRunId,
              ...(selectedTargetId === undefined ? {} : { target: selectedTargetId }),
              ...(selectedItemKey === undefined ? {} : { sel: selectedItemKey }),
              ...actionSearch,
            }
          : {
              tab: activeTab,
              ...(selectedTargetId === undefined ? {} : { target: selectedTargetId }),
              ...(selectedItemKey === undefined ? {} : { sel: selectedItemKey }),
              ...actionSearch,
            },
    });
  };

  // Surface investigation context lives in the route search so browser Back
  // steps through target and row selections instead of leaving the
  // engagement. Selection navigations keep the scroll position; overlays
  // restore row focus and scroll on close themselves.
  const selectTarget = (target: string) => {
    void navigate({
      to: "/engagements/$engagementId",
      params: { engagementId: displayed.id },
      resetScroll: false,
      search: {
        tab: "surface",
        ...(runId === undefined ? {} : { run: runId }),
        target,
        ...actionSearch,
      },
    });
  };

  const [selectionReturn, setSelectionReturn] = useState<SurfaceSelectionReturn | undefined>(undefined);
  useEffect(() => {
    setSelectionReturn((current) => current?.engagementId === displayed.id && current.key === selectedItemKey ? current : undefined);
  }, [displayed.id, selectedItemKey]);
  const selectSurfaceItem: SurfaceSelectionHandler = (key, context) => {
    if (key !== undefined) {
      setSelectionReturn(context === undefined ? undefined : { engagementId: displayed.id, key, context });
    }
    void navigate({
      to: "/engagements/$engagementId",
      params: { engagementId: displayed.id },
      resetScroll: false,
      search: {
        tab: activeTab,
        ...(runId === undefined ? {} : { run: runId }),
        ...(selectedTargetId === undefined ? {} : { target: selectedTargetId }),
        ...(key === undefined ? {} : { sel: key }),
        ...actionSearch,
      },
    });
  };

  const openRunFromTray = (nextRunId: string) => {
    void navigate({
      to: "/engagements/$engagementId",
      params: { engagementId: displayed.id },
      search: {
        tab: "runs",
        run: nextRunId,
        ...(selectedTargetId === undefined ? {} : { target: selectedTargetId }),
        ...(selectedItemKey === undefined ? {} : { sel: selectedItemKey }),
        ...actionSearch,
      },
    });
  };

  const openNotesFromSurface = () => {
    void navigate({
      to: "/engagements/$engagementId",
      params: { engagementId: displayed.id },
      search: {
        tab: "notes",
        ...(runId === undefined ? {} : { run: runId }),
        ...(selectedTargetId === undefined ? {} : { target: selectedTargetId }),
        ...(selectedItemKey === undefined ? {} : { sel: selectedItemKey }),
        ...actionSearch,
      },
    });
  };

  return (
    <article className="min-w-0">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="m-0 min-w-0 text-[20px] leading-7 font-semibold tracking-[-0.03em] break-words">
            {displayed.name}
          </h1>
          <p className="m-0 flex flex-wrap items-center gap-x-2 text-[12px] text-muted-foreground">
            <span>{ENGAGEMENT_KIND_LABELS[displayed.kind]}</span>
            <span className="text-border" aria-hidden="true">
              ·
            </span>
            <span aria-label={`Status: ${ENGAGEMENT_STATUS_LABELS[displayed.status]}`}>
              {ENGAGEMENT_STATUS_LABELS[displayed.status]}
            </span>
            <span className="text-border" aria-hidden="true">
              ·
            </span>
            <span className="font-mono">rev {displayed.revision}</span>
          </p>
        </div>
        <p className="m-0 shrink-0 text-[11px] text-muted-foreground">
          Updated{" "}
          <time dateTime={displayed.updatedAt} className="font-mono text-foreground">
            {formatEngagementTimestamp(displayed.updatedAt)}
          </time>
        </p>
      </header>

      {displayed.description !== null || displayed.authorizationContext !== null ? (
        <section
          aria-label="Engagement context"
          className="mt-1.5 flex flex-col gap-0.5 text-[12px] leading-5 sm:flex-row sm:flex-wrap sm:gap-x-6"
        >
          {displayed.description !== null ? (
            <p className="m-0 min-w-0 flex-1 whitespace-pre-wrap break-words">{displayed.description}</p>
          ) : null}
          {displayed.authorizationContext !== null ? (
            <p className="m-0 min-w-0 flex-1 whitespace-pre-wrap break-words">
              <span className="font-medium">Authorization</span>
              <span className="text-muted-foreground"> · </span>
              {displayed.authorizationContext}
            </p>
          ) : null}
        </section>
      ) : null}

      <nav aria-label="Engagement sections" className="mt-3 flex flex-wrap items-end gap-1 border-b border-border">
        {ENGAGEMENT_TABS.map((entry) => {
          const active = entry.id === activeTab;
          return (
            <Link
              key={entry.id}
              to="/engagements/$engagementId"
              params={{ engagementId: displayed.id }}
              search={{
                tab: entry.id,
                ...(runId === undefined ? {} : { run: runId }),
                ...(selectedTargetId === undefined ? {} : { target: selectedTargetId }),
                ...(selectedItemKey === undefined ? {} : { sel: selectedItemKey }),
                ...actionSearch,
              }}
              aria-current={active ? "page" : undefined}
              className={`inline-flex min-h-11 items-center rounded-t-[10px] px-3 text-[13px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
              }`}
            >
              {entry.label}
            </Link>
          );
        })}
        <button
          ref={searchTriggerRef}
          type="button"
          aria-label="Search notes and findings"
          aria-haspopup="dialog"
          aria-expanded={searchOpen}
          className="ml-auto inline-flex min-h-11 items-center rounded-t-[10px] px-3 text-[13px] font-semibold text-muted-foreground outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={(event) => openSearch(event.currentTarget)}
        >
          Search
        </button>
      </nav>

      {runId !== undefined ? (
        <p className="mt-3 mb-0 truncate font-mono text-[11px] text-muted-foreground" title={runId}>
          Selected run {runId}
        </p>
      ) : null}

      {activeTab === "surface" ? (
        <div className="mt-4">
          <EngagementResumeView
            key={displayed.id}
            archived={archived}
            engagementId={displayed.id}
            lead={
              rememberedLead.leadId === null ? undefined : (
                <ResumeLeadRow
                  engagementId={displayed.id}
                  leadId={rememberedLead.leadId}
                  onOpen={openResumeLead}
                  onForget={(leadId) => forgetLeadId(displayed.id, leadId)}
                />
              )
            }
            onOpenFinding={openResumeFinding}
            onOpenRun={openRunFromTray}
          />

          <ExecutionTray engagementId={displayed.id} onOpenRun={openRunFromTray} />

          <div className="mt-4">
            <EngagementServicesSection
              archived={archived}
              engagementId={displayed.id}
              onOpenLead={openSurfaceLead}
              onOpenNotes={openNotesFromSurface}
              onSearch={openSearch}
              searchOpen={searchOpen}
              leadOpen={leadOpenVisible}
              onSelectKey={selectSurfaceItem}
              onSelectTarget={selectTarget}
              onStartLead={(context) => setLeadStart({ engagementId: displayed.id, context })}
              selectedKey={selectedItemKey}
              selectionReturn={selectionReturn}
              selectedTarget={selectedTargetId}
            />
          </div>

          <div className="mt-5">
            <EngagementHttpProbesSection
              engagementId={displayed.id}
              onSelectKey={selectSurfaceItem}
              selectedKey={selectedItemKey}
            />
          </div>

          <div className="mt-5">
            <EngagementFfufSection
              archived={archived}
              engagementId={displayed.id}
              onSelectKey={selectSurfaceItem}
              selectedKey={selectedItemKey}
            />
          </div>

          <div className="mt-5">
            <EngagementVhostSection
              archived={archived}
              engagementId={displayed.id}
            />
          </div>

          <div className="mt-5">
            <EngagementGitleaksSection
              archived={archived}
              engagementId={displayed.id}
            />
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <ActionPlanner
              archived={archived}
              engagementId={displayed.id}
              pendingActionId={pendingActionId}
            />
            <SavedScopeEditor archived={archived} engagementId={displayed.id} />
          </div>
        </div>
      ) : null}

      {activeTab === "runs" ? (
        <div className="mt-5">
          <RunHistoryPanel
            archived={archived}
            engagementId={displayed.id}
            selectedRunId={runId}
            onSelect={selectRun}
          />
        </div>
      ) : null}

      {activeTab === "notes" ? (
        <EngagementNotesSection
          key={displayed.id}
          archived={archived}
          engagementId={displayed.id}
          destination={noteDestination}
          onDismissDestination={dismissDestination}
          onNavigationStay={dismissDestination}
          onSearchAgain={reopenSearch}
        />
      ) : null}

      {activeTab === "findings" ? (
        <EngagementFindingsSection
          key={`findings-${displayed.id}`}
          archived={archived}
          engagementId={displayed.id}
          destination={findingDestination}
          onBackToResume={backToResume}
          onNavigationStay={stayOnFindings}
          onDismissDestination={dismissDestination}
          onSearchAgain={reopenSearch}
          {...(advisorDraft.open
            ? {
                selection: {
                  selectedIds: advisorDraft.findingIds,
                  onToggleFinding: toggleAdvisorFinding,
                },
              }
            : {})}
        />
      ) : null}

      {activeTab === "leads" ? (
        <div className="mt-5">
          <EngagementLeadsSection
            key={`leads-${displayed.id}`}
            archived={archived}
            engagementId={displayed.id}
          />
          <EngagementObjectivesSection
            key={`objectives-${displayed.id}`}
            archived={archived}
            engagementId={displayed.id}
          />
          <EngagementSecretsSection
            key={`secrets-${displayed.id}`}
            archived={archived}
            engagementId={displayed.id}
          />
          <EngagementAccessSection
            key={`access-${displayed.id}`}
            archived={archived}
            engagementId={displayed.id}
          />
        </div>
      ) : null}

      {activeTab === "techniques" ? (
        <EngagementTechniquesSection
          key={`techniques-${displayed.id}`}
          archived={archived}
          engagementId={displayed.id}
        />
      ) : null}

      {activeTab === "report" ? (
        <EngagementReportSection
          key={`report-${displayed.id}`}
          engagementId={displayed.id}
        />
      ) : null}

      {leadStart !== null && leadStart.engagementId === displayed.id ? (
        <LeadQuickCreate
          key={`${leadStart.engagementId}:${leadStart.context.sourceKey}`}
          archived={archived}
          context={leadStart.context}
          engagementId={leadStart.engagementId}
          onClose={() => setLeadStart(null)}
        />
      ) : null}

      {searchOpen ? (
        <EngagementSearchDialog
          key={`search-${displayed.id}`}
          engagementId={displayed.id}
          query={searchQuery}
          onQueryChange={setSearchQuery}
          onClose={closeSearch}
          onSelect={openSearchResult}
        />
      ) : null}

      {leadOpenVisible ? (
        <LeadOverlay
          key={`${leadOpen.engagementId}:${overlayLeadId(leadOpen.origin)}:${leadOpen.origin.kind === "surface" ? leadOpen.origin.request.sourceKey : "resume"}`}
          archived={archived}
          engagementId={leadOpen.engagementId}
          origin={leadOpen.origin}
          onClose={closeLeadOpen}
          onValidRead={rememberLead}
        />
      ) : null}

      {advisorDraft.open ? (
        <AdvisorPanel
          key={`${displayed.id}:${advisorDraft.nonce}`}
          engagementId={displayed.id}
          archived={archived}
          excerpts={advisorDraft.excerpts}
          findingIds={advisorDraft.findingIds}
          onExcerptsChange={setAdvisorExcerpts}
          onFindingIdsChange={setAdvisorFindingIds}
          onClose={closeAdvisor}
        />
      ) : null}
    </article>
  );
}
