import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readDevConfig } from "./dev-config.mjs";
import { assertExecutablePresent } from "./demo-config.mjs";
import {
  createChildRegistry,
  createSharedCleanup,
  createStopState,
  describeChildExit,
} from "./demo-lifecycle.mjs";
import { waitForApiReadiness } from "./dev-readiness.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_DEV_API_PORT = 3001;
export const DEFAULT_NMAP_EXECUTABLE = "/usr/bin/nmap";
export const DEV_FINGERPRINT_SEED = "stonehush-dev-runner-v1";
export const API_READY_TIMEOUT_MS = 30_000;
export const REQUEST_TIMEOUT_MS = 10_000;
const RUNNER_SRC = path.join("apps", "runner", "src", "index.ts");
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function devFingerprint() {
  return `sha256:${createHash("sha256").update(DEV_FINGERPRINT_SEED).digest("hex")}`;
}

function readApiBaseUrl(environment, repositoryRoot) {
  const rawBase = environment.STONEHUSH_API_BASE_URL;
  if (rawBase !== undefined) {
    if (rawBase.length === 0 || rawBase.includes("\0")) {
      throw new Error("STONEHUSH_API_BASE_URL must be a non-empty http(s) URL without NUL bytes.");
    }
    let url;
    try {
      url = new URL(rawBase);
    } catch {
      throw new Error("STONEHUSH_API_BASE_URL must be a valid http(s) URL.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("STONEHUSH_API_BASE_URL must use http or https.");
    }
    return rawBase.replace(/\/+$/, "");
  }
  const devConfig = readDevConfig(
    {
      STONEHUSH_API_PORT: environment.STONEHUSH_API_PORT,
      STONEHUSH_DATA_DIR: environment.STONEHUSH_DATA_DIR,
      STONEHUSH_WEB_PORT: environment.STONEHUSH_WEB_PORT,
    },
    repositoryRoot,
  );
  return `http://127.0.0.1:${devConfig.apiPort}`;
}

function readRunnerDataDir(environment, repositoryRoot) {
  const rawRunnerDir = environment.STONEHUSH_RUNNER_DATA_DIR;
  if (rawRunnerDir !== undefined) {
    if (rawRunnerDir.length === 0 || rawRunnerDir.includes("\0") || !path.isAbsolute(rawRunnerDir)) {
      throw new Error("STONEHUSH_RUNNER_DATA_DIR must be a non-empty absolute path without NUL bytes.");
    }
    return path.resolve(rawRunnerDir);
  }
  const devConfig = readDevConfig(
    {
      STONEHUSH_API_PORT: environment.STONEHUSH_API_PORT,
      STONEHUSH_DATA_DIR: environment.STONEHUSH_DATA_DIR,
      STONEHUSH_WEB_PORT: environment.STONEHUSH_WEB_PORT,
    },
    repositoryRoot,
  );
  return path.join(devConfig.dataDirectory, "runner");
}

function readFingerprint(environment) {
  const raw = environment.STONEHUSH_INSTALLATION_FINGERPRINT;
  if (raw === undefined) return devFingerprint();
  if (!FINGERPRINT_PATTERN.test(raw)) {
    throw new Error("STONEHUSH_INSTALLATION_FINGERPRINT must be sha256: plus 64 hex characters.");
  }
  return raw;
}

function readNmapExecutable(environment) {
  const raw = environment.STONEHUSH_NMAP_EXECUTABLE ?? DEFAULT_NMAP_EXECUTABLE;
  if (raw.length === 0 || raw.includes("\0") || !raw.startsWith("/")) {
    throw new Error("STONEHUSH_NMAP_EXECUTABLE must be a non-empty absolute path without NUL bytes.");
  }
  return raw;
}

function readRunnerName(environment, now = () => Date.now()) {
  const raw = environment.STONEHUSH_RUNNER_NAME;
  if (raw === undefined) return `dev-runner-${now()}`;
  if (raw.includes("\0")) {
    throw new Error("STONEHUSH_RUNNER_NAME must not contain NUL bytes.");
  }
  if (raw !== raw.trim() || Array.from(raw).length < 1 || Array.from(raw).length > 120) {
    throw new Error("STONEHUSH_RUNNER_NAME must be 1 to 120 characters without leading or trailing whitespace.");
  }
  return raw;
}

export function resolveRunnerDevConfig({ env, repositoryRoot, now = () => Date.now() }) {
  if (!path.isAbsolute(repositoryRoot)) {
    throw new Error("The runner-dev repository root must be absolute.");
  }
  const apiBaseUrl = readApiBaseUrl(env, repositoryRoot);
  const runnerDataDir = readRunnerDataDir(env, repositoryRoot);
  const fingerprint = readFingerprint(env);
  const nmapExecutable = readNmapExecutable(env);
  const runnerName = readRunnerName(env, now);

  const runnerId = env.STONEHUSH_RUNNER_ID ?? "";
  const runnerSecret = env.STONEHUSH_RUNNER_SECRET ?? "";
  if (runnerId.includes("\0")) {
    throw new Error("STONEHUSH_RUNNER_ID must not contain NUL bytes.");
  }
  const hasId = runnerId.length > 0;
  const hasSecret = runnerSecret.length > 0;
  if (hasId !== hasSecret) {
    throw new Error(
      "Partial runner credentials: set both STONEHUSH_RUNNER_ID and STONEHUSH_RUNNER_SECRET, or unset both to enroll again.",
    );
  }
  let reuse = false;
  if (hasId && hasSecret) {
    if (runnerId.length < 1 || runnerId.length > 255) {
      throw new Error("STONEHUSH_RUNNER_ID must be 1 to 255 characters.");
    }
    if (!SECRET_PATTERN.test(runnerSecret)) {
      throw new Error(
        "STONEHUSH_RUNNER_SECRET looks malformed; refusing to reuse. Unset both credential variables to enroll again.",
      );
    }
    reuse = true;
  }

  return {
    apiBaseUrl,
    fingerprint,
    nmapExecutable,
    reuse,
    runnerDataDir,
    runnerId: reuse ? runnerId : "",
    runnerName,
    runnerSecret: reuse ? runnerSecret : "",
  };
}

export function runnerSpawnArgs({ pnpmProgram, runnerAbsolutePath, tsxImport }) {
  if (tsxImport !== undefined) {
    return {
      command: process.execPath,
      args: ["--import", tsxImport, "--conditions=development", runnerAbsolutePath],
    };
  }
  return {
    command: process.execPath,
    args: [
      pnpmProgram,
      "--filter",
      "@stonehush/api",
      "exec",
      "tsx",
      "--conditions=development",
      runnerAbsolutePath,
    ],
  };
}

export function buildRunnerChildEnv({ baseEnv, plan, runnerId, runnerSecret }) {
  return {
    ...baseEnv,
    STONEHUSH_API_BASE_URL: plan.apiBaseUrl,
    STONEHUSH_INSTALLATION_FINGERPRINT: plan.fingerprint,
    STONEHUSH_NMAP_EXECUTABLE: plan.nmapExecutable,
    STONEHUSH_RUNNER_DATA_DIR: plan.runnerDataDir,
    STONEHUSH_RUNNER_ID: runnerId,
    STONEHUSH_RUNNER_SECRET: runnerSecret,
  };
}

async function apiJson(base, method, urlPath, { body, idempotencyKey, signal } = {}) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
  let response;
  try {
    response = await fetch(`${base}${urlPath}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(idempotencyKey !== undefined ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: combined,
    });
  } catch (error) {
    if (signal?.aborted === true) {
      throw new Error(`${method} ${urlPath} aborted: runner-dev stopping on signal.`);
    }
    throw error;
  }
  const text = await response.text();
  let payload;
  try {
    payload = text.length === 0 ? null : JSON.parse(text);
  } catch {
    throw new Error(`${method} ${urlPath} returned non-JSON status ${response.status}.`);
  }
  if (response.status >= 400) {
    const code = payload !== null && typeof payload === "object" ? payload.code : undefined;
    throw new Error(
      `${method} ${urlPath} failed status ${response.status}${code ? ` code ${code}` : ""}.`,
    );
  }
  return payload;
}

export async function enrollRunner({ apiBaseUrl, fingerprint, runnerName, stop, fetchJson = apiJson }) {
  const challenge = await fetchJson(apiBaseUrl, "POST", "/api/v1/runners/enrollment-challenges", {
    body: { installationFingerprint: fingerprint, name: runnerName },
    idempotencyKey: randomUUID(),
    signal: stop.stopSignal,
  });
  if (typeof challenge?.challengeId !== "string" || challenge.challengeId.length === 0) {
    throw new Error("Enrollment challenge returned no id.");
  }
  try {
    const confirmed = await fetchJson(
      apiBaseUrl,
      "POST",
      `/api/v1/runners/enrollment-challenges/${encodeURIComponent(challenge.challengeId)}/confirm`,
      {
        body: { ownerConfirmed: true },
        idempotencyKey: randomUUID(),
        signal: stop.stopSignal,
      },
    );
    const runnerId = confirmed?.runner?.id;
    const runnerRevision = confirmed?.runner?.revision;
    const runnerSecret = confirmed?.secret;
    if (typeof runnerId !== "string" || runnerId.length === 0 || runnerId.length > 255 || runnerId.includes("\0")) {
      throw new Error("Enrollment confirm returned no runner id.");
    }
    if (
      runnerRevision !== 1 ||
      confirmed.runner.status !== "enabled" ||
      confirmed.runner.installationFingerprint !== fingerprint ||
      confirmed.runner.name !== runnerName
    ) {
      throw new Error("Enrollment confirm returned no matching newly created runner identity.");
    }
    if (typeof runnerSecret !== "string" || !SECRET_PATTERN.test(runnerSecret)) {
      throw new Error("Enrollment confirm returned no usable runner secret.");
    }
    return { runnerId, runnerRevision, runnerSecret };
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} Confirmation may have enabled a runner. Inspect the API enrollment state and explicitly revoke only that identity before retrying; no identity was guessed or revoked.`,
    );
  }
}

// Call only for a successful enrollment owned by this launch, after stopping
// its child. Reused or uncertain identities must never enter this cleanup.
export async function revokeEnrolledRunner({ apiBaseUrl, runnerId, runnerRevision, fetchJson = apiJson }) {
  const revoked = await fetchJson(apiBaseUrl, "POST", `/api/v1/runners/${encodeURIComponent(runnerId)}/revoke`, {
    body: { expectedRevision: runnerRevision },
    idempotencyKey: randomUUID(),
  });
  if (
    revoked?.runner?.id !== runnerId ||
    revoked.runner.status !== "revoked" ||
    revoked.runner.revision !== runnerRevision + 1
  ) {
    throw new Error("Runner revocation returned no matching revoked identity.");
  }
  return revoked;
}

function spawnChild(command, args, { cwd, env }) {
  const child = spawn(command, args, { cwd, detached: true, env, shell: false, stdio: "inherit" });
  return child;
}

// The caller owns preflight, API readiness, signal handling and cleanup.
// Enrollment and credentials are shared with the standalone starter.
export async function startRunnerDev({
  plan, stop, registry, baseEnv, pnpmProgram, repositoryRoot,
  tsxImport, spawnImplementation = spawnChild, onEnrolled = () => {},
}) {
  stop.throwIfStopping("runner directory setup");
  await mkdir(plan.runnerDataDir, { mode: 0o700, recursive: true });
  stop.throwIfStopping("runner enrollment");
  const credentials = plan.reuse
    ? { runnerId: plan.runnerId, runnerSecret: plan.runnerSecret }
    : await enrollRunner({
      apiBaseUrl: plan.apiBaseUrl,
      fingerprint: plan.fingerprint,
      runnerName: plan.runnerName,
      stop,
    });
  if (!plan.reuse) onEnrolled({ runnerId: credentials.runnerId, runnerRevision: credentials.runnerRevision });
  console.log(plan.reuse
    ? "Reusing existing runner credentials from the environment."
    : `Runner enrolled as ${plan.runnerName}: ${credentials.runnerId}, revision ${credentials.runnerRevision}.`);
  stop.throwIfStopping("runner startup");
  const { command, args } = runnerSpawnArgs({
    pnpmProgram,
    runnerAbsolutePath: path.join(repositoryRoot, RUNNER_SRC),
    tsxImport,
  });
  const child = spawnImplementation(command, args, {
    cwd: repositoryRoot,
    env: buildRunnerChildEnv({ baseEnv, plan, ...credentials }),
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return registry.track(child, exited, "runner");
}

async function main() {
  let plan;
  try {
    plan = resolveRunnerDevConfig({ env: process.env, repositoryRoot });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const pnpmProgram = process.env.npm_execpath;
  if (!pnpmProgram) {
    console.error("pnpm executable path is unavailable. Start the runner with pnpm runner:dev.");
    process.exitCode = 1;
    return;
  }

  const registry = createChildRegistry();
  const stop = createStopState();
  let ownedEnrollment;
  const shutdown = createSharedCleanup(async () => {
    await registry.shutdown();
    if (ownedEnrollment === undefined) return;
    try {
      await revokeEnrolledRunner({ apiBaseUrl: plan.apiBaseUrl, ...ownedEnrollment });
      console.log(`Revoked temporary runner ${ownedEnrollment.runnerId}.`);
    } catch {
      console.error(
        `Temporary runner cleanup could not confirm revocation. Explicitly recover runner ${ownedEnrollment.runnerId} at recorded revision ${ownedEnrollment.runnerRevision} through the configured API before enrolling again; do not revoke another identity.`,
      );
    }
  });

  let signalResolve = null;
  const gotSignal = new Promise((resolve) => {
    signalResolve = resolve;
  });
  function handleSignal(name) {
    stop.requestStop(name);
    signalResolve?.(name);
  }
  process.once("SIGINT", () => handleSignal("SIGINT"));
  process.once("SIGTERM", () => handleSignal("SIGTERM"));

  try {
    stop.throwIfStopping("tool preflight");
    await assertExecutablePresent(plan.nmapExecutable, "nmap");
    stop.throwIfStopping("data directory setup");
    await mkdir(plan.runnerDataDir, { mode: 0o700, recursive: true });

    stop.throwIfStopping("API readiness");
    await Promise.race([
      waitForApiReadiness({
        exited: new Promise(() => {}),
        timeoutMs: API_READY_TIMEOUT_MS,
        url: `${plan.apiBaseUrl}/health`,
      }),
      stop.stopped.then(() => "stopped"),
    ]).then((outcome) => {
      if (outcome === "stopped") stop.throwIfStopping("API readiness");
    });

    const tracked = await startRunnerDev({
      plan, stop, registry, baseEnv: process.env, pnpmProgram, repositoryRoot,
      onEnrolled: (identity) => { ownedEnrollment = identity; },
    });

    console.log(`Runner connected to ${plan.apiBaseUrl}. Press Ctrl+C to stop; only runner-dev-owned processes are cleaned up.`);
    const settled = await Promise.race([gotSignal, registry.anyExit()]);
    await shutdown();
    if (settled === "SIGINT" || settled === "SIGTERM") {
      process.exitCode = settled === "SIGINT" ? 130 : 143;
      return;
    }
    if (settled !== undefined && typeof settled === "object") {
      console.error(`Runner stack unhealthy while running: ${describeChildExit(settled)}.`);
      process.exitCode = 1;
      return;
    }
    void tracked;
  } catch (error) {
    console.error(`runner-dev failed: ${error instanceof Error ? error.message : String(error)}`);
    await shutdown();
    process.exitCode = stop.signalName === "SIGTERM" ? 143 : stop.signalName === "SIGINT" ? 130 : 1;
    if (stop.stopping) process.exit(process.exitCode);
  }
}

const isDirectRun = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  await main();
}
