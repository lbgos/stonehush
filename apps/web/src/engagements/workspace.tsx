import type { Engagement } from "@stonehush/contracts";
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
import { useEffect } from "react";

import {
  ENGAGEMENT_KIND_LABELS,
  ENGAGEMENT_STATUS_LABELS,
  formatEngagementTimestamp,
} from "./format.js";
import { partitionEngagements, useEngagementDetailQuery, useEngagementsQuery } from "./query.js";
import { ActionPlanner } from "./action-planner.js";
import { AdvisorPanel } from "../advisor/advisor-panel.js";
import { EngagementDeadlineSection } from "./deadline.js";
import { EngagementFindingsSection } from "./findings.js";
import { EngagementFfufSection } from "./ffuf-surface.js";
import { EngagementNotesSection } from "./notes.js";
import { EngagementReportSection } from "./report.js";
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
  selectedItemKey,
  selectedRunId,
  selectedTargetId,
  tab,
}: {
  engagementId?: string | undefined;
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

function selectDisplayedEngagement(listed: Engagement, detailed: Engagement | undefined): Engagement {
  if (detailed === undefined) return listed;
  return detailed.revision >= listed.revision ? detailed : listed;
}

function EngagementDetail({
  engagement,
  selectedItemKey,
  selectedRunId,
  selectedTargetId,
  tab,
}: {
  engagement: Engagement;
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
            }
          : {
              tab: activeTab,
              ...(selectedTargetId === undefined ? {} : { target: selectedTargetId }),
              ...(selectedItemKey === undefined ? {} : { sel: selectedItemKey }),
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
      },
    });
  };

  const selectSurfaceItem = (key: string | undefined) => {
    void navigate({
      to: "/engagements/$engagementId",
      params: { engagementId: displayed.id },
      resetScroll: false,
      search: {
        tab: activeTab,
        ...(runId === undefined ? {} : { run: runId }),
        ...(selectedTargetId === undefined ? {} : { target: selectedTargetId }),
        ...(key === undefined ? {} : { sel: key }),
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
      },
    });
  };

  return (
    <article className="min-w-0">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="m-0 text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
            {ENGAGEMENT_KIND_LABELS[displayed.kind]}
          </p>
          <h1 className="mt-1 text-[26px] font-semibold tracking-[-0.04em] leading-none">{displayed.name}</h1>
          <p className="mt-2 flex flex-wrap items-center gap-x-2 text-[12px] text-muted-foreground">
            <span aria-label={`Status: ${ENGAGEMENT_STATUS_LABELS[displayed.status]}`}>
              {ENGAGEMENT_STATUS_LABELS[displayed.status]}
            </span>
            <span className="text-border" aria-hidden="true">
              ·
            </span>
            <span className="font-mono">rev {displayed.revision}</span>
            <span className="text-border" aria-hidden="true">
              ·
            </span>
            <span>{displayed.kind}</span>
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="m-0 text-[11px] text-muted-foreground">Updated</p>
          <p className="m-0 font-mono text-[11px] text-foreground">{formatEngagementTimestamp(displayed.updatedAt)}</p>
        </div>
      </header>

      {displayed.description !== null || displayed.authorizationContext !== null ? (
        <section
          aria-label="Engagement context"
          className="mt-4 overflow-hidden rounded-[10px] border border-border"
        >
          <div className="flex flex-col gap-1.5 px-3 py-2.5 text-[12px] leading-5 sm:flex-row sm:flex-wrap sm:gap-x-4">
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
          </div>
        </section>
      ) : null}

      <nav aria-label="Engagement sections" className="mt-4 flex flex-wrap gap-1 border-b border-border">
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
      </nav>

      {runId !== undefined ? (
        <p className="mt-3 mb-0 truncate font-mono text-[11px] text-muted-foreground" title={runId}>
          Selected run {runId}
        </p>
      ) : null}

      {activeTab === "surface" ? (
        <div className="mt-5">
          <EngagementDeadlineSection archived={archived} engagementId={displayed.id} />

          <ExecutionTray engagementId={displayed.id} onOpenRun={openRunFromTray} />

          <div className="mt-5">
            <EngagementServicesSection
              archived={archived}
              engagementId={displayed.id}
              onOpenNotes={openNotesFromSurface}
              onSelectKey={selectSurfaceItem}
              onSelectTarget={selectTarget}
              selectedKey={selectedItemKey}
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

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <ActionPlanner archived={archived} engagementId={displayed.id} />
            <SavedScopeEditor archived={archived} engagementId={displayed.id} />
          </div>
        </div>
      ) : null}

      {activeTab === "runs" ? (
        <div className="mt-5">
          <RunHistoryPanel
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
        />
      ) : null}

      {activeTab === "findings" ? (
        <EngagementFindingsSection
          key={`findings-${displayed.id}`}
          archived={archived}
          engagementId={displayed.id}
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

      {activeTab === "report" ? (
        <EngagementReportSection
          key={`report-${displayed.id}`}
          engagementId={displayed.id}
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
