import { randomUUID } from "node:crypto";

import {
  CreateSecretRequestSchema,
  RecordSecretVerificationRequestSchema,
  SECRET_CONTRACT_VERSION,
  SecretSchema,
  type Secret,
} from "@blackglass/contracts";
import { asc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema.js";
import {
  engagements,
  secretVerifications,
  secrets,
  type SecretRow,
  type SecretVerificationRow,
} from "./schema.js";

type Database = BetterSQLite3Database<typeof schema>;

export interface SecretRepositoryProviders {
  createId?: () => string;
  now?: () => Date;
}

export type SecretRepositoryError =
  | { code: "engagement_not_found" }
  | { code: "engagement_archived" }
  | { code: "secret_not_found" }
  | { code: "invalid_repository_input" }
  | { code: "invalid_persisted_data" }
  | { code: "storage_busy" };

export type SecretResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: SecretRepositoryError };

function failed<T>(error: SecretRepositoryError): SecretResult<T> {
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

function secretFromRows(row: SecretRow, verifications: SecretVerificationRow[]): SecretResult<Secret> {
  const parsed = SecretSchema.safeParse({
    contractVersion: row.contractVersion,
    id: row.id,
    engagementId: row.engagementId,
    label: row.label,
    username: row.username,
    serviceRef: row.serviceRef,
    secretRef: row.secretRef,
    hint: row.hint,
    verifications: verifications.map((verification) => ({
      at: verification.createdAt,
      result: verification.result,
      method: verification.method,
      note: verification.note,
    })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  return parsed.success
    ? { ok: true, value: parsed.data }
    : failed({ code: "invalid_persisted_data" });
}

export class SecretRepository {
  private readonly createId: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly db: Database,
    providers: SecretRepositoryProviders = {},
  ) {
    this.createId = providers.createId ?? randomUUID;
    this.now = providers.now ?? (() => new Date());
  }

  private engagementStatus(
    engagementId: string,
  ): SecretResult<"active" | "archived"> {
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

  private readSecretRow(engagementId: string, secretId: string): SecretResult<SecretRow> {
    try {
      const row = this.db.select().from(secrets).where(eq(secrets.id, secretId)).get();
      if (row === undefined || row.engagementId !== engagementId) {
        return failed({ code: "secret_not_found" });
      }
      return { ok: true, value: row };
    } catch (error) {
      return failed({ code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data" });
    }
  }

  private verificationsFor(secretId: string): SecretResult<SecretVerificationRow[]> {
    try {
      const rows = this.db
        .select()
        .from(secretVerifications)
        .where(eq(secretVerifications.secretId, secretId))
        .orderBy(asc(secretVerifications.createdAt), asc(secretVerifications.id))
        .all();
      return { ok: true, value: rows };
    } catch (error) {
      return failed({ code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data" });
    }
  }

  createSecret(engagementId: string, input: unknown): SecretResult<Secret> {
    const parsed = CreateSecretRequestSchema.safeParse(input);
    if (!parsed.success) return failed({ code: "invalid_repository_input" });
    const status = this.engagementStatus(engagementId);
    if (!status.ok) return status;
    if (status.value === "archived") return failed({ code: "engagement_archived" });
    const timestamp = this.now().toISOString();
    const row = {
      id: this.createId(),
      contractVersion: SECRET_CONTRACT_VERSION,
      engagementId,
      label: parsed.data.label,
      username: parsed.data.username ?? null,
      serviceRef: parsed.data.serviceRef,
      secretRef: parsed.data.secretRef,
      hint: parsed.data.hint ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    try {
      this.db.insert(secrets).values(row).run();
    } catch (error) {
      return failed({ code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data" });
    }
    const stored = this.db.select().from(secrets).where(eq(secrets.id, row.id)).get();
    if (stored === undefined) return failed({ code: "invalid_persisted_data" });
    return secretFromRows(stored, []);
  }

  listSecrets(engagementId: string): SecretResult<Secret[]> {
    const status = this.engagementStatus(engagementId);
    if (!status.ok) return status;
    try {
      const rows = this.db
        .select()
        .from(secrets)
        .where(eq(secrets.engagementId, engagementId))
        .orderBy(asc(secrets.createdAt), asc(secrets.id))
        .all();
      const values: Secret[] = [];
      for (const row of rows) {
        const verifications = this.verificationsFor(row.id);
        if (!verifications.ok) return verifications;
        const parsed = secretFromRows(row, verifications.value);
        if (!parsed.ok) return parsed;
        values.push(parsed.value);
      }
      return { ok: true, value: values };
    } catch (error) {
      return failed({ code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data" });
    }
  }

  getSecret(engagementId: string, secretId: string): SecretResult<Secret> {
    const status = this.engagementStatus(engagementId);
    if (!status.ok) return status;
    const row = this.readSecretRow(engagementId, secretId);
    if (!row.ok) return row;
    const verifications = this.verificationsFor(secretId);
    if (!verifications.ok) return verifications;
    return secretFromRows(row.value, verifications.value);
  }

  // Verification records an outcome for this service only. Nothing here marks
  // any other service tested; service scoping is structural, one row per
  // service-scoped secret.
  recordVerification(
    engagementId: string,
    secretId: string,
    input: unknown,
  ): SecretResult<Secret> {
    const parsed = RecordSecretVerificationRequestSchema.safeParse(input);
    if (!parsed.success) return failed({ code: "invalid_repository_input" });
    const status = this.engagementStatus(engagementId);
    if (!status.ok) return status;
    if (status.value === "archived") return failed({ code: "engagement_archived" });
    const row = this.readSecretRow(engagementId, secretId);
    if (!row.ok) return row;
    const timestamp = this.now().toISOString();
    try {
      this.db
        .insert(secretVerifications)
        .values({
          id: this.createId(),
          contractVersion: SECRET_CONTRACT_VERSION,
          engagementId,
          secretId,
          result: parsed.data.result,
          method: parsed.data.method,
          note: parsed.data.note ?? null,
          createdAt: timestamp,
        })
        .run();
      this.db
        .update(secrets)
        .set({ updatedAt: timestamp })
        .where(eq(secrets.id, secretId))
        .run();
    } catch (error) {
      return failed({ code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data" });
    }
    return this.getSecret(engagementId, secretId);
  }
}
