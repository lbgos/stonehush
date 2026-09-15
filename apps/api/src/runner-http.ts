import { createHash } from "node:crypto";

import {
  canonicalizeJson,
  isOperatorArtifactContentRoute,
  isOperatorRunHistoryRoute,
  isOperatorRunOutputRoute,
  isRunnerControlRoute,
  parseRunnerAuthorizationHeader,
  type CommandJsonV1DigestProjection,
  type JsonValue,
  type RunnerMutationError,
} from "@stonehush/contracts";
import type {
  EngagementWriteTransaction,
  EvidenceGrantRepositoryError,
  OperatorCommandRepository,
  RunRepositoryError,
  RunnerRepository,
  RunnerRepositoryError,
} from "@stonehush/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  executeActorMutation,
  readIdempotencyKey,
  sendFixedOperatorError,
  sendOperatorCommandResult,
} from "./operator-command.js";
export interface RunnerRequestAuth {
  runnerId: string;
  credentialFingerprint: string;
}

declare module "fastify" {
  interface FastifyRequest {
    runnerAuth?: RunnerRequestAuth;
  }
}

type CommandRepository = Pick<
  OperatorCommandRepository,
  "executeOperatorCommand"
>;

export function stripAuthorizationHeader(
  headers: Record<string, unknown>,
): Record<string, unknown> {
  const redacted = { ...headers };
  delete redacted.authorization;
  delete redacted.Authorization;
  return redacted;
}

export function sendRunnerError(
  reply: FastifyReply,
  status: number,
  body: RunnerMutationError,
) {
  return reply.code(status).type("application/json").send(body);
}

export function mapRunnerRepositoryError(
  error: RunnerRepositoryError,
): { status: number; body: RunnerMutationError } {
  switch (error.code) {
    case "invalid_repository_input":
      return { status: 400, body: { code: "invalid_request" } };
    case "runner_unauthorized":
      return { status: 401, body: { code: "runner_unauthorized" } };
    case "enrollment_challenge_not_found":
    case "runner_not_found":
      return { status: 404, body: { code: error.code } };
    case "enrollment_challenge_expired":
    case "enrollment_challenge_reused":
    case "runner_already_enabled":
    case "runner_revoked":
    case "runner_handshake_required":
    case "runner_fingerprint_mismatch":
      return { status: 409, body: { code: error.code } };
    case "revision_conflict":
      return {
        status: 409,
        body: {
          code: "revision_conflict",
          resourceType: "runner",
          resourceId: error.resourceId,
          currentRevision: error.currentRevision,
        },
      };
    case "runner_protocol_unsupported":
      return {
        status: 426,
        body: {
          code: "runner_protocol_unsupported",
          supported: ["runner-control-v1"],
        },
      };
    case "storage_busy":
      return { status: 503, body: { code: "storage_busy" } };
    case "invalid_persisted_data":
      return { status: 500, body: { code: "invalid_persisted_data" } };
  }
}

export function mapRunRepositoryError(
  error: RunRepositoryError,
): { status: number; body: RunnerMutationError } {
  switch (error.code) {
    case "invalid_repository_input":
      return { status: 400, body: { code: "invalid_request" } };
    case "run_not_found":
    case "action_not_found":
      return { status: 404, body: { code: "invalid_request" } };
    case "lease_owner_mismatch":
      return { status: 403, body: { code: "lease_owner_mismatch" } };
    case "fencing_exhausted":
    case "no_work":
      return { status: 409, body: { code: "no_work" } };
    case "stale_fence":
    case "lease_expired":
    case "heartbeat_replay_conflict":
    case "heartbeat_sequence_stale":
    case "event_replay_conflict":
    case "run_already_terminal":
    case "invalid_run_transition":
    case "artifact_upload_in_progress":
      return { status: 409, body: { code: error.code } };
    case "event_sequence_gap":
      return {
        status: 409,
        body: {
          code: "event_sequence_gap",
          expectedSequence: error.expectedSequence,
        },
      };
    case "storage_busy":
      return { status: 503, body: { code: "storage_busy" } };
    default:
      return { status: 500, body: { code: "invalid_persisted_data" } };
  }
}

export function mapEvidenceGrantRepositoryError(
  error: EvidenceGrantRepositoryError,
): { status: number; body: RunnerMutationError } {
  switch (error.code) {
    case "invalid_repository_input":
      return { status: 400, body: { code: "invalid_request" } };
    case "run_not_found":
      return { status: 404, body: { code: "invalid_request" } };
    case "lease_owner_mismatch":
      return { status: 403, body: { code: "lease_owner_mismatch" } };
    case "stale_fence":
    case "lease_expired":
    case "run_already_terminal":
    case "artifact_upload_in_progress":
    case "artifact_quota_exceeded":
    case "concurrent_upload_limit":
    case "staging_quota_exceeded":
    case "run_quota_exceeded":
    case "total_quota_exceeded":
      return { status: 409, body: { code: error.code } };
    case "event_sequence_gap":
      return {
        status: 409,
        body: {
          code: "event_sequence_gap",
          expectedSequence: error.expectedSequence,
        },
      };
    case "storage_busy":
      return { status: 503, body: { code: "storage_busy" } };
    case "invalid_persisted_data":
      return { status: 500, body: { code: "invalid_persisted_data" } };
  }
}

export function requestDigestFor(value: unknown): string | undefined {
  const canonical = canonicalizeJson(value);
  if (!canonical.ok) return undefined;
  return `sha256:${createHash("sha256").update(canonical.canonicalJson, "utf8").digest("hex")}`;
}

export function registerRunnerAuthHook(
  app: FastifyInstance,
  runnerRepository?: Pick<RunnerRepository, "authenticate">,
): void {
  app.addHook("onRequest", async (request, reply) => {
    const header = Array.isArray(request.headers.authorization)
      ? request.headers.authorization[0]
      : request.headers.authorization;
    delete request.headers.authorization;
    const credential = parseRunnerAuthorizationHeader(header);
    const runnerRoute = isRunnerControlRoute(request.url);

    if (runnerRoute) {
      if (!credential.ok || runnerRepository === undefined) {
        // D3 evidence routes distinguish presented non-runner credentials
        // (operator or browser) from absent credentials.
        if (
          !credential.ok &&
          header !== undefined &&
          request.url.startsWith("/api/v1/runner/artifacts/")
        ) {
          return sendRunnerError(reply, 403, { code: "runner_identity_required" });
        }
        return sendRunnerError(reply, 401, { code: "runner_unauthorized" });
      }
      const authenticated = runnerRepository.authenticate(
        credential.runnerId,
        credential.secret,
      );
      if (!authenticated.ok) {
        if (authenticated.error.code === "storage_busy") {
          return sendRunnerError(reply, 503, { code: "storage_busy" });
        }
        if (authenticated.error.code === "invalid_persisted_data") {
          return sendRunnerError(reply, 500, { code: "invalid_persisted_data" });
        }
        return sendRunnerError(reply, 401, { code: "runner_unauthorized" });
      }
      request.runnerAuth = {
        runnerId: authenticated.value.runner.id,
        credentialFingerprint: authenticated.value.credentialFingerprint,
      };
      request.log.info(
        {
          runnerId: request.runnerAuth.runnerId,
          credentialFingerprint: request.runnerAuth.credentialFingerprint,
        },
        "runner authenticated",
      );
      return;
    }

    if (credential.ok) {
      // Only the GET verb of the operator artifact-content and run-output
      // routes serves engagement evidence to operators; a syntactically valid
      // runner credential must never be accepted there (nor treated as the
      // generic operator 403). Other methods keep existing route behavior.
      if (
        request.method === "GET" &&
        (isOperatorArtifactContentRoute(request.url) ||
          isOperatorRunOutputRoute(request.url) ||
          isOperatorRunHistoryRoute(request.url))
      ) {
        return sendRunnerError(reply, 403, { code: "operator_identity_required" });
      }
      return sendRunnerError(reply, 403, { code: "runner_route_forbidden" });
    }
  });
}

export function dispatchRunnerMutation(
  request: FastifyRequest,
  reply: FastifyReply,
  repository: CommandRepository,
  options: {
    actorId: string;
    route: string;
    operation: string;
    digest: CommandJsonV1DigestProjection;
    mutate: (transaction: EngagementWriteTransaction) => {
      status: number;
      body: JsonValue;
    };
  },
) {
  const key = readIdempotencyKey(request);
  if (key === undefined) {
    return sendFixedOperatorError(reply, 400, "invalid_request");
  }
  return sendOperatorCommandResult(
    reply,
    executeActorMutation(
      repository,
      {
        actorId: options.actorId,
        key,
        route: options.route,
        operation: options.operation,
        path: request.params,
        query: request.query,
        body: request.body,
        digest: options.digest,
      },
      options.mutate,
    ),
  );
}
