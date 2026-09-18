import {
  GitleaksMatchesResponseSchema,
  GitleaksScanResponseSchema,
  type GitleaksMatch,
  type GitleaksScanResponse,
} from "@stonehush/contracts";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  EngagementGitleaksMatchesQueryError,
  parseGitleaksScanError,
} from "./errors.js";
import { ENGAGEMENTS_QUERY_KEY } from "./query.js";

export function engagementGitleaksMatchesQueryKey(engagementId: string) {
  return [...ENGAGEMENTS_QUERY_KEY, engagementId, "gitleaks-matches"] as const;
}

export async function fetchEngagementGitleaksMatches(
  engagementId: string,
  signal?: AbortSignal,
): Promise<GitleaksMatch[]> {
  try {
    const response = await fetch(
      `/api/v1/engagements/${engagementId}/gitleaks-matches`,
      signal ? { signal } : undefined,
    );
    if (response.status !== 200) throw new EngagementGitleaksMatchesQueryError();
    const payload: unknown = await response.json();
    const result = GitleaksMatchesResponseSchema.safeParse(payload);
    if (!result.success) throw new EngagementGitleaksMatchesQueryError();
    return result.data;
  } catch (error) {
    if (error instanceof EngagementGitleaksMatchesQueryError) throw error;
    throw new EngagementGitleaksMatchesQueryError();
  }
}

export function engagementGitleaksMatchesQueryOptions(engagementId: string) {
  return queryOptions({
    queryKey: engagementGitleaksMatchesQueryKey(engagementId),
    queryFn: ({ signal }) => fetchEngagementGitleaksMatches(engagementId, signal),
  });
}

export function useEngagementGitleaksMatchesQuery(engagementId: string) {
  return useQuery(engagementGitleaksMatchesQueryOptions(engagementId));
}

export async function requestGitleaksScan(
  engagementId: string,
  signal?: AbortSignal,
): Promise<GitleaksScanResponse> {
  const response = await fetch(`/api/v1/engagements/${engagementId}/gitleaks-scans`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
    ...(signal ? { signal } : {}),
  });
  const payload: unknown = await response.json().catch(() => undefined);
  if (response.status !== 201) throw parseGitleaksScanError(payload);
  const result = GitleaksScanResponseSchema.safeParse(payload);
  if (!result.success) throw parseGitleaksScanError(undefined);
  return result.data;
}

export function useScanGitleaksMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (engagementId: string) => requestGitleaksScan(engagementId),
    onSuccess: (_scan, engagementId) => {
      void queryClient.invalidateQueries({
        queryKey: engagementGitleaksMatchesQueryKey(engagementId),
      });
    },
  });
}
