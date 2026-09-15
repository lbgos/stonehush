import {
  ActionIdParamsSchema,
  ActionQueryErrorSchema,
  ActionResponseSchema,
  ActionRetryContextResponseSchema,
  type ActionQueryError,
} from "@stonehush/contracts";
import type {
  ActionRepositoryError,
  EngagementRepository,
  RepositoryResult,
} from "@stonehush/db";
import type { FastifyInstance, FastifyReply } from "fastify";

type ActionQueries = Pick<
  EngagementRepository,
  "getAction" | "retryActionContext"
>;

function sendError(
  reply: FastifyReply,
  status: 400 | 404 | 409 | 500 | 503,
  code: ActionQueryError["code"],
) {
  return reply
    .code(status)
    .type("application/json")
    .send(ActionQueryErrorSchema.parse({ code }));
}

function sendRepositoryError(reply: FastifyReply, error: ActionRepositoryError) {
  switch (error.code) {
    case "engagement_not_found":
    case "action_not_found":
      return sendError(reply, 404, error.code);
    case "invalid_action_transition":
    case "run_not_retryable":
      return sendError(reply, 409, error.code);
    case "storage_busy":
      return sendError(reply, 503, error.code);
    case "invalid_persisted_data":
      return sendError(reply, 500, error.code);
    default:
      return sendError(reply, 500, "invalid_persisted_data");
  }
}

function queryRepository<T>(
  operation: () => RepositoryResult<T, ActionRepositoryError>,
): RepositoryResult<T, ActionRepositoryError> {
  try {
    return operation();
  } catch {
    return { ok: false, error: { code: "invalid_persisted_data" } };
  }
}

interface ResponseSchema {
  safeParse(value: unknown):
    | { success: true; data: unknown }
    | { success: false };
}

function sendValidated(
  reply: FastifyReply,
  schema: ResponseSchema,
  value: unknown,
) {
  const parsed = schema.safeParse(value);
  return parsed.success
    ? reply.code(200).type("application/json").send(parsed.data)
    : sendError(reply, 500, "invalid_persisted_data");
}

export function registerActionRoutes(
  app: FastifyInstance,
  repository: ActionQueries,
): void {
  app.get(
    "/api/v1/engagements/:engagementId/actions/:actionId",
    async (request, reply) => {
      const params = ActionIdParamsSchema.safeParse(request.params);
      if (!params.success) return sendError(reply, 400, "invalid_request");
      const result = queryRepository(() =>
        repository.getAction(params.data.engagementId, params.data.actionId),
      );
      if (!result.ok) return sendRepositoryError(reply, result.error);
      return sendValidated(reply, ActionResponseSchema, result.value);
    },
  );

  app.get(
    "/api/v1/engagements/:engagementId/actions/:actionId/retry-context",
    async (request, reply) => {
      const params = ActionIdParamsSchema.safeParse(request.params);
      if (!params.success) return sendError(reply, 400, "invalid_request");
      const result = queryRepository(() =>
        repository.retryActionContext(
          params.data.engagementId,
          params.data.actionId,
        ),
      );
      if (!result.ok) return sendRepositoryError(reply, result.error);
      return sendValidated(reply, ActionRetryContextResponseSchema, result.value);
    },
  );
}
