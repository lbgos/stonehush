import {
  RunOutputResponseSchema,
  type RunOutputResponse,
} from "@stonehush/contracts";
import { queryOptions, skipToken, useQuery } from "@tanstack/react-query";

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
  if (response.status !== 200) throw new RunOutputQueryError();
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
  if (response.status !== 200) throw new RunOutputQueryError();
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
