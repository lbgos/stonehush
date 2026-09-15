import {
  AppendScopeRevisionRequestSchema,
  CreateEngagementRequestSchema,
  EngagementIdParamsSchema,
  EngagementMutationQuerySchema,
  EngagementMutationResponseSchema,
  EngagementRevisionRequestSchema,
  JsonValueSchema,
  ScopeRevisionMutationResponseSchema,
  UpdateAutoContinueWarningsRequestSchema,
  UpdateEngagementDeadlineRequestSchema,
  commandJsonV1AppendScopeRevisionDigest,
  commandJsonV1ArchiveEngagementDigest,
  commandJsonV1CreateEngagementDigest,
  commandJsonV1ReopenEngagementDigest,
  commandJsonV1UpdateAutoContinueWarningsDigest,
  commandJsonV1UpdateDeadlineDigest,
  type EngagementMutationError,
  type JsonValue,
} from "@stonehush/contracts";
import type {
  EngagementWriteTransaction,
  OperatorCommandRepository,
  RepositoryError,
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

interface ResponseSchema {
  safeParse(value: unknown):
    | { success: true; data: unknown }
    | { success: false };
}

class InvalidMutationResponseError extends Error {}

function mutationError(
  error: RepositoryError,
  engagementId?: string,
): { status: 400 | 404 | 409 | 500 | 503; body: EngagementMutationError } {
  switch (error.code) {
    case "invalid_repository_input":
      return { status: 400, body: { code: "invalid_request" } };
    case "engagement_not_found":
      return { status: 404, body: { code: error.code } };
    case "engagement_archived":
    case "invalid_engagement_transition":
      return { status: 409, body: { code: error.code } };
    case "revision_conflict":
      return {
        status: 409,
        body: {
          code: error.code,
          resourceType: "engagement",
          resourceId: engagementId ?? "",
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

function definitiveResponse<T>(
  result: RepositoryResult<T>,
  successStatus: 200 | 201,
  successSchema: ResponseSchema,
  engagementId?: string,
): { status: number; body: JsonValue } {
  if (result.ok) {
    const validated = successSchema.safeParse(result.value);
    if (!validated.success) throw new InvalidMutationResponseError();
    const body = JsonValueSchema.safeParse(validated.data);
    if (!body.success) throw new InvalidMutationResponseError();
    return { status: successStatus, body: body.data };
  }
  return mutationError(result.error, engagementId);
}

function invalidRequest(): { status: 400; body: { code: "invalid_request" } } {
  return { status: 400, body: { code: "invalid_request" } };
}

export function registerEngagementMutationRoutes(
  app: FastifyInstance,
  repository: CommandRepository,
): void {
  app.post("/api/v1/engagements", async (request, reply) => {
    return dispatchOperatorMutation(request, reply, repository, {
      route: "/api/v1/engagements",
      operation: "create",
      digest: commandJsonV1CreateEngagementDigest,
      mutate: (transaction: EngagementWriteTransaction) => {
        const body = CreateEngagementRequestSchema.safeParse(request.body);
        const query = EngagementMutationQuerySchema.safeParse(request.query);
        if (!body.success || !query.success) {
          return invalidRequest();
        }
        return definitiveResponse(
          transaction.createEngagement(body.data),
          201,
          EngagementMutationResponseSchema,
        );
      },
    });
  });

  for (const operation of ["archive", "reopen"] as const) {
    app.post(
      `/api/v1/engagements/:engagementId/${operation}`,
      async (request, reply) => {
        const engagementId = readPathParam(request.params, "engagementId");
        if (engagementId === undefined) {
          return sendFixedOperatorError(reply, 400, "invalid_request");
        }
        return dispatchOperatorMutation(request, reply, repository, {
          route: `/api/v1/engagements/${engagementId}/${operation}`,
          operation,
          digest:
            operation === "archive"
              ? commandJsonV1ArchiveEngagementDigest
              : commandJsonV1ReopenEngagementDigest,
          mutate: (transaction: EngagementWriteTransaction) => {
            const params = EngagementIdParamsSchema.safeParse(request.params);
            const body = EngagementRevisionRequestSchema.safeParse(
              request.body,
            );
            const query = EngagementMutationQuerySchema.safeParse(
              request.query,
            );
            if (!params.success || !body.success || !query.success) {
              return invalidRequest();
            }
            return definitiveResponse(
              transaction[operation](
                params.data.engagementId,
                body.data.expectedRevision,
              ),
              200,
              EngagementMutationResponseSchema,
              params.data.engagementId,
            );
          },
        });
      },
    );
  }

  app.patch(
    "/api/v1/engagements/:engagementId/auto-continue-warnings",
    async (request, reply) => {
      const engagementId = readPathParam(request.params, "engagementId");
      if (engagementId === undefined) {
        return sendFixedOperatorError(reply, 400, "invalid_request");
      }
      return dispatchOperatorMutation(request, reply, repository, {
        route: `/api/v1/engagements/${engagementId}/auto-continue-warnings`,
        operation: "update_auto_continue_warnings",
        digest: commandJsonV1UpdateAutoContinueWarningsDigest,
        mutate: (transaction: EngagementWriteTransaction) => {
          const params = EngagementIdParamsSchema.safeParse(request.params);
          const body = UpdateAutoContinueWarningsRequestSchema.safeParse(
            request.body,
          );
          const query = EngagementMutationQuerySchema.safeParse(request.query);
          if (!params.success || !body.success || !query.success) {
            return invalidRequest();
          }
          return definitiveResponse(
            transaction.updateAutoContinueWarnings(
              params.data.engagementId,
              body.data.expectedRevision,
              body.data.autoContinueWarnings,
            ),
            200,
            EngagementMutationResponseSchema,
            params.data.engagementId,
          );
        },
      });
    },
  );

  app.patch(
    "/api/v1/engagements/:engagementId/deadline",
    async (request, reply) => {
      const engagementId = readPathParam(request.params, "engagementId");
      if (engagementId === undefined) {
        return sendFixedOperatorError(reply, 400, "invalid_request");
      }
      return dispatchOperatorMutation(request, reply, repository, {
        route: `/api/v1/engagements/${engagementId}/deadline`,
        operation: "update_deadline",
        digest: commandJsonV1UpdateDeadlineDigest,
        mutate: (transaction: EngagementWriteTransaction) => {
          const params = EngagementIdParamsSchema.safeParse(request.params);
          const body = UpdateEngagementDeadlineRequestSchema.safeParse(
            request.body,
          );
          const query = EngagementMutationQuerySchema.safeParse(request.query);
          if (!params.success || !body.success || !query.success) {
            return invalidRequest();
          }
          return definitiveResponse(
            transaction.updateDeadline(
              params.data.engagementId,
              body.data.expectedRevision,
              body.data.deadlineAt,
            ),
            200,
            EngagementMutationResponseSchema,
            params.data.engagementId,
          );
        },
      });
    },
  );

  app.post(
    "/api/v1/engagements/:engagementId/scope-revisions",
    async (request, reply) => {
      const engagementId = readPathParam(request.params, "engagementId");
      if (engagementId === undefined) {
        return sendFixedOperatorError(reply, 400, "invalid_request");
      }
      return dispatchOperatorMutation(request, reply, repository, {
        route: `/api/v1/engagements/${engagementId}/scope-revisions`,
        operation: "append_scope_revision",
        digest: commandJsonV1AppendScopeRevisionDigest,
        mutate: (transaction: EngagementWriteTransaction) => {
          const params = EngagementIdParamsSchema.safeParse(request.params);
          const body = AppendScopeRevisionRequestSchema.safeParse(request.body);
          const query = EngagementMutationQuerySchema.safeParse(request.query);
          if (!params.success || !body.success || !query.success) {
            return invalidRequest();
          }
          return definitiveResponse(
            transaction.appendScopeRevision({
              engagementId: params.data.engagementId,
              ...body.data,
            }),
            201,
            ScopeRevisionMutationResponseSchema,
            params.data.engagementId,
          );
        },
      });
    },
  );
}
