import {
  EngagementSearchResponseSchema,
  type EngagementSearchResponse,
} from "@stonehush/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

export const ENGAGEMENT_SEARCH_QUERY_ERROR_MESSAGE = "The search request failed.";
export const ENGAGEMENT_SEARCH_DEBOUNCE_MS = 200;

export class EngagementSearchQueryError extends Error {
  constructor() {
    super(ENGAGEMENT_SEARCH_QUERY_ERROR_MESSAGE);
    this.name = "EngagementSearchQueryError";
  }
}

export function engagementSearchQueryKey(engagementId: string, query?: string) {
  const prefix = ["engagements", engagementId, "search"] as const;
  return query === undefined ? prefix : [...prefix, query] as const;
}

export function engagementSearchUrl(engagementId: string, query: string): string {
  return `/api/v1/engagements/${encodeURIComponent(engagementId)}/search?q=${encodeURIComponent(query)}`;
}

/**
 * Fetch one search. A response for another engagement or another query is
 * rejected, so results can never cross engagements or queries.
 */
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
  if (result.data.engagementId !== engagementId || result.data.query !== query) {
    throw new EngagementSearchQueryError();
  }
  return result.data;
}

/**
 * Search results are never served from cache: notes and findings change
 * under the operator, and the app disables refetch on mount. Each query key
 * fetches when first observed and is dropped once unobserved, which also
 * aborts a request superseded by newer input or a closed dialog.
 */
export function engagementSearchQueryOptions(engagementId: string, query: string) {
  return queryOptions({
    queryKey: engagementSearchQueryKey(engagementId, query),
    queryFn: ({ signal }) => fetchEngagementSearch(engagementId, query, signal),
    staleTime: 0,
    refetchOnMount: "always",
    gcTime: 0,
  });
}

/** Disabled (no fetch) while `query` is null, i.e. outside the input bounds. */
export function useEngagementSearchQuery(engagementId: string, query: string | null) {
  return useQuery({
    ...engagementSearchQueryOptions(engagementId, query ?? ""),
    enabled: query !== null,
  });
}

/** Latest value after it has held still for `delayMs`. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}
