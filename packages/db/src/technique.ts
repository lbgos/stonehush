import { randomUUID } from "node:crypto";

import { asc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import {
  CreateTechniqueRequestSchema,
  TECHNIQUE_CONTRACT_VERSION,
  TechniqueSchema,
  type Technique,
} from "@blackglass/contracts";

import * as schema from "./schema.js";
import { engagements, techniques } from "./schema.js";

type Database = BetterSQLite3Database<typeof schema>;

// Saved technique storage (STONE-7). One reusable operator procedure per
// row, engagement-scoped. Creates refuse archived engagements; reads stay
// available on archived engagements so saved material keeps its provenance.
// Rows are validated against the technique contract on every read, so
// corrupt rows surface as invalid_persisted_data instead of leaking.

export type TechniqueRepositoryErrorCode =
  | "engagement_not_found"
  | "engagement_archived"
  | "technique_not_found"
  | "invalid_repository_input"
  | "storage_busy"
  | "invalid_persisted_data";

export type TechniqueRepositoryError = { code: TechniqueRepositoryErrorCode };

export type TechniqueResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: TechniqueRepositoryError };

export interface TechniqueRepositoryProviders {
  now?: () => Date;
  createId?: () => string;
}

function failed(code: TechniqueRepositoryErrorCode): TechniqueResult<never> {
  return { ok: false, error: { code } };
}

function storageError(error: unknown): TechniqueRepositoryError {
  const code = (error as { code?: string })?.code;
  if (code === "SQLITE_BUSY" || code === "SQLITE_BUSY_TIMEOUT") {
    return { code: "storage_busy" };
  }
  return { code: "invalid_persisted_data" };
}

function techniqueFromRow(row: typeof techniques.$inferSelect): TechniqueResult<Technique> {
  if (row.contractVersion !== TECHNIQUE_CONTRACT_VERSION) {
    return failed("invalid_persisted_data");
  }
  let prerequisites: unknown;
  let procedure: unknown;
  try {
    prerequisites = JSON.parse(row.prerequisitesJson);
    procedure = JSON.parse(row.procedureJson);
  } catch {
    return failed("invalid_persisted_data");
  }
  // Full contract validation on every read: names, questions, meanings,
  // timestamps, and array bounds rechecked, so corrupt rows surface as
  // invalid_persisted_data instead of leaking.
  const parsed = TechniqueSchema.safeParse({
    contractVersion: TECHNIQUE_CONTRACT_VERSION,
    id: row.id,
    engagementId: row.engagementId,
    name: row.name,
    whenUseful: row.whenUseful,
    prerequisites,
    question: row.question,
    procedure,
    meaning: row.meaning,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  if (!parsed.success) return failed("invalid_persisted_data");
  return { ok: true, value: parsed.data };
}

export class TechniqueRepository {
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(
    private readonly db: Database,
    providers: TechniqueRepositoryProviders = {},
  ) {
    this.now = providers.now ?? (() => new Date());
    this.createId = providers.createId ?? randomUUID;
  }

  createTechnique(engagementId: string, input: unknown): TechniqueResult<Technique> {
    const parsed = CreateTechniqueRequestSchema.safeParse(input);
    if (!parsed.success) return failed("invalid_repository_input");
    try {
      const engagement = this.db
        .select({ status: engagements.status })
        .from(engagements)
        .where(eq(engagements.id, engagementId))
        .get();
      if (engagement === undefined) return failed("engagement_not_found");
      if (engagement.status === "archived") return failed("engagement_archived");
      const timestamp = this.now().toISOString();
      const id = this.createId();
      this.db
        .insert(techniques)
        .values({
          id,
          contractVersion: TECHNIQUE_CONTRACT_VERSION,
          engagementId,
          name: parsed.data.name,
          whenUseful: parsed.data.whenUseful,
          prerequisitesJson: JSON.stringify(parsed.data.prerequisites),
          question: parsed.data.question,
          procedureJson: JSON.stringify(parsed.data.procedure),
          meaning: parsed.data.meaning,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
      const stored = this.db
        .select()
        .from(techniques)
        .where(eq(techniques.id, id))
        .get();
      if (stored === undefined) return failed("invalid_persisted_data");
      return techniqueFromRow(stored);
    } catch (error) {
      return failed(storageError(error).code);
    }
  }

  listTechniques(engagementId: string): TechniqueResult<Technique[]> {
    try {
      const engagement = this.db
        .select({ id: engagements.id })
        .from(engagements)
        .where(eq(engagements.id, engagementId))
        .get();
      if (engagement === undefined) return failed("engagement_not_found");
      const rows = this.db
        .select()
        .from(techniques)
        .where(eq(techniques.engagementId, engagementId))
        .orderBy(asc(techniques.createdAt), asc(techniques.id))
        .all();
      const values: Technique[] = [];
      for (const row of rows) {
        const parsed = techniqueFromRow(row);
        if (!parsed.ok) return parsed;
        values.push(parsed.value);
      }
      return { ok: true, value: values };
    } catch (error) {
      return failed(storageError(error).code);
    }
  }

  // Narrow scoped lookup: a missing row or a row owned by another
  // engagement is identically technique_not_found, so no existence oracle
  // exists. Available on archived engagements like other read paths.
  getTechniqueForEngagement(
    engagementId: string,
    techniqueId: string,
  ): TechniqueResult<Technique> {
    try {
      const engagement = this.db
        .select({ id: engagements.id })
        .from(engagements)
        .where(eq(engagements.id, engagementId))
        .get();
      if (engagement === undefined) return failed("engagement_not_found");
      const row = this.db
        .select()
        .from(techniques)
        .where(eq(techniques.id, techniqueId))
        .get();
      if (row === undefined || row.engagementId !== engagementId) {
        return failed("technique_not_found");
      }
      return techniqueFromRow(row);
    } catch (error) {
      return failed(storageError(error).code);
    }
  }
}
