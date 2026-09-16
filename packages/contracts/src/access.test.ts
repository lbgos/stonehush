import { describe, expect, it } from "vitest";

import {
  ACCESS_CONTRACT_VERSION,
  AccessRecordSchema,
  CreateAccessRequestSchema,
  formatAccessRecordLabel,
} from "./access.js";

const TARGET_ID = "10000000-0000-4000-8000-000000000001";
const LEAD_ID = "10000000-0000-4000-8000-000000000002";
const SECRET_ID = "10000000-0000-4000-8000-000000000003";
const ENGAGEMENT_ID = "10000000-0000-4000-8000-000000000000";
const ACCESS_ID = "10000000-0000-4000-8000-000000000004";
const AT = "2026-09-10T12:00:00.000Z";

function record(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: ACCESS_CONTRACT_VERSION,
    id: ACCESS_ID,
    engagementId: ENGAGEMENT_ID,
    targetId: TARGET_ID,
    account: "deploy",
    accessType: "ssh",
    sourceLeadId: LEAD_ID,
    secretId: SECRET_ID,
    context: "SSH from the runner network",
    lastConfirmedAt: AT,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

describe("access contracts", () => {
  it("records SSH access with account, type, source lead, and last confirmed", () => {
    const parsed = AccessRecordSchema.safeParse(record());
    expect(parsed.success).toBe(true);
  });

  it("accepts a record without an associated secret", () => {
    expect(AccessRecordSchema.safeParse(record({ secretId: null })).success).toBe(true);
  });

  it("labels SSH access as recorded, never connected", () => {
    expect(formatAccessRecordLabel("ssh")).toBe("Recorded SSH access");
    expect(formatAccessRecordLabel("ssh")).not.toContain("Connected");
    expect(formatAccessRecordLabel("ssh")).not.toContain("●");
  });

  it("rejects every access type outside the recorded set", () => {
    expect(
      CreateAccessRequestSchema.safeParse({
        targetId: TARGET_ID,
        account: "deploy",
        accessType: "rdp-backdoor",
        sourceLeadId: LEAD_ID,
      }).success,
    ).toBe(false);
  });

  it("rejects blank accounts and untrimmed context", () => {
    expect(
      CreateAccessRequestSchema.safeParse({
        targetId: TARGET_ID,
        account: "  ",
        accessType: "ssh",
        sourceLeadId: LEAD_ID,
      }).success,
    ).toBe(false);
    expect(
      CreateAccessRequestSchema.safeParse({
        targetId: TARGET_ID,
        account: "deploy",
        accessType: "ssh",
        sourceLeadId: LEAD_ID,
        context: " trailing",
      }).success,
    ).toBe(false);
  });

  it("never carries a secret value field: strict parsing drops value smuggling", () => {
    expect(
      AccessRecordSchema.safeParse(
        record({ secretValue: "flag{planted}", password: "planted", plaintext: "planted" }),
      ).success,
    ).toBe(false);
    expect(
      CreateAccessRequestSchema.safeParse({
        targetId: TARGET_ID,
        account: "deploy",
        accessType: "ssh",
        sourceLeadId: LEAD_ID,
        secretValue: "flag{planted}",
      }).success,
    ).toBe(false);
  });
});
