import {
  CompleteEvidenceUploadErrorSchema,
  CompleteEvidenceUploadRequestSchema,
  EVIDENCE_DECLARED_SIZE_MAX,
  OpaqueUploadIdSchema,
} from "@stonehush/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { EvidencePublicationService } from "./evidence/evidence-publication.js";
import { sendRunnerError } from "./runner-http.js";

type UploadErrorCode =
  | "invalid_persisted_data"
  | "storage_busy"
  | "evidence_io_error"
  | string;

function sendOutcomeError(reply: FastifyReply, code: UploadErrorCode): FastifyReply {
  switch (code) {
    case "storage_busy":
    case "storage_backup_quiesced":
      return sendRunnerError(reply, 503, { code });
    case "invalid_persisted_data":
    case "evidence_io_error":
      return sendRunnerError(reply, 500, { code: "invalid_persisted_data" });
    case "artifact_upload_in_progress":
      return sendRunnerError(reply, 409, { code });
    case "artifact_quota_exceeded":
      return sendRunnerError(reply, 413, { code });
    case "lease_owner_mismatch":
      return sendRunnerError(reply, 403, { code });
    case "lease_expired":
      return sendRunnerError(reply, 409, { code });
    default: {
      // Remaining publication, quota, and path-defense refusals are pinned
      // contract codes and must stay exact.
      const parsed = CompleteEvidenceUploadErrorSchema.safeParse({ code });
      if (!parsed.success) {
        return sendRunnerError(reply, 500, { code: "invalid_persisted_data" });
      }
      return reply.code(409).type("application/json").send(parsed.data);
    }
  }
}

export function registerRunnerEvidenceUploadRoutes(
  app: FastifyInstance,
  options: { publication: EvidencePublicationService },
): void {
  app.put(
    "/api/v1/runner/artifacts/uploads/:uploadId",
    // The reservation check inside the service is the real bound; this only
    // stops the framework's own limit error from preempting it.
    { bodyLimit: EVIDENCE_DECLARED_SIZE_MAX },
    async (request, reply) => {
      const runnerId = request.runnerAuth?.runnerId;
      if (runnerId === undefined) {
        return sendRunnerError(reply, 401, { code: "runner_unauthorized" });
      }
      const uploadId = OpaqueUploadIdSchema.safeParse(
        (request.params as Record<string, unknown>).uploadId,
      );
      if (!uploadId.success || typeof request.body !== "object" || request.body === null) {
        return sendRunnerError(reply, 400, { code: "invalid_request" });
      }
      const outcome = await options.publication.handlePut(
        uploadId.data,
        runnerId,
        request.body as AsyncIterable<unknown>,
      );
      if (outcome.ok) {
        return reply.code(204).send();
      }
      if (outcome.kind === "not_found") {
        return sendRunnerError(reply, 404, { code: "invalid_request" });
      }
      return sendOutcomeError(reply, outcome.code);
    },
  );

  app.post(
    "/api/v1/runner/artifacts/uploads/:uploadId/complete",
    async (request, reply) => {
      const runnerId = request.runnerAuth?.runnerId;
      if (runnerId === undefined) {
        return sendRunnerError(reply, 401, { code: "runner_unauthorized" });
      }
      const uploadId = OpaqueUploadIdSchema.safeParse(
        (request.params as Record<string, unknown>).uploadId,
      );
      const body = CompleteEvidenceUploadRequestSchema.safeParse(request.body);
      if (!uploadId.success || !body.success || body.data.uploadId !== uploadId.data) {
        return sendRunnerError(reply, 400, { code: "invalid_request" });
      }
      const outcome = await options.publication.handleComplete(
        uploadId.data,
        runnerId,
        body.data,
      );
      if (outcome.ok) {
        return reply.code(200).type("application/json").send({
          disposition: outcome.disposition,
          artifactId: outcome.artifactId,
          sizeBytes: outcome.sizeBytes,
          digest: outcome.digest,
          completeness: outcome.completeness,
        });
      }
      if (outcome.kind === "not_found") {
        return sendRunnerError(reply, 404, { code: "invalid_request" });
      }
      return sendOutcomeError(reply, outcome.code);
    },
  );
}
