import {
  StoneCaptureListResponseSchema,
  type StoneCapture,
  type StoneCaptureKind,
} from "@blackglass/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";

export const STONE_CAPTURES_QUERY_KEY = ["stone-captures"] as const;

export class StoneCaptureQueryError extends Error {
  constructor() {
    super("The capture request failed.");
    this.name = "StoneCaptureQueryError";
  }
}

export class StoneCaptureMutationError extends Error {
  readonly code: string;
  constructor(code: string) {
    super("The capture request failed.");
    this.name = "StoneCaptureMutationError";
    this.code = code;
  }
}

function responseCode(payload: unknown): string {
  if (typeof payload === "object" && payload !== null && "code" in payload) {
    const code = (payload as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "request_failed";
}

export async function fetchStoneCaptures(
  engagementId: string,
  signal?: AbortSignal,
): Promise<StoneCapture[]> {
  const response = await fetch(
    `/api/v1/engagements/${engagementId}/stone-captures`,
    signal ? { signal } : undefined,
  );
  if (response.status !== 200) throw new StoneCaptureQueryError();
  const payload: unknown = await response.json();
  const result = StoneCaptureListResponseSchema.safeParse(payload);
  if (!result.success) throw new StoneCaptureQueryError();
  return result.data;
}

export function stoneCapturesQueryKey(engagementId: string) {
  return [...STONE_CAPTURES_QUERY_KEY, engagementId] as const;
}

export function stoneCapturesQueryOptions(engagementId: string) {
  return queryOptions({
    queryKey: stoneCapturesQueryKey(engagementId),
    queryFn: ({ signal }) => fetchStoneCaptures(engagementId, signal),
  });
}

export function useStoneCapturesQuery(engagementId: string) {
  return useQuery(stoneCapturesQueryOptions(engagementId));
}

export interface StoneCaptureDraft {
  targetId: string | null;
  leadId: string | null;
  kind: StoneCaptureKind;
  title: string;
  command?: string | undefined;
  observation?: string | undefined;
  contentText?: string | undefined;
  contentDigest?: string | undefined;
  fileName?: string | undefined;
  byteSize?: number | undefined;
}

export async function createStoneCaptureRequest(
  engagementId: string,
  draft: StoneCaptureDraft,
): Promise<{ deduplicated: boolean; capture: StoneCapture }> {
  const response = await fetch(`/api/v1/engagements/${engagementId}/stone-captures`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ engagementId, ...draft }),
  });
  const payload: unknown = await response.json();
  if (response.status !== 201 && response.status !== 200) {
    throw new StoneCaptureMutationError(responseCode(payload));
  }
  return payload as { deduplicated: boolean; capture: StoneCapture };
}

export async function importStoneArtifactRequest(
  engagementId: string,
  artifact: "nmap-xml" | "ffuf-json",
  draft: Omit<StoneCaptureDraft, "kind">,
): Promise<{ deduplicated: boolean; capture: StoneCapture }> {
  const response = await fetch(
    `/api/v1/engagements/${engagementId}/stone-imports/${artifact}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...draft }),
    },
  );
  const payload: unknown = await response.json();
  if (response.status !== 201 && response.status !== 200) {
    throw new StoneCaptureMutationError(responseCode(payload));
  }
  return payload as { deduplicated: boolean; capture: StoneCapture };
}
