import { AdvisorStatusSchema, type AdvisorStatus } from "@stonehush/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";

export const ADVISOR_STATUS_QUERY_KEY = ["advisor", "status"] as const;
export const ADVISOR_STATUS_QUERY_ERROR_MESSAGE = "The advisor status request failed.";

export class AdvisorStatusQueryError extends Error {
  constructor() {
    super(ADVISOR_STATUS_QUERY_ERROR_MESSAGE);
    this.name = "AdvisorStatusQueryError";
  }
}

export async function fetchAdvisorStatus(signal?: AbortSignal): Promise<AdvisorStatus> {
  try {
    const response = await fetch("/api/v1/advisor/status", signal ? { signal } : undefined);
    if (response.status !== 200) throw new AdvisorStatusQueryError();

    const payload: unknown = await response.json();
    const result = AdvisorStatusSchema.safeParse(payload);
    if (!result.success) throw new AdvisorStatusQueryError();
    return result.data;
  } catch (error) {
    if (error instanceof AdvisorStatusQueryError) throw error;
    throw new AdvisorStatusQueryError();
  }
}

export const advisorStatusQueryOptions = queryOptions({
  queryKey: ADVISOR_STATUS_QUERY_KEY,
  // TanStack supplies the lifecycle signal so discarded requests stop promptly.
  queryFn: ({ signal }) => fetchAdvisorStatus(signal),
});

export function useAdvisorStatusQuery() {
  return useQuery(advisorStatusQueryOptions);
}
