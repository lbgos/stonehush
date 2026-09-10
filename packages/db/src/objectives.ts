import { createHash, randomUUID } from "node:crypto";

import {
  CaptureObjectiveRequestSchema,
  CreateObjectiveRequestSchema,
  OBJECTIVE_CONTRACT_VERSION,
  ObjectiveSchema,
  type Objective,
} from "@blackglass/contracts";
import { proofHintForValue } from "@blackglass/domain";
import { asc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema.js";
import { engagements, objectives, type ObjectiveRow } from "./schema.js";

type Database = BetterSQLite3Database<typeof schema>;

export interface ObjectiveRepositoryProviders {
  createId?: () => string;
  now?: () => Date;
}

export type ObjectiveRepositoryError =
  | { code: "engagement_not_found" }
  | { code: "engagement_archived" }
  | { code: "objective_not_found" }
  | { code: "invalid_objective_transition" }
  | { code: "invalid_repository_input" }
  | { code: "invalid_persisted_data" }
  | { code: "storage_busy" };

export type ObjectiveResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ObjectiveRepositoryError };

function failed<T>(error: ObjectiveRepositoryError): ObjectiveResult<T> {
  return { ok: false, error };
}

function isStorageBusy(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "SQLITE_BUSY" || error.code === "SQLITE_BUSY_TIMEOUT")
  );
}

function objectiveFromRow(row: ObjectiveRow): ObjectiveResult<Objective> {
  const parsed = ObjectiveSchema.safeParse({
    contractVersion: row.contractVersion,
    id: row.id,
    engagementId: row.engagementId,
    name: row.name,
    kind: row.kind,
    state: row.state,
    proofHint: row.proofHint,
    proofDigest: row.proofDigest,
    capturedAt: row.capturedAt,
    submittedAt: row.submittedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  return parsed.success
    ? { ok: true, value: parsed.data }
    : failed({ code: "invalid_persisted_data" });
}

export function digestProofValue(proofValue: string): string {
  return `sha256:${createHash("sha256").update(proofValue, "utf8").digest("hex")}`;
}

export class ObjectiveRepository {
  private readonly createId: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly db: Database,
    providers: ObjectiveRepositoryProviders = {},
  ) {
    this.createId = providers.createId ?? randomUUID;
    this.now = providers.now ?? (() => new Date());
  }

  private engagementStatus(
    engagementId: string,
  ): ObjectiveResult<"active" | "archived"> {
    try {
      const row = this.db
        .select({ status: engagements.status })
        .from(engagements)
        .where(eq(engagements.id, engagementId))
        .get();
      if (row === undefined) return failed({ code: "engagement_not_found" });
      return { ok: true, value: row.status };
    } catch (error) {
      return failed({ code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data" });
    }
  }

  private readObjective(engagementId: string, objectiveId: string): ObjectiveResult<ObjectiveRow> {
    try {
      const row = this.db
        .select()
        .from(objectives)
        .where(eq(objectives.id, objectiveId))
        .get();
      if (row === undefined || row.engagementId !== engagementId) {
        return failed({ code: "objective_not_found" });
      }
      return { ok: true, value: row };
    } catch (error) {
      return failed({ code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data" });
    }
  }

  createObjective(engagementId: string, input: unknown): ObjectiveResult<Objective> {
    const parsed = CreateObjectiveRequestSchema.safeParse(input);
    if (!parsed.success) return failed({ code: "invalid_repository_input" });
    const status = this.engagementStatus(engagementId);
    if (!status.ok) return status;
    if (status.value === "archived") return failed({ code: "engagement_archived" });
    const timestamp = this.now().toISOString();
    const row = {
      id: this.createId(),
      contractVersion: OBJECTIVE_CONTRACT_VERSION,
      engagementId,
      name: parsed.data.name,
      kind: parsed.data.kind,
      state: "open" as const,
      proofHint: null,
      proofDigest: null,
      capturedAt: null,
      submittedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    try {
      this.db.insert(objectives).values(row).run();
    } catch (error) {
      return failed({ code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data" });
    }
    const stored = this.db.select().from(objectives).where(eq(objectives.id, row.id)).get();
    if (stored === undefined) return failed({ code: "invalid_persisted_data" });
    return objectiveFromRow(stored);
  }

  listObjectives(engagementId: string): ObjectiveResult<Objective[]> {
    const status = this.engagementStatus(engagementId);
    if (!status.ok) return status;
    try {
      const rows = this.db
        .select()
        .from(objectives)
        .where(eq(objectives.engagementId, engagementId))
        .orderBy(asc(objectives.createdAt), asc(objectives.id))
        .all();
      const values: Objective[] = [];
      for (const row of rows) {
        const parsed = objectiveFromRow(row);
        if (!parsed.ok) return parsed;
        values.push(parsed.value);
      }
      return { ok: true, value: values };
    } catch (error) {
      return failed({ code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data" });
    }
  }

  getObjective(engagementId: string, objectiveId: string): ObjectiveResult<Objective> {
    const status = this.engagementStatus(engagementId);
    if (!status.ok) return status;
    const row = this.readObjective(engagementId, objectiveId);
    if (!row.ok) return row;
    return objectiveFromRow(row.value);
  }

  // Capture stores only the digest plus a short masked hint. The raw proof
  // value never reaches the database layer return value or the row.
  captureObjective(
    engagementId: string,
    objectiveId: string,
    input: unknown,
  ): ObjectiveResult<Objective> {
    const parsed = CaptureObjectiveRequestSchema.safeParse(input);
    if (!parsed.success) return failed({ code: "invalid_repository_input" });
    const status = this.engagementStatus(engagementId);
    if (!status.ok) return status;
    if (status.value === "archived") return failed({ code: "engagement_archived" });
    const row = this.readObjective(engagementId, objectiveId);
    if (!row.ok) return row;
    if (row.value.state !== "open") {
      return failed({ code: "invalid_objective_transition" });
    }
    const timestamp = this.now().toISOString();
    try {
      this.db
        .update(objectives)
        .set({
          state: "captured",
          proofHint: proofHintForValue(parsed.data.proofValue),
          proofDigest: digestProofValue(parsed.data.proofValue),
          capturedAt: timestamp,
          updatedAt: timestamp,
        })
        .where(eq(objectives.id, objectiveId))
        .run();
      const stored = this.db
        .select()
        .from(objectives)
        .where(eq(objectives.id, objectiveId))
        .get();
      if (stored === undefined) return failed({ code: "invalid_persisted_data" });
      return objectiveFromRow(stored);
    } catch (error) {
      return failed({ code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data" });
    }
  }

  // Submission is user-recorded: only a captured objective can be submitted,
  // and the call itself is the record. Nothing is inferred or scored.
  submitObjective(engagementId: string, objectiveId: string): ObjectiveResult<Objective> {
    const status = this.engagementStatus(engagementId);
    if (!status.ok) return status;
    if (status.value === "archived") return failed({ code: "engagement_archived" });
    const row = this.readObjective(engagementId, objectiveId);
    if (!row.ok) return row;
    if (row.value.state !== "captured") {
      return failed({ code: "invalid_objective_transition" });
    }
    const timestamp = this.now().toISOString();
    try {
      this.db
        .update(objectives)
        .set({ state: "submitted", submittedAt: timestamp, updatedAt: timestamp })
        .where(eq(objectives.id, objectiveId))
        .run();
      const stored = this.db
        .select()
        .from(objectives)
        .where(eq(objectives.id, objectiveId))
        .get();
      if (stored === undefined) return failed({ code: "invalid_persisted_data" });
      return objectiveFromRow(stored);
    } catch (error) {
      return failed({ code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data" });
    }
  }

  reopenObjective(engagementId: string, objectiveId: string): ObjectiveResult<Objective> {
    const status = this.engagementStatus(engagementId);
    if (!status.ok) return status;
    if (status.value === "archived") return failed({ code: "engagement_archived" });
    const row = this.readObjective(engagementId, objectiveId);
    if (!row.ok) return row;
    if (row.value.state === "open") {
      return failed({ code: "invalid_objective_transition" });
    }
    try {
      this.db
        .update(objectives)
        .set({
          state: "open",
          proofHint: null,
          proofDigest: null,
          capturedAt: null,
          submittedAt: null,
          updatedAt: this.now().toISOString(),
        })
        .where(eq(objectives.id, objectiveId))
        .run();
      const stored = this.db
        .select()
        .from(objectives)
        .where(eq(objectives.id, objectiveId))
        .get();
      if (stored === undefined) return failed({ code: "invalid_persisted_data" });
      return objectiveFromRow(stored);
    } catch (error) {
      return failed({ code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data" });
    }
  }
}
