import { describe, expect, it } from "vitest";

import {
  GITLEAKS_MAX_FINDINGS,
  GitleaksMatchSchema,
  GitleaksScanResponseSchema,
} from "./gitleaks.js";

describe("gitleaks contract", () => {
  it("accepts a redacted match with rule, file, line, and fingerprint only", () => {
    const parsed = GitleaksMatchSchema.safeParse({
      ruleId: "github-pat",
      file: "capture-01.bin",
      line: 12,
      fingerprint: "a".repeat(16),
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a match carrying a secret value, even under an unknown key", () => {
    for (const candidate of [
      { ruleId: "r", file: "f", line: 1, fingerprint: "b".repeat(16), Secret: "ghp_live" },
      { ruleId: "r", file: "f", line: 1, fingerprint: "b".repeat(16), secret: "ghp_live" },
      { ruleId: "r", file: "f", line: 1, fingerprint: "b".repeat(16), Match: "ghp_live" },
      { ruleId: "r", file: "f", line: 1, fingerprint: "b".repeat(16), value: "ghp_live" },
    ]) {
      expect(GitleaksMatchSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("rejects a non-hex fingerprint", () => {
    const parsed = GitleaksMatchSchema.safeParse({
      ruleId: "r",
      file: "f",
      line: 1,
      fingerprint: "not-a-fingerprint",
    });
    expect(parsed.success).toBe(false);
  });

  it("caps the matches array", () => {
    const match = {
      ruleId: "r",
      file: "f",
      line: 1,
      fingerprint: "c".repeat(16),
    };
    const ok = GitleaksScanResponseSchema.safeParse({
      scanId: "10000000-0000-4000-8000-000000000001",
      engagementId: "10000000-0000-4000-8000-000000000002",
      scannedAt: new Date().toISOString(),
      matchCount: 1,
      truncated: false,
      matches: [match],
    });
    expect(ok.success).toBe(true);
    const over = GitleaksScanResponseSchema.safeParse({
      scanId: "10000000-0000-4000-8000-000000000001",
      engagementId: "10000000-0000-4000-8000-000000000002",
      scannedAt: new Date().toISOString(),
      matchCount: GITLEAKS_MAX_FINDINGS + 1,
      truncated: true,
      matches: Array.from({ length: GITLEAKS_MAX_FINDINGS + 1 }, () => match),
    });
    expect(over.success).toBe(false);
  });
});
