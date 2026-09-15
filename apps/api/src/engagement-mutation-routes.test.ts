import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import path from "node:path";

import {
  JsonValueSchema,
  MAX_CANONICAL_JSON_BYTES,
} from "@stonehush/contracts";
import {
  EngagementRepository,
  OperatorCommandRepository,
  openEngagementDatabase,
  type EngagementWriteTransaction,
} from "@stonehush/db";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

const directories: string[] = [];
const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
  await Promise.all(
    directories.splice(0).map(async (directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "stonehush-mutation-api-"));
  directories.push(directory);
  await chmod(directory, 0o700);
  const database = openEngagementDatabase({ dataDirectory: directory });
  let nextId = 1;
  let minute = 0;
  const engagementRepository = new EngagementRepository(database.db, {
    createId: () =>
      `10000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
    now: () => new Date(Date.UTC(2026, 7, 12, 12, minute++)),
  });
  const operatorCommandRepository = new OperatorCommandRepository(
    engagementRepository,
    { now: () => new Date("2026-08-12T13:00:00.000Z") },
  );
  const app = buildApp({
    engagementRepository,
    operatorCommandRepository,
    getDevelopmentStorageReadiness: () => "ready",
  });
  app.addHook("onClose", async () => database.close());
  apps.push(app);
  return { app, database, directory, engagementRepository, operatorCommandRepository };
}

const headers = (key: string) => ({ "idempotency-key": key });
const key = (suffix: string) => `fixture-idempotency-${suffix.padEnd(12, "0")}`;

function rawNestedArrayJson(leafJson: string, depth: number): string {
  return `${"[".repeat(depth)}${leafJson}${"]".repeat(depth)}`;
}

function jsonParseThrows(value: unknown): boolean {
  try {
    JsonValueSchema.safeParse(value);
    return false;
  } catch (error) {
    return error instanceof RangeError;
  }
}

async function sendDuplicateKeyRequest(
  port: number,
  commandKey: string,
): Promise<{ statusCode: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      name: "Target lab",
      kind: "lab",
      autoContinueWarnings: false,
    });
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/v1/engagements",
        headers: [
          "host",
          "127.0.0.1",
          "content-type",
          "application/json",
          "content-length",
          String(Buffer.byteLength(body)),
          "idempotency-key",
          commandKey,
          "idempotency-key",
          commandKey,
        ],
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (responseBody += chunk));
        response.once("end", () =>
          resolve({ statusCode: response.statusCode, body: responseBody }),
        );
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}

describe("engagement mutation routes", () => {
  it("creates, archives, reopens, updates warning preference, and appends active scope", async () => {
    const { app } = await fixture();
    const createBody = {
      name: "Target lab",
      kind: "lab",
      autoContinueWarnings: false,
    };
    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/v1/engagements",
      headers: headers(key("create")),
      payload: createBody,
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json();
    expect(created).toMatchObject({ revision: 1, status: "active" });
    const base = `/api/v1/engagements/${created.id}`;

    const archivedResponse = await app.inject({
      method: "POST",
      url: `${base}/archive`,
      headers: headers(key("archive")),
      payload: { expectedRevision: 1 },
    });
    expect(archivedResponse.statusCode).toBe(200);
    expect(archivedResponse.json()).toMatchObject({ revision: 2, status: "archived" });

    const reopenedResponse = await app.inject({
      method: "POST",
      url: `${base}/reopen`,
      headers: headers(key("reopen")),
      payload: { expectedRevision: 2 },
    });
    expect(reopenedResponse.statusCode).toBe(200);
    expect(reopenedResponse.json()).toMatchObject({ revision: 3, status: "active" });

    const preferenceResponse = await app.inject({
      method: "PATCH",
      url: `${base}/auto-continue-warnings`,
      headers: headers(key("preference")),
      payload: { expectedRevision: 3, autoContinueWarnings: true },
    });
    expect(preferenceResponse.statusCode).toBe(200);
    expect(preferenceResponse.json()).toMatchObject({
      revision: 4,
      autoContinueWarnings: true,
    });

    const scopeResponse = await app.inject({
      method: "POST",
      url: `${base}/scope-revisions`,
      headers: headers(key("scope")),
      payload: { expectedRevision: 4, rules: [] },
    });
    expect(scopeResponse.statusCode).toBe(201);
    expect(scopeResponse.json()).toMatchObject({
      engagementId: created.id,
      version: 1,
      rules: [],
    });
    expect((await app.inject({ method: "GET", url: base })).json()).toMatchObject({
      engagement: {
        revision: 5,
        activeScopeRevisionId: scopeResponse.json().id,
      },
      activeScopeRevision: { id: scopeResponse.json().id },
    });
  });

  it("creates with a near deadline, moves it past due, clears it, and rejects malformed input", async () => {
    const { app } = await fixture();
    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/v1/engagements",
      headers: headers(key("deadline-create")),
      payload: {
        name: "Target lab",
        kind: "lab",
        autoContinueWarnings: false,
        deadlineAt: "2026-08-12T14:00:00.000Z",
      },
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json();
    expect(created).toMatchObject({ revision: 1, deadlineAt: "2026-08-12T14:00:00.000Z" });
    const base = `/api/v1/engagements/${created.id}`;

    const pastResponse = await app.inject({
      method: "PATCH",
      url: `${base}/deadline`,
      headers: headers(key("deadline-past")),
      payload: { expectedRevision: 1, deadlineAt: "2026-08-12T11:00:00.000Z" },
    });
    expect(pastResponse.statusCode).toBe(200);
    expect(pastResponse.json()).toMatchObject({
      revision: 2,
      deadlineAt: "2026-08-12T11:00:00.000Z",
    });

    const clearedResponse = await app.inject({
      method: "PATCH",
      url: `${base}/deadline`,
      headers: headers(key("deadline-clear")),
      payload: { expectedRevision: 2, deadlineAt: null },
    });
    expect(clearedResponse.statusCode).toBe(200);
    expect(clearedResponse.json()).toMatchObject({ revision: 3, deadlineAt: null });
    expect((await app.inject({ method: "GET", url: base })).json()).toMatchObject({
      engagement: { revision: 3, deadlineAt: null },
    });

    for (const [index, payload] of [
      { expectedRevision: 3, deadlineAt: "" },
      { expectedRevision: 3, deadlineAt: "tomorrow" },
      { expectedRevision: 3, deadlineAt: "2026-08-12T14:00:00.000+02:00" },
      { expectedRevision: 3 },
    ].entries()) {
      expect(
        await app.inject({
          method: "PATCH",
          url: `${base}/deadline`,
          headers: headers(key(`deadline-bad-${index}`)),
          payload,
        }),
      ).toMatchObject({ statusCode: 400, body: '{"code":"invalid_request"}' });
    }
    expect(
      await app.inject({
        method: "PATCH",
        url: `${base}/deadline?ignored=true`,
        headers: headers(key("deadline-query")),
        payload: { expectedRevision: 3, deadlineAt: null },
      }),
    ).toMatchObject({ statusCode: 400, body: '{"code":"invalid_request"}' });
  });

  it("rejects deadline writes on archived engagements and stale revisions", async () => {
    const { app } = await fixture();
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/v1/engagements",
        headers: headers(key("deadline-arch-create")),
        payload: { name: "Target lab", kind: "lab", autoContinueWarnings: false },
      })
    ).json();
    expect(created).toMatchObject({ deadlineAt: null });
    const base = `/api/v1/engagements/${created.id}`;
    await app.inject({
      method: "POST",
      url: `${base}/archive`,
      headers: headers(key("deadline-arch-archive")),
      payload: { expectedRevision: 1 },
    });
    expect(
      await app.inject({
        method: "PATCH",
        url: `${base}/deadline`,
        headers: headers(key("deadline-arch-write")),
        payload: { expectedRevision: 2, deadlineAt: "2026-08-14T12:00:00.000Z" },
      }),
    ).toMatchObject({ statusCode: 409, body: '{"code":"engagement_archived"}' });
    expect(
      await app.inject({
        method: "PATCH",
        url: `${base}/deadline`,
        headers: headers(key("deadline-arch-clear")),
        payload: { expectedRevision: 2, deadlineAt: null },
      }),
    ).toMatchObject({ statusCode: 409, body: '{"code":"engagement_archived"}' });

    const missingId = "10000000-0000-4000-8000-000000000099";
    expect(
      await app.inject({
        method: "PATCH",
        url: `/api/v1/engagements/${missingId}/deadline`,
        headers: headers(key("deadline-missing")),
        payload: { expectedRevision: 1, deadlineAt: null },
      }),
    ).toMatchObject({ statusCode: 404, body: '{"code":"engagement_not_found"}' });
  });

  it("replays exact stored success after lifecycle changes and conflicts on changed input", async () => {
    const { app } = await fixture();
    const commandKey = key("replay-create");
    const payload = { name: "Target lab", kind: "lab", autoContinueWarnings: false };
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/engagements",
      headers: headers(commandKey),
      payload,
    });
    const created = first.json();
    await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${created.id}/archive`,
      headers: headers(key("later-archive")),
      payload: { expectedRevision: 1 },
    });

    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/engagements",
      headers: headers(commandKey),
      payload,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.body).toBe(first.body);
    const conflict = await app.inject({
      method: "POST",
      url: "/api/v1/engagements",
      headers: headers(commandKey),
      payload: { ...payload, name: "Different lab" },
    });
    expect(conflict).toMatchObject({
      statusCode: 409,
      body: '{"code":"idempotency_conflict"}',
    });
    expect((await app.inject({ method: "GET", url: "/api/v1/engagements" })).json())
      .toHaveLength(1);
  });

  it("replays omitted create-engagement defaults and strips unknown fields from the digest", async () => {
    const { app, database } = await fixture();
    const omittedKey = key("omit-null");
    const omitted = { name: "Target lab", kind: "lab", autoContinueWarnings: false };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/engagements",
      headers: headers(omittedKey),
      payload: omitted,
    });
    expect(created.statusCode).toBe(201);
    expect(
      database.sqlite
        .prepare("select request_digest from operator_command_idempotency where idempotency_key = ?")
        .pluck()
        .get(omittedKey),
    ).toBe("sha256:b8a1a7e36d9307ad76be0324867dc33bed145bd6553a5782ce594e4c1a29a8cf");
    expect(
      await app.inject({
        method: "POST",
        url: "/api/v1/engagements",
        headers: headers(omittedKey),
        payload: { ...omitted, description: null, authorizationContext: null },
      }),
    ).toMatchObject({ statusCode: 201, body: created.body });
    expect(
      await app.inject({
        method: "POST",
        url: "/api/v1/engagements?ignored=true",
        headers: headers(omittedKey),
        payload: { ...omitted, extra: true },
      }),
    ).toMatchObject({ statusCode: 201, body: created.body });

    const unknownKey = key("unknown-create");
    const unknownCreate = await app.inject({
      method: "POST",
      url: "/api/v1/engagements",
      headers: headers(unknownKey),
      payload: { ...omitted, extra: true },
    });
    expect(unknownCreate).toMatchObject({
      statusCode: 400,
      body: '{"code":"invalid_request"}',
    });
    expect(
      await app.inject({
        method: "POST",
        url: "/api/v1/engagements",
        headers: headers(unknownKey),
        payload: omitted,
      }),
    ).toMatchObject({ statusCode: 400, body: unknownCreate.body });
    expect(
      await app.inject({
        method: "POST",
        url: "/api/v1/engagements",
        headers: headers(omittedKey),
        payload: { ...omitted, name: "Other lab", extra: true },
      }),
    ).toMatchObject({ statusCode: 409, body: '{"code":"idempotency_conflict"}' });
    expect(
      await app.inject({
        method: "POST",
        url: "/api/v1/engagements",
        headers: headers(omittedKey),
        payload: { ...omitted, autoContinueWarnings: "false", extra: true },
      }),
    ).toMatchObject({ statusCode: 409, body: '{"code":"idempotency_conflict"}' });

    const reservedIpRule = {
      id: "reserved-ip",
      kind: "ip",
      target: {
        kind: "ip",
        normalizationProfile: "d1-v1",
        family: 4,
        address: "192.0.2.20",
        zone: null,
      },
    };
    const scopeKey = key("unknown-scope");
    const scope = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${created.json().id}/scope-revisions`,
      headers: headers(scopeKey),
      payload: { expectedRevision: 1, rules: [reservedIpRule] },
    });
    expect(scope.statusCode).toBe(201);
    expect(
      await app.inject({
        method: "POST",
        url: `/api/v1/engagements/${created.json().id}/scope-revisions`,
        headers: headers(scopeKey),
        payload: {
          expectedRevision: 1,
          extra: true,
          rules: [
            {
              ...reservedIpRule,
              extra: true,
              target: { ...reservedIpRule.target, extra: true },
            },
          ],
        },
      }),
    ).toMatchObject({ statusCode: 201, body: scope.body });

    const nestedUnknownKey = key("nested-unknown");
    const nestedUnknown = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${created.json().id}/scope-revisions`,
      headers: headers(nestedUnknownKey),
      payload: {
        expectedRevision: 2,
        extra: true,
        rules: [
          {
            ...reservedIpRule,
            extra: true,
            target: { ...reservedIpRule.target, extra: true },
          },
        ],
      },
    });
    expect(nestedUnknown).toMatchObject({
      statusCode: 400,
      body: '{"code":"invalid_request"}',
    });
    expect(
      await app.inject({
        method: "POST",
        url: `/api/v1/engagements/${created.json().id}/scope-revisions`,
        headers: headers(nestedUnknownKey),
        payload: { expectedRevision: 2, rules: [reservedIpRule] },
      }),
    ).toMatchObject({ statusCode: 400, body: nestedUnknown.body });
    expect(
      database.sqlite
        .prepare("select count(*) from engagements")
        .pluck()
        .get(),
    ).toBe(1);
  });

  it("rejects a deeply nested declared field as a fixed invalid request", async () => {
    const { app, database, engagementRepository } = await fixture();
    const marker = "SENSITIVE_NESTING_MARKER";
    const depth = 32_768;
    const body = `{"name":${rawNestedArrayJson(JSON.stringify(marker), depth)},"kind":"lab","autoContinueWarnings":false}`;
    expect(Buffer.byteLength(body)).toBeLessThan(MAX_CANONICAL_JSON_BYTES);
    const parsed = JSON.parse(body);
    expect(jsonParseThrows(parsed)).toBe(true);

    const commandKey = key("deep-json");
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/engagements",
      headers: {
        ...headers(commandKey),
        "content-type": "application/json",
      },
      payload: body,
    });
    expect(response).toMatchObject({
      statusCode: 400,
      body: '{"code":"invalid_request"}',
    });
    expect(response.body).not.toContain(marker);
    expect(
      database.sqlite
        .prepare("select count(*) from operator_command_idempotency")
        .pluck()
        .get(),
    ).toBe(0);
    expect(engagementRepository.listEngagements()).toEqual({ ok: true, value: [] });
  });

  it("rejects malformed transport before lookup and does not reserve its key", async () => {
    const { app, database } = await fixture();
    const commandKey = key("invalid-transport");
    for (const request of [
      { headers: {}, payload: { name: "Target lab", kind: "lab", autoContinueWarnings: false } },
      { headers: headers("short"), payload: { name: "Target lab", kind: "lab", autoContinueWarnings: false } },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/engagements",
        ...request,
      });
      expect(response).toMatchObject({ statusCode: 400, body: '{"code":"invalid_request"}' });
    }
    const malformed = await app.inject({
      method: "POST",
      url: "/api/v1/engagements",
      headers: {
        ...headers(commandKey),
        "content-type": "application/json",
      },
      payload: '{"name":"SENSITIVE_PARSE_MARKER"',
    });
    expect(malformed).toMatchObject({
      statusCode: 400,
      body: '{"code":"invalid_request"}',
    });
    expect(malformed.body).not.toContain("SENSITIVE_PARSE_MARKER");
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Fixture listener did not expose a port.");
    }
    const duplicate = await sendDuplicateKeyRequest(address.port, commandKey);
    expect(duplicate).toEqual({
      statusCode: 400,
      body: '{"code":"invalid_request"}',
    });
    expect(
      database.sqlite.prepare("select count(*) from operator_command_idempotency").pluck().get(),
    ).toBe(0);
    const missingId = "10000000-0000-4000-8000-000000000099";
    for (const [index, queryRequest] of [
      {
        method: "POST" as const,
        url: "/api/v1/engagements?ignored=true",
        payload: { name: "Target lab", kind: "lab", autoContinueWarnings: false },
      },
      {
        method: "POST" as const,
        url: `/api/v1/engagements/${missingId}/archive?ignored=true`,
        payload: { expectedRevision: 1 },
      },
      {
        method: "POST" as const,
        url: `/api/v1/engagements/${missingId}/reopen?ignored=true`,
        payload: { expectedRevision: 1 },
      },
      {
        method: "PATCH" as const,
        url: `/api/v1/engagements/${missingId}/auto-continue-warnings?ignored=true`,
        payload: { expectedRevision: 1, autoContinueWarnings: true },
      },
      {
        method: "POST" as const,
        url: `/api/v1/engagements/${missingId}/scope-revisions?ignored=true`,
        payload: { expectedRevision: 1, rules: [] },
      },
    ].entries()) {
      expect(
        await app.inject({
          ...queryRequest,
          headers: headers(key(`query-${index}`)),
        }),
      ).toMatchObject({ statusCode: 400, body: '{"code":"invalid_request"}' });
    }
    expect(
      await app.inject({
        method: "POST",
        url: "/api/v1/engagements",
        headers: headers(commandKey),
        payload: { name: "Target lab", kind: "lab", autoContinueWarnings: false },
      }),
    ).toMatchObject({ statusCode: 201 });
  });

  it("stores stale revision and archived-rule errors as exact definitive responses", async () => {
    const { app } = await fixture();
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/v1/engagements",
        headers: headers(key("error-create")),
        payload: { name: "Target lab", kind: "lab", autoContinueWarnings: false },
      })
    ).json();
    const base = `/api/v1/engagements/${created.id}`;
    await app.inject({
      method: "POST",
      url: `${base}/archive`,
      headers: headers(key("error-archive")),
      payload: { expectedRevision: 1 },
    });
    const staleKey = key("stale");
    const stale = await app.inject({
      method: "POST",
      url: `${base}/reopen`,
      headers: headers(staleKey),
      payload: { expectedRevision: 1 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({
      code: "revision_conflict",
      resourceType: "engagement",
      resourceId: created.id,
      currentRevision: 2,
    });
    await app.inject({
      method: "POST",
      url: `${base}/reopen`,
      headers: headers(key("valid-reopen")),
      payload: { expectedRevision: 2 },
    });
    expect(
      await app.inject({
        method: "POST",
        url: `${base}/reopen`,
        headers: headers(staleKey),
        payload: { expectedRevision: 1 },
      }),
    ).toMatchObject({ statusCode: 409, body: stale.body });

    await app.inject({
      method: "POST",
      url: `${base}/archive`,
      headers: headers(key("archive-again")),
      payload: { expectedRevision: 3 },
    });
    for (const request of [
      {
        method: "PATCH" as const,
        url: `${base}/auto-continue-warnings`,
        payload: { expectedRevision: 4, autoContinueWarnings: true },
      },
      {
        method: "POST" as const,
        url: `${base}/scope-revisions`,
        payload: { expectedRevision: 4, rules: [] },
      },
    ]) {
      const response = await app.inject({
        ...request,
        headers: headers(key(`archived-${request.method}`)),
      });
      expect(response).toMatchObject({
        statusCode: 409,
        body: '{"code":"engagement_archived"}',
      });
    }
  });

  it("maps missing engagements and invalid lifecycle transitions exactly", async () => {
    const { app } = await fixture();
    const missingId = "10000000-0000-4000-8000-000000000099";
    expect(
      await app.inject({
        method: "POST",
        url: `/api/v1/engagements/${missingId}/archive`,
        headers: headers(key("missing")),
        payload: { expectedRevision: 1 },
      }),
    ).toMatchObject({
      statusCode: 404,
      body: '{"code":"engagement_not_found"}',
    });

    const created = (
      await app.inject({
        method: "POST",
        url: "/api/v1/engagements",
        headers: headers(key("transition-create")),
        payload: { name: "Target lab", kind: "lab", autoContinueWarnings: false },
      })
    ).json();
    expect(
      await app.inject({
        method: "POST",
        url: `/api/v1/engagements/${created.id}/reopen`,
        headers: headers(key("invalid-transition")),
        payload: { expectedRevision: 1 },
      }),
    ).toMatchObject({
      statusCode: 409,
      body: '{"code":"invalid_engagement_transition"}',
    });
  });

  it("replays lifecycle and scope successes after the engagement advances", async () => {
    const { app } = await fixture();
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/v1/engagements",
        headers: headers(key("success-replay-create")),
        payload: { name: "Target lab", kind: "lab", autoContinueWarnings: false },
      })
    ).json();
    const base = `/api/v1/engagements/${created.id}`;
    const archiveRequest = {
      method: "POST" as const,
      url: `${base}/archive`,
      headers: headers(key("success-replay-archive")),
      payload: { expectedRevision: 1 },
    };
    const archived = await app.inject(archiveRequest);
    await app.inject({
      method: "POST",
      url: `${base}/reopen`,
      headers: headers(key("success-replay-reopen")),
      payload: { expectedRevision: 2 },
    });
    expect(await app.inject(archiveRequest)).toMatchObject({
      statusCode: 200,
      body: archived.body,
    });

    const scopeRequest = {
      method: "POST" as const,
      url: `${base}/scope-revisions`,
      headers: headers(key("success-replay-scope")),
      payload: { expectedRevision: 3, rules: [] },
    };
    const scope = await app.inject(scopeRequest);
    await app.inject({
      method: "PATCH",
      url: `${base}/auto-continue-warnings`,
      headers: headers(key("success-replay-preference")),
      payload: { expectedRevision: 4, autoContinueWarnings: true },
    });
    expect(await app.inject(scopeRequest)).toMatchObject({
      statusCode: 201,
      body: scope.body,
    });
  });

  it("rolls back route mutation when its success response violates the route schema", async () => {
    const { database, engagementRepository, operatorCommandRepository } = await fixture();
    const app = buildApp({
      engagementRepository,
      operatorCommandRepository: {
        executeOperatorCommand(command, mutate) {
          return operatorCommandRepository.executeOperatorCommand(
            command,
            (transaction: EngagementWriteTransaction) => {
              const invalidResponseTransaction = new Proxy(transaction, {
                get(target, property, receiver) {
                  if (property !== "createEngagement") {
                    return Reflect.get(target, property, receiver);
                  }
                  return (input: Parameters<EngagementWriteTransaction["createEngagement"]>[0]) => {
                    target.createEngagement(input);
                    return { ok: true, value: { id: "schema-invalid" } };
                  };
                },
              });
              return mutate(invalidResponseTransaction);
            },
          );
        },
      },
      getDevelopmentStorageReadiness: () => "ready",
    });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/engagements",
      headers: headers(key("rollback")),
      payload: { name: "Target lab", kind: "lab", autoContinueWarnings: false },
    });
    expect(response).toMatchObject({
      statusCode: 500,
      body: '{"code":"invalid_persisted_data"}',
    });
    expect(engagementRepository.listEngagements()).toEqual({ ok: true, value: [] });
    expect(
      database.sqlite.prepare("select count(*) from operator_command_idempotency").pluck().get(),
    ).toBe(0);
  });

  it("returns unrecorded storage_busy and accepts the same key after lock release", async () => {
    const { app, database, directory } = await fixture();
    const blocker = openEngagementDatabase({ dataDirectory: directory });
    blocker.sqlite.exec("begin immediate");
    const commandKey = key("busy");
    const request = {
      method: "POST" as const,
      url: "/api/v1/engagements",
      headers: headers(commandKey),
      payload: { name: "Target lab", kind: "lab", autoContinueWarnings: false },
    };
    const busy = await app.inject(request);
    expect(busy).toMatchObject({ statusCode: 503, body: '{"code":"storage_busy"}' });
    expect(
      database.sqlite.prepare("select count(*) from operator_command_idempotency").pluck().get(),
    ).toBe(0);
    blocker.sqlite.exec("rollback");
    blocker.close();
    expect(await app.inject(request)).toMatchObject({ statusCode: 201 });
  }, 10_000);

  it("replays stored command JSON exactly and does not reflect non-JSON bodies", async () => {
    const marker = "SENSITIVE_STORED_MARKER";
    const staleApp = buildApp({
      engagementRepository: {
        getEngagement: () => ({ ok: false, error: { code: "engagement_not_found" } }),
        getFindingForEngagement: () => ({ ok: false, error: { code: "finding_not_found" } }),
        listEngagements: () => ({ ok: true, value: [] }),
        listScopeRevisions: () => ({ ok: true, value: [] }),
        getAction: () => ({ ok: false, error: { code: "action_not_found" } }),
        retryActionContext: () => ({
          ok: false,
          error: { code: "action_not_found" },
        }),
        getEngagementNotes: () => ({ ok: false, error: { code: "engagement_not_found" } }),
        putEngagementNotes: () => ({ ok: false, error: { code: "engagement_not_found" } }),
      },
      operatorCommandRepository: {
        executeOperatorCommand: () => ({
          ok: true,
          disposition: "replayed",
          response: { status: 201, bodyJson: '{"stale":true}' },
        }),
      },
      getDevelopmentStorageReadiness: () => "ready",
    });
    apps.push(staleApp);
    const replayed = await staleApp.inject({
      method: "POST",
      url: "/api/v1/engagements",
      headers: headers(key("stale-response")),
      payload: { name: "Target lab", kind: "lab", autoContinueWarnings: false },
    });
    expect(replayed).toMatchObject({
      statusCode: 201,
      body: '{"stale":true}',
    });

    const brokenApp = buildApp({
      engagementRepository: {
        getEngagement: () => ({ ok: false, error: { code: "engagement_not_found" } }),
        getFindingForEngagement: () => ({ ok: false, error: { code: "finding_not_found" } }),
        listEngagements: () => ({ ok: true, value: [] }),
        listScopeRevisions: () => ({ ok: true, value: [] }),
        getAction: () => ({ ok: false, error: { code: "action_not_found" } }),
        retryActionContext: () => ({
          ok: false,
          error: { code: "action_not_found" },
        }),
        getEngagementNotes: () => ({ ok: false, error: { code: "engagement_not_found" } }),
        putEngagementNotes: () => ({ ok: false, error: { code: "engagement_not_found" } }),
      },
      operatorCommandRepository: {
        executeOperatorCommand: () => ({
          ok: true,
          disposition: "replayed",
          response: { status: 201, bodyJson: `{"marker":"${marker}"` },
        }),
      },
      getDevelopmentStorageReadiness: () => "ready",
    });
    apps.push(brokenApp);
    const broken = await brokenApp.inject({
      method: "POST",
      url: "/api/v1/engagements",
      headers: headers(key("malformed-response")),
      payload: { name: "Target lab", kind: "lab", autoContinueWarnings: false },
    });
    expect(broken).toMatchObject({
      statusCode: 500,
      body: '{"code":"invalid_persisted_data"}',
    });
    expect(broken.body).not.toContain(marker);
  });
});
