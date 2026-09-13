import { createFileRoute } from "@tanstack/react-router";

import { EngagementWorkspace } from "../engagements/workspace.js";

// Engagement detail search. Raw strings pass through; the workspace resolves
// an unknown tab to the surface default and forwards the run id only through
// the existing encoded run-output query (no latest-run fallback). Target and
// sel carry STONE-2 surface investigation context (selected target and row)
// so browser Back steps through the investigation instead of leaving the
// engagement.
export function validateEngagementSearch(search: Record<string, unknown>): {
  tab?: string;
  run?: string;
  target?: string;
  sel?: string;
} {
  const result: { tab?: string; run?: string; target?: string; sel?: string } = {};
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
  const { run, sel, tab, target } = Route.useSearch();
  return (
    <EngagementWorkspace
      engagementId={engagementId}
      tab={tab}
      selectedRunId={run}
      selectedTargetId={target}
      selectedItemKey={sel}
    />
  );
}
