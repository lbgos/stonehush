import { readFile } from "node:fs/promises";

import {
  FFUF_MAX_JSON_BYTES,
  FFUF_MAX_RESULTS,
  FfufVhostActionOptionsSchema,
  FfufDiscoveryOutputSchema,
  type FfufDiscoveryOutput,
} from "@stonehush/contracts";
import { buildVhostArgv } from "@stonehush/domain";

import { runSupervisedCommand } from "./process.js";

export interface VhostRunContext {
  runId: string;
  leaseId: string;
  fence: string;
  runRoot: string;
}

export interface VhostSpawnResult {
  exitCode: number | null;
}

export interface VhostRunnerDeps {
  ffufExecutable?: string;
  runContext: VhostRunContext;
  spawn?: (request: { executable: string; argv: readonly string[] }) => Promise<VhostSpawnResult>;
  readOutputJson?: (absolutePath: string) => Promise<Buffer>;
}

export type RunVhostDiscoveryResult =
  | { ok: true; output: FfufDiscoveryOutput; exitCode: number | null }
  | { ok: false; error: { code: "invalid_ffuf_vhost_contract" | "ffuf_missing" | "ffuf_parse_error" } };

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

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

function parseVhostJson(buffer: Buffer, exitCode: number | null): RunVhostDiscoveryResult {
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
 * Run ffuf vhost discovery through the supervised process runner.
 * Argv arrays only, never shell strings. The Host header carries FUZZ;
 * the request URL stays the explicit IP base.
 */
export async function runVhostDiscovery(
  deps: VhostRunnerDeps,
  options: unknown,
  defaultExecutable = "/usr/bin/ffuf",
): Promise<RunVhostDiscoveryResult> {
  try {
    const contract = FfufVhostActionOptionsSchema.safeParse(options);
    if (!contract.success) {
      return { ok: false, error: { code: "invalid_ffuf_vhost_contract" } };
    }
    const built = buildVhostArgv(contract.data);
    if (!built.ok) {
      return { ok: false, error: { code: "invalid_ffuf_vhost_contract" } };
    }
    if (built.argv[0] !== "ffuf") {
      return { ok: false, error: { code: "invalid_ffuf_vhost_contract" } };
    }

    const executable = deps.ffufExecutable ?? defaultExecutable;
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
    return parseVhostJson(buffer, exitCode);
  } catch {
    return { ok: false, error: { code: "ffuf_parse_error" } };
  }
}
