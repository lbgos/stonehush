import {
  CreateFindingRequestSchema,
  FindingListResponseSchema,
  FindingResponseSchema,
  UpdateFindingRequestSchema,
  type Finding,
} from "@stonehush/contracts";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  FindingMutationClientError,
  FindingsQueryError,
  parseFindingMutationError,
} from "./errors.js";
import { reportQueryKey } from "./report-query.js";

export function findingsQueryKey(engagementId: string) {
  return ["engagements", engagementId, "findings"] as const;
}

export async function fetchFindings(
  engagementId: string,
  signal?: AbortSignal,
): Promise<Finding[]> {
  let response: Response;
  try {
    response = await fetch(
      `/api/v1/engagements/${engagementId}/findings`,
      signal ? { signal } : undefined,
    );
  } catch {
    throw new FindingsQueryError();
  }
  if (response.status !== 200) throw new FindingsQueryError();
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new FindingsQueryError();
  }
  const result = FindingListResponseSchema.safeParse(payload);
  if (!result.success) throw new FindingsQueryError();
  return result.data;
}

export interface CreateFindingInput {
  title: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  body: string;
  evidenceArtifactIds: string[];
}

export async function createFindingRequest(
  engagementId: string,
  input: CreateFindingInput,
  signal?: AbortSignal,
): Promise<Finding> {
  const body = CreateFindingRequestSchema.parse(input);
  let response: Response;
  try {
    response = await fetch(`/api/v1/engagements/${engagementId}/findings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch {
    throw new FindingMutationClientError("request_failed");
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new FindingMutationClientError("request_failed");
  }
  if (response.status !== 201) throw parseFindingMutationError(payload);
  const parsed = FindingResponseSchema.safeParse(payload);
  if (!parsed.success) throw new FindingMutationClientError("invalid_persisted_data");
  return parsed.data;
}

async function findingTransitionRequest(
  engagementId: string,
  findingId: string,
  operation: "resolve" | "reopen",
): Promise<Finding> {
  let response: Response;
  try {
    response = await fetch(
      `/api/v1/engagements/${engagementId}/findings/${findingId}/${operation}`,
      { method: "POST" },
    );
  } catch {
    throw new FindingMutationClientError("request_failed");
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new FindingMutationClientError("request_failed");
  }
  if (response.status !== 200) throw parseFindingMutationError(payload);
  const parsed = FindingResponseSchema.safeParse(payload);
  if (!parsed.success) throw new FindingMutationClientError("invalid_persisted_data");
  return parsed.data;
}

export function findingsQueryOptions(engagementId: string) {
  return queryOptions({
    queryKey: findingsQueryKey(engagementId),
    queryFn: ({ signal }) => fetchFindings(engagementId, signal),
  });
}

export function useFindingsQuery(engagementId: string) {
  return useQuery(findingsQueryOptions(engagementId));
}

export function useCreateFindingMutation(engagementId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateFindingInput) => createFindingRequest(engagementId, input),
    onSuccess: (finding) => {
      queryClient.setQueryData<Finding[]>(findingsQueryKey(engagementId), (current) =>
        current === undefined ? [finding] : [...current, finding],
      );
      void queryClient.invalidateQueries({ queryKey: reportQueryKey(engagementId) });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: findingsQueryKey(engagementId) });
    },
  });
}

export function useFindingTransitionMutation(
  engagementId: string,
  operation: "resolve" | "reopen",
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (findingId: string) =>
      findingTransitionRequest(engagementId, findingId, operation),
    onSuccess: (finding) => {
      queryClient.setQueryData<Finding[]>(findingsQueryKey(engagementId), (current) =>
        current === undefined
          ? [finding]
          : current.map((entry) => (entry.id === finding.id ? finding : entry)),
      );
      void queryClient.invalidateQueries({ queryKey: reportQueryKey(engagementId) });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: findingsQueryKey(engagementId) });
    },
  });
}

export interface UpdateFindingInput {
  findingId: string;
  title: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  body: string;
  expectedRevision: number;
}

export async function updateFindingRequest(
  engagementId: string,
  input: UpdateFindingInput,
  signal?: AbortSignal,
): Promise<Finding> {
  const body = UpdateFindingRequestSchema.parse({
    title: input.title,
    severity: input.severity,
    body: input.body,
    expectedRevision: input.expectedRevision,
  });
  let response: Response;
  try {
    response = await fetch(
      `/api/v1/engagements/${engagementId}/findings/${input.findingId}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      },
    );
  } catch {
    throw new FindingMutationClientError("request_failed");
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new FindingMutationClientError("request_failed");
  }
  if (response.status !== 200) throw parseFindingMutationError(payload);
  const parsed = FindingResponseSchema.safeParse(payload);
  if (!parsed.success) throw new FindingMutationClientError("invalid_persisted_data");
  return parsed.data;
}

export function useUpdateFindingMutation(engagementId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateFindingInput) => updateFindingRequest(engagementId, input),
    onSuccess: (finding) => {
      queryClient.setQueryData<Finding[]>(findingsQueryKey(engagementId), (current) =>
        current === undefined
          ? [finding]
          : current.map((entry) => (entry.id === finding.id ? finding : entry)),
      );
      void queryClient.invalidateQueries({ queryKey: reportQueryKey(engagementId) });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: findingsQueryKey(engagementId) });
    },
  });
}
