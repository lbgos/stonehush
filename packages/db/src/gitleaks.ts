import { desc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import {
  GITLEAKS_MAX_FINDINGS,
  GitleaksMatchSchema,
  GitleaksScanResponseSchema,
  type GitleaksMatch,
} from "@stonehush/contracts";
import * as schema from "./schema.js";
import { engagements, gitleaksMatches, gitleaksScans } from "./schema.js";

type Database = BetterSQLite3Database<typeof schema>;

export interface GitleaksRepositoryProviders {
  createId?: () => string;
  now?: () => Date;
}

export type CreateGitleaksScanResult =
  | { ok: true; value: { scanId: string; engagementId: string; scannedAt: string; matchCount: number; truncated: boolean; matches: GitleaksMatch[] } }
  | { ok: false; code: "engagement_not_found" | "engagement_archived" | "storage_busy" | "invalid_persisted_data" };

export type LatestGitleaksScanResult =
  | { ok: true; value: { scanId: string; engagementId: string; scannedAt: string; matchCount: number; truncated: boolean; matches: GitleaksMatch[] } | null }
  | { ok: false; code: "engagement_not_found" | "storage_busy" | "invalid_persisted_data" };

function storageCode(error: unknown): "storage_busy" | "invalid_persisted_data" {
  const code = (error as { code?: string })?.code;
  if (code === "SQLITE_BUSY" || code === "SQLITE_BUSY_TIMEOUT") return "storage_busy";
  return "invalid_persisted_data";
}

/**
 * Gitleaks scan store. Rows carry rule id, file, line, and fingerprint
 * only: the table has no secret value column, so persistence cannot leak
 * what the parser already dropped. Each scan is one immutable batch; a
 * rescan inserts a new batch and readers serve the latest.
 */
export class GitleaksRepository {
  constructor(
    private readonly db: Database,
    private readonly providers: GitleaksRepositoryProviders = {},
  ) {}

  private createId(): string {
    return this.providers.createId?.() ?? crypto.randomUUID();
  }

  private now(): Date {
    return this.providers.now?.() ?? new Date();
  }

  createScan(
    engagementId: string,
    input: { matches: GitleaksMatch[]; truncated: boolean },
  ): CreateGitleaksScanResult {
    // Dedupe on the row identity before counting: the primary key drops
    // exact duplicates on insert, so the count must describe kept rows.
    const seen = new Set<string>();
    const matches: GitleaksMatch[] = [];
    for (const match of input.matches) {
      if (!GitleaksMatchSchema.safeParse(match).success) {
        return { ok: false, code: "invalid_persisted_data" };
      }
      const identity = `${match.ruleId}\0${match.file}\0${match.line}\0${match.fingerprint}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      matches.push(match);
    }
    if (matches.length > GITLEAKS_MAX_FINDINGS) {
      return { ok: false, code: "invalid_persisted_data" };
    }
    try {
      const scanId = this.createId();
      const scannedAt = this.now().toISOString();
      // The engagement read lives inside the write transaction: the route
      // checks archived status before the scan runs, but an archive can
      // land while the detector works. The write stays authoritative.
      const outcome = this.db.transaction(
        (tx) => {
          const engagement = tx
            .select({ id: engagements.id, status: engagements.status })
            .from(engagements)
            .where(eq(engagements.id, engagementId))
            .get();
          if (engagement === undefined) return { ok: false as const, code: "engagement_not_found" as const };
          if (engagement.status === "archived") return { ok: false as const, code: "engagement_archived" as const };
          tx.insert(gitleaksScans)
            .values({
              scanId,
              engagementId,
              matchCount: matches.length,
              truncated: input.truncated,
              createdAt: scannedAt,
            })
            .run();
          for (const match of matches) {
            tx.insert(gitleaksMatches)
              .values({
                scanId,
                ruleId: match.ruleId,
                file: match.file,
                line: match.line,
                fingerprint: match.fingerprint,
              })
              .onConflictDoNothing()
              .run();
          }
          return { ok: true as const };
        },
        { behavior: "immediate" },
      );
      if (!outcome.ok) return outcome;
      const stored = this.readScan(scanId);
      if (stored === undefined) return { ok: false, code: "invalid_persisted_data" };
      return { ok: true, value: stored };
    } catch (error) {
      return { ok: false, code: storageCode(error) };
    }
  }

  latestForEngagement(engagementId: string): LatestGitleaksScanResult {
    try {
      const engagement = this.db
        .select({ id: engagements.id })
        .from(engagements)
        .where(eq(engagements.id, engagementId))
        .get();
      if (engagement === undefined) {
        return { ok: false, code: "engagement_not_found" };
      }
      const latest = this.db
        .select({ scanId: gitleaksScans.scanId })
        .from(gitleaksScans)
        .where(eq(gitleaksScans.engagementId, engagementId))
        .orderBy(desc(gitleaksScans.createdAt), desc(gitleaksScans.scanId))
        .get();
      if (latest === undefined) return { ok: true, value: null };
      const stored = this.readScan(latest.scanId);
      if (stored === undefined) return { ok: false, code: "invalid_persisted_data" };
      return { ok: true, value: stored };
    } catch (error) {
      return { ok: false, code: storageCode(error) };
    }
  }

  private readScan(
    scanId: string,
  ): { scanId: string; engagementId: string; scannedAt: string; matchCount: number; truncated: boolean; matches: GitleaksMatch[] } | undefined {
    const scan = this.db
      .select()
      .from(gitleaksScans)
      .where(eq(gitleaksScans.scanId, scanId))
      .get();
    if (scan === undefined) return undefined;
    const rows = this.db
      .select({
        ruleId: gitleaksMatches.ruleId,
        file: gitleaksMatches.file,
        line: gitleaksMatches.line,
        fingerprint: gitleaksMatches.fingerprint,
      })
      .from(gitleaksMatches)
      .where(eq(gitleaksMatches.scanId, scanId))
      .orderBy(gitleaksMatches.file, gitleaksMatches.line, gitleaksMatches.ruleId)
      .all();
    const candidate = {
      scanId: scan.scanId,
      engagementId: scan.engagementId,
      scannedAt: scan.createdAt,
      matchCount: scan.matchCount,
      truncated: scan.truncated,
      matches: rows,
    };
    const validated = GitleaksScanResponseSchema.safeParse(candidate);
    if (!validated.success) return undefined;
    return validated.data;
  }
}
