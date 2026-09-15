import {
  EngagementDetailResponseSchema,
  EngagementFfufResultsResponseSchema,
  EngagementHttpProbesResponseSchema,
  EngagementListResponseSchema,
  EngagementServicesResponseSchema,
  type Engagement,
  type EngagementWithActiveScope,
  type FfufProjected,
  type HttpProbeProjected,
  type NmapProjectedService,
} from "@stonehush/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";

import {
  EngagementDetailQueryError,
  EngagementFfufResultsQueryError,
  EngagementHttpProbesQueryError,
  EngagementServicesQueryError,
  EngagementsQueryError,
} from "./errors.js";

export const ENGAGEMENTS_QUERY_KEY = ["engagements"] as const;

export function engagementDetailQueryKey(engagementId: string) {
  return [...ENGAGEMENTS_QUERY_KEY, engagementId] as const;
}

export function engagementServicesQueryKey(engagementId: string) {
  return [...ENGAGEMENTS_QUERY_KEY, engagementId, "services"] as const;
}

export async function fetchEngagements(signal?: AbortSignal): Promise<Engagement[]> {
  try {
    const response = await fetch("/api/v1/engagements", signal ? { signal } : undefined);
    if (response.status !== 200) throw new EngagementsQueryError();

    const payload: unknown = await response.json();
    const result = EngagementListResponseSchema.safeParse(payload);
    if (!result.success) throw new EngagementsQueryError();
    return result.data;
  } catch (error) {
    if (error instanceof EngagementsQueryError) throw error;
    throw new EngagementsQueryError();
  }
}

export async function fetchEngagementDetail(
  engagementId: string,
  signal?: AbortSignal,
): Promise<EngagementWithActiveScope> {
  try {
    const response = await fetch(
      `/api/v1/engagements/${engagementId}`,
      signal ? { signal } : undefined,
    );
    if (response.status !== 200) throw new EngagementDetailQueryError();

    const payload: unknown = await response.json();
    const result = EngagementDetailResponseSchema.safeParse(payload);
    if (!result.success) throw new EngagementDetailQueryError();
    return result.data;
  } catch (error) {
    if (error instanceof EngagementDetailQueryError) throw error;
    throw new EngagementDetailQueryError();
  }
}

export async function fetchEngagementServices(
  engagementId: string,
  signal?: AbortSignal,
): Promise<NmapProjectedService[]> {
  try {
    const response = await fetch(
      `/api/v1/engagements/${engagementId}/services`,
      signal ? { signal } : undefined,
    );
    if (response.status !== 200) throw new EngagementServicesQueryError();

    const payload: unknown = await response.json();
    const result = EngagementServicesResponseSchema.safeParse(payload);
    if (!result.success) throw new EngagementServicesQueryError();
    return result.data;
  } catch (error) {
    if (error instanceof EngagementServicesQueryError) throw error;
    throw new EngagementServicesQueryError();
  }
}

export const engagementsQueryOptions = queryOptions({
  queryKey: ENGAGEMENTS_QUERY_KEY,
  queryFn: ({ signal }) => fetchEngagements(signal),
});

export function engagementDetailQueryOptions(engagementId: string) {
  return queryOptions({
    queryKey: engagementDetailQueryKey(engagementId),
    queryFn: ({ signal }) => fetchEngagementDetail(engagementId, signal),
  });
}

export function engagementServicesQueryOptions(engagementId: string) {
  return queryOptions({
    queryKey: engagementServicesQueryKey(engagementId),
    queryFn: ({ signal }) => fetchEngagementServices(engagementId, signal),
  });
}

export function useEngagementsQuery() {
  return useQuery(engagementsQueryOptions);
}

export function useEngagementDetailQuery(engagementId: string) {
  return useQuery(engagementDetailQueryOptions(engagementId));
}

export function useEngagementServicesQuery(engagementId: string) {
  return useQuery(engagementServicesQueryOptions(engagementId));
}

export function engagementHttpProbesQueryKey(engagementId: string) {
  return [...ENGAGEMENTS_QUERY_KEY, engagementId, "http-probes"] as const;
}

export async function fetchEngagementHttpProbes(
  engagementId: string,
  signal?: AbortSignal,
): Promise<HttpProbeProjected[]> {
  try {
    const response = await fetch(
      `/api/v1/engagements/${engagementId}/http-probes`,
      signal ? { signal } : undefined,
    );
    if (response.status !== 200) throw new EngagementHttpProbesQueryError();

    const payload: unknown = await response.json();
    const result = EngagementHttpProbesResponseSchema.safeParse(payload);
    if (!result.success) throw new EngagementHttpProbesQueryError();
    return result.data;
  } catch (error) {
    if (error instanceof EngagementHttpProbesQueryError) throw error;
    throw new EngagementHttpProbesQueryError();
  }
}

export function engagementHttpProbesQueryOptions(engagementId: string) {
  return queryOptions({
    queryKey: engagementHttpProbesQueryKey(engagementId),
    queryFn: ({ signal }) => fetchEngagementHttpProbes(engagementId, signal),
  });
}

export function useEngagementHttpProbesQuery(engagementId: string) {
  return useQuery(engagementHttpProbesQueryOptions(engagementId));
}

export function engagementFfufResultsQueryKey(engagementId: string) {
  return [...ENGAGEMENTS_QUERY_KEY, engagementId, "ffuf-results"] as const;
}

export async function fetchEngagementFfufResults(
  engagementId: string,
  signal?: AbortSignal,
): Promise<FfufProjected[]> {
  try {
    const response = await fetch(
      `/api/v1/engagements/${engagementId}/ffuf-results`,
      signal ? { signal } : undefined,
    );
    if (response.status !== 200) throw new EngagementFfufResultsQueryError();

    const payload: unknown = await response.json();
    const result = EngagementFfufResultsResponseSchema.safeParse(payload);
    if (!result.success) throw new EngagementFfufResultsQueryError();
    return result.data;
  } catch (error) {
    if (error instanceof EngagementFfufResultsQueryError) throw error;
    throw new EngagementFfufResultsQueryError();
  }
}

export function engagementFfufResultsQueryOptions(engagementId: string) {
  return queryOptions({
    queryKey: engagementFfufResultsQueryKey(engagementId),
    queryFn: ({ signal }) => fetchEngagementFfufResults(engagementId, signal),
  });
}

export function useEngagementFfufResultsQuery(engagementId: string) {
  return useQuery(engagementFfufResultsQueryOptions(engagementId));
}

export function partitionEngagements(engagements: readonly Engagement[]) {
  const active: Engagement[] = [];
  const archived: Engagement[] = [];
  for (const engagement of engagements) {
    if (engagement.status === "archived") archived.push(engagement);
    else active.push(engagement);
  }
  return { active, archived };
}
