import {
  AcquireRunnerLeaseRequestSchema,
  AcquireRunnerLeaseResponseSchema,
  JsonValueSchema,
  RunnerAppendStartedRequestSchema,
  RunnerCompleteRequestSchema,
  RunnerEventResponseSchema,
  RunnerHandshakeAcceptedResponseSchema,
  RunnerHandshakeRequestSchema,
  RunnerHeartbeatRequestSchema,
  RunnerHeartbeatResponseSchema,
  RunnerLeaseIdParamsSchema,
  RunnerMutationQuerySchema,
  commandJsonV1RunnerAppendStartedDigest,
  commandJsonV1RunnerCompleteDigest,
  type JsonValue,
} from "@stonehush/contracts";
import type {
  EngagementRepository,
  OperatorCommandRepository,
  RunRepository,
  RunnerRepository,
} from "@stonehush/db";
import { selectOldestQueuedRun } from "@stonehush/db";
import type { FastifyInstance } from "fastify";

import { readPathParam } from "./operator-command.js";
import {
  dispatchRunnerMutation,
  mapRunRepositoryError,
  mapRunnerRepositoryError,
  requestDigestFor,
  sendRunnerError,
} from "./runner-http.js";

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

function requireRunnerAuth(request: { runnerAuth?: { runnerId: string } }) {
  return request.runnerAuth?.runnerId;
}

export function registerRunnerControlRoutes(
  app: FastifyInstance,
  options: {
    commandRepository: CommandRepository;
    engagementRepository: Pick<EngagementRepository, "withWriteTx">;
    runRepository: Pick<
      RunRepository,
      "acquireLease" | "heartbeat" | "appendEvent" | "completeRun"
    >;
    runnerRepository: Pick<
      RunnerRepository,
      "acceptHandshake" | "requireAcceptedSession"
    >;
    now?: () => Date;
  },
): void {
  const now = options.now ?? (() => new Date());
  app.post("/api/v1/runner/handshake", async (request, reply) => {
    const runnerId = requireRunnerAuth(request);
    if (runnerId === undefined) {
      return sendRunnerError(reply, 401, { code: "runner_unauthorized" });
    }
    const body = RunnerHandshakeRequestSchema.safeParse(request.body);
    const query = RunnerMutationQuerySchema.safeParse(request.query);
    if (!body.success || !query.success) {
      return sendRunnerError(reply, 400, { code: "invalid_request" });
    }
    const accepted = options.runnerRepository.acceptHandshake(runnerId, body.data);
    if (!accepted.ok) {
      const mapped = mapRunnerRepositoryError(accepted.error);
      return sendRunnerError(reply, mapped.status, mapped.body);
    }
    const validated = RunnerHandshakeAcceptedResponseSchema.safeParse(accepted.value);
    if (!validated.success) {
      return sendRunnerError(reply, 500, { code: "invalid_persisted_data" });
    }
    return reply.code(200).type("application/json").send(validated.data);
  });

  app.post("/api/v1/runner/lease", async (request, reply) => {
    const runnerId = requireRunnerAuth(request);
    if (runnerId === undefined) {
      return sendRunnerError(reply, 401, { code: "runner_unauthorized" });
    }
    const body = AcquireRunnerLeaseRequestSchema.safeParse(request.body);
    const query = RunnerMutationQuerySchema.safeParse(request.query);
    if (!body.success || !query.success) {
      return sendRunnerError(reply, 400, { code: "invalid_request" });
    }
    let result:
      | ReturnType<RunnerRepository["requireAcceptedSession"]>
      | ReturnType<RunRepository["acquireLease"]>
      | { ok: false; error: { code: "invalid_persisted_data" } }
      | { ok: true; value: { run: unknown; lease: unknown; actionSnapshot: unknown } };
    try {
      result = options.engagementRepository.withWriteTx((transaction) => {
        const session = options.runnerRepository.requireAcceptedSession(
          runnerId,
          body.data.sessionId,
          transaction.client,
        );
        if (!session.ok) return session;
        const queued = selectOldestQueuedRun(transaction.client);
        if (!queued.ok) return queued;
        const actionResult = transaction.getAction(
          queued.value.engagementId,
          queued.value.actionId,
        );
        if (!actionResult.ok) {
          return { ok: false as const, error: { code: "invalid_persisted_data" as const } };
        }
        const action = actionResult.value;
        const queuedVersion = action.action.queuedSnapshotVersion;
        if (queuedVersion === null) {
          return { ok: false as const, error: { code: "invalid_persisted_data" as const } };
        }
        const snapshot = action.action.snapshots.find(
          (candidate) => candidate.version === queuedVersion,
        );
        if (snapshot === undefined) {
          return { ok: false as const, error: { code: "invalid_persisted_data" as const } };
        }
        if (
          snapshot.actionId !== queued.value.actionId ||
          snapshot.actionId !== action.action.actionId ||
          snapshot.version !== queuedVersion
        ) {
          return { ok: false as const, error: { code: "invalid_persisted_data" as const } };
        }
        const leased = transaction.acquireLease({
          runId: queued.value.id,
          runnerId,
          sessionId: body.data.sessionId,
          serverNow: transaction.now().toISOString(),
        });
        if (!leased.ok) return leased;
        return {
          ok: true as const,
          value: {
            run: leased.value.run,
            lease: leased.value.lease,
            actionSnapshot: snapshot,
          },
        };
      });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error.code === "SQLITE_BUSY" || error.code === "SQLITE_BUSY_TIMEOUT")
      ) {
        return sendRunnerError(reply, 503, { code: "storage_busy" });
      }
      throw error;
    }
    if (!result.ok) {
      const code = result.error.code;
      if (
        code === "runner_handshake_required" ||
        code === "runner_revoked" ||
        code === "runner_not_found" ||
        code === "runner_unauthorized"
      ) {
        const mapped = mapRunnerRepositoryError({
          code,
        } as Extract<
          Parameters<typeof mapRunnerRepositoryError>[0],
          { code: typeof code }
        >);
        return sendRunnerError(reply, mapped.status, mapped.body);
      }
      const mapped = mapRunRepositoryError(
        result.error as Parameters<typeof mapRunRepositoryError>[0],
      );
      return sendRunnerError(reply, mapped.status, mapped.body);
    }
    const validated = AcquireRunnerLeaseResponseSchema.safeParse({
      run: (result.value as { run: unknown }).run,
      lease: (result.value as { lease: unknown }).lease,
      actionSnapshot: (result.value as { actionSnapshot: unknown }).actionSnapshot,
    });
    if (!validated.success) {
      return sendRunnerError(reply, 500, { code: "invalid_persisted_data" });
    }
    return reply.code(200).type("application/json").send(validated.data);
  });

  app.post("/api/v1/runner/leases/:leaseId/heartbeat", async (request, reply) => {
    const runnerId = requireRunnerAuth(request);
    const leaseId = readPathParam(request.params, "leaseId");
    if (runnerId === undefined) {
      return sendRunnerError(reply, 401, { code: "runner_unauthorized" });
    }
    if (leaseId === undefined) {
      return sendRunnerError(reply, 400, { code: "invalid_request" });
    }
    const params = RunnerLeaseIdParamsSchema.safeParse(request.params);
    const body = RunnerHeartbeatRequestSchema.safeParse(request.body);
    const query = RunnerMutationQuerySchema.safeParse(request.query);
    if (!params.success || !body.success || !query.success) {
      return sendRunnerError(reply, 400, { code: "invalid_request" });
    }
    const digest = requestDigestFor({
      fence: body.data.fence,
      heartbeatSequence: body.data.heartbeatSequence,
      leaseId: params.data.leaseId,
      runId: body.data.runId,
      runnerId,
      sessionId: body.data.sessionId,
    });
    if (digest === undefined) {
      return sendRunnerError(reply, 400, { code: "invalid_request" });
    }
    const result = options.runRepository.heartbeat({
      presented: {
        runId: body.data.runId,
        leaseId: params.data.leaseId,
        runnerId,
        sessionId: body.data.sessionId,
        fence: body.data.fence,
      },
      heartbeatSequence: body.data.heartbeatSequence,
      requestDigest: digest,
      serverNow: now().toISOString(),
    });
    if (!result.ok) {
      const mapped = mapRunRepositoryError(result.error);
      return sendRunnerError(reply, mapped.status, mapped.body);
    }
    if (result.value.ok !== true) {
      return sendRunnerError(reply, 500, { code: "invalid_persisted_data" });
    }
    const leaseExpiresAt =
      result.value.disposition === "stored_heartbeat_replayed"
        ? result.value.leaseExpiresAt
        : result.value.heartbeat.leaseExpiresAt;
    const heartbeatSequence =
      result.value.disposition === "stored_heartbeat_replayed"
        ? body.data.heartbeatSequence
        : result.value.heartbeat.heartbeatSequence;
    const validated = RunnerHeartbeatResponseSchema.safeParse({
      leaseExpiresAt,
      heartbeatSequence,
    });
    if (!validated.success) {
      return sendRunnerError(reply, 500, { code: "invalid_persisted_data" });
    }
    return reply.code(200).type("application/json").send(validated.data);
  });

  app.post("/api/v1/runner/leases/:leaseId/events", async (request, reply) => {
    const runnerId = requireRunnerAuth(request);
    const leaseId = readPathParam(request.params, "leaseId");
    if (runnerId === undefined) {
      return sendRunnerError(reply, 401, { code: "runner_unauthorized" });
    }
    if (leaseId === undefined) {
      return sendRunnerError(reply, 400, { code: "invalid_request" });
    }
    return dispatchRunnerMutation(request, reply, options.commandRepository, {
      actorId: runnerId,
      route: `/api/v1/runner/leases/${leaseId}/events`,
      operation: "append_started",
      digest: commandJsonV1RunnerAppendStartedDigest,
      mutate: (transaction) => {
        const params = RunnerLeaseIdParamsSchema.safeParse(request.params);
        const body = RunnerAppendStartedRequestSchema.safeParse(request.body);
        const query = RunnerMutationQuerySchema.safeParse(request.query);
        if (!params.success || !body.success || !query.success) {
          return { status: 400, body: { code: "invalid_request" } };
        }
        const appended = options.runRepository.appendEvent(
          {
            presented: {
              runId: body.data.runId,
              leaseId: params.data.leaseId,
              runnerId,
              sessionId: body.data.sessionId,
              fence: body.data.fence,
            },
            sequence: body.data.sequence,
            type: "started",
            payload: body.data.payload,
            serverNow: transaction.now().toISOString(),
          },
          transaction.client,
        );
        if (!appended.ok) {
          const mapped = mapRunRepositoryError(appended.error);
          return { status: mapped.status, body: jsonBody(mapped.body) };
        }
        const validated = RunnerEventResponseSchema.safeParse({
          disposition: appended.value.disposition,
          event: appended.value.event,
        });
        if (!validated.success) throw new InvalidMutationResponseError();
        return { status: 200, body: jsonBody(validated.data) };
      },
    });
  });

  app.post("/api/v1/runner/leases/:leaseId/complete", async (request, reply) => {
    const runnerId = requireRunnerAuth(request);
    const leaseId = readPathParam(request.params, "leaseId");
    if (runnerId === undefined) {
      return sendRunnerError(reply, 401, { code: "runner_unauthorized" });
    }
    if (leaseId === undefined) {
      return sendRunnerError(reply, 400, { code: "invalid_request" });
    }
    return dispatchRunnerMutation(request, reply, options.commandRepository, {
      actorId: runnerId,
      route: `/api/v1/runner/leases/${leaseId}/complete`,
      operation: "complete",
      digest: commandJsonV1RunnerCompleteDigest,
      mutate: (transaction) => {
        const params = RunnerLeaseIdParamsSchema.safeParse(request.params);
        const body = RunnerCompleteRequestSchema.safeParse(request.body);
        const query = RunnerMutationQuerySchema.safeParse(request.query);
        if (!params.success || !body.success || !query.success) {
          return { status: 400, body: { code: "invalid_request" } };
        }
        const completed = options.runRepository.completeRun(
          {
            presented: {
              runId: body.data.runId,
              leaseId: params.data.leaseId,
              runnerId,
              sessionId: body.data.sessionId,
              fence: body.data.fence,
            },
            sequence: body.data.sequence,
            terminalKind: body.data.terminalKind,
            reason: body.data.reason,
            serverNow: transaction.now().toISOString(),
          },
          transaction.client,
        );
        if (!completed.ok) {
          const mapped = mapRunRepositoryError(completed.error);
          return { status: mapped.status, body: jsonBody(mapped.body) };
        }
        const validated = RunnerEventResponseSchema.safeParse({
          disposition: completed.value.disposition,
          event: completed.value.event,
        });
        if (!validated.success) throw new InvalidMutationResponseError();
        return { status: 200, body: jsonBody(validated.data) };
      },
    });
  });
}
