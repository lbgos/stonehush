import {
  EngagementDetailResponseSchema,
  EngagementIdParamsSchema,
  EngagementListResponseSchema,
  EngagementQueryErrorSchema,
  ScopeRevisionListResponseSchema,
  type EngagementQueryError,
} from "@stonehush/contracts";
import type {
  EngagementRepository,
  RepositoryError,
  RepositoryResult,
} from "@stonehush/db";
import type { FastifyInstance, FastifyReply } from "fastify";

type EngagementQueries = Pick<
  EngagementRepository,
  "getEngagement" | "listEngagements" | "listScopeRevisions"
>;

function sendError(
  reply: FastifyReply,
  status: 400 | 404 | 500 | 503,
  code: EngagementQueryError["code"],
) {
  return reply
    .code(status)
    .type("application/json")
    .send(EngagementQueryErrorSchema.parse({ code }));
}

function sendRepositoryError(reply: FastifyReply, error: RepositoryError) {
  switch (error.code) {
    case "engagement_not_found":
      return sendError(reply, 404, error.code);
    case "storage_busy":
      return sendError(reply, 503, error.code);
    case "invalid_persisted_data":
      return sendError(reply, 500, error.code);
    default:
      return sendError(reply, 500, "invalid_persisted_data");
  }
}

function parseEngagementId(requestParams: unknown) {
  return EngagementIdParamsSchema.safeParse(requestParams);
}

function queryRepository<T>(
  operation: () => RepositoryResult<T>,
): RepositoryResult<T> {
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

export function registerEngagementRoutes(
  app: FastifyInstance,
  repository: EngagementQueries,
): void {
  app.get("/api/v1/engagements", async (_request, reply) => {
    const result = queryRepository(() => repository.listEngagements());
    if (!result.ok) return sendRepositoryError(reply, result.error);
    return sendValidated(reply, EngagementListResponseSchema, result.value);
  });

  app.get("/api/v1/engagements/:engagementId", async (request, reply) => {
    const params = parseEngagementId(request.params);
    if (!params.success) return sendError(reply, 400, "invalid_request");
    const result = queryRepository(() =>
      repository.getEngagement(params.data.engagementId),
    );
    if (!result.ok) return sendRepositoryError(reply, result.error);
    return sendValidated(reply, EngagementDetailResponseSchema, result.value);
  });

  app.get(
    "/api/v1/engagements/:engagementId/scope-revisions",
    async (request, reply) => {
      const params = parseEngagementId(request.params);
      if (!params.success) return sendError(reply, 400, "invalid_request");
      const result = queryRepository(() =>
        repository.listScopeRevisions(params.data.engagementId),
      );
      if (!result.ok) return sendRepositoryError(reply, result.error);
      return sendValidated(reply, ScopeRevisionListResponseSchema, result.value);
    },
  );
}
