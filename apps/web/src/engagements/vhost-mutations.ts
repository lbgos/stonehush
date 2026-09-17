import {
  FfufVhostDiscoveryLaunchSchema,
  FfufVhostDiscoveryOptionsSchema,
  type PersistedAction,
} from "@stonehush/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";

import { isRevisionConflict } from "./errors.js";
import { createIntentKeyHolder, requestFingerprint } from "./idempotency.js";
import { sendActionMutation } from "./mutations.js";
import { ENGAGEMENTS_QUERY_KEY, engagementDetailQueryKey } from "./query.js";

export interface VhostDiscoveryInput {
  engagementId: string;
  expectedEngagementRevision: number;
  expectedActiveScopeRevisionId: string | null;
  address: string;
  port: number;
  tls: boolean;
  wordlistPath: string;
  rate: number;
  threads: number;
  timeoutSeconds: number;
  maxTimeSeconds: number;
  matchStatusCodes: readonly number[];
}

export type VhostFieldResult = { ok: true; value: number } | { ok: false; message: string };

const VHOST_NUMERIC_FIELDS = {
  port: { schema: FfufVhostDiscoveryOptionsSchema.shape.port, range: "1-65535" },
  rate: { schema: FfufVhostDiscoveryOptionsSchema.shape.rate, range: "1-10000" },
  threads: { schema: FfufVhostDiscoveryOptionsSchema.shape.threads, range: "1-200" },
  timeoutSeconds: { schema: FfufVhostDiscoveryOptionsSchema.shape.timeoutSeconds, range: "1-120" },
  maxTimeSeconds: { schema: FfufVhostDiscoveryOptionsSchema.shape.maxTimeSeconds, range: "5-1800" },
} as const;

export function parseVhostPositiveInt(
  raw: string,
  field: keyof typeof VHOST_NUMERIC_FIELDS,
  label: string,
): VhostFieldResult {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false, message: `${label} must be a positive integer.` };
  const value = Number.parseInt(trimmed, 10);
  if (!VHOST_NUMERIC_FIELDS[field].schema.safeParse(value).success) {
    return { ok: false, message: `${label} must be an integer in ${VHOST_NUMERIC_FIELDS[field].range}.` };
  }
  return { ok: true, value };
}

export function validateVhostAddress(
  raw: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: "Target IP must be an explicit IPv4 or IPv6 address." };
  }
  if (!FfufVhostDiscoveryOptionsSchema.shape.address.safeParse(trimmed).success) {
    return { ok: false, message: "Target IP must be an explicit IPv4 or IPv6 address." };
  }
  return { ok: true, value: trimmed };
}

export function validateVhostWordlistPath(
  raw: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: "Wordlist path must be an absolute managed path." };
  }
  if (!FfufVhostDiscoveryOptionsSchema.shape.wordlistPath.safeParse(trimmed).success) {
    return {
      ok: false,
      message: "Wordlist path must be absolute and must not contain path traversal.",
    };
  }
  return { ok: true, value: trimmed };
}

export async function launchVhostDiscoveryRequest(
  input: VhostDiscoveryInput,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<PersistedAction> {
  const body = FfufVhostDiscoveryLaunchSchema.parse({
    expectedEngagementRevision: input.expectedEngagementRevision,
    expectedActiveScopeRevisionId: input.expectedActiveScopeRevisionId,
    address: input.address,
    port: input.port,
    tls: input.tls,
    wordlistPath: input.wordlistPath,
    rate: input.rate,
    threads: input.threads,
    timeoutSeconds: input.timeoutSeconds,
    maxTimeSeconds: input.maxTimeSeconds,
    matchStatusCodes: [...input.matchStatusCodes],
  });
  return sendActionMutation(`/api/v1/engagements/${input.engagementId}/vhost-discoveries`, {
    body,
    idempotencyKey,
    ...(signal ? { signal } : {}),
  });
}

export function useLaunchVhostDiscoveryMutation() {
  const queryClient = useQueryClient();
  const keys = useRef(createIntentKeyHolder());

  return useMutation({
    mutationFn: (input: VhostDiscoveryInput) => {
      const body = FfufVhostDiscoveryLaunchSchema.parse({
        expectedEngagementRevision: input.expectedEngagementRevision,
        expectedActiveScopeRevisionId: input.expectedActiveScopeRevisionId,
        address: input.address,
        port: input.port,
        tls: input.tls,
        wordlistPath: input.wordlistPath,
        rate: input.rate,
        threads: input.threads,
        timeoutSeconds: input.timeoutSeconds,
        maxTimeSeconds: input.maxTimeSeconds,
        matchStatusCodes: [...input.matchStatusCodes],
      });
      const intent = requestFingerprint({
        engagementId: input.engagementId,
        ...body,
      });
      return launchVhostDiscoveryRequest(input, keys.current.keyFor(intent));
    },
    onSuccess: (_action, input) => {
      keys.current.reset(
        requestFingerprint({
          engagementId: input.engagementId,
          expectedEngagementRevision: input.expectedEngagementRevision,
          expectedActiveScopeRevisionId: input.expectedActiveScopeRevisionId,
          address: input.address,
          port: input.port,
          tls: input.tls,
          wordlistPath: input.wordlistPath,
          rate: input.rate,
          threads: input.threads,
          timeoutSeconds: input.timeoutSeconds,
          maxTimeSeconds: input.maxTimeSeconds,
          matchStatusCodes: [...input.matchStatusCodes],
        }),
      );
    },
    onError: async (error, input) => {
      if (isRevisionConflict(error)) {
        await queryClient.invalidateQueries({
          queryKey: engagementDetailQueryKey(input.engagementId),
        });
        await queryClient.invalidateQueries({ queryKey: ENGAGEMENTS_QUERY_KEY });
      }
    },
  });
}
