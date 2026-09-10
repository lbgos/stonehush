import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { Objective, Secret } from "@blackglass/contracts";

import { registerObjectiveRoutes } from "./objective-routes.js";
import { registerSecretRoutes } from "./secret-routes.js";

const ENGAGEMENT_ID = "10000000-0000-4000-8000-000000000001";
const TS = "2026-08-12T12:00:00.000Z";
const PROOF = "flag{synthetic-proof-0001}";

function objectiveRecord(overrides: Partial<Objective> = {}): Objective {
  return {
    contractVersion: 1,
    id: "10000000-0000-4000-8000-000000000003",
    engagementId: ENGAGEMENT_ID,
    name: "user flag",
    kind: "user_flag",
    state: "open",
    proofHint: null,
    proofDigest: null,
    capturedAt: null,
    submittedAt: null,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

function buildObjectiveApp() {
  const app = Fastify();
  let objective = objectiveRecord();
  registerObjectiveRoutes(app, {
    createObjective: () => ({ ok: true as const, value: objective }),
    listObjectives: () => ({ ok: true as const, value: [objective] }),
    getObjective: () => ({ ok: true as const, value: objective }),
    captureObjective: () => {
      objective = {
        ...objective,
        state: "captured",
        proofHint: "24 bytes",
        proofDigest: `sha256:${"0".repeat(64)}`,
        capturedAt: TS,
      };
      return { ok: true as const, value: objective };
    },
    submitObjective: () => {
      if (objective.state !== "captured") {
        return {
          ok: false as const,
          error: { code: "invalid_objective_transition" as const },
        };
      }
      objective = { ...objective, state: "submitted", submittedAt: TS };
      return { ok: true as const, value: objective };
    },
    reopenObjective: () => {
      objective = objectiveRecord();
      return { ok: true as const, value: objective };
    },
  });
  return app;
}

describe("objective routes", () => {
  it("creates, captures with masked values, and submits as distinct steps", async () => {
    const app = buildObjectiveApp();
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/objectives`,
      payload: { name: "user flag", kind: "user_flag" },
    });
    expect(created.statusCode).toBe(201);
    const captured = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/objectives/${objectiveRecord().id}/capture`,
      payload: { proofValue: PROOF },
    });
    expect(captured.statusCode).toBe(200);
    const body = captured.json() as Record<string, unknown>;
    expect(body["state"]).toBe("captured");
    expect(JSON.stringify(body)).not.toContain(PROOF);
    expect(body["proofHint"]).not.toBe(null);
    const submitted = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/objectives/${objectiveRecord().id}/submit`,
      payload: {},
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json()).toMatchObject({ state: "submitted" });
    await app.close();
  });

  it("rejects score theater on creation", async () => {
    const app = buildObjectiveApp();
    const bad = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/objectives`,
      payload: { name: "user flag", kind: "user_flag", score: 50 },
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });
});

function secretRecord(overrides: Partial<Secret> = {}): Secret {
  return {
    contractVersion: 1,
    id: "10000000-0000-4000-8000-000000000004",
    engagementId: ENGAGEMENT_ID,
    label: "SSH password for app host",
    username: "operator",
    serviceRef: "192.0.2.10:22/ssh",
    secretRef: "vault:stone/lab-app-ssh",
    hint: "12 chars",
    verifications: [],
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

function buildSecretApp() {
  const app = Fastify();
  let secret = secretRecord();
  registerSecretRoutes(app, {
    createSecret: () => ({ ok: true as const, value: secret }),
    listSecrets: () => ({ ok: true as const, value: [secret] }),
    getSecret: () => ({ ok: true as const, value: secret }),
    recordVerification: (_engagementId: string, _secretId: string, input: unknown) => {
      const body = input as { result: "verified" | "failed"; method: string };
      secret = {
        ...secret,
        verifications: [
          { at: TS, result: body.result, method: body.method, note: null },
        ],
      };
      return { ok: true as const, value: secret };
    },
  });
  return app;
}

describe("secret routes", () => {
  it("creates and lists reference-only secrets with no value anywhere", async () => {
    const app = buildSecretApp();
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/secrets`,
      payload: {
        label: "SSH password for app host",
        serviceRef: "192.0.2.10:22/ssh",
        secretRef: "vault:stone/lab-app-ssh",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(JSON.stringify(created.json())).not.toContain("synthetic-secret-001");
    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/secrets`,
    });
    expect(listed.statusCode).toBe(200);
    const listedBody = listed.json() as unknown[];
    expect(listedBody).toHaveLength(1);
    expect("value" in (listedBody[0] as Record<string, unknown>)).toBe(false);
    await app.close();
  });

  it("rejects plaintext value fields and records verifications without values", async () => {
    const app = buildSecretApp();
    const bad = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/secrets`,
      payload: {
        label: "SSH password",
        serviceRef: "192.0.2.10:22/ssh",
        secretRef: "vault:stone/lab-app-ssh",
        value: "synthetic-secret-001",
      },
    });
    expect(bad.statusCode).toBe(400);
    const verified = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/secrets/${secretRecord().id}/verifications`,
      payload: { result: "verified", method: "ssh login" },
    });
    expect(verified.statusCode).toBe(201);
    const body = verified.json() as { verifications: unknown[] };
    expect(body.verifications).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("synthetic-secret-001");
    await app.close();
  });
});
