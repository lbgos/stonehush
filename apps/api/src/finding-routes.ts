import {
  CreateFindingRequestSchema,
  EngagementIdParamsSchema,
  FindingIdParamsSchema,
  FindingListResponseSchema,
  FindingMutationErrorSchema,
  FindingQueryErrorSchema,
  FindingResponseSchema,
  UpdateFindingRequestSchema,
} from "@stonehush/contracts";
import type { EngagementRepository } from "@stonehush/db";
import type { FastifyInstance, FastifyReply } from "fastify";

type FindingsRepository = Pick<
  EngagementRepository,
  "createFinding" | "listFindings" | "resolveFinding" | "reopenFinding" | "updateFinding"
>;

function sendQueryError(
  reply: FastifyReply,
  status: 400 | 404 | 500 | 503,
  code: string,
) {
  return reply
    .code(status)
    .type("application/json")
    .send(FindingQueryErrorSchema.parse({ code }));
}

function sendMutationError(
  reply: FastifyReply,
  status: 400 | 404 | 409 | 500 | 503,
  code: string,
) {
  return reply
    .code(status)
    .type("application/json")
    .send(FindingMutationErrorSchema.parse({ code }));
}

export function registerFindingRoutes(
  app: FastifyInstance,
  repository: FindingsRepository,
): void {
  app.get("/api/v1/engagements/:engagementId/findings", async (request, reply) => {
    const params = EngagementIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendQueryError(reply, 400, "invalid_request");
    let result: ReturnType<FindingsRepository["listFindings"]>;
    try {
      result = repository.listFindings(params.data.engagementId);
    } catch {
      return sendQueryError(reply, 500, "invalid_persisted_data");
    }
    if (!result.ok) {
      if (result.error.code === "engagement_not_found") {
        return sendQueryError(reply, 404, result.error.code);
      }
      if (result.error.code === "storage_busy") {
        return sendQueryError(reply, 503, result.error.code);
      }
      return sendQueryError(reply, 500, "invalid_persisted_data");
    }
    const validated = FindingListResponseSchema.safeParse(result.value);
    if (!validated.success) return sendQueryError(reply, 500, "invalid_persisted_data");
    return reply.code(200).type("application/json").send(validated.data);
  });

  app.post("/api/v1/engagements/:engagementId/findings", async (request, reply) => {
    const params = EngagementIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendMutationError(reply, 400, "invalid_request");
    const body = CreateFindingRequestSchema.safeParse(request.body);
    if (!body.success) return sendMutationError(reply, 400, "invalid_request");
    let result: ReturnType<FindingsRepository["createFinding"]>;
    try {
      result = repository.createFinding(params.data.engagementId, body.data);
    } catch {
      return sendMutationError(reply, 500, "invalid_persisted_data");
    }
    if (!result.ok) {
      if (result.error.code === "engagement_not_found") {
        return sendMutationError(reply, 404, result.error.code);
      }
      if (result.error.code === "engagement_archived") {
        return sendMutationError(reply, 409, result.error.code);
      }
      if (result.error.code === "storage_busy") {
        return sendMutationError(reply, 503, result.error.code);
      }
      if (result.error.code === "invalid_repository_input") {
        return sendMutationError(reply, 400, "invalid_request");
      }
      return sendMutationError(reply, 500, "invalid_persisted_data");
    }
    const validated = FindingResponseSchema.safeParse(result.value);
    if (!validated.success) return sendMutationError(reply, 500, "invalid_persisted_data");
    return reply.code(201).type("application/json").send(validated.data);
  });

  app.put("/api/v1/engagements/:engagementId/findings/:findingId", async (request, reply) => {
    const params = FindingIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendMutationError(reply, 400, "invalid_request");
    const body = UpdateFindingRequestSchema.safeParse(request.body);
    if (!body.success) return sendMutationError(reply, 400, "invalid_request");
    let result: ReturnType<FindingsRepository["updateFinding"]>;
    try {
      result = repository.updateFinding(params.data.engagementId, params.data.findingId, body.data);
    } catch {
      return sendMutationError(reply, 500, "invalid_persisted_data");
    }
    if (!result.ok) {
      if (
        result.error.code === "engagement_not_found" ||
        result.error.code === "finding_not_found"
      ) {
        return sendMutationError(reply, 404, result.error.code);
      }
      if (result.error.code === "engagement_archived") {
        return sendMutationError(reply, 409, result.error.code);
      }
      if (result.error.code === "revision_conflict") {
        const conflict = FindingMutationErrorSchema.safeParse({
          code: "revision_conflict",
          resourceType: "finding",
          resourceId: params.data.findingId,
          currentRevision: result.error.currentRevision,
        });
        if (!conflict.success) return sendMutationError(reply, 500, "invalid_persisted_data");
        return reply.code(409).type("application/json").send(conflict.data);
      }
      if (result.error.code === "storage_busy") {
        return sendMutationError(reply, 503, result.error.code);
      }
      if (result.error.code === "invalid_repository_input") {
        return sendMutationError(reply, 400, "invalid_request");
      }
      return sendMutationError(reply, 500, "invalid_persisted_data");
    }
    const validated = FindingResponseSchema.safeParse(result.value);
    if (!validated.success) return sendMutationError(reply, 500, "invalid_persisted_data");
    return reply.code(200).type("application/json").send(validated.data);
  });

  for (const operation of ["resolve", "reopen"] as const) {    app.post(
      `/api/v1/engagements/:engagementId/findings/:findingId/${operation}`,
      async (request, reply) => {
        const params = FindingIdParamsSchema.safeParse(request.params);
        if (!params.success) return sendMutationError(reply, 400, "invalid_request");
        const mutate =
          operation === "resolve"
            ? repository.resolveFinding.bind(repository)
            : repository.reopenFinding.bind(repository);
        let result: ReturnType<FindingsRepository["resolveFinding"]>;
        try {
          result = mutate(params.data.engagementId, params.data.findingId);
        } catch {
          return sendMutationError(reply, 500, "invalid_persisted_data");
        }
        if (!result.ok) {
          if (
            result.error.code === "engagement_not_found" ||
            result.error.code === "finding_not_found"
          ) {
            return sendMutationError(reply, 404, result.error.code);
          }
          if (
            result.error.code === "engagement_archived" ||
            result.error.code === "invalid_finding_transition"
          ) {
            return sendMutationError(reply, 409, result.error.code);
          }
          if (result.error.code === "storage_busy") {
            return sendMutationError(reply, 503, result.error.code);
          }
          return sendMutationError(reply, 500, "invalid_persisted_data");
        }
        const validated = FindingResponseSchema.safeParse(result.value);
        if (!validated.success) {
          return sendMutationError(reply, 500, "invalid_persisted_data");
        }
        return reply.code(200).type("application/json").send(validated.data);
      },
    );
  }
}
