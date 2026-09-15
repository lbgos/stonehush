import type { PersistedAction } from "@stonehush/contracts";
import { queryOptions, skipToken } from "@tanstack/react-query";

import { fetchPersistedAction } from "./action-mutations.js";
import { ENGAGEMENTS_QUERY_KEY } from "./query.js";

const TERMINAL_ACTION_STATES = new Set<PersistedAction["action"]["state"]>([
  "succeeded",
  "failed",
  "cancelled",
  "capability_error",
]);

export function isTerminalActionState(state: PersistedAction["action"]["state"]): boolean {
  return TERMINAL_ACTION_STATES.has(state);
}

export function persistedActionQueryKey(engagementId: string, actionId: string | undefined) {
  return [...ENGAGEMENTS_QUERY_KEY, engagementId, "actions", actionId] as const;
}

export function persistedActionQueryOptions(engagementId: string, actionId: string | undefined) {
  return queryOptions({
    queryKey: persistedActionQueryKey(engagementId, actionId),
    queryFn: actionId
      ? ({ signal }) => fetchPersistedAction(engagementId, actionId, signal)
      : skipToken,
  });
}

export function actionLifecycleStatusCopy(input: Pick<PersistedAction["action"], "state" | "runState">): string {
  switch (input.state) {
    case "queued":
      return "Action queued";
    case "active":
      return input.runState === "cancel_requested" ? "Action cancelling" : "Action running";
    case "active_paused_for_warning":
      return "Action paused for warning";
    case "succeeded":
      return "Action succeeded";
    case "failed":
      return "Action failed";
    case "cancelled":
      return "Action cancelled";
    case "capability_error":
      return "This action cannot run";
    case "paused_for_warning":
      return "Action needs a warning";
    case "planning":
      return "Action planning";
  }
}
