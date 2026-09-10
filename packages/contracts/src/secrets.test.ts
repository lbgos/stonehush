import { describe, expect, it } from "vitest";

import {
  CreateSecretRequestSchema,
  RecordSecretVerificationRequestSchema,
  SecretResponseSchema,
} from "./secrets.js";

const SECRET_ID = "10000000-0000-4000-8000-000000000004";
const ENGAGEMENT_ID = "10000000-0000-4000-8000-000000000002";

function secretRecord(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: 1,
    id: SECRET_ID,
    engagementId: ENGAGEMENT_ID,
    label: "SSH password for app host",
    username: "operator",
    serviceRef: "192.0.2.10:22/ssh",
    secretRef: "vault:stone/lab-app-ssh",
    hint: "12 chars",
    verifications: [],
    createdAt: "2026-08-12T12:00:00.000Z",
    updatedAt: "2026-08-12T12:00:00.000Z",
    ...overrides,
  };
}

describe("secret contracts", () => {
  it("creates an explicit sensitive record with a service-scoped reference", () => {
    const result = CreateSecretRequestSchema.safeParse({
      label: "SSH password for app host",
      username: "operator",
      serviceRef: "192.0.2.10:22/ssh",
      secretRef: "vault:stone/lab-app-ssh",
    });
    expect(result.success).toBe(true);
    expect(SecretResponseSchema.safeParse(secretRecord()).success).toBe(true);
  });

  it("never carries a plaintext value: value fields are rejected", () => {
    for (const extra of ["value", "password", "secret", "plaintext"]) {
      const request = CreateSecretRequestSchema.safeParse({
        label: "SSH password for app host",
        serviceRef: "192.0.2.10:22/ssh",
        secretRef: "vault:stone/lab-app-ssh",
        [extra]: "synthetic-secret-001",
      });
      expect(request.success).toBe(false);
      const response = SecretResponseSchema.safeParse(
        secretRecord({ [extra]: "synthetic-secret-001" }),
      );
      expect(response.success).toBe(false);
    }
  });

  it("records verification history without values", () => {
    const result = RecordSecretVerificationRequestSchema.safeParse({
      result: "verified",
      method: "ssh login",
      note: "Worked against 192.0.2.10:22 only",
    });
    expect(result.success).toBe(true);
    const withHistory = SecretResponseSchema.safeParse(
      secretRecord({
        verifications: [
          {
            at: "2026-08-12T12:00:00.000Z",
            result: "verified",
            method: "ssh login",
            note: null,
          },
        ],
      }),
    );
    expect(withHistory.success).toBe(true);
  });

  it("requires a service scope on every secret", () => {
    expect(
      CreateSecretRequestSchema.safeParse({
        label: "Orphan credential",
        secretRef: "vault:stone/orphan",
      }).success,
    ).toBe(false);
  });
});
