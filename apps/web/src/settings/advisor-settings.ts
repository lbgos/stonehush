import {
  GetAdvisorSettingsResponseSchema,
  type AdvisorSettings,
  type UpdateAdvisorSettingsRequest,
} from "@stonehush/contracts";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ADVISOR_STATUS_QUERY_KEY } from "../advisor-status-query.js";

export const ADVISOR_SETTINGS_QUERY_KEY = ["settings", "advisor"] as const;

export const ADVISOR_SETTINGS_QUERY_ERROR_MESSAGE = "The advisor settings request failed.";
export const UPDATE_ADVISOR_SETTINGS_ERROR_MESSAGE = "The advisor settings update failed.";

export class AdvisorSettingsQueryError extends Error {
  constructor() {
    super(ADVISOR_SETTINGS_QUERY_ERROR_MESSAGE);
    this.name = "AdvisorSettingsQueryError";
  }
}

export class UpdateAdvisorSettingsError extends Error {
  constructor() {
    super(UPDATE_ADVISOR_SETTINGS_ERROR_MESSAGE);
    this.name = "UpdateAdvisorSettingsError";
  }
}

export async function fetchAdvisorSettings(signal?: AbortSignal): Promise<AdvisorSettings> {
  try {
    const response = await fetch("/api/v1/settings/advisor", signal ? { signal } : undefined);
    if (response.status !== 200) throw new AdvisorSettingsQueryError();
    const payload: unknown = await response.json();
    const result = GetAdvisorSettingsResponseSchema.safeParse(payload);
    if (!result.success) throw new AdvisorSettingsQueryError();
    return result.data;
  } catch (error) {
    // Cancellation is not a failure: let the abort reach React Query so a
    // discarded request never surfaces as a network error.
    if (signal?.aborted) throw error;
    if (error instanceof AdvisorSettingsQueryError) throw error;
    throw new AdvisorSettingsQueryError();
  }
}

export const advisorSettingsQueryOptions = queryOptions({
  queryKey: ADVISOR_SETTINGS_QUERY_KEY,
  queryFn: ({ signal }) => fetchAdvisorSettings(signal),
});

export function useAdvisorSettingsQuery() {
  return useQuery(advisorSettingsQueryOptions);
}

export async function updateAdvisorSettingsRequest(
  body: UpdateAdvisorSettingsRequest,
): Promise<AdvisorSettings> {
  try {
    const response = await fetch("/api/v1/settings/advisor", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.status !== 200) throw new UpdateAdvisorSettingsError();
    const payload: unknown = await response.json();
    const result = GetAdvisorSettingsResponseSchema.safeParse(payload);
    if (!result.success) throw new UpdateAdvisorSettingsError();
    return result.data;
  } catch (error) {
    if (error instanceof UpdateAdvisorSettingsError) throw error;
    throw new UpdateAdvisorSettingsError();
  }
}

export function useUpdateAdvisorSettingsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateAdvisorSettingsRequest) => updateAdvisorSettingsRequest(body),
    onSuccess: (settings) => {
      queryClient.setQueryData(ADVISOR_SETTINGS_QUERY_KEY, settings);
      // A successful save can change the tested connection, so re-read status.
      void queryClient.invalidateQueries({ queryKey: ADVISOR_STATUS_QUERY_KEY });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ADVISOR_SETTINGS_QUERY_KEY });
    },
  });
}
