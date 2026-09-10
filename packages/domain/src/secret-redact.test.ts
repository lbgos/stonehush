import { describe, expect, it } from "vitest";

import {
  SECRET_DISPLAY_MASK,
  SECRET_EXCLUDED_SURFACES,
  SECRET_REDACTION_TOKEN,
  SECRET_STORAGE_COPY,
  isSecretExcludedFrom,
  maskSecretValue,
  proofHintForValue,
  redactKnownSecretsFromText,
} from "./secret-redact.js";

describe("secret redaction util", () => {
  it("masks any value totally, leaking no length", () => {
    expect(maskSecretValue("synthetic-secret-001")).toBe(SECRET_DISPLAY_MASK);
    expect(maskSecretValue("synthetic-secret-001")).toBe(
      maskSecretValue("a much longer synthetic secret value 002"),
    );
  });

  it("excludes secrets from search, AI context, logs, reports, screenshots, and command previews", () => {
    for (const surface of [
      "search",
      "ai_context",
      "logs",
      "report_text",
      "screenshots",
      "command_preview",
    ] as const) {
      expect(SECRET_EXCLUDED_SURFACES).toContain(surface);
      expect(isSecretExcludedFrom(surface)).toBe(true);
    }
  });

  it("redacts known values from search, AI, log, and report text", () => {
    const known = "synthetic-secret-001";
    for (const surfaceText of [
      `search index entry ${known} here`,
      `ai context block ${known} here`,
      `log line ${known} here`,
      `report paragraph ${known} here`,
    ]) {
      const result = redactKnownSecretsFromText(surfaceText, [known]);
      expect(result.redactions).toBe(1);
      expect(result.text).not.toContain(known);
      expect(result.text).toContain(SECRET_REDACTION_TOKEN);
    }
  });

  it("skips tiny values that would over-match ordinary text", () => {
    const result = redactKnownSecretsFromText("an ordinary log line", ["an", "or"]);
    expect(result).toEqual({ text: "an ordinary log line", redactions: 0 });
  });

  it("builds short masked hints without the value", () => {
    const hint = proofHintForValue("flag{synthetic-proof-0001}");
    expect(hint).not.toContain("flag{synthetic-proof-0001}");
    expect(hint.length).toBeLessThanOrEqual(64);
  });

  it("documents that masking is not encryption in copy", () => {
    expect(SECRET_STORAGE_COPY).toContain("never plaintext");
    expect(SECRET_STORAGE_COPY).toContain("not");
    expect(SECRET_STORAGE_COPY).toMatch(/not encryption/i);
  });
});
