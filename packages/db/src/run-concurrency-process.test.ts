import { existsSync, writeFileSync } from "node:fs";

import { describe, it } from "vitest";

import { openEngagementDatabase } from "./database.js";
import { RunRepository } from "./run.js";

const workerConfiguration = {
  dataDirectory: process.env.STONEHUSH_RUN_CONCURRENCY_DATA_DIRECTORY,
  runId: process.env.STONEHUSH_RUN_CONCURRENCY_RUN_ID,
  runnerId: process.env.STONEHUSH_RUN_CONCURRENCY_RUNNER_ID,
  sessionId: process.env.STONEHUSH_RUN_CONCURRENCY_SESSION_ID,
  readyPath: process.env.STONEHUSH_RUN_CONCURRENCY_READY_PATH,
  goPath: process.env.STONEHUSH_RUN_CONCURRENCY_GO_PATH,
  resultPath: process.env.STONEHUSH_RUN_CONCURRENCY_RESULT_PATH,
};

const isWorker = Object.values(workerConfiguration).every((value) => value !== undefined);

describe.runIf(isWorker)("run lease concurrency process", () => {
  it("acquires one lease after the parent releases the barrier", () => {
    const {
      dataDirectory,
      runId,
      runnerId,
      sessionId,
      readyPath,
      goPath,
      resultPath,
    } = workerConfiguration;
    if (
      dataDirectory === undefined ||
      runId === undefined ||
      runnerId === undefined ||
      sessionId === undefined ||
      readyPath === undefined ||
      goPath === undefined ||
      resultPath === undefined
    ) {
      return;
    }

    const database = openEngagementDatabase({ dataDirectory });
    try {
      const runs = new RunRepository(database.db);
      writeFileSync(readyPath, "ready", { mode: 0o600 });
      while (!existsSync(goPath)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      const result = runs.acquireLease({
        runId,
        runnerId,
        sessionId,
        serverNow: "2026-08-09T12:00:00.000Z",
      });
      writeFileSync(resultPath, JSON.stringify(result), { mode: 0o600 });
    } finally {
      database.close();
    }
  });
});
