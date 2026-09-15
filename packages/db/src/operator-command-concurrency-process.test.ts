import { existsSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { openEngagementDatabase } from "./database.js";
import { OperatorCommandRepository } from "./operator-command.js";
import { EngagementRepository } from "./repository.js";

const workerConfiguration = {
  dataDirectory: process.env.STONEHUSH_CONCURRENCY_DATA_DIRECTORY,
  readyPath: process.env.STONEHUSH_CONCURRENCY_READY_PATH,
  goPath: process.env.STONEHUSH_CONCURRENCY_GO_PATH,
  resultPath: process.env.STONEHUSH_CONCURRENCY_RESULT_PATH,
};

const isWorker = Object.values(workerConfiguration).every((value) => value !== undefined);

describe.runIf(isWorker)("operator command concurrency process", () => {
  it("executes one command after the parent releases the barrier", () => {
    const { dataDirectory, readyPath, goPath, resultPath } = workerConfiguration;
    expect(dataDirectory).toBeDefined();
    expect(readyPath).toBeDefined();
    expect(goPath).toBeDefined();
    expect(resultPath).toBeDefined();
    if (
      dataDirectory === undefined ||
      readyPath === undefined ||
      goPath === undefined ||
      resultPath === undefined
    ) {
      return;
    }

    const database = openEngagementDatabase({ dataDirectory });
    try {
      const repository = new OperatorCommandRepository(
        new EngagementRepository(database.db, {
          createId: () => "10000000-0000-4000-8000-000000000001",
          now: () => new Date("2026-08-12T12:00:00.000Z"),
        }),
        { now: () => new Date("2026-08-12T12:01:00.000Z") },
      );
      writeFileSync(readyPath, "ready", { mode: 0o600 });
      while (!existsSync(goPath)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      const result = repository.executeOperatorCommand(
        {
          actorId: "local-operator-v1",
          route: "/api/v1/engagements",
          operation: "create",
          idempotencyKey: "fixture-idempotency-key-concurrent",
          canonicalizationProfile: "command-json-v1",
          requestDigest:
            "sha256:b8a1a7e36d9307ad76be0324867dc33bed145bd6553a5782ce594e4c1a29a8cf",
        },
        (transaction) => {
          const created = transaction.createEngagement({
            name: "Concurrent lab",
            kind: "lab",
            autoContinueWarnings: false,
          });
          if (!created.ok) throw new Error("Concurrent mutation applied twice.");
          return { status: 201, body: { engagementId: created.value.id } };
        },
      );
      writeFileSync(resultPath, JSON.stringify(result), { mode: 0o600 });
    } finally {
      database.close();
    }
  });
});
