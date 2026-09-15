import {
  SystemStatusResponseSchema,
  type SystemStatusResponse,
} from "@stonehush/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";

export const SYSTEM_STATUS_QUERY_KEY = ["system", "status"] as const;
export const SYSTEM_STATUS_QUERY_ERROR_MESSAGE = "The system status request failed.";

export class SystemStatusQueryError extends Error {
  constructor() {
    super(SYSTEM_STATUS_QUERY_ERROR_MESSAGE);
    this.name = "SystemStatusQueryError";
  }
}

export async function fetchSystemStatus(signal?: AbortSignal): Promise<SystemStatusResponse> {
  try {
    const response = await fetch("/api/v1/system/status", signal ? { signal } : undefined);
    if (response.status !== 200 && response.status !== 503) throw new SystemStatusQueryError();

    const payload: unknown = await response.json();
    const result = SystemStatusResponseSchema.safeParse(payload);
    if (!result.success) throw new SystemStatusQueryError();
    if (response.status === 200 && result.data.overall !== "ready") {
      throw new SystemStatusQueryError();
    }
    if (response.status === 503 && result.data.overall !== "not_ready") {
      throw new SystemStatusQueryError();
    }
    return result.data;
  } catch (error) {
    if (error instanceof SystemStatusQueryError) throw error;
    throw new SystemStatusQueryError();
  }
}

export const systemStatusQueryOptions = queryOptions({
  queryKey: SYSTEM_STATUS_QUERY_KEY,
  // TanStack supplies the lifecycle signal so discarded requests stop promptly.
  queryFn: ({ signal }) => fetchSystemStatus(signal),
});

export function useSystemStatusQuery() {
  return useQuery(systemStatusQueryOptions);
}
