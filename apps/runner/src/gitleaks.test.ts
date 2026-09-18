import { describe, expect, it } from "vitest";

import { GITLEAKS_DEFAULT_EXECUTABLE, runGitleaksScan } from "./gitleaks.js";

const LIVE_KEY = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh12";

const FIXTURE_JSON = JSON.stringify([
  {
    Description: "GitHub Personal Access Token",
    StartLine: 7,
    EndLine: 7,
    Match: `token = "${LIVE_KEY}"`,
    Secret: LIVE_KEY,
    File: "bundle.js",
    Commit: "",
    Entropy: 4.2,
    Author: "op",
    Email: "op@example.com",
    Date: "2026-01-01T00:00:00Z",
    Message: "",
    Tags: [],
    RuleID: "github-pat",
    Fingerprint: "fixture-fingerprint-ignored",
  },
]);

const OPTIONS = { sourceDir: "/tmp/evidence-scan", reportPath: "/tmp/evidence-scan/report.json" };

function fixtureDeps(report: string | null, exitCode: number | null = 1) {
  const calls: { executable: string; argv: readonly string[] }[] = [];
  const reads: string[] = [];
  return {
    calls,
    reads,
    deps: {
      spawn: async (request: { executable: string; argv: readonly string[] }) => {
        calls.push(request);
        return { exitCode };
      },
      readReportJson: async (absolutePath: string) => {
        reads.push(absolutePath);
        if (report === null) throw new Error("report unavailable");
        return Buffer.from(report, "utf8");
      },
    },
  };
}

describe("runGitleaksScan", () => {
  it("runs the fixed detect argv and returns redacted matches only", async () => {
    const fixture = fixtureDeps(FIXTURE_JSON);
    const result = await runGitleaksScan(fixture.deps, OPTIONS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.exitCode).toBe(1);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ ruleId: "github-pat", file: "bundle.js", line: 7 });
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]?.executable).toBe(GITLEAKS_DEFAULT_EXECUTABLE);
    expect(fixture.calls[0]?.argv).toEqual([
      "detect",
      "--source",
      "/tmp/evidence-scan",
      "--no-git",
      "-f",
      "json",
      "--report-path",
      "/tmp/evidence-scan/report.json",
      "--no-banner",
      "--redact",
    ]);
    expect(fixture.reads).toEqual(["/tmp/evidence-scan/report.json"]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(LIVE_KEY);
    expect(serialized).not.toContain("Secret");
  });

  it("reports a truthful missing-tool error when the binary is absent", async () => {
    const enoent = new Error("spawn /usr/bin/gitleaks ENOENT") as Error & { code: string };
    enoent.code = "ENOENT";
    const result = await runGitleaksScan(
      {
        spawn: async () => {
          throw enoent;
        },
        readReportJson: async () => Buffer.of(),
      },
      OPTIONS,
    );
    expect(result).toEqual({ ok: false, error: { code: "gitleaks_missing" } });
  });

  it("treats an empty report as zero matches", async () => {
    const fixture = fixtureDeps("[]", 0);
    const result = await runGitleaksScan(fixture.deps, OPTIONS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.matches).toEqual([]);
  });

  it("fails closed when the report is missing, even on a clean exit", async () => {
    const fixture = fixtureDeps(null, 0);
    const result = await runGitleaksScan(fixture.deps, OPTIONS);
    expect(result).toEqual({ ok: false, error: { code: "gitleaks_parse_error" } });
  });

  it("fails unexpected exits without parsing", async () => {
    const fixture = fixtureDeps(FIXTURE_JSON, 2);
    const result = await runGitleaksScan(fixture.deps, OPTIONS);
    expect(result).toEqual({ ok: false, error: { code: "gitleaks_failed" } });
  });

  it("rejects an invalid source contract before spawning", async () => {
    const fixture = fixtureDeps(FIXTURE_JSON);
    const result = await runGitleaksScan(fixture.deps, { sourceDir: "relative" });
    expect(result).toEqual({ ok: false, error: { code: "invalid_gitleaks_contract" } });
    expect(fixture.calls).toHaveLength(0);
  });

  it("bounds oversized detector output", async () => {
    const fixture = fixtureDeps(null);
    fixture.deps.readReportJson = async () => Buffer.alloc(9 * 1024 * 1024, 0x5b);
    const result = await runGitleaksScan(fixture.deps, OPTIONS);
    expect(result).toEqual({ ok: false, error: { code: "gitleaks_output_too_large" } });
  });
});
