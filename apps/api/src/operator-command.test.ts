import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import fixtureData from "../../../docs/architecture/fixtures/d2/canonical-request.json" with {
  type: "json",
};
import {
  JsonValueSchema,
  MAX_CANONICAL_JSON_DEPTH,
  commandJsonV1CreateEngagementDigest,
  projectCommandJsonV1DigestInput,
  type JsonValue,
} from "@stonehush/contracts";
import {
  EngagementRepository,
  OperatorCommandRepository,
  openEngagementDatabase,
} from "@stonehush/db";
import {
  LOCAL_OPERATOR_ACTOR_ID,
  executeOperatorMutation,
  parseBoundedDigestInput,
  prepareLocalOperatorCommand,
} from "./operator-command.js";

interface CommandFixture {
  id: string;
  given: {
    value: {
      route: string;
      operation: string;
      path: JsonValue;
      query: JsonValue;
      body: JsonValue;
    };
  };
  expected: { digest: string };
}

const commandFixtures = (fixtureData as { cases: CommandFixture[] }).cases.filter(
  (fixtureCase) => "route" in fixtureCase.given.value,
);

function nestedJsonThatThrowsParse(leaf: JsonValue): JsonValue {
  let candidate: JsonValue = leaf;
  for (let index = 0; index < 32_768; index += 1) {
    candidate = [candidate];
  }
  try {
    JsonValueSchema.safeParse(candidate);
  } catch {
    return candidate;
  }
  throw new Error("Could not reproduce Zod JSON RangeError.");
}

function jsonParseThrows(value: unknown): boolean {
  try {
    JsonValueSchema.safeParse(value);
    return false;
  } catch (error) {
    return error instanceof RangeError;
  }
}

describe("local operator command preparation", () => {
  it("binds server-owned identity and exact fixture digests", () => {
    for (const fixtureCase of commandFixtures) {
      const value = fixtureCase.given.value;
      expect(
        prepareLocalOperatorCommand({
          key: "fixture-idempotency-key-0001",
          route: value.route,
          operation: value.operation,
          path: value.path,
          query: value.query,
          body: value.body,
        }),
        fixtureCase.id,
      ).toEqual({
        ok: true,
        command: {
          actorId: LOCAL_OPERATOR_ACTOR_ID,
          route: value.route,
          operation: value.operation,
          idempotencyKey: "fixture-idempotency-key-0001",
          canonicalizationProfile: "command-json-v1",
          requestDigest: fixtureCase.expected.digest,
        },
      });
    }
  });

  it("binds path, query, body, route, and operation independently", () => {
    const base = {
      key: "fixture-idempotency-key-0001",
      route: "/api/v1/engagements",
      operation: "create",
      path: {},
      query: {},
      body: { value: null },
    };
    const prepared = prepareLocalOperatorCommand(base);
    if (!prepared.ok) throw new Error("Fixture preparation failed.");
    for (const changed of [
      { ...base, route: "/api/v1/engagements/fixture" },
      { ...base, operation: "archive" },
      { ...base, path: { id: "fixture" } },
      { ...base, query: { mode: "fixture" } },
      { ...base, body: {} },
    ]) {
      const result = prepareLocalOperatorCommand(changed);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.command.requestDigest).not.toBe(prepared.command.requestDigest);
      }
    }
  });

  it("rejects invalid keys, routes, operations, and semantic values without reflection", () => {
    const marker = "SENSITIVE_UNTRUSTED_MARKER";
    const compileTimeOnly = (): void => {
      prepareLocalOperatorCommand({
        key: "fixture-idempotency-key-0001",
        route: "/api/v1/engagements",
        operation: "create",
        path: {},
        query: {},
        // @ts-expect-error Callers must pass successful JSON schema outputs.
        body: { value: undefined },
      });
    };
    expect(compileTimeOnly).toBeTypeOf("function");
    for (const input of [
      {
        key: "short",
        route: "/api/v1/engagements",
        operation: "create",
        path: {},
        query: {},
        body: {},
      },
      {
        key: "fixture-idempotency-key-0001",
        route: `/api/v1/engagements?${marker}`,
        operation: "create",
        path: {},
        query: {},
        body: {},
      },
      {
        key: "fixture-idempotency-key-0001",
        route: "/api/v1/engagements",
        operation: "Create",
        path: {},
        query: {},
        body: {},
      },
      {
        key: "fixture-idempotency-key-0001",
        route: "/api/v1/engagements",
        operation: "create",
        path: {},
        query: {},
        body: { value: undefined },
      },
    ]) {
      const result = Reflect.apply(prepareLocalOperatorCommand, undefined, [input]);
      expect(result).toEqual({
        ok: false,
        error: { code: "invalid_command_input" },
      });
      expect(JSON.stringify(result)).not.toContain(marker);
    }
  });
});

const commandFixturesDirs: string[] = [];
const commandDatabases: ReturnType<typeof openEngagementDatabase>[] = [];

function commandRepositoryFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "stonehush-command-seam-"));
  commandFixturesDirs.push(directory);
  chmodSync(directory, 0o700);
  const database = openEngagementDatabase({ dataDirectory: directory });
  commandDatabases.push(database);
  const engagementRepository = new EngagementRepository(database.db, {
    createId: () => "10000000-0000-4000-8000-000000000001",
    now: () => new Date("2026-08-12T12:00:00.000Z"),
  });
  const commandRepository = new OperatorCommandRepository(engagementRepository, {
    now: () => new Date("2026-08-12T12:01:00.000Z"),
  });
  return { commandRepository, database };
}

afterEach(() => {
  for (const database of commandDatabases.splice(0)) {
    if (database.sqlite.open) database.close();
  }
  for (const directory of commandFixturesDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("operator mutation digest lookup", () => {
  const createEngagementDigest =
    commandFixtures.find((fixtureCase) => fixtureCase.id === "d2.canonical.create-engagement")
      ?.expected.digest;
  const input = {
    key: "fixture-idempotency-key-0001",
    route: "/api/v1/engagements",
    operation: "create",
    path: {},
    query: {},
    body: { name: "Target lab", kind: "lab", autoContinueWarnings: false },
    digest: commandJsonV1CreateEngagementDigest,
  };

  it("replays the stored response without invoking the absent-path validator", () => {
    const { commandRepository } = commandRepositoryFixture();
    const applied = executeOperatorMutation(
      commandRepository,
      input,
      (transaction) => {
        const created = transaction.createEngagement(input.body);
        if (!created.ok) throw new Error(`Fixture failed: ${created.error.code}`);
        return { status: 201, body: { id: created.value.id } };
      },
    );
    expect(applied).toMatchObject({ ok: true, disposition: "applied" });

    let validatorCalls = 0;
    const replayed = executeOperatorMutation(
      commandRepository,
      input,
      () => {
        validatorCalls += 1;
        throw new Error("absent-path validator must not run on exact replay");
      },
    );
    expect(replayed).toEqual(
      applied.ok ? { ...applied, disposition: "replayed" } : applied,
    );
    expect(validatorCalls).toBe(0);
  });

  it("conflicts on another bounded digest before the absent-path validator", () => {
    const { commandRepository } = commandRepositoryFixture();
    expect(
      executeOperatorMutation(commandRepository, input, () => ({
        status: 201,
        body: { stored: true },
      })),
    ).toMatchObject({ ok: true, disposition: "applied" });

    let validatorCalls = 0;
    expect(
      executeOperatorMutation(
        commandRepository,
        { ...input, body: { name: "Other lab", kind: "lab", autoContinueWarnings: false } },
        () => {
          validatorCalls += 1;
          throw new Error("absent-path validator must not run on digest conflict");
        },
      ),
    ).toEqual({ ok: false, error: { code: "idempotency_conflict" } });
    expect(validatorCalls).toBe(0);
  });

  it("hashes omitted create-engagement defaults to the pinned digest and replays explicit null", () => {
    if (createEngagementDigest === undefined) {
      throw new Error("Missing d2.canonical.create-engagement digest.");
    }
    const { commandRepository, database } = commandRepositoryFixture();
    const applied = executeOperatorMutation(
      commandRepository,
      input,
      (transaction) => {
        const created = transaction.createEngagement(input.body);
        if (!created.ok) throw new Error(`Fixture failed: ${created.error.code}`);
        return { status: 201, body: { id: created.value.id } };
      },
    );
    expect(applied).toMatchObject({ ok: true, disposition: "applied" });
    expect(
      database.sqlite
        .prepare("select request_digest from operator_command_idempotency")
        .pluck()
        .get(),
    ).toBe(createEngagementDigest);
    expect(
      prepareLocalOperatorCommand({
        key: input.key,
        route: input.route,
        operation: input.operation,
        ...projectCommandJsonV1DigestInput(commandJsonV1CreateEngagementDigest, {
          path: {},
          query: {},
          body: input.body,
        }),
      }),
    ).toMatchObject({
      ok: true,
      command: { requestDigest: createEngagementDigest },
    });

    let validatorCalls = 0;
    const replayed = executeOperatorMutation(
      commandRepository,
      {
        ...input,
        body: {
          ...input.body,
          description: null,
          authorizationContext: null,
        },
      },
      () => {
        validatorCalls += 1;
        throw new Error("explicit-null replay must not run absent-path validation");
      },
    );
    expect(replayed).toEqual(
      applied.ok ? { ...applied, disposition: "replayed" } : applied,
    );
    expect(validatorCalls).toBe(0);
  });

  it("ignores unknown fields for digest lookup and still stores absent-key validation", () => {
    const { commandRepository, database } = commandRepositoryFixture();
    const applied = executeOperatorMutation(
      commandRepository,
      input,
      (transaction) => {
        const created = transaction.createEngagement(input.body);
        if (!created.ok) throw new Error(`Fixture failed: ${created.error.code}`);
        return { status: 201, body: { id: created.value.id } };
      },
    );
    expect(applied).toMatchObject({ ok: true, disposition: "applied" });

    let replayValidatorCalls = 0;
    expect(
      executeOperatorMutation(
        commandRepository,
        { ...input, body: { ...input.body, extra: true } },
        () => {
          replayValidatorCalls += 1;
          throw new Error("unknown fields must not create a digest conflict");
        },
      ),
    ).toEqual(applied.ok ? { ...applied, disposition: "replayed" } : applied);
    expect(replayValidatorCalls).toBe(0);

    const unknownKey = {
      ...input,
      key: "fixture-idempotency-key-0002",
      body: { ...input.body, extra: true },
    };
    const storedInvalid = executeOperatorMutation(
      commandRepository,
      unknownKey,
      () => ({ status: 400, body: { code: "invalid_request" } }),
    );
    expect(storedInvalid).toMatchObject({
      ok: true,
      disposition: "applied",
      response: { status: 400, bodyJson: '{"code":"invalid_request"}' },
    });
    expect(
      executeOperatorMutation(
        commandRepository,
        { ...unknownKey, body: input.body },
        () => {
          throw new Error("absent-path validator must not run on stored 400 replay");
        },
      ),
    ).toEqual(
      storedInvalid.ok ? { ...storedInvalid, disposition: "replayed" } : storedInvalid,
    );
    expect(
      database.sqlite
        .prepare("select count(*) from operator_command_idempotency")
        .pluck()
        .get(),
    ).toBe(2);
  });

  it("does not let an invalid spelling with extra fields hijack another digest", () => {
    const { commandRepository } = commandRepositoryFixture();
    expect(
      executeOperatorMutation(commandRepository, input, () => ({
        status: 201,
        body: { stored: true },
      })),
    ).toMatchObject({ ok: true, disposition: "applied" });

    let validatorCalls = 0;
    expect(
      executeOperatorMutation(
        commandRepository,
        {
          ...input,
          body: {
            name: "Other lab",
            kind: "lab",
            autoContinueWarnings: false,
            extra: true,
          },
        },
        () => {
          validatorCalls += 1;
          throw new Error("semantic conflict must happen before validation");
        },
      ),
    ).toEqual({ ok: false, error: { code: "idempotency_conflict" } });
    expect(
      executeOperatorMutation(
        commandRepository,
        {
          ...input,
          body: {
            name: "Target lab",
            kind: "lab",
            autoContinueWarnings: "false",
            extra: true,
          },
        },
        () => {
          validatorCalls += 1;
          throw new Error("invalid spelling must not replay a valid digest");
        },
      ),
    ).toEqual({ ok: false, error: { code: "idempotency_conflict" } });
    expect(validatorCalls).toBe(0);
  });

  it("fails closed when bounded JSON parse throws on extreme nesting", () => {
    const marker = "SENSITIVE_NESTING_MARKER";
    const nested = nestedJsonThatThrowsParse(marker);
    expect(jsonParseThrows(nested)).toBe(true);
    expect(parseBoundedDigestInput(nested)).toBeUndefined();

    let depthLimit: JsonValue = null;
    for (let index = 0; index < MAX_CANONICAL_JSON_DEPTH; index += 1) {
      depthLimit = [depthLimit];
    }
    expect(parseBoundedDigestInput(depthLimit)).toEqual(depthLimit);

    const { commandRepository, database } = commandRepositoryFixture();
    let validatorCalls = 0;
    const result = executeOperatorMutation(
      commandRepository,
      {
        ...input,
        body: {
          name: "Target lab",
          kind: "lab",
          autoContinueWarnings: false,
          extra: nested,
        },
      },
      () => {
        validatorCalls += 1;
        throw new Error("deep input must not mutate");
      },
    );
    expect(result).toEqual({ ok: false, error: { code: "invalid_command_input" } });
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(validatorCalls).toBe(0);
    expect(
      database.sqlite
        .prepare("select count(*) from operator_command_idempotency")
        .pluck()
        .get(),
    ).toBe(0);
  });
});
