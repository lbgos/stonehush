import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  GITLEAKS_MAX_JSON_BYTES,
  GITLEAKS_SCAN_TIMEOUT_MS,
  type GitleaksMatch,
} from "@stonehush/contracts";
import { buildGitleaksArgv, parseGitleaksJson } from "@stonehush/domain";

/**
 * Control-plane T0 secret scan over captured engagement evidence.
 *
 * Read-only over the workspace: verified evidence bytes are staged into a
 * fresh 0700 temp directory, scanned with argv-only gitleaks execution
 * (never shell strings), then the stage is removed. File names inside the
 * stage are sanitized artifact ids, so detector-reported paths map back to
 * artifact ids without ever leaking host paths to the API layer. The JSON
 * report lands in a stage file (the ffuf output-file pattern) and is read
 * back bounded; detector log lines never enter the parse input.
 *
 * The executable is operator-configured with a shipped default, like
 * ffuf/nmap: an absent binary reports gitleaks_missing. Secret values are
 * dropped by the domain parser before this result reaches any repository.
 *
 * Nothing is skipped silently: every listed artifact is staged or the scan
 * fails. An oversized evidence set fails with evidence_too_large instead
 * of reporting a partial clean scan, and a failed stage cleanup fails the
 * scan instead of reporting success while secret bytes remain on disk.
 */

export const GITLEAKS_STAGE_FILES_MAX = 2_000;
export const GITLEAKS_STAGE_TOTAL_MAX_BYTES = 256 * 1024 * 1024;
export const GITLEAKS_STAGE_REPORT_NAME = "gitleaks-report.json";

export interface GitleaksStageArtifact {
  readonly artifactId: string;
  readonly sizeBytes: number;
  readonly digest: string;
}

export interface GitleaksEvidenceSource {
  listArtifacts(engagementId: string): Promise<GitleaksStageArtifact[]>;
  readArtifact(artifact: GitleaksStageArtifact): Promise<Buffer>;
}

export interface GitleaksScanSpawnResult {
  exitCode: number | null;
}

export interface GitleaksScanDeps {
  executable?: string;
  timeoutMs?: number;
  source: GitleaksEvidenceSource;
  spawn?: (request: { executable: string; argv: readonly string[] }) => Promise<GitleaksScanSpawnResult>;
}

export type ScanEngagementEvidenceResult =
  | {
      ok: true;
      value: { matches: GitleaksMatch[]; truncated: boolean; stagedFiles: number };
    }
  | { ok: false; error: { code: GitleaksScanErrorCode } };

export type GitleaksScanErrorCode =
  | "gitleaks_missing"
  | "gitleaks_failed"
  | "gitleaks_output_too_large"
  | "gitleaks_parse_error"
  | "evidence_too_large"
  | "invalid_persisted_data";

export interface GitleaksScanner {
  scan(engagementId: string): Promise<ScanEngagementEvidenceResult>;
}

const NUL = String.fromCharCode(0);

function isEnoent(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    if ((error as { code?: unknown }).code === "ENOENT") return true;
  }
  return error instanceof Error && error.message.includes("ENOENT");
}

function defaultSpawn(request: {
  executable: string;
  argv: readonly string[];
  timeoutMs: number;
}): Promise<GitleaksScanSpawnResult> {
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

function stageFileName(artifactId: string, index: number): string | null {
  if (!/^[a-z0-9][a-z0-9-]{0,126}$/.test(artifactId)) return null;
  return `${String(index).padStart(6, "0")}-${artifactId}.bin`;
}

export async function scanEngagementEvidence(
  engagementId: string,
  deps: GitleaksScanDeps,
): Promise<ScanEngagementEvidenceResult> {
  const executable = deps.executable ?? "/usr/bin/gitleaks";
  if (typeof executable !== "string" || !executable.startsWith("/") || executable.includes(NUL)) {
    return { ok: false, error: { code: "gitleaks_failed" } };
  }

  let stageDir: string | undefined;
  const fail = async (code: GitleaksScanErrorCode): Promise<ScanEngagementEvidenceResult> => {
    if (stageDir !== undefined) {
      await rm(stageDir, { recursive: true, force: true }).catch(() => {});
      stageDir = undefined;
    }
    return { ok: false, error: { code } };
  };

  try {
    let artifacts: GitleaksStageArtifact[];
    try {
      artifacts = await deps.source.listArtifacts(engagementId);
    } catch {
      return await fail("invalid_persisted_data");
    }
    if (artifacts.length > GITLEAKS_STAGE_FILES_MAX) {
      return await fail("evidence_too_large");
    }

    stageDir = await mkdtemp(path.join(tmpdir(), "stonehush-gitleaks-"));
    await chmod(stageDir, 0o700);
    const reportPath = path.join(stageDir, GITLEAKS_STAGE_REPORT_NAME);
    const built = buildGitleaksArgv({ sourceDir: stageDir, reportPath });
    if (!built.ok || built.argv[0] !== "gitleaks") {
      return await fail("gitleaks_failed");
    }
    const argvTail = built.argv.slice(1);

    const stagedNames = new Map<string, string>();
    let stagedBytes = 0;
    let index = 0;
    for (const artifact of artifacts) {
      const name = stageFileName(artifact.artifactId, index);
      index += 1;
      // A row that cannot be staged truthfully fails the scan: reporting
      // success over an unscanned artifact would look like a clean scan.
      if (name === null) return await fail("invalid_persisted_data");
      if (stagedBytes + artifact.sizeBytes > GITLEAKS_STAGE_TOTAL_MAX_BYTES) {
        return await fail("evidence_too_large");
      }
      let bytes: Buffer;
      try {
        bytes = await deps.source.readArtifact(artifact);
      } catch {
        return await fail("invalid_persisted_data");
      }
      if (bytes.length !== artifact.sizeBytes) return await fail("invalid_persisted_data");
      await writeFile(path.join(stageDir, name), bytes, { mode: 0o600 });
      stagedNames.set(name, artifact.artifactId);
      stagedBytes += bytes.length;
    }

    const timeoutMs = deps.timeoutMs ?? GITLEAKS_SCAN_TIMEOUT_MS;
    const spawnFn =
      deps.spawn ??
      ((request: { executable: string; argv: readonly string[] }) =>
        defaultSpawn({ ...request, timeoutMs }));
    let spawned: GitleaksScanSpawnResult;
    try {
      spawned = await spawnFn({ executable, argv: argvTail });
    } catch (error) {
      if (isEnoent(error)) return await fail("gitleaks_missing");
      return await fail("gitleaks_failed");
    }
    if (spawned.exitCode !== 0 && spawned.exitCode !== 1) {
      return await fail("gitleaks_failed");
    }

    let report: Buffer;
    try {
      // Size the report before reading it: readFile would buffer an
      // unbounded detector dump first and check second. The post-read
      // length check stays as a guard against growth between stat and read.
      const reportStats = await stat(reportPath);
      if (reportStats.size > GITLEAKS_MAX_JSON_BYTES) {
        return await fail("gitleaks_output_too_large");
      }
      report = await readFile(reportPath);
    } catch {
      // A missing report fails closed even on a clean detector exit: a
      // scan that cannot show its report cannot claim to be clean.
      return await fail("gitleaks_parse_error");
    }
    if (report.length > GITLEAKS_MAX_JSON_BYTES) {
      return await fail("gitleaks_output_too_large");
    }
    const parsed = parseGitleaksJson(new Uint8Array(report));
    if (!parsed.ok) {
      return await fail(parsed.error.code);
    }
    // Map staged file names back to artifact ids. Detector paths outside
    // the stage fail the scan instead of persisting a host path.
    const matches: GitleaksMatch[] = [];
    for (const match of parsed.matches) {
      const base = path.basename(match.file);
      const artifactId = stagedNames.get(base) ?? stagedNames.get(match.file);
      if (artifactId === undefined) {
        return await fail("gitleaks_parse_error");
      }
      matches.push({ ...match, file: artifactId });
    }

    const stagedFiles = stagedNames.size;
    const truncated = parsed.truncated;
    try {
      await rm(stageDir, { recursive: true, force: true });
      stageDir = undefined;
    } catch {
      // The scan is complete but secret bytes may remain staged: report
      // failure so the route never persists results as a clean success.
      // fail() retries the removal once before returning.
      return await fail("gitleaks_failed");
    }
    return { ok: true, value: { matches, truncated, stagedFiles } };
  } catch {
    return await fail("gitleaks_failed");
  }
}

export interface EvidenceArtifactLister {
  listArtifactsForEngagement(engagementId: string):
    | { ok: true; artifacts: { artifactId: string; sizeBytes: number; digest: string }[] }
    | { ok: false; code: string };
}

export interface VerifiedEvidenceStore {
  verifiedDownload(input: {
    artifactId: string;
    expectedSizeBytes: number;
    expectedDigest: string;
  }): Promise<
    | { status: "ready"; sizeBytes: number; digest: string; stream: AsyncGenerator<Buffer> }
    | { status: "missing" }
    | { status: "corrupt"; code: string }
  >;
}

/**
 * Wire the scanner to shipped storage: artifacts are enumerated through
 * run membership and read back through verified download, so staged bytes
 * are exactly the published bytes. Anything unverified fails the scan.
 */
export function createEvidenceScanner(input: {
  artifacts: EvidenceArtifactLister;
  store: VerifiedEvidenceStore;
  executable?: string;
}): GitleaksScanner {
  const source: GitleaksEvidenceSource = {
    listArtifacts: async (engagementId) => {
      const listed = input.artifacts.listArtifactsForEngagement(engagementId);
      if (!listed.ok) throw new Error(`artifacts unavailable: ${listed.code}`);
      return listed.artifacts.map((row) => ({
        artifactId: row.artifactId,
        sizeBytes: row.sizeBytes,
        digest: row.digest,
      }));
    },
    readArtifact: async (artifact) => {
      const download = await input.store.verifiedDownload({
        artifactId: artifact.artifactId,
        expectedSizeBytes: artifact.sizeBytes,
        expectedDigest: artifact.digest,
      });
      if (download.status !== "ready") {
        throw new Error(`artifact unavailable: ${download.status}`);
      }
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of download.stream) {
        total += chunk.length;
        if (total > artifact.sizeBytes) throw new Error("artifact grew during scan");
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, total);
    },
  };
  return {
    scan: (engagementId: string) =>
      scanEngagementEvidence(engagementId, {
        source,
        ...(input.executable === undefined ? {} : { executable: input.executable }),
      }),
  };
}
