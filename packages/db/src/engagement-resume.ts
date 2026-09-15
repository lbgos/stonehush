import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import {
  EngagementNextStepRecordSchema,
  EngagementNextStepSchema,
  UpdateEngagementNextStepRequestSchema,
  type EngagementNextStepRecord,
} from "@stonehush/contracts";

import * as schema from "./schema.js";
import { engagementNextSteps, engagements } from "./schema.js";

type Database = BetterSQLite3Database<typeof schema>;

export type EngagementResumeRepositoryError =
  | { code: "engagement_not_found" }
  | { code: "engagement_archived" }
  | { code: "invalid_repository_input" }
  | { code: "revision_conflict"; currentRevision: number }
  | { code: "storage_busy" }
  | { code: "invalid_persisted_data" };

export type EngagementResumeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: EngagementResumeRepositoryError };

function isStorageBusy(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: string }).code === "SQLITE_BUSY" ||
      (error as { code?: string }).code === "SQLITE_BUSY_TIMEOUT")
  );
}

function failed<T>(error: EngagementResumeRepositoryError): EngagementResumeResult<T> {
  return { ok: false, error };
}

function isPrimaryKeyConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY"
  );
}

/**
 * STONE-6 next-step store. Own table and own revision, mirroring the notes
 * pattern: archived engagements reject writes, expectedRevision guards
 * compare-and-swap, and a missing row reads as cleared revision 0.
 */
export class EngagementResumeRepository {
  constructor(
    private readonly db: Database,
    private readonly providers: { now?: () => Date } = {},
  ) {}

  private now(): Date {
    return this.providers.now?.() ?? new Date();
  }

  getNextStep(engagementId: string): EngagementResumeResult<EngagementNextStepRecord> {
    try {
      const engagement = this.db
        .select({ status: engagements.status })
        .from(engagements)
        .where(eq(engagements.id, engagementId))
        .get();
      if (engagement === undefined) return failed({ code: "engagement_not_found" });
      const row = this.db
        .select()
        .from(engagementNextSteps)
        .where(eq(engagementNextSteps.engagementId, engagementId))
        .get();
      if (row === undefined) {
        const validated = EngagementNextStepRecordSchema.safeParse({
          engagementId,
          nextStep: null,
          updatedAt: this.now().toISOString(),
          revision: 0,
        });
        if (!validated.success) return failed({ code: "invalid_persisted_data" });
        return { ok: true, value: validated.data };
      }
      const validated = EngagementNextStepRecordSchema.safeParse({
        engagementId: row.engagementId,
        nextStep: row.nextStep,
        updatedAt: row.updatedAt,
        revision: row.revision,
      });
      if (!validated.success) return failed({ code: "invalid_persisted_data" });
      return { ok: true, value: validated.data };
    } catch (error) {
      return failed({ code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data" });
    }
  }

  putNextStep(
    engagementId: string,
    input: unknown,
  ): EngagementResumeResult<EngagementNextStepRecord> {
    const parsed = UpdateEngagementNextStepRequestSchema.safeParse(input);
    if (!parsed.success) return failed({ code: "invalid_repository_input" });
    if (parsed.data.nextStep !== null) {
      const step = EngagementNextStepSchema.safeParse(parsed.data.nextStep);
      if (!step.success) return failed({ code: "invalid_repository_input" });
    }
    const expectedRevision = parsed.data.expectedRevision;
    if (expectedRevision >= Number.MAX_SAFE_INTEGER) {
      return failed({ code: "invalid_repository_input" });
    }
    const nextRevision = expectedRevision + 1;
    const updatedAt = this.now().toISOString();
    // Check and write run atomically: the revision read, the archived
    // check, and the write share one transaction, and the write itself is
    // conditional on the expected revision, so a concurrent writer or an
    // archival between the read and the write turns into a conflict or an
    // archived rejection instead of a silent overwrite.
    try {
      return this.db.transaction((tx) => {
        const engagement = tx
          .select({ status: engagements.status })
          .from(engagements)
          .where(eq(engagements.id, engagementId))
          .get();
        if (engagement === undefined) return failed({ code: "engagement_not_found" });
        if (engagement.status === "archived") return failed({ code: "engagement_archived" });
        const existing = tx
          .select()
          .from(engagementNextSteps)
          .where(eq(engagementNextSteps.engagementId, engagementId))
          .get();
        const currentRevision = existing?.revision ?? 0;
        if (expectedRevision !== currentRevision) {
          return failed({ code: "revision_conflict", currentRevision });
        }
        if (existing === undefined) {
          // No conditional insert primitive here: a concurrent first write
          // surfaces as a primary-key conflict below and is reported as a
          // revision conflict, never a silent overwrite.
          tx
            .insert(engagementNextSteps)
            .values({ engagementId, nextStep: parsed.data.nextStep, updatedAt, revision: nextRevision })
            .run();
        } else {
          const updated = tx
            .update(engagementNextSteps)
            .set({ nextStep: parsed.data.nextStep, updatedAt, revision: nextRevision })
            .where(
              and(
                eq(engagementNextSteps.engagementId, engagementId),
                eq(engagementNextSteps.revision, expectedRevision),
              ),
            )
            .run();
          if (updated.changes === 0) {
            return failed({ code: "revision_conflict", currentRevision: expectedRevision });
          }
        }
        const validated = EngagementNextStepRecordSchema.safeParse({
          engagementId,
          nextStep: parsed.data.nextStep,
          updatedAt,
          revision: nextRevision,
        });
        if (!validated.success) return failed({ code: "invalid_persisted_data" });
        return { ok: true, value: validated.data };
      });
    } catch (error) {
      if (isStorageBusy(error)) return failed({ code: "storage_busy" });
      if (isPrimaryKeyConflict(error)) {
        const reread = this.getNextStep(engagementId);
        if (reread.ok) {
          return failed({ code: "revision_conflict", currentRevision: reread.value.revision });
        }
      }
      return failed({ code: "invalid_persisted_data" });
    }
  }
}
