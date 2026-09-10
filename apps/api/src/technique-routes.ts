import {
  CreateTechniqueRequestSchema,
  EngagementIdParamsSchema,
  TechniqueIdParamsSchema,
  TechniqueListResponseSchema,
  TechniqueMutationErrorSchema,
  TechniqueQueryErrorSchema,
  TechniqueResponseSchema,
} from "@blackglass/contracts";
import type { TechniqueRepository } from "@blackglass/db";
import type { FastifyInstance, FastifyReply } from "fastify";

type TechniquesRepository = Pick<
  TechniqueRepository,
  "createTechnique" | "listTechniques" | "getTechniqueForEngagement"
>;

function sendQueryError(
  reply: FastifyReply,
  status: 400 | 404 | 500 | 503,
  code: string,
) {
  return reply
    .code(status)
    .type("application/json")
    .send(TechniqueQueryErrorSchema.parse({ code }));
}

function sendMutationError(
  reply: FastifyReply,
  status: 400 | 404 | 409 | 500 | 503,
  code: string,
) {
  return reply
    .code(status)
    .type("application/json")
    .send(TechniqueMutationErrorSchema.parse({ code }));
}

export function registerTechniqueRoutes(
  app: FastifyInstance,
  repository: TechniquesRepository,
): void {
  app.get("/api/v1/engagements/:engagementId/techniques", async (request, reply) => {
    const params = EngagementIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendQueryError(reply, 400, "invalid_request");
    let result: ReturnType<TechniquesRepository["listTechniques"]>;
    try {
      result = repository.listTechniques(params.data.engagementId);
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
    const validated = TechniqueListResponseSchema.safeParse(result.value);
    if (!validated.success) return sendQueryError(reply, 500, "invalid_persisted_data");
    return reply.code(200).type("application/json").send(validated.data);
  });

  app.get(
    "/api/v1/engagements/:engagementId/techniques/:techniqueId",
    async (request, reply) => {
      const params = TechniqueIdParamsSchema.safeParse(request.params);
      if (!params.success) return sendQueryError(reply, 400, "invalid_request");
      let result: ReturnType<TechniquesRepository["getTechniqueForEngagement"]>;
      try {
        result = repository.getTechniqueForEngagement(
          params.data.engagementId,
          params.data.techniqueId,
        );
      } catch {
        return sendQueryError(reply, 500, "invalid_persisted_data");
      }
      if (!result.ok) {
        if (result.error.code === "engagement_not_found") {
          return sendQueryError(reply, 404, result.error.code);
        }
        if (result.error.code === "technique_not_found") {
          return sendQueryError(reply, 404, result.error.code);
        }
        if (result.error.code === "storage_busy") {
          return sendQueryError(reply, 503, result.error.code);
        }
        return sendQueryError(reply, 500, "invalid_persisted_data");
      }
      const validated = TechniqueResponseSchema.safeParse(result.value);
      if (!validated.success) return sendQueryError(reply, 500, "invalid_persisted_data");
      return reply.code(200).type("application/json").send(validated.data);
    },
  );

  app.post("/api/v1/engagements/:engagementId/techniques", async (request, reply) => {
    const params = EngagementIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendMutationError(reply, 400, "invalid_request");
    const body = CreateTechniqueRequestSchema.safeParse(request.body);
    if (!body.success) return sendMutationError(reply, 400, "invalid_request");
    let result: ReturnType<TechniquesRepository["createTechnique"]>;
    try {
      result = repository.createTechnique(params.data.engagementId, body.data);
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
    const validated = TechniqueResponseSchema.safeParse(result.value);
    if (!validated.success) return sendMutationError(reply, 500, "invalid_persisted_data");
    return reply.code(201).type("application/json").send(validated.data);
  });
}
