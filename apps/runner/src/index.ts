#!/usr/bin/env node
import { createRunnerLoop } from "./runner.js";
import { resolveRunnerConfig, validateRunnerConfig } from "./config.js";

const config = resolveRunnerConfig();
const validated = validateRunnerConfig(config);
if (!validated.ok) {
  console.error(`runner config invalid: ${validated.error}`);
  process.exit(2);
}

console.log(`stonehush-runner starting session ${config.sessionId} api=${config.apiBaseUrl} runner=${config.runnerId}`);

const loop = createRunnerLoop(config);
loop.start();

let shuttingDown = false;
let exitCode = 0;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`runner received ${signal}, stopping`);
  try {
    await loop.stop();
  } catch {
    exitCode = 1;
  }
  process.exitCode = exitCode;
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
