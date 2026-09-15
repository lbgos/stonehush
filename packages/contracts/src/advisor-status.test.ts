import { describe, expect, it } from "vitest";

import {
  ADVISOR_STATUS_REASONS,
  AdvisorStatusReasonSchema,
  AdvisorStatusSchema,
  ConnectionTestResultSchema,
} from "./advisor-status.js";

const baseStatus = {
  configured: true,
  endpointReachable: true,
  modelId: "qwen3:8b",
  endpointHost: "127.0.0.1",
  publicEndpoint: false,
  optIn: false,
  keyEnvVar: "STONEHUSH_ADVISOR_API_KEY",
  keyPresent: true,
  latencyMs: 12,
  reason: "ok",
};

describe("AdvisorStatusReasonSchema", () => {
  it("accepts every documented reason code", () => {
    expect(ADVISOR_STATUS_REASONS).toEqual([
      "unconfigured",
      "missing_key_env",
      "key_unset",
      "public_not_opted_in",
      "unreachable",
      "probe_failed",
      "ok",
    ]);
    for (const reason of ADVISOR_STATUS_REASONS) {
      expect(AdvisorStatusReasonSchema.safeParse(reason).success).toBe(true);
    }
  });

  it("rejects unknown reason codes", () => {
    expect(AdvisorStatusReasonSchema.safeParse("connected").success).toBe(false);
    expect(AdvisorStatusReasonSchema.safeParse("").success).toBe(false);
  });
});

describe("AdvisorStatusSchema", () => {
  it("accepts a reachable private endpoint status", () => {
    expect(AdvisorStatusSchema.safeParse(baseStatus).success).toBe(true);
  });

  it("accepts null reachability and latency when no probe ran", () => {
    const result = AdvisorStatusSchema.safeParse({
      ...baseStatus,
      configured: false,
      endpointReachable: null,
      endpointHost: "",
      modelId: "",
      keyEnvVar: "",
      keyPresent: false,
      latencyMs: null,
      reason: "unconfigured",
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown keys and missing fields", () => {
    expect(AdvisorStatusSchema.safeParse({ ...baseStatus, extra: true }).success).toBe(false);
    const { reason, ...withoutReason } = baseStatus;
    expect(reason).toBe("ok");
    expect(AdvisorStatusSchema.safeParse(withoutReason).success).toBe(false);
  });

  it("rejects negative or fractional latency", () => {
    expect(
      AdvisorStatusSchema.safeParse({ ...baseStatus, latencyMs: -1 }).success,
    ).toBe(false);
    expect(
      AdvisorStatusSchema.safeParse({ ...baseStatus, latencyMs: 1.5 }).success,
    ).toBe(false);
  });
});

describe("ConnectionTestResultSchema", () => {
  it("accepts a reachable result with latency", () => {
    expect(
      ConnectionTestResultSchema.safeParse({ reachable: true, latencyMs: 3 }).success,
    ).toBe(true);
  });

  it("rejects missing, negative, or non-integer latency", () => {
    expect(ConnectionTestResultSchema.safeParse({ reachable: true }).success).toBe(false);
    expect(
      ConnectionTestResultSchema.safeParse({ reachable: false, latencyMs: -1 }).success,
    ).toBe(false);
    expect(
      ConnectionTestResultSchema.safeParse({ reachable: true, latencyMs: 2.5 }).success,
    ).toBe(false);
  });
});
