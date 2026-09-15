import { describe, expect, it } from "vitest";

import {
  ADVISOR_SETTINGS_DEFAULTS,
  AdvisorSettingsSchema,
  GetAdvisorSettingsResponseSchema,
  GetSettingsResponseSchema,
  RUNNER_SETTINGS_DEFAULTS,
  RunnerSettingsSchema,
  SettingScopeSchema,
  UpdateAdvisorSettingsRequestSchema,
  UpdateSettingsRequestSchema,
} from "./settings.js";

describe("SettingScopeSchema", () => {
  it("accepts the runner and advisor scopes", () => {
    expect(SettingScopeSchema.safeParse("runner").success).toBe(true);
    expect(SettingScopeSchema.safeParse("advisor").success).toBe(true);
    for (const scope of ["general", "appearance", "evidence", "diagnostics", ""]) {
      expect(SettingScopeSchema.safeParse(scope).success).toBe(false);
    }
  });
});

describe("RunnerSettingsSchema", () => {
  it("accepts the shipped defaults", () => {
    const parsed = RunnerSettingsSchema.safeParse({ ...RUNNER_SETTINGS_DEFAULTS });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({
        ffufBinaryPath: "/usr/bin/ffuf",
        ffufWordlistPath: "",
        ffufRate: 100,
        ffufThreads: 40,
        ffufTimeoutSeconds: 10,
        ffufMaxTimeSeconds: 120,
      });
    }
  });

  it("accepts an absolute wordlist path", () => {
    expect(
      RunnerSettingsSchema.safeParse({
        ...RUNNER_SETTINGS_DEFAULTS,
        ffufWordlistPath: "/usr/share/wordlists/common.txt",
      }).success,
    ).toBe(true);
  });

  it("rejects relative and traversal paths", () => {
    expect(
      RunnerSettingsSchema.safeParse({
        ...RUNNER_SETTINGS_DEFAULTS,
        ffufBinaryPath: "usr/bin/ffuf",
      }).success,
    ).toBe(false);
    expect(
      RunnerSettingsSchema.safeParse({
        ...RUNNER_SETTINGS_DEFAULTS,
        ffufBinaryPath: "/usr/bin/../../ffuf",
      }).success,
    ).toBe(false);
    expect(
      RunnerSettingsSchema.safeParse({
        ...RUNNER_SETTINGS_DEFAULTS,
        ffufWordlistPath: "wordlists/common.txt",
      }).success,
    ).toBe(false);
    expect(
      RunnerSettingsSchema.safeParse({
        ...RUNNER_SETTINGS_DEFAULTS,
        ffufWordlistPath: "/lists/../etc/passwd",
      }).success,
    ).toBe(false);
    expect(
      RunnerSettingsSchema.safeParse({
        ...RUNNER_SETTINGS_DEFAULTS,
        ffufBinaryPath: "/usr/bin/ffuf\0",
      }).success,
    ).toBe(false);
  });

  it("rejects out-of-range ints", () => {
    expect(
      RunnerSettingsSchema.safeParse({ ...RUNNER_SETTINGS_DEFAULTS, ffufRate: 0 }).success,
    ).toBe(false);
    expect(
      RunnerSettingsSchema.safeParse({ ...RUNNER_SETTINGS_DEFAULTS, ffufRate: 10_001 }).success,
    ).toBe(false);
    expect(
      RunnerSettingsSchema.safeParse({ ...RUNNER_SETTINGS_DEFAULTS, ffufThreads: 0 }).success,
    ).toBe(false);
    expect(
      RunnerSettingsSchema.safeParse({ ...RUNNER_SETTINGS_DEFAULTS, ffufThreads: 201 }).success,
    ).toBe(false);
    expect(
      RunnerSettingsSchema.safeParse({ ...RUNNER_SETTINGS_DEFAULTS, ffufTimeoutSeconds: 0 })
        .success,
    ).toBe(false);
    expect(
      RunnerSettingsSchema.safeParse({ ...RUNNER_SETTINGS_DEFAULTS, ffufTimeoutSeconds: 121 })
        .success,
    ).toBe(false);
    expect(
      RunnerSettingsSchema.safeParse({ ...RUNNER_SETTINGS_DEFAULTS, ffufMaxTimeSeconds: 4 })
        .success,
    ).toBe(false);
    expect(
      RunnerSettingsSchema.safeParse({ ...RUNNER_SETTINGS_DEFAULTS, ffufMaxTimeSeconds: 1801 })
        .success,
    ).toBe(false);
    expect(
      RunnerSettingsSchema.safeParse({ ...RUNNER_SETTINGS_DEFAULTS, ffufRate: 12.5 }).success,
    ).toBe(false);
  });

  it("rejects unknown keys (strict, no passthrough)", () => {
    expect(
      RunnerSettingsSchema.safeParse({ ...RUNNER_SETTINGS_DEFAULTS, ffufBinary: "/usr/bin/ffuf" })
        .success,
    ).toBe(false);
    expect(
      GetSettingsResponseSchema.safeParse({ ...RUNNER_SETTINGS_DEFAULTS, scope: "runner" })
        .success,
    ).toBe(false);
  });
});

describe("UpdateSettingsRequestSchema", () => {
  it("accepts a partial update", () => {
    expect(UpdateSettingsRequestSchema.safeParse({ ffufRate: 50 }).success).toBe(true);
    expect(UpdateSettingsRequestSchema.safeParse({}).success).toBe(true);
    expect(
      UpdateSettingsRequestSchema.safeParse({
        ffufWordlistPath: "/usr/share/wordlists/common.txt",
        ffufThreads: 20,
      }).success,
    ).toBe(true);
  });

  it("rejects unknown keys and invalid values", () => {
    expect(
      UpdateSettingsRequestSchema.safeParse({ ffufRate: 50, general: {} }).success,
    ).toBe(false);
    expect(
      UpdateSettingsRequestSchema.safeParse({ ffufWordlistPath: "/lists/../etc/passwd" })
        .success,
    ).toBe(false);
    expect(UpdateSettingsRequestSchema.safeParse({ ffufRate: 0 }).success).toBe(false);
    expect(
      UpdateSettingsRequestSchema.safeParse({ ffufTimeoutSeconds: 10_000 }).success,
    ).toBe(false);
  });
});

describe("AdvisorSettingsSchema", () => {
  it("accepts the shipped defaults (unconfigured endpoint and model)", () => {
    const parsed = AdvisorSettingsSchema.safeParse({ ...ADVISOR_SETTINGS_DEFAULTS });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({
        endpointBaseUrl: "",
        modelId: "",
        apiKeyEnvVar: "",
        requestBudget: 10,
        rawResponseVisibility: true,
        publicEndpointOptIn: false,
      });
    }
  });

  it("accepts a configured http(s) endpoint, model, env var, and budget", () => {
    expect(
      AdvisorSettingsSchema.safeParse({
        ...ADVISOR_SETTINGS_DEFAULTS,
        endpointBaseUrl: "http://127.0.0.1:11434/v1",
        modelId: "qwen3:8b",
        apiKeyEnvVar: "STONEHUSH_ADVISOR_API_KEY",
        requestBudget: 25,
        rawResponseVisibility: false,
        publicEndpointOptIn: false,
      }).success,
    ).toBe(true);
  });

  it("rejects non-http(s) and overlong endpoints", () => {
    expect(
      AdvisorSettingsSchema.safeParse({
        ...ADVISOR_SETTINGS_DEFAULTS,
        endpointBaseUrl: "ftp://example.invalid/v1",
      }).success,
    ).toBe(false);
    expect(
      AdvisorSettingsSchema.safeParse({
        ...ADVISOR_SETTINGS_DEFAULTS,
        endpointBaseUrl: "not-a-url",
      }).success,
    ).toBe(false);
    expect(
      AdvisorSettingsSchema.safeParse({
        ...ADVISOR_SETTINGS_DEFAULTS,
        endpointBaseUrl: `https://example.invalid/${"a".repeat(2048)}`,
      }).success,
    ).toBe(false);
  });

  it("rejects invalid env var names and overlong model ids", () => {
    for (const apiKeyEnvVar of ["lowercase", "HAS-DASH", "HAS SPACE", "9STARTS_WITH_DIGIT"]) {
      expect(
        AdvisorSettingsSchema.safeParse({ ...ADVISOR_SETTINGS_DEFAULTS, apiKeyEnvVar })
          .success,
      ).toBe(false);
    }
    expect(
      AdvisorSettingsSchema.safeParse({
        ...ADVISOR_SETTINGS_DEFAULTS,
        apiKeyEnvVar: `${"A".repeat(128)}B`,
      }).success,
    ).toBe(false);
    expect(
      AdvisorSettingsSchema.safeParse({
        ...ADVISOR_SETTINGS_DEFAULTS,
        modelId: "m".repeat(129),
      }).success,
    ).toBe(false);
  });

  it("rejects out-of-range budgets and non-boolean flags", () => {
    for (const requestBudget of [0, 101, 2.5, "10"]) {
      expect(
        AdvisorSettingsSchema.safeParse({ ...ADVISOR_SETTINGS_DEFAULTS, requestBudget })
          .success,
      ).toBe(false);
    }
    expect(
      AdvisorSettingsSchema.safeParse({
        ...ADVISOR_SETTINGS_DEFAULTS,
        rawResponseVisibility: "yes",
      }).success,
    ).toBe(false);
    expect(
      AdvisorSettingsSchema.safeParse({
        ...ADVISOR_SETTINGS_DEFAULTS,
        publicEndpointOptIn: 1,
      }).success,
    ).toBe(false);
  });

  it("rejects key material in any string value", () => {
    for (const value of [
      "sk-abc123",
      "https://example.invalid/v1?key=sk-abc123",
      "Bearer eyJhbGciOiJIUzI1NiJ9",
      "prefix bearer token",
      "SK-LIVE-KEY",
    ]) {
      expect(
        AdvisorSettingsSchema.safeParse({ ...ADVISOR_SETTINGS_DEFAULTS, modelId: value })
          .success,
      ).toBe(false);
      expect(
        AdvisorSettingsSchema.safeParse({ ...ADVISOR_SETTINGS_DEFAULTS, apiKeyEnvVar: value })
          .success,
      ).toBe(false);
    }
    expect(
      AdvisorSettingsSchema.safeParse({
        ...ADVISOR_SETTINGS_DEFAULTS,
        endpointBaseUrl: "https://example.invalid/sk-abc123",
      }).success,
    ).toBe(false);
  });

  it("accepts a public URL without opt-in at storage (enforcement is a later slice)", () => {
    expect(
      AdvisorSettingsSchema.safeParse({
        ...ADVISOR_SETTINGS_DEFAULTS,
        endpointBaseUrl: "https://api.example-provider.invalid/v1",
        publicEndpointOptIn: false,
      }).success,
    ).toBe(true);
  });

  it("rejects unknown keys (strict, no passthrough)", () => {
    expect(
      AdvisorSettingsSchema.safeParse({ ...ADVISOR_SETTINGS_DEFAULTS, apiKey: "secret" })
        .success,
    ).toBe(false);
    expect(
      GetAdvisorSettingsResponseSchema.safeParse({
        ...ADVISOR_SETTINGS_DEFAULTS,
        scope: "advisor",
      }).success,
    ).toBe(false);
  });
});

describe("UpdateAdvisorSettingsRequestSchema", () => {
  it("accepts a partial update", () => {
    expect(UpdateAdvisorSettingsRequestSchema.safeParse({ requestBudget: 5 }).success).toBe(
      true,
    );
    expect(UpdateAdvisorSettingsRequestSchema.safeParse({}).success).toBe(true);
    expect(
      UpdateAdvisorSettingsRequestSchema.safeParse({
        endpointBaseUrl: "http://127.0.0.1:11434/v1",
        modelId: "qwen3:8b",
      }).success,
    ).toBe(true);
  });

  it("rejects unknown keys, key material, and invalid values", () => {
    expect(
      UpdateAdvisorSettingsRequestSchema.safeParse({ requestBudget: 5, scope: "advisor" })
        .success,
    ).toBe(false);
    expect(
      UpdateAdvisorSettingsRequestSchema.safeParse({ modelId: "sk-abc123" }).success,
    ).toBe(false);
    expect(
      UpdateAdvisorSettingsRequestSchema.safeParse({ endpointBaseUrl: "gopher://x" })
        .success,
    ).toBe(false);
    expect(
      UpdateAdvisorSettingsRequestSchema.safeParse({ apiKeyEnvVar: "bad-name" }).success,
    ).toBe(false);
    expect(
      UpdateAdvisorSettingsRequestSchema.safeParse({ requestBudget: 101 }).success,
    ).toBe(false);
  });
});
