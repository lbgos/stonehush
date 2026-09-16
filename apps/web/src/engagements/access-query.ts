import {
  AccessListResponseSchema,
  AccessMutationErrorSchema,
  AccessResponseSchema,
  CreateAccessRequestSchema,
  type AccessRecord,
  type AccessType,
} from "@stonehush/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { leadsQueryKey } from "./leads-query.js";

export const ACCESS_QUERY_ERROR_MESSAGE = "The access request failed.";
export const ACCESS_MUTATION_ERROR_MESSAGE = "The access request failed.";

export class AccessQueryError extends Error {
  constructor() {
    super(ACCESS_QUERY_ERROR_MESSAGE);
    this.name = "AccessQueryError";
  }
}

export class AccessMutationClientError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(accessMutationMessageFor(code));
    this.name = "AccessMutationClientError";
    this.code = code;
  }
}

function accessMutationMessageFor(code: string): string {
  switch (code) {
    case "engagement_not_found":
      return "That engagement is no longer available.";
    case "access_not_found":
      return "That access record is no longer available.";
    case "target_not_found":
      return "That target is no longer available.";
    case "lead_not_found":
      return "That source lead is no longer available.";
    case "secret_not_found":
      return "That secret is no longer available.";
    case "engagement_archived":
      return "This engagement is archived.";
    case "storage_busy":
      return "Storage is busy. Try again.";
    case "invalid_request":
      return "The request was not accepted. Check the fields and try again.";
    case "invalid_persisted_data":
      return "The server returned data this client cannot use.";
    default:
      return ACCESS_MUTATION_ERROR_MESSAGE;
  }
}

export function parseAccessMutationError(payload: unknown): AccessMutationClientError {
  const parsed = AccessMutationErrorSchema.safeParse(payload);
  if (!parsed.success) return new AccessMutationClientError("invalid_persisted_data");
  return new AccessMutationClientError(responseCode(payload));
}

function responseCode(payload: unknown): string {
  if (typeof payload === "object" && payload !== null && "code" in payload) {
    const code = (payload as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "request_failed";
}

export function accessQueryKey(engagementId: string) {
  return ["engagements", engagementId, "access"] as const;
}

export async function fetchAccessRecords(
  engagementId: string,
  signal?: AbortSignal,
): Promise<AccessRecord[]> {
  let response: Response;
  try {
    response = await fetch(
      `/api/v1/engagements/${engagementId}/access`,
      signal ? { signal } : undefined,
    );
  } catch {
    throw new AccessQueryError();
  }
  if (response.status !== 200) throw new AccessQueryError();
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AccessQueryError();
  }
  const parsed = AccessListResponseSchema.safeParse(payload);
  if (!parsed.success) throw new AccessQueryError();
  return parsed.data;
}

export interface CreateAccessInput {
  targetId: string;
  account: string;
  accessType: AccessType;
  sourceLeadId: string;
  secretId?: string | undefined;
  context?: string | undefined;
}

export async function createAccessRequest(
  engagementId: string,
  input: CreateAccessInput,
): Promise<AccessRecord> {
  const parsed = CreateAccessRequestSchema.safeParse({
    targetId: input.targetId,
    account: input.account,
    accessType: input.accessType,
    sourceLeadId: input.sourceLeadId,
    ...(input.secretId === undefined ? {} : { secretId: input.secretId }),
    ...(input.context === undefined ? {} : { context: input.context }),
  });
  // Client-side validation failure stays a typed mutation error: the raw
  // ZodError never reaches the alert.
  if (!parsed.success) throw new AccessMutationClientError("invalid_request");
  const body = parsed.data;
  let response: Response;
  try {
    response = await fetch(`/api/v1/engagements/${engagementId}/access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AccessMutationClientError("request_failed");
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AccessMutationClientError("request_failed");
  }
  if (response.status !== 201) throw parseAccessMutationError(payload);
  const validated = AccessResponseSchema.safeParse(payload);
  if (!validated.success) throw new AccessMutationClientError("invalid_persisted_data");
  return validated.data;
}

export async function refreshAccessRequest(
  engagementId: string,
  accessId: string,
): Promise<AccessRecord> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/engagements/${engagementId}/access/${accessId}/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
  } catch {
    throw new AccessMutationClientError("request_failed");
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AccessMutationClientError("request_failed");
  }
  if (response.status !== 200) throw parseAccessMutationError(payload);
  const parsed = AccessResponseSchema.safeParse(payload);
  if (!parsed.success) throw new AccessMutationClientError("invalid_persisted_data");
  return parsed.data;
}

export function useAccessRecordsQuery(engagementId: string) {
  return useQuery({
    queryKey: accessQueryKey(engagementId),
    queryFn: ({ signal }) => fetchAccessRecords(engagementId, signal),
  });
}

function useInvalidateAccess(engagementId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: accessQueryKey(engagementId) });
    // Recording access can fire a quiet revisit suggestion, so the lead list
    // refreshes alongside the new record.
    void queryClient.invalidateQueries({ queryKey: leadsQueryKey(engagementId) });
  };
}

export function useCreateAccessMutation(engagementId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAccessInput) => createAccessRequest(engagementId, input),
    onSuccess: (record) => {
      queryClient.setQueryData<AccessRecord[]>(accessQueryKey(engagementId), (current) =>
        current === undefined ? [record] : [...current, record],
      );
    },
    onSettled: useInvalidateAccess(engagementId),
  });
}

export function useRefreshAccessMutation(engagementId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (accessId: string) => refreshAccessRequest(engagementId, accessId),
    onSuccess: (record) => {
      queryClient.setQueryData<AccessRecord[]>(accessQueryKey(engagementId), (current) =>
        current === undefined
          ? [record]
          : current.map((entry) => (entry.id === record.id ? record : entry)),
      );
    },
    onSettled: useInvalidateAccess(engagementId),
  });
}
