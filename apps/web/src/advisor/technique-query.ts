import {
  CreateTechniqueRequestSchema,
  TechniqueListResponseSchema,
  TechniqueMutationErrorSchema,
  TechniqueResponseSchema,
  type Technique,
} from "@stonehush/contracts";
import { useMutation, useQuery, useQueryClient, queryOptions } from "@tanstack/react-query";

export const TECHNIQUE_QUERY_ERROR_MESSAGE = "The techniques request failed.";
export const TECHNIQUE_REQUEST_ERROR_MESSAGE = "The technique request failed.";

export class TechniquesQueryError extends Error {
  constructor() {
    super(TECHNIQUE_QUERY_ERROR_MESSAGE);
    this.name = "TechniquesQueryError";
  }
}

export class TechniqueRequestError extends Error {
  readonly code: string;

  constructor(code = "request_failed") {
    super(TECHNIQUE_REQUEST_ERROR_MESSAGE);
    this.name = "TechniqueRequestError";
    this.code = code;
  }
}

export function parseTechniqueMutationError(payload: unknown): TechniqueRequestError {
  const parsed = TechniqueMutationErrorSchema.safeParse(payload);
  if (parsed.success) return new TechniqueRequestError(parsed.data.code);
  return new TechniqueRequestError("request_failed");
}

// Server refusals that definitely did not create a technique, so a later
// retry is a new save rather than a possible duplicate. Anything else,
// including a network failure or an unreadable response, leaves the create
// outcome unknown: the operator checks Techniques before saving again.
export function isTechniqueSaveRefused(code: string): boolean {
  return (
    code === "invalid_request" ||
    code === "engagement_not_found" ||
    code === "engagement_archived" ||
    code === "storage_busy"
  );
}
export function techniquesQueryKey(engagementId: string) {
  return ["engagements", engagementId, "techniques"] as const;
}

export async function fetchTechniques(
  engagementId: string,
  signal?: AbortSignal,
): Promise<Technique[]> {
  let response: Response;
  try {
    response = await fetch(
      `/api/v1/engagements/${encodeURIComponent(engagementId)}/techniques`,
      signal ? { signal } : undefined,
    );
  } catch {
    throw new TechniquesQueryError();
  }
  if (response.status !== 200) throw new TechniquesQueryError();
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new TechniquesQueryError();
  }
  const result = TechniqueListResponseSchema.safeParse(payload);
  if (!result.success) throw new TechniquesQueryError();
  return result.data;
}

export interface SaveTechniqueInput {
  readonly name: string;
  readonly whenUseful: string;
  readonly prerequisites: readonly string[];
  readonly question: string;
  readonly procedure: readonly { readonly instruction: string; readonly command?: string }[];
  readonly meaning: string;
}

export async function saveTechniqueRequest(
  engagementId: string,
  input: SaveTechniqueInput,
  signal?: AbortSignal,
): Promise<Technique> {
  const body = CreateTechniqueRequestSchema.parse({
    name: input.name,
    whenUseful: input.whenUseful,
    prerequisites: [...input.prerequisites],
    question: input.question,
    procedure: input.procedure.map((step) => ({ ...step })),
    meaning: input.meaning,
  });
  let response: Response;
  try {
    response = await fetch(
      `/api/v1/engagements/${encodeURIComponent(engagementId)}/techniques`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      },
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new TechniqueRequestError();
  }
  let payload: unknown = undefined;
  try {
    payload = await response.json();
  } catch {
    throw new TechniqueRequestError("request_failed");
  }
  if (response.status !== 201) throw parseTechniqueMutationError(payload);
  const result = TechniqueResponseSchema.safeParse(payload);
  if (!result.success) throw new TechniqueRequestError("invalid_persisted_data");
  return result.data;
}

export function techniquesQueryOptions(engagementId: string) {
  return queryOptions({
    queryKey: techniquesQueryKey(engagementId),
    queryFn: ({ signal }) => fetchTechniques(engagementId, signal),
    refetchOnMount: true,
  });
}

export function useTechniquesQuery(engagementId: string) {
  return useQuery(techniquesQueryOptions(engagementId));
}

export function useSaveTechniqueMutation(engagementId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveTechniqueInput) => saveTechniqueRequest(engagementId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: techniquesQueryKey(engagementId) });
    },
  });
}
