import { z } from "zod";

import { ActionSnapshotSchema } from "./action-planning.js";
import {
  PersistedRunEventSchema,
  PersistedRunSchema,
  PositiveFencingTokenSchema,
  RUNNER_CONTROL_PROTOCOL,
  RunnerLeaseSchema,
  RunnerSequenceSchema,
  RunTerminalKindSchema,
  RunTerminalReasonSchema,
} from "./runner-control.js";

export const RUNNER_IDENTITY_CONTRACT_VERSION = 1 as const;
export const RUNNER_ENROLLMENT_CHALLENGE_TTL_SECONDS = 600;
export const RUNNER_SECRET_BYTES = 32;
export const RUNNER_SALT_BYTES = 32;
export const RUNNER_SCRYPT_N = 16_384;
export const RUNNER_SCRYPT_R = 8;
export const RUNNER_SCRYPT_P = 1;
export const RUNNER_SCRYPT_KEYLEN = 32;
export const RUNNER_CREDENTIAL_FINGERPRINT_HEX_LENGTH = 12;
export const RUNNER_AUTHORIZATION_SCHEME = "Stonehush-Runner" as const;
export const RUNNER_SECRET_ENCODING = "base64url" as const;
export const RUNNER_CONTROL_ROUTE_PREFIX = "/api/v1/runner/" as const;

const IdentifierSchema = z.string().min(1).max(255);
const TimestampSchema = z.iso.datetime({ offset: true });

function hasCodePointLength(
  value: string,
  minimum: number,
  maximum: number,
): boolean {
  const length = Array.from(value).length;
  return length >= minimum && length <= maximum;
}

export const RunnerNameSchema = z
  .string()
  .refine((value) => value === value.trim(), {
    message: "must not have leading or trailing whitespace",
  })
  .refine((value) => hasCodePointLength(value, 1, 120), {
    message: "must contain between 1 and 120 Unicode code points",
  });

export const InstallationFingerprintSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/);

export const RunnerSecretSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const RunnerStatusSchema = z.enum(["enabled", "revoked"]);

export const PersistedRunnerIdentitySchema = z.strictObject({
  contractVersion: z.literal(RUNNER_IDENTITY_CONTRACT_VERSION),
  id: IdentifierSchema,
  revision: z.number().int().positive(),
  name: RunnerNameSchema,
  installationFingerprint: InstallationFingerprintSchema,
  status: RunnerStatusSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  revokedAt: TimestampSchema.nullable(),
});

export const RunnerVerifierRecordSchema = z.strictObject({
  kdf: z.literal("scrypt"),
  costN: z.literal(RUNNER_SCRYPT_N),
  blockSizeR: z.literal(RUNNER_SCRYPT_R),
  parallelizationP: z.literal(RUNNER_SCRYPT_P),
  saltHex: z.string().regex(/^[0-9a-f]{64}$/),
  verifierHex: z.string().regex(/^[0-9a-f]{64}$/),
});

export const EnrollmentChallengeSchema = z.strictObject({
  challengeId: IdentifierSchema,
  name: RunnerNameSchema,
  installationFingerprint: InstallationFingerprintSchema,
  expiresAt: TimestampSchema,
  ttlSeconds: z.literal(RUNNER_ENROLLMENT_CHALLENGE_TTL_SECONDS),
});

export const StartEnrollmentChallengeRequestSchema = z.strictObject({
  name: RunnerNameSchema,
  installationFingerprint: InstallationFingerprintSchema,
});

export const ConfirmEnrollmentRequestSchema = z.strictObject({
  ownerConfirmed: z.literal(true),
});

export const ConfirmEnrollmentResponseSchema = z.strictObject({
  runner: PersistedRunnerIdentitySchema,
  encoding: z.literal(RUNNER_SECRET_ENCODING),
  credentialBytes: z.literal(RUNNER_SECRET_BYTES),
  secret: RunnerSecretSchema.optional(),
});

export const RunnerIdParamsSchema = z.strictObject({
  runnerId: IdentifierSchema,
});

export const EnrollmentChallengeIdParamsSchema = z.strictObject({
  challengeId: IdentifierSchema,
});

export const RevokeRunnerRequestSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
});

export const RevokeRunnerResponseSchema = z.strictObject({
  runner: PersistedRunnerIdentitySchema,
  leasesFenced: z.number().int().nonnegative(),
  cancellationRequested: z.boolean(),
});

export const RunnerMutationQuerySchema = z.strictObject({});

export const RunnerHandshakeRequestSchema = z.strictObject({
  protocol: z.string().min(1).max(64),
  sessionId: IdentifierSchema,
  installationFingerprint: InstallationFingerprintSchema,
  eventSchemas: z.array(z.string().min(1).max(64)).min(1).max(16),
  buildVersion: z.string().min(1).max(128).optional(),
  architecture: z.string().min(1).max(64).optional(),
  kernel: z.string().min(1).max(128).optional(),
  capabilities: z.array(z.string().min(1).max(64)).max(32).optional(),
  registryDigest: InstallationFingerprintSchema.optional(),
  abandonedJournalReports: z.array(z.unknown()).max(1_024).optional(),
});

export const RunnerHandshakeAcceptedResponseSchema = z.strictObject({
  acceptedProtocol: z.literal(RUNNER_CONTROL_PROTOCOL),
  sessionId: IdentifierSchema,
  runnerId: IdentifierSchema,
  leaseAllowed: z.literal(true),
  sessionPinned: z.literal(true),
  registryPinned: z.boolean(),
});

export const AcquireRunnerLeaseRequestSchema = z.strictObject({
  sessionId: IdentifierSchema,
});

export const AcquireRunnerLeaseResponseSchema = z
  .strictObject({
    run: PersistedRunSchema,
    lease: RunnerLeaseSchema,
    actionSnapshot: ActionSnapshotSchema,
  })
  .superRefine((value, context) => {
    if (value.run.actionId !== value.actionSnapshot.actionId) {
      context.addIssue({
        code: "custom",
        message: "snapshot action mismatch",
        path: ["actionSnapshot", "actionId"],
      });
    }
    if (value.lease.runId !== value.run.id) {
      context.addIssue({
        code: "custom",
        message: "lease run mismatch",
        path: ["lease", "runId"],
      });
    }
    if (value.lease.fence !== value.run.currentFence) {
      context.addIssue({
        code: "custom",
        message: "lease fence mismatch",
        path: ["lease", "fence"],
      });
    }
  });

export const RunnerLeaseIdParamsSchema = z.strictObject({
  leaseId: IdentifierSchema,
});

export const RunnerHeartbeatRequestSchema = z.strictObject({
  runId: IdentifierSchema,
  sessionId: IdentifierSchema,
  fence: PositiveFencingTokenSchema,
  heartbeatSequence: RunnerSequenceSchema,
});

export const RunnerHeartbeatResponseSchema = z.strictObject({
  leaseExpiresAt: TimestampSchema,
  heartbeatSequence: RunnerSequenceSchema,
});

export const RunnerAppendStartedRequestSchema = z.strictObject({
  runId: IdentifierSchema,
  sessionId: IdentifierSchema,
  fence: PositiveFencingTokenSchema,
  sequence: RunnerSequenceSchema,
  payload: z.unknown().optional(),
});

export const RunnerCompleteRequestSchema = z.strictObject({
  runId: IdentifierSchema,
  sessionId: IdentifierSchema,
  fence: PositiveFencingTokenSchema,
  sequence: RunnerSequenceSchema,
  terminalKind: RunTerminalKindSchema,
  reason: RunTerminalReasonSchema.nullable(),
});

export const RunnerEventResponseSchema = z.strictObject({
  disposition: z.enum([
    "accepted_completion",
    "accepted_event",
    "stored_event_replayed",
    "stored_terminal_replayed",
  ]),
  event: PersistedRunEventSchema,
});

const RunnerRevisionConflictSchema = z.strictObject({
  code: z.literal("revision_conflict"),
  resourceType: z.literal("runner"),
  resourceId: IdentifierSchema,
  currentRevision: z.number().int().positive(),
});

// Codes returned only by the D3 evidence grant admission route.
export const RunnerEvidenceGrantErrorCodeSchema = z.enum([
  "artifact_upload_in_progress",
  "artifact_quota_exceeded",
  "concurrent_upload_limit",
  "staging_quota_exceeded",
  "run_quota_exceeded",
  "total_quota_exceeded",
]);

export const RunnerEvidenceGrantErrorSchema = z.strictObject({
  code: RunnerEvidenceGrantErrorCodeSchema,
});

const RunnerIdentityRequiredErrorSchema = z.strictObject({
  code: z.literal("runner_identity_required"),
});

export const RunnerProtocolUnsupportedErrorSchema = z.strictObject({
  code: z.literal("runner_protocol_unsupported"),
  supported: z.tuple([z.literal(RUNNER_CONTROL_PROTOCOL)]),
});

export const RunnerMutationErrorSchema = z.union([
  z.strictObject({ code: z.literal("invalid_request") }),
  z.strictObject({ code: z.literal("runner_unauthorized") }),
  z.strictObject({ code: z.literal("runner_route_forbidden") }),
  z.strictObject({ code: z.literal("enrollment_challenge_expired") }),
  z.strictObject({ code: z.literal("enrollment_challenge_reused") }),
  z.strictObject({ code: z.literal("enrollment_challenge_not_found") }),
  z.strictObject({ code: z.literal("runner_already_enabled") }),
  z.strictObject({ code: z.literal("runner_not_found") }),
  z.strictObject({ code: z.literal("runner_revoked") }),
  z.strictObject({ code: z.literal("runner_handshake_required") }),
  z.strictObject({ code: z.literal("runner_fingerprint_mismatch") }),
  RunnerProtocolUnsupportedErrorSchema,
  z.strictObject({ code: z.literal("no_work") }),
  z.strictObject({ code: z.literal("stale_fence") }),
  z.strictObject({ code: z.literal("lease_expired") }),
  z.strictObject({ code: z.literal("lease_owner_mismatch") }),
  z.strictObject({ code: z.literal("heartbeat_replay_conflict") }),
  z.strictObject({ code: z.literal("heartbeat_sequence_stale") }),
  z.strictObject({ code: z.literal("event_replay_conflict") }),
  z.strictObject({
    code: z.literal("event_sequence_gap"),
    expectedSequence: RunnerSequenceSchema,
  }),
  z.strictObject({ code: z.literal("run_already_terminal") }),
  z.strictObject({ code: z.literal("invalid_run_transition") }),
  RunnerIdentityRequiredErrorSchema,
  z.strictObject({ code: z.literal("operator_identity_required") }),
  RunnerEvidenceGrantErrorSchema,
  z.strictObject({ code: z.literal("idempotency_conflict") }),
  RunnerRevisionConflictSchema,
  z.strictObject({ code: z.literal("invalid_persisted_data") }),
  z.strictObject({ code: z.literal("storage_busy") }),
  // A backup snapshot holds the exclusive quiesce lock: publication is
  // paused, nothing about the grant or lease changed.
  z.strictObject({ code: z.literal("storage_backup_quiesced") }),
]);

export type RunnerName = z.infer<typeof RunnerNameSchema>;
export type EnrollmentChallenge = z.infer<typeof EnrollmentChallengeSchema>;
export type PersistedRunnerIdentity = z.infer<
  typeof PersistedRunnerIdentitySchema
>;
export type StartEnrollmentChallengeRequest = z.infer<
  typeof StartEnrollmentChallengeRequestSchema
>;
export type ConfirmEnrollmentRequest = z.infer<
  typeof ConfirmEnrollmentRequestSchema
>;
export type ConfirmEnrollmentResponse = z.infer<
  typeof ConfirmEnrollmentResponseSchema
>;
export type RevokeRunnerRequest = z.infer<typeof RevokeRunnerRequestSchema>;
export type RevokeRunnerResponse = z.infer<typeof RevokeRunnerResponseSchema>;
export type RunnerHandshakeRequest = z.infer<typeof RunnerHandshakeRequestSchema>;
export type RunnerHandshakeAcceptedResponse = z.infer<
  typeof RunnerHandshakeAcceptedResponseSchema
>;
export type AcquireRunnerLeaseRequest = z.infer<
  typeof AcquireRunnerLeaseRequestSchema
>;
export type AcquireRunnerLeaseResponse = z.infer<
  typeof AcquireRunnerLeaseResponseSchema
>;
export type RunnerHeartbeatRequest = z.infer<typeof RunnerHeartbeatRequestSchema>;
export type RunnerAppendStartedRequest = z.infer<
  typeof RunnerAppendStartedRequestSchema
>;
export type RunnerCompleteRequest = z.infer<typeof RunnerCompleteRequestSchema>;
export type RunnerMutationError = z.infer<typeof RunnerMutationErrorSchema>;
export type RunnerEvidenceGrantErrorCode = z.infer<
  typeof RunnerEvidenceGrantErrorCodeSchema
>;
export type RunnerEvidenceGrantError = z.infer<
  typeof RunnerEvidenceGrantErrorSchema
>;
export type RunnerVerifierRecord = z.infer<typeof RunnerVerifierRecordSchema>;
export type RunnerAuthorization =
  | { ok: true; runnerId: string; secret: string }
  | { ok: false };

const RUNNER_AUTHORIZATION_PATTERN =
  /^Stonehush-Runner ([^ \t]{1,255}) ([A-Za-z0-9_-]{43})$/;

export function isRunnerControlRoute(url: string): boolean {
  const path = url.split("?")[0] ?? url;
  return path === "/api/v1/runner" || path.startsWith(RUNNER_CONTROL_ROUTE_PREFIX);
}

export function parseRunnerAuthorizationHeader(
  value: string | undefined,
): RunnerAuthorization {
  if (value === undefined) return { ok: false };
  const matched = RUNNER_AUTHORIZATION_PATTERN.exec(value);
  if (matched === null) return { ok: false };
  return { ok: true, runnerId: matched[1] as string, secret: matched[2] as string };
}

export function formatRunnerAuthorization(
  runnerId: string,
  secret: string,
): string {
  return `${RUNNER_AUTHORIZATION_SCHEME} ${runnerId} ${secret}`;
}
