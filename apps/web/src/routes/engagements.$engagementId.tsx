import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

import { browserStorage, storeLastEngagementId } from "../engagements/first-action.js";
import { EngagementWorkspace } from "../engagements/workspace.js";

// Engagement detail search. Raw strings pass through; the workspace resolves
// an unknown tab to the surface default and forwards the run id only through
// the existing encoded run-output query (no latest-run fallback). The action
// id carries a first scan that paused for a warning into the planner. Target
// and sel carry STONE-2 surface investigation context (selected target and row)
// so browser Back steps through the investigation instead of leaving the
// engagement.
export function validateEngagementSearch(search: Record<string, unknown>): {
  action?: string;
  tab?: string;
  run?: string;
  target?: string;
  sel?: string;
} {
  const result: {
    action?: string;
    tab?: string;
    run?: string;
    target?: string;
    sel?: string;
  } = {};
  if (typeof search.action === "string") result.action = search.action;
  if (typeof search.tab === "string") result.tab = search.tab;
  if (typeof search.run === "string") result.run = search.run;
  if (typeof search.target === "string") result.target = search.target;
  if (typeof search.sel === "string") result.sel = search.sel;
  return result;
}

export const Route = createFileRoute("/engagements/$engagementId")({
  validateSearch: validateEngagementSearch,
  component: EngagementDetailPage,
});

function EngagementDetailPage() {
  const { engagementId } = Route.useParams();
  const { action, run, sel, tab, target } = Route.useSearch();
  // Resume follows the last-opened engagement, however it was opened. The
  // stored id updates on every detail visit so sidebar and list navigation
  // count, not just creation and the Resume link.
  useEffect(() => {
    storeLastEngagementId(browserStorage(), engagementId);
  }, [engagementId]);
  return (
    <EngagementWorkspace
      engagementId={engagementId}
      pendingActionId={action}
      selectedRunId={run}
      selectedTargetId={target}
      selectedItemKey={sel}
      tab={tab}
    />
  );
}
