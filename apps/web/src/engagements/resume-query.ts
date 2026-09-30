import {
  EngagementResumeResponseSchema,
  EngagementResumeErrorSchema,
  EngagementNextStepRecordSchema,
  type EngagementResumeError,
  UpdateEngagementNextStepRequestSchema,
  type EngagementResumeResponse,
} from "@stonehush/contracts";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export const ENGAGEMENT_RESUME_QUERY_ERROR_MESSAGE = "The resume request failed.";
export const ENGAGEMENT_NEXT_STEP_MUTATION_ERROR_MESSAGE = "The next step request failed.";

export class EngagementResumeQueryError extends Error {
  constructor() {
    super(ENGAGEMENT_RESUME_QUERY_ERROR_MESSAGE);
    this.name = "EngagementResumeQueryError";
  }
}

export class EngagementNextStepMutationError extends Error {
  constructor(readonly detail?: EngagementResumeError) {
    super(detail?.code === "revision_conflict" ? "The next step changed elsewhere."
      : detail?.code === "engagement_archived" ? "This engagement is archived. The next step was not saved."
      : detail?.code === "storage_busy" ? "Storage is busy. Try again."
      : ENGAGEMENT_NEXT_STEP_MUTATION_ERROR_MESSAGE);
    this.name = "EngagementNextStepMutationError";
  }
}

export function engagementResumeQueryKey(engagementId: string, since?: string) {
  return since === undefined
    ? (["engagements", engagementId, "resume"] as const)
    : (["engagements", engagementId, "resume", since] as const);
}

export function engagementResumeUrl(engagementId: string, since?: string): string {
  const base = `/api/v1/engagements/${encodeURIComponent(engagementId)}/resume`;
  return since === undefined ? base : `${base}?since=${encodeURIComponent(since)}`;
}

export async function fetchEngagementResume(
  engagementId: string,
  since?: string,
  signal?: AbortSignal,
): Promise<EngagementResumeResponse> {
  let response: Response;
  try {
    response = await fetch(engagementResumeUrl(engagementId, since), signal ? { signal } : undefined);
  } catch {
    throw new EngagementResumeQueryError();
  }
  if (response.status !== 200) throw new EngagementResumeQueryError();
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new EngagementResumeQueryError();
  }
  const result = EngagementResumeResponseSchema.safeParse(payload);
  if (!result.success || result.data.engagementId !== engagementId) throw new EngagementResumeQueryError();
  return result.data;
}

export function engagementResumeQueryOptions(engagementId: string, since?: string) {
  return queryOptions({
    queryKey: engagementResumeQueryKey(engagementId, since),
    queryFn: ({ signal }) => fetchEngagementResume(engagementId, since, signal),
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export function useEngagementResumeQuery(engagementId: string, since?: string) {
  return useQuery(engagementResumeQueryOptions(engagementId, since));
}

export async function saveNextStepRequest(
  engagementId: string,
  input: { nextStep: string | null; expectedRevision: number },
  signal?: AbortSignal,
): Promise<{ revision: number }> {
  const parsed = UpdateEngagementNextStepRequestSchema.safeParse(input);
  if (!parsed.success) throw new EngagementNextStepMutationError();
  const body = parsed.data;
  let response: Response;
  try {
    response = await fetch(`/api/v1/engagements/${encodeURIComponent(engagementId)}/next-step`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch {
    throw new EngagementNextStepMutationError();
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new EngagementNextStepMutationError();
  }
  if (response.status !== 200) {
    const error = EngagementResumeErrorSchema.safeParse(payload);
    throw new EngagementNextStepMutationError(error.success ? error.data : undefined);
  }
  const record = EngagementNextStepRecordSchema.safeParse(payload);
  if (!record.success || record.data.engagementId !== engagementId) {
    throw new EngagementNextStepMutationError();
  }
  return { revision: record.data.revision };
}

export function useSaveNextStepMutation(engagementId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { nextStep: string | null; expectedRevision: number }) =>
      saveNextStepRequest(engagementId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["engagements", engagementId, "resume"] });
    },
  });
}
