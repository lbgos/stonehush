import { randomUUID } from "node:crypto";
import path from "node:path";

export interface RunnerConfig {
  apiBaseUrl: string;
  dataDir: string;
  runRoot: string;
  runnerId: string;
  secret: string;
  sessionId: string;
  installationFingerprint: string;
  heartbeatIntervalMs: number;
  leaseDurationMs: number;
  executable: string;
}

export function resolveRunnerConfig(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  const apiBaseUrl =
    overrides.apiBaseUrl ??
    process.env.STONEHUSH_API_BASE_URL ??
    "http://127.0.0.1:3000";
  const dataDir =
    overrides.dataDir ??
    process.env.STONEHUSH_RUNNER_DATA_DIR ??
    path.join(process.cwd(), "data");
  const runnerId = overrides.runnerId ?? process.env.STONEHUSH_RUNNER_ID ?? "";
  const secret = overrides.secret ?? process.env.STONEHUSH_RUNNER_SECRET ?? "";
  const sessionId = overrides.sessionId ?? randomUUID();
  const installationFingerprint =
    overrides.installationFingerprint ??
    process.env.STONEHUSH_INSTALLATION_FINGERPRINT ??
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const executable =
    overrides.executable ??
    process.env.STONEHUSH_NMAP_EXECUTABLE ??
    "/usr/bin/nmap";

  return {
    apiBaseUrl: apiBaseUrl.replace(/\/+$/, ""),
    dataDir,
    runRoot: overrides.runRoot ?? path.join(dataDir, "runner", "runs"),
    runnerId,
    secret,
    sessionId,
    installationFingerprint,
    heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? 10_000,
    leaseDurationMs: overrides.leaseDurationMs ?? 30_000,
    executable,
  };
}

export function validateRunnerConfig(config: RunnerConfig): { ok: true } | { ok: false; error: string } {
  if (config.runnerId.length < 1 || config.runnerId.length > 255) {
    return { ok: false, error: "runnerId must be 1-255 characters" };
  }
  if (config.secret.length < 22) {
    return { ok: false, error: "secret too short" };
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(config.installationFingerprint)) {
    return { ok: false, error: "installationFingerprint must be sha256: + 64 hex" };
  }
  if (config.apiBaseUrl.length === 0) return { ok: false, error: "apiBaseUrl required" };
  return { ok: true };
}
