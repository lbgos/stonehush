import {
  ActionResponseSchema,
  AppendScopeRevisionRequestSchema,
  CreateEngagementRequestSchema,
  EngagementMutationResponseSchema,
  ScopeRevisionMutationResponseSchema,
  UpdateEngagementDeadlineRequestSchema,
  type CreateEngagementInput,
  type Engagement,
  type EngagementWithActiveScope,
  type PersistedAction,
  type SavedScopeRule,
  type ScopeRevision,
} from "@stonehush/contracts";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useRef } from "react";

import {
  EngagementMutationClientError,
  isRevisionConflict,
  parseEngagementMutationError,
} from "./errors.js";
import { createIdempotencyKey, createIntentKeyHolder, requestFingerprint } from "./idempotency.js";
import { canonicalTargetIdentities } from "./action-targets.js";
import { ENGAGEMENTS_QUERY_KEY, engagementDetailQueryKey } from "./query.js";

const SUCCESS_STATUSES = new Set([200, 201]);
const ERROR_STATUSES = new Set([400, 404, 409, 500, 503]);

interface MutationSuccessSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

async function sendOperatorMutation<T>(
  url: string,
  init: {
    body: unknown;
    idempotencyKey: string;
    method?: "POST" | "PATCH";
    signal?: AbortSignal;
  },
  successSchema: MutationSuccessSchema<T>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": init.idempotencyKey,
      },
      body: JSON.stringify(init.body),
      ...(init.signal ? { signal: init.signal } : {}),
    });
  } catch {
    throw new EngagementMutationClientError("request_failed");
  }

  if (!SUCCESS_STATUSES.has(response.status) && !ERROR_STATUSES.has(response.status)) {
    throw new EngagementMutationClientError("request_failed");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new EngagementMutationClientError("request_failed");
  }

  if (SUCCESS_STATUSES.has(response.status)) {
    const parsed = successSchema.safeParse(payload);
    if (!parsed.success) throw new EngagementMutationClientError("invalid_persisted_data");
    return parsed.data;
  }

  throw parseEngagementMutationError(payload);
}

export async function sendEngagementMutation(
  url: string,
  init: {
    body: unknown;
    idempotencyKey: string;
    method?: "POST" | "PATCH";
    signal?: AbortSignal;
  },
): Promise<Engagement> {
  return sendOperatorMutation(url, init, EngagementMutationResponseSchema);
}

export async function sendScopeRevisionMutation(
  url: string,
  init: {
    body: unknown;
    idempotencyKey: string;
    method?: "POST" | "PATCH";
    signal?: AbortSignal;
  },
): Promise<ScopeRevision> {
  return sendOperatorMutation(url, init, ScopeRevisionMutationResponseSchema);
}

export async function sendActionMutation(
  url: string,
  init: {
    body: unknown;
    idempotencyKey: string;
    method?: "POST" | "PATCH";
    signal?: AbortSignal;
  },
): Promise<PersistedAction> {
  return sendOperatorMutation(url, init, ActionResponseSchema);
}

export async function createEngagementRequest(
  input: CreateEngagementInput,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<Engagement> {
  const body = CreateEngagementRequestSchema.parse(input);
  return sendEngagementMutation("/api/v1/engagements", {
    body,
    idempotencyKey,
    ...(signal ? { signal } : {}),
  });
}

export async function archiveEngagementRequest(
  engagementId: string,
  expectedRevision: number,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<Engagement> {
  return sendEngagementMutation(`/api/v1/engagements/${engagementId}/archive`, {
    body: { expectedRevision },
    idempotencyKey,
    ...(signal ? { signal } : {}),
  });
}

export async function reopenEngagementRequest(
  engagementId: string,
  expectedRevision: number,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<Engagement> {
  return sendEngagementMutation(`/api/v1/engagements/${engagementId}/reopen`, {
    body: { expectedRevision },
    idempotencyKey,
    ...(signal ? { signal } : {}),
  });
}

export async function appendScopeRevisionRequest(
  engagementId: string,
  input: { expectedRevision: number; rules: readonly SavedScopeRule[] },
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<ScopeRevision> {
  const body = AppendScopeRevisionRequestSchema.parse(input);
  return sendScopeRevisionMutation(`/api/v1/engagements/${engagementId}/scope-revisions`, {
    body,
    idempotencyKey,
    ...(signal ? { signal } : {}),
  });
}

export async function updateDeadlineRequest(
  engagementId: string,
  input: { expectedRevision: number; deadlineAt: string | null },
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<Engagement> {
  const body = UpdateEngagementDeadlineRequestSchema.parse(input);
  return sendEngagementMutation(`/api/v1/engagements/${engagementId}/deadline`, {
    body,
    idempotencyKey,
    method: "PATCH",
    ...(signal ? { signal } : {}),
  });
}

export function upsertEngagementInCache(queryClient: QueryClient, engagement: Engagement) {
  queryClient.setQueryData<Engagement[]>(ENGAGEMENTS_QUERY_KEY, (current) => {
    if (current === undefined) return [engagement];
    const index = current.findIndex((item) => item.id === engagement.id);
    if (index === -1) {
      return [...current, engagement].sort((left, right) => {
        const created = left.createdAt.localeCompare(right.createdAt);
        return created !== 0 ? created : left.id.localeCompare(right.id);
      });
    }
    const next = current.slice();
    next[index] = engagement;
    return next;
  });
}

function applyScopeRevisionToCaches(
  queryClient: QueryClient,
  engagementId: string,
  revision: ScopeRevision,
  expectedRevision: number,
) {
  queryClient.setQueryData<EngagementWithActiveScope>(
    engagementDetailQueryKey(engagementId),
    (current) => {
      if (current === undefined) return current;
      return {
        engagement: {
          ...current.engagement,
          revision: expectedRevision + 1,
          activeScopeRevisionId: revision.id,
          updatedAt: revision.createdAt,
        },
        activeScopeRevision: revision,
      };
    },
  );

  const listed = queryClient
    .getQueryData<Engagement[]>(ENGAGEMENTS_QUERY_KEY)
    ?.find((item) => item.id === engagementId);
  if (listed === undefined) return;
  upsertEngagementInCache(queryClient, {
    ...listed,
    revision: expectedRevision + 1,
    activeScopeRevisionId: revision.id,
    updatedAt: revision.createdAt,
  });
}

async function handleLifecycleError(queryClient: QueryClient, error: unknown) {
  if (isRevisionConflict(error)) {
    await queryClient.invalidateQueries({ queryKey: ENGAGEMENTS_QUERY_KEY });
  }
}

export function useCreateEngagementMutation() {
  const queryClient = useQueryClient();
  const keys = useRef(createIntentKeyHolder());

  // The creation intent covers the first scan targets alongside the stored
  // metadata. Two starts that differ only in targets are different intents:
  // reopening after a lost response with a new target must create a fresh
  // engagement instead of replaying the abandoned one. Targets enter in
  // canonical sorted form so equivalent inputs and reorderings keep the same
  // key and still replay. Identical retries keep the same key so a committed
  // create still replays.
  const keyFor = (body: CreateEngagementInput, targets?: readonly string[]) =>
    keys.current.keyFor(
      requestFingerprint(
        targets === undefined ? body : { ...body, targets: canonicalTargetIdentities(targets) },
      ),
    );
  const resetKey = (body: CreateEngagementInput, targets?: readonly string[]) =>
    keys.current.reset(
      requestFingerprint(
        targets === undefined ? body : { ...body, targets: canonicalTargetIdentities(targets) },
      ),
    );

  return useMutation({
    mutationFn: (input: CreateEngagementInput & { targets?: readonly string[] }) => {
      const { targets, ...rest } = input;
      const body = CreateEngagementRequestSchema.parse(rest);
      return createEngagementRequest(body, keyFor(body, targets));
    },
    onSuccess: (engagement, input) => {
      upsertEngagementInCache(queryClient, engagement);
      const { targets, ...rest } = input;
      resetKey(CreateEngagementRequestSchema.parse(rest), targets);
    },
  });
}

export function useArchiveEngagementMutation() {
  const queryClient = useQueryClient();
  const keys = useRef(createIntentKeyHolder());

  return useMutation({
    mutationFn: (input: { engagementId: string; expectedRevision: number }) => {
      const intent = `archive:${input.engagementId}:${input.expectedRevision}`;
      return archiveEngagementRequest(
        input.engagementId,
        input.expectedRevision,
        keys.current.keyFor(intent),
      );
    },
    onSuccess: (engagement, input) => {
      upsertEngagementInCache(queryClient, engagement);
      keys.current.reset(`archive:${input.engagementId}:${input.expectedRevision}`);
      void queryClient.invalidateQueries({
        queryKey: engagementDetailQueryKey(input.engagementId),
      });
    },
    onError: (error) => handleLifecycleError(queryClient, error),
  });
}

export function useReopenEngagementMutation() {
  const queryClient = useQueryClient();
  const keys = useRef(createIntentKeyHolder());

  return useMutation({
    mutationFn: (input: { engagementId: string; expectedRevision: number }) => {
      const intent = `reopen:${input.engagementId}:${input.expectedRevision}`;
      return reopenEngagementRequest(
        input.engagementId,
        input.expectedRevision,
        keys.current.keyFor(intent),
      );
    },
    onSuccess: (engagement, input) => {
      upsertEngagementInCache(queryClient, engagement);
      keys.current.reset(`reopen:${input.engagementId}:${input.expectedRevision}`);
      void queryClient.invalidateQueries({
        queryKey: engagementDetailQueryKey(input.engagementId),
      });
    },
    onError: (error) => handleLifecycleError(queryClient, error),
  });
}

export function useUpdateDeadlineMutation() {
  const queryClient = useQueryClient();
  const keys = useRef(createIntentKeyHolder());

  return useMutation({
    mutationFn: (input: {
      engagementId: string;
      expectedRevision: number;
      deadlineAt: string | null;
    }) => {
      const body = UpdateEngagementDeadlineRequestSchema.parse({
        expectedRevision: input.expectedRevision,
        deadlineAt: input.deadlineAt,
      });
      const intent = requestFingerprint({
        engagementId: input.engagementId,
        expectedRevision: body.expectedRevision,
        deadlineAt: body.deadlineAt,
      });
      return updateDeadlineRequest(input.engagementId, body, keys.current.keyFor(intent));
    },
    onSuccess: (engagement, input) => {
      upsertEngagementInCache(queryClient, engagement);
      keys.current.reset(
        requestFingerprint({
          engagementId: input.engagementId,
          expectedRevision: input.expectedRevision,
          deadlineAt: input.deadlineAt,
        }),
      );
      void queryClient.invalidateQueries({
        queryKey: engagementDetailQueryKey(input.engagementId),
      });
    },
    onError: (error) => handleLifecycleError(queryClient, error),
  });
}

export function useAppendScopeRevisionMutation() {
  const queryClient = useQueryClient();
  const keys = useRef(createIntentKeyHolder());

  return useMutation({
    mutationFn: (input: {
      engagementId: string;
      expectedRevision: number;
      rules: readonly SavedScopeRule[];
    }) => {
      const body = AppendScopeRevisionRequestSchema.parse({
        expectedRevision: input.expectedRevision,
        rules: input.rules,
      });
      const intent = requestFingerprint({
        engagementId: input.engagementId,
        expectedRevision: body.expectedRevision,
        rules: body.rules,
      });
      return appendScopeRevisionRequest(input.engagementId, body, keys.current.keyFor(intent));
    },
    onSuccess: async (revision, input) => {
      const body = AppendScopeRevisionRequestSchema.parse({
        expectedRevision: input.expectedRevision,
        rules: input.rules,
      });
      keys.current.reset(
        requestFingerprint({
          engagementId: input.engagementId,
          expectedRevision: body.expectedRevision,
          rules: body.rules,
        }),
      );
      applyScopeRevisionToCaches(
        queryClient,
        input.engagementId,
        revision,
        input.expectedRevision,
      );
      await queryClient.invalidateQueries({
        queryKey: engagementDetailQueryKey(input.engagementId),
      });
      await queryClient.invalidateQueries({ queryKey: ENGAGEMENTS_QUERY_KEY });
    },
    onError: (error) => handleLifecycleError(queryClient, error),
  });
}

export { createIdempotencyKey };
