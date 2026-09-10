import {
  CreateSecretRequestSchema,
  EngagementIdParamsSchema,
  RecordSecretVerificationRequestSchema,
  SecretIdParamsSchema,
  SecretListResponseSchema,
  SecretMutationErrorSchema,
  SecretQueryErrorSchema,
  SecretResponseSchema,
} from "@blackglass/contracts";
import type { SecretRepository } from "@blackglass/db";
import type { FastifyInstance, FastifyReply } from "fastify";

type SecretRoutesRepository = Pick<
  SecretRepository,
  "createSecret" | "listSecrets" | "getSecret" | "recordVerification"
>;

function sendQueryError(
  reply: FastifyReply,
  status: 400 | 404 | 500 | 503,
  code: string,
) {
  return reply
    .code(status)
    .type("application/json")
    .send(SecretQueryErrorSchema.parse({ code }));
}

function sendMutationError(
  reply: FastifyReply,
  status: 400 | 404 | 409 | 500 | 503,
  code: string,
) {
  return reply
    .code(status)
    .type("application/json")
    .send(SecretMutationErrorSchema.parse({ code }));
}

function mutationStatus(code: string): 400 | 404 | 409 | 500 | 503 {
  if (code === "engagement_not_found" || code === "secret_not_found") return 404;
  if (code === "engagement_archived") return 409;
  if (code === "storage_busy") return 503;
  if (code === "invalid_repository_input") return 400;
  return 500;
}

// Secret routes carry references only, never plaintext values. The contract
// has no value field, so nothing here can leak one; verification history
// records outcomes and methods, never values.
export function registerSecretRoutes(
  app: FastifyInstance,
  repository: SecretRoutesRepository,
): void {
  app.get("/api/v1/engagements/:engagementId/secrets", async (request, reply) => {
    const params = EngagementIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendQueryError(reply, 400, "invalid_request");
    let result: ReturnType<SecretRoutesRepository["listSecrets"]>;
    try {
      result = repository.listSecrets(params.data.engagementId);
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
    const validated = SecretListResponseSchema.safeParse(result.value);
    if (!validated.success) return sendQueryError(reply, 500, "invalid_persisted_data");
    return reply.code(200).type("application/json").send(validated.data);
  });

  app.post("/api/v1/engagements/:engagementId/secrets", async (request, reply) => {
    const params = EngagementIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendMutationError(reply, 400, "invalid_request");
    const body = CreateSecretRequestSchema.safeParse(request.body);
    if (!body.success) return sendMutationError(reply, 400, "invalid_request");
    let result: ReturnType<SecretRoutesRepository["createSecret"]>;
    try {
      result = repository.createSecret(params.data.engagementId, body.data);
    } catch {
      return sendMutationError(reply, 500, "invalid_persisted_data");
    }
    if (!result.ok) {
      return sendMutationError(reply, mutationStatus(result.error.code), result.error.code);
    }
    const validated = SecretResponseSchema.safeParse(result.value);
    if (!validated.success) return sendMutationError(reply, 500, "invalid_persisted_data");
    return reply.code(201).type("application/json").send(validated.data);
  });

  app.get("/api/v1/engagements/:engagementId/secrets/:secretId", async (request, reply) => {
    const params = SecretIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendQueryError(reply, 400, "invalid_request");
    let result: ReturnType<SecretRoutesRepository["getSecret"]>;
    try {
      result = repository.getSecret(params.data.engagementId, params.data.secretId);
    } catch {
      return sendQueryError(reply, 500, "invalid_persisted_data");
    }
    if (!result.ok) {
      if (
        result.error.code === "engagement_not_found" ||
        result.error.code === "secret_not_found"
      ) {
        return sendQueryError(reply, 404, result.error.code);
      }
      if (result.error.code === "storage_busy") {
        return sendQueryError(reply, 503, result.error.code);
      }
      return sendQueryError(reply, 500, "invalid_persisted_data");
    }
    const validated = SecretResponseSchema.safeParse(result.value);
    if (!validated.success) return sendQueryError(reply, 500, "invalid_persisted_data");
    return reply.code(200).type("application/json").send(validated.data);
  });

  app.post(
    "/api/v1/engagements/:engagementId/secrets/:secretId/verifications",
    async (request, reply) => {
      const params = SecretIdParamsSchema.safeParse(request.params);
      if (!params.success) return sendMutationError(reply, 400, "invalid_request");
      const body = RecordSecretVerificationRequestSchema.safeParse(request.body);
      if (!body.success) return sendMutationError(reply, 400, "invalid_request");
      let result: ReturnType<SecretRoutesRepository["recordVerification"]>;
      try {
        result = repository.recordVerification(
          params.data.engagementId,
          params.data.secretId,
          body.data,
        );
      } catch {
        return sendMutationError(reply, 500, "invalid_persisted_data");
      }
      if (!result.ok) {
        return sendMutationError(reply, mutationStatus(result.error.code), result.error.code);
      }
      const validated = SecretResponseSchema.safeParse(result.value);
      if (!validated.success) return sendMutationError(reply, 500, "invalid_persisted_data");
      return reply.code(201).type("application/json").send(validated.data);
    },
  );
}
