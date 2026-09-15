import { PersistedRunSchema, type PersistedRun } from "@stonehush/contracts";
import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema.js";
import { actions, engagements, evidenceArtifacts, runs } from "./schema.js";

type Database = BetterSQLite3Database<typeof schema>;

export type RunOutputRunRow = PersistedRun;
export type RunOutputArtifactRow = typeof evidenceArtifacts.$inferSelect;

type LatestTerminalResult =
  | { ok: true; run: PersistedRun | undefined }
  | { ok: false; code: "engagement_not_found" | "storage_busy" | "invalid_persisted_data" };

type RunForEngagementResult =
  | { ok: true; run: PersistedRun | undefined }
  | { ok: false; code: "engagement_not_found" | "storage_busy" | "invalid_persisted_data" };

export interface ListRunsForEngagementOptions {
  readonly limit: number;
  readonly before?: { readonly createdAt: string; readonly id: string };
}

type ListRunsForEngagementResult =
  | { ok: true; runs: PersistedRun[] }
  | { ok: false; code: "engagement_not_found" | "storage_busy" | "invalid_persisted_data" };

type ArtifactsForRunResult =
  | { ok: true; artifacts: RunOutputArtifactRow[] }
  | { ok: false; code: "storage_busy" | "invalid_persisted_data" };

type ArtifactsForEngagementResult =
  | { ok: true; artifacts: RunOutputArtifactRow[] }
  | {
      ok: false;
      code: "engagement_not_found" | "storage_busy" | "invalid_persisted_data";
    };

function persistedRunFromRow(row: typeof runs.$inferSelect): PersistedRun | undefined {
  const parsed = PersistedRunSchema.safeParse({
    contractVersion: row.contractVersion,
    id: row.id,
    actionId: row.actionId,
    engagementId: row.engagementId,
    attempt: row.attempt,
    state: row.state,
    currentLeaseId: row.currentLeaseId,
    currentFence: row.currentFence,
    terminalKind: row.terminalKind,
    terminalReason: row.terminalReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  return parsed.success ? parsed.data : undefined;
}

function storageCode(error: unknown): "storage_busy" | "invalid_persisted_data" {
  const code = (error as { code?: string })?.code;
  return code === "SQLITE_BUSY" || code === "SQLITE_BUSY_TIMEOUT"
    ? "storage_busy"
    : "invalid_persisted_data";
}

const TERMINAL_RUN_STATES = ["succeeded", "failed", "cancelled"] as const;

export class RunOutputRepository {
  constructor(private readonly db: Database) {}

  latestTerminalRunForEngagement(engagementId: string): LatestTerminalResult {
    try {
      const engagement = this.db
        .select({ id: engagements.id })
        .from(engagements)
        .where(eq(engagements.id, engagementId))
        .get();
      if (engagement === undefined) {
        return { ok: false, code: "engagement_not_found" };
      }
      const row = this.db
        .select()
        .from(runs)
        .innerJoin(actions, eq(actions.id, runs.actionId))
        .where(
          and(
            eq(runs.engagementId, engagementId),
            eq(actions.engagementId, engagementId),
            inArray(runs.state, [...TERMINAL_RUN_STATES]),
          ),
        )
        .orderBy(desc(runs.updatedAt), desc(runs.id))
        .limit(1)
        .get();
      if (row === undefined) return { ok: true, run: undefined };
      const parsed = persistedRunFromRow(row.runs);
      if (parsed === undefined) return { ok: false, code: "invalid_persisted_data" };
      return { ok: true, run: parsed };
    } catch (error) {
      return { ok: false, code: storageCode(error) };
    }
  }

  runForEngagement(engagementId: string, runId: string): RunForEngagementResult {
    try {
      const engagement = this.db
        .select({ id: engagements.id })
        .from(engagements)
        .where(eq(engagements.id, engagementId))
        .get();
      if (engagement === undefined) {
        return { ok: false, code: "engagement_not_found" };
      }
      const row = this.db
        .select()
        .from(runs)
        .innerJoin(actions, eq(actions.id, runs.actionId))
        .where(
          and(
            eq(runs.id, runId),
            eq(runs.engagementId, engagementId),
            eq(actions.engagementId, engagementId),
          ),
        )
        .get();
      if (row === undefined) return { ok: true, run: undefined };
      const parsed = persistedRunFromRow(row.runs);
      if (parsed === undefined) return { ok: false, code: "invalid_persisted_data" };
      return { ok: true, run: parsed };
    } catch (error) {
      return { ok: false, code: storageCode(error) };
    }
  }

  // Live keyset listing for the run-history endpoint. Newest createdAt
  // first, stable descending id tie-break, strict tuple comparison below the
  // cursor. Fetches limit plus one with the same ownership predicate; the
  // caller slices to limit and issues nextCursor from the last returned row
  // only when another row exists. No OFFSET, no updatedAt cursor.
  //
  // Ownership requires BOTH runs.engagementId and actions.engagementId
  // through the run-to-action inner join; only run columns are selected so a
  // mismatched action never leaks a row. Archived engagements stay readable
  // because only existence is checked.
  //
  // Existing indices (run_engagement_id_unique and run_queue_order_idx on
  // state/createdAt/id) do not exactly cover engagement/createdAt/id
  // ordering. LIMIT bounds materialization, not scan/sort cost. Accepted
  // without a migration for this bounded listing.
  listRunsForEngagement(
    engagementId: string,
    options: ListRunsForEngagementOptions,
  ): ListRunsForEngagementResult {
    try {
      const engagement = this.db
        .select({ id: engagements.id })
        .from(engagements)
        .where(eq(engagements.id, engagementId))
        .get();
      if (engagement === undefined) {
        return { ok: false, code: "engagement_not_found" };
      }
      const cursor = options.before;
      const cursorPredicate =
        cursor === undefined
          ? undefined
          : or(
              lt(runs.createdAt, cursor.createdAt),
              and(eq(runs.createdAt, cursor.createdAt), lt(runs.id, cursor.id)),
            );
      const ownership = and(
        eq(runs.engagementId, engagementId),
        eq(actions.engagementId, engagementId),
      );
      const rows = this.db
        .select({ run: runs })
        .from(runs)
        .innerJoin(actions, eq(actions.id, runs.actionId))
        .where(
          cursorPredicate === undefined
            ? ownership
            : and(ownership, cursorPredicate),
        )
        .orderBy(desc(runs.createdAt), desc(runs.id))
        .limit(options.limit + 1)
        .all();
      const parsed: PersistedRun[] = [];
      for (const row of rows) {
        const run = persistedRunFromRow(row.run);
        if (run === undefined) {
          return { ok: false, code: "invalid_persisted_data" };
        }
        parsed.push(run);
      }
      return { ok: true, runs: parsed };
    } catch (error) {
      return { ok: false, code: storageCode(error) };
    }
  }

  artifactsForRun(runId: string): ArtifactsForRunResult {
    try {
      const rows = this.db
        .select()
        .from(evidenceArtifacts)
        .where(eq(evidenceArtifacts.runId, runId))
        .all();
      return { ok: true, artifacts: rows };
    } catch (error) {
      return { ok: false, code: storageCode(error) };
    }
  }

  // Published evidence digests scoped to one engagement through
  // run -> action membership. Read-only: archived engagements stay readable.
  listArtifactsForEngagement(engagementId: string): ArtifactsForEngagementResult {
    try {
      const engagement = this.db
        .select({ id: engagements.id })
        .from(engagements)
        .where(eq(engagements.id, engagementId))
        .get();
      if (engagement === undefined) {
        return { ok: false, code: "engagement_not_found" };
      }
      const rows = this.db
        .select({ artifact: evidenceArtifacts })
        .from(evidenceArtifacts)
        .innerJoin(runs, eq(runs.id, evidenceArtifacts.runId))
        .innerJoin(actions, eq(actions.id, runs.actionId))
        .where(
          and(
            eq(runs.engagementId, engagementId),
            eq(actions.engagementId, engagementId),
          ),
        )
        .orderBy(evidenceArtifacts.createdAt, evidenceArtifacts.artifactId)
        .all();
      return { ok: true, artifacts: rows.map((row) => row.artifact) };
    } catch (error) {
      return { ok: false, code: storageCode(error) };
    }
  }
}
