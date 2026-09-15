import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";

import { engagementMutationMessage, isRevisionConflict } from "./engagements/errors.js";
import { DeadlinePill } from "./engagements/deadline.js";
import {
  useArchiveEngagementMutation,
  useReopenEngagementMutation,
} from "./engagements/mutations.js";
import { useEngagementsQuery } from "./engagements/query.js";
import { useSelectedEngagementId } from "./engagements/sidebar.js";
import { useEngagementWorkspace } from "./engagements/workspace-context.js";

interface Crumb {
  href?: "/" | "/engagements";
  label: string;
}

export function StageHeader() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const selectedId = useSelectedEngagementId();
  const engagements = useEngagementsQuery();
  const { clearNotice } = useEngagementWorkspace();
  const selected = selectedId
    ? engagements.data?.find((engagement) => engagement.id === selectedId)
    : undefined;

  useEffect(() => {
    clearNotice();
  }, [clearNotice, pathname]);

  const crumbs = crumbsForPath(pathname, selected?.name);

  // Stage chrome: plugins shows Stonehush / Plugins with disabled Install from path
  const isPlugins = pathname === "/plugins";
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-[13px] text-muted-foreground">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <span key={`${crumb.label}-${index}`} className="flex min-w-0 items-center gap-2">
              {index > 0 && (
                <span className="text-border" aria-hidden="true">
                  /
                </span>
              )}
              {crumb.href && !last ? (
                <Link
                  to={crumb.href}
                  className="truncate outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span className={last ? "truncate font-medium text-foreground" : "truncate"}>
                  {crumb.label}
                </span>
              )}
            </span>
          );
        })}
      </nav>
      {selected ? (
        <EngagementStageActions engagementId={selected.id} />
      ) : isPlugins ? (
        <PluginStageActions />
      ) : (
        <GlobalStageActions />
      )}
    </div>
  );
}

function GlobalStageActions() {
  const { openCreate } = useEngagementWorkspace();
  return (
    <div className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        className="inline-flex min-h-11 items-center rounded-md bg-primary px-3 text-[13px] font-semibold text-primary-foreground outline-none hover:brightness-[1.06] focus-visible:ring-2 focus-visible:ring-ring md:min-h-8"
        onClick={openCreate}
      >
        New engagement
      </button>
    </div>
  );
}

function PluginStageActions() {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        aria-disabled="true"
        disabled
        title="Installing from a path stays unavailable until decision gate D5 defines the plugin protocol."
        className="inline-flex min-h-8 items-center justify-center rounded-lg border border-border px-3 text-[13px] text-muted-foreground opacity-60"
      >
        Install from path
      </button>
    </div>
  );
}

function EngagementStageActions({ engagementId }: { engagementId: string }) {
  const engagements = useEngagementsQuery();
  const engagement = engagements.data?.find((item) => item.id === engagementId);
  const archive = useArchiveEngagementMutation();
  const reopen = useReopenEngagementMutation();
  const navigate = useNavigate();
  const search = useRouterState({ select: (state) => state.location.search });
  const { requestFocusRuns } = useEngagementWorkspace();

  useEffect(() => {
    archive.reset();
    reopen.reset();
  }, [engagementId]);

  if (!engagement) return null;

  const pending = archive.isPending || reopen.isPending;
  const error = archive.error ?? reopen.error;
  const conflict = isRevisionConflict(error);
  const isActive = engagement.status === "active";

  // New run works from every tab: route to Surface (keeping the common run
  // selection) and focus the existing planner after it mounts. The navigation
  // goes through the router so a dirty notes draft still blocks it; Stay keeps
  // the draft and launches nothing. This starts no execution by itself.
  const startNewRun = () => {
    const run = (search as Record<string, unknown>)["run"];
    void navigate({
      to: "/engagements/$engagementId",
      params: { engagementId },
      search:
        typeof run === "string" && run.length > 0
          ? { tab: "surface", run }
          : { tab: "surface" },
    });
    requestFocusRuns();
  };

  return (
    <div className="flex min-w-0 shrink-0 items-center gap-1">
      <DeadlinePill deadlineAt={engagement.deadlineAt} />
      <button
        type="button"
        className="inline-flex h-8 items-center rounded-md px-2 text-[13px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={startNewRun}
      >
        New run
      </button>
      <button
        type="button"
        disabled={pending}
        className="inline-flex h-8 items-center rounded-md border border-border px-3 text-[13px] font-semibold text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        onClick={() => {
          if (isActive) {
            archive.mutate({
              engagementId: engagement.id,
              expectedRevision: engagement.revision,
            });
            return;
          }
          reopen.mutate({
            engagementId: engagement.id,
            expectedRevision: engagement.revision,
          });
        }}
      >
        {pending ? "Working" : isActive ? "Archive engagement" : "Reopen engagement"}
      </button>
      {error && (
        <p className="m-0 max-w-[14rem] text-[11px] leading-4 text-destructive" role="alert">
          {conflict
            ? "This engagement changed. Showing the latest revision."
            : engagementMutationMessage(error)}
        </p>
      )}
    </div>
  );
}

function crumbsForPath(pathname: string, engagementName?: string): Crumb[] {
  if (pathname === "/") return [{ label: "Dashboard" }];
  if (pathname === "/engagements") return [{ href: "/engagements", label: "Engagements" }];
  if (pathname.startsWith("/engagements/")) {
    return [
      { href: "/engagements", label: "Engagements" },
      { label: engagementName ?? "Engagement" },
    ];
  }
  if (pathname === "/plugins") return [{ href: "/", label: "Stonehush" }, { label: "Plugins" }];
  if (pathname === "/settings") return [{ label: "Settings" }];
  return [{ label: "Page not found" }];
}

export { crumbsForPath };
