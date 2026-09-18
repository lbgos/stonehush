import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

import {
  GITLEAKS_MAX_JSON_BYTES,
  GITLEAKS_SCAN_TIMEOUT_MS,
  type GitleaksMatch,
} from "@stonehush/contracts";
import { buildGitleaksArgv, parseGitleaksJson } from "@stonehush/domain";

export const GITLEAKS_DEFAULT_EXECUTABLE = "/usr/bin/gitleaks";
export { GITLEAKS_MAX_JSON_BYTES, GITLEAKS_SCAN_TIMEOUT_MS };

const NUL = String.fromCharCode(0);

export interface GitleaksSpawnResult {
  exitCode: number | null;
}

export interface GitleaksRunnerDeps {
  gitleaksExecutable?: string;
  timeoutMs?: number;
  spawn?: (request: { executable: string; argv: readonly string[] }) => Promise<GitleaksSpawnResult>;
  readReportJson?: (absolutePath: string) => Promise<Buffer>;
}

export interface GitleaksRunnerOptions {
  sourceDir: string;
  reportPath: string;
}

export type RunGitleaksScanResult =
  | { ok: true; matches: GitleaksMatch[]; truncated: boolean; rawCount: number; exitCode: number | null }
  | {
      ok: false;
      error: {
        code:
          | "invalid_gitleaks_contract"
          | "gitleaks_missing"
          | "gitleaks_failed"
          | "gitleaks_parse_error"
          | "gitleaks_output_too_large";
      };
    };

function isEnoent(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT") return true;
  }
  const message = error instanceof Error ? error.message : "";
  return message.includes("ENOENT");
}

function defaultSpawn(request: {
  executable: string;
  argv: readonly string[];
  timeoutMs: number;
}): Promise<GitleaksSpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(request.executable, [...request.argv], {
      shell: false,
      timeout: request.timeoutMs,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => resolve({ exitCode: code }));
  });
}

async function defaultReadReport(absolutePath: string): Promise<Buffer> {
  return readFile(absolutePath);
}

/**
 * Run gitleaks detect over a local evidence directory through argv-only
 * execution, never shell strings. The executable is operator-configured
 * with a shipped default, exactly like ffuf: a missing binary reports
 * gitleaks_missing instead of a generic failure.
 *
 * The JSON report lands in a caller-controlled file (the ffuf output-file
 * pattern), read back bounded; detector log lines never enter the parse
 * input. Secret values are dropped by the domain parser, so this result
 * can be persisted as-is.
 *
 * Exit codes: 0 means no leaks, 1 means leaks found and the report still
 * parses. Any other exit, signal, or spawn failure is gitleaks_failed.
 */
export async function runGitleaksScan(
  deps: GitleaksRunnerDeps,
  options: unknown,
): Promise<RunGitleaksScanResult> {
  try {
    const candidate =
      typeof options === "object" && options !== null && !Array.isArray(options)
        ? (options as Partial<GitleaksRunnerOptions>)
        : undefined;
    const built = buildGitleaksArgv(candidate);
    if (!built.ok) {
      return { ok: false, error: { code: "invalid_gitleaks_contract" } };
    }
    if (built.argv[0] !== "gitleaks") {
      return { ok: false, error: { code: "invalid_gitleaks_contract" } };
    }
    const reportPath =
      typeof candidate?.reportPath === "string" ? candidate.reportPath : "";
    const executable = deps.gitleaksExecutable ?? GITLEAKS_DEFAULT_EXECUTABLE;
    if (typeof executable !== "string" || !executable.startsWith("/") || executable.includes(NUL)) {
      return { ok: false, error: { code: "invalid_gitleaks_contract" } };
    }
    const timeoutMs = deps.timeoutMs ?? GITLEAKS_SCAN_TIMEOUT_MS;
    const argv = built.argv.slice(1);
    const spawnFn =
      deps.spawn ??
      ((request: { executable: string; argv: readonly string[] }) =>
        defaultSpawn({ ...request, timeoutMs }));

    let spawned: GitleaksSpawnResult;
    try {
      spawned = await spawnFn({ executable, argv });
    } catch (error) {
      if (isEnoent(error)) return { ok: false, error: { code: "gitleaks_missing" } };
      return { ok: false, error: { code: "gitleaks_failed" } };
    }

    if (spawned.exitCode !== 0 && spawned.exitCode !== 1) {
      return { ok: false, error: { code: "gitleaks_failed" } };
    }

    const readReport = deps.readReportJson ?? defaultReadReport;
    let buffer: Buffer;
    try {
      buffer = await readReport(reportPath);
    } catch {
      // A missing report fails closed even on a clean detector exit: a
      // scan that cannot show its report cannot claim to be clean.
      return { ok: false, error: { code: "gitleaks_parse_error" } };
    }
    if (buffer.length > GITLEAKS_MAX_JSON_BYTES) {
      return { ok: false, error: { code: "gitleaks_output_too_large" } };
    }
    const parsed = parseGitleaksJson(new Uint8Array(buffer));
    if (!parsed.ok) {
      return { ok: false, error: { code: parsed.error.code } };
    }
    return {
      ok: true,
      matches: parsed.matches,
      truncated: parsed.truncated,
      rawCount: parsed.rawCount,
      exitCode: spawned.exitCode,
    };
  } catch {
    return { ok: false, error: { code: "gitleaks_failed" } };
  }
}
