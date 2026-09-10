import {
  CaptureObjectiveRequestSchema,
  CreateLeadAttemptRequestSchema,
  CreateLeadRequestSchema,
  CreateObjectiveRequestSchema,
  CreateSecretRequestSchema,
  LeadAttemptListResponseSchema,
  LeadAttemptResponseSchema,
  LeadListResponseSchema,
  LeadMutationErrorSchema,
  LeadOutlineResponseSchema,
  LeadResponseSchema,
  ObjectiveListResponseSchema,
  ObjectiveMutationErrorSchema,
  ObjectiveResponseSchema,
  ParkLeadRequestSchema,
  RecordSecretVerificationRequestSchema,
  SecretListResponseSchema,
  SecretMutationErrorSchema,
  SecretResponseSchema,
  SuggestLeadRevisitRequestSchema,
  type Lead,
  type LeadAttempt,
  type Objective,
  type ObjectiveKind,
  type Secret,
} from "@blackglass/contracts";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export const LEADS_QUERY_ERROR_MESSAGE = "The leads request failed.";
export const LEAD_MUTATION_ERROR_MESSAGE = "The leads request failed.";
export const OBJECTIVES_QUERY_ERROR_MESSAGE = "The objectives request failed.";
export const OBJECTIVE_MUTATION_ERROR_MESSAGE = "The objectives request failed.";
export const SECRETS_QUERY_ERROR_MESSAGE = "The secrets request failed.";
export const SECRET_MUTATION_ERROR_MESSAGE = "The secrets request failed.";

export class LeadsQueryError extends Error {
  constructor() {
    super(LEADS_QUERY_ERROR_MESSAGE);
    this.name = "LeadsQueryError";
  }
}

export class LeadMutationClientError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(leadMutationMessageFor(code));
    this.name = "LeadMutationClientError";
    this.code = code;
  }
}

function leadMutationMessageFor(code: string): string {
  switch (code) {
    case "engagement_not_found":
      return "That engagement is no longer available.";
    case "lead_not_found":
      return "That lead is no longer available.";
    case "attempt_not_found":
      return "That attempt is no longer available.";
    case "engagement_archived":
      return "This engagement is archived.";
    case "invalid_lead_transition":
      return "That lead action is not valid now.";
    case "revisit_suppressed":
      return "No revisit suggested: the same anonymous check was already tested, or a suggestion is already waiting.";
    case "storage_busy":
      return "Storage is busy. Try again.";
    case "invalid_request":
      return "The request was not accepted. Check the fields and try again.";
    case "invalid_persisted_data":
      return "The server returned data this client cannot use.";
    default:
      return LEAD_MUTATION_ERROR_MESSAGE;
  }
}

export function parseLeadMutationError(payload: unknown): LeadMutationClientError {
  const parsed = LeadMutationErrorSchema.safeParse(payload);
  if (parsed.success) return new LeadMutationClientError(parsed.data.code);
  return new LeadMutationClientError("request_failed");
}

export class ObjectivesQueryError extends Error {
  constructor() {
    super(OBJECTIVES_QUERY_ERROR_MESSAGE);
    this.name = "ObjectivesQueryError";
  }
}

export class ObjectiveMutationClientError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(objectiveMutationMessageFor(code));
    this.name = "ObjectiveMutationClientError";
    this.code = code;
  }
}

function objectiveMutationMessageFor(code: string): string {
  switch (code) {
    case "engagement_not_found":
      return "That engagement is no longer available.";
    case "objective_not_found":
      return "That objective is no longer available.";
    case "engagement_archived":
      return "This engagement is archived.";
    case "invalid_objective_transition":
      return "That objective action is not valid now. Capture before submitting.";
    case "storage_busy":
      return "Storage is busy. Try again.";
    case "invalid_request":
      return "The request was not accepted. Check the fields and try again.";
    case "invalid_persisted_data":
      return "The server returned data this client cannot use.";
    default:
      return OBJECTIVE_MUTATION_ERROR_MESSAGE;
  }
}

export function parseObjectiveMutationError(payload: unknown): ObjectiveMutationClientError {
  const parsed = ObjectiveMutationErrorSchema.safeParse(payload);
  if (parsed.success) return new ObjectiveMutationClientError(parsed.data.code);
  return new ObjectiveMutationClientError("request_failed");
}

export class SecretsQueryError extends Error {
  constructor() {
    super(SECRETS_QUERY_ERROR_MESSAGE);
    this.name = "SecretsQueryError";
  }
}

export class SecretMutationClientError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(secretMutationMessageFor(code));
    this.name = "SecretMutationClientError";
    this.code = code;
  }
}

function secretMutationMessageFor(code: string): string {
  switch (code) {
    case "engagement_not_found":
      return "That engagement is no longer available.";
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
      return SECRET_MUTATION_ERROR_MESSAGE;
  }
}

export function parseSecretMutationError(payload: unknown): SecretMutationClientError {
  const parsed = SecretMutationErrorSchema.safeParse(payload);
  if (parsed.success) return new SecretMutationClientError(parsed.data.code);
  return new SecretMutationClientError("request_failed");
}

export function leadsQueryKey(engagementId: string) {
  return ["engagements", engagementId, "leads"] as const;
}

export function leadAttemptsQueryKey(engagementId: string, leadId: string) {
  return ["engagements", engagementId, "leads", leadId, "attempts"] as const;
}

export function leadOutlineQueryKey(engagementId: string, leadId: string) {
  return ["engagements", engagementId, "leads", leadId, "outline"] as const;
}

export function objectivesQueryKey(engagementId: string) {
  return ["engagements", engagementId, "objectives"] as const;
}

export function secretsQueryKey(engagementId: string) {
  return ["engagements", engagementId, "secrets"] as const;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new LeadsQueryError();
  }
}

export async function fetchLeads(
  engagementId: string,
  signal?: AbortSignal,
): Promise<Lead[]> {
  let response: Response;
  try {
    response = await fetch(
      `/api/v1/engagements/${engagementId}/leads`,
      signal ? { signal } : undefined,
    );
  } catch {
    throw new LeadsQueryError();
  }
  if (response.status !== 200) throw new LeadsQueryError();
  const result = LeadListResponseSchema.safeParse(await readJson(response));
  if (!result.success) throw new LeadsQueryError();
  return result.data;
}

export interface CreateLeadInput {
  title: string;
  target?: string | undefined;
  serviceRef?: string | undefined;
  source: { kind: Lead["source"]["kind"]; ref: string; label?: string | undefined };
  nextStep?: string | undefined;
}

async function postLeadMutation<T>(
  url: string,
  payload: unknown,
  parse: (value: unknown) => T | undefined,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new LeadMutationClientError("request_failed");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new LeadMutationClientError("request_failed");
  }
  if (response.status !== 200 && response.status !== 201) {
    throw parseLeadMutationError(body);
  }
  const parsed = parse(body);
  if (parsed === undefined) throw new LeadMutationClientError("invalid_persisted_data");
  return parsed;
}

export async function createLeadRequest(
  engagementId: string,
  input: CreateLeadInput,
): Promise<Lead> {
  const body = CreateLeadRequestSchema.parse({
    title: input.title,
    ...(input.target === undefined ? {} : { target: input.target }),
    ...(input.serviceRef === undefined ? {} : { serviceRef: input.serviceRef }),
    source: input.source,
    ...(input.nextStep === undefined ? {} : { nextStep: input.nextStep }),
  });
  return postLeadMutation(
    `/api/v1/engagements/${engagementId}/leads`,
    body,
    (value) => LeadResponseSchema.safeParse(value).data,
  );
}

export async function parkLeadRequest(
  engagementId: string,
  leadId: string,
  input: { reason: string; testedConditions?: string | undefined },
): Promise<Lead> {
  const body = ParkLeadRequestSchema.parse(input);
  return postLeadMutation(
    `/api/v1/engagements/${engagementId}/leads/${leadId}/park`,
    body,
    (value) => LeadResponseSchema.safeParse(value).data,
  );
}

export async function leadTransitionRequest(
  engagementId: string,
  leadId: string,
  operation: "reopen" | "close" | "revisit/dismiss",
  payload: unknown = {},
): Promise<Lead> {
  return postLeadMutation(
    `/api/v1/engagements/${engagementId}/leads/${leadId}/${operation}`,
    payload,
    (value) => LeadResponseSchema.safeParse(value).data,
  );
}

export async function suggestLeadRevisitRequest(
  engagementId: string,
  leadId: string,
  input: {
    trigger: "new_access" | "hostname_change" | "service_change";
    reason: string;
    anonymous: boolean;
    conditions?: string | undefined;
  },
): Promise<Lead> {
  const body = SuggestLeadRevisitRequestSchema.parse(input);
  return postLeadMutation(
    `/api/v1/engagements/${engagementId}/leads/${leadId}/revisit`,
    body,
    (value) => LeadResponseSchema.safeParse(value).data,
  );
}

export async function fetchLeadAttempts(
  engagementId: string,
  leadId: string,
  signal?: AbortSignal,
): Promise<LeadAttempt[]> {
  let response: Response;
  try {
    response = await fetch(
      `/api/v1/engagements/${engagementId}/leads/${leadId}/attempts`,
      signal ? { signal } : undefined,
    );
  } catch {
    throw new LeadsQueryError();
  }
  if (response.status !== 200) throw new LeadsQueryError();
  const result = LeadAttemptListResponseSchema.safeParse(await readJson(response));
  if (!result.success) throw new LeadsQueryError();
  return result.data;
}

export interface RecordAttemptInput {
  summary: string;
  outcome: LeadAttempt["outcome"];
  conditions?: string | undefined;
  evidenceArtifactIds?: string[] | undefined;
  linkedFindingId?: string | undefined;
  linkedObjectiveId?: string | undefined;
}

export async function recordAttemptRequest(
  engagementId: string,
  leadId: string,
  input: RecordAttemptInput,
): Promise<LeadAttempt> {
  const body = CreateLeadAttemptRequestSchema.parse({
    summary: input.summary,
    outcome: input.outcome,
    ...(input.conditions === undefined ? {} : { conditions: input.conditions }),
    evidenceArtifactIds: input.evidenceArtifactIds ?? [],
    ...(input.linkedFindingId === undefined ? {} : { linkedFindingId: input.linkedFindingId }),
    ...(input.linkedObjectiveId === undefined ? {} : { linkedObjectiveId: input.linkedObjectiveId }),
  });
  return postLeadMutation(
    `/api/v1/engagements/${engagementId}/leads/${leadId}/attempts`,
    body,
    (value) => LeadAttemptResponseSchema.safeParse(value).data,
  );
}

export async function fetchLeadOutline(
  engagementId: string,
  leadId: string,
  signal?: AbortSignal,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(
      `/api/v1/engagements/${engagementId}/leads/${leadId}/outline`,
      signal ? { signal } : undefined,
    );
  } catch {
    throw new LeadsQueryError();
  }
  if (response.status !== 200) throw new LeadsQueryError();
  const result = LeadOutlineResponseSchema.safeParse(await readJson(response));
  if (!result.success) throw new LeadsQueryError();
  return result.data.outline;
}

export function useLeadsQuery(engagementId: string) {
  return useQuery({
    queryKey: leadsQueryKey(engagementId),
    queryFn: ({ signal }) => fetchLeads(engagementId, signal),
  });
}

export function useLeadAttemptsQuery(engagementId: string, leadId: string | null) {
  return useQuery({
    queryKey: leadId === null ? ["engagements", engagementId, "leads", "none"] : leadAttemptsQueryKey(engagementId, leadId),
    queryFn: ({ signal }) =>
      leadId === null ? Promise.resolve([]) : fetchLeadAttempts(engagementId, leadId, signal),
  });
}

export function useLeadOutlineQuery(engagementId: string, leadId: string | null) {
  return useQuery({
    queryKey: leadId === null ? ["engagements", engagementId, "leads", "none"] : leadOutlineQueryKey(engagementId, leadId),
    queryFn: ({ signal }) =>
      leadId === null ? Promise.resolve("") : fetchLeadOutline(engagementId, leadId, signal),
  });
}

function useInvalidateLeads(engagementId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: leadsQueryKey(engagementId) });
  };
}

export function useCreateLeadMutation(engagementId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateLeadInput) => createLeadRequest(engagementId, input),
    onSuccess: (lead) => {
      queryClient.setQueryData<Lead[]>(leadsQueryKey(engagementId), (current) =>
        current === undefined ? [lead] : [...current, lead],
      );
    },
    onSettled: useInvalidateLeads(engagementId),
  });
}

export function useParkLeadMutation(engagementId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { leadId: string; reason: string; testedConditions?: string | undefined }) =>
      parkLeadRequest(engagementId, input.leadId, input),
    onSuccess: (lead) => {
      queryClient.setQueryData<Lead[]>(leadsQueryKey(engagementId), (current) =>
        current === undefined
          ? [lead]
          : current.map((entry) => (entry.id === lead.id ? lead : entry)),
      );
    },
    onSettled: useInvalidateLeads(engagementId),
  });
}

export function useLeadTransitionMutation(
  engagementId: string,
  operation: "reopen" | "close" | "revisit/dismiss",
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { leadId: string; payload?: unknown }) =>
      leadTransitionRequest(engagementId, input.leadId, operation, input.payload ?? {}),
    onSuccess: (lead) => {
      queryClient.setQueryData<Lead[]>(leadsQueryKey(engagementId), (current) =>
        current === undefined
          ? [lead]
          : current.map((entry) => (entry.id === lead.id ? lead : entry)),
      );
    },
    onSettled: useInvalidateLeads(engagementId),
  });
}

export function useSuggestRevisitMutation(engagementId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      leadId: string;
      trigger: "new_access" | "hostname_change" | "service_change";
      reason: string;
      anonymous: boolean;
      conditions?: string | undefined;
    }) => suggestLeadRevisitRequest(engagementId, input.leadId, input),
    onSuccess: (lead) => {
      queryClient.setQueryData<Lead[]>(leadsQueryKey(engagementId), (current) =>
        current === undefined
          ? [lead]
          : current.map((entry) => (entry.id === lead.id ? lead : entry)),
      );
    },
    onSettled: useInvalidateLeads(engagementId),
  });
}

export function useRecordAttemptMutation(engagementId: string, leadId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RecordAttemptInput) => recordAttemptRequest(engagementId, leadId, input),
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: leadAttemptsQueryKey(engagementId, leadId),
      });
      void queryClient.invalidateQueries({
        queryKey: leadOutlineQueryKey(engagementId, leadId),
      });
    },
  });
}

export async function fetchObjectives(
  engagementId: string,
  signal?: AbortSignal,
): Promise<Objective[]> {
  let response: Response;
  try {
    response = await fetch(
      `/api/v1/engagements/${engagementId}/objectives`,
      signal ? { signal } : undefined,
    );
  } catch {
    throw new ObjectivesQueryError();
  }
  if (response.status !== 200) throw new ObjectivesQueryError();
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ObjectivesQueryError();
  }
  const result = ObjectiveListResponseSchema.safeParse(payload);
  if (!result.success) throw new ObjectivesQueryError();
  return result.data;
}

async function postObjectiveMutation<T>(
  url: string,
  payload: unknown,
  parse: (value: unknown) => T | undefined,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new ObjectiveMutationClientError("request_failed");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ObjectiveMutationClientError("request_failed");
  }
  if (response.status !== 200 && response.status !== 201) {
    throw parseObjectiveMutationError(body);
  }
  const parsed = parse(body);
  if (parsed === undefined) throw new ObjectiveMutationClientError("invalid_persisted_data");
  return parsed;
}

export function useObjectivesQuery(engagementId: string) {
  return useQuery({
    queryKey: objectivesQueryKey(engagementId),
    queryFn: ({ signal }) => fetchObjectives(engagementId, signal),
  });
}

export function useCreateObjectiveMutation(engagementId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; kind: ObjectiveKind }) => {
      const body = CreateObjectiveRequestSchema.parse(input);
      return postObjectiveMutation(
        `/api/v1/engagements/${engagementId}/objectives`,
        body,
        (value) => ObjectiveResponseSchema.safeParse(value).data,
      );
    },
    onSuccess: (objective) => {
      queryClient.setQueryData<Objective[]>(objectivesQueryKey(engagementId), (current) =>
        current === undefined ? [objective] : [...current, objective],
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: objectivesQueryKey(engagementId) });
    },
  });
}

export function useCaptureObjectiveMutation(engagementId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { objectiveId: string; proofValue: string }) => {
      const body = CaptureObjectiveRequestSchema.parse({ proofValue: input.proofValue });
      return postObjectiveMutation(
        `/api/v1/engagements/${engagementId}/objectives/${input.objectiveId}/capture`,
        body,
        (value) => ObjectiveResponseSchema.safeParse(value).data,
      );
    },
    onSuccess: (objective) => {
      queryClient.setQueryData<Objective[]>(objectivesQueryKey(engagementId), (current) =>
        current === undefined
          ? [objective]
          : current.map((entry) => (entry.id === objective.id ? objective : entry)),
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: objectivesQueryKey(engagementId) });
    },
  });
}

export function useObjectiveTransitionMutation(
  engagementId: string,
  operation: "submit" | "reopen",
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (objectiveId: string) =>
      postObjectiveMutation(
        `/api/v1/engagements/${engagementId}/objectives/${objectiveId}/${operation}`,
        {},
        (value) => ObjectiveResponseSchema.safeParse(value).data,
      ),
    onSuccess: (objective) => {
      queryClient.setQueryData<Objective[]>(objectivesQueryKey(engagementId), (current) =>
        current === undefined
          ? [objective]
          : current.map((entry) => (entry.id === objective.id ? objective : entry)),
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: objectivesQueryKey(engagementId) });
    },
  });
}

export async function fetchSecrets(
  engagementId: string,
  signal?: AbortSignal,
): Promise<Secret[]> {
  let response: Response;
  try {
    response = await fetch(
      `/api/v1/engagements/${engagementId}/secrets`,
      signal ? { signal } : undefined,
    );
  } catch {
    throw new SecretsQueryError();
  }
  if (response.status !== 200) throw new SecretsQueryError();
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new SecretsQueryError();
  }
  const result = SecretListResponseSchema.safeParse(payload);
  if (!result.success) throw new SecretsQueryError();
  return result.data;
}

async function postSecretMutation<T>(
  url: string,
  payload: unknown,
  parse: (value: unknown) => T | undefined,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new SecretMutationClientError("request_failed");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new SecretMutationClientError("request_failed");
  }
  if (response.status !== 200 && response.status !== 201) {
    throw parseSecretMutationError(body);
  }
  const parsed = parse(body);
  if (parsed === undefined) throw new SecretMutationClientError("invalid_persisted_data");
  return parsed;
}

export function useSecretsQuery(engagementId: string) {
  return useQuery({
    queryKey: secretsQueryKey(engagementId),
    queryFn: ({ signal }) => fetchSecrets(engagementId, signal),
  });
}

export interface CreateSecretInput {
  label: string;
  username?: string | undefined;
  serviceRef: string;
  secretRef: string;
  hint?: string | undefined;
}

export function useCreateSecretMutation(engagementId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSecretInput) => {
      const body = CreateSecretRequestSchema.parse({
        label: input.label,
        ...(input.username === undefined ? {} : { username: input.username }),
        serviceRef: input.serviceRef,
        secretRef: input.secretRef,
        ...(input.hint === undefined ? {} : { hint: input.hint }),
      });
      return postSecretMutation(
        `/api/v1/engagements/${engagementId}/secrets`,
        body,
        (value) => SecretResponseSchema.safeParse(value).data,
      );
    },
    onSuccess: (secret) => {
      queryClient.setQueryData<Secret[]>(secretsQueryKey(engagementId), (current) =>
        current === undefined ? [secret] : [...current, secret],
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: secretsQueryKey(engagementId) });
    },
  });
}

export function useRecordVerificationMutation(engagementId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      secretId: string;
      result: "verified" | "failed";
      method: string;
      note?: string | undefined;
    }) => {
      const body = RecordSecretVerificationRequestSchema.parse({
        result: input.result,
        method: input.method,
        ...(input.note === undefined ? {} : { note: input.note }),
      });
      return postSecretMutation(
        `/api/v1/engagements/${engagementId}/secrets/${input.secretId}/verifications`,
        body,
        (value) => SecretResponseSchema.safeParse(value).data,
      );
    },
    onSuccess: (secret) => {
      queryClient.setQueryData<Secret[]>(secretsQueryKey(engagementId), (current) =>
        current === undefined
          ? [secret]
          : current.map((entry) => (entry.id === secret.id ? secret : entry)),
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: secretsQueryKey(engagementId) });
    },
  });
}

export function leadsQueryOptions(engagementId: string) {
  return queryOptions({
    queryKey: leadsQueryKey(engagementId),
    queryFn: ({ signal }) => fetchLeads(engagementId, signal),
  });
}
