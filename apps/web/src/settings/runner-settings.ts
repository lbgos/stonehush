import {
  GetSettingsResponseSchema,
  type RunnerSettings,
  type UpdateSettingsRequest,
} from "@stonehush/contracts";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export const RUNNER_SETTINGS_QUERY_KEY = ["settings", "runner"] as const;

export const RUNNER_SETTINGS_QUERY_ERROR_MESSAGE = "The runner settings request failed.";
export const UPDATE_RUNNER_SETTINGS_ERROR_MESSAGE = "The runner settings update failed.";

export class RunnerSettingsQueryError extends Error {
  constructor() {
    super(RUNNER_SETTINGS_QUERY_ERROR_MESSAGE);
    this.name = "RunnerSettingsQueryError";
  }
}

export class UpdateRunnerSettingsError extends Error {
  constructor() {
    super(UPDATE_RUNNER_SETTINGS_ERROR_MESSAGE);
    this.name = "UpdateRunnerSettingsError";
  }
}

export async function fetchRunnerSettings(signal?: AbortSignal): Promise<RunnerSettings> {
  try {
    const response = await fetch("/api/v1/settings/runner", signal ? { signal } : undefined);
    if (response.status !== 200) throw new RunnerSettingsQueryError();
    const payload: unknown = await response.json();
    const result = GetSettingsResponseSchema.safeParse(payload);
    if (!result.success) throw new RunnerSettingsQueryError();
    return result.data;
  } catch (error) {
    if (error instanceof RunnerSettingsQueryError) throw error;
    throw new RunnerSettingsQueryError();
  }
}

export const runnerSettingsQueryOptions = queryOptions({
  queryKey: RUNNER_SETTINGS_QUERY_KEY,
  queryFn: ({ signal }) => fetchRunnerSettings(signal),
});

export function useRunnerSettingsQuery() {
  return useQuery(runnerSettingsQueryOptions);
}

export async function updateRunnerSettingsRequest(
  body: UpdateSettingsRequest,
): Promise<RunnerSettings> {
  try {
    const response = await fetch("/api/v1/settings/runner", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.status !== 200) throw new UpdateRunnerSettingsError();
    const payload: unknown = await response.json();
    const result = GetSettingsResponseSchema.safeParse(payload);
    if (!result.success) throw new UpdateRunnerSettingsError();
    return result.data;
  } catch (error) {
    if (error instanceof UpdateRunnerSettingsError) throw error;
    throw new UpdateRunnerSettingsError();
  }
}

export function useUpdateRunnerSettingsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateSettingsRequest) => updateRunnerSettingsRequest(body),
    onSuccess: (settings) => {
      queryClient.setQueryData(RUNNER_SETTINGS_QUERY_KEY, settings);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: RUNNER_SETTINGS_QUERY_KEY });
    },
  });
}
