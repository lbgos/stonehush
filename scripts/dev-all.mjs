import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { readDevConfig } from "./dev-config.mjs";
import { assertExecutablePresent, assertPortsFree } from "./demo-config.mjs";
import { createChildRegistry, createSharedCleanup, createStopState } from "./demo-lifecycle.mjs";
import { probeApiHealth, waitForApiReadiness } from "./dev-readiness.mjs";
import { resolveRunnerDevConfig, startRunnerDev } from "./runner-dev.mjs";

export const COMBINED_READY_TIMEOUT_MS = 30_000;

export function resolveCombinedConfig(env, repositoryRoot) {
  const dev = readDevConfig(env, repositoryRoot);
  const runner = resolveRunnerDevConfig({ env, repositoryRoot });
  const url = new URL(runner.apiBaseUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)
    || Number(url.port || 80) !== dev.apiPort || url.pathname !== "/"
    || url.search || url.hash || url.username || url.password) {
    throw new Error("STONEHUSH_API_BASE_URL must match the local API started by dev:all.");
  }
  return { dev, runner: { ...runner, apiBaseUrl: `http://127.0.0.1:${dev.apiPort}` } };
}

// Each wait fails on any child exit or stop request, even during enrollment.
export async function superviseWait(operation, { registry, stop, timeoutMs = COMBINED_READY_TIMEOUT_MS }) {
  stop.throwIfStopping("startup");
  const deadline = new AbortController();
  try {
    return await Promise.race([
      operation,
      registry.anyExit().then(() => { throw new Error("An owned development child exited unexpectedly."); }),
      stop.stopped.then(() => { throw new Error("Development startup stopped."); }),
      ...(Number.isFinite(timeoutMs) ? [delay(timeoutMs, undefined, { signal: deadline.signal }).then(() => {
        throw new Error("Development startup readiness deadline exceeded.");
      })] : []),
    ]);
  } finally {
    deadline.abort();
  }
}

export function childReady(child, type) {
  return new Promise((resolve, reject) => {
    function onMessage(message) {
      if (message !== null && typeof message === "object" && message.type === type
        && Object.keys(message).length === 1) {
        cleanup();
        resolve();
      }
    }
    function onDisconnect() {
      cleanup();
      reject(new Error("Development child disconnected before readiness."));
    }
    function cleanup() {
      child.off("message", onMessage);
      child.off("disconnect", onDisconnect);
    }
    child.on("message", onMessage);
    child.once("disconnect", onDisconnect);
  });
}

export async function waitForWebReadiness({ url, signal, fetchImplementation = fetch }) {
  while (!signal.aborted) {
    try {
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(500)]);
      const page = await fetchImplementation(url, { signal: requestSignal });
      const html = await page.text();
      if (page.status === 200 && html.includes('id="root"')
        && await probeApiHealth(fetchImplementation, `${url}/health`, signal)) return;
    } catch {
      signal.throwIfAborted();
    }
    await delay(50, undefined, { signal });
  }
  signal.throwIfAborted();
}

export async function runCombinedDev({ repositoryRoot, env = process.env }) {
  const registry = createChildRegistry();
  const stop = createStopState();
  const shutdown = createSharedCleanup(() => registry.shutdown());
  const onSignal = (name) => {
    stop.requestStop(name);
    void shutdown();
  };
  const onInt = () => onSignal("SIGINT");
  const onTerm = () => onSignal("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);

  try {
    const { dev, runner } = resolveCombinedConfig(env, repositoryRoot);
    const require = createRequire(path.join(repositoryRoot, "apps/api/package.json"));
    const tsxImport = require.resolve("tsx");
    const pnpmProgram = env.npm_execpath;
    if (!pnpmProgram) throw new Error("Start the complete development stack with pnpm dev:all.");
    await assertExecutablePresent(runner.nmapExecutable, "nmap");
    stop.throwIfStopping("port preflight");
    await assertPortsFree("127.0.0.1", [dev.apiPort, dev.webPort]);
    stop.throwIfStopping("API startup");

    // Credentials belong only to the runner, never to API/web children.
    const { STONEHUSH_RUNNER_ID: _id, STONEHUSH_RUNNER_SECRET: _secret, ...publicEnv } = env;
    const environment = {
      ...publicEnv,
      STONEHUSH_API_PORT: String(dev.apiPort),
      STONEHUSH_WEB_PORT: String(dev.webPort),
      STONEHUSH_DATA_DIR: dev.dataDirectory,
    };
    function spawnOwned(command, args, { cwd, env: childEnv }, label) {
      stop.throwIfStopping(`${label} startup`);
      return spawn(command, args, {
        cwd, env: childEnv, detached: true, shell: false,
        stdio: ["inherit", "inherit", "inherit", "ipc"],
      });
    }
    function start(label, args, cwd) {
      const child = spawnOwned(process.execPath, args, { cwd, env: environment }, label);
      const exited = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      return registry.track(child, exited, label);
    }
    const api = start("API", ["--import", tsxImport, "--conditions=development",
      path.join(repositoryRoot, "apps/api/src/server.ts")], repositoryRoot);
    // IPC proves this child successfully bound its listener, not a foreign /health.
    await superviseWait(childReady(api.child, "stonehush-api-ready"), { registry, stop });
    await superviseWait(waitForApiReadiness({
      exited: api.exited, url: `${runner.apiBaseUrl}/health`, signal: stop.stopSignal,
    }), { registry, stop });
    stop.throwIfStopping("web startup");
    const webRequire = createRequire(path.join(repositoryRoot, "apps/web/package.json"));
    const viteEntry = path.join(path.dirname(webRequire.resolve("vite/package.json")), "bin/vite.js");
    const web = start("web", [viteEntry], path.join(repositoryRoot, "apps/web"));
    // Vite has no readiness IPC. Its channel must not keep the child alive.
    web.child.disconnect();
    const webUrl = `http://127.0.0.1:${dev.webPort}`;
    await superviseWait(waitForWebReadiness({ url: webUrl, signal: stop.stopSignal }), { registry, stop });
    const startedRunner = await superviseWait(startRunnerDev({
      plan: runner, stop, registry, baseEnv: environment, pnpmProgram, repositoryRoot, tsxImport,
      spawnImplementation: (command, args, options) => spawnOwned(command, args, options, "runner"),
    }), { registry, stop });
    await superviseWait(childReady(startedRunner.child, "stonehush-runner-ready"), { registry, stop });
    stop.throwIfStopping("ready announcement");
    console.log(`Stonehush ready at ${webUrl}. API, web and runner are connected. Press Ctrl+C to stop.`);
    await superviseWait(new Promise(() => {}), { registry, stop, timeoutMs: Infinity });
  } catch (error) {
    if (!stop.stopping) console.error(`dev:all failed: ${error instanceof Error ? error.message : "startup failed"}`);
    // Abort outstanding enrollment and readiness before cleanup. This also prevents late spawns.
    stop.requestStop("failure");
    await shutdown();
    process.exitCode = stop.signalName === "SIGINT" ? 130 : stop.signalName === "SIGTERM" ? 143 : 1;
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
}
