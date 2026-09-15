import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openEngagementDatabase } from "./database.js";
import { OperatorCommandRepository, type PreparedOperatorCommand } from "./operator-command.js";
import {
  EngagementRepository,
  type EngagementWriteTransaction,
} from "./repository.js";

const directories: string[] = [];
const databases: ReturnType<typeof openEngagementDatabase>[] = [];

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "stonehush-command-test-"));
  directories.push(directory);
  chmodSync(directory, 0o700);
  const database = openEngagementDatabase({ dataDirectory: directory });
  databases.push(database);
  const engagementRepository = new EngagementRepository(database.db, {
    createId: () => "10000000-0000-4000-8000-000000000001",
    now: () => new Date("2026-08-12T12:00:00.000Z"),
  });
  const commandRepository = new OperatorCommandRepository(engagementRepository, {
    now: () => new Date("2026-08-12T12:01:00.000Z"),
  });
  return { directory, database, engagementRepository, commandRepository };
}

function command(
  overrides: Partial<PreparedOperatorCommand> = {},
): PreparedOperatorCommand {
  return {
    actorId: "local-operator-v1",
    route: "/api/v1/engagements",
    operation: "create",
    idempotencyKey: "fixture-idempotency-key-0001",
    canonicalizationProfile: "command-json-v1",
    requestDigest:
      "sha256:b8a1a7e36d9307ad76be0324867dc33bed145bd6553a5782ce594e4c1a29a8cf",
    ...overrides,
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) {
    if (database.sqlite.open) database.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("operator command idempotency", () => {
  it("applies once and replays the byte-identical stored response", () => {
    const { database, engagementRepository, commandRepository } = fixture();
    let mutations = 0;
    const mutate = (transaction: EngagementWriteTransaction) => {
      mutations += 1;
      const created = transaction.createEngagement({
        name: "Target lab",
        kind: "lab",
        autoContinueWarnings: false,
      });
      if (!created.ok) throw new Error(`Fixture failed: ${created.error.code}`);
      return { status: 201, body: { engagement: created.value } } as const;
    };

    const applied = commandRepository.executeOperatorCommand(command(), mutate);
    const replayed = commandRepository.executeOperatorCommand(command(), mutate);

    expect(applied).toMatchObject({ ok: true, disposition: "applied" });
    expect(replayed).toEqual(
      applied.ok
        ? { ...applied, disposition: "replayed" }
        : applied,
    );
    expect(mutations).toBe(1);
    expect(engagementRepository.listEngagements()).toMatchObject({
      ok: true,
      value: [{ name: "Target lab" }],
    });
    expect(
      database.sqlite
        .prepare("select count(*) from operator_command_idempotency")
        .pluck()
        .get(),
    ).toBe(1);
  });

  it("conflicts before mutation when the tuple key has another digest", () => {
    const { commandRepository } = fixture();
    expect(
      commandRepository.executeOperatorCommand(command(), () => ({
        status: 409,
        body: { code: "first" },
      })),
    ).toMatchObject({ ok: true, disposition: "applied" });
    let mutations = 0;

    expect(
      commandRepository.executeOperatorCommand(
        command({
          requestDigest:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        }),
        () => {
          mutations += 1;
          return { status: 200, body: null };
        },
      ),
    ).toEqual({ ok: false, error: { code: "idempotency_conflict" } });
    expect(mutations).toBe(0);
  });

  it("scopes the same key independently by actor, concrete route, and operation", () => {
    const { commandRepository } = fixture();
    const commands = [
      command(),
      command({ actorId: "future-operator-v1" }),
      command({ route: "/api/v1/engagements/fixture" }),
      command({ operation: "archive" }),
    ];
    let mutations = 0;
    for (const prepared of commands) {
      expect(
        commandRepository.executeOperatorCommand(prepared, () => {
          mutations += 1;
          return { status: 202, body: { mutation: mutations } };
        }),
      ).toMatchObject({ ok: true, disposition: "applied" });
    }
    expect(mutations).toBe(4);
  });

  it("rolls back mutation and record when response serialization is invalid", () => {
    const { database, engagementRepository, commandRepository } = fixture();
    const result = commandRepository.executeOperatorCommand(command(), (transaction) => {
      const created = transaction.createEngagement({
        name: "Target lab",
        kind: "lab",
        autoContinueWarnings: false,
      });
      if (!created.ok) throw new Error(`Fixture failed: ${created.error.code}`);
      return { status: 201, body: { unsupported: undefined } as never };
    });

    expect(result).toEqual({ ok: false, error: { code: "invalid_command_input" } });
    expect(engagementRepository.listEngagements()).toEqual({ ok: true, value: [] });
    expect(
      database.sqlite
        .prepare("select count(*) from operator_command_idempotency")
        .pluck()
        .get(),
    ).toBe(0);
  });

  it("rolls back mutation when the callback throws without reflecting its error", () => {
    const { engagementRepository, commandRepository } = fixture();
    const result = commandRepository.executeOperatorCommand(command(), (transaction) => {
      transaction.createEngagement({
        name: "Target lab",
        kind: "lab",
        autoContinueWarnings: false,
      });
      throw new Error("SENSITIVE_MUTATION_MARKER");
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "invalid_persisted_data" },
    });
    expect(JSON.stringify(result)).not.toContain("SENSITIVE_MUTATION_MARKER");
    expect(engagementRepository.listEngagements()).toEqual({ ok: true, value: [] });
  });

  it("rejects Promise-returning mutations at type and runtime and rolls back", () => {
    const { engagementRepository, commandRepository } = fixture();
    if (false) {
      // @ts-expect-error Operator command mutations must be synchronous.
      commandRepository.executeOperatorCommand(command(), async () => ({
        status: 200,
        body: null,
      }));
    }
    const result = Reflect.apply(commandRepository.executeOperatorCommand, commandRepository, [
      command(),
      async (transaction: EngagementWriteTransaction) => {
        transaction.createEngagement({
          name: "Target lab",
          kind: "lab",
          autoContinueWarnings: false,
        });
        return { status: 201, body: null };
      },
    ]);

    expect(result).toEqual({ ok: false, error: { code: "invalid_command_input" } });
    expect(engagementRepository.listEngagements()).toEqual({ ok: true, value: [] });
  });

  it("fails closed on noncanonical persisted response data", () => {
    const { database, commandRepository } = fixture();
    expect(
      commandRepository.executeOperatorCommand(command(), () => ({
        status: 200,
        body: { a: 1, b: 2 },
      })),
    ).toMatchObject({ ok: true });
    database.sqlite
      .prepare(
        "update operator_command_idempotency set response_body_json = ? where idempotency_key = ?",
      )
      .run('{"b":2,"a":1}', command().idempotencyKey);

    expect(
      commandRepository.executeOperatorCommand(command(), () => ({
        status: 200,
        body: null,
      })),
    ).toEqual({ ok: false, error: { code: "invalid_persisted_data" } });
  });

  it("rejects invalid command metadata before opening a mutation", () => {
    const { commandRepository } = fixture();
    let mutations = 0;
    const result = commandRepository.executeOperatorCommand(
      command({ idempotencyKey: "short" }),
      () => {
        mutations += 1;
        return { status: 200, body: null };
      },
    );
    expect(result).toEqual({ ok: false, error: { code: "invalid_command_input" } });
    expect(mutations).toBe(0);
  });

  it("enforces route and operation contract shapes in raw storage", () => {
    const { database } = fixture();
    const insert = database.sqlite.prepare(`
      insert into operator_command_idempotency (
        actor_id, route, operation, idempotency_key, canonicalization_profile,
        request_digest, response_status, response_body_json, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const values = [
      "local-operator-v1",
      "/api/v1/engagements",
      "create",
      "fixture-idempotency-key-storage",
      "command-json-v1",
      command().requestDigest,
      200,
      "null",
      "2026-08-12T12:01:00.000Z",
    ] as const;

    expect(() => insert.run(...values.with(1, "/api/v1/engagements?raw=true"))).toThrow(
      /operator_command_route/,
    );
    expect(() => insert.run(...values.with(1, "/other"))).toThrow(
      /operator_command_route/,
    );
    expect(() => insert.run(...values.with(2, "1create"))).toThrow(
      /operator_command_operation/,
    );
  });

  it("replays a stored result from a second database connection", () => {
    const first = fixture();
    const secondDatabase = openEngagementDatabase({ dataDirectory: first.directory });
    databases.push(secondDatabase);
    const second = new OperatorCommandRepository(
      new EngagementRepository(secondDatabase.db),
    );
    let mutations = 0;
    expect(
      first.commandRepository.executeOperatorCommand(command(), () => {
        mutations += 1;
        return { status: 204, body: null };
      }),
    ).toMatchObject({ ok: true, disposition: "applied" });
    expect(
      second.executeOperatorCommand(command(), () => {
        mutations += 1;
        return { status: 200, body: null };
      }),
    ).toMatchObject({ ok: true, disposition: "replayed" });
    expect(mutations).toBe(1);
  });

  it("serializes competing processes into one mutation and one replay", async () => {
    const { directory } = fixture();
    const goPath = path.join(directory, "go");
    const workers = [0, 1].map((index) => {
      const readyPath = path.join(directory, `ready-${index}`);
      const resultPath = path.join(directory, `result-${index}.json`);
      const child = spawn(
        "pnpm",
        ["exec", "vitest", "run", "src/operator-command-concurrency-process.test.ts", "--reporter=dot"],
        {
          cwd: path.resolve(import.meta.dirname, ".."),
          env: {
            ...process.env,
            FORCE_COLOR: "0",
            STONEHUSH_CONCURRENCY_DATA_DIRECTORY: directory,
            STONEHUSH_CONCURRENCY_READY_PATH: readyPath,
            STONEHUSH_CONCURRENCY_GO_PATH: goPath,
            STONEHUSH_CONCURRENCY_RESULT_PATH: resultPath,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      return { child, readyPath, resultPath, output: () => ({ stdout, stderr }) };
    });
    const deadline = Date.now() + 5_000;
    while (!workers.every(({ readyPath }) => existsSync(readyPath))) {
      const failedWorker = workers.find(({ child }) => child.exitCode !== null);
      if (failedWorker !== undefined) {
        throw new Error(
          `Worker exited ${failedWorker.child.exitCode} before the barrier: ${JSON.stringify(failedWorker.output())}`,
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Workers did not reach the barrier: ${JSON.stringify(workers.map(({ output }) => output()))}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    writeFileSync(goPath, "go", { mode: 0o600 });
    const results = await Promise.all(
      workers.map(
        ({ child, resultPath, output }) =>
          new Promise<unknown>((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", (code) => {
              if (code === 0) resolve(JSON.parse(readFileSync(resultPath, "utf8")));
              else reject(new Error(`Worker exited ${code}: ${JSON.stringify(output())}`));
            });
          }),
      ),
    );
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ok: true, disposition: "applied" }),
        expect.objectContaining({ ok: true, disposition: "replayed" }),
      ]),
    );
  }, 10_000);

  it("returns storage_busy without a record and permits the same-key retry", () => {
    const first = fixture();
    const secondDatabase = openEngagementDatabase({ dataDirectory: first.directory });
    databases.push(secondDatabase);
    const second = new OperatorCommandRepository(
      new EngagementRepository(secondDatabase.db),
    );
    first.database.sqlite.exec("begin immediate");
    const busy = second.executeOperatorCommand(command(), () => ({
      status: 200,
      body: null,
    }));
    first.database.sqlite.exec("rollback");
    expect(busy).toEqual({ ok: false, error: { code: "storage_busy" } });
    expect(
      secondDatabase.sqlite
        .prepare("select count(*) from operator_command_idempotency")
        .pluck()
        .get(),
    ).toBe(0);
    expect(
      second.executeOperatorCommand(command(), () => ({ status: 200, body: null })),
    ).toMatchObject({ ok: true, disposition: "applied" });
  }, 10_000);
});
