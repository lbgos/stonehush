import {
  FfufDiscoveryLaunchSchema,
  FfufDiscoveryOptionsSchema,
  type PersistedAction,
} from "@stonehush/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";

import { isRevisionConflict } from "./errors.js";
import { createIntentKeyHolder, requestFingerprint } from "./idempotency.js";
import { sendActionMutation } from "./mutations.js";
import { ENGAGEMENTS_QUERY_KEY, engagementDetailQueryKey } from "./query.js";

export interface FfufDiscoveryInput {
  engagementId: string;
  expectedEngagementRevision: number;
  expectedActiveScopeRevisionId: string | null;
  origin: string;
  wordlistPath: string;
  rate: number;
  threads: number;
  timeoutSeconds: number;
  maxTimeSeconds: number;
  matchStatusCodes: readonly number[];
}

export type FfufFieldResult = { ok: true; value: number } | { ok: false; message: string };

// Numeric launch fields validated against the authoritative ffuf contract
// bounds (not just positive integers) so out-of-range input fails here with
// a field error instead of a generic request error from the mutation parse.
// The accept/reject decision always comes from the contract schema itself;
// only the message text names the range.
const FFUF_NUMERIC_FIELDS = {
  rate: { schema: FfufDiscoveryOptionsSchema.shape.rate, range: "1-10000" },
  threads: { schema: FfufDiscoveryOptionsSchema.shape.threads, range: "1-200" },
  timeoutSeconds: { schema: FfufDiscoveryOptionsSchema.shape.timeoutSeconds, range: "1-120" },
  maxTimeSeconds: { schema: FfufDiscoveryOptionsSchema.shape.maxTimeSeconds, range: "5-1800" },
} as const;

export function parseFfufPositiveInt(
  raw: string,
  field: keyof typeof FFUF_NUMERIC_FIELDS,
  label: string,
): FfufFieldResult {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false, message: `${label} must be a positive integer.` };
  const value = Number.parseInt(trimmed, 10);
  if (!FFUF_NUMERIC_FIELDS[field].schema.safeParse(value).success) {
    return { ok: false, message: `${label} must be an integer in ${FFUF_NUMERIC_FIELDS[field].range}.` };
  }
  return { ok: true, value };
}

export function validateFfufWordlistPath(
  raw: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: "Wordlist path must be an absolute managed path." };
  }
  if (!FfufDiscoveryOptionsSchema.shape.wordlistPath.safeParse(trimmed).success) {
    return {
      ok: false,
      message: "Wordlist path must be absolute and must not contain path traversal.",
    };
  }
  return { ok: true, value: trimmed };
}

export async function launchFfufDiscoveryRequest(
  input: FfufDiscoveryInput,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<PersistedAction> {
  const body = FfufDiscoveryLaunchSchema.parse({
    expectedEngagementRevision: input.expectedEngagementRevision,
    expectedActiveScopeRevisionId: input.expectedActiveScopeRevisionId,
    origin: input.origin,
    wordlistPath: input.wordlistPath,
    rate: input.rate,
    threads: input.threads,
    timeoutSeconds: input.timeoutSeconds,
    maxTimeSeconds: input.maxTimeSeconds,
    matchStatusCodes: [...input.matchStatusCodes],
  });
  return sendActionMutation(`/api/v1/engagements/${input.engagementId}/ffuf-discoveries`, {
    body,
    idempotencyKey,
    ...(signal ? { signal } : {}),
  });
}

export function useLaunchFfufDiscoveryMutation() {
  const queryClient = useQueryClient();
  const keys = useRef(createIntentKeyHolder());

  return useMutation({
    mutationFn: (input: FfufDiscoveryInput) => {
      const body = FfufDiscoveryLaunchSchema.parse({
        expectedEngagementRevision: input.expectedEngagementRevision,
        expectedActiveScopeRevisionId: input.expectedActiveScopeRevisionId,
        origin: input.origin,
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
      return launchFfufDiscoveryRequest(input, keys.current.keyFor(intent));
    },
    onSuccess: (_action, input) => {
      keys.current.reset(
        requestFingerprint({
          engagementId: input.engagementId,
          expectedEngagementRevision: input.expectedEngagementRevision,
          expectedActiveScopeRevisionId: input.expectedActiveScopeRevisionId,
          origin: input.origin,
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
