import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

import {
  ConfirmEnrollmentRequestSchema,
  EnrollmentChallengeSchema,
  PersistedRunnerIdentitySchema,
  RevokeRunnerRequestSchema,
  RUNNER_CONTROL_PROTOCOL,
  RUNNER_ENROLLMENT_CHALLENGE_TTL_SECONDS,
  RUNNER_IDENTITY_CONTRACT_VERSION,
  RUNNER_SALT_BYTES,
  RUNNER_SCRYPT_KEYLEN,
  RUNNER_SCRYPT_N,
  RUNNER_SCRYPT_P,
  RUNNER_SCRYPT_R,
  RUNNER_SECRET_BYTES,
  RunnerHandshakeRequestSchema,
  RunnerSecretSchema,
  RunnerVerifierRecordSchema,
  StartEnrollmentChallengeRequestSchema,
  type EnrollmentChallenge,
  type PersistedRunnerIdentity,
  type RunnerHandshakeAcceptedResponse,
  type RunnerVerifierRecord,
} from "@stonehush/contracts";
import { and, eq, isNull, ne } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import {
  fenceCurrentLeasesForRunner,
  type RunPersistenceContext,
  type RunQueryClient,
  type RunWriteClient,
} from "./run.js";
import * as schema from "./schema.js";
import {
  runnerEnrollmentChallenges,
  runnerIdentities,
  runnerSessions,
  type RunnerIdentityRow,
} from "./schema.js";

type DatabaseSchema = typeof schema;

export type RunnerRepositoryError =
  | { code: "enrollment_challenge_expired" }
  | { code: "enrollment_challenge_not_found" }
  | { code: "enrollment_challenge_reused" }
  | { code: "invalid_persisted_data" }
  | { code: "invalid_repository_input" }
  | {
      code: "revision_conflict";
      currentRevision: number;
      resourceType: "runner";
      resourceId: string;
    }
  | { code: "runner_already_enabled" }
  | { code: "runner_fingerprint_mismatch" }
  | { code: "runner_handshake_required" }
  | { code: "runner_not_found" }
  | { code: "runner_protocol_unsupported" }
  | { code: "runner_revoked" }
  | { code: "runner_unauthorized" }
  | { code: "storage_busy" };

export type RunnerResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: RunnerRepositoryError };

export interface RunnerRepositoryProviders {
  createId?: () => string;
  now?: () => Date;
  createSecret?: () => Buffer;
}

export interface ConfirmedRunnerEnrollment {
  readonly runner: PersistedRunnerIdentity;
  readonly secret: string;
  readonly secretBytes: Buffer;
}

export interface AuthenticatedRunner {
  readonly runner: PersistedRunnerIdentity;
  readonly credentialFingerprint: string;
}

export interface RevokedRunner {
  readonly runner: PersistedRunnerIdentity;
  readonly leasesFenced: number;
  readonly cancellationRequested: boolean;
}

const SCRYPT_OPTIONS = {
  N: RUNNER_SCRYPT_N,
  r: RUNNER_SCRYPT_R,
  p: RUNNER_SCRYPT_P,
  maxmem: 64 * 1024 * 1024,
} as const;

const DUMMY_SALT = Buffer.alloc(RUNNER_SALT_BYTES, 1);
const DUMMY_VERIFIER = Buffer.alloc(RUNNER_SCRYPT_KEYLEN, 2);

function failed<T>(error: RunnerRepositoryError): RunnerResult<T> {
  return { ok: false, error };
}

function isStorageBusy(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "SQLITE_BUSY" || error.code === "SQLITE_BUSY_TIMEOUT")
  );
}

function isUniqueConstraint(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "SQLITE_CONSTRAINT" ||
      error.code === "SQLITE_CONSTRAINT_UNIQUE" ||
      error.code === "SQLITE_CONSTRAINT_PRIMARYKEY")
  );
}

class InvalidRunnerWriteError extends Error {}

function abortInvalidWrite(): never {
  throw new InvalidRunnerWriteError("runner persistence write invariant failed");
}

export function encodeRunnerSecret(secretBytes: Buffer): string {
  return secretBytes.toString("base64url");
}

export function decodeRunnerSecret(encoded: string): Buffer | undefined {
  if (!RunnerSecretSchema.safeParse(encoded).success) return undefined;
  const bytes = Buffer.from(encoded, "base64url");
  return bytes.length === RUNNER_SECRET_BYTES ? bytes : undefined;
}

export function runnerCredentialFingerprint(secretBytes: Buffer): string {
  return createHash("sha256").update(secretBytes).digest("hex").slice(0, 12);
}

export function hashRunnerSecret(
  secretBytes: Buffer,
  salt: Buffer,
): Buffer {
  return scryptSync(secretBytes, salt, RUNNER_SCRYPT_KEYLEN, SCRYPT_OPTIONS);
}

export function secretsMatch(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function identityFromRow(row: RunnerIdentityRow): RunnerResult<PersistedRunnerIdentity> {
  const parsed = PersistedRunnerIdentitySchema.safeParse({
    contractVersion: row.contractVersion,
    id: row.id,
    revision: row.revision,
    name: row.name,
    installationFingerprint: row.installationFingerprint,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revokedAt: row.revokedAt,
  });
  return parsed.success
    ? { ok: true, value: parsed.data }
    : failed({ code: "invalid_persisted_data" });
}

function verifierFromRow(row: RunnerIdentityRow): RunnerResult<RunnerVerifierRecord> {
  const parsed = RunnerVerifierRecordSchema.safeParse({
    kdf: row.kdf,
    costN: row.costN,
    blockSizeR: row.blockSizeR,
    parallelizationP: row.parallelizationP,
    saltHex: row.saltHex,
    verifierHex: row.verifierHex,
  });
  return parsed.success
    ? { ok: true, value: parsed.data }
    : failed({ code: "invalid_persisted_data" });
}

function enabledRunner(client: RunQueryClient): RunnerIdentityRow | undefined {
  return client
    .select()
    .from(runnerIdentities)
    .where(eq(runnerIdentities.status, "enabled"))
    .get();
}

function loadRunner(
  client: RunQueryClient,
  runnerId: string,
): RunnerIdentityRow | undefined {
  return client
    .select()
    .from(runnerIdentities)
    .where(eq(runnerIdentities.id, runnerId))
    .get();
}

function authenticatePresentedSecret(
  row: RunnerIdentityRow | undefined,
  secret: string,
): boolean {
  const secretBytes = decodeRunnerSecret(secret) ?? Buffer.alloc(RUNNER_SECRET_BYTES);
  const salt =
    row === undefined ? DUMMY_SALT : Buffer.from(row.saltHex, "hex");
  const expected =
    row === undefined ? DUMMY_VERIFIER : Buffer.from(row.verifierHex, "hex");
  const presented = hashRunnerSecret(secretBytes, salt);
  const matches = secretsMatch(presented, expected);
  return row !== undefined && row.status === "enabled" && matches;
}

export class RunnerRepository {
  private readonly createId: () => string;
  private readonly now: () => Date;
  private readonly createSecret: () => Buffer;

  constructor(
    private readonly db: BetterSQLite3Database<DatabaseSchema>,
    providers: RunnerRepositoryProviders = {},
  ) {
    this.createId = providers.createId ?? randomUUID;
    this.now = providers.now ?? (() => new Date());
    this.createSecret = providers.createSecret ?? (() => randomBytes(RUNNER_SECRET_BYTES));
  }

  private write<T>(
    operation: (context: RunPersistenceContext) => RunnerResult<T>,
    transaction?: RunWriteClient,
  ): RunnerResult<T> {
    if (transaction !== undefined) {
      return operation({
        client: transaction,
        createId: this.createId,
        now: this.now,
      });
    }
    try {
      return this.db.transaction(
        (client) =>
          operation({
            client,
            createId: this.createId,
            now: this.now,
          }),
        { behavior: "immediate" },
      );
    } catch (error) {
      if (error instanceof InvalidRunnerWriteError) {
        return failed({ code: "invalid_persisted_data" });
      }
      return failed({
        code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data",
      });
    }
  }

  startEnrollmentChallenge(
    input: unknown,
    transaction?: RunWriteClient,
  ): RunnerResult<EnrollmentChallenge> {
    return this.write((context) => {
      const parsed = StartEnrollmentChallengeRequestSchema.safeParse(input);
      if (!parsed.success) return failed({ code: "invalid_repository_input" });
      if (enabledRunner(context.client) !== undefined) {
        return failed({ code: "runner_already_enabled" });
      }
      const createdAt = context.now();
      const expiresAt = new Date(
        createdAt.getTime() + RUNNER_ENROLLMENT_CHALLENGE_TTL_SECONDS * 1_000,
      );
      const challengeId = context.createId();
      const candidate = EnrollmentChallengeSchema.safeParse({
        challengeId,
        name: parsed.data.name,
        installationFingerprint: parsed.data.installationFingerprint,
        expiresAt: expiresAt.toISOString(),
        ttlSeconds: RUNNER_ENROLLMENT_CHALLENGE_TTL_SECONDS,
      });
      if (!candidate.success) return failed({ code: "invalid_repository_input" });
      context.client
        .insert(runnerEnrollmentChallenges)
        .values({
          id: challengeId,
          contractVersion: RUNNER_IDENTITY_CONTRACT_VERSION,
          name: parsed.data.name,
          installationFingerprint: parsed.data.installationFingerprint,
          createdAt: createdAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          consumedAt: null,
        })
        .run();
      return { ok: true, value: candidate.data };
    }, transaction);
  }

  confirmEnrollment(
    challengeId: string,
    input: unknown,
    transaction?: RunWriteClient,
  ): RunnerResult<ConfirmedRunnerEnrollment> {
    return this.write((context) => {
      const parsed = ConfirmEnrollmentRequestSchema.safeParse(input);
      if (!parsed.success || challengeId.length < 1 || challengeId.length > 255) {
        return failed({ code: "invalid_repository_input" });
      }
      const challenge = context.client
        .select()
        .from(runnerEnrollmentChallenges)
        .where(eq(runnerEnrollmentChallenges.id, challengeId))
        .get();
      if (challenge === undefined) {
        return failed({ code: "enrollment_challenge_not_found" });
      }
      const timestamp = context.now().toISOString();
      if (challenge.consumedAt !== null) {
        return failed({ code: "enrollment_challenge_reused" });
      }
      if (Date.parse(timestamp) > Date.parse(challenge.expiresAt)) {
        return failed({ code: "enrollment_challenge_expired" });
      }
      if (enabledRunner(context.client) !== undefined) {
        return failed({ code: "runner_already_enabled" });
      }
      const consumed = context.client
        .update(runnerEnrollmentChallenges)
        .set({ consumedAt: timestamp })
        .where(
          and(
            eq(runnerEnrollmentChallenges.id, challengeId),
            isNull(runnerEnrollmentChallenges.consumedAt),
          ),
        )
        .run();
      if (consumed.changes !== 1) {
        return failed({ code: "enrollment_challenge_reused" });
      }

      const secretBytes = this.createSecret();
      if (secretBytes.length !== RUNNER_SECRET_BYTES) {
        return failed({ code: "invalid_repository_input" });
      }
      const secret = encodeRunnerSecret(secretBytes);
      if (!RunnerSecretSchema.safeParse(secret).success) {
        return failed({ code: "invalid_repository_input" });
      }
      const salt = randomBytes(RUNNER_SALT_BYTES);
      const verifier = hashRunnerSecret(secretBytes, salt);
      const runnerId = context.createId();
      const row = {
        id: runnerId,
        contractVersion: RUNNER_IDENTITY_CONTRACT_VERSION,
        revision: 1,
        name: challenge.name,
        installationFingerprint: challenge.installationFingerprint,
        status: "enabled" as const,
        saltHex: salt.toString("hex"),
        verifierHex: verifier.toString("hex"),
        kdf: "scrypt" as const,
        costN: RUNNER_SCRYPT_N,
        blockSizeR: RUNNER_SCRYPT_R,
        parallelizationP: RUNNER_SCRYPT_P,
        verifierBytes: RUNNER_SCRYPT_KEYLEN,
        createdAt: timestamp,
        updatedAt: timestamp,
        revokedAt: null,
      };
      const identity = identityFromRow(row);
      if (!identity.ok) return identity;
      try {
        context.client.insert(runnerIdentities).values(row).run();
      } catch (error) {
        if (isUniqueConstraint(error)) {
          return failed({ code: "runner_already_enabled" });
        }
        throw error;
      }
      return {
        ok: true,
        value: { runner: identity.value, secret, secretBytes },
      };
    }, transaction);
  }

  revoke(
    runnerId: string,
    input: unknown,
    transaction?: RunWriteClient,
  ): RunnerResult<RevokedRunner> {
    return this.write((context) => {
      const parsed = RevokeRunnerRequestSchema.safeParse(input);
      if (!parsed.success || runnerId.length < 1 || runnerId.length > 255) {
        return failed({ code: "invalid_repository_input" });
      }
      const current = loadRunner(context.client, runnerId);
      if (current === undefined) return failed({ code: "runner_not_found" });
      if (current.revision !== parsed.data.expectedRevision) {
        return failed({
          code: "revision_conflict",
          currentRevision: current.revision,
          resourceType: "runner",
          resourceId: runnerId,
        });
      }
      if (current.status === "revoked") return failed({ code: "runner_revoked" });
      const timestamp = context.now().toISOString();
      const updated = context.client
        .update(runnerIdentities)
        .set({
          status: "revoked",
          revision: current.revision + 1,
          updatedAt: timestamp,
          revokedAt: timestamp,
        })
        .where(
          and(
            eq(runnerIdentities.id, runnerId),
            eq(runnerIdentities.revision, current.revision),
            eq(runnerIdentities.status, "enabled"),
          ),
        )
        .run();
      if (updated.changes !== 1) return failed({ code: "invalid_persisted_data" });
      context.client
        .update(runnerSessions)
        .set({ current: false })
        .where(
          and(eq(runnerSessions.runnerId, runnerId), eq(runnerSessions.current, true)),
        )
        .run();
      const fenced = fenceCurrentLeasesForRunner(context, {
        runnerId,
        serverNow: timestamp,
      });
      if (!fenced.ok) {
        if (fenced.error.code === "invalid_repository_input") {
          return failed({ code: "invalid_repository_input" });
        }
        if (fenced.error.code === "storage_busy") {
          return failed({ code: "storage_busy" });
        }
        return failed({ code: "invalid_persisted_data" });
      }
      const stored = loadRunner(context.client, runnerId);
      if (stored === undefined) abortInvalidWrite();
      const identity = identityFromRow(stored);
      if (!identity.ok) return identity;
      return {
        ok: true,
        value: {
          runner: identity.value,
          leasesFenced: fenced.value.leasesFenced,
          cancellationRequested: fenced.value.cancellationRequested,
        },
      };
    }, transaction);
  }

  acceptHandshake(
    runnerId: string,
    input: unknown,
    transaction?: RunWriteClient,
  ): RunnerResult<RunnerHandshakeAcceptedResponse> {
    return this.write((context) => {
      const parsed = RunnerHandshakeRequestSchema.safeParse(input);
      if (!parsed.success || runnerId.length < 1 || runnerId.length > 255) {
        return failed({ code: "invalid_repository_input" });
      }
      if (parsed.data.protocol !== RUNNER_CONTROL_PROTOCOL) {
        return failed({ code: "runner_protocol_unsupported" });
      }
      const runner = loadRunner(context.client, runnerId);
      if (runner === undefined) return failed({ code: "runner_not_found" });
      if (runner.status !== "enabled") return failed({ code: "runner_revoked" });
      if (runner.installationFingerprint !== parsed.data.installationFingerprint) {
        return failed({ code: "runner_fingerprint_mismatch" });
      }
      const timestamp = context.now().toISOString();
      const existing = context.client
        .select()
        .from(runnerSessions)
        .where(eq(runnerSessions.sessionId, parsed.data.sessionId))
        .get();
      if (existing !== undefined && existing.runnerId !== runnerId) {
        return failed({ code: "invalid_repository_input" });
      }
      context.client
        .update(runnerSessions)
        .set({ current: false })
        .where(
          and(
            eq(runnerSessions.runnerId, runnerId),
            eq(runnerSessions.current, true),
            ne(runnerSessions.sessionId, parsed.data.sessionId),
          ),
        )
        .run();
      if (existing === undefined) {
        try {
          context.client
            .insert(runnerSessions)
            .values({
              sessionId: parsed.data.sessionId,
              contractVersion: RUNNER_IDENTITY_CONTRACT_VERSION,
              runnerId,
              protocol: RUNNER_CONTROL_PROTOCOL,
              installationFingerprint: parsed.data.installationFingerprint,
              registryDigest: parsed.data.registryDigest ?? null,
              eventSchemasJson: JSON.stringify(parsed.data.eventSchemas),
              current: true,
              createdAt: timestamp,
            })
            .run();
        } catch (error) {
          if (isUniqueConstraint(error)) {
            return failed({ code: "invalid_repository_input" });
          }
          throw error;
        }
      } else {
        context.client
          .update(runnerSessions)
          .set({
            current: true,
            protocol: RUNNER_CONTROL_PROTOCOL,
            installationFingerprint: parsed.data.installationFingerprint,
            registryDigest: parsed.data.registryDigest ?? null,
            eventSchemasJson: JSON.stringify(parsed.data.eventSchemas),
          })
          .where(eq(runnerSessions.sessionId, parsed.data.sessionId))
          .run();
      }
      return {
        ok: true,
        value: {
          acceptedProtocol: RUNNER_CONTROL_PROTOCOL,
          sessionId: parsed.data.sessionId,
          runnerId,
          leaseAllowed: true,
          sessionPinned: true,
          registryPinned: parsed.data.registryDigest !== undefined,
        },
      };
    }, transaction);
  }

  requireAcceptedSession(
    runnerId: string,
    sessionId: string,
    transaction?: RunWriteClient,
  ): RunnerResult<{ sessionId: string; runnerId: string }> {
    const read = (client: RunQueryClient): RunnerResult<{
      sessionId: string;
      runnerId: string;
    }> => {
      const runner = loadRunner(client, runnerId);
      if (runner === undefined) return failed({ code: "runner_not_found" });
      if (runner.status !== "enabled") return failed({ code: "runner_revoked" });
      const session = client
        .select()
        .from(runnerSessions)
        .where(
          and(
            eq(runnerSessions.sessionId, sessionId),
            eq(runnerSessions.runnerId, runnerId),
            eq(runnerSessions.current, true),
          ),
        )
        .get();
      if (session === undefined) {
        return failed({ code: "runner_handshake_required" });
      }
      return { ok: true, value: { sessionId, runnerId } };
    };
    if (transaction !== undefined) return read(transaction);
    try {
      return read(this.db);
    } catch (error) {
      return failed({
        code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data",
      });
    }
  }

  authenticate(
    runnerId: string,
    secret: string,
  ): RunnerResult<AuthenticatedRunner> {
    try {
      const row = loadRunner(this.db, runnerId);
      if (!authenticatePresentedSecret(row, secret) || row === undefined) {
        return failed({ code: "runner_unauthorized" });
      }
      const identity = identityFromRow(row);
      if (!identity.ok) return identity;
      const secretBytes = decodeRunnerSecret(secret);
      if (secretBytes === undefined) return failed({ code: "runner_unauthorized" });
      return {
        ok: true,
        value: {
          runner: identity.value,
          credentialFingerprint: runnerCredentialFingerprint(secretBytes),
        },
      };
    } catch (error) {
      return failed({
        code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data",
      });
    }
  }

  getIdentity(runnerId: string): RunnerResult<PersistedRunnerIdentity> {
    try {
      const row = loadRunner(this.db, runnerId);
      if (row === undefined) return failed({ code: "runner_not_found" });
      return identityFromRow(row);
    } catch (error) {
      return failed({
        code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data",
      });
    }
  }

  getVerifierRecord(runnerId: string): RunnerResult<RunnerVerifierRecord> {
    try {
      const row = loadRunner(this.db, runnerId);
      if (row === undefined) return failed({ code: "runner_not_found" });
      return verifierFromRow(row);
    } catch (error) {
      return failed({
        code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data",
      });
    }
  }
}
