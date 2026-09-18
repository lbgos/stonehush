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
  stdout: Buffer;
}

export interface GitleaksRunnerDeps {
  gitleaksExecutable?: string;
  timeoutMs?: number;
  spawn?: (request: { executable: string; argv: readonly string[] }) => Promise<GitleaksSpawnResult>;
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
    });
    const chunks: Buffer[] = [];
    let total = 0;
    let overflow = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (overflow) return;
      total += chunk.length;
      if (total > GITLEAKS_MAX_JSON_BYTES) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (overflow) {
        const error = new Error("gitleaks stdout exceeded bound") as Error & { code: string };
        error.code = "GITLEAKS_OUTPUT_TOO_LARGE";
        reject(error);
        return;
      }
      resolve({ exitCode: code, stdout: Buffer.concat(chunks, total) });
    });
  });
}

/**
 * Run gitleaks detect over a local evidence directory through argv-only
 * execution, never shell strings. The executable is operator-configured
 * with a shipped default, exactly like ffuf: a missing binary reports
 * gitleaks_missing instead of a generic failure. Stdout is bounded; an
 * oversized detector dump fails before parsing. Secret values are dropped
 * by the domain parser, so this result can be persisted as-is.
 *
 * Exit codes: 0 means no leaks, 1 means leaks found and the JSON still
 * parses. Any other exit, signal, or spawn failure is gitleaks_failed.
 */
export async function runGitleaksScan(
  deps: GitleaksRunnerDeps,
  options: unknown,
): Promise<RunGitleaksScanResult> {
  try {
    const built = buildGitleaksArgv(options);
    if (!built.ok) {
      return { ok: false, error: { code: "invalid_gitleaks_contract" } };
    }
    if (built.argv[0] !== "gitleaks") {
      return { ok: false, error: { code: "invalid_gitleaks_contract" } };
    }
    const executable = deps.gitleaksExecutable ?? GITLEAKS_DEFAULT_EXECUTABLE;
    if (typeof executable !== "string" || !executable.startsWith("/") || executable.includes(NUL)) {
      return { ok: false, error: { code: "invalid_gitleaks_contract" } };
    }
    const timeoutMs = deps.timeoutMs ?? GITLEAKS_SCAN_TIMEOUT_MS;
    const argv = built.argv.slice(1);
    const spawn =
      deps.spawn ??
      ((request: { executable: string; argv: readonly string[] }) =>
        defaultSpawn({ ...request, timeoutMs }));

    let spawned: GitleaksSpawnResult;
    try {
      spawned = await spawn({ executable, argv });
    } catch (error) {
      if (isEnoent(error)) return { ok: false, error: { code: "gitleaks_missing" } };
      if ((error as { code?: string })?.code === "GITLEAKS_OUTPUT_TOO_LARGE") {
        return { ok: false, error: { code: "gitleaks_output_too_large" } };
      }
      return { ok: false, error: { code: "gitleaks_failed" } };
    }

    if (spawned.stdout.length > GITLEAKS_MAX_JSON_BYTES) {
      return { ok: false, error: { code: "gitleaks_output_too_large" } };
    }
    if (spawned.exitCode !== 0 && spawned.exitCode !== 1) {
      return { ok: false, error: { code: "gitleaks_failed" } };
    }

    const parsed = parseGitleaksJson(new Uint8Array(spawned.stdout));
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
