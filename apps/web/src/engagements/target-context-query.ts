import {
  StoneAddressBindingSchema,
  StoneHostnameAssociationSchema,
  StoneTargetListResponseSchema,
  type StoneAddressBinding,
  type StoneHostnameAssociation,
  type StoneTarget,
} from "@blackglass/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";

export const STONE_TARGETS_QUERY_KEY = ["stone-targets"] as const;

export class StoneTargetQueryError extends Error {
  constructor() {
    super("The target request failed.");
    this.name = "StoneTargetQueryError";
  }
}

export class StoneTargetMutationError extends Error {
  readonly code: string;
  constructor(code: string) {
    super("The target request failed.");
    this.name = "StoneTargetMutationError";
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

export async function fetchStoneTargets(
  engagementId: string,
  signal?: AbortSignal,
): Promise<StoneTarget[]> {
  const response = await fetch(
    `/api/v1/engagements/${engagementId}/stone-targets`,
    signal ? { signal } : undefined,
  );
  if (response.status !== 200) throw new StoneTargetQueryError();
  const payload: unknown = await response.json();
  const result = StoneTargetListResponseSchema.safeParse(payload);
  if (!result.success) throw new StoneTargetQueryError();
  return result.data;
}

export interface StoneBindings {
  current: StoneAddressBinding[];
  historical: StoneAddressBinding[];
}

export async function fetchStoneBindings(
  engagementId: string,
  targetId: string,
  signal?: AbortSignal,
): Promise<StoneBindings> {
  const response = await fetch(
    `/api/v1/engagements/${engagementId}/stone-targets/${targetId}/bindings`,
    signal ? { signal } : undefined,
  );
  if (response.status !== 200) throw new StoneTargetQueryError();
  const payload = (await response.json()) as { current: unknown; historical: unknown };
  const current = Array.isArray(payload.current)
    ? payload.current.map((item) => StoneAddressBindingSchema.parse(item))
    : [];
  const historical = Array.isArray(payload.historical)
    ? payload.historical.map((item) => StoneAddressBindingSchema.parse(item))
    : [];
  return { current, historical };
}

export function stoneTargetsQueryKey(engagementId: string) {
  return [...STONE_TARGETS_QUERY_KEY, engagementId] as const;
}

export function stoneBindingsQueryKey(engagementId: string, targetId: string) {
  return [...STONE_TARGETS_QUERY_KEY, engagementId, targetId, "bindings"] as const;
}

export function stoneTargetsQueryOptions(engagementId: string) {
  return queryOptions({
    queryKey: stoneTargetsQueryKey(engagementId),
    queryFn: ({ signal }) => fetchStoneTargets(engagementId, signal),
  });
}

export function stoneBindingsQueryOptions(engagementId: string, targetId: string) {
  return queryOptions({
    queryKey: stoneBindingsQueryKey(engagementId, targetId),
    queryFn: ({ signal }) => fetchStoneBindings(engagementId, targetId, signal),
  });
}

export function useStoneTargetsQuery(engagementId: string) {
  return useQuery(stoneTargetsQueryOptions(engagementId));
}

export function useStoneBindingsQuery(engagementId: string, targetId: string | null) {
  return useQuery({
    queryKey:
      targetId === null
        ? [...STONE_TARGETS_QUERY_KEY, engagementId, "no-target"]
        : stoneBindingsQueryKey(engagementId, targetId),
    queryFn: ({ signal }) =>
      targetId === null
        ? Promise.resolve({ current: [], historical: [] } satisfies StoneBindings)
        : fetchStoneBindings(engagementId, targetId, signal),
  });
}

export async function createStoneTargetRequest(
  engagementId: string,
  input: { label: string; initialAddress: string },
): Promise<StoneTarget> {
  const response = await fetch(`/api/v1/engagements/${engagementId}/stone-targets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const payload: unknown = await response.json();
  if (response.status !== 201) throw new StoneTargetMutationError(responseCode(payload));
  return payload as StoneTarget;
}

export async function changeStoneAddressRequest(
  engagementId: string,
  targetId: string,
  input: { newAddress: string; reason?: string },
): Promise<{ addressText: string; retiredBindingId: string | null }> {
  const response = await fetch(
    `/api/v1/engagements/${engagementId}/stone-targets/${targetId}/address-change`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetId, ...input }),
    },
  );
  const payload: unknown = await response.json();
  if (response.status !== 200) throw new StoneTargetMutationError(responseCode(payload));
  return payload as { addressText: string; retiredBindingId: string | null };
}

export async function proposeStoneHostnameRequest(
  engagementId: string,
  targetId: string,
  input: { connectionAddress: string; requestedHostname: string },
): Promise<StoneHostnameAssociation> {
  const response = await fetch(
    `/api/v1/engagements/${engagementId}/stone-targets/${targetId}/hostname-associations`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  const payload: unknown = await response.json();
  if (response.status !== 201) throw new StoneTargetMutationError(responseCode(payload));
  return StoneHostnameAssociationSchema.parse(payload);
}

export async function decideStoneHostnameRequest(
  engagementId: string,
  associationId: string,
  decision: "associated" | "declined",
): Promise<StoneHostnameAssociation> {
  const response = await fetch(
    `/api/v1/engagements/${engagementId}/stone-hostname-associations/${associationId}/decision`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    },
  );
  const payload: unknown = await response.json();
  if (response.status !== 200) throw new StoneTargetMutationError(responseCode(payload));
  return StoneHostnameAssociationSchema.parse(payload);
}
