import { describe, expect, it } from "vitest";

import fixtureData from "../../../docs/architecture/fixtures/d2/canonical-request.json" with {
  type: "json",
};
import {
  ActionIdParamsSchema,
  ActionMutationQuerySchema,
  AddScopeAndRunActionRequestSchema,
  CancelActionRequestSchema,
  ContinueActionRequestSchema,
  ContinueLateWarningActionRequestSchema,
  CreateActionRequestSchema,
} from "./action-api.js";
import {
  CommandJsonV1CreateActionBodyDigestSchema,
  CommandJsonV1CreateEngagementBodyDigestSchema,
  commandJsonV1AddScopeAndRunActionDigest,
  commandJsonV1AppendScopeRevisionDigest,
  commandJsonV1ArchiveEngagementDigest,
  commandJsonV1CancelActionDigest,
  commandJsonV1ContinueActionDigest,
  commandJsonV1ContinueLateWarningActionDigest,
  commandJsonV1CreateActionDigest,
  commandJsonV1CreateEngagementDigest,
  commandJsonV1EngagementRevisionDigest,
  commandJsonV1ReopenEngagementDigest,
  commandJsonV1UpdateAutoContinueWarningsDigest,
  commandJsonV1UpdateDeadlineDigest,
  projectCommandJsonV1DigestInput,
  projectCommandJsonV1DigestObject,
  projectCommandJsonV1SavedScopeRule,
  type CommandJsonV1DigestProjection,
} from "./command-json-v1-digest.js";
import { CreateEngagementInputSchema } from "./engagement.js";
import {
  AppendScopeRevisionRequestSchema,
  CreateEngagementRequestSchema,
  EngagementIdParamsSchema,
  EngagementMutationQuerySchema,
  EngagementRevisionRequestSchema,
  UpdateAutoContinueWarningsRequestSchema,
  UpdateEngagementDeadlineRequestSchema,
} from "./engagement-api.js";
import {
  JsonValueSchema,
  canonicalizeJson,
  type JsonValue,
} from "./operator-command.js";

const createEngagementFixture = (
  fixtureData as {
    cases: Array<{
      id: string;
      given: { value: { body: unknown } };
      expected: { canonicalJson: string };
    }>;
  }
).cases.find((fixtureCase) => fixtureCase.id === "d2.canonical.create-engagement");

const reservedIpRule = {
  id: "reserved-ip",
  kind: "ip" as const,
  target: {
    kind: "ip" as const,
    normalizationProfile: "d1-v1" as const,
    family: 4 as const,
    address: "192.0.2.20",
    zone: null,
  },
};

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

describe("command-json-v1 digest projection", () => {
  it("applies create-engagement defaults to the pinned D2 envelope", () => {
    if (createEngagementFixture === undefined) {
      throw new Error("Missing d2.canonical.create-engagement fixture.");
    }
    const omitted = {
      name: "Target lab",
      kind: "lab",
      autoContinueWarnings: false,
    };
    const explicitNull = {
      ...omitted,
      description: null,
      authorizationContext: null,
    };
    const projectedOmitted = projectCommandJsonV1DigestInput(
      commandJsonV1CreateEngagementDigest,
      { path: {}, query: {}, body: omitted },
    );
    const projectedExplicit = projectCommandJsonV1DigestInput(
      commandJsonV1CreateEngagementDigest,
      { path: {}, query: {}, body: explicitNull },
    );
    expect(projectedOmitted).toEqual(projectedExplicit);
    expect(projectedOmitted.body).toEqual(
      CreateEngagementInputSchema.parse(omitted),
    );
    expect(projectedOmitted.body).toEqual(createEngagementFixture.given.value.body);
    expect(
      canonicalizeJson({
        actorId: "local-operator-v1",
        body: projectedOmitted.body,
        canonicalizationProfile: "command-json-v1",
        operation: "create",
        path: projectedOmitted.path,
        query: projectedOmitted.query,
        route: "/api/v1/engagements",
      }),
    ).toEqual({
      ok: true,
      canonicalJson: createEngagementFixture.expected.canonicalJson,
    });
  });

  it("applies create-action declaredPorts default to schema output", () => {
    const omitted = {
      expectedEngagementRevision: 1,
      expectedActiveScopeRevisionId: null,
      targets: ["192.0.2.10"],
    };
    const explicitNull = { ...omitted, declaredPorts: null };
    expect(
      projectCommandJsonV1DigestObject(
        CommandJsonV1CreateActionBodyDigestSchema,
        omitted,
      ),
    ).toEqual(CreateActionRequestSchema.parse(omitted));
    expect(
      projectCommandJsonV1DigestObject(
        CommandJsonV1CreateActionBodyDigestSchema,
        omitted,
      ),
    ).toEqual(
      projectCommandJsonV1DigestObject(
        CommandJsonV1CreateActionBodyDigestSchema,
        explicitNull,
      ),
    );
    expect(
      projectCommandJsonV1DigestInput(commandJsonV1CreateActionDigest, {
        path: { engagementId: "10000000-0000-4000-8000-000000000001" },
        query: {},
        body: omitted,
      }).body,
    ).toEqual({ ...omitted, declaredPorts: null });
  });

  it("strips unknown top-level and nested fields without changing declared values", () => {
    const body = {
      name: "Target lab",
      kind: "lab",
      autoContinueWarnings: false,
    };
    expect(
      projectCommandJsonV1DigestObject(
        CommandJsonV1CreateEngagementBodyDigestSchema,
        { ...body, extra: true },
      ),
    ).toEqual(CreateEngagementInputSchema.parse(body));
    expect(
      commandJsonV1CreateEngagementDigest.projectQuery({ ignored: "true" }),
    ).toEqual({});

    const ruleWithUnknowns = {
      ...reservedIpRule,
      extra: true,
      target: { ...reservedIpRule.target, extra: true },
      portRanges: [{ from: 80, to: 80, extra: true }],
    };
    expect(projectCommandJsonV1SavedScopeRule(ruleWithUnknowns)).toEqual({
      ...reservedIpRule,
      portRanges: [{ from: 80, to: 80 }],
    });

    const urlOrigin = {
      id: "origin-1",
      kind: "url-origin" as const,
      origin: {
        scheme: "https",
        host: { hostname: "app.target.test" },
        effectivePort: 443,
        extra: true,
      },
      extra: true,
    };
    expect(projectCommandJsonV1SavedScopeRule(urlOrigin)).toEqual({
      id: "origin-1",
      kind: "url-origin",
      origin: {
        scheme: "https",
        host: { hostname: "app.target.test" },
        effectivePort: 443,
      },
    });
  });

  it("keeps invalid declared spellings distinct from schema output", () => {
    expect(
      projectCommandJsonV1DigestObject(
        CommandJsonV1CreateEngagementBodyDigestSchema,
        {
          name: "Target lab",
          kind: "lab",
          autoContinueWarnings: "false",
          extra: true,
        },
      ),
    ).toEqual({
      name: "Target lab",
      kind: "lab",
      description: null,
      authorizationContext: null,
      autoContinueWarnings: "false",
    });
    expect(
      projectCommandJsonV1SavedScopeRule({
        ...reservedIpRule,
        extra: true,
        target: { ...reservedIpRule.target, extra: true, address: 20 },
      }),
    ).toEqual({
      ...reservedIpRule,
      target: { ...reservedIpRule.target, address: 20 },
    });
    expect(
      projectCommandJsonV1SavedScopeRule({
        id: "origin-1",
        kind: "url-origin",
        origin: {
          scheme: "https",
          host: { hostname: "app.target.test", address: "192.0.2.10" },
          effectivePort: 443,
        },
      }),
    ).not.toEqual({
      id: "origin-1",
      kind: "url-origin",
      origin: {
        scheme: "https",
        host: { hostname: "app.target.test" },
        effectivePort: 443,
      },
    });
  });

  it("does not throw when a second JSON parse overflows", () => {
    const nested = nestedJsonThatThrowsParse(null);
    expect(jsonParseThrows(nested)).toBe(true);
    const value = { name: nested };
    expect(
      projectCommandJsonV1DigestObject(
        CommandJsonV1CreateEngagementBodyDigestSchema,
        value,
      ),
    ).toBe(value);
  });

  it("rethrows a non-RangeError from digest projection", () => {
    const schema = {
      safeParse(): never {
        throw new TypeError("SENSITIVE_SCHEMA_FAULT");
      },
    };
    expect(() =>
      projectCommandJsonV1DigestObject(schema, { name: "Target lab" }),
    ).toThrow(TypeError);
    try {
      projectCommandJsonV1DigestObject(schema, { name: "Target lab" });
      throw new Error("expected TypeError");
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      expect(error instanceof Error ? error.message : "").toBe(
        "SENSITIVE_SCHEMA_FAULT",
      );
    }
  });

  it("matches current request schema output for every mutation route", () => {
    const engagementId = "10000000-0000-4000-8000-000000000001";
    const actionId = "10000000-0000-4000-8000-000000000002";
    const engagementPath = { engagementId };
    const actionPath = { engagementId, actionId };
    const ipv4Target = {
      kind: "ip" as const,
      normalizationProfile: "d1-v1" as const,
      family: 4 as const,
      address: "192.0.2.20",
      zone: null,
    };
    const ipv6Target = {
      kind: "ip" as const,
      normalizationProfile: "d1-v1" as const,
      family: 6 as const,
      address: "2001:db8::7",
      zone: null,
    };
    const ipv6ZonedTarget = {
      kind: "ip" as const,
      normalizationProfile: "d1-v1" as const,
      family: 6 as const,
      address: "fe80::7",
      zone: "Eth0",
    };
    const rules = [
      { id: "ip-v4", kind: "ip" as const, target: ipv4Target },
      {
        id: "ip-v6",
        kind: "ip" as const,
        target: ipv6Target,
        portRanges: [{ from: 80, to: 80 }],
      },
      { id: "ip-zoned", kind: "ip" as const, target: ipv6ZonedTarget },
      {
        id: "cidr-v4",
        kind: "cidr" as const,
        target: {
          kind: "cidr" as const,
          normalizationProfile: "d1-v1" as const,
          family: 4 as const,
          network: "192.0.2.0",
          prefixLength: 24,
          hostBitsMasked: false,
        },
      },
      {
        id: "cidr-v6",
        kind: "cidr" as const,
        target: {
          kind: "cidr" as const,
          normalizationProfile: "d1-v1" as const,
          family: 6 as const,
          network: "2001:db8::7",
          prefixLength: 128,
          hostBitsMasked: true,
        },
      },
      {
        id: "domain",
        kind: "domain" as const,
        target: {
          kind: "hostname" as const,
          normalizationProfile: "d1-v1" as const,
          hostname: "app.target.test",
        },
        includeSubdomains: true,
      },
      {
        id: "origin-hostname",
        kind: "url-origin" as const,
        origin: {
          scheme: "https" as const,
          host: { hostname: "app.target.test" },
          effectivePort: 443,
        },
      },
      {
        id: "origin-ipv4",
        kind: "url-origin" as const,
        origin: {
          scheme: "http" as const,
          host: { address: "192.0.2.20", zone: null },
          effectivePort: 80,
        },
        portRanges: [{ from: 80, to: 443 }],
      },
      {
        id: "origin-ipv6",
        kind: "url-origin" as const,
        origin: {
          scheme: "https" as const,
          host: { address: "2001:db8::7", zone: null },
          effectivePort: 443,
        },
      },
      {
        id: "origin-zoned",
        kind: "url-origin" as const,
        origin: {
          scheme: "https" as const,
          host: { address: "fe80::7", zone: "Eth0" },
          effectivePort: 443,
        },
      },
    ];
    interface RequestSchema {
      parse(value: unknown): unknown;
    }
    const cases: Array<{
      name: string;
      projection: CommandJsonV1DigestProjection;
      pathSchema: RequestSchema;
      querySchema: RequestSchema;
      bodySchema: RequestSchema;
      path: JsonValue;
      query: JsonValue;
      body: JsonValue;
    }> = [
      {
        name: "create engagement omitted defaults",
        projection: commandJsonV1CreateEngagementDigest,
        pathSchema: EngagementMutationQuerySchema,
        querySchema: EngagementMutationQuerySchema,
        bodySchema: CreateEngagementRequestSchema,
        path: {},
        query: {},
        body: { name: "Target lab", kind: "lab", autoContinueWarnings: false },
      },
      {
        name: "create engagement explicit nulls",
        projection: commandJsonV1CreateEngagementDigest,
        pathSchema: EngagementMutationQuerySchema,
        querySchema: EngagementMutationQuerySchema,
        bodySchema: CreateEngagementRequestSchema,
        path: {},
        query: {},
        body: {
          name: "Target lab",
          kind: "lab",
          description: null,
          authorizationContext: null,
          autoContinueWarnings: false,
        },
      },
      {
        name: "archive engagement",
        projection: commandJsonV1ArchiveEngagementDigest,
        pathSchema: EngagementIdParamsSchema,
        querySchema: EngagementMutationQuerySchema,
        bodySchema: EngagementRevisionRequestSchema,
        path: engagementPath,
        query: {},
        body: { expectedRevision: 2 },
      },
      {
        name: "reopen engagement",
        projection: commandJsonV1ReopenEngagementDigest,
        pathSchema: EngagementIdParamsSchema,
        querySchema: EngagementMutationQuerySchema,
        bodySchema: EngagementRevisionRequestSchema,
        path: engagementPath,
        query: {},
        body: { expectedRevision: 2 },
      },
      {
        name: "engagement revision alias",
        projection: commandJsonV1EngagementRevisionDigest,
        pathSchema: EngagementIdParamsSchema,
        querySchema: EngagementMutationQuerySchema,
        bodySchema: EngagementRevisionRequestSchema,
        path: engagementPath,
        query: {},
        body: { expectedRevision: 2 },
      },
      {
        name: "update auto-continue warnings",
        projection: commandJsonV1UpdateAutoContinueWarningsDigest,
        pathSchema: EngagementIdParamsSchema,
        querySchema: EngagementMutationQuerySchema,
        bodySchema: UpdateAutoContinueWarningsRequestSchema,
        path: engagementPath,
        query: {},
        body: { expectedRevision: 3, autoContinueWarnings: true },
      },
      {
        name: "update engagement deadline",
        projection: commandJsonV1UpdateDeadlineDigest,
        pathSchema: EngagementIdParamsSchema,
        querySchema: EngagementMutationQuerySchema,
        bodySchema: UpdateEngagementDeadlineRequestSchema,
        path: engagementPath,
        query: {},
        body: { expectedRevision: 3, deadlineAt: "2026-08-14T12:00:00.000Z" },
      },
      {
        name: "clear engagement deadline",
        projection: commandJsonV1UpdateDeadlineDigest,
        pathSchema: EngagementIdParamsSchema,
        querySchema: EngagementMutationQuerySchema,
        bodySchema: UpdateEngagementDeadlineRequestSchema,
        path: engagementPath,
        query: {},
        body: { expectedRevision: 4, deadlineAt: null },
      },
      {
        name: "append scope revision",
        projection: commandJsonV1AppendScopeRevisionDigest,
        pathSchema: EngagementIdParamsSchema,
        querySchema: EngagementMutationQuerySchema,
        bodySchema: AppendScopeRevisionRequestSchema,
        path: engagementPath,
        query: {},
        body: { expectedRevision: 4, rules },
      },
      {
        name: "create action omitted declaredPorts",
        projection: commandJsonV1CreateActionDigest,
        pathSchema: EngagementIdParamsSchema,
        querySchema: ActionMutationQuerySchema,
        bodySchema: CreateActionRequestSchema,
        path: engagementPath,
        query: {},
        body: {
          expectedEngagementRevision: 1,
          expectedActiveScopeRevisionId: null,
          targets: ["192.0.2.10"],
        },
      },
      {
        name: "create action explicit ports",
        projection: commandJsonV1CreateActionDigest,
        pathSchema: EngagementIdParamsSchema,
        querySchema: ActionMutationQuerySchema,
        bodySchema: CreateActionRequestSchema,
        path: engagementPath,
        query: {},
        body: {
          expectedEngagementRevision: 1,
          expectedActiveScopeRevisionId: engagementId,
          targets: ["192.0.2.10"],
          declaredPorts: [80, 443],
        },
      },
      {
        name: "continue action",
        projection: commandJsonV1ContinueActionDigest,
        pathSchema: ActionIdParamsSchema,
        querySchema: ActionMutationQuerySchema,
        bodySchema: ContinueActionRequestSchema,
        path: actionPath,
        query: {},
        body: {
          expectedRevision: 1,
          snapshotVersion: 1,
          snapshotBinding: "sha256:fixture-snapshot-1",
        },
      },
      {
        name: "continue late warning",
        projection: commandJsonV1ContinueLateWarningActionDigest,
        pathSchema: ActionIdParamsSchema,
        querySchema: ActionMutationQuerySchema,
        bodySchema: ContinueLateWarningActionRequestSchema,
        path: actionPath,
        query: {},
        body: {
          expectedRevision: 1,
          snapshotVersion: 1,
          snapshotBinding: "sha256:fixture-snapshot-1",
          pendingEventId: 7,
        },
      },
      {
        name: "add scope and run",
        projection: commandJsonV1AddScopeAndRunActionDigest,
        pathSchema: ActionIdParamsSchema,
        querySchema: ActionMutationQuerySchema,
        bodySchema: AddScopeAndRunActionRequestSchema,
        path: actionPath,
        query: {},
        body: {
          expectedEngagementRevision: 2,
          expectedActionRevision: 1,
          rules,
        },
      },
      {
        name: "cancel action",
        projection: commandJsonV1CancelActionDigest,
        pathSchema: ActionIdParamsSchema,
        querySchema: ActionMutationQuerySchema,
        bodySchema: CancelActionRequestSchema,
        path: actionPath,
        query: {},
        body: { expectedRevision: 1 },
      },
    ];

    expect(new Set(cases.map((fixture) => fixture.projection))).toEqual(
      new Set([
        commandJsonV1CreateEngagementDigest,
        commandJsonV1ArchiveEngagementDigest,
        commandJsonV1ReopenEngagementDigest,
        commandJsonV1EngagementRevisionDigest,
        commandJsonV1UpdateAutoContinueWarningsDigest,
        commandJsonV1UpdateDeadlineDigest,
        commandJsonV1AppendScopeRevisionDigest,
        commandJsonV1CreateActionDigest,
        commandJsonV1ContinueActionDigest,
        commandJsonV1ContinueLateWarningActionDigest,
        commandJsonV1AddScopeAndRunActionDigest,
        commandJsonV1CancelActionDigest,
      ]),
    );

    for (const fixture of cases) {
      const projected = projectCommandJsonV1DigestInput(fixture.projection, {
        path: fixture.path,
        query: fixture.query,
        body: fixture.body,
      });
      expect(projected.path, `${fixture.name} path`).toEqual(
        fixture.pathSchema.parse(fixture.path),
      );
      expect(projected.query, `${fixture.name} query`).toEqual(
        fixture.querySchema.parse(fixture.query),
      );
      expect(projected.body, `${fixture.name} body`).toEqual(
        fixture.bodySchema.parse(fixture.body),
      );
    }
  });
});
