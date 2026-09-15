import { readFile } from "node:fs/promises";

import {
  FFUF_MAX_JSON_BYTES,
  FFUF_MAX_RESULTS,
  FfufActionOptionsSchema,
  FfufDiscoveryOutputSchema,
  type FfufDiscoveryOutput,
  type FfufErrorCode,
} from "@stonehush/contracts";
import { buildFfufArgv } from "@stonehush/domain";

import { runSupervisedCommand } from "./process.js";

export const FFUF_DEFAULT_EXECUTABLE = "/usr/bin/ffuf";
export { FFUF_MAX_JSON_BYTES };

export interface FfufRunContext {
  runId: string;
  leaseId: string;
  fence: string;
  runRoot: string;
}

export interface FfufSpawnResult {
  exitCode: number | null;
}

export interface FfufRunnerDeps {
  ffufExecutable?: string;
  runContext: FfufRunContext;
  spawn?: (request: { executable: string; argv: readonly string[] }) => Promise<FfufSpawnResult>;
  readOutputJson?: (absolutePath: string) => Promise<Buffer>;
}

export type RunFfufDiscoveryResult =
  | { ok: true; output: FfufDiscoveryOutput; exitCode: number | null }
  | { ok: false; error: { code: FfufErrorCode } };

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Project one raw ffuf -of json record onto the parser contract.
 * Unknown keys (position, host, resultfile) are dropped, never passed through.
 * An empty redirectlocation means "no redirect" and is normalized to absent.
 */
function projectRawResult(candidate: unknown): Record<string, unknown> | null {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return null;
  const record = candidate as Record<string, unknown>;
  if (typeof record.url !== "string" || typeof record.status !== "number") return null;
  if (typeof record.length !== "number" || typeof record.words !== "number" || typeof record.lines !== "number") {
    return null;
  }
  const projected: Record<string, unknown> = {
    url: record.url,
    status: record.status,
    length: record.length,
    words: record.words,
    lines: record.lines,
    input: null,
  };
  if (typeof record.redirectlocation === "string" && record.redirectlocation.length > 0) {
    projected.redirectlocation = record.redirectlocation;
  }
  const input = record.input;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const fuzz = (input as Record<string, unknown>).FUZZ;
  if (typeof fuzz !== "string") return null;
  projected.input = { FUZZ: fuzz };
  return projected;
}

function parseFfufJson(buffer: Buffer, exitCode: number | null): RunFfufDiscoveryResult {
  try {
    if (buffer.length === 0 || buffer.length > FFUF_MAX_JSON_BYTES) {
      return { ok: false, error: { code: "ffuf_parse_error" } };
    }
    const parsed: unknown = JSON.parse(buffer.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: { code: "ffuf_parse_error" } };
    }
    const rawResults = (parsed as Record<string, unknown>).results;
    if (!Array.isArray(rawResults)) {
      return { ok: false, error: { code: "ffuf_parse_error" } };
    }
    const projected: Record<string, unknown>[] = [];
    for (const candidate of rawResults) {
      const item = projectRawResult(candidate);
      if (item === null) return { ok: false, error: { code: "ffuf_parse_error" } };
      projected.push(item);
    }
    const truncated = exitCode !== 0 || projected.length > FFUF_MAX_RESULTS;
    const output = FfufDiscoveryOutputSchema.safeParse({
      results: projected.slice(0, FFUF_MAX_RESULTS),
      truncated,
    });
    if (!output.success) {
      return { ok: false, error: { code: "ffuf_parse_error" } };
    }
    return { ok: true, output: output.data, exitCode };
  } catch {
    return { ok: false, error: { code: "ffuf_parse_error" } };
  }
}

/**
 * Run ffuf discovery through the existing supervised process runner.
 * Argv arrays only, never shell strings. Non-zero exit with valid partial
 * JSON still returns parsed results with truncated true. Invalid JSON
 * returns ffuf_parse_error and never throws.
 */
export async function runFfufDiscovery(
  deps: FfufRunnerDeps,
  options: unknown,
): Promise<RunFfufDiscoveryResult> {
  try {
    const contract = FfufActionOptionsSchema.safeParse(options);
    if (!contract.success) {
      return { ok: false, error: { code: "invalid_ffuf_action_contract" } };
    }
    const built = buildFfufArgv(contract.data);
    if (!built.ok) {
      return { ok: false, error: { code: "invalid_ffuf_action_contract" } };
    }
    if (built.argv[0] !== "ffuf") {
      return { ok: false, error: { code: "invalid_ffuf_action_contract" } };
    }

    const executable = deps.ffufExecutable ?? FFUF_DEFAULT_EXECUTABLE;
    const argv = built.argv.slice(1);
    const spawn =
      deps.spawn ??
      ((request: { executable: string; argv: readonly string[] }) =>
        runSupervisedCommand({
          runId: deps.runContext.runId,
          leaseId: deps.runContext.leaseId,
          fence: deps.runContext.fence,
          runRoot: deps.runContext.runRoot,
          executable: request.executable,
          argv: request.argv,
        }));

    let exitCode: number | null;
    try {
      const spawned = await spawn({ executable, argv });
      exitCode = spawned.exitCode;
    } catch (error) {
      if (isEnoent(error)) return { ok: false, error: { code: "ffuf_missing" } };
      const message = error instanceof Error ? error.message : "";
      if (message.includes("ENOENT") || message.includes("executable")) {
        return { ok: false, error: { code: "ffuf_missing" } };
      }
      return { ok: false, error: { code: "ffuf_parse_error" } };
    }

    const readJson = deps.readOutputJson ?? ((absolutePath: string) => readFile(absolutePath));
    let buffer: Buffer;
    try {
      buffer = await readJson(contract.data.outputJsonPath);
    } catch {
      return { ok: false, error: { code: "ffuf_parse_error" } };
    }
    return parseFfufJson(buffer, exitCode);
  } catch {
    return { ok: false, error: { code: "ffuf_parse_error" } };
  }
}
