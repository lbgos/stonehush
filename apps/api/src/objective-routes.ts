import {
  CaptureObjectiveRequestSchema,
  CreateObjectiveRequestSchema,
  EngagementIdParamsSchema,
  ObjectiveIdParamsSchema,
  ObjectiveListResponseSchema,
  ObjectiveMutationErrorSchema,
  ObjectiveQueryErrorSchema,
  ObjectiveResponseSchema,
  SubmitObjectiveRequestSchema,
} from "@blackglass/contracts";
import type { ObjectiveRepository } from "@blackglass/db";
import type { FastifyInstance, FastifyReply } from "fastify";

type ObjectiveRoutesRepository = Pick<
  ObjectiveRepository,
  | "createObjective"
  | "listObjectives"
  | "getObjective"
  | "captureObjective"
  | "submitObjective"
  | "reopenObjective"
>;

function sendQueryError(
  reply: FastifyReply,
  status: 400 | 404 | 500 | 503,
  code: string,
) {
  return reply
    .code(status)
    .type("application/json")
    .send(ObjectiveQueryErrorSchema.parse({ code }));
}

function sendMutationError(
  reply: FastifyReply,
  status: 400 | 404 | 409 | 500 | 503,
  code: string,
) {
  return reply
    .code(status)
    .type("application/json")
    .send(ObjectiveMutationErrorSchema.parse({ code }));
}

function mutationStatus(code: string): 400 | 404 | 409 | 500 | 503 {
  if (code === "engagement_not_found" || code === "objective_not_found") return 404;
  if (code === "engagement_archived" || code === "invalid_objective_transition") return 409;
  if (code === "storage_busy") return 503;
  if (code === "invalid_repository_input") return 400;
  return 500;
}

export function registerObjectiveRoutes(
  app: FastifyInstance,
  repository: ObjectiveRoutesRepository,
): void {
  app.get("/api/v1/engagements/:engagementId/objectives", async (request, reply) => {
    const params = EngagementIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendQueryError(reply, 400, "invalid_request");
    let result: ReturnType<ObjectiveRoutesRepository["listObjectives"]>;
    try {
      result = repository.listObjectives(params.data.engagementId);
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
    const validated = ObjectiveListResponseSchema.safeParse(result.value);
    if (!validated.success) return sendQueryError(reply, 500, "invalid_persisted_data");
    return reply.code(200).type("application/json").send(validated.data);
  });

  app.post("/api/v1/engagements/:engagementId/objectives", async (request, reply) => {
    const params = EngagementIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendMutationError(reply, 400, "invalid_request");
    const body = CreateObjectiveRequestSchema.safeParse(request.body);
    if (!body.success) return sendMutationError(reply, 400, "invalid_request");
    let result: ReturnType<ObjectiveRoutesRepository["createObjective"]>;
    try {
      result = repository.createObjective(params.data.engagementId, body.data);
    } catch {
      return sendMutationError(reply, 500, "invalid_persisted_data");
    }
    if (!result.ok) {
      return sendMutationError(reply, mutationStatus(result.error.code), result.error.code);
    }
    const validated = ObjectiveResponseSchema.safeParse(result.value);
    if (!validated.success) return sendMutationError(reply, 500, "invalid_persisted_data");
    return reply.code(201).type("application/json").send(validated.data);
  });

  app.get("/api/v1/engagements/:engagementId/objectives/:objectiveId", async (request, reply) => {
    const params = ObjectiveIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendQueryError(reply, 400, "invalid_request");
    let result: ReturnType<ObjectiveRoutesRepository["getObjective"]>;
    try {
      result = repository.getObjective(params.data.engagementId, params.data.objectiveId);
    } catch {
      return sendQueryError(reply, 500, "invalid_persisted_data");
    }
    if (!result.ok) {
      if (
        result.error.code === "engagement_not_found" ||
        result.error.code === "objective_not_found"
      ) {
        return sendQueryError(reply, 404, result.error.code);
      }
      if (result.error.code === "storage_busy") {
        return sendQueryError(reply, 503, result.error.code);
      }
      return sendQueryError(reply, 500, "invalid_persisted_data");
    }
    const validated = ObjectiveResponseSchema.safeParse(result.value);
    if (!validated.success) return sendQueryError(reply, 500, "invalid_persisted_data");
    return reply.code(200).type("application/json").send(validated.data);
  });

  // Capture accepts the raw proof value once, hashes it, and never echoes it.
  // Responses carry only the digest and a short masked hint.
  app.post(
    "/api/v1/engagements/:engagementId/objectives/:objectiveId/capture",
    async (request, reply) => {
      const params = ObjectiveIdParamsSchema.safeParse(request.params);
      if (!params.success) return sendMutationError(reply, 400, "invalid_request");
      const body = CaptureObjectiveRequestSchema.safeParse(request.body);
      if (!body.success) return sendMutationError(reply, 400, "invalid_request");
      let result: ReturnType<ObjectiveRoutesRepository["captureObjective"]>;
      try {
        result = repository.captureObjective(
          params.data.engagementId,
          params.data.objectiveId,
          body.data,
        );
      } catch {
        return sendMutationError(reply, 500, "invalid_persisted_data");
      }
      if (!result.ok) {
        return sendMutationError(reply, mutationStatus(result.error.code), result.error.code);
      }
      const validated = ObjectiveResponseSchema.safeParse(result.value);
      if (!validated.success) return sendMutationError(reply, 500, "invalid_persisted_data");
      return reply.code(200).type("application/json").send(validated.data);
    },
  );

  for (const operation of ["submit", "reopen"] as const) {
    app.post(
      `/api/v1/engagements/:engagementId/objectives/:objectiveId/${operation}`,
      async (request, reply) => {
        const params = ObjectiveIdParamsSchema.safeParse(request.params);
        if (!params.success) return sendMutationError(reply, 400, "invalid_request");
        if (operation === "submit") {
          const body = SubmitObjectiveRequestSchema.safeParse(request.body ?? {});
          if (!body.success) return sendMutationError(reply, 400, "invalid_request");
        }
        const mutate =
          operation === "submit"
            ? repository.submitObjective.bind(repository)
            : repository.reopenObjective.bind(repository);
        let result: ReturnType<ObjectiveRoutesRepository["submitObjective"]>;
        try {
          result = mutate(params.data.engagementId, params.data.objectiveId);
        } catch {
          return sendMutationError(reply, 500, "invalid_persisted_data");
        }
        if (!result.ok) {
          return sendMutationError(reply, mutationStatus(result.error.code), result.error.code);
        }
        const validated = ObjectiveResponseSchema.safeParse(result.value);
        if (!validated.success) {
          return sendMutationError(reply, 500, "invalid_persisted_data");
        }
        return reply.code(200).type("application/json").send(validated.data);
      },
    );
  }
}
