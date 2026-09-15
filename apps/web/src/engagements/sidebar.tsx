import {
  LoadingRegion,
  RowContextMenu,
  SidebarCardRow,
  SidebarCompactRow,
  SidebarRowAction,
  SidebarShelf,
  Skeleton,
} from "@stonehush/ui";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { MouseEvent } from "react";

import { engagementMutationMessage, isRevisionConflict } from "./errors.js";
import {
  ENGAGEMENT_KIND_LABELS,
  engagementContext,
  engagementMetadata,
} from "./format.js";
import {
  useArchiveEngagementMutation,
  useReopenEngagementMutation,
} from "./mutations.js";
import { partitionEngagements, useEngagementsQuery } from "./query.js";
import { copyTextToClipboard } from "./report-query.js";
import { engagementMatchesFilter, useEngagementWorkspace } from "./workspace-context.js";

export function EngagementSidebarList({ onNavigate }: { onNavigate: () => void }) {
  const engagements = useEngagementsQuery();
  const { engagementFilter, openCreate } = useEngagementWorkspace();
  const selectedId = useSelectedEngagementId();
  const interceptNavigation = useEngagementLinkNavigation(onNavigate);
  const hasData = engagements.data !== undefined;

  if (!hasData && engagements.isFetching) {
    return (
      <LoadingRegion label="Loading engagements" className="space-y-2 px-3 py-2">
        <Skeleton className="h-[78px] w-full" />
        <Skeleton className="h-[78px] w-full" />
        <Skeleton className="h-11 w-full" />
      </LoadingRegion>
    );
  }

  if (!hasData && engagements.isError) {
    return (
      <div className="px-3 py-3" role="alert">
        <p className="m-0 text-xs text-sidebar-muted-foreground">Engagements could not be loaded.</p>
        <button
          type="button"
          className="mt-2 inline-flex min-h-11 items-center text-xs font-semibold text-sidebar-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring md:min-h-8"
          onClick={() => void engagements.refetch()}
        >
          Retry
        </button>
      </div>
    );
  }

  const records = engagements.data ?? [];
  const filtered = records.filter((engagement) =>
    engagementMatchesFilter(
      engagement.name,
      ENGAGEMENT_KIND_LABELS[engagement.kind],
      engagementFilter,
    ),
  );
  const { active, archived } = partitionEngagements(filtered);
  const filterActive = engagementFilter.trim().length > 0;

  if (records.length === 0) {
    return (
      <div className="px-3 py-4">
        <p className="m-0 text-xs leading-5 text-sidebar-muted-foreground">
          No engagements yet. Create one to start local work.
        </p>
        <button
          type="button"
          className="mt-2 inline-flex min-h-11 items-center text-xs font-semibold text-sidebar-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring md:min-h-8"
          onClick={openCreate}
        >
          New engagement
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3 px-3 pt-1 pb-4">
      {engagements.isError && (
        <p className="m-0 px-2 text-xs text-warning" role="status">
          Showing the last successful engagement list.
          <button
            type="button"
            className="ml-2 min-h-11 font-semibold underline outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-8"
            onClick={() => void engagements.refetch()}
          >
            Refresh
          </button>
        </p>
      )}
      {filterActive && filtered.length === 0 && (
        <p className="m-0 px-2 py-3 text-xs leading-5 text-sidebar-muted-foreground">
          No engagements match this filter.
        </p>
      )}
      <section aria-label="Active engagements">
        {active.length === 0 && !(filterActive && filtered.length === 0) ? (
          <div className="px-2 py-3">
            <p className="m-0 text-xs leading-5 text-sidebar-muted-foreground">
              No active engagements. Archived work stays below.
            </p>
            <button
              type="button"
              className="mt-2 inline-flex min-h-11 items-center text-xs font-semibold text-sidebar-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring md:min-h-8"
              onClick={openCreate}
            >
              New engagement
            </button>
          </div>
        ) : active.length === 0 ? null : (
          <ul
            className="m-0 list-none space-y-1 p-0"
            onClick={interceptNavigation}
          >
            {active.map((engagement) => (
              <li key={engagement.id}>
                <EngagementRow
                  compact={false}
                  current={engagement.id === selectedId}
                  engagement={engagement}
                  onNavigate={onNavigate}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
      {archived.length > 0 && (
        <SidebarShelf
          {...(selectedId ? { currentId: selectedId } : {})}
          defaultOpen={selectedId !== undefined && archived.some((item) => item.id === selectedId)}
          getId={(item) => item.id}
          items={archived}
          renderItem={(engagement) => (
            <div onClick={interceptNavigation}>
              <EngagementRow
                compact
                current={engagement.id === selectedId}
                engagement={engagement}
                onNavigate={onNavigate}
              />
            </div>
          )}
          title="Archived"
        />
      )}
    </div>
  );
}

function EngagementRow({
  compact,
  current,
  engagement,
  onNavigate,
}: {
  compact: boolean;
  current: boolean;
  engagement: ReturnType<typeof partitionEngagements>["active"][number];
  onNavigate: () => void;
}) {
  const navigate = useNavigate();
  const archive = useArchiveEngagementMutation();
  const reopen = useReopenEngagementMutation();
  const href = `/engagements/${engagement.id}`;
  const pending = archive.isPending || reopen.isPending;
  const error = archive.error ?? reopen.error;
  const conflict = isRevisionConflict(error);
  const Row = compact ? SidebarCompactRow : SidebarCardRow;
  const toggleLabel = engagement.status === "active" ? `Archive ${engagement.name}` : `Reopen ${engagement.name}`;
  const toggleStatus = () => {
    if (pending) return;
    if (engagement.status === "active") {
      archive.mutate({
        engagementId: engagement.id,
        expectedRevision: engagement.revision,
      });
    } else {
      reopen.mutate({
        engagementId: engagement.id,
        expectedRevision: engagement.revision,
      });
    }
  };
  const openEngagement = () => {
    void navigate({
      to: "/engagements/$engagementId",
      params: { engagementId: engagement.id },
    });
    onNavigate();
  };

  return (
    <div>
      <RowContextMenu
        label={`${engagement.name} actions`}
        items={[
          { label: "Open engagement", onSelect: openEngagement },
          {
            label: "Copy engagement name",
            onSelect: () => void copyTextToClipboard(engagement.name),
          },
          {
            label: "Copy engagement ID",
            onSelect: () => void copyTextToClipboard(engagement.id),
          },
          { separator: true },
          { label: toggleLabel, onSelect: toggleStatus, disabled: pending },
        ]}
      >
        <Row
          action={
            engagement.status === "active" ? (
              <SidebarRowAction
                disabled={pending}
                label={`Archive ${engagement.name}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  toggleStatus();
                }}
              >
                Archive
              </SidebarRowAction>
            ) : (
              <SidebarRowAction
                disabled={pending}
                label={`Reopen ${engagement.name}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  toggleStatus();
                }}
              >
                Reopen
              </SidebarRowAction>
            )
          }
          context={engagementContext(engagement)}
          current={current}
          href={href}
          itemId={engagement.id}
          metadata={engagementMetadata(engagement)}
          onNavigate={onNavigate}
          title={engagement.name}
        />
      </RowContextMenu>
      {error && (
        <p className="m-0 px-3 py-1 text-[11px] text-destructive" role="alert">
          {conflict
            ? "This engagement changed. Showing the latest revision."
            : engagementMutationMessage(error)}
        </p>
      )}
    </div>
  );
}

function useEngagementLinkNavigation(onNavigate: () => void) {
  const navigate = useNavigate();
  return (event: MouseEvent) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    if (event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("button")) return;
    const href = target.closest("a")?.getAttribute("href");
    if (!href?.startsWith("/engagements/")) return;
    const engagementId = href.slice("/engagements/".length);
    if (engagementId.length === 0 || engagementId.includes("/")) return;
    event.preventDefault();
    void navigate({
      to: "/engagements/$engagementId",
      params: { engagementId },
    });
    onNavigate();
  };
}

export function useSelectedEngagementId(): string | undefined {
  return useRouterState({
    select: (state) => {
      const match = state.matches.find((item) => item.routeId === "/engagements/$engagementId");
      const params = match?.params as { engagementId?: string } | undefined;
      return params?.engagementId;
    },
  });
}
