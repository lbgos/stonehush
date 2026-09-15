import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { ADVISOR_TURN_EXPIRY_MS } from "./advisor-turns.js";
import { AdvisorTurnsRepository } from "./advisor-turns.js";
import type { ReserveAdvisorTurnInput } from "./advisor-turns.js";
import { openEngagementDatabase } from "./database.js";
import { EngagementRepository } from "./repository.js";
import { advisorTurns } from "./schema.js";
import type { AdvisorSuppliedEvidenceId } from "@stonehush/contracts";

interface Fixture {
  directory: string;
  database: ReturnType<typeof openEngagementDatabase>;
  turns: AdvisorTurnsRepository;
  engagements: EngagementRepository;
  engagementId: string;
}

const fixtures: Fixture[] = [];

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture === undefined) continue;
    if (fixture.database.sqlite.open) fixture.database.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

function createFixture(nowIso = "2026-08-12T12:00:00.000Z"): Fixture {
  const directory = mkdtempSync(path.join(tmpdir(), "stonehush-advisor-turns-test-"));
  chmodSync(directory, 0o700);
  const database = openEngagementDatabase({ dataDirectory: directory });
  const engagements = new EngagementRepository(database.db);
  const created = engagements.createEngagement({
    name: "Lab",
    kind: "lab",
    description: null,
    authorizationContext: null,
    autoContinueWarnings: false,
  });
  if (!created.ok) throw new Error("engagement fixture failed");
  const turns = new AdvisorTurnsRepository(database.db, { now: () => new Date(nowIso) });
  const fixture = { directory, database, turns, engagements, engagementId: created.value.id };
  fixtures.push(fixture);
  return fixture;
}

const KEY_A = "test-key-aaaaaaaaaaaaaaaa";
const DIGEST_A = `sha256:${"ab".repeat(32)}`;
const DIGEST_B = `sha256:${"cd".repeat(32)}`;

interface ReserveOverrides {
  readonly engagementId?: string;
  readonly idempotencyKey?: string;
  readonly requestDigest?: string;
  readonly question?: string;
  readonly suppliedIds?: readonly AdvisorSuppliedEvidenceId[];
  readonly modelId?: string;
}

function reserveInput(overrides: ReserveOverrides = {}): ReserveAdvisorTurnInput {
  return {
    engagementId: overrides.engagementId ?? "",
    idempotencyKey: overrides.idempotencyKey ?? KEY_A,
    requestDigest: overrides.requestDigest ?? DIGEST_A,
    question: overrides.question ?? "What does this banner show?",
    suppliedIds: overrides.suppliedIds ?? [{ kind: "artifact", id: "nmap-xml-1" }],
    modelId: overrides.modelId ?? "synthetic-test-model",
  };
}

function explanation(overrides: Record<string, unknown> = {}) {
  return {
    profile: "advisor-explanation-v1",
    answer: "The banner shows an HTTP service.",
    citations: ["nmap-xml-1"],
    abstained: false,
    uncertainty: "",
    ...overrides,
  };
}

describe("advisor turn reservation", () => {
  it("reserves pending then replays the same key and digest", () => {
    const { turns, engagementId } = createFixture();
    const reserved = turns.reserveOrReplay(reserveInput({ engagementId }));
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    expect(reserved.value.disposition).toBe("reserved");
    expect(reserved.value.turn).toMatchObject({
      engagementId,
      status: "pending",
      question: "What does this banner show?",
      answer: "",
      citations: [],
      idempotencyKey: KEY_A,
      requestDigest: DIGEST_A,
    });
    const replayed = turns.reserveOrReplay(reserveInput({ engagementId }));
    expect(replayed).toEqual({
      ok: true,
      value: { disposition: "replayed", turn: reserved.value.turn },
    });
  });

  it("conflicts on the same key with a changed digest", () => {
    const { turns, engagementId } = createFixture();
    expect(turns.reserveOrReplay(reserveInput({ engagementId })).ok).toBe(true);
    expect(
      turns.reserveOrReplay(reserveInput({ engagementId, requestDigest: DIGEST_B })),
    ).toEqual({ ok: false, error: { code: "idempotency_conflict" } });
  });

  it("rejects invalid input without touching storage", () => {
    const { turns, engagementId, database } = createFixture();
    const bad = [
      reserveInput({ engagementId, idempotencyKey: "short" }),
      reserveInput({ engagementId, requestDigest: "sha256:xyz" }),
      reserveInput({ engagementId, question: "  padded  " }),
      reserveInput({ engagementId, question: "x".repeat(2001) }),
      reserveInput({ engagementId, modelId: "" }),
      reserveInput({
        engagementId,
        suppliedIds: [{ kind: "artifact", id: "HAS SPACE" }],
      }),
      reserveInput({
        engagementId,
        suppliedIds: [
          { kind: "artifact", id: "dup-1" },
          { kind: "service", id: "dup-1" },
        ],
      }),
      reserveInput({
        engagementId,
        suppliedIds: Array.from({ length: 13 }, (_, index) => ({
          kind: "artifact" as const,
          id: `artifact-${index}`,
        })),
      }),
    ];
    for (const input of bad) {
      expect(turns.reserveOrReplay(input)).toEqual({
        ok: false,
        error: { code: "invalid_input" },
      });
    }
    expect(database.db.select().from(advisorTurns).all()).toHaveLength(0);
  });

  it("rejects unknown engagements and archived writes while listing archived", () => {
    const { turns, engagements, engagementId } = createFixture();
    expect(
      turns.reserveOrReplay(reserveInput({ engagementId: "00000000-0000-4000-8000-000000000099" })),
    ).toEqual({ ok: false, error: { code: "engagement_not_found" } });
    const detail = engagements.getEngagement(engagementId);
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(engagements.archive(engagementId, detail.value.engagement.revision).ok).toBe(true);
    expect(turns.reserveOrReplay(reserveInput({ engagementId }))).toEqual({
      ok: false,
      error: { code: "engagement_archived" },
    });
    const listed = turns.listTurns(engagementId);
    expect(listed).toEqual({ ok: true, value: { turns: [], nextCursor: null } });
    expect(turns.listTurns("00000000-0000-4000-8000-000000000099")).toEqual({
      ok: false,
      error: { code: "engagement_not_found" },
    });
  });

  it("keeps engagements isolated", () => {
    const first = createFixture();
    const second = createFixture();
    const reserved = first.turns.reserveOrReplay(reserveInput({ engagementId: first.engagementId }));
    expect(reserved.ok).toBe(true);
    expect(second.turns.listTurns(second.engagementId)).toEqual({
      ok: true,
      value: { turns: [], nextCursor: null },
    });
    if (!reserved.ok) return;
    expect(
      second.turns.completeTurn({
        engagementId: second.engagementId,
        turnId: reserved.value.turn.id,
        requestDigest: DIGEST_A,
        completion: { status: "cancelled" },
      }),
    ).toEqual({ ok: false, error: { code: "turn_not_found" } });
  });

  it("maps a contended write lock to storage_busy", () => {
    const { engagementId, database, directory } = createFixture();
    const second = openEngagementDatabase({ dataDirectory: directory });
    try {
      second.sqlite.pragma("busy_timeout = 200");
      const contender = new AdvisorTurnsRepository(second.db);
      database.sqlite.exec("BEGIN IMMEDIATE");
      try {
        expect(contender.reserveOrReplay(reserveInput({ engagementId }))).toEqual({
          ok: false,
          error: { code: "storage_busy" },
        });
      } finally {
        database.sqlite.exec("ROLLBACK");
      }
      const retried = contender.reserveOrReplay(reserveInput({ engagementId }));
      expect(retried.ok).toBe(true);
      if (!retried.ok) return;
      expect(retried.value.disposition).toBe("reserved");
    } finally {
      if (second.sqlite.open) second.close();
    }
  });
});

describe("advisor turn completion", () => {
  function reservedTurn(nowIso = "2026-08-12T12:00:00.000Z") {
    const fixture = createFixture(nowIso);
    const reserved = fixture.turns.reserveOrReplay(
      reserveInput({ engagementId: fixture.engagementId }),
    );
    if (!reserved.ok || reserved.value.disposition !== "reserved") {
      throw new Error("reserve fixture failed");
    }
    return { fixture, turnId: reserved.value.turn.id };
  }

  it("completes succeeded once and derives explanation fields", () => {
    const { fixture, turnId } = reservedTurn();
    const completed = fixture.turns.completeTurn({
      engagementId: fixture.engagementId,
      turnId,
      requestDigest: DIGEST_A,
      completion: { status: "succeeded", explanation: explanation(), redactions: 2 },
    });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.value.turn).toMatchObject({
      status: "succeeded",
      answer: "The banner shows an HTTP service.",
      uncertainty: "",
      citations: ["nmap-xml-1"],
      redactions: 2,
      modelId: "synthetic-test-model",
      errorCode: null,
    });
    expect(
      fixture.turns.completeTurn({
        engagementId: fixture.engagementId,
        turnId,
        requestDigest: DIGEST_A,
        completion: { status: "cancelled" },
      }),
    ).toEqual({ ok: false, error: { code: "turn_not_pending" } });
  });

  it("rejects incoherent explanations and keeps the row pending", () => {
    const { fixture, turnId } = reservedTurn();
    expect(
      fixture.turns.completeTurn({
        engagementId: fixture.engagementId,
        turnId,
        requestDigest: DIGEST_A,
        completion: { status: "succeeded", explanation: explanation({ answer: "" }), redactions: 0 },
      }),
    ).toEqual({ ok: false, error: { code: "invalid_input" } });
    expect(
      fixture.turns.completeTurn({
        engagementId: fixture.engagementId,
        turnId,
        requestDigest: DIGEST_A,
        completion: { status: "provider_error", errorCode: "bogus" as never },
      }),
    ).toEqual({ ok: false, error: { code: "invalid_input" } });
    const replayed = fixture.turns.reserveOrReplay(
      reserveInput({ engagementId: fixture.engagementId }),
    );
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.value.turn.status).toBe("pending");
  });

  it("stores the exact abstained boolean, never a derivation", () => {
    // Identical text and citations with opposite flags must persist
    // opposite booleans: abstention cannot be inferred from blank fields.
    const sharedText = {
      answer: "Partial read: only the banner is visible.",
      citations: ["nmap-xml-1"],
      uncertainty: "Version cannot be determined from the banner alone.",
    };
    const first = createFixture();
    const firstReserved = first.turns.reserveOrReplay(
      reserveInput({ engagementId: first.engagementId }),
    );
    if (!firstReserved.ok || firstReserved.value.disposition !== "reserved") {
      throw new Error("reserve fixture failed");
    }
    const abstained = first.turns.completeTurn({
      engagementId: first.engagementId,
      turnId: firstReserved.value.turn.id,
      requestDigest: DIGEST_A,
      completion: {
        status: "succeeded",
        explanation: explanation({ ...sharedText, abstained: true }),
        redactions: 1,
      },
    });
    expect(abstained.ok).toBe(true);
    if (!abstained.ok) return;
    expect(abstained.value.turn.abstained).toBe(true);

    const second = createFixture();
    const secondReserved = second.turns.reserveOrReplay(
      reserveInput({ engagementId: second.engagementId }),
    );
    if (!secondReserved.ok || secondReserved.value.disposition !== "reserved") {
      throw new Error("reserve fixture failed");
    }
    const grounded = second.turns.completeTurn({
      engagementId: second.engagementId,
      turnId: secondReserved.value.turn.id,
      requestDigest: DIGEST_A,
      completion: {
        status: "succeeded",
        explanation: explanation({ ...sharedText, abstained: false }),
        redactions: 1,
      },
    });
    expect(grounded.ok).toBe(true);
    if (!grounded.ok) return;
    expect(grounded.value.turn.abstained).toBe(false);

    const relisted = second.turns.listTurns(second.engagementId);
    expect(relisted.ok).toBe(true);
    if (!relisted.ok) return;
    expect(relisted.value.turns[0]?.abstained).toBe(false);
  });

  it("stores bounded error codes without output", () => {
    const { fixture, turnId } = reservedTurn();
    const completed = fixture.turns.completeTurn({
      engagementId: fixture.engagementId,
      turnId,
      requestDigest: DIGEST_A,
      completion: { status: "provider_error", errorCode: "provider_timeout" },
    });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.value.turn).toMatchObject({
      status: "provider_error",
      answer: "",
      citations: [],
      errorCode: "provider_timeout",
    });
  });

  it("rejects digest mismatch and unknown rows without leaking", () => {
    const { fixture, turnId } = reservedTurn();
    expect(
      fixture.turns.completeTurn({
        engagementId: fixture.engagementId,
        turnId,
        requestDigest: DIGEST_B,
        completion: { status: "cancelled" },
      }),
    ).toEqual({ ok: false, error: { code: "reservation_mismatch" } });
    expect(
      fixture.turns.completeTurn({
        engagementId: fixture.engagementId,
        turnId: "00000000-0000-4000-8000-000000000099",
        requestDigest: DIGEST_A,
        completion: { status: "cancelled" },
      }),
    ).toEqual({ ok: false, error: { code: "turn_not_found" } });
  });

  it("expires stale pending rows and never resurrects them", () => {
    const staleAt = new Date(Date.UTC(2026, 7, 12, 10, 0)).toISOString();
    const { fixture, turnId } = reservedTurn(staleAt);
    const laterAt = new Date(
      Date.parse(staleAt) + ADVISOR_TURN_EXPIRY_MS + 1_000,
    ).toISOString();
    const later = new AdvisorTurnsRepository(fixture.database.db, {
      now: () => new Date(laterAt),
    });
    const expired = later.expireStalePending(fixture.engagementId);
    expect(expired).toEqual({ ok: true, value: { expired: 1 } });
    expect(
      later.completeTurn({
        engagementId: fixture.engagementId,
        turnId,
        requestDigest: DIGEST_A,
        completion: { status: "succeeded", explanation: explanation(), redactions: 0 },
      }),
    ).toEqual({ ok: false, error: { code: "turn_expired" } });
    const replayed = later.reserveOrReplay(reserveInput({ engagementId: fixture.engagementId }));
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.value.turn.status).toBe("expired");
  });

  it("scopes and bounds expiry without a sweeper", () => {
    const staleAt = "2026-08-12T10:00:00.000Z";
    const first = createFixture(staleAt);
    const second = createFixture(staleAt);
    for (const key of [KEY_A, "test-key-bbbbbbbbbbbbbbbb", "test-key-cccccccccccccccc"]) {
      expect(
        first.turns.reserveOrReplay(reserveInput({ engagementId: first.engagementId, idempotencyKey: key })),
      ).toMatchObject({ ok: true });
    }
    expect(
      second.turns.reserveOrReplay(
        reserveInput({ engagementId: second.engagementId, idempotencyKey: KEY_A }),
      ).ok,
    ).toBe(true);
    const current = new AdvisorTurnsRepository(first.database.db, {
      now: () => new Date("2026-08-12T12:00:00.000Z"),
    });
    expect(current.expireStalePending(first.engagementId, { limit: 2 })).toEqual({
      ok: true,
      value: { expired: 2 },
    });
    const remaining = current.listTurns(first.engagementId);
    expect(remaining.ok).toBe(true);
    if (!remaining.ok) return;
    expect(remaining.value.turns.filter((turn) => turn.status === "pending")).toHaveLength(1);
    const untouched = second.turns.listTurns(second.engagementId);
    expect(untouched.ok).toBe(true);
    if (!untouched.ok) return;
    expect(untouched.value.turns).toHaveLength(1);
    expect(untouched.value.turns[0]?.status).toBe("pending");
  });

  it("cleans archived pending rows to cancelled and reports archived", () => {
    const { fixture, turnId } = reservedTurn();
    const detail = fixture.engagements.getEngagement(fixture.engagementId);
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(
      fixture.engagements.archive(fixture.engagementId, detail.value.engagement.revision).ok,
    ).toBe(true);
    expect(
      fixture.turns.completeTurn({
        engagementId: fixture.engagementId,
        turnId,
        requestDigest: DIGEST_A,
        completion: { status: "succeeded", explanation: explanation(), redactions: 0 },
      }),
    ).toEqual({ ok: false, error: { code: "engagement_archived" } });
    const listed = fixture.turns.listTurns(fixture.engagementId);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.turns).toHaveLength(1);
    expect(listed.value.turns[0]).toMatchObject({ status: "cancelled", answer: "" });
  });

  it("leaves archived terminal rows untouched while reporting archived", () => {
    const { fixture, turnId } = reservedTurn();
    const completed = fixture.turns.completeTurn({
      engagementId: fixture.engagementId,
      turnId,
      requestDigest: DIGEST_A,
      completion: { status: "succeeded", explanation: explanation(), redactions: 0 },
    });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    const detail = fixture.engagements.getEngagement(fixture.engagementId);
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(
      fixture.engagements.archive(fixture.engagementId, detail.value.engagement.revision).ok,
    ).toBe(true);
    expect(
      fixture.turns.completeTurn({
        engagementId: fixture.engagementId,
        turnId,
        requestDigest: DIGEST_A,
        completion: { status: "cancelled" },
      }),
    ).toEqual({ ok: false, error: { code: "engagement_archived" } });
    const listed = fixture.turns.listTurns(fixture.engagementId);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.turns[0]).toMatchObject({
      status: "succeeded",
      answer: "The banner shows an HTTP service.",
    });
  });
});

describe("advisor turn history", () => {
  it("pages newest first with a deterministic cursor", () => {
    const fixture = createFixture();
    const ids: string[] = [];
    for (let minute = 0; minute < 3; minute += 1) {
      const turns = new AdvisorTurnsRepository(fixture.database.db, {
        now: () => new Date(Date.UTC(2026, 7, 12, 12, minute)),
      });
      const reserved = turns.reserveOrReplay(
        reserveInput({
          engagementId: fixture.engagementId,
          idempotencyKey: `test-key-minute-${String(minute).padStart(16, "0")}`,
        }),
      );
      if (!reserved.ok || reserved.value.disposition !== "reserved") {
        throw new Error("reserve fixture failed");
      }
      ids.push(reserved.value.turn.id);
    }
    const first = fixture.turns.listTurns(fixture.engagementId, { limit: 2 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.turns.map((turn) => turn.id)).toEqual([ids[2], ids[1]]);
    expect(first.value.nextCursor).toEqual({
      createdAt: first.value.turns[1]?.createdAt,
      id: ids[1],
    });
    if (first.value.nextCursor === null) throw new Error("cursor fixture failed");
    const second = fixture.turns.listTurns(fixture.engagementId, {
      cursor: first.value.nextCursor,
      limit: 2,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.turns.map((turn) => turn.id)).toEqual([ids[0]]);
    expect(second.value.nextCursor).toBeNull();
    expect(
      fixture.turns.listTurns(fixture.engagementId, {
        cursor: { createdAt: "short", id: ids[0] ?? "" },
      }),
    ).toEqual({ ok: false, error: { code: "invalid_input" } });
  });

  it("maps corrupt rows to invalid persisted data", () => {
    const { turns, engagementId, database } = createFixture();
    const reserved = turns.reserveOrReplay(reserveInput({ engagementId }));
    if (!reserved.ok || reserved.value.disposition !== "reserved") {
      throw new Error("reserve fixture failed");
    }
    const turnId = reserved.value.turn.id;
    // Valid JSON with the wrong shape: passes SQL CHECKs, fails strict mapping.
    database.db
      .update(advisorTurns)
      .set({ citationsJson: '{"not":"an array"}' })
      .where(eq(advisorTurns.id, turnId))
      .run();
    expect(turns.listTurns(engagementId)).toEqual({
      ok: false,
      error: { code: "invalid_persisted_data" },
    });
    database.db
      .update(advisorTurns)
      .set({ citationsJson: "[]", suppliedIdsJson: "[123]" })
      .where(eq(advisorTurns.id, turnId))
      .run();
    expect(turns.listTurns(engagementId)).toEqual({
      ok: false,
      error: { code: "invalid_persisted_data" },
    });
  });
});
