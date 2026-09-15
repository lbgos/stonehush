import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import {
  EngagementServicesResponseSchema,
  EvidenceArtifactRecordSchema,
  NMAP_MAX_XML_BYTES,
  NMAP_PARSER_VERSION,
} from "@stonehush/contracts";
import { parseNmapXml } from "@stonehush/domain";
import * as schema from "./schema.js";
import { actions, engagements, evidenceArtifacts, nmapServices, runs } from "./schema.js";

type Database = BetterSQLite3Database<typeof schema>;

type NmapArtifactRow = {
  artifactId: string;
  artifactSlot: string;
  kind: string;
  sizeBytes: number;
  digest: string;
  completeness: string;
  createdAt: string;
};

type GetArtifactResult =
  | { ok: true; row: NmapArtifactRow | undefined }
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
  xmlBytes: Uint8Array;
};

export class NmapServiceRepository {
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
    if (input.xmlBytes.length > NMAP_MAX_XML_BYTES) {
      return { ok: false, code: "invalid_persisted_data" };
    }

    const parsed = parseNmapXml(input.xmlBytes);
    if (!parsed.ok) {
      return { ok: false, code: "invalid_persisted_data" };
    }

    if (parsed.services.length === 0) {
      return { ok: true };
    }

    try {
      this.db.transaction(
        (tx) => {
          for (const service of parsed.services) {
            tx.insert(nmapServices)
              .values({
                artifactId: input.artifactId,
                parserVersion: NMAP_PARSER_VERSION,
                address: service.address,
                port: service.port,
                protocol: service.protocol,
                hostname: service.hostname,
                serviceName: service.serviceName,
                product: service.product,
                version: service.version,
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
          address: nmapServices.address,
          port: nmapServices.port,
          protocol: nmapServices.protocol,
          hostname: nmapServices.hostname,
          serviceName: nmapServices.serviceName,
          product: nmapServices.product,
          version: nmapServices.version,
          parserVersion: nmapServices.parserVersion,
          artifactId: nmapServices.artifactId,
          observedAt: nmapServices.observedAt,
          runId: evidenceArtifacts.runId,
          artifactDigest: evidenceArtifacts.digest,
        })
        .from(nmapServices)
        .innerJoin(evidenceArtifacts, eq(evidenceArtifacts.artifactId, nmapServices.artifactId))
        .innerJoin(runs, eq(runs.id, evidenceArtifacts.runId))
        .innerJoin(actions, eq(actions.id, runs.actionId))
        .where(and(eq(actions.engagementId, engagementId), eq(runs.engagementId, engagementId)))
        .all();

      const withSource = rows.map((row) => ({ source: "nmap" as const, ...row }));

      const validated = EngagementServicesResponseSchema.safeParse(withSource);
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
