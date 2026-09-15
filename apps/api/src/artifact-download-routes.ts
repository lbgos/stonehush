import { Readable } from "node:stream";

import {
  ArtifactContentParamsSchema,
  ArtifactDownloadErrorSchema,
  type ArtifactDownloadError,
} from "@stonehush/contracts";
import type { EvidenceGrantRepository } from "@stonehush/db";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { EvidenceStore } from "./evidence/evidence-store.js";

export interface ArtifactDownloadDependencies {
  readonly repository: Pick<
    EvidenceGrantRepository,
    "publishedArtifactForEngagement"
  >;
  readonly store: Pick<EvidenceStore, "verifiedDownload">;
}

// Advisory display names must be plain identifier-like strings; anything
// else (dots, separators, traversal, overlong) falls back to a name derived
// from the control-plane artifact id.
const SAFE_FILE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function sendDownloadError(
  reply: FastifyReply,
  status: 400 | 404 | 409,
  code: ArtifactDownloadError["code"],
) {
  return reply
    .code(status)
    .type("application/json")
    .send(ArtifactDownloadErrorSchema.parse({ code }));
}

function displayNameFor(
  artifact: { originalFileName: string | null },
  artifactId: string,
): string {
  const original = artifact.originalFileName;
  return original !== null && SAFE_FILE_NAME_PATTERN.test(original)
    ? original
    : `artifact-${artifactId}-bin`;
}

export function registerArtifactDownloadRoutes(
  app: FastifyInstance,
  dependencies: ArtifactDownloadDependencies,
): void {
  const { repository, store } = dependencies;

  app.get(
    "/api/v1/engagements/:engagementId/artifacts/:artifactId/content",
    // HEAD is not an operator download surface: disabling automatic exposure
    // keeps artifact verification from running for HEAD probes.
    { exposeHeadRoute: false },
    async (request, reply) => {
      // Range is rejected before any lookup or byte access.
      if (request.headers.range !== undefined) {
        return sendDownloadError(reply, 400, "range_not_supported");
      }
      const params = ArtifactContentParamsSchema.safeParse(request.params);
      if (!params.success) {
        return sendDownloadError(reply, 400, "invalid_request");
      }

      // Membership through run -> action -> engagement. Unknown artifact and
      // engagement mismatch are the same 404 so existence cannot be probed.
      const artifact = repository.publishedArtifactForEngagement({
        engagementId: params.data.engagementId,
        artifactId: params.data.artifactId,
      });
      if (artifact === undefined) {
        return sendDownloadError(reply, 404, "artifact_not_found");
      }

      const download = await store.verifiedDownload({
        artifactId: params.data.artifactId,
        expectedSizeBytes: artifact.sizeBytes,
        expectedDigest: artifact.digest,
      });
      if (download.status === "missing") {
        return sendDownloadError(reply, 409, "missing_artifact");
      }
      if (download.status === "corrupt") {
        return sendDownloadError(reply, 409, "corrupt_artifact");
      }

      // declaredContentType is advisory and never trusted; serving bytes as
      // an inert octet stream with nosniff keeps content sniffing off.
      reply
        .code(200)
        .header("content-type", "application/octet-stream")
        .header(
          "content-disposition",
          `attachment; filename="${displayNameFor(artifact, params.data.artifactId)}"`,
        )
        .header("x-content-type-options", "nosniff")
        .header("cache-control", "private, no-store")
        .header("content-length", String(download.sizeBytes));
      // Readable.from wraps the bounded generator chunks without re-buffering
      // them; backpressure flows to the verified fd reads. Generator errors
      // carry no paths or filesystem metadata by construction.
      return reply.send(Readable.from(download.stream));
    },
  );
}
