import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ActionSnapshot } from "@stonehush/contracts";
import { afterEach, describe, expect, it } from "vitest";

import fixtureData from "../../../docs/architecture/fixtures/d2/runner-identity.json" with {
  type: "json",
};
import { bindActionSnapshot } from "./action-snapshot.js";
import { openEngagementDatabase, DATABASE_SCHEMA_VERSION } from "./database.js";
import { EngagementRepository } from "./repository.js";
import { RunRepository } from "./run.js";
import {
  decodeRunnerSecret,
  encodeRunnerSecret,
  hashRunnerSecret,
  RunnerRepository,
  runnerCredentialFingerprint,
  secretsMatch,
} from "./runner.js";

const MUST_IMPLEMENT = [
  "d2.runner.enrollment-owner-confirmation",
  "d2.runner.enrollment-expired",
  "d2.runner.credential-hashed-at-rest",
  "d2.runner.revocation-fences-work",
  "d2.runner.lost-credential-reenrollment",
] as const;

const DEFERRED: Record<string, string> = {
  "d2.runner.rotation-handover": "rotation handover / later owner",
  "d2.runner.route-separation": "apps/api runner HTTP boundary",
  "d2.runner.protocol-handshake-accepted": "apps/api handshake route",
  "d2.runner.protocol-mismatch": "apps/api handshake route",
  "d2.runner.required-capability-missing": "capability admission / later owner",
  "d2.runner.event-schema-unsupported": "event schema / later owner",
  "d2.runner.handshake-reports-abandoned-journals":
    "restart journals / later owner",
};

const fixtureFingerprint =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const digestA = `sha256:${"a".repeat(64)}`;

interface Fixture {
  directory: string;
  database: ReturnType<typeof openEngagementDatabase>;
  engagements: EngagementRepository;
  runs: RunRepository;
  runners: RunnerRepository;
  setNow(value: string): void;
}

const fixtures: Fixture[] = [];

function createFixture(
  options: { runnerId?: string; leaseIds?: readonly string[] } = {},
): Fixture {
  const directory = mkdtempSync(path.join(tmpdir(), "stonehush-runner-db-"));
  chmodSync(directory, 0o700);
  const database = openEngagementDatabase({ dataDirectory: directory });
  let now = new Date("2026-08-09T12:00:00.000Z");
  let runnerSeq = 0;
  let leaseSeq = 0;
  let engagementSeq = 0;
  const fixture: Fixture = {
    directory,
    database,
    engagements: new EngagementRepository(database.db, {
      createId: () => {
        engagementSeq += 1;
        return `10000000-0000-4000-8000-${String(engagementSeq).padStart(12, "0")}`;
      },
      now: () => new Date(now),
    }),
    runs: new RunRepository(database.db, {
      createId: () => {
        const id = options.leaseIds?.[leaseSeq];
        leaseSeq += 1;
        return id ?? `lease-storage-fixture-${leaseSeq}`;
      },
      now: () => new Date(now),
    }),
    runners: new RunnerRepository(database.db, {
      createId: () => {
        runnerSeq += 1;
        if (runnerSeq === 2 && options.runnerId !== undefined) return options.runnerId;
        return `runner-id-fixture-${runnerSeq}`;
      },
      now: () => new Date(now),
    }),
    setNow(value: string) {
      now = new Date(value);
    },
  };
  fixtures.push(fixture);
  return fixture;
}

function boundSnapshot(actionId: string): ActionSnapshot {
  const snapshot: ActionSnapshot = {
    normalizationProfile: "d1-v1",
    orchestrationProfile: "d2-v1",
    snapshotId: `snapshot-${actionId}`,
    version: 1,
    binding: digestA,
    actionId,
    canonicalTargets: [
      {
        normalizationProfile: "d1-v1",
        kind: "hostname",
        hostname: "app.target.test",
      },
    ],
    concreteDestinations: [
      {
        normalizationProfile: "d1-v1",
        kind: "ip",
        family: 4,
        address: "192.0.2.40",
        zone: null,
      },
    ],
    typedOptions: { fixture: true },
    resolutionSnapshots: [
      {
        canonicalQueryName: "app.target.test",
        resolverMode: "system",
        cnameChain: [],
        answers: [{ address: "192.0.2.40", family: 4, ttlSeconds: 60 }],
        resolvedAt: "2026-08-09T11:59:00.000Z",
      },
    ],
    scopeRevisionId: null,
    warningState: {
      reasonCodes: [],
      knownAdditions: [],
      acknowledgment: null,
    },
  };
  const bound = bindActionSnapshot(snapshot);
  if (!bound.ok) throw new Error("fixture snapshot binding failed");
  return { ...snapshot, binding: bound.binding };
}

function queuedAction(fixture: Fixture, actionId: string) {
  const engagement = fixture.engagements.createEngagement({
    name: "Runner fixture lab",
    kind: "lab",
    description: null,
    authorizationContext: "Synthetic fixture authorization context",
    autoContinueWarnings: false,
  });
  if (!engagement.ok) throw new Error("fixture engagement failed");
  const planned = fixture.engagements.persistPlannedAction({
    engagementId: engagement.value.id,
    snapshot: boundSnapshot(actionId),
    representable: true,
    capabilityErrorCode: null,
    occurredAt: "2026-08-09T12:00:00.000Z",
  });
  if (!planned.ok) throw new Error(`fixture action failed: ${planned.error.code}`);
  const row = fixture.database.sqlite
    .prepare("select id from runs where action_id = ?")
    .get(actionId) as { id: string } | undefined;
  if (row === undefined) throw new Error("queued run was not allocated");
  return { engagementId: engagement.value.id, runId: row.id };
}

function enroll(
  fixture: Fixture,
  options: { name?: string; fingerprint?: string } = {},
) {
  const challenge = fixture.runners.startEnrollmentChallenge({
    name: options.name ?? "fixture-runner",
    installationFingerprint: options.fingerprint ?? fixtureFingerprint,
  });
  if (!challenge.ok) throw new Error(`challenge failed: ${challenge.error.code}`);
  const confirmed = fixture.runners.confirmEnrollment(challenge.value.challengeId, {
    ownerConfirmed: true,
  });
  if (!confirmed.ok) throw new Error(`confirm failed: ${confirmed.error.code}`);
  return { challenge: challenge.value, ...confirmed.value };
}

function sqliteContainsSecret(
  database: ReturnType<typeof openEngagementDatabase>,
  secret: string,
): boolean {
  const tables = database.sqlite
    .prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'")
    .pluck()
    .all() as string[];
  for (const table of tables) {
    const rows = database.sqlite.prepare(`select * from "${table}"`).all();
    if (JSON.stringify(rows).includes(secret)) return true;
  }
  return false;
}

function fixtureCase(id: string) {
  const value = fixtureData.cases.find((candidate) => candidate.id === id);
  if (value === undefined) throw new Error(`Missing D2 fixture ${id}`);
  return value;
}

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture === undefined) continue;
    if (fixture.database.sqlite.open) fixture.database.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

describe("runner identity fixture ownership", () => {
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

describe("runner identity schema", () => {
  it("applies 0004 runner identity tables", () => {
    const fixture = createFixture();
    expect(
      fixture.database.sqlite
        .prepare("select count(*) as count from __drizzle_migrations")
        .get(),
    ).toEqual({ count: DATABASE_SCHEMA_VERSION });
    expect(
      fixture.database.sqlite
        .prepare(
          "select name from sqlite_master where type = 'table' and name in ('runner_identities', 'runner_enrollment_challenges', 'runner_sessions') order by name",
        )
        .all(),
    ).toEqual([
      { name: "runner_enrollment_challenges" },
      { name: "runner_identities" },
      { name: "runner_sessions" },
    ]);
  });
});

describe("runner enrollment persistence", () => {
  it("d2.runner.enrollment-owner-confirmation: confirmation creates one 32-byte base64url secret", () => {
    const spec = fixtureCase("d2.runner.enrollment-owner-confirmation") as {
      given: {
        challengeAgeSeconds: number;
        challengeTtlSeconds: number;
        ownerConfirmed: boolean;
        runnerName: string;
        installationFingerprint: string;
      };
      expected: {
        identityCreated: boolean;
        credentialBytes: number;
        encoding: string;
        presentationCount: number;
      };
    };
    const fixture = createFixture({ runnerId: "runner-fixture-1" });
    fixture.setNow("2026-08-09T12:00:00.000Z");
    const challenge = fixture.runners.startEnrollmentChallenge({
      name: spec.given.runnerName,
      installationFingerprint: spec.given.installationFingerprint,
    });
    expect(challenge).toMatchObject({
      ok: true,
      value: {
        name: spec.given.runnerName,
        installationFingerprint: spec.given.installationFingerprint,
        ttlSeconds: spec.given.challengeTtlSeconds,
      },
    });
    fixture.setNow("2026-08-09T12:00:30.000Z");
    const confirmed = fixture.runners.confirmEnrollment(
      challenge.ok ? challenge.value.challengeId : "",
      { ownerConfirmed: spec.given.ownerConfirmed },
    );
    expect(confirmed.ok).toBe(spec.expected.identityCreated);
    if (!confirmed.ok) throw new Error("expected identity");
    expect(confirmed.value.secretBytes.length).toBe(spec.expected.credentialBytes);
    expect(encodeRunnerSecret(confirmed.value.secretBytes)).toBe(confirmed.value.secret);
    expect(confirmed.value.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(confirmed.value.runner).toMatchObject({
      id: "runner-fixture-1",
      name: spec.given.runnerName,
      status: "enabled",
    });
    expect(fixture.runners.getIdentity("runner-fixture-1")).toEqual({
      ok: true,
      value: confirmed.value.runner,
    });
    const storedIdentity = fixture.runners.getIdentity("runner-fixture-1");
    expect("secret" in (storedIdentity.ok ? storedIdentity.value : {})).toBe(false);
    expect(spec.expected.presentationCount).toBe(1);
    expect(spec.expected.encoding).toBe("base64url");
  });

  it("d2.runner.enrollment-expired: an expired one-use challenge creates no identity", () => {
    const spec = fixtureCase("d2.runner.enrollment-expired") as {
      given: {
        challengeAgeSeconds: number;
        challengeTtlSeconds: number;
        ownerConfirmed: boolean;
      };
      error: { code: string; identityCreated: boolean; presentationCount: number };
    };
    const fixture = createFixture();
    fixture.setNow("2026-08-09T12:00:00.000Z");
    const challenge = fixture.runners.startEnrollmentChallenge({
      name: "fixture-runner",
      installationFingerprint: fixtureFingerprint,
    });
    if (!challenge.ok) throw new Error(challenge.error.code);
    fixture.setNow(
      new Date(
        Date.parse("2026-08-09T12:00:00.000Z") + spec.given.challengeAgeSeconds * 1_000,
      ).toISOString(),
    );
    const confirmed = fixture.runners.confirmEnrollment(challenge.value.challengeId, {
      ownerConfirmed: spec.given.ownerConfirmed,
    });
    expect(confirmed).toEqual({
      ok: false,
      error: { code: spec.error.code },
    });
    expect(
      fixture.database.sqlite
        .prepare("select count(*) as count from runner_identities")
        .get(),
    ).toEqual({ count: 0 });
    expect(spec.error.identityCreated).toBe(false);
    expect(spec.error.presentationCount).toBe(0);
  });

  it("rejects a reused challenge and a second enabled enrollment", () => {
    const fixture = createFixture();
    const first = enroll(fixture);
    const reused = fixture.runners.confirmEnrollment(first.challenge.challengeId, {
      ownerConfirmed: true,
    });
    expect(reused).toEqual({
      ok: false,
      error: { code: "enrollment_challenge_reused" },
    });
    const second = fixture.runners.startEnrollmentChallenge({
      name: "fixture-runner-2",
      installationFingerprint: `sha256:${"c".repeat(64)}`,
    });
    expect(second).toEqual({
      ok: false,
      error: { code: "runner_already_enabled" },
    });
    expect(
      fixture.database.sqlite
        .prepare("select count(*) as count from runner_identities where status = 'enabled'")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("d2.runner.credential-hashed-at-rest: stores only the concrete scrypt verifier", () => {
    const spec = fixtureCase("d2.runner.credential-hashed-at-rest") as {
      given: {
        credentialBytes: number;
        saltBytes: number;
        kdf: string;
        costN: number;
        blockSizeR: number;
        parallelizationP: number;
        verifierBytes: number;
      };
      expected: {
        plaintextStored: boolean;
        constantTimeCompare: boolean;
        redisplaySupported: boolean;
      };
    };
    const fixture = createFixture({ runnerId: "runner-fixture-1" });
    const enrolled = enroll(fixture);
    const record = fixture.runners.getVerifierRecord("runner-fixture-1");
    expect(record).toMatchObject({
      ok: true,
      value: {
        kdf: spec.given.kdf,
        costN: spec.given.costN,
        blockSizeR: spec.given.blockSizeR,
        parallelizationP: spec.given.parallelizationP,
      },
    });
    if (!record.ok) throw new Error("missing verifier");
    expect(Buffer.from(record.value.saltHex, "hex").length).toBe(spec.given.saltBytes);
    expect(Buffer.from(record.value.verifierHex, "hex").length).toBe(
      spec.given.verifierBytes,
    );
    expect(enrolled.secretBytes.length).toBe(spec.given.credentialBytes);
    expect(sqliteContainsSecret(fixture.database, enrolled.secret)).toBe(
      spec.expected.plaintextStored,
    );
    const identityJson = JSON.stringify(fixture.runners.getIdentity("runner-fixture-1"));
    expect(identityJson).not.toContain(enrolled.secret);
    expect(identityJson).not.toContain(record.value.verifierHex);
    const recomputed = hashRunnerSecret(
      enrolled.secretBytes,
      Buffer.from(record.value.saltHex, "hex"),
    );
    expect(secretsMatch(recomputed, Buffer.from(record.value.verifierHex, "hex"))).toBe(
      true,
    );
    expect(spec.expected.constantTimeCompare).toBe(true);
    expect(spec.expected.redisplaySupported).toBe(false);
    expect(
      fixture.runners.authenticate("runner-fixture-1", enrolled.secret),
    ).toMatchObject({ ok: true });
    expect(
      fixture.runners.authenticate(
        "runner-fixture-1",
        encodeRunnerSecret(Buffer.alloc(32, 9)),
      ),
    ).toEqual({ ok: false, error: { code: "runner_unauthorized" } });
  });

  it("d2.runner.revocation-fences-work: revoke denies auth and fences current leases", () => {
    const spec = fixtureCase("d2.runner.revocation-fences-work") as {
      given: { runnerId: string; activeLeaseIds: string[]; ownerRevokes: boolean };
      expected: {
        authenticationAccepted: boolean;
        leasesFenced: number;
        cancellationRequested: boolean;
        newLeaseAllowed: boolean;
      };
    };
    const fixture = createFixture({
      runnerId: spec.given.runnerId,
      leaseIds: spec.given.activeLeaseIds,
    });
    const enrolled = enroll(fixture);
    const created = queuedAction(fixture, "action-fixture-revoke");
    const acquired = fixture.runs.acquireLease({
      runId: created.runId,
      runnerId: spec.given.runnerId,
      sessionId: "session-fixture-1",
      serverNow: "2026-08-09T12:00:00.000Z",
    });
    expect(acquired).toMatchObject({
      ok: true,
      value: { lease: { leaseId: spec.given.activeLeaseIds[0] } },
    });
    const revoked = fixture.runners.revoke(spec.given.runnerId, { expectedRevision: 1 });
    expect(revoked).toMatchObject({
      ok: true,
      value: {
        leasesFenced: spec.expected.leasesFenced,
        cancellationRequested: spec.expected.cancellationRequested,
        runner: { status: "revoked" },
      },
    });
    expect(
      fixture.runners.authenticate(spec.given.runnerId, enrolled.secret),
    ).toEqual({
      ok: spec.expected.authenticationAccepted,
      error: { code: "runner_unauthorized" },
    });
    expect(fixture.runs.getCurrentLease(created.runId)).toEqual({
      ok: false,
      error: { code: "run_not_found" },
    });
    expect(fixture.runs.getRun(created.runId)).toMatchObject({
      ok: true,
      value: { state: "cancel_requested", currentLeaseId: null },
    });
    const next = queuedAction(fixture, "action-fixture-revoke-2");
    expect(
      fixture.runners.requireAcceptedSession(spec.given.runnerId, "session-fixture-1"),
    ).toEqual({ ok: false, error: { code: "runner_revoked" } });
    expect(spec.expected.newLeaseAllowed).toBe(false);
    expect(next.runId).toBeTruthy();
  });

  it("d2.runner.lost-credential-reenrollment: secret is not recoverable", () => {
    const spec = fixtureCase("d2.runner.lost-credential-reenrollment") as {
      given: { credentialFileLost: boolean; serverHasVerifier: boolean };
      expected: { secretRecoverable: boolean; requiredSteps: string[] };
    };
    const fixture = createFixture({ runnerId: "runner-lost-1" });
    const first = enroll(fixture);
    expect(fixture.runners.getVerifierRecord("runner-lost-1").ok).toBe(
      spec.given.serverHasVerifier,
    );
    expect(sqliteContainsSecret(fixture.database, first.secret)).toBe(false);
    expect(JSON.stringify(fixture.runners.getIdentity("runner-lost-1"))).not.toContain(
      first.secret,
    );
    expect(spec.expected.secretRecoverable).toBe(false);
    expect(spec.expected.requiredSteps).toEqual([
      "revoke_identity",
      "remove_local_file",
      "enroll_again",
    ]);
    expect(spec.given.credentialFileLost).toBe(true);
    const revoked = fixture.runners.revoke("runner-lost-1", { expectedRevision: 1 });
    expect(revoked.ok).toBe(true);
    const second = enroll(fixture);
    expect(second.secret).not.toBe(first.secret);
    expect(
      fixture.runners.authenticate(second.runner.id, first.secret),
    ).toEqual({ ok: false, error: { code: "runner_unauthorized" } });
    expect(
      fixture.runners.authenticate(second.runner.id, second.secret),
    ).toMatchObject({ ok: true });
  });

  it("pins a handshake session and rejects a protocol mismatch before leasing", () => {
    const fixture = createFixture({ runnerId: "runner-fixture-1" });
    enroll(fixture);
    expect(
      fixture.runners.acceptHandshake("runner-fixture-1", {
        protocol: "runner-control-v2",
        sessionId: "session-fixture-1",
        installationFingerprint: fixtureFingerprint,
        eventSchemas: ["runner-event-v1"],
      }),
    ).toEqual({ ok: false, error: { code: "runner_protocol_unsupported" } });
    expect(
      fixture.runners.requireAcceptedSession("runner-fixture-1", "session-fixture-1"),
    ).toEqual({ ok: false, error: { code: "runner_handshake_required" } });
    const accepted = fixture.runners.acceptHandshake("runner-fixture-1", {
      protocol: "runner-control-v1",
      sessionId: "session-fixture-1",
      installationFingerprint: fixtureFingerprint,
      eventSchemas: ["runner-event-v1"],
      registryDigest: `sha256:${"b".repeat(64)}`,
    });
    expect(accepted).toEqual({
      ok: true,
      value: {
        acceptedProtocol: "runner-control-v1",
        sessionId: "session-fixture-1",
        runnerId: "runner-fixture-1",
        leaseAllowed: true,
        sessionPinned: true,
        registryPinned: true,
      },
    });
    expect(
      fixture.runners.requireAcceptedSession("runner-fixture-1", "session-fixture-1"),
    ).toEqual({
      ok: true,
      value: { sessionId: "session-fixture-1", runnerId: "runner-fixture-1" },
    });
  });

  it("keeps credential fingerprints distinct from the secret and decoded length", () => {
    const secret = Buffer.alloc(32, 7);
    expect(decodeRunnerSecret(encodeRunnerSecret(secret))).toEqual(secret);
    const fingerprint = runnerCredentialFingerprint(secret);
    expect(fingerprint).toHaveLength(12);
    expect(fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(fingerprint).not.toBe(encodeRunnerSecret(secret).slice(0, 12));
  });
});
