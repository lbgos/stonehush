import {
  ActionResponseSchema,
  AddScopeAndRunActionRequestSchema,
  CancelActionRequestSchema,
  ContinueActionRequestSchema,
  ContinueLateWarningActionRequestSchema,
  CreateActionRequestSchema,
  type PersistedAction,
  type SavedScopeRule,
} from "@stonehush/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";

import {
  EngagementMutationClientError,
  isRevisionConflict,
  parseEngagementMutationError,
} from "./errors.js";
import { createIntentKeyHolder, requestFingerprint } from "./idempotency.js";
import { sendActionMutation } from "./mutations.js";
import { ENGAGEMENTS_QUERY_KEY, engagementDetailQueryKey } from "./query.js";

const ERROR_STATUSES = new Set([400, 404, 409, 500, 503]);

export async function createActionRequest(
  engagementId: string,
  input: {
    expectedEngagementRevision: number;
    expectedActiveScopeRevisionId: string | null;
    targets: readonly string[];
    declaredPorts: readonly number[] | null;
  },
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<PersistedAction> {
  const body = CreateActionRequestSchema.parse(input);
  return sendActionMutation(`/api/v1/engagements/${engagementId}/actions`, {
    body,
    idempotencyKey,
    ...(signal ? { signal } : {}),
  });
}

export async function continueActionRequest(
  engagementId: string,
  actionId: string,
  input: {
    expectedRevision: number;
    snapshotVersion: number;
    snapshotBinding: string;
  },
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<PersistedAction> {
  const body = ContinueActionRequestSchema.parse(input);
  return sendActionMutation(
    `/api/v1/engagements/${engagementId}/actions/${actionId}/continue`,
    {
      body,
      idempotencyKey,
      ...(signal ? { signal } : {}),
    },
  );
}

export async function continueLateWarningActionRequest(
  engagementId: string,
  actionId: string,
  input: {
    expectedRevision: number;
    snapshotVersion: number;
    snapshotBinding: string;
    pendingEventId: number;
  },
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<PersistedAction> {
  const body = ContinueLateWarningActionRequestSchema.parse(input);
  return sendActionMutation(
    `/api/v1/engagements/${engagementId}/actions/${actionId}/continue-late-warning`,
    {
      body,
      idempotencyKey,
      ...(signal ? { signal } : {}),
    },
  );
}

export async function addScopeAndRunActionRequest(
  engagementId: string,
  actionId: string,
  input: {
    expectedEngagementRevision: number;
    expectedActionRevision: number;
    rules: readonly SavedScopeRule[];
  },
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<PersistedAction> {
  const body = AddScopeAndRunActionRequestSchema.parse(input);
  return sendActionMutation(
    `/api/v1/engagements/${engagementId}/actions/${actionId}/add-scope-and-run`,
    {
      body,
      idempotencyKey,
      ...(signal ? { signal } : {}),
    },
  );
}

export async function cancelActionRequest(
  engagementId: string,
  actionId: string,
  input: { expectedRevision: number },
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<PersistedAction> {
  const body = CancelActionRequestSchema.parse(input);
  return sendActionMutation(
    `/api/v1/engagements/${engagementId}/actions/${actionId}/cancel`,
    {
      body,
      idempotencyKey,
      ...(signal ? { signal } : {}),
    },
  );
}

export async function fetchPersistedAction(
  engagementId: string,
  actionId: string,
  signal?: AbortSignal,
): Promise<PersistedAction> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/engagements/${engagementId}/actions/${actionId}`, {
      ...(signal ? { signal } : {}),
    });
  } catch {
    throw new EngagementMutationClientError("request_failed");
  }

  if (response.status !== 200 && !ERROR_STATUSES.has(response.status)) {
    throw new EngagementMutationClientError("request_failed");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new EngagementMutationClientError("request_failed");
  }

  if (response.status === 200) {
    const parsed = ActionResponseSchema.safeParse(payload);
    if (!parsed.success) throw new EngagementMutationClientError("invalid_persisted_data");
    return parsed.data;
  }

  throw parseEngagementMutationError(payload);
}

async function refreshAfterConflict(queryClient: ReturnType<typeof useQueryClient>, engagementId: string) {
  await queryClient.invalidateQueries({ queryKey: engagementDetailQueryKey(engagementId) });
  await queryClient.invalidateQueries({ queryKey: ENGAGEMENTS_QUERY_KEY });
}

export function useCreateActionMutation() {
  const queryClient = useQueryClient();
  const keys = useRef(createIntentKeyHolder());

  return useMutation({
    mutationFn: (input: {
      engagementId: string;
      expectedEngagementRevision: number;
      expectedActiveScopeRevisionId: string | null;
      targets: readonly string[];
      declaredPorts: readonly number[] | null;
    }) => {
      const body = CreateActionRequestSchema.parse({
        expectedEngagementRevision: input.expectedEngagementRevision,
        expectedActiveScopeRevisionId: input.expectedActiveScopeRevisionId,
        targets: input.targets,
        declaredPorts: input.declaredPorts,
      });
      const intent = requestFingerprint({
        engagementId: input.engagementId,
        ...body,
      });
      return createActionRequest(input.engagementId, body, keys.current.keyFor(intent));
    },
    onSuccess: (_action, input) => {
      const body = CreateActionRequestSchema.parse({
        expectedEngagementRevision: input.expectedEngagementRevision,
        expectedActiveScopeRevisionId: input.expectedActiveScopeRevisionId,
        targets: input.targets,
        declaredPorts: input.declaredPorts,
      });
      keys.current.reset(
        requestFingerprint({
          engagementId: input.engagementId,
          ...body,
        }),
      );
    },
    onError: async (error, input) => {
      if (isRevisionConflict(error)) {
        await refreshAfterConflict(queryClient, input.engagementId);
      }
    },
  });
}

export function useContinueActionMutation() {
  const queryClient = useQueryClient();
  const keys = useRef(createIntentKeyHolder());

  return useMutation({
    mutationFn: (input: {
      engagementId: string;
      actionId: string;
      expectedRevision: number;
      snapshotVersion: number;
      snapshotBinding: string;
    }) => {
      const body = ContinueActionRequestSchema.parse({
        expectedRevision: input.expectedRevision,
        snapshotVersion: input.snapshotVersion,
        snapshotBinding: input.snapshotBinding,
      });
      const intent = requestFingerprint({
        engagementId: input.engagementId,
        actionId: input.actionId,
        ...body,
      });
      return continueActionRequest(
        input.engagementId,
        input.actionId,
        body,
        keys.current.keyFor(intent),
      );
    },
    onSuccess: (_action, input) => {
      keys.current.reset(
        requestFingerprint({
          engagementId: input.engagementId,
          actionId: input.actionId,
          expectedRevision: input.expectedRevision,
          snapshotVersion: input.snapshotVersion,
          snapshotBinding: input.snapshotBinding,
        }),
      );
    },
    onError: async (error, input) => {
      if (isRevisionConflict(error)) {
        await refreshAfterConflict(queryClient, input.engagementId);
      }
    },
  });
}

export function useContinueLateWarningActionMutation() {
  const queryClient = useQueryClient();
  const keys = useRef(createIntentKeyHolder());

  return useMutation({
    mutationFn: (input: {
      engagementId: string;
      actionId: string;
      expectedRevision: number;
      snapshotVersion: number;
      snapshotBinding: string;
      pendingEventId: number;
    }) => {
      const body = ContinueLateWarningActionRequestSchema.parse({
        expectedRevision: input.expectedRevision,
        snapshotVersion: input.snapshotVersion,
        snapshotBinding: input.snapshotBinding,
        pendingEventId: input.pendingEventId,
      });
      const intent = requestFingerprint({
        engagementId: input.engagementId,
        actionId: input.actionId,
        ...body,
      });
      return continueLateWarningActionRequest(
        input.engagementId,
        input.actionId,
        body,
        keys.current.keyFor(intent),
      );
    },
    onSuccess: (_action, input) => {
      keys.current.reset(
        requestFingerprint({
          engagementId: input.engagementId,
          actionId: input.actionId,
          expectedRevision: input.expectedRevision,
          snapshotVersion: input.snapshotVersion,
          snapshotBinding: input.snapshotBinding,
          pendingEventId: input.pendingEventId,
        }),
      );
    },
    onError: async (error, input) => {
      if (isRevisionConflict(error)) {
        await refreshAfterConflict(queryClient, input.engagementId);
      }
    },
  });
}

export function useAddScopeAndRunActionMutation() {
  const queryClient = useQueryClient();
  const keys = useRef(createIntentKeyHolder());

  return useMutation({
    mutationFn: (input: {
      engagementId: string;
      actionId: string;
      expectedEngagementRevision: number;
      expectedActionRevision: number;
      rules: readonly SavedScopeRule[];
    }) => {
      const body = AddScopeAndRunActionRequestSchema.parse({
        expectedEngagementRevision: input.expectedEngagementRevision,
        expectedActionRevision: input.expectedActionRevision,
        rules: input.rules,
      });
      const intent = requestFingerprint({
        engagementId: input.engagementId,
        actionId: input.actionId,
        ...body,
      });
      return addScopeAndRunActionRequest(
        input.engagementId,
        input.actionId,
        body,
        keys.current.keyFor(intent),
      );
    },
    onSuccess: async (_action, input) => {
      keys.current.reset(
        requestFingerprint({
          engagementId: input.engagementId,
          actionId: input.actionId,
          expectedEngagementRevision: input.expectedEngagementRevision,
          expectedActionRevision: input.expectedActionRevision,
          rules: input.rules,
        }),
      );
      await queryClient.invalidateQueries({
        queryKey: engagementDetailQueryKey(input.engagementId),
      });
      await queryClient.invalidateQueries({ queryKey: ENGAGEMENTS_QUERY_KEY });
    },
    onError: async (error, input) => {
      if (isRevisionConflict(error)) {
        await refreshAfterConflict(queryClient, input.engagementId);
      }
    },
  });
}

export function useCancelActionMutation() {
  const queryClient = useQueryClient();
  const keys = useRef(createIntentKeyHolder());

  return useMutation({
    mutationFn: (input: {
      engagementId: string;
      actionId: string;
      expectedRevision: number;
    }) => {
      const intent = requestFingerprint({
        engagementId: input.engagementId,
        actionId: input.actionId,
        expectedRevision: input.expectedRevision,
      });
      return cancelActionRequest(
        input.engagementId,
        input.actionId,
        { expectedRevision: input.expectedRevision },
        keys.current.keyFor(intent),
      );
    },
    onSuccess: (_action, input) => {
      keys.current.reset(
        requestFingerprint({
          engagementId: input.engagementId,
          actionId: input.actionId,
          expectedRevision: input.expectedRevision,
        }),
      );
    },
    onError: async (error, input) => {
      if (isRevisionConflict(error)) {
        await refreshAfterConflict(queryClient, input.engagementId);
      }
    },
  });
}
