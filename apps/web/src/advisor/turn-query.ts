import {
  AdvisorTurnErrorSchema,
  AdvisorTurnListResponseSchema,
  AdvisorTurnSchema,
  CreateAdvisorTurnRequestSchema,
  type AdvisorTurn,
  type AdvisorTurnError,
  type AdvisorTurnListResponse,
  type CreateAdvisorTurnRequest,
} from "@stonehush/contracts";
import {
  infiniteQueryOptions,
  skipToken,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";

export const ADVISOR_TURNS_QUERY_ERROR_MESSAGE = "The advisor history request failed.";
export const ADVISOR_TURN_REQUEST_ERROR_MESSAGE = "The advisor request failed.";

export class AdvisorTurnsQueryError extends Error {
  constructor() {
    super(ADVISOR_TURNS_QUERY_ERROR_MESSAGE);
    this.name = "AdvisorTurnsQueryError";
  }
}

export class AdvisorTurnRequestError extends Error {
  readonly code: AdvisorTurnError["code"] | "request_failed";

  constructor(code: AdvisorTurnError["code"] | "request_failed" = "request_failed") {
    super(ADVISOR_TURN_REQUEST_ERROR_MESSAGE);
    this.name = "AdvisorTurnRequestError";
    this.code = code;
  }
}

function parseTurnError(payload: unknown): AdvisorTurnRequestError {
  const parsed = AdvisorTurnErrorSchema.safeParse(payload);
  if (parsed.success) return new AdvisorTurnRequestError(parsed.data.code);
  return new AdvisorTurnRequestError();
}

export function advisorTurnsQueryKey(engagementId: string) {
  return ["engagements", engagementId, "advisor", "turns"] as const;
}

export interface FetchAdvisorTurnsPageInput {
  readonly limit?: number;
  readonly before?: { readonly createdAt: string; readonly id: string };
}

// Bounded list URL. Limit always ships explicitly so page requests stay
// bounded; cursor fields forward verbatim, never decoded client-side.
export function advisorTurnsListUrl(
  engagementId: string,
  input: FetchAdvisorTurnsPageInput = {},
): string {
  const params = new URLSearchParams();
  params.set("limit", String(input.limit ?? 50));
  if (input.before !== undefined) {
    params.set("beforeCreatedAt", input.before.createdAt);
    params.set("beforeId", input.before.id);
  }
  return `/api/v1/engagements/${encodeURIComponent(engagementId)}/advisor/turns?${params.toString()}`;
}

export async function fetchAdvisorTurnsPage(
  engagementId: string,
  input: FetchAdvisorTurnsPageInput = {},
  signal?: AbortSignal,
): Promise<AdvisorTurnListResponse> {
  let response: Response;
  try {
    response = await fetch(
      advisorTurnsListUrl(engagementId, input),
      signal ? { signal } : undefined,
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new AdvisorTurnsQueryError();
  }
  if (response.status !== 200) throw new AdvisorTurnsQueryError();
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AdvisorTurnsQueryError();
  }
  const result = AdvisorTurnListResponseSchema.safeParse(payload);
  if (!result.success) throw new AdvisorTurnsQueryError();
  return result.data;
}

export function advisorTurnsInfiniteQueryOptions(engagementId: string | undefined) {
  return infiniteQueryOptions({
    queryKey:
      engagementId === undefined
        ? (["engagements", "advisor", "turns", "none"] as const)
        : ([...advisorTurnsQueryKey(engagementId)] as const),
    queryFn:
      engagementId === undefined
        ? skipToken
        : ({ pageParam, signal }) =>
            fetchAdvisorTurnsPage(
              engagementId,
              pageParam === undefined ? {} : { before: pageParam },
              signal,
            ),
    initialPageParam: undefined as { createdAt: string; id: string } | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    retry: false,
  });
}

export function useAdvisorTurnsQuery(engagementId: string | undefined) {
  return useInfiniteQuery(advisorTurnsInfiniteQueryOptions(engagementId));
}

export interface RequestAdvisorTurnInput {
  readonly question: string;
  readonly excerptArtifactIds: readonly string[];
  readonly findingIds: readonly string[];
}

export async function requestAdvisorTurn(
  engagementId: string,
  input: RequestAdvisorTurnInput,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<AdvisorTurn> {
  const body: CreateAdvisorTurnRequest = CreateAdvisorTurnRequestSchema.parse({
    engagementId,
    ...input,
  });
  let response: Response;
  try {
    response = await fetch(`/api/v1/engagements/${encodeURIComponent(engagementId)}/advisor/turns`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new AdvisorTurnRequestError();
  }
  let payload: unknown = undefined;
  try {
    payload = await response.json();
  } catch {
    throw new AdvisorTurnRequestError();
  }
  if (response.status !== 200) throw parseTurnError(payload);
  const result = AdvisorTurnSchema.safeParse(payload);
  if (!result.success) throw new AdvisorTurnRequestError();
  return result.data;
}

export function useRequestAdvisorTurnMutation(engagementId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      input,
      idempotencyKey,
      signal,
    }: {
      input: RequestAdvisorTurnInput;
      idempotencyKey: string;
      signal?: AbortSignal;
    }) => requestAdvisorTurn(engagementId, input, idempotencyKey, signal),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: advisorTurnsQueryKey(engagementId) });
    },
  });
}
