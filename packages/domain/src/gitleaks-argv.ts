/**
 * Build deterministic gitleaks argv for a local evidence scan. No shell
 * strings; each argv element is one literal string, so evidence directory
 * paths with spaces or metacharacters stay a single element.
 *
 * Fixed order:
 * gitleaks, detect, --source <dir>, --no-git, -f json,
 * --report-path <file>, --no-banner, --redact
 *
 * --no-git keeps the scan to file content already in the workspace. The
 * JSON report goes to a caller-controlled file (the ffuf output-file
 * pattern) instead of stdout: detector log lines stay out of the parse
 * input entirely. --no-banner keeps logs quiet and --redact is defense in
 * depth only: the parser drops secret values regardless, so redaction
 * never depends on a detector flag.
 */

export type BuildGitleaksArgvResult =
  | { ok: true; argv: string[] }
  | { ok: false; error: { code: "invalid_gitleaks_contract" } };

function isManagedAbsolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    value.startsWith("/") &&
    !value.includes(String.fromCharCode(0))
  );
}

export function buildGitleaksArgv(input: unknown): BuildGitleaksArgvResult {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return { ok: false, error: { code: "invalid_gitleaks_contract" } };
    }
    const record = input as Record<string, unknown>;
    if (!isManagedAbsolutePath(record.sourceDir) || !isManagedAbsolutePath(record.reportPath)) {
      return { ok: false, error: { code: "invalid_gitleaks_contract" } };
    }
    if (record.sourceDir === record.reportPath) {
      return { ok: false, error: { code: "invalid_gitleaks_contract" } };
    }
    return {
      ok: true,
      argv: [
        "gitleaks",
        "detect",
        "--source",
        record.sourceDir,
        "--no-git",
        "-f",
        "json",
        "--report-path",
        record.reportPath,
        "--no-banner",
        "--redact",
      ],
    };
  } catch {
    return { ok: false, error: { code: "invalid_gitleaks_contract" } };
  }
}
