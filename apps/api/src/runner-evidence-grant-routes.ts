import {
  CreateEvidenceGrantRequestSchema,
  EvidenceGrantResponseSchema,
  JsonValueSchema,
  RunnerMutationQuerySchema,
  commandJsonV1RunnerArtifactGrantDigest,
  type JsonValue,
} from "@stonehush/contracts";
import type {
  EvidenceGrantRepository,
  OperatorCommandRepository,
} from "@stonehush/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  dispatchRunnerMutation,
  mapEvidenceGrantRepositoryError,
  sendRunnerError,
} from "./runner-http.js";
import type { StorageQuiesceGate } from "./evidence/backup-lock.js";

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

export function registerRunnerEvidenceGrantRoutes(
  app: FastifyInstance,
  options: {
    commandRepository: CommandRepository;
    evidenceGrantRepository: Pick<EvidenceGrantRepository, "createGrant">;
    // When present, each grant admission holds a nonblocking shared quiesce
    // lock around its transaction; a backup snapshot refuses new grants with
    // an exact 503 and no grant row change.
    storageGate?: StorageQuiesceGate;
  },
): void {
  app.post("/api/v1/runner/artifacts/grants", async (request, reply) => {
    const runnerId = request.runnerAuth?.runnerId;
    if (runnerId === undefined) {
      return sendRunnerError(reply, 401, { code: "runner_unauthorized" });
    }
    if (options.storageGate !== undefined) {
      const gate = options.storageGate.acquireShared();
      if (!gate.ok) {
        return sendRunnerError(reply, 503, { code: "storage_backup_quiesced" });
      }
      try {
        return await dispatchAdmission(request, reply, runnerId);
      } finally {
        gate.release();
      }
    }
    return dispatchAdmission(request, reply, runnerId);
  });

  function dispatchAdmission(
    request: FastifyRequest,
    reply: FastifyReply,
    runnerId: string,
  ) {
    return dispatchRunnerMutation(request, reply, options.commandRepository, {
      actorId: runnerId,
      route: "/api/v1/runner/artifacts/grants",
      operation: "create_artifact_grant",
      digest: commandJsonV1RunnerArtifactGrantDigest,
      mutate: (transaction) => {
        const body = CreateEvidenceGrantRequestSchema.safeParse(request.body);
        const query = RunnerMutationQuerySchema.safeParse(request.query);
        if (!body.success || !query.success) {
          return { status: 400, body: { code: "invalid_request" } };
        }
        const granted = options.evidenceGrantRepository.createGrant(
          {
            ...body.data,
            runnerId,
            serverNow: transaction.now().toISOString(),
          },
          transaction.client,
        );
        if (!granted.ok) {
          const mapped = mapEvidenceGrantRepositoryError(granted.error);
          return { status: mapped.status, body: jsonBody(mapped.body) };
        }
        const validated = EvidenceGrantResponseSchema.safeParse(granted.value);
        if (!validated.success) throw new InvalidMutationResponseError();
        return { status: 201, body: jsonBody(validated.data) };
      },
    });
  }
}
