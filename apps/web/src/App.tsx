import { ApplicationShell, type ConsolePanel } from "@stonehush/ui";
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { CreateEngagementDialog } from "./engagements/create-dialog.js";
import { EngagementSidebarList } from "./engagements/sidebar.js";
import { RawOutputPanel } from "./engagements/run-output.js";
import {
  EngagementWorkspaceProvider,
  useEngagementWorkspace,
} from "./engagements/workspace-context.js";
import { SettingsBackButton, SettingsNav } from "./settings/sidebar.js";
import { SettingsViewProvider } from "./settings/settings-view.js";
import { StageHeader } from "./stage-header.js";
import { AdvisorStatusCard } from "./advisor-status-card.js";
import { useSystemStatusQuery } from "./system-status-query.js";

const consolePanels: readonly ConsolePanel[] = [
  {
    value: "advisor",
    label: "Advisor",
    content: <AdvisorStatusCard />,
  },
  {
    value: "activity",
    label: "Activity",
    content: (
      <ConsolePlaceholder
        title="Activity"
        detail="Queue, run, cancel, and retry events will appear here. No runs are connected yet."
      />
    ),
  },
  {
    value: "raw-output",
    label: "Raw output",
    content: <RawOutputPanel />,
  },
];

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4 shrink-0" aria-hidden="true">
      <circle cx="7" cy="7" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M10.4 10.4 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4 shrink-0" aria-hidden="true">
      <path d="M8 3.2v9.6M3.2 8h9.6" fill="none" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function ConsolePlaceholder({ detail, title }: { detail: string; title: string }) {
  return (
    <div>
      <p className="m-0 text-[13px] font-semibold">{title}</p>
      <p className="mt-1 mb-0 text-[13px] text-muted-foreground">{detail}</p>
    </div>
  );
}

function SidebarHeader() {
  return (
    <div className="flex h-12 items-center gap-2 px-3 pt-[env(safe-area-inset-top)]">
      <Link
        to="/"
        aria-label="Stonehush home"
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <img
          src="/brand/stonehush-icon.svg"
          alt=""
          aria-hidden="true"
          width="20"
          height="20"
          className="size-5 shrink-0 rounded-[4px]"
        />
        <span className="m-0 min-w-0 flex-1 truncate text-[13px] font-semibold tracking-[-0.03em] text-sidebar-foreground">
          STONEHUSH
        </span>
      </Link>
    </div>
  );
}

function SidebarActions({
  onCreate,
  onNavigate,
}: {
  onCreate: () => void;
  onNavigate: () => void;
}) {
  const { engagementFilter, setEngagementFilter } = useEngagementWorkspace();

  return (
    <div className="flex items-center gap-0.5 px-2 py-1.5">
      <label className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-sidebar-muted-foreground focus-within:bg-sidebar-hover md:min-h-8">
        <SearchIcon />
        <span className="sr-only">Filter engagements</span>
        <input
          type="search"
          value={engagementFilter}
          placeholder="Filter engagements"
          aria-label="Filter engagements"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-sidebar-foreground outline-none placeholder:text-sidebar-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onChange={(event) => setEngagementFilter(event.target.value)}
        />
      </label>
      <button
        type="button"
        aria-label="New engagement"
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-sidebar-muted-foreground outline-none hover:bg-sidebar-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring md:size-8"
        onClick={() => {
          onNavigate();
          onCreate();
        }}
      >
        <PlusIcon />
      </button>
    </div>
  );
}

function PluginsIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4 shrink-0" aria-hidden="true">
      <path d="M4.2 5.2h7.6v7.2H4.2z" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M6 5.2V3.8h4v1.4" fill="none" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4 shrink-0" aria-hidden="true">
      <circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M8 2.2v1.4M8 12.4v1.4M2.2 8h1.4M12.4 8h1.4M3.9 3.9l1 1M11.1 11.1l1 1M12.1 3.9l-1 1M4.9 11.1l-1 1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

const footerLinkClasses =
  "flex min-h-11 items-center gap-2 rounded-lg px-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-8";

function SidebarFooter({ onNavigate }: { onNavigate: () => void }) {
  return (
    <div className="flex flex-col gap-0.5 px-2 py-2.5">
      <Link
        to="/plugins"
        activeProps={{ className: `${footerLinkClasses} bg-sidebar-active text-sidebar-foreground` }}
        className={`${footerLinkClasses} text-sidebar-muted-foreground hover:bg-sidebar-hover hover:text-sidebar-foreground`}
        onClick={onNavigate}
      >
        <PluginsIcon />
        Plugins
      </Link>
      <Link
        to="/settings"
        activeOptions={{ exact: true }}
        activeProps={{ className: `${footerLinkClasses} bg-sidebar-active text-sidebar-foreground` }}
        className={`${footerLinkClasses} text-sidebar-muted-foreground hover:bg-sidebar-hover hover:text-sidebar-foreground`}
        onClick={onNavigate}
      >
        <SettingsIcon />
        Settings
      </Link>
    </div>
  );
}

function WorkspaceNotice() {
  const { notice } = useEngagementWorkspace();
  return (
    <p
      className={
        notice
          ? "border-b border-border px-4 py-2 text-[13px] text-muted-foreground"
          : "sr-only"
      }
      data-testid="workspace-notice"
      role="status"
    >
      {notice ?? ""}
    </p>
  );
}

function consoleStatusLabel(systemStatus: ReturnType<typeof useSystemStatusQuery>): string {
  if (systemStatus.data?.overall === "ready") return "No active runs · System ready";
  if (systemStatus.data) return "No active runs · System not ready";
  if (systemStatus.isError) return "No active runs · System unavailable";
  return "No active runs";
}

export function ApplicationLayout() {
  const [createOpen, setCreateOpen] = useState(false);
  const openCreate = () => setCreateOpen(true);
  const systemStatus = useSystemStatusQuery();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const onSettings = pathname === "/settings";
  const onPlugins = pathname === "/plugins";
  // Reference chrome visibility: Settings drops the desktop stage header and
  // console; Plugins keeps the header but drops the console; other routes keep both.
  const showConsole = !onSettings && !onPlugins;
  const showDesktopStageHeader = !onSettings;
  // The settings Back control returns to the last non-settings route, which also
  // covers direct /settings entry where no internal route was visited yet.
  const returnPath = useRef("/");
  useEffect(() => {
    if (!onSettings) returnPath.current = pathname;
  }, [onSettings, pathname]);
  const goBackFromSettings = () => {
    void navigate({ to: returnPath.current });
  };

  return (
    <EngagementWorkspaceProvider openCreate={openCreate}>
      <SettingsViewProvider active={onSettings}>
        <ApplicationShell
          consolePanels={consolePanels}
          consoleStatus={consoleStatusLabel(systemStatus)}
          mobileBrand={
            <Link
              to="/"
              className="block truncate rounded outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              Stonehush
            </Link>
          }
          showConsole={showConsole}
          showDesktopStageHeader={showDesktopStageHeader}
          sidebarActions={
            onSettings
              ? undefined
              : (closeMobile) => <SidebarActions onCreate={openCreate} onNavigate={closeMobile} />
          }
          sidebarContent={(closeMobile) =>
            onSettings ? (
              <SettingsNav onCloseMobile={closeMobile} />
            ) : (
              <EngagementSidebarList onNavigate={closeMobile} />
            )
          }
          sidebarFooter={(closeMobile) =>
            onSettings ? (
              <div className="px-2 py-2.5">
                <SettingsBackButton onBack={goBackFromSettings} onCloseMobile={closeMobile} />
              </div>
            ) : (
              <SidebarFooter onNavigate={closeMobile} />
            )
          }
          sidebarHeader={<SidebarHeader />}
          stageHeader={<StageHeader />}
        >
          <WorkspaceNotice />
          <Outlet />
        </ApplicationShell>
        <CreateEngagementDialog open={createOpen} onOpenChange={setCreateOpen} />
      </SettingsViewProvider>
    </EngagementWorkspaceProvider>
  );
}
