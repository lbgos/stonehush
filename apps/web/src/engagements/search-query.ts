import {
  EngagementSearchResponseSchema,
  type EngagementSearchResponse,
} from "@stonehush/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";

export const ENGAGEMENT_SEARCH_QUERY_ERROR_MESSAGE = "The search request failed.";

export class EngagementSearchQueryError extends Error {
  constructor() {
    super(ENGAGEMENT_SEARCH_QUERY_ERROR_MESSAGE);
    this.name = "EngagementSearchQueryError";
  }
}

export function engagementSearchQueryKey(engagementId: string, query: string) {
  return ["engagements", engagementId, "search", query] as const;
}

export function engagementSearchUrl(engagementId: string, query: string): string {
  return `/api/v1/engagements/${encodeURIComponent(engagementId)}/search?q=${encodeURIComponent(query)}`;
}

export async function fetchEngagementSearch(
  engagementId: string,
  query: string,
  signal?: AbortSignal,
): Promise<EngagementSearchResponse> {
  let response: Response;
  try {
    response = await fetch(engagementSearchUrl(engagementId, query), signal ? { signal } : undefined);
  } catch {
    throw new EngagementSearchQueryError();
  }
  if (response.status !== 200) throw new EngagementSearchQueryError();
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new EngagementSearchQueryError();
  }
  const result = EngagementSearchResponseSchema.safeParse(payload);
  if (!result.success) throw new EngagementSearchQueryError();
  return result.data;
}

export function engagementSearchQueryOptions(engagementId: string, query: string) {
  return queryOptions({
    queryKey: engagementSearchQueryKey(engagementId, query),
    queryFn: ({ signal }) => fetchEngagementSearch(engagementId, query, signal),
    staleTime: 30_000,
  });
}

/** Disabled (no fetch) until the operator types at least 2 characters. */
export function useEngagementSearchQuery(engagementId: string, query: string) {
  return useQuery({
    ...engagementSearchQueryOptions(engagementId, query.trim()),
    enabled: query.trim().length >= 2,
  });
}
