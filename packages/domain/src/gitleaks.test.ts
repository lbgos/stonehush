import { describe, expect, it } from "vitest";

import { GITLEAKS_MAX_JSON_BYTES } from "@stonehush/contracts";

import { parseGitleaksJson } from "./gitleaks.js";

const LIVE_KEY = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh12";
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe("parseGitleaksJson redaction boundary", () => {
  it("projects rule, file, and line while dropping secret values", () => {
    const output = JSON.stringify([
      {
        Description: "GitHub Personal Access Token",
        StartLine: 12,
        EndLine: 12,
        Match: `token = "${LIVE_KEY}"`,
        Secret: LIVE_KEY,
        File: "app.js",
        Commit: "",
        Entropy: 4.1,
        Author: "op",
        Email: "op@example.com",
        Date: "2026-01-01",
        Message: "",
        Tags: [],
        RuleID: "github-pat",
        Fingerprint: "ignored",
      },
      {
        Description: "AWS Access Key",
        StartLine: 3,
        Secret: AWS_KEY,
        Match: AWS_KEY,
        File: "config.txt",
        RuleID: "aws-access-key",
      },
    ]);
    const parsed = parseGitleaksJson(encode(output));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.truncated).toBe(false);
    expect(parsed.rawCount).toBe(2);
    expect(parsed.matches).toHaveLength(2);
    expect(parsed.matches[0]).toMatchObject({ ruleId: "github-pat", file: "app.js", line: 12 });
    expect(parsed.matches[1]).toMatchObject({ ruleId: "aws-access-key", file: "config.txt", line: 3 });
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain(LIVE_KEY);
    expect(serialized).not.toContain(AWS_KEY);
    expect(serialized).not.toContain("Secret");
    expect(serialized).not.toContain("Match");
    expect(parsed.matches[0]?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("treats empty detector output as zero matches", () => {
    for (const empty of ["", "   \n  "]) {
      const parsed = parseGitleaksJson(encode(empty));
      expect(parsed).toEqual({ ok: true, matches: [], truncated: false, rawCount: 0 });
    }
    const parsed = parseGitleaksJson(encode("[]"));
    expect(parsed).toEqual({ ok: true, matches: [], truncated: false, rawCount: 0 });
  });

  it("fails closed on malformed records instead of dropping hits silently", () => {
    expect(parseGitleaksJson(encode('{"not":"an array"}')).ok).toBe(false);
    expect(parseGitleaksJson(encode('[{"RuleID":"r"}]')).ok).toBe(false);
    expect(parseGitleaksJson(encode("not json")).ok).toBe(false);
    const bad = parseGitleaksJson(encode('{"not":"an array"}'));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("gitleaks_parse_error");
  });

  it("bounds oversized detector output before persistence", () => {
    const oversized = new Uint8Array(GITLEAKS_MAX_JSON_BYTES + 1);
    const parsed = parseGitleaksJson(oversized);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe("gitleaks_output_too_large");
  });

  it("keeps line 0 visible instead of inventing a line number", () => {
    const parsed = parseGitleaksJson(
      encode(JSON.stringify([{ RuleID: "r", File: "f.bin", StartLine: 0, Secret: "x" }])),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.matches[0]?.line).toBe(0);
    expect(JSON.stringify(parsed)).not.toContain('"Secret"');
  });
});
