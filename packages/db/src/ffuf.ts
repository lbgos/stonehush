import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import {
  EngagementFfufResultsResponseSchema,
  EvidenceArtifactRecordSchema,
  FFUF_MAX_JSON_BYTES,
  FFUF_PARSER_VERSION,
} from "@stonehush/contracts";
import { parseFfufArtifactJson } from "@stonehush/domain";
import * as schema from "./schema.js";
import { actions, engagements, evidenceArtifacts, ffufResults, runs } from "./schema.js";

type Database = BetterSQLite3Database<typeof schema>;

type FfufArtifactRow = {
  artifactId: string;
  artifactSlot: string;
  kind: string;
  sizeBytes: number;
  digest: string;
  completeness: string;
  createdAt: string;
};

type GetArtifactResult =
  | { ok: true; row: FfufArtifactRow | undefined }
  | { ok: false; code: "storage_busy" | "invalid_persisted_data" };

type ProjectResult =
  | { ok: true }
  | { ok: false; code: "storage_busy" | "invalid_persisted_data" };

type ListForEngagementResult =
  | { ok: true; value: unknown[] }
  | { ok: false; code: "engagement_not_found" | "storage_busy" | "invalid_persisted_data" };

type ProjectInput = {
  artifactId: string;
  observedAt: string;
  jsonBytes: Uint8Array;
};

export class FfufRepository {
  constructor(private readonly db: Database) {}

  getArtifact(artifactId: string): GetArtifactResult {
    try {
      const persistedRow = this.db
        .select()
        .from(evidenceArtifacts)
        .where(eq(evidenceArtifacts.artifactId, artifactId))
        .get();

      if (persistedRow === undefined) {
        return { ok: true, row: undefined };
      }

      const candidate = {
        contractVersion: persistedRow.contractVersion,
        profile: persistedRow.profile,
        artifactId: persistedRow.artifactId,
        runId: persistedRow.runId,
        fence: persistedRow.fence,
        eventSequence: persistedRow.eventSequence,
        artifactSlot: persistedRow.artifactSlot,
        kind: persistedRow.kind,
        sizeBytes: persistedRow.sizeBytes,
        digest: persistedRow.digest,
        relativePath: persistedRow.relativePath,
        completeness: persistedRow.completeness,
        redaction: {
          applied: Boolean(persistedRow.redactionApplied),
          boundary: persistedRow.redactionBoundary,
          rawBytesPreserved: Boolean(persistedRow.rawBytesPreserved),
        },
        createdAt: persistedRow.createdAt,
      };

      const validated = EvidenceArtifactRecordSchema.safeParse(candidate);
      if (!validated.success) {
        return { ok: false, code: "invalid_persisted_data" };
      }

      const record = validated.data;

      return {
        ok: true,
        row: {
          artifactId: record.artifactId,
          artifactSlot: record.artifactSlot,
          kind: record.kind,
          sizeBytes: record.sizeBytes,
          digest: record.digest,
          completeness: record.completeness,
          createdAt: record.createdAt,
        },
      };
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === "SQLITE_BUSY" || code === "SQLITE_BUSY_TIMEOUT") {
        return { ok: false, code: "storage_busy" };
      }
      return { ok: false, code: "invalid_persisted_data" };
    }
  }

  project(input: ProjectInput): ProjectResult {
    if (input.jsonBytes.length > FFUF_MAX_JSON_BYTES) {
      return { ok: false, code: "invalid_persisted_data" };
    }

    const parsed = parseFfufArtifactJson(input.jsonBytes);
    if (!parsed.ok) {
      return { ok: false, code: "invalid_persisted_data" };
    }

    try {
      this.db.transaction(
        (tx) => {
          for (const result of parsed.output.results) {
            tx.insert(ffufResults)
              .values({
                artifactId: input.artifactId,
                parserVersion: FFUF_PARSER_VERSION,
                url: result.url,
                status: result.status,
                length: result.length,
                words: result.words,
                lines: result.lines,
                redirectlocation: result.redirectlocation ?? null,
                fuzz: result.input.FUZZ,
                observedAt: input.observedAt,
              })
              .onConflictDoNothing()
              .run();
          }
        },
        { behavior: "immediate" },
      );

      return { ok: true };
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === "SQLITE_BUSY" || code === "SQLITE_BUSY_TIMEOUT") {
        return { ok: false, code: "storage_busy" };
      }
      return { ok: false, code: "invalid_persisted_data" };
    }
  }

  listForEngagement(engagementId: string): ListForEngagementResult {
    try {
      const engagement = this.db
        .select()
        .from(engagements)
        .where(eq(engagements.id, engagementId))
        .get();

      if (engagement === undefined) {
        return { ok: false, code: "engagement_not_found" };
      }

      const rows = this.db
        .select({
          url: ffufResults.url,
          status: ffufResults.status,
          length: ffufResults.length,
          words: ffufResults.words,
          lines: ffufResults.lines,
          redirectlocation: ffufResults.redirectlocation,
          fuzz: ffufResults.fuzz,
          parserVersion: ffufResults.parserVersion,
          artifactId: ffufResults.artifactId,
          observedAt: ffufResults.observedAt,
          runId: evidenceArtifacts.runId,
          artifactDigest: evidenceArtifacts.digest,
        })
        .from(ffufResults)
        .innerJoin(evidenceArtifacts, eq(evidenceArtifacts.artifactId, ffufResults.artifactId))
        .innerJoin(runs, eq(runs.id, evidenceArtifacts.runId))
        .innerJoin(actions, eq(actions.id, runs.actionId))
        .where(and(eq(actions.engagementId, engagementId), eq(runs.engagementId, engagementId)))
        .all();

      const withSource = rows.map((row) => ({ source: "ffuf" as const, ...row }));

      const validated = EngagementFfufResultsResponseSchema.safeParse(withSource);
      if (!validated.success) {
        return { ok: false, code: "invalid_persisted_data" };
      }

      return { ok: true, value: validated.data };
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === "SQLITE_BUSY" || code === "SQLITE_BUSY_TIMEOUT") {
        return { ok: false, code: "storage_busy" };
      }
      return { ok: false, code: "invalid_persisted_data" };
    }
  }
}
