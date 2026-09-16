import {
  EngagementIdParamsSchema,
  WORKSPACE_BUNDLE_MAX_JSON_BYTES,
  WorkspaceBundleErrorSchema,
  WorkspaceBundleExportQuerySchema,
  WorkspaceBundleImportResponseSchema,
} from "@stonehush/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";

import {
  exportWorkspaceBundle,
  importWorkspaceBundle,
  type WorkspaceBundleDependencies,
  type WorkspaceBundleErrorCode,
} from "./workspace-bundle-service.js";

function sendError(reply: FastifyReply, code: WorkspaceBundleErrorCode) {
  const status =
    code === "invalid_request" ? 400
    : code === "engagement_not_found" ? 404
    : code === "storage_busy" ? 503
    : code === "bundle_too_large" ? 413
    : code === "unsupported_bundle_version" ? 415
    : code === "bundle_digest_mismatch" ? 422
    : 500;
  return reply
    .code(status)
    .type("application/json")
    .send(WorkspaceBundleErrorSchema.parse({ code }));
}

// Portable workspace bundle routes (stone-9). Export serves one versioned
// file for continuing work as a new engagement elsewhere; import creates
// that new engagement with fresh ids. This is not the client report: copy
// and filenames keep the two unmistakably separate.
export function registerWorkspaceBundleRoutes(
  app: FastifyInstance,
  dependencies: WorkspaceBundleDependencies,
): void {
  app.get(
    "/api/v1/engagements/:engagementId/workspace-bundle",
    async (request, reply) => {
      const params = EngagementIdParamsSchema.safeParse(request.params);
      if (!params.success) return sendError(reply, "invalid_request");
      const query = WorkspaceBundleExportQuerySchema.safeParse(request.query);
      if (!query.success) return sendError(reply, "invalid_request");
      const { engagementId } = params.data;

      const exported = await exportWorkspaceBundle(
        engagementId,
        { privateCopy: query.data.privateCopy === "true" },
        dependencies,
      );
      if (!exported.ok) return sendError(reply, exported.error.code);
      return reply
        .code(200)
        .type("application/json")
        .header(
          "content-disposition",
          `attachment; filename="engagement-${engagementId}-workspace-bundle.json"`,
        )
        .header("cache-control", "private, no-store")
        .send(exported.value.bundle);
    },
  );

  // The body limit is the bundle JSON bound: oversized uploads are rejected
  // before unbounded memory use, ahead of schema and digest checks.
  app.post(
    "/api/v1/workspace-bundles/import",
    { bodyLimit: WORKSPACE_BUNDLE_MAX_JSON_BYTES },
    async (request, reply) => {
      const imported = await importWorkspaceBundle(request.body, dependencies);
      if (!imported.ok) return sendError(reply, imported.error.code);
      const response = WorkspaceBundleImportResponseSchema.safeParse({
        engagementId: imported.value.engagementId,
        summary: imported.value.summary,
      });
      if (!response.success) return sendError(reply, "invalid_persisted_data");
      return reply.code(201).type("application/json").send(response.data);
    },
  );
}
