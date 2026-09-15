import { createHash } from "node:crypto";

import {
  COMMAND_CANONICALIZATION_PROFILE,
  CommandOperationSchema,
  ConcreteCommandRouteSchema,
  IdempotencyKeySchema,
  JsonValueSchema,
  canonicalizeJson,
  projectCommandJsonV1DigestInput,
  type CommandJsonV1DigestProjection,
  type JsonValue,
} from "@stonehush/contracts";
import type {
  EngagementWriteTransaction,
  OperatorCommandRepository,
  OperatorCommandResult,
  PreparedOperatorCommand,
} from "@stonehush/db";
import type { FastifyReply, FastifyRequest } from "fastify";

export const LOCAL_OPERATOR_ACTOR_ID = "local-operator-v1" as const;

interface LocalOperatorCommandInput {
  key: string;
  route: string;
  operation: string;
  /** Bounded digest-input path, query, and body values. */
  path: JsonValue;
  query: JsonValue;
  body: JsonValue;
}

export type PrepareLocalOperatorCommandResult =
  | { ok: true; command: PreparedOperatorCommand }
  | { ok: false; error: { code: "invalid_command_input" } };

export type OperatorMutationCallback = (
  transaction: EngagementWriteTransaction,
) => {
  status: number;
  body: JsonValue;
};

type CommandRepository = Pick<
  OperatorCommandRepository,
  "executeOperatorCommand"
>;

export function prepareActorCommand(
  actorId: string,
  input: LocalOperatorCommandInput,
): PrepareLocalOperatorCommandResult {
  const key = IdempotencyKeySchema.safeParse(input.key);
  const route = ConcreteCommandRouteSchema.safeParse(input.route);
  const operation = CommandOperationSchema.safeParse(input.operation);
  if (!key.success || !route.success || !operation.success) {
    return { ok: false, error: { code: "invalid_command_input" } };
  }
  const canonical = canonicalizeJson({
    actorId,
    body: input.body,
    canonicalizationProfile: COMMAND_CANONICALIZATION_PROFILE,
    operation: operation.data,
    path: input.path,
    query: input.query,
    route: route.data,
  });
  if (!canonical.ok) {
    return { ok: false, error: { code: "invalid_command_input" } };
  }
  const requestDigest = `sha256:${createHash("sha256")
    .update(canonical.canonicalJson, "utf8")
    .digest("hex")}`;
  return {
    ok: true,
    command: {
      actorId,
      route: route.data,
      operation: operation.data,
      idempotencyKey: key.data,
      canonicalizationProfile: COMMAND_CANONICALIZATION_PROFILE,
      requestDigest,
    },
  };
}

export function prepareLocalOperatorCommand(
  input: LocalOperatorCommandInput,
): PrepareLocalOperatorCommandResult {
  return prepareActorCommand(LOCAL_OPERATOR_ACTOR_ID, input);
}

export function parseBoundedDigestInput(
  value: unknown,
): JsonValue | undefined {
  try {
    const parsed = JsonValueSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  } catch (error) {
    if (error instanceof RangeError) return undefined;
    throw error;
  }
}

export function readIdempotencyKey(request: FastifyRequest): string | undefined {
  const values: string[] = [];
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    if (request.raw.rawHeaders[index]?.toLowerCase() === "idempotency-key") {
      values.push(request.raw.rawHeaders[index + 1] ?? "");
    }
  }
  if (values.length !== 1) return undefined;
  const parsed = IdempotencyKeySchema.safeParse(values[0]);
  return parsed.success ? parsed.data : undefined;
}

export function readPathParam(
  params: unknown,
  name: string,
): string | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const value = Reflect.get(params, name);
  return typeof value === "string" ? value : undefined;
}

export function executeActorMutation(
  repository: CommandRepository,
  input: {
    actorId: string;
    key: string;
    route: string;
    operation: string;
    path: unknown;
    query: unknown;
    body: unknown;
    digest: CommandJsonV1DigestProjection;
  },
  mutate: OperatorMutationCallback,
): OperatorCommandResult {
  const path = parseBoundedDigestInput(input.path);
  const query = parseBoundedDigestInput(input.query);
  const body = parseBoundedDigestInput(input.body);
  if (path === undefined || query === undefined || body === undefined) {
    return { ok: false, error: { code: "invalid_command_input" } };
  }
  const projected = projectCommandJsonV1DigestInput(input.digest, {
    path,
    query,
    body,
  });
  const prepared = prepareActorCommand(input.actorId, {
    key: input.key,
    route: input.route,
    operation: input.operation,
    path: projected.path,
    query: projected.query,
    body: projected.body,
  });
  if (!prepared.ok) return prepared;
  return repository.executeOperatorCommand(prepared.command, mutate);
}

export function executeOperatorMutation(
  repository: CommandRepository,
  input: {
    key: string;
    route: string;
    operation: string;
    path: unknown;
    query: unknown;
    body: unknown;
    digest: CommandJsonV1DigestProjection;
  },
  mutate: OperatorMutationCallback,
): OperatorCommandResult {
  return executeActorMutation(
    repository,
    { actorId: LOCAL_OPERATOR_ACTOR_ID, ...input },
    mutate,
  );
}

const FIXED_COMMAND_ERRORS = {
  invalid_command_input: { status: 400, code: "invalid_request" },
  idempotency_conflict: { status: 409, code: "idempotency_conflict" },
  storage_busy: { status: 503, code: "storage_busy" },
  invalid_persisted_data: { status: 500, code: "invalid_persisted_data" },
} as const;

export function sendFixedOperatorError(
  reply: FastifyReply,
  status: 400 | 409 | 500 | 503,
  code:
    | "invalid_request"
    | "idempotency_conflict"
    | "invalid_persisted_data"
    | "storage_busy",
) {
  return reply.code(status).type("application/json").send({ code });
}

export function sendOperatorCommandResult(
  reply: FastifyReply,
  result: OperatorCommandResult,
) {
  if (!result.ok) {
    const mapped = FIXED_COMMAND_ERRORS[result.error.code];
    return sendFixedOperatorError(reply, mapped.status, mapped.code);
  }
  try {
    JSON.parse(result.response.bodyJson);
  } catch {
    return sendFixedOperatorError(reply, 500, "invalid_persisted_data");
  }
  return reply
    .code(result.response.status)
    .type("application/json")
    .send(result.response.bodyJson);
}

export function dispatchActorMutation(
  request: FastifyRequest,
  reply: FastifyReply,
  repository: CommandRepository,
  options: {
    actorId: string;
    route: string;
    operation: string;
    digest: CommandJsonV1DigestProjection;
    mutate: OperatorMutationCallback;
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

export function dispatchOperatorMutation(
  request: FastifyRequest,
  reply: FastifyReply,
  repository: CommandRepository,
  options: {
    route: string;
    operation: string;
    digest: CommandJsonV1DigestProjection;
    mutate: OperatorMutationCallback;
  },
) {
  return dispatchActorMutation(request, reply, repository, {
    actorId: LOCAL_OPERATOR_ACTOR_ID,
    ...options,
  });
}
