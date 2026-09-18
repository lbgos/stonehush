/**
 * Build deterministic gitleaks argv for a local evidence scan. No shell
 * strings; each argv element is one literal string, so evidence directory
 * paths with spaces or metacharacters stay a single element.
 *
 * Fixed order:
 * gitleaks, detect, --source <dir>, --no-git, -f json, --no-banner, --redact
 *
 * --no-git keeps the scan to file content already in the workspace.
 * --no-banner keeps stdout pure JSON for the bounded parser. --redact is
 * defense in depth only: the parser below drops secret values regardless,
 * so redaction never depends on a detector flag.
 */

export type BuildGitleaksArgvResult =
  | { ok: true; argv: string[] }
  | { ok: false; error: { code: "invalid_gitleaks_contract" } };

export function buildGitleaksArgv(input: unknown): BuildGitleaksArgvResult {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return { ok: false, error: { code: "invalid_gitleaks_contract" } };
    }
    const sourceDir = (input as Record<string, unknown>).sourceDir;
    if (typeof sourceDir !== "string" || sourceDir.length === 0 || sourceDir.length > 4096) {
      return { ok: false, error: { code: "invalid_gitleaks_contract" } };
    }
    if (!sourceDir.startsWith("/") || sourceDir.includes("\0")) {
      return { ok: false, error: { code: "invalid_gitleaks_contract" } };
    }
    return {
      ok: true,
      argv: [
        "gitleaks",
        "detect",
        "--source",
        sourceDir,
        "--no-git",
        "-f",
        "json",
        "--no-banner",
        "--redact",
      ],
    };
  } catch {
    return { ok: false, error: { code: "invalid_gitleaks_contract" } };
  }
}
