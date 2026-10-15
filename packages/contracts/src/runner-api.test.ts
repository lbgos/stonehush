import { describe, expect, it } from "vitest";

import fixtureData from "../../../docs/architecture/fixtures/d2/runner-identity.json" with {
  type: "json",
};
import {
  AcquireRunnerLeaseResponseSchema,
  ConfirmEnrollmentRequestSchema,
  ConfirmEnrollmentResponseSchema,
  InstallationFingerprintSchema,
  PersistedRunnerIdentitySchema,
  RunnerHandshakeRequestSchema,
  RunnerHeartbeatResponseSchema,
  RunnerMutationErrorSchema,
  RunnerEvidenceGrantErrorSchema,
  RunnerProtocolUnsupportedErrorSchema,
  RunnerSecretSchema,
  StartEnrollmentChallengeRequestSchema,
  formatRunnerAuthorization,
  isRunnerControlRoute,
  parseRunnerAuthorizationHeader,
} from "./runner-api.js";
import { RUNNER_CONTROL_PROTOCOL } from "./runner-control.js";
import { ActionSnapshotSchema } from "./action-planning.js";

const MUST_IMPLEMENT = [
  "d2.runner.enrollment-owner-confirmation",
  "d2.runner.enrollment-expired",
  "d2.runner.credential-hashed-at-rest",
  "d2.runner.route-separation",
  "d2.runner.protocol-handshake-accepted",
  "d2.runner.protocol-mismatch",
  "d2.runner.revocation-fences-work",
  "d2.runner.lost-credential-reenrollment",
] as const;

const DEFERRED: Record<string, string> = {
  "d2.runner.rotation-handover": "rotation handover / later owner",
  "d2.runner.required-capability-missing": "capability admission / later owner",
  "d2.runner.event-schema-unsupported": "event schema / later owner",
  "d2.runner.handshake-reports-abandoned-journals":
    "restart journals / later owner",
};

const fixtureFingerprint =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("runner identity contract fixture ownership", () => {
  it("implements or explicitly defers every D2 runner-identity case", () => {
    const implemented = new Set<string>(MUST_IMPLEMENT);
    for (const entry of fixtureData.cases) {
      const deferredOwner = DEFERRED[entry.id];
      if (deferredOwner !== undefined) {
        expect(implemented.has(entry.id), `${entry.id} must not be fake-passed`).toBe(
          false,
        );
        expect(deferredOwner.length).toBeGreaterThan(0);
        continue;
      }
      expect(implemented.has(entry.id), `${entry.id} has no owner`).toBe(true);
    }
  });
});

describe("runner API contracts", () => {
  it("accepts the enrollment confirmation envelope from the owner-confirmation fixture", () => {
    const spec = fixtureData.cases.find(
      (entry) => entry.id === "d2.runner.enrollment-owner-confirmation",
    );
    expect(spec).toBeDefined();
    expect(
      StartEnrollmentChallengeRequestSchema.safeParse({
        name: spec?.given.runnerName,
        installationFingerprint: spec?.given.installationFingerprint,
      }).success,
    ).toBe(true);
    expect(
      ConfirmEnrollmentRequestSchema.safeParse({ ownerConfirmed: true }).success,
    ).toBe(true);
    expect(
      ConfirmEnrollmentResponseSchema.safeParse({
        runner: {
          contractVersion: 1,
          id: "runner-fixture-1",
          revision: 1,
          name: "fixture-runner",
          installationFingerprint: fixtureFingerprint,
          status: "enabled",
          createdAt: "2026-08-09T12:00:00.000Z",
          updatedAt: "2026-08-09T12:00:00.000Z",
          revokedAt: null,
        },
        encoding: "base64url",
        credentialBytes: 32,
        secret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }).success,
    ).toBe(true);
  });

  it("rejects a redisplayable identity document that includes verifier material", () => {
    expect(
      PersistedRunnerIdentitySchema.safeParse({
        contractVersion: 1,
        id: "runner-fixture-1",
        revision: 1,
        name: "fixture-runner",
        installationFingerprint: fixtureFingerprint,
        status: "enabled",
        createdAt: "2026-08-09T12:00:00.000Z",
        updatedAt: "2026-08-09T12:00:00.000Z",
        revokedAt: null,
        secret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }).success,
    ).toBe(false);
    expect(RunnerSecretSchema.safeParse("not-a-secret").success).toBe(false);
    expect(InstallationFingerprintSchema.safeParse("sha256:zz").success).toBe(
      false,
    );
  });

  it("accepts runner-control-v1 handshake input and pins the 426 mismatch shape", () => {
    expect(
      RunnerHandshakeRequestSchema.safeParse({
        protocol: RUNNER_CONTROL_PROTOCOL,
        sessionId: "session-fixture-1",
        installationFingerprint: fixtureFingerprint,
        eventSchemas: ["runner-event-v1"],
        registryDigest: `sha256:${"b".repeat(64)}`,
      }).success,
    ).toBe(true);
    expect(
      RunnerProtocolUnsupportedErrorSchema.safeParse({
        code: "runner_protocol_unsupported",
        supported: [RUNNER_CONTROL_PROTOCOL],
      }).success,
    ).toBe(true);
    expect(
      RunnerMutationErrorSchema.safeParse({
        code: "runner_protocol_unsupported",
        supported: [RUNNER_CONTROL_PROTOCOL],
      }).success,
    ).toBe(true);
  });

  it("parses D3 grant admission errors as strict {code} objects", () => {
    for (const code of [
      "artifact_upload_in_progress",
      "artifact_quota_exceeded",
      "concurrent_upload_limit",
      "staging_quota_exceeded",
      "run_quota_exceeded",
      "total_quota_exceeded",
    ] as const) {
      expect(
        RunnerMutationErrorSchema.safeParse({ code }).success,
        code,
      ).toBe(true);
    }
    // Wire errors are objects, never bare strings.
    expect(RunnerMutationErrorSchema.safeParse("concurrent_upload_limit").success).toBe(
      false,
    );
    expect(RunnerEvidenceGrantErrorSchema.safeParse({ code: "stale_fence" }).success).toBe(
      false,
    );
  });

  it("separates runner control routes from operator enrollment and engagement routes", () => {
    expect(isRunnerControlRoute("/api/v1/runner/lease")).toBe(true);
    expect(isRunnerControlRoute("/api/v1/runner/handshake?x=1")).toBe(true);
    expect(isRunnerControlRoute("/api/v1/runners/enrollment-challenges")).toBe(
      false,
    );
    expect(isRunnerControlRoute("/api/v1/engagements")).toBe(false);
    expect(isRunnerControlRoute("/api/v1/actions")).toBe(false);
  });

  it("parses the runner selector and secret without treating operator headers as credentials", () => {
    const header = formatRunnerAuthorization(
      "runner-fixture-1",
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
    expect(parseRunnerAuthorizationHeader(header)).toEqual({
      ok: true,
      runnerId: "runner-fixture-1",
      secret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(parseRunnerAuthorizationHeader("Bearer operator-token")).toEqual({
      ok: false,
    });
    expect(parseRunnerAuthorizationHeader(undefined)).toEqual({ ok: false });
  });

  it("requires canonical actionSnapshot in AcquireRunnerLeaseResponse and rejects strict mismatches", () => {
    const validSnapshot = {
      normalizationProfile: "d1-v1" as const,
      orchestrationProfile: "d2-v1" as const,
      snapshotId: "snapshot-fixture-lease",
      version: 1,
      binding: `sha256:${"a".repeat(64)}`,
      actionId: "action-fixture-lease",
      canonicalTargets: [
        {
          normalizationProfile: "d1-v1" as const,
          kind: "hostname" as const,
          hostname: "app.target.test",
        },
      ],
      concreteDestinations: [
        {
          normalizationProfile: "d1-v1" as const,
          kind: "ip" as const,
          family: 4 as const,
          address: "192.0.2.10",
          zone: null,
        },
      ],
      typedOptions: { fixture: true },
      resolutionSnapshots: [],
      scopeRevisionId: null,
      warningState: {
        reasonCodes: [],
        knownAdditions: [],
        acknowledgment: null,
      },
    } as const;
    expect(ActionSnapshotSchema.safeParse(validSnapshot).success).toBe(true);
    const validRun = {
      contractVersion: 1 as const,
      id: "run-fixture-lease-1",
      actionId: "action-fixture-lease",
      engagementId: "engagement-fixture-1",
      attempt: 1,
      state: "leased" as const,
      currentLeaseId: "lease-fixture-1",
      currentFence: "1" as const,
      terminalKind: null,
      terminalReason: null,
      createdAt: "2026-08-09T12:00:00.000Z",
      updatedAt: "2026-08-09T12:00:00.000Z",
    } as const;
    const validLease = {
      orchestrationProfile: "d2-v1" as const,
      protocol: "runner-control-v1" as const,
      runId: "run-fixture-lease-1",
      leaseId: "lease-fixture-1",
      runnerId: "runner-fixture-1",
      sessionId: "session-fixture-1",
      fence: "1" as const,
      expiresAt: "2026-08-09T12:00:30.000Z",
      latestHeartbeatSequence: 0,
      latestEventSequence: 0,
    } as const;
    const validResponse = {
      run: validRun,
      lease: validLease,
      actionSnapshot: validSnapshot,
    };
    expect(AcquireRunnerLeaseResponseSchema.safeParse(validResponse).success).toBe(true);
    // strict: missing snapshot
    expect(
      AcquireRunnerLeaseResponseSchema.safeParse({ run: validRun, lease: validLease }).success,
    ).toBe(false);
    // strict: extra top-level field
    expect(
      AcquireRunnerLeaseResponseSchema.safeParse({ ...validResponse, extra: "evil" }).success,
    ).toBe(false);
    // strict: extra field inside snapshot
    expect(
      AcquireRunnerLeaseResponseSchema.safeParse({
        ...validResponse,
        actionSnapshot: { ...validSnapshot, extra: "evil" },
      }).success,
    ).toBe(false);
    // malformed snapshot: invalid hostname (non-synthetic but also invalid shape)
    expect(
      AcquireRunnerLeaseResponseSchema.safeParse({
        ...validResponse,
        actionSnapshot: { ...validSnapshot, canonicalTargets: [] },
      }).success,
    ).toBe(false);
    // mismatched snapshot actionId (untrusted tampering)
    expect(
      AcquireRunnerLeaseResponseSchema.safeParse({
        ...validResponse,
        actionSnapshot: { ...validSnapshot, actionId: "action-tampered" },
      }).success,
    ).toBe(false);
    // mismatched lease runId
    expect(
      AcquireRunnerLeaseResponseSchema.safeParse({
        ...validResponse,
        lease: { ...validLease, runId: "run-tampered" },
      }).success,
    ).toBe(false);
    // mismatched fence
    expect(
      AcquireRunnerLeaseResponseSchema.safeParse({
        ...validResponse,
        lease: { ...validLease, fence: "2" },
      }).success,
    ).toBe(false);
    // malformed binding (fails opaque binding shape)
    expect(
      AcquireRunnerLeaseResponseSchema.safeParse({
        ...validResponse,
        actionSnapshot: { ...validSnapshot, binding: "sha256:!!!" },
      }).success,
    ).toBe(false);
    // arbitrary JSON rejected (no parallel type)
    expect(
      AcquireRunnerLeaseResponseSchema.safeParse({
        run: validRun,
        lease: validLease,
        actionSnapshot: { arbitrary: "json" },
      }).success,
    ).toBe(false);
  });
});


it("accepts old heartbeat responses and validates optional cancellation intent", () => {
  const response = { leaseExpiresAt: "2026-08-09T12:00:30.000Z", heartbeatSequence: 1 };
  expect(RunnerHeartbeatResponseSchema.parse(response).cancellationRequested).toBeUndefined();
  expect(RunnerHeartbeatResponseSchema.parse({ ...response, cancellationRequested: true }).cancellationRequested).toBe(true);
  expect(RunnerHeartbeatResponseSchema.safeParse({ ...response, cancellationRequested: "true" }).success).toBe(false);
});
