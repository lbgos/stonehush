import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import {
  ADVISOR_EVIDENCE_BLOCKS_MAX,
  ADVISOR_EXPLANATION_PROFILE,
  AdvisorExplanationSchema,
  AdvisorQuestionSchema,
  AdvisorSuppliedEvidenceIdSchema,
  CommandRequestDigestSchema,
  IdempotencyKeySchema,
  type AdvisorSuppliedEvidenceId,
} from "@stonehush/contracts";

import * as schema from "./schema.js";
import { advisorTurns, engagements } from "./schema.js";
import type { DatabaseWriteClient } from "./repository.js";

type Database = BetterSQLite3Database<typeof schema>;

// P3a storage and reservation for read-only evidence explanations. No
// provider calls, no prompt assembly, no redaction here: the caller supplies
// already-redacted bounded data and this repository validates shape, never
// content. Terminal rows are immutable; only pending rows transition.

export const ADVISOR_TURN_EXPIRY_MS = 180_000 as const;
export const ADVISOR_TURN_EXPIRY_CLEANUP_LIMIT = 100 as const;
export const ADVISOR_TURN_LIST_MAX = 50 as const;
const ADVISOR_TURN_CONTRACT_VERSION = 1 as const;

const ADVISOR_TURN_STATUSES = [
  "pending",
  "succeeded",
  "parse_error",
  "provider_error",
  "cancelled",
  "expired",
] as const;

export type AdvisorTurnStatus = (typeof ADVISOR_TURN_STATUSES)[number];

const ADVISOR_TURN_FAILURE_CODES = [
  "provider_timeout",
  "provider_unreachable",
  "provider_response_too_large",
  "provider_redirect_rejected",
  "provider_parse_error",
  "context_too_large",
] as const;

export type AdvisorTurnFailureCode = (typeof ADVISOR_TURN_FAILURE_CODES)[number];

export type AdvisorTurnsErrorCode =
  | "invalid_input"
  | "engagement_not_found"
  | "engagement_archived"
  | "idempotency_conflict"
  | "turn_not_found"
  | "turn_not_pending"
  | "turn_expired"
  | "reservation_mismatch"
  | "storage_busy"
  | "invalid_persisted_data";

export type AdvisorTurnsError = { code: AdvisorTurnsErrorCode };

export type AdvisorTurnsResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AdvisorTurnsError };

export interface AdvisorTurnRecord {
  readonly id: string;
  readonly engagementId: string;
  readonly status: AdvisorTurnStatus;
  readonly question: string;
  readonly answer: string;
  readonly uncertainty: string;
  // Explicit abstention flag for succeeded turns, null otherwise. Never
  // inferred: P1 allows abstained answers with partial text and citations.
  readonly abstained: boolean | null;
  readonly citations: readonly string[];
  readonly suppliedIds: readonly AdvisorSuppliedEvidenceId[];
  readonly redactions: number;
  readonly modelId: string;
  readonly errorCode: AdvisorTurnFailureCode | null;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReserveAdvisorTurnInput {
  readonly engagementId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly question: string;
  readonly suppliedIds: readonly AdvisorSuppliedEvidenceId[];
  readonly modelId: string;
}

export type CompleteAdvisorTurnCompletion =
  | { readonly status: "succeeded"; readonly explanation: unknown; readonly redactions: number }
  | { readonly status: "parse_error" | "provider_error"; readonly errorCode: AdvisorTurnFailureCode }
  | { readonly status: "cancelled" };

export interface CompleteAdvisorTurnInput {
  readonly engagementId: string;
  readonly turnId: string;
  readonly requestDigest: string;
  readonly completion: CompleteAdvisorTurnCompletion;
}

export interface AdvisorTurnCursor {
  readonly createdAt: string;
  readonly id: string;
}

function failed(code: AdvisorTurnsErrorCode): AdvisorTurnsResult<never> {
  return { ok: false, error: { code } };
}

function storageError(error: unknown): AdvisorTurnsError {
  const code = (error as { code?: string })?.code;
  if (code === "SQLITE_BUSY" || code === "SQLITE_BUSY_TIMEOUT") {
    return { code: "storage_busy" };
  }
  return { code: "invalid_persisted_data" };
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === "SQLITE_CONSTRAINT_UNIQUE";
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 255;
}

function isStatus(value: unknown): value is AdvisorTurnStatus {
  return (
    typeof value === "string" &&
    (ADVISOR_TURN_STATUSES as readonly string[]).includes(value)
  );
}

function isFailureCode(value: unknown): value is AdvisorTurnFailureCode {
  return (
    typeof value === "string" &&
    (ADVISOR_TURN_FAILURE_CODES as readonly string[]).includes(value)
  );
}

function parseStringArray(raw: string): readonly string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const values: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "string") return undefined;
    values.push(entry);
  }
  return values;
}

// Strict read coherence: every invariant completeTurn writes is rechecked,
// so corrupt rows surface as invalid_persisted_data instead of leaking.
function mapTurnRow(row: typeof advisorTurns.$inferSelect): AdvisorTurnRecord | undefined {
  if (row.contractVersion !== ADVISOR_TURN_CONTRACT_VERSION) return undefined;
  if (!isStatus(row.status)) return undefined;
  if (utf8ByteLength(row.question) < 1 || utf8ByteLength(row.question) > 2_000) {
    return undefined;
  }
  if (utf8ByteLength(row.answer) > 8_000 || utf8ByteLength(row.uncertainty) > 2_000) {
    return undefined;
  }
  const citations = parseStringArray(row.citationsJson);
  if (citations === undefined) return undefined;
  let supplied: unknown;
  try {
    supplied = JSON.parse(row.suppliedIdsJson);
  } catch {
    return undefined;
  }
  const suppliedIds = AdvisorSuppliedEvidenceIdSchema.array()
    .max(ADVISOR_EVIDENCE_BLOCKS_MAX)
    .safeParse(supplied);
  if (!suppliedIds.success) return undefined;
  if (!Number.isSafeInteger(row.redactions) || row.redactions < 0) return undefined;
  if (row.modelId.length < 1 || row.modelId.length > 128) return undefined;
  let errorCode: AdvisorTurnFailureCode | null = null;
  if (row.status === "parse_error" || row.status === "provider_error") {
    if (!isFailureCode(row.errorCode)) return undefined;
    errorCode = row.errorCode;
  } else if (row.errorCode !== null) {
    return undefined;
  }
  // Succeeded rows revalidate through the whole explanation schema, so the
  // stored fields satisfy every P1 invariant including the grounded-answer
  // citation rule. Other statuses carry no explanation and must be null.
  let abstained: boolean | null = null;
  if (row.status === "succeeded") {
    if (typeof row.abstained !== "boolean") return undefined;
    const explanation = AdvisorExplanationSchema.safeParse({
      profile: ADVISOR_EXPLANATION_PROFILE,
      answer: row.answer,
      citations: [...citations],
      abstained: row.abstained,
      uncertainty: row.uncertainty,
    });
    if (!explanation.success) return undefined;
    abstained = row.abstained;
  } else if (row.abstained !== null) {
    return undefined;
  }
  if (
    (row.status === "pending" || row.status === "cancelled" || row.status === "expired") &&
    (row.answer !== "" || row.uncertainty !== "" || citations.length !== 0)
  ) {
    return undefined;
  }
  return {
    id: row.id,
    engagementId: row.engagementId,
    status: row.status,
    question: row.question,
    answer: row.answer,
    uncertainty: row.uncertainty,
    abstained,
    citations,
    suppliedIds: suppliedIds.data,
    redactions: row.redactions,
    modelId: row.modelId,
    errorCode,
    idempotencyKey: row.idempotencyKey,
    requestDigest: row.requestDigest,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface AdvisorTurnsRepositoryProviders {
  now?: () => Date;
  createId?: () => string;
}

export class AdvisorTurnsRepository {
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(
    private readonly db: Database,
    providers: AdvisorTurnsRepositoryProviders = {},
  ) {
    this.now = providers.now ?? (() => new Date());
    this.createId = providers.createId ?? randomUUID;
  }

  private cutoffIso(): string {
    return new Date(this.now().getTime() - ADVISOR_TURN_EXPIRY_MS).toISOString();
  }

  private expireStalePendingTx(
    tx: DatabaseWriteClient,
    engagementId: string,
    cutoffIso: string,
    stampedAt: string,
    limit: number,
  ): number {
    const stale = tx
      .select({ id: advisorTurns.id })
      .from(advisorTurns)
      .where(
        and(
          eq(advisorTurns.engagementId, engagementId),
          eq(advisorTurns.status, "pending"),
          lt(advisorTurns.createdAt, cutoffIso),
        ),
      )
      .orderBy(advisorTurns.createdAt, advisorTurns.id)
      .limit(limit)
      .all();
    if (stale.length === 0) return 0;
    // Bound the write to exactly the selected rows: the limit binds.
    tx.update(advisorTurns)
      .set({ status: "expired", updatedAt: stampedAt })
      .where(
        and(
          eq(advisorTurns.engagementId, engagementId),
          eq(advisorTurns.status, "pending"),
          inArray(
            advisorTurns.id,
            stale.map((row) => row.id),
          ),
        ),
      )
      .run();
    return stale.length;
  }

  reserveOrReplay(
    input: ReserveAdvisorTurnInput,
  ): AdvisorTurnsResult<{ disposition: "reserved" | "replayed"; turn: AdvisorTurnRecord }> {
    if (!isIdentifier(input.engagementId)) return failed("invalid_input");
    if (!IdempotencyKeySchema.safeParse(input.idempotencyKey).success) {
      return failed("invalid_input");
    }
    if (!CommandRequestDigestSchema.safeParse(input.requestDigest).success) {
      return failed("invalid_input");
    }
    if (!AdvisorQuestionSchema.safeParse(input.question).success) {
      return failed("invalid_input");
    }
    const suppliedIds = AdvisorSuppliedEvidenceIdSchema.array()
      .max(ADVISOR_EVIDENCE_BLOCKS_MAX)
      .safeParse([...input.suppliedIds]);
    if (!suppliedIds.success) return failed("invalid_input");
    if (new Set(suppliedIds.data.map((entry) => entry.id)).size !== suppliedIds.data.length) {
      return failed("invalid_input");
    }
    if (typeof input.modelId !== "string" || input.modelId.length < 1 ||
        input.modelId.length > 128) {
      return failed("invalid_input");
    }
    const turnId = this.createId();
    if (!isIdentifier(turnId)) return failed("invalid_persisted_data");
    const stampedAt = this.now().toISOString();
    const cutoffIso = this.cutoffIso();
    const suppliedJson = JSON.stringify(suppliedIds.data);
    try {
      return this.db.transaction(
        (tx) => {
          const engagement = tx
            .select({ id: engagements.id, status: engagements.status })
            .from(engagements)
            .where(eq(engagements.id, input.engagementId))
            .get();
          if (engagement === undefined) return failed("engagement_not_found");
          if (engagement.status === "archived") return failed("engagement_archived");
          this.expireStalePendingTx(tx, input.engagementId, cutoffIso, stampedAt,
            ADVISOR_TURN_EXPIRY_CLEANUP_LIMIT);
          const existing = tx
            .select()
            .from(advisorTurns)
            .where(
              and(
                eq(advisorTurns.engagementId, input.engagementId),
                eq(advisorTurns.idempotencyKey, input.idempotencyKey),
              ),
            )
            .get();
          if (existing !== undefined) {
            if (existing.requestDigest !== input.requestDigest) {
              return failed("idempotency_conflict");
            }
            const replayed = mapTurnRow(existing);
            if (replayed === undefined) return failed("invalid_persisted_data");
            return { ok: true as const, value: { disposition: "replayed" as const, turn: replayed } };
          }
          tx.insert(advisorTurns).values({
            id: turnId,
            contractVersion: ADVISOR_TURN_CONTRACT_VERSION,
            engagementId: input.engagementId,
            status: "pending",
            question: input.question,
            answer: "",
            uncertainty: "",
            abstained: null,
            citationsJson: "[]",
            suppliedIdsJson: suppliedJson,
            redactions: 0,
            modelId: input.modelId,
            errorCode: null,
            idempotencyKey: input.idempotencyKey,
            requestDigest: input.requestDigest,
            createdAt: stampedAt,
            updatedAt: stampedAt,
          }).run();
          const inserted = tx
            .select()
            .from(advisorTurns)
            .where(eq(advisorTurns.id, turnId))
            .get();
          if (inserted === undefined) return failed("invalid_persisted_data");
          const turn = mapTurnRow(inserted);
          if (turn === undefined) return failed("invalid_persisted_data");
          return { ok: true as const, value: { disposition: "reserved" as const, turn } };
        },
        { behavior: "immediate" },
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        // A concurrent insert won the race: re-read deterministically.
        return this.replayAfterConflict(input.engagementId, input.idempotencyKey, input.requestDigest);
      }
      return { ok: false, error: storageError(error) };
    }
  }

  // Narrow read-only lookup by idempotency key for the early-replay path.
  // Single statement, no transaction, no writes: expiry and conflict
  // decisions stay with the caller.
  lookupTurnByIdempotencyKey(
    engagementId: string,
    idempotencyKey: string,
  ): AdvisorTurnsResult<{ turn: AdvisorTurnRecord | null }> {
    if (!isIdentifier(engagementId)) return failed("invalid_input");
    if (!IdempotencyKeySchema.safeParse(idempotencyKey).success) {
      return failed("invalid_input");
    }
    try {
      const existing = this.db
        .select()
        .from(advisorTurns)
        .where(
          and(
            eq(advisorTurns.engagementId, engagementId),
            eq(advisorTurns.idempotencyKey, idempotencyKey),
          ),
        )
        .get();
      if (existing === undefined) return { ok: true, value: { turn: null } };
      const turn = mapTurnRow(existing);
      if (turn === undefined) return failed("invalid_persisted_data");
      return { ok: true, value: { turn } };
    } catch (error) {
      return { ok: false, error: storageError(error) };
    }
  }

  private replayAfterConflict(
    engagementId: string,
    idempotencyKey: string,
    requestDigest: string,
  ): AdvisorTurnsResult<{ disposition: "reserved" | "replayed"; turn: AdvisorTurnRecord }> {
    try {
      const existing = this.db
        .select()
        .from(advisorTurns)
        .where(
          and(
            eq(advisorTurns.engagementId, engagementId),
            eq(advisorTurns.idempotencyKey, idempotencyKey),
          ),
        )
        .get();
      if (existing === undefined) return failed("invalid_persisted_data");
      if (existing.requestDigest !== requestDigest) return failed("idempotency_conflict");
      const turn = mapTurnRow(existing);
      if (turn === undefined) return failed("invalid_persisted_data");
      return { ok: true, value: { disposition: "replayed", turn } };
    } catch (error) {
      return { ok: false, error: storageError(error) };
    }
  }

  completeTurn(
    input: CompleteAdvisorTurnInput,
  ): AdvisorTurnsResult<{ turn: AdvisorTurnRecord }> {
    if (!isIdentifier(input.engagementId) || !isIdentifier(input.turnId)) {
      return failed("invalid_input");
    }
    if (!CommandRequestDigestSchema.safeParse(input.requestDigest).success) {
      return failed("invalid_input");
    }
    const completion = input.completion;
    if (
      completion.status !== "succeeded" && completion.status !== "parse_error" &&
      completion.status !== "provider_error" && completion.status !== "cancelled"
    ) {
      return failed("invalid_input");
    }
    let answer = "";
    let uncertainty = "";
    let citations: readonly string[] = [];
    let abstained: boolean | null = null;
    let redactions = 0;
    let errorCode: AdvisorTurnFailureCode | null = null;
    if (completion.status === "succeeded") {
      const explanation = AdvisorExplanationSchema.safeParse(completion.explanation);
      if (!explanation.success) return failed("invalid_input");
      if (
        !Number.isSafeInteger(completion.redactions) || completion.redactions < 0
      ) {
        return failed("invalid_input");
      }
      answer = explanation.data.answer;
      uncertainty = explanation.data.uncertainty;
      citations = [...explanation.data.citations];
      abstained = explanation.data.abstained;
      redactions = completion.redactions;
    } else if (completion.status === "parse_error" || completion.status === "provider_error") {
      if (!isFailureCode(completion.errorCode)) return failed("invalid_input");
      errorCode = completion.errorCode;
    }
    const stampedAt = this.now().toISOString();
    const cutoffIso = this.cutoffIso();
    try {
      return this.db.transaction(
        (tx) => {
          const engagement = tx
            .select({ id: engagements.id, status: engagements.status })
            .from(engagements)
            .where(eq(engagements.id, input.engagementId))
            .get();
          if (engagement === undefined) return failed("engagement_not_found");
          const row = tx
            .select()
            .from(advisorTurns)
            .where(eq(advisorTurns.id, input.turnId))
            .get();
          if (row === undefined || row.engagementId !== input.engagementId) {
            return failed("turn_not_found");
          }
          if (mapTurnRow(row) === undefined) return failed("invalid_persisted_data");
          if (row.requestDigest !== input.requestDigest) {
            return failed("reservation_mismatch");
          }
          // Archived engagements never keep a pending turn: clean the row up
          // to terminal cancelled without storing output, and still report
          // archived so the route maps its own response. Terminal rows are
          // left untouched.
          if (engagement.status === "archived") {
            if (row.status === "pending") {
              tx.update(advisorTurns)
                .set({ status: "cancelled", updatedAt: stampedAt })
                .where(eq(advisorTurns.id, row.id))
                .run();
            }
            return failed("engagement_archived");
          }
          // The explicit row expires consistently even when the bounded batch
          // cleanup left it pending: it can never resurrect afterwards. Rows
          // already expired report the same code without any write.
          if (row.status === "pending" && row.createdAt < cutoffIso) {
            tx.update(advisorTurns)
              .set({ status: "expired", updatedAt: stampedAt })
              .where(eq(advisorTurns.id, row.id))
              .run();
            return failed("turn_expired");
          }
          if (row.status === "expired") return failed("turn_expired");
          if (row.status !== "pending") return failed("turn_not_pending");
          const completed =           tx.update(advisorTurns)
            .set({
              status: completion.status,
              answer,
              uncertainty,
              abstained,
              citationsJson: JSON.stringify(citations),
              redactions,
              errorCode,
              updatedAt: stampedAt,
            })
            .where(
              and(
                eq(advisorTurns.id, row.id),
                eq(advisorTurns.engagementId, input.engagementId),
                eq(advisorTurns.requestDigest, input.requestDigest),
                eq(advisorTurns.status, "pending"),
              ),
            )
            .run();
          if (completed.changes !== 1) return failed("turn_not_pending");
          const updated = tx
            .select()
            .from(advisorTurns)
            .where(eq(advisorTurns.id, row.id))
            .get();
          if (updated === undefined) return failed("invalid_persisted_data");
          const turn = mapTurnRow(updated);
          if (turn === undefined || turn.status === "pending") {
            return failed("turn_not_pending");
          }
          return { ok: true as const, value: { turn } };
        },
        { behavior: "immediate" },
      );
    } catch (error) {
      return { ok: false, error: storageError(error) };
    }
  }

  expireStalePending(
    engagementId: string,
    options: { cutoffIso?: string; limit?: number } = {},
  ): AdvisorTurnsResult<{ expired: number }> {
    if (!isIdentifier(engagementId)) return failed("invalid_input");
    const cutoffIso = options.cutoffIso ?? this.cutoffIso();
    if (typeof cutoffIso !== "string" || cutoffIso.length < 20) {
      return failed("invalid_input");
    }
    const limit = options.limit ?? ADVISOR_TURN_EXPIRY_CLEANUP_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      return failed("invalid_input");
    }
    const stampedAt = this.now().toISOString();
    try {
      return this.db.transaction(
        (tx) => {
          const engagement = tx
            .select({ id: engagements.id })
            .from(engagements)
            .where(eq(engagements.id, engagementId))
            .get();
          if (engagement === undefined) return failed("engagement_not_found");
          const count = this.expireStalePendingTx(tx, engagementId, cutoffIso, stampedAt, limit);
          return { ok: true as const, value: { expired: count } };
        },
        { behavior: "immediate" },
      );
    } catch (error) {
      return { ok: false, error: storageError(error) };
    }
  }

  listTurns(
    engagementId: string,
    options: { cursor?: AdvisorTurnCursor; limit?: number } = {},
  ): AdvisorTurnsResult<{ turns: readonly AdvisorTurnRecord[]; nextCursor: AdvisorTurnCursor | null }> {
    if (!isIdentifier(engagementId)) return failed("invalid_input");
    const limit = options.limit ?? ADVISOR_TURN_LIST_MAX;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > ADVISOR_TURN_LIST_MAX) {
      return failed("invalid_input");
    }
    const cursor = options.cursor;
    if (cursor !== undefined) {
      if (
        typeof cursor.createdAt !== "string" || cursor.createdAt.length < 20 ||
        !isIdentifier(cursor.id)
      ) {
        return failed("invalid_input");
      }
    }
    try {
      const engagement = this.db
        .select({ id: engagements.id })
        .from(engagements)
        .where(eq(engagements.id, engagementId))
        .get();
      if (engagement === undefined) return failed("engagement_not_found");
      const rows = this.db
        .select()
        .from(advisorTurns)
        .where(
          and(
            eq(advisorTurns.engagementId, engagementId),
            cursor === undefined
              ? undefined
              : or(
                  lt(advisorTurns.createdAt, cursor.createdAt),
                  and(
                    eq(advisorTurns.createdAt, cursor.createdAt),
                    lt(advisorTurns.id, cursor.id),
                  ),
                ),
          ),
        )
        .orderBy(desc(advisorTurns.createdAt), desc(advisorTurns.id))
        .limit(limit + 1)
        .all();
      const turns: AdvisorTurnRecord[] = [];
      for (const row of rows.slice(0, limit)) {
        const turn = mapTurnRow(row);
        if (turn === undefined) return failed("invalid_persisted_data");
        turns.push(turn);
      }
      const last = turns[turns.length - 1];
      const nextCursor =
        rows.length > limit && last !== undefined
          ? { createdAt: last.createdAt, id: last.id }
          : null;
      return { ok: true, value: { turns, nextCursor } };
    } catch (error) {
      return { ok: false, error: storageError(error) };
    }
  }
}
