import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SavedScopeRule } from "@stonehush/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { DATABASE_FILENAME, openEngagementDatabase, DATABASE_SCHEMA_VERSION } from "./database.js";
import { EngagementRepository } from "./repository.js";

const IDS = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
  "10000000-0000-4000-8000-000000000004",
  "10000000-0000-4000-8000-000000000005",
] as const;

const ipRule: SavedScopeRule = {
  id: "reserved-ip",
  kind: "ip",
  target: {
    kind: "ip",
    normalizationProfile: "d1-v1",
    family: 4,
    address: "192.0.2.7",
    zone: null,
  },
};

interface Fixture {
  directory: string;
  database: ReturnType<typeof openEngagementDatabase>;
  repository: EngagementRepository;
}

const fixtures: Fixture[] = [];

function createFixture(): Fixture {
  const directory = mkdtempSync(path.join(tmpdir(), "stonehush-db-test-"));
  chmodSync(directory, 0o700);
  const database = openEngagementDatabase({ dataDirectory: directory });
  let idIndex = 0;
  let clockTick = 0;
  const repository = new EngagementRepository(database.db, {
    createId: () => IDS[idIndex++] ?? "10000000-0000-4000-8000-000000000099",
    now: () => new Date(Date.UTC(2026, 7, 12, 12, clockTick++)),
  });
  const fixture = { directory, database, repository };
  fixtures.push(fixture);
  return fixture;
}

function createEngagement(repository: EngagementRepository, name = "Target lab") {
  const result = repository.createEngagement({
    name,
    kind: "lab",
    description: null,
    authorizationContext: "Synthetic fixture authorization context",
    autoContinueWarnings: false,
  });
  if (!result.ok) throw new Error(`Fixture create failed: ${result.error.code}`);
  return result.value;
}

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture === undefined) continue;
    if (fixture.database.sqlite.open) fixture.database.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

describe("engagement persistence", () => {
  it("migrates a fresh database, reapplies migrations, and enforces connection safety", () => {
    const fixture = createFixture();
    const databasePath = path.join(fixture.directory, DATABASE_FILENAME);

    expect(statSync(databasePath).mode & 0o777).toBe(0o600);
    expect(fixture.database.sqlite.pragma("journal_mode", { simple: true })).toBe(
      "wal",
    );
    expect(fixture.database.sqlite.pragma("foreign_keys", { simple: true })).toBe(
      1,
    );
    expect(
      fixture.database.sqlite.pragma("recursive_triggers", { simple: true }),
    ).toBe(1);
    expect(fixture.database.sqlite.pragma("synchronous", { simple: true })).toBe(
      2,
    );
    expect(fixture.database.sqlite.pragma("busy_timeout", { simple: true })).toBe(
      5_000,
    );

    fixture.database.close();
    fixture.database = openEngagementDatabase({
      dataDirectory: fixture.directory,
    });
    expect(
      fixture.database.sqlite
        .prepare("select count(*) as count from __drizzle_migrations")
        .get(),
    ).toEqual({ count: DATABASE_SCHEMA_VERSION });
  });

  it("creates, lists, archives, and reopens with optimistic revisions", () => {
    const { repository } = createFixture();
    expect(
      repository.createEngagement({
        name: "  Target lab  ",
        kind: "lab",
        description: null,
        authorizationContext: null,
        autoContinueWarnings: false,
      }),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
    const created = createEngagement(repository);
    expect(created).toMatchObject({
      revision: 1,
      name: "Target lab",
      status: "active",
      activeScopeRevisionId: null,
    });
    expect(repository.listEngagements()).toEqual({ ok: true, value: [created] });

    const archived = repository.archive(created.id, 1);
    expect(archived).toMatchObject({
      ok: true,
      value: { revision: 2, status: "archived" },
    });
    expect(repository.archive(created.id, 1)).toEqual({
      ok: false,
      error: { code: "revision_conflict", currentRevision: 2 },
    });
    expect(repository.reopen(created.id, 2)).toMatchObject({
      ok: true,
      value: { revision: 3, status: "active" },
    });
  });

  it("updates warning preference and uses Unicode code-point bounds in SQLite", () => {
    const { repository } = createFixture();
    const name = "😀".repeat(120);
    const engagement = createEngagement(repository, name);
    expect(engagement.name).toBe(name);
    expect(repository.updateAutoContinueWarnings(engagement.id, 1, true)).toMatchObject(
      {
        ok: true,
        value: { revision: 2, autoContinueWarnings: true },
      },
    );
    expect(
      repository.createEngagement({
        name: "😀".repeat(121),
        kind: "lab",
        description: null,
        authorizationContext: null,
        autoContinueWarnings: false,
      }),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
  });

  it("sets, changes, and clears the deadline with optimistic revisions", () => {
    const { repository } = createFixture();
    const created = repository.createEngagement({
      name: "Target lab",
      kind: "lab",
      description: null,
      authorizationContext: null,
      autoContinueWarnings: false,
      deadlineAt: "2026-08-12T14:00:00.000Z",
    });
    expect(created).toMatchObject({
      ok: true,
      value: { revision: 1, deadlineAt: "2026-08-12T14:00:00.000Z" },
    });
    if (!created.ok) throw new Error("Fixture create failed");
    expect(repository.getEngagement(created.value.id)).toMatchObject({
      ok: true,
      value: { engagement: { deadlineAt: "2026-08-12T14:00:00.000Z" } },
    });

    const moved = repository.updateDeadline(
      created.value.id,
      1,
      "2026-08-10T12:00:00.000Z",
    );
    expect(moved).toMatchObject({
      ok: true,
      value: { revision: 2, deadlineAt: "2026-08-10T12:00:00.000Z" },
    });

    const cleared = repository.updateDeadline(created.value.id, 2, null);
    expect(cleared).toMatchObject({
      ok: true,
      value: { revision: 3, deadlineAt: null },
    });
    expect(repository.listEngagements()).toMatchObject({
      ok: true,
      value: [{ deadlineAt: null }],
    });

    expect(repository.updateDeadline(created.value.id, 2, null)).toEqual({
      ok: false,
      error: { code: "revision_conflict", currentRevision: 3 },
    });
  });

  it("rejects deadline writes on archived engagements and invalid input", () => {
    const { repository } = createFixture();
    expect(
      repository.createEngagement({
        name: "Target lab",
        kind: "lab",
        description: null,
        authorizationContext: null,
        autoContinueWarnings: false,
        deadlineAt: "",
      }),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
    expect(
      repository.createEngagement({
        name: "Target lab",
        kind: "lab",
        description: null,
        authorizationContext: null,
        autoContinueWarnings: false,
        deadlineAt: "not-a-date",
      }),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });

    const engagement = createEngagement(repository);
    expect(
      repository.updateDeadline(engagement.id, 1, "not-a-date"),
    ).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
    expect(repository.updateDeadline(engagement.id, 1, "")).toEqual({
      ok: false,
      error: { code: "invalid_repository_input" },
    });

    expect(repository.archive(engagement.id, 1)).toMatchObject({ ok: true });
    expect(repository.updateDeadline(engagement.id, 2, null)).toEqual({
      ok: false,
      error: { code: "engagement_archived" },
    });
    expect(
      repository.updateDeadline(engagement.id, 2, "2026-08-14T12:00:00.000Z"),
    ).toEqual({ ok: false, error: { code: "engagement_archived" } });
  });

  it("distinguishes no active scope from an active empty revision", () => {
    const { repository } = createFixture();
    const engagement = createEngagement(repository);
    expect(repository.getEngagement(engagement.id)).toEqual({
      ok: true,
      value: { engagement, activeScopeRevision: null },
    });

    const appended = repository.appendScopeRevision({
      engagementId: engagement.id,
      expectedRevision: 1,
      rules: [],
    });
    expect(appended).toMatchObject({ ok: true, value: { version: 1, rules: [] } });
    expect(repository.getEngagement(engagement.id)).toMatchObject({
      ok: true,
      value: {
        engagement: { revision: 2, activeScopeRevisionId: IDS[1] },
        activeScopeRevision: { id: IDS[1], rules: [] },
      },
    });
  });

  it("appends immutable scope snapshots and atomically advances the active pointer", () => {
    const { database, repository } = createFixture();
    const engagement = createEngagement(repository);
    expect(
      repository.appendScopeRevision({
        engagementId: engagement.id,
        expectedRevision: 1,
        rules: [ipRule],
      }),
    ).toMatchObject({ ok: true, value: { id: IDS[1], version: 1 } });
    const originalJson = database.sqlite
      .prepare("select rules_json from scope_revisions where id = ?")
      .pluck()
      .get(IDS[1]);

    expect(
      repository.appendScopeRevision({
        engagementId: engagement.id,
        expectedRevision: 2,
        rules: [],
      }),
    ).toMatchObject({ ok: true, value: { id: IDS[2], version: 2 } });
    expect(repository.listScopeRevisions(engagement.id)).toMatchObject({
      ok: true,
      value: [
        { id: IDS[1], version: 1, rules: [ipRule] },
        { id: IDS[2], version: 2, rules: [] },
      ],
    });
    expect(
      database.sqlite
        .prepare("select rules_json from scope_revisions where id = ?")
        .pluck()
        .get(IDS[1]),
    ).toBe(originalJson);
  });

  it("accepts canonical default-port origins and masked CIDR provenance", () => {
    const { repository } = createFixture();
    const engagement = createEngagement(repository);
    const rules: SavedScopeRule[] = [
      {
        id: "default-https-origin",
        kind: "url-origin",
        origin: {
          scheme: "https",
          host: { hostname: "example.test" },
          effectivePort: 443,
        },
      },
      {
        id: "masked-cidr",
        kind: "cidr",
        target: {
          kind: "cidr",
          normalizationProfile: "d1-v1",
          family: 4,
          network: "192.0.2.0",
          prefixLength: 24,
          hostBitsMasked: true,
        },
      },
    ];

    expect(
      repository.appendScopeRevision({
        engagementId: engagement.id,
        expectedRevision: 1,
        rules,
      }),
    ).toMatchObject({ ok: true, value: { rules } });
  });

  it("uses a caller-owned immediate transaction without nesting and rolls back as one unit", () => {
    const { repository } = createFixture();
    const engagement = createEngagement(repository);

    expect(() =>
      repository.withWriteTx((transaction) => {
        expect(
          repository.appendScopeRevision(
            {
              engagementId: engagement.id,
              expectedRevision: 1,
              rules: [ipRule],
            },
            transaction,
          ),
        ).toMatchObject({ ok: true });
        throw new Error("synthetic rollback");
      }),
    ).toThrow("synthetic rollback");

    expect(repository.listScopeRevisions(engagement.id)).toEqual({
      ok: true,
      value: [],
    });
    expect(repository.getEngagement(engagement.id)).toMatchObject({
      ok: true,
      value: { engagement: { revision: 1, activeScopeRevisionId: null } },
    });
  });

  it("rolls back scope allocation and pointer changes when the final revision write fails", () => {
    const { database, repository } = createFixture();
    const engagement = createEngagement(repository);
    database.sqlite.exec(`
      create trigger synthetic_engagement_update_failure
      before update on engagements
      begin
        select raise(abort, 'synthetic update failure');
      end;
    `);

    expect(
      repository.appendScopeRevision({
        engagementId: engagement.id,
        expectedRevision: 1,
        rules: [ipRule],
      }),
    ).toEqual({ ok: false, error: { code: "invalid_persisted_data" } });
    expect(repository.listScopeRevisions(engagement.id)).toEqual({
      ok: true,
      value: [],
    });
    expect(repository.getEngagement(engagement.id)).toEqual({
      ok: true,
      value: { engagement, activeScopeRevision: null },
    });
  });

  it("rejects asynchronous write transaction callbacks at type and runtime", () => {
    const { repository } = createFixture();

    if (false) {
      // @ts-expect-error Promise-returning callbacks cannot own a write transaction.
      repository.withWriteTx(async () => undefined);
    }
    const untypedCall: (callback: () => unknown) => unknown =
      repository.withWriteTx.bind(repository);
    expect(() => untypedCall(() => Promise.resolve())).toThrow(
      "Write transaction callback must be synchronous.",
    );
  });

  it("blocks archived mutations and rejects stale revisions without partial writes", () => {
    const { repository } = createFixture();
    const engagement = createEngagement(repository);
    expect(repository.archive(engagement.id, 1)).toMatchObject({ ok: true });
    expect(
      repository.appendScopeRevision({
        engagementId: engagement.id,
        expectedRevision: 2,
        rules: [],
      }),
    ).toEqual({ ok: false, error: { code: "engagement_archived" } });
    expect(repository.updateAutoContinueWarnings(engagement.id, 2, true)).toEqual({
      ok: false,
      error: { code: "engagement_archived" },
    });
    expect(repository.listScopeRevisions(engagement.id)).toEqual({
      ok: true,
      value: [],
    });
  });

  it("rejects noncanonical and reflective unknown input without storing it", () => {
    const { repository } = createFixture();
    const marker = "SENSITIVE_UNTRUSTED_MARKER";
    const invalidCreate = repository.createEngagement({
      name: "Target lab",
      kind: "lab",
      description: null,
      authorizationContext: null,
      autoContinueWarnings: false,
      [marker]: marker,
    });
    expect(invalidCreate).toEqual({
      ok: false,
      error: { code: "invalid_repository_input" },
    });
    expect(JSON.stringify(invalidCreate)).not.toContain(marker);

    const engagement = createEngagement(repository);
    const invalidScope = repository.appendScopeRevision({
      engagementId: engagement.id,
      expectedRevision: 1,
      rules: [
        {
          ...ipRule,
          target: { ...ipRule.target, address: "192.0.2.007" },
        },
      ],
    });
    expect(invalidScope).toEqual({
      ok: false,
      error: { code: "invalid_repository_input" },
    });
    expect(repository.listScopeRevisions(engagement.id)).toEqual({
      ok: true,
      value: [],
    });
  });

  it("enforces cross-engagement ownership and immutable scope rows in SQLite", () => {
    const { database, repository } = createFixture();
    const first = createEngagement(repository, "First lab");
    const second = createEngagement(repository, "Second lab");
    expect(
      repository.appendScopeRevision({
        engagementId: first.id,
        expectedRevision: 1,
        rules: [],
      }),
    ).toMatchObject({ ok: true });

    expect(() =>
      database.sqlite
        .prepare(
          "insert into engagement_active_scopes (engagement_id, scope_revision_id) values (?, ?)",
        )
        .run(second.id, IDS[2]),
    ).toThrow();
    expect(() =>
      database.sqlite
        .prepare("update scope_revisions set rules_json = '[]' where id = ?")
        .run(IDS[2]),
    ).toThrow("scope revisions are immutable");
    expect(() =>
      database.sqlite.prepare("delete from scope_revisions where id = ?").run(IDS[2]),
    ).toThrow("scope revisions are immutable");
    expect(() =>
      database.sqlite
        .prepare(
          "insert or replace into scope_revisions (id, contract_version, engagement_id, version, rules_json, created_at) values (?, 1, ?, 1, '[]', ?)",
        )
        .run(IDS[2], first.id, "2026-08-12T12:09:00.000Z"),
    ).toThrow("scope revisions are immutable");
  });

  it("reports a dangling active-scope pointer as invalid persisted data", () => {
    const { database, repository } = createFixture();
    const engagement = createEngagement(repository);
    database.sqlite.pragma("foreign_keys = OFF");
    database.sqlite
      .prepare(
        "insert into engagement_active_scopes (engagement_id, scope_revision_id) values (?, ?)",
      )
      .run(engagement.id, IDS[1]);
    database.sqlite.pragma("foreign_keys = ON");

    const expected = {
      ok: false as const,
      error: { code: "invalid_persisted_data" as const },
    };
    expect(repository.getEngagement(engagement.id)).toEqual(expected);
    expect(repository.listEngagements()).toEqual(expected);
  });

  it("reports a cross-engagement active-scope pointer as invalid persisted data", () => {
    const { database, repository } = createFixture();
    const first = createEngagement(repository, "First lab");
    const second = createEngagement(repository, "Second lab");
    const scope = repository.appendScopeRevision({
      engagementId: second.id,
      expectedRevision: second.revision,
      rules: [],
    });
    if (!scope.ok) throw new Error(`Fixture failed: ${scope.error.code}`);
    database.sqlite.pragma("foreign_keys = OFF");
    database.sqlite
      .prepare(
        "insert into engagement_active_scopes (engagement_id, scope_revision_id) values (?, ?)",
      )
      .run(first.id, scope.value.id);
    database.sqlite.pragma("foreign_keys = ON");

    const expected = {
      ok: false as const,
      error: { code: "invalid_persisted_data" as const },
    };
    expect(repository.getEngagement(first.id)).toEqual(expected);
    expect(repository.listEngagements()).toEqual(expected);
  });

  it("rejects malformed JSON at the boundary and reports shape-invalid stored JSON safely", () => {
    const { database, repository } = createFixture();
    const engagement = createEngagement(repository);
    expect(() =>
      database.sqlite
        .prepare(
          "insert into scope_revisions (id, contract_version, engagement_id, version, rules_json, created_at) values (?, 1, ?, 1, ?, ?)",
        )
        .run(IDS[1], engagement.id, "{", "2026-08-12T12:01:00.000Z"),
    ).toThrow();

    database.sqlite
      .prepare(
        "insert into scope_revisions (id, contract_version, engagement_id, version, rules_json, created_at) values (?, 1, ?, 1, ?, ?)",
      )
      .run(IDS[1], engagement.id, "{}", "2026-08-12T12:01:00.000Z");
    expect(repository.listScopeRevisions(engagement.id)).toEqual({
      ok: false,
      error: { code: "invalid_persisted_data" },
    });
  });

  it("stores the validated JSON snapshot rather than caller-owned mutable data", () => {
    const { database, repository } = createFixture();
    const engagement = createEngagement(repository);
    const rules: SavedScopeRule[] = [{ ...ipRule }];
    expect(
      repository.appendScopeRevision({
        engagementId: engagement.id,
        expectedRevision: 1,
        rules,
      }),
    ).toMatchObject({ ok: true });
    rules.length = 0;

    expect(repository.listScopeRevisions(engagement.id)).toMatchObject({
      ok: true,
      value: [{ rules: [ipRule] }],
    });
    expect(
      readFileSync(path.join(fixturePath(database), DATABASE_FILENAME)).byteLength,
    ).toBeGreaterThan(0);
  });
});

function fixturePath(database: ReturnType<typeof openEngagementDatabase>): string {
  const databaseFile = database.sqlite.name;
  return path.dirname(databaseFile);
}
