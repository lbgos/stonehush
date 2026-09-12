import {
  AttachmentListResponseSchema,
  AttachmentSchema,
  CreateExcerptRequestSchema,
  ExcerptListResponseSchema,
  ExcerptSchema,
  ExcerptSearchResponseSchema,
  ExcerptSourceListResponseSchema,
  RunOutputResponseSchema,
  type Attachment,
  type Excerpt,
  type ExcerptSearchResponse,
  type ExcerptSourceRef,
  type RunOutputResponse,
} from "@stonehush/contracts";
import { queryOptions, skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export const RUN_OUTPUT_QUERY_ERROR_MESSAGE = "The raw output request failed.";

export class RunOutputQueryError extends Error {
  constructor() {
    super(RUN_OUTPUT_QUERY_ERROR_MESSAGE);
    this.name = "RunOutputQueryError";
  }
}

export class NoTerminalRunError extends Error {
  constructor() {
    super("No finished or cancelled runs yet.");
    this.name = "NoTerminalRunError";
  }
}

export class RunNotFoundError extends Error {
  constructor() {
    super("That run is no longer available.");
    this.name = "RunNotFoundError";
  }
}

// Terminal read failures that still leave an evidence reference. The code
// selects the failed-download panel (reference plus retry) instead of the
// generic unavailable state.
export class RunOutputUnavailableError extends Error {
  readonly code: string;
  constructor(code: string) {
    super("The preserved output bytes are unavailable.");
    this.name = "RunOutputUnavailableError";
    this.code = code;
  }
}

function throwForOutputStatus(status: number, payload: unknown): never {
  const code = (payload as { code?: unknown } | null)?.code;
  if (status === 404 && code === "no_terminal_run") throw new NoTerminalRunError();
  if (status === 404 && code === "run_not_found") throw new RunNotFoundError();
  if (typeof code === "string" && (code === "missing_artifact" || code === "corrupt_artifact")) {
    throw new RunOutputUnavailableError(code);
  }
  throw new RunOutputQueryError();
}

export function latestRunOutputQueryKey(engagementId: string) {
  return ["engagements", engagementId, "runs", "latest", "output"] as const;
}

export function runOutputQueryKey(engagementId: string, runId: string) {
  return ["engagements", engagementId, "runs", runId, "output"] as const;
}

export async function fetchLatestRunOutput(
  engagementId: string,
  signal?: AbortSignal,
): Promise<RunOutputResponse> {
  let response: Response;
  try {
    response = await fetch(
      `/api/v1/engagements/${encodeURIComponent(engagementId)}/runs/latest/output`,
      signal ? { signal } : undefined,
    );
  } catch {
    throw new RunOutputQueryError();
  }
  if (response.status === 404) {
    let code: unknown = undefined;
    try {
      code = (await response.json() as { code?: unknown }).code;
    } catch {
      throw new RunOutputQueryError();
    }
    if (code === "no_terminal_run") throw new NoTerminalRunError();
    throw new RunOutputQueryError();
  }
  if (response.status !== 200) {
    let payload: unknown = undefined;
    try {
      payload = await response.json();
    } catch {
      throw new RunOutputQueryError();
    }
    throwForOutputStatus(response.status, payload);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new RunOutputQueryError();
  }
  const result = RunOutputResponseSchema.safeParse(payload);
  if (!result.success) throw new RunOutputQueryError();
  return result.data;
}

export function latestRunOutputQueryOptions(engagementId: string | undefined) {
  return queryOptions({
    queryKey:
      engagementId === undefined
        ? ["engagements", "runs", "latest", "output", "none"]
        : latestRunOutputQueryKey(engagementId),
    queryFn:
      engagementId === undefined
        ? skipToken
        : ({ signal }) => fetchLatestRunOutput(engagementId, signal),
    retry: false,
  });
}

export function useLatestRunOutputQuery(engagementId: string | undefined) {
  return useQuery(latestRunOutputQueryOptions(engagementId));
}

// Selected-run output. Always targets the exact run endpoint; a missing
// selection disables the query instead of falling back to the newest output.
export async function fetchRunOutput(
  engagementId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<RunOutputResponse> {
  let response: Response;
  try {
    response = await fetch(
      `/api/v1/engagements/${encodeURIComponent(engagementId)}/runs/${encodeURIComponent(runId)}/output`,
      signal ? { signal } : undefined,
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new RunOutputQueryError();
  }
  if (response.status === 404) {
    let code: unknown = undefined;
    try {
      code = (await response.json() as { code?: unknown }).code;
    } catch {
      throw new RunOutputQueryError();
    }
    if (code === "run_not_found") throw new RunNotFoundError();
    throw new RunOutputQueryError();
  }
  if (response.status !== 200) {
    let payload: unknown = undefined;
    try {
      payload = await response.json();
    } catch {
      throw new RunOutputQueryError();
    }
    throwForOutputStatus(response.status, payload);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new RunOutputQueryError();
  }
  const result = RunOutputResponseSchema.safeParse(payload);
  if (!result.success) throw new RunOutputQueryError();
  return result.data;
}

export function runOutputQueryOptions(
  engagementId: string | undefined,
  runId: string | undefined,
) {
  const selected =
    engagementId !== undefined && runId !== undefined && runId.length > 0
      ? { engagementId, runId }
      : undefined;
  return queryOptions({
    queryKey:
      selected === undefined
        ? (["engagements", "runs", "output", "none"] as const)
        : runOutputQueryKey(selected.engagementId, selected.runId),
    queryFn:
      selected === undefined
        ? skipToken
        : ({ signal }) => fetchRunOutput(selected.engagementId, selected.runId, signal),
    retry: false,
  });
}

export function useRunOutputQuery(
  engagementId: string | undefined,
  runId: string | undefined,
) {
  return useQuery(runOutputQueryOptions(engagementId, runId));
}

export function selectEngagementIdFromPathname(pathname: string): string | undefined {
  const match = /^\/engagements\/([^/]+)/.exec(pathname);
  const candidate = match?.[1];
  return candidate === undefined || candidate.length === 0 ? undefined : candidate;
}

// Explicit run selection from the route search (?run=). Only a non-empty
// string counts; anything else means no selection and keeps the latest-run
// fallback. Never decodes or validates beyond that: the exact run endpoint
// below encodes the id and reports an unknown run truthfully.
export function selectRunIdFromSearch(search: unknown): string | undefined {
  if (typeof search !== "object" || search === null) return undefined;
  const run = (search as Record<string, unknown>)["run"];
  return typeof run === "string" && run.length > 0 ? run : undefined;
}

// ---- STONE-3 fast capture: excerpts, search, sources, finding handoff ----

export const EXCERPT_QUERY_ERROR_MESSAGE = "The excerpt request failed.";

export class ExcerptQueryError extends Error {
  constructor() {
    super(EXCERPT_QUERY_ERROR_MESSAGE);
    this.name = "ExcerptQueryError";
  }
}

export function excerptsQueryKey(engagementId: string) {
  return ["engagements", engagementId, "excerpts"] as const;
}

export async function fetchExcerpts(
  engagementId: string,
  signal?: AbortSignal,
): Promise<Excerpt[]> {
  let response: Response;
  try {
    response = await fetch(
      `/api/v1/engagements/${encodeURIComponent(engagementId)}/excerpts`,
      signal ? { signal } : undefined,
    );
  } catch {
    throw new ExcerptQueryError();
  }
  if (response.status !== 200) throw new ExcerptQueryError();
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ExcerptQueryError();
  }
  const result = ExcerptListResponseSchema.safeParse(payload);
  if (!result.success) throw new ExcerptQueryError();
  return result.data;
}

export function excerptsQueryOptions(engagementId: string | undefined) {
  return queryOptions({
    queryKey:
      engagementId === undefined
        ? (["engagements", "excerpts", "none"] as const)
        : excerptsQueryKey(engagementId),
    queryFn:
      engagementId === undefined ? skipToken : ({ signal }) => fetchExcerpts(engagementId, signal),
    retry: false,
  });
}

export function useExcerptsQuery(engagementId: string | undefined) {
  return useQuery(excerptsQueryOptions(engagementId));
}

export interface CreateExcerptInput {
  runId: string;
  artifactId: string;
  stream: "stdout" | "stderr";
  byteOffset: number;
  byteLength: number;
  targetNote?: string;
}

export async function createExcerptRequest(
  engagementId: string,
  input: CreateExcerptInput,
  signal?: AbortSignal,
): Promise<Excerpt> {
  const body = CreateExcerptRequestSchema.parse(input);
  let response: Response;
  try {
    response = await fetch(`/api/v1/engagements/${encodeURIComponent(engagementId)}/excerpts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch {
    throw new ExcerptQueryError();
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ExcerptQueryError();
  }
  if (response.status !== 201) throw new ExcerptQueryError();
  const parsed = ExcerptSchema.safeParse(payload);
  if (!parsed.success) throw new ExcerptQueryError();
  return parsed.data;
}

export function useCreateExcerptMutation(engagementId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateExcerptInput) => createExcerptRequest(engagementId, input),
    onSuccess: (excerpt) => {
      queryClient.setQueryData<Excerpt[]>(excerptsQueryKey(engagementId), (current) =>
        current === undefined ? [excerpt] : [...current, excerpt],
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: excerptsQueryKey(engagementId) });
    },
  });
}

export async function searchRunOutput(
  engagementId: string,
  runId: string,
  query: string,
  stream?: "stdout" | "stderr",
  signal?: AbortSignal,
): Promise<ExcerptSearchResponse> {
  const params = new URLSearchParams({ q: query });
  if (stream !== undefined) params.set("stream", stream);
  let response: Response;
  try {
    response = await fetch(
      `/api/v1/engagements/${encodeURIComponent(engagementId)}/runs/${encodeURIComponent(runId)}/output/search?${params.toString()}`,
      signal ? { signal } : undefined,
    );
  } catch {
    throw new ExcerptQueryError();
  }
  if (response.status !== 200) throw new ExcerptQueryError();
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ExcerptQueryError();
  }
  const result = ExcerptSearchResponseSchema.safeParse(payload);
  if (!result.success) throw new ExcerptQueryError();
  return result.data;
}

export function excerptSourcesQueryKey(engagementId: string, runId: string) {
  return ["engagements", engagementId, "runs", runId, "excerpt-sources"] as const;
}

export async function fetchExcerptSources(
  engagementId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<ExcerptSourceRef[]> {
  let response: Response;
  try {
    response = await fetch(
      `/api/v1/engagements/${encodeURIComponent(engagementId)}/runs/${encodeURIComponent(runId)}/excerpt-sources`,
      signal ? { signal } : undefined,
    );
  } catch {
    throw new ExcerptQueryError();
  }
  if (response.status !== 200) throw new ExcerptQueryError();
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ExcerptQueryError();
  }
  const result = ExcerptSourceListResponseSchema.safeParse(payload);
  if (!result.success) throw new ExcerptQueryError();
  return result.data;
}

export function useExcerptSourcesQuery(engagementId: string, runId: string) {
  return useQuery({
    queryKey: excerptSourcesQueryKey(engagementId, runId),
    queryFn: ({ signal }) => fetchExcerptSources(engagementId, runId, signal),
    retry: false,
  });
}

export function attachmentsQueryKey(engagementId: string) {
  return ["engagements", engagementId, "attachments"] as const;
}

export async function fetchAttachments(
  engagementId: string,
  signal?: AbortSignal,
): Promise<Attachment[]> {
  let response: Response;
  try {
    response = await fetch(
      `/api/v1/engagements/${encodeURIComponent(engagementId)}/attachments`,
      signal ? { signal } : undefined,
    );
  } catch {
    throw new ExcerptQueryError();
  }
  if (response.status !== 200) throw new ExcerptQueryError();
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ExcerptQueryError();
  }
  const result = AttachmentListResponseSchema.safeParse(payload);
  if (!result.success) throw new ExcerptQueryError();
  return result.data;
}

export async function createAttachmentRequest(
  engagementId: string,
  input: {
    filename: string;
    mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    contentBase64: string;
    caption?: string;
    targetLabel?: string;
  },
  signal?: AbortSignal,
): Promise<Attachment> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/engagements/${encodeURIComponent(engagementId)}/attachments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      ...(signal ? { signal } : {}),
    });
  } catch {
    throw new ExcerptQueryError();
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ExcerptQueryError();
  }
  if (response.status !== 201) throw new ExcerptQueryError();
  const parsed = AttachmentSchema.safeParse(payload);
  if (!parsed.success) throw new ExcerptQueryError();
  return parsed.data;
}

// Pending finding prefill handoff between the Raw output tab and the
// Findings tab. Module-scoped and keyed by engagement: the workspace mounts
// tabs independently and the route search schema is owned elsewhere, so the
// excerpt object itself (already server-verified and masked) travels here.
// Consumed once; a reload loses only the shortcut, never the saved excerpt.
const pendingFindingExcerpts = new Map<string, Excerpt>();

export function requestFindingFromExcerpt(engagementId: string, excerpt: Excerpt): void {
  pendingFindingExcerpts.set(engagementId, excerpt);
}

export function takePendingFindingExcerpt(engagementId: string): Excerpt | undefined {
  const excerpt = pendingFindingExcerpts.get(engagementId);
  if (excerpt !== undefined) pendingFindingExcerpts.delete(engagementId);
  return excerpt;
}
