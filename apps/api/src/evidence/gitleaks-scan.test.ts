import { readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { scanEngagementEvidence } from "./gitleaks-scan.js";

const LIVE_KEY = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh12";

function sourceWith(files: { artifactId: string; bytes: string }[]) {
  return {
    listArtifacts: async () =>
      files.map((file) => ({
        artifactId: file.artifactId,
        sizeBytes: Buffer.byteLength(file.bytes),
        digest: `sha256:${file.artifactId}`,
      })),
    readArtifact: async (artifact: { artifactId: string }) => {
      const found = files.find((file) => file.artifactId === artifact.artifactId);
      if (found === undefined) throw new Error("unknown artifact");
      return Buffer.from(found.bytes, "utf8");
    },
  };
}

// Stub detector: writes a gitleaks-shaped JSON report for staged files
// containing the live-looking key, using the report path straight from
// argv exactly where the service pointed the real binary.
function stubDetector() {
  const calls: { executable: string; argv: readonly string[] }[] = [];
  return {
    calls,
    spawn: async (request: { executable: string; argv: readonly string[] }) => {
      calls.push(request);
      const sourceIndex = request.argv.indexOf("--source");
      const reportIndex = request.argv.indexOf("--report-path");
      const dir = request.argv[sourceIndex + 1] as string;
      const reportPath = request.argv[reportIndex + 1] as string;
      const names = await readdir(dir);
      const findings: unknown[] = [];
      for (const name of names) {
        if (name === path.basename(reportPath)) continue;
        const content = await readFile(path.join(dir, name), "utf8");
        if (content.includes(LIVE_KEY)) {
          findings.push({
            Description: "GitHub Personal Access Token",
            StartLine: 1,
            EndLine: 1,
            Match: content,
            Secret: LIVE_KEY,
            File: path.join(dir, name),
            RuleID: "github-pat",
          });
        }
      }
      await writeFile(reportPath, JSON.stringify(findings), { mode: 0o600 });
      return { exitCode: findings.length > 0 ? 1 : 0 };
    },
  };
}

describe("scanEngagementEvidence", () => {
  it("stages verified evidence, runs the fixed argv, and keeps values out", async () => {
    const detector = stubDetector();
    const result = await scanEngagementEvidence("eng-1", {
      executable: "/usr/bin/gitleaks",
      source: sourceWith([
        { artifactId: "ev-000001", bytes: `const token = "${LIVE_KEY}";\n` },
        { artifactId: "ev-000002", bytes: "nothing interesting here\n" },
      ]),
      spawn: detector.spawn,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stagedFiles).toBe(2);
    expect(result.value.truncated).toBe(false);
    expect(result.value.matches).toHaveLength(1);
    expect(result.value.matches[0]).toMatchObject({
      ruleId: "github-pat",
      file: "ev-000001",
      line: 1,
    });
    expect(result.value.matches[0]?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(detector.calls).toHaveLength(1);
    expect(detector.calls[0]?.executable).toBe("/usr/bin/gitleaks");
    const argv = detector.calls[0]?.argv ?? [];
    expect(argv.slice(0, 7)).toEqual([
      "detect",
      "--source",
      argv[2],
      "--no-git",
      "-f",
      "json",
      "--report-path",
    ]);
    expect(argv).toContain("--no-banner");
    expect(argv).toContain("--redact");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(LIVE_KEY);
    expect(serialized).not.toContain("Secret");
  });

  it("maps the missing binary to the truthful missing-tool error", async () => {
    const enoent = new Error("spawn /usr/bin/gitleaks ENOENT") as Error & { code: string };
    enoent.code = "ENOENT";
    const result = await scanEngagementEvidence("eng-1", {
      source: sourceWith([]),
      spawn: async () => {
        throw enoent;
      },
    });
    expect(result).toEqual({ ok: false, error: { code: "gitleaks_missing" } });
  });

  it("bounds an oversized evidence set before staging anything", async () => {
    const files = Array.from({ length: 2001 }, (_, index) => ({
      artifactId: `ev-${String(index).padStart(6, "0")}`,
      bytes: "x",
    }));
    const result = await scanEngagementEvidence("eng-1", {
      source: sourceWith(files),
      spawn: async () => ({ exitCode: 0 }),
    });
    expect(result).toEqual({ ok: false, error: { code: "evidence_too_large" } });
  });

  it("fails instead of silently skipping an artifact that changed mid-read", async () => {
    const source = sourceWith([{ artifactId: "ev-000001", bytes: "stable\n" }]);
    const tampered = {
      ...source,
      readArtifact: async () => Buffer.from("different length bytes here\n", "utf8"),
    };
    const result = await scanEngagementEvidence("eng-1", {
      source: tampered,
      spawn: async () => ({ exitCode: 0 }),
    });
    expect(result).toEqual({ ok: false, error: { code: "invalid_persisted_data" } });
  });

  it("fails closed when the detector leaves no report", async () => {
    const result = await scanEngagementEvidence("eng-1", {
      source: sourceWith([]),
      spawn: async () => ({ exitCode: 0 }),
    });
    expect(result).toEqual({ ok: false, error: { code: "gitleaks_parse_error" } });
  });

  it("leaves no stage directory behind after a scan", async () => {
    const before = new Set(await readdir(tmpdir()));
    const detector = stubDetector();
    const result = await scanEngagementEvidence("eng-1", {
      source: sourceWith([{ artifactId: "ev-000001", bytes: "clean\n" }]),
      spawn: detector.spawn,
    });
    expect(result.ok).toBe(true);
    const after = await readdir(tmpdir());
    expect(after.filter((name) => name.startsWith("stonehush-gitleaks-") && !before.has(name))).toEqual([]);
  });
});
