import { NMAP_MAX_XML_BYTES } from "@stonehush/contracts";
import type { NmapServiceRepository } from "@stonehush/db";
import type { EvidenceStore } from "./evidence-store.js";

type ProjectionResult =
  | { ok: true; skipped?: boolean }
  | { ok: false; code: "storage_busy" | "invalid_persisted_data" };

export class NmapProjectionService {
  constructor(
    private readonly store: EvidenceStore,
    private readonly repo: NmapServiceRepository,
  ) {}

  async projectForArtifact(artifactId: string): Promise<ProjectionResult> {
    const lookup = this.repo.getArtifact(artifactId);
    if (!lookup.ok) {
      return { ok: false, code: lookup.code };
    }

    const row = lookup.row;
    if (row === undefined) {
      return { ok: false, code: "invalid_persisted_data" };
    }

    if (row.artifactSlot !== "nmap-xml" || row.kind !== "tool_raw") {
      return { ok: true, skipped: true };
    }

    if (row.completeness !== "complete") {
      return { ok: true, skipped: true };
    }

    if (row.sizeBytes > NMAP_MAX_XML_BYTES) {
      return { ok: false, code: "invalid_persisted_data" };
    }

    const download = await this.store.verifiedDownload({
      artifactId: row.artifactId,
      expectedSizeBytes: row.sizeBytes,
      expectedDigest: row.digest,
    });

    if (download.status !== "ready") {
      return { ok: false, code: "invalid_persisted_data" };
    }

    const chunks: Buffer[] = [];
    let total = 0;

    try {
      for await (const chunk of download.stream) {
        total += chunk.length;
        if (total > NMAP_MAX_XML_BYTES) {
          return { ok: false, code: "invalid_persisted_data" };
        }
        chunks.push(chunk);
      }
    } catch {
      return { ok: false, code: "invalid_persisted_data" };
    }

    const bytes = Buffer.concat(chunks, total);

    const result = this.repo.project({
      artifactId: row.artifactId,
      observedAt: row.createdAt,
      xmlBytes: bytes,
    });

    if (!result.ok) {
      return { ok: false, code: result.code };
    }

    return { ok: true };
  }
}
