import {
  ActionIdParamsSchema,
  ActionMutationQuerySchema,
  ActionResponseSchema,
  AddScopeAndRunActionRequestSchema,
  CancelActionRequestSchema,
  ContinueActionRequestSchema,
  ContinueLateWarningActionRequestSchema,
  CreateActionRequestSchema,
  EngagementIdParamsSchema,
  JsonValueSchema,
  commandJsonV1AddScopeAndRunActionDigest,
  commandJsonV1CancelActionDigest,
  commandJsonV1ContinueActionDigest,
  commandJsonV1ContinueLateWarningActionDigest,
  commandJsonV1CreateActionDigest,
  type ActionMutationError,
  type JsonValue,
} from "@stonehush/contracts";
import type {
  ActionRepositoryError,
  EngagementWriteTransaction,
  OperatorCommandRepository,
  RepositoryResult,
} from "@stonehush/db";
import type { FastifyInstance } from "fastify";

import {
  dispatchOperatorMutation,
  readPathParam,
  sendFixedOperatorError,
} from "./operator-command.js";

type CommandRepository = Pick<
  OperatorCommandRepository,
  "executeOperatorCommand"
>;

class InvalidMutationResponseError extends Error {}

function mutationError(
  error: ActionRepositoryError,
  defaults: { resourceType: "engagement" | "action"; resourceId: string },
): { status: 400 | 404 | 409 | 500 | 503; body: ActionMutationError } {
  switch (error.code) {
    case "invalid_repository_input":
      return { status: 400, body: { code: "invalid_request" } };
    case "engagement_not_found":
    case "action_not_found":
      return { status: 404, body: { code: error.code } };
    case "engagement_archived":
    case "invalid_action_transition":
    case "action_already_queued":
    case "capability_error_not_overridable":
    case "snapshot_binding_mismatch":
    case "invalid_run_transition":
    case "run_not_retryable":
    case "invalid_engagement_transition":
      return {
        status: 409,
        body: {
          code:
            error.code === "invalid_engagement_transition"
              ? "invalid_action_transition"
              : error.code,
        },
      };
    case "revision_conflict":
      return {
        status: 409,
        body: {
          code: error.code,
          resourceType: error.resourceType ?? defaults.resourceType,
          resourceId: error.resourceId ?? defaults.resourceId,
          currentRevision: error.currentRevision,
        },
      };
    case "storage_busy":
      return { status: 503, body: { code: error.code } };
    case "invalid_persisted_data":
    case "finding_not_found":
    case "invalid_finding_transition":
      return { status: 500, body: { code: "invalid_persisted_data" } };
  }
}

function definitiveResponse(
  result: RepositoryResult<unknown, ActionRepositoryError>,
  successStatus: 200 | 201,
  defaults: { resourceType: "engagement" | "action"; resourceId: string },
): { status: number; body: JsonValue } {
  if (result.ok) {
    const validated = ActionResponseSchema.safeParse(result.value);
    if (!validated.success) throw new InvalidMutationResponseError();
    const body = JsonValueSchema.safeParse(validated.data);
    if (!body.success) throw new InvalidMutationResponseError();
    return { status: successStatus, body: body.data };
  }
  return mutationError(result.error, defaults);
}

function invalidRequest(): { status: 400; body: { code: "invalid_request" } } {
  return { status: 400, body: { code: "invalid_request" } };
}

export function registerActionMutationRoutes(
  app: FastifyInstance,
  repository: CommandRepository,
): void {
  app.post(
    "/api/v1/engagements/:engagementId/actions",
    async (request, reply) => {
      const engagementId = readPathParam(request.params, "engagementId");
      if (engagementId === undefined) {
        return sendFixedOperatorError(reply, 400, "invalid_request");
      }
      return dispatchOperatorMutation(request, reply, repository, {
        route: `/api/v1/engagements/${engagementId}/actions`,
        operation: "create",
        digest: commandJsonV1CreateActionDigest,
        mutate: (transaction: EngagementWriteTransaction) => {
          const params = EngagementIdParamsSchema.safeParse(request.params);
          const body = CreateActionRequestSchema.safeParse(request.body);
          const query = ActionMutationQuerySchema.safeParse(request.query);
          if (!params.success || !body.success || !query.success) {
            return invalidRequest();
          }
          return definitiveResponse(
            transaction.planOperatorAction(params.data.engagementId, body.data),
            201,
            {
              resourceType: "engagement",
              resourceId: params.data.engagementId,
            },
          );
        },
      });
    },
  );

  app.post(
    "/api/v1/engagements/:engagementId/actions/:actionId/continue",
    async (request, reply) => {
      const engagementId = readPathParam(request.params, "engagementId");
      const actionId = readPathParam(request.params, "actionId");
      if (engagementId === undefined || actionId === undefined) {
        return sendFixedOperatorError(reply, 400, "invalid_request");
      }
      return dispatchOperatorMutation(request, reply, repository, {
        route: `/api/v1/engagements/${engagementId}/actions/${actionId}/continue`,
        operation: "continue",
        digest: commandJsonV1ContinueActionDigest,
        mutate: (transaction: EngagementWriteTransaction) => {
          const params = ActionIdParamsSchema.safeParse(request.params);
          const body = ContinueActionRequestSchema.safeParse(request.body);
          const query = ActionMutationQuerySchema.safeParse(request.query);
          if (!params.success || !body.success || !query.success) {
            return invalidRequest();
          }
          return definitiveResponse(
            transaction.continueAction({
              engagementId: params.data.engagementId,
              actionId: params.data.actionId,
              expectedRevision: body.data.expectedRevision,
              snapshotVersion: body.data.snapshotVersion,
              snapshotBinding: body.data.snapshotBinding,
              occurredAt: transaction.now().toISOString(),
            }),
            200,
            { resourceType: "action", resourceId: params.data.actionId },
          );
        },
      });
    },
  );

  app.post(
    "/api/v1/engagements/:engagementId/actions/:actionId/continue-late-warning",
    async (request, reply) => {
      const engagementId = readPathParam(request.params, "engagementId");
      const actionId = readPathParam(request.params, "actionId");
      if (engagementId === undefined || actionId === undefined) {
        return sendFixedOperatorError(reply, 400, "invalid_request");
      }
      return dispatchOperatorMutation(request, reply, repository, {
        route: `/api/v1/engagements/${engagementId}/actions/${actionId}/continue-late-warning`,
        operation: "continue_late_warning",
        digest: commandJsonV1ContinueLateWarningActionDigest,
        mutate: (transaction: EngagementWriteTransaction) => {
          const params = ActionIdParamsSchema.safeParse(request.params);
          const body = ContinueLateWarningActionRequestSchema.safeParse(request.body);
          const query = ActionMutationQuerySchema.safeParse(request.query);
          if (!params.success || !body.success || !query.success) {
            return invalidRequest();
          }
          return definitiveResponse(
            transaction.continueLateWarning({
              engagementId: params.data.engagementId,
              actionId: params.data.actionId,
              expectedRevision: body.data.expectedRevision,
              snapshotVersion: body.data.snapshotVersion,
              snapshotBinding: body.data.snapshotBinding,
              pendingEventId: body.data.pendingEventId,
              occurredAt: transaction.now().toISOString(),
            }),
            200,
            { resourceType: "action", resourceId: params.data.actionId },
          );
        },
      });
    },
  );

  app.post(
    "/api/v1/engagements/:engagementId/actions/:actionId/add-scope-and-run",
    async (request, reply) => {
      const engagementId = readPathParam(request.params, "engagementId");
      const actionId = readPathParam(request.params, "actionId");
      if (engagementId === undefined || actionId === undefined) {
        return sendFixedOperatorError(reply, 400, "invalid_request");
      }
      return dispatchOperatorMutation(request, reply, repository, {
        route: `/api/v1/engagements/${engagementId}/actions/${actionId}/add-scope-and-run`,
        operation: "add_scope_and_run",
        digest: commandJsonV1AddScopeAndRunActionDigest,
        mutate: (transaction: EngagementWriteTransaction) => {
          const params = ActionIdParamsSchema.safeParse(request.params);
          const body = AddScopeAndRunActionRequestSchema.safeParse(
            request.body,
          );
          const query = ActionMutationQuerySchema.safeParse(request.query);
          if (!params.success || !body.success || !query.success) {
            return invalidRequest();
          }
          return definitiveResponse(
            transaction.addScopeAndRunOperatorAction(
              params.data.engagementId,
              params.data.actionId,
              body.data,
            ),
            200,
            { resourceType: "action", resourceId: params.data.actionId },
          );
        },
      });
    },
  );

  app.post(
    "/api/v1/engagements/:engagementId/actions/:actionId/cancel",
    async (request, reply) => {
      const engagementId = readPathParam(request.params, "engagementId");
      const actionId = readPathParam(request.params, "actionId");
      if (engagementId === undefined || actionId === undefined) {
        return sendFixedOperatorError(reply, 400, "invalid_request");
      }
      return dispatchOperatorMutation(request, reply, repository, {
        route: `/api/v1/engagements/${engagementId}/actions/${actionId}/cancel`,
        operation: "cancel",
        digest: commandJsonV1CancelActionDigest,
        mutate: (transaction: EngagementWriteTransaction) => {
          const params = ActionIdParamsSchema.safeParse(request.params);
          const body = CancelActionRequestSchema.safeParse(request.body);
          const query = ActionMutationQuerySchema.safeParse(request.query);
          if (!params.success || !body.success || !query.success) {
            return invalidRequest();
          }
          return definitiveResponse(
            transaction.cancelAction({
              engagementId: params.data.engagementId,
              actionId: params.data.actionId,
              expectedRevision: body.data.expectedRevision,
            }),
            200,
            { resourceType: "action", resourceId: params.data.actionId },
          );
        },
      });
    },
  );
}
