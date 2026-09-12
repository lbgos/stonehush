import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

import { browserStorage, storeLastEngagementId } from "../engagements/first-action.js";
import { EngagementWorkspace } from "../engagements/workspace.js";

// Engagement detail search. Raw strings pass through; the workspace resolves
// an unknown tab to the surface default and forwards the run id only through
// the existing encoded run-output query (no latest-run fallback). The action
// id carries a first scan that paused for a warning into the planner.
export function validateEngagementSearch(search: Record<string, unknown>): {
  action?: string;
  tab?: string;
  run?: string;
} {
  const result: { action?: string; tab?: string; run?: string } = {};
  if (typeof search.action === "string") result.action = search.action;
  if (typeof search.tab === "string") result.tab = search.tab;
  if (typeof search.run === "string") result.run = search.run;
  return result;
}

export const Route = createFileRoute("/engagements/$engagementId")({
  validateSearch: validateEngagementSearch,
  component: EngagementDetailPage,
});

function EngagementDetailPage() {
  const { engagementId } = Route.useParams();
  const { action, run, tab } = Route.useSearch();
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
      tab={tab}
    />
  );
}
