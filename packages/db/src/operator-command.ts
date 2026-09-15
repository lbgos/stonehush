import {
  COMMAND_CANONICALIZATION_PROFILE,
  CommandActorIdSchema,
  CommandOperationSchema,
  CommandRequestDigestSchema,
  CommandResponseStatusSchema,
  ConcreteCommandRouteSchema,
  IdempotencyKeySchema,
  canonicalizeJson,
  type JsonValue,
} from "@stonehush/contracts";
import { and, eq } from "drizzle-orm";

import type { EngagementRepository, EngagementWriteTransaction } from "./repository.js";
import { operatorCommandIdempotency } from "./schema.js";

export interface PreparedOperatorCommand {
  actorId: string;
  route: string;
  operation: string;
  idempotencyKey: string;
  canonicalizationProfile: typeof COMMAND_CANONICALIZATION_PROFILE;
  requestDigest: string;
}

export interface CommandHttpResponse {
  status: number;
  body: JsonValue;
}

export type OperatorCommandErrorCode =
  | "idempotency_conflict"
  | "invalid_command_input"
  | "invalid_persisted_data"
  | "storage_busy";

export type OperatorCommandResult =
  | {
      ok: true;
      disposition: "applied" | "replayed";
      response: { status: number; bodyJson: string };
    }
  | { ok: false; error: { code: OperatorCommandErrorCode } };

interface OperatorCommandProviders {
  now?: () => Date;
}

function failed(code: OperatorCommandErrorCode): OperatorCommandResult {
  return { ok: false, error: { code } };
}

class InvalidCommandResponseError extends Error {}

function isStorageBusy(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "SQLITE_BUSY" || error.code === "SQLITE_BUSY_TIMEOUT")
  );
}

function validateCommand(command: PreparedOperatorCommand): boolean {
  return (
    CommandActorIdSchema.safeParse(command.actorId).success &&
    ConcreteCommandRouteSchema.safeParse(command.route).success &&
    CommandOperationSchema.safeParse(command.operation).success &&
    IdempotencyKeySchema.safeParse(command.idempotencyKey).success &&
    command.canonicalizationProfile === COMMAND_CANONICALIZATION_PROFILE &&
    CommandRequestDigestSchema.safeParse(command.requestDigest).success
  );
}

export class OperatorCommandRepository {
  private readonly now: () => Date;

  constructor(
    private readonly engagementRepository: EngagementRepository,
    providers: OperatorCommandProviders = {},
  ) {
    this.now = providers.now ?? (() => new Date());
  }

  executeOperatorCommand(
    command: PreparedOperatorCommand,
    mutation: (
      transaction: EngagementWriteTransaction,
    ) => CommandHttpResponse,
  ): OperatorCommandResult {
    if (!validateCommand(command)) return failed("invalid_command_input");
    try {
      return this.engagementRepository.withWriteTx((transaction) => {
        const existing = transaction.client
          .select()
          .from(operatorCommandIdempotency)
          .where(
            and(
              eq(operatorCommandIdempotency.actorId, command.actorId),
              eq(operatorCommandIdempotency.route, command.route),
              eq(operatorCommandIdempotency.operation, command.operation),
              eq(
                operatorCommandIdempotency.idempotencyKey,
                command.idempotencyKey,
              ),
            ),
          )
          .get();
        if (existing !== undefined) {
          if (existing.requestDigest !== command.requestDigest) {
            return failed("idempotency_conflict");
          }
          const body = canonicalizeJson(JSON.parse(existing.responseBodyJson));
          if (
            !body.ok ||
            body.canonicalJson !== existing.responseBodyJson ||
            !CommandResponseStatusSchema.safeParse(existing.responseStatus).success ||
            existing.canonicalizationProfile !== COMMAND_CANONICALIZATION_PROFILE
          ) {
            return failed("invalid_persisted_data");
          }
          return {
            ok: true,
            disposition: "replayed",
            response: {
              status: existing.responseStatus,
              bodyJson: existing.responseBodyJson,
            },
          };
        }

        const response = mutation(transaction);
        const status = CommandResponseStatusSchema.safeParse(response.status);
        const body = canonicalizeJson(response.body);
        if (!status.success || !body.ok) throw new InvalidCommandResponseError();
        transaction.client
          .insert(operatorCommandIdempotency)
          .values({
            actorId: command.actorId,
            route: command.route,
            operation: command.operation,
            idempotencyKey: command.idempotencyKey,
            canonicalizationProfile: command.canonicalizationProfile,
            requestDigest: command.requestDigest,
            responseStatus: status.data,
            responseBodyJson: body.canonicalJson,
            createdAt: this.now().toISOString(),
          })
          .run();
        return {
          ok: true,
          disposition: "applied",
          response: { status: status.data, bodyJson: body.canonicalJson },
        };
      });
    } catch (error) {
      if (error instanceof InvalidCommandResponseError) {
        return failed("invalid_command_input");
      }
      return failed(isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data");
    }
  }
}
