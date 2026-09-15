import {
  ActionMutationQuerySchema,
  ActionResponseSchema,
  EngagementFfufResultsParamsSchema,
  EngagementFfufResultsResponseSchema,
  EngagementIdParamsSchema,
  FfufDiscoveryLaunchRequestSchema,
  JsonValueSchema,
  commandJsonV1CreateFfufDiscoveryDigest,
  type ActionMutationError,
  type JsonValue,
} from "@stonehush/contracts";
import type {
  ActionRepositoryError,
  EngagementWriteTransaction,
  FfufRepository,
  OperatorCommandRepository,
} from "@stonehush/db";
import type { FastifyInstance, FastifyReply } from "fastify";

import {
  dispatchOperatorMutation,
  readPathParam,
  sendFixedOperatorError,
} from "./operator-command.js";

type CommandRepository = Pick<
  OperatorCommandRepository,
  "executeOperatorCommand"
>;

type FfufResultsQueries = Pick<FfufRepository, "listForEngagement">;

function mutationError(
  error: ActionRepositoryError,
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
          resourceType: error.resourceType ?? "engagement",
          resourceId: error.resourceId ?? "",
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

class InvalidMutationResponseError extends Error {}

function sendError(reply: FastifyReply, status: number, code: string) {
  return reply.code(status).type("application/json").send({ code });
}

export function registerFfufRoutes(
  app: FastifyInstance,
  deps: { commands?: CommandRepository; results: FfufResultsQueries },
): void {
  if (deps.commands !== undefined) {
    const commands = deps.commands;
    app.post(
      "/api/v1/engagements/:engagementId/ffuf-discoveries",
      async (request, reply) => {
      const engagementId = readPathParam(request.params, "engagementId");
      if (engagementId === undefined) {
        return sendFixedOperatorError(reply, 400, "invalid_request");
      }
      return dispatchOperatorMutation(request, reply, commands, {
        route: `/api/v1/engagements/${engagementId}/ffuf-discoveries`,
        operation: "create",
        digest: commandJsonV1CreateFfufDiscoveryDigest,
        mutate: (transaction: EngagementWriteTransaction) => {
          const params = EngagementIdParamsSchema.safeParse(request.params);
          // Partial launch: absent numerics and an absent or empty wordlist
          // fall back to stored runner defaults inside the plan transaction.
          const body = FfufDiscoveryLaunchRequestSchema.safeParse(request.body);
          const query = ActionMutationQuerySchema.safeParse(request.query);
          if (!params.success || !query.success) {
            return { status: 400, body: { code: "invalid_request" } };
          }
          if (!body.success) {
            return { status: 400, body: { code: "invalid_ffuf_action_contract" } };
          }
          const planned = transaction.planFfufDiscoveryAction(params.data.engagementId, body.data);
          if (!planned.ok) return mutationError(planned.error);
          const validated = ActionResponseSchema.safeParse(planned.value);
          if (!validated.success) throw new InvalidMutationResponseError();
          const json = JsonValueSchema.safeParse(validated.data);
          if (!json.success) throw new InvalidMutationResponseError();
          return { status: 201, body: json.data as JsonValue };
        },
      });
      },
    );
  }

  app.get("/api/v1/engagements/:engagementId/ffuf-results", async (request, reply) => {
    const parsed = EngagementFfufResultsParamsSchema.safeParse(request.params);
    if (!parsed.success) return sendError(reply, 400, "invalid_request");
    const { engagementId } = parsed.data;
    let result: ReturnType<FfufResultsQueries["listForEngagement"]>;
    try {
      result = deps.results.listForEngagement(engagementId);
    } catch {
      return sendError(reply, 500, "invalid_persisted_data");
    }
    if (!result.ok) {
      if (result.code === "engagement_not_found") return sendError(reply, 404, "engagement_not_found");
      if (result.code === "storage_busy") return sendError(reply, 503, "storage_busy");
      return sendError(reply, 500, "invalid_persisted_data");
    }
    const validated = EngagementFfufResultsResponseSchema.safeParse(result.value);
    if (!validated.success) return sendError(reply, 500, "invalid_persisted_data");
    return reply.code(200).type("application/json").send(validated.data);
  });
}
