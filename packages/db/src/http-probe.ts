import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import {
  EngagementHttpProbesResponseSchema,
  EvidenceArtifactRecordSchema,
  HTTP_PROBE_ARTIFACT_SLOT,
  HTTP_PROBE_MAX_RAW_BYTES,
  HTTP_PROBE_PARSER_VERSION,
  HttpProbeHopSchema,
} from "@stonehush/contracts";
import { parseProbeRawBytes } from "@stonehush/domain";
import * as schema from "./schema.js";
import { actions, engagements, evidenceArtifacts, httpProbeResults, runs } from "./schema.js";

type Database = BetterSQLite3Database<typeof schema>;

type ProbeArtifactRow = {
  artifactId: string;
  artifactSlot: string;
  kind: string;
  sizeBytes: number;
  digest: string;
  completeness: string;
  createdAt: string;
};

type GetArtifactResult =
  | { ok: true; row: ProbeArtifactRow | undefined }
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
  rawBytes: Uint8Array;
};

export class HttpProbeRepository {
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
    if (input.rawBytes.length > HTTP_PROBE_MAX_RAW_BYTES) {
      return { ok: false, code: "invalid_persisted_data" };
    }

    const parsed = parseProbeRawBytes(input.rawBytes);
    if (!parsed.ok) {
      return { ok: false, code: "invalid_persisted_data" };
    }
    if (parsed.raw.parserVersion !== HTTP_PROBE_PARSER_VERSION) {
      return { ok: false, code: "invalid_persisted_data" };
    }

    try {
      this.db.transaction(
        (tx) => {
          tx.insert(httpProbeResults)
            .values({
              artifactId: input.artifactId,
              parserVersion: HTTP_PROBE_PARSER_VERSION,
              url: parsed.raw.url,
              finalUrl: parsed.raw.finalUrl,
              status: parsed.raw.status,
              title: parsed.raw.title,
              contentType: parsed.raw.selectedHeaders.contentType,
              server: parsed.raw.selectedHeaders.server,
              poweredBy: parsed.raw.selectedHeaders.poweredBy,
              hopsJson: JSON.stringify(parsed.raw.hops),
              probeError: parsed.raw.error,
              observedAt: input.observedAt,
            })
            .onConflictDoNothing()
            .run();
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
          url: httpProbeResults.url,
          finalUrl: httpProbeResults.finalUrl,
          status: httpProbeResults.status,
          title: httpProbeResults.title,
          contentType: httpProbeResults.contentType,
          server: httpProbeResults.server,
          poweredBy: httpProbeResults.poweredBy,
          hopsJson: httpProbeResults.hopsJson,
          error: httpProbeResults.probeError,
          parserVersion: httpProbeResults.parserVersion,
          artifactId: httpProbeResults.artifactId,
          observedAt: httpProbeResults.observedAt,
          runId: evidenceArtifacts.runId,
          artifactDigest: evidenceArtifacts.digest,
        })
        .from(httpProbeResults)
        .innerJoin(evidenceArtifacts, eq(evidenceArtifacts.artifactId, httpProbeResults.artifactId))
        .innerJoin(runs, eq(runs.id, evidenceArtifacts.runId))
        .innerJoin(actions, eq(actions.id, runs.actionId))
        .where(and(eq(actions.engagementId, engagementId), eq(runs.engagementId, engagementId)))
        .all();

      const withSource = [];
      for (const row of rows) {
        const hops = HttpProbeHopSchema.array().safeParse(JSON.parse(row.hopsJson));
        if (!hops.success) {
          return { ok: false, code: "invalid_persisted_data" };
        }
        withSource.push({
          source: "http-probe" as const,
          parserVersion: row.parserVersion,
          url: row.url,
          fetchedAt: row.observedAt,
          finalUrl: row.finalUrl,
          status: row.status,
          title: row.title,
          selectedHeaders: {
            contentType: row.contentType,
            server: row.server,
            poweredBy: row.poweredBy,
          },
          hops: hops.data,
          error: row.error,
          runId: row.runId,
          artifactId: row.artifactId,
          artifactDigest: row.artifactDigest,
          observedAt: row.observedAt,
        });
      }

      const validated = EngagementHttpProbesResponseSchema.safeParse(withSource);
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

export { HTTP_PROBE_ARTIFACT_SLOT };
