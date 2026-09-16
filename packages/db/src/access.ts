import { randomUUID } from "node:crypto";

import {
  ACCESS_CONTRACT_VERSION,
  AccessRecordSchema,
  CreateAccessRequestSchema,
  type AccessRecord,
} from "@stonehush/contracts";
import { asc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema.js";
import {
  accessRecords,
  engagements,
  leads,
  secrets,
  stoneTargets,
  type AccessRecordRow,
} from "./schema.js";

type Database = BetterSQLite3Database<typeof schema>;

export interface AccessRepositoryProviders {
  createId?: () => string;
  now?: () => Date;
}

export type AccessRepositoryError =
  | { code: "engagement_not_found" }
  | { code: "engagement_archived" }
  | { code: "access_not_found" }
  | { code: "target_not_found" }
  | { code: "lead_not_found" }
  | { code: "secret_not_found" }
  | { code: "invalid_repository_input" }
  | { code: "invalid_persisted_data" }
  | { code: "storage_busy" };

export type AccessResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AccessRepositoryError };

function failed<T>(error: AccessRepositoryError): AccessResult<T> {
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

function accessFromRow(row: AccessRecordRow): AccessResult<AccessRecord> {
  const parsed = AccessRecordSchema.safeParse({
    contractVersion: row.contractVersion,
    id: row.id,
    engagementId: row.engagementId,
    targetId: row.targetId,
    account: row.account,
    accessType: row.accessType,
    sourceLeadId: row.sourceLeadId,
    secretId: row.secretId,
    context: row.context,
    lastConfirmedAt: row.lastConfirmedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  return parsed.success
    ? { ok: true, value: parsed.data }
    : failed({ code: "invalid_persisted_data" });
}

export class AccessRepository {
  private readonly createId: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly db: Database,
    providers: AccessRepositoryProviders = {},
  ) {
    this.createId = providers.createId ?? randomUUID;
    this.now = providers.now ?? (() => new Date());
  }

  private engagementStatus(
    engagementId: string,
  ): AccessResult<"active" | "archived"> {
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

  // Cross-slice references stay existence-checked and engagement-scoped:
  // target, source lead, and optional secret must belong to this engagement.
  // Secrets pass by id only; no value is ever read or stored here.
  private checkReferences(
    engagementId: string,
    input: { targetId: string; sourceLeadId: string; secretId?: string | undefined },
  ): AccessResult<null> {
    try {
      const target = this.db
        .select({ engagementId: stoneTargets.engagementId })
        .from(stoneTargets)
        .where(eq(stoneTargets.id, input.targetId))
        .get();
      if (target === undefined || target.engagementId !== engagementId) {
        return failed({ code: "target_not_found" });
      }
      const lead = this.db
        .select({ engagementId: leads.engagementId })
        .from(leads)
        .where(eq(leads.id, input.sourceLeadId))
        .get();
      if (lead === undefined || lead.engagementId !== engagementId) {
        return failed({ code: "lead_not_found" });
      }
      if (input.secretId !== undefined) {
        const secret = this.db
          .select({ engagementId: secrets.engagementId })
          .from(secrets)
          .where(eq(secrets.id, input.secretId))
          .get();
        if (secret === undefined || secret.engagementId !== engagementId) {
          return failed({ code: "secret_not_found" });
        }
      }
      return { ok: true, value: null };
    } catch (error) {
      return failed({ code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data" });
    }
  }

  createAccess(engagementId: string, input: unknown): AccessResult<AccessRecord> {
    const parsed = CreateAccessRequestSchema.safeParse(input);
    if (!parsed.success) return failed({ code: "invalid_repository_input" });
    const status = this.engagementStatus(engagementId);
    if (!status.ok) return status;
    if (status.value === "archived") return failed({ code: "engagement_archived" });
    const references = this.checkReferences(engagementId, parsed.data);
    if (!references.ok) return references;
    // Recording access confirms it now: lastConfirmedAt starts at creation
    // and only moves forward through an explicit refresh.
    const timestamp = this.now().toISOString();
    const row = {
      id: this.createId(),
      contractVersion: ACCESS_CONTRACT_VERSION,
      engagementId,
      targetId: parsed.data.targetId,
      account: parsed.data.account,
      accessType: parsed.data.accessType,
      sourceLeadId: parsed.data.sourceLeadId,
      secretId: parsed.data.secretId ?? null,
      context: parsed.data.context ?? null,
      lastConfirmedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    try {
      this.db.insert(accessRecords).values(row).run();
    } catch (error) {
      return failed({ code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data" });
    }
    const stored = this.db.select().from(accessRecords).where(eq(accessRecords.id, row.id)).get();
    if (stored === undefined) return failed({ code: "invalid_persisted_data" });
    return accessFromRow(stored);
  }

  listAccess(engagementId: string): AccessResult<AccessRecord[]> {
    const status = this.engagementStatus(engagementId);
    if (!status.ok) return status;
    try {
      const rows = this.db
        .select()
        .from(accessRecords)
        .where(eq(accessRecords.engagementId, engagementId))
        .orderBy(asc(accessRecords.createdAt), asc(accessRecords.id))
        .all();
      const values: AccessRecord[] = [];
      for (const row of rows) {
        const parsed = accessFromRow(row);
        if (!parsed.ok) return parsed;
        values.push(parsed.value);
      }
      return { ok: true, value: values };
    } catch (error) {
      return failed({ code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data" });
    }
  }

  getAccess(engagementId: string, accessId: string): AccessResult<AccessRecord> {
    const status = this.engagementStatus(engagementId);
    if (!status.ok) return status;
    try {
      const row = this.db.select().from(accessRecords).where(eq(accessRecords.id, accessId)).get();
      if (row === undefined || row.engagementId !== engagementId) {
        return failed({ code: "access_not_found" });
      }
      return accessFromRow(row);
    } catch (error) {
      return failed({ code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data" });
    }
  }

  // Last-confirmed refresh: the operator re-confirms a recorded access. The
  // timestamp only moves forward; recording is not proof of a live shell.
  refreshAccess(engagementId: string, accessId: string): AccessResult<AccessRecord> {
    const status = this.engagementStatus(engagementId);
    if (!status.ok) return status;
    if (status.value === "archived") return failed({ code: "engagement_archived" });
    const current = this.getAccess(engagementId, accessId);
    if (!current.ok) return current;
    const timestamp = this.now().toISOString();
    if (timestamp < current.value.lastConfirmedAt) {
      return failed({ code: "invalid_repository_input" });
    }
    try {
      this.db
        .update(accessRecords)
        .set({ lastConfirmedAt: timestamp, updatedAt: timestamp })
        .where(eq(accessRecords.id, accessId))
        .run();
      const stored = this.db.select().from(accessRecords).where(eq(accessRecords.id, accessId)).get();
      if (stored === undefined) return failed({ code: "invalid_persisted_data" });
      return accessFromRow(stored);
    } catch (error) {
      return failed({ code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data" });
    }
  }
}
