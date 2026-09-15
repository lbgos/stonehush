import {
  RUN_HISTORY_DEFAULT_LIMIT,
  RunHistoryResponseSchema,
  type RunHistoryResponse,
} from "@stonehush/contracts";
import { infiniteQueryOptions, skipToken, useInfiniteQuery } from "@tanstack/react-query";

export const RUN_HISTORY_QUERY_ERROR_MESSAGE = "The run history request failed.";

export class RunHistoryQueryError extends Error {
  constructor() {
    super(RUN_HISTORY_QUERY_ERROR_MESSAGE);
    this.name = "RunHistoryQueryError";
  }
}

export function runHistoryQueryKey(engagementId: string) {
  return ["engagements", engagementId, "runs"] as const;
}

export interface FetchRunHistoryPageInput {
  readonly limit?: number;
  readonly before?: string;
}

// Bounded list URL. Limit always ships explicitly so page requests stay
// bounded; the default matches the contract. The cursor is opaque here and
// forwarded verbatim through URLSearchParams, never decoded client-side.
export function runHistoryListUrl(
  engagementId: string,
  input: FetchRunHistoryPageInput = {},
): string {
  const params = new URLSearchParams();
  params.set("limit", String(input.limit ?? RUN_HISTORY_DEFAULT_LIMIT));
  if (input.before !== undefined) params.set("before", input.before);
  return `/api/v1/engagements/${encodeURIComponent(engagementId)}/runs?${params.toString()}`;
}

export async function fetchRunHistoryPage(
  engagementId: string,
  input: FetchRunHistoryPageInput = {},
  signal?: AbortSignal,
): Promise<RunHistoryResponse> {
  let response: Response;
  try {
    response = await fetch(
      runHistoryListUrl(engagementId, input),
      signal ? { signal } : undefined,
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new RunHistoryQueryError();
  }
  if (response.status !== 200) throw new RunHistoryQueryError();
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new RunHistoryQueryError();
  }
  const result = RunHistoryResponseSchema.safeParse(payload);
  if (!result.success) throw new RunHistoryQueryError();
  return result.data;
}

// Single infinite-query cache per engagement and page size. The contract
// nextCursor feeds the next pageParam; a null cursor ends the list.
export function runHistoryInfiniteQueryOptions(
  engagementId: string | undefined,
  limit: number = RUN_HISTORY_DEFAULT_LIMIT,
) {
  return infiniteQueryOptions({
    queryKey:
      engagementId === undefined
        ? (["engagements", "runs", "history", "none"] as const)
        : ([...runHistoryQueryKey(engagementId), limit] as const),
    queryFn:
      engagementId === undefined
        ? skipToken
        : ({ pageParam, signal }) =>
            fetchRunHistoryPage(
              engagementId,
              pageParam === undefined ? { limit } : { limit, before: pageParam },
              signal,
            ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    retry: false,
  });
}

export function useRunHistoryQuery(
  engagementId: string | undefined,
  limit?: number,
) {
  return useInfiniteQuery(runHistoryInfiniteQueryOptions(engagementId, limit));
}
