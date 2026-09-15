import {
  ConfirmEnrollmentRequestSchema,
  ConfirmEnrollmentResponseSchema,
  EnrollmentChallengeIdParamsSchema,
  EnrollmentChallengeSchema,
  JsonValueSchema,
  RevokeRunnerRequestSchema,
  RevokeRunnerResponseSchema,
  RunnerIdParamsSchema,
  RunnerMutationQuerySchema,
  StartEnrollmentChallengeRequestSchema,
  commandJsonV1ConfirmEnrollmentDigest,
  commandJsonV1RevokeRunnerDigest,
  commandJsonV1StartEnrollmentChallengeDigest,
  type JsonValue,
} from "@stonehush/contracts";
import type {
  EngagementWriteTransaction,
  OperatorCommandRepository,
  RunnerRepository,
} from "@stonehush/db";
import type { FastifyInstance } from "fastify";

import {
  dispatchOperatorMutation,
  executeOperatorMutation,
  readIdempotencyKey,
  readPathParam,
  sendFixedOperatorError,
  sendOperatorCommandResult,
} from "./operator-command.js";
import { mapRunnerRepositoryError } from "./runner-http.js";

type CommandRepository = Pick<
  OperatorCommandRepository,
  "executeOperatorCommand"
>;

class InvalidMutationResponseError extends Error {}

function jsonBody(value: unknown): JsonValue {
  const parsed = JsonValueSchema.safeParse(value);
  if (!parsed.success) throw new InvalidMutationResponseError();
  return parsed.data;
}

export function registerRunnerEnrollmentRoutes(
  app: FastifyInstance,
  commandRepository: CommandRepository,
  runnerRepository: Pick<
    RunnerRepository,
    "startEnrollmentChallenge" | "confirmEnrollment" | "revoke"
  >,
): void {
  app.post("/api/v1/runners/enrollment-challenges", async (request, reply) => {
    return dispatchOperatorMutation(request, reply, commandRepository, {
      route: "/api/v1/runners/enrollment-challenges",
      operation: "start_enrollment_challenge",
      digest: commandJsonV1StartEnrollmentChallengeDigest,
      mutate: (transaction: EngagementWriteTransaction) => {
        const body = StartEnrollmentChallengeRequestSchema.safeParse(request.body);
        const query = RunnerMutationQuerySchema.safeParse(request.query);
        if (!body.success || !query.success) {
          return { status: 400, body: { code: "invalid_request" } };
        }
        const result = runnerRepository.startEnrollmentChallenge(
          body.data,
          transaction.client,
        );
        if (!result.ok) return mapRunnerRepositoryError(result.error);
        const validated = EnrollmentChallengeSchema.safeParse(result.value);
        if (!validated.success) throw new InvalidMutationResponseError();
        return { status: 201, body: jsonBody(validated.data) };
      },
    });
  });

  app.post(
    "/api/v1/runners/enrollment-challenges/:challengeId/confirm",
    async (request, reply) => {
      const challengeId = readPathParam(request.params, "challengeId");
      if (challengeId === undefined) {
        return sendFixedOperatorError(reply, 400, "invalid_request");
      }
      const key = readIdempotencyKey(request);
      if (key === undefined) {
        return sendFixedOperatorError(reply, 400, "invalid_request");
      }
      let presentedSecret: string | undefined;
      const result = executeOperatorMutation(
        commandRepository,
        {
          key,
          route: `/api/v1/runners/enrollment-challenges/${challengeId}/confirm`,
          operation: "confirm_enrollment",
          path: request.params,
          query: request.query,
          body: request.body,
          digest: commandJsonV1ConfirmEnrollmentDigest,
        },
        (transaction: EngagementWriteTransaction) => {
          const params = EnrollmentChallengeIdParamsSchema.safeParse(request.params);
          const body = ConfirmEnrollmentRequestSchema.safeParse(request.body);
          const query = RunnerMutationQuerySchema.safeParse(request.query);
          if (!params.success || !body.success || !query.success) {
            return { status: 400, body: { code: "invalid_request" } };
          }
          const confirmed = runnerRepository.confirmEnrollment(
            params.data.challengeId,
            body.data,
            transaction.client,
          );
          if (!confirmed.ok) return mapRunnerRepositoryError(confirmed.error);
          presentedSecret = confirmed.value.secret;
          const validated = ConfirmEnrollmentResponseSchema.safeParse({
            runner: confirmed.value.runner,
            encoding: "base64url",
            credentialBytes: 32,
          });
          if (!validated.success) throw new InvalidMutationResponseError();
          return { status: 201, body: jsonBody(validated.data) };
        },
      );
      if (
        result.ok &&
        result.disposition === "applied" &&
        presentedSecret !== undefined
      ) {
        const stored = ConfirmEnrollmentResponseSchema.safeParse(
          JSON.parse(result.response.bodyJson),
        );
        if (!stored.success) {
          return sendFixedOperatorError(reply, 500, "invalid_persisted_data");
        }
        return reply
          .code(201)
          .type("application/json")
          .send({ ...stored.data, secret: presentedSecret });
      }
      return sendOperatorCommandResult(reply, result);
    },
  );

  app.post("/api/v1/runners/:runnerId/revoke", async (request, reply) => {
    const runnerId = readPathParam(request.params, "runnerId");
    if (runnerId === undefined) {
      return sendFixedOperatorError(reply, 400, "invalid_request");
    }
    return dispatchOperatorMutation(request, reply, commandRepository, {
      route: `/api/v1/runners/${runnerId}/revoke`,
      operation: "revoke",
      digest: commandJsonV1RevokeRunnerDigest,
      mutate: (transaction: EngagementWriteTransaction) => {
        const params = RunnerIdParamsSchema.safeParse(request.params);
        const body = RevokeRunnerRequestSchema.safeParse(request.body);
        const query = RunnerMutationQuerySchema.safeParse(request.query);
        if (!params.success || !body.success || !query.success) {
          return { status: 400, body: { code: "invalid_request" } };
        }
        const revoked = runnerRepository.revoke(
          params.data.runnerId,
          body.data,
          transaction.client,
        );
        if (!revoked.ok) return mapRunnerRepositoryError(revoked.error);
        const validated = RevokeRunnerResponseSchema.safeParse(revoked.value);
        if (!validated.success) throw new InvalidMutationResponseError();
        return { status: 200, body: jsonBody(validated.data) };
      },
    });
  });
}
