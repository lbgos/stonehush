import {
  EngagementIdParamsSchema,
  EngagementNotesResponseSchema,
  EngagementQueryErrorSchema,
  UpdateEngagementNotesErrorSchema,
  UpdateEngagementNotesRequestSchema,
} from "@stonehush/contracts";
import type { EngagementRepository } from "@stonehush/db";
import type { FastifyInstance, FastifyReply } from "fastify";

type NotesRepository = Pick<EngagementRepository, "getEngagementNotes" | "putEngagementNotes">;

function sendError(reply: FastifyReply, status: 400 | 404 | 500 | 503, code: string) {
  return reply
    .code(status)
    .type("application/json")
    .send(EngagementQueryErrorSchema.parse({ code }));
}

export function registerEngagementNotesRoutes(app: FastifyInstance, repository: NotesRepository): void {
  app.get("/api/v1/engagements/:engagementId/notes", async (request, reply) => {
    const params = EngagementIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "invalid_request");
    let result: ReturnType<NotesRepository["getEngagementNotes"]>;
    try {
      result = repository.getEngagementNotes(params.data.engagementId);
    } catch {
      return sendError(reply, 500, "invalid_persisted_data");
    }
    if (!result.ok) {
      if (result.error.code === "engagement_not_found") return sendError(reply, 404, result.error.code);
      if (result.error.code === "storage_busy") return sendError(reply, 503, result.error.code);
      return sendError(reply, 500, "invalid_persisted_data");
    }
    const validated = EngagementNotesResponseSchema.safeParse(result.value);
    if (!validated.success) return sendError(reply, 500, "invalid_persisted_data");
    return reply.code(200).type("application/json").send(validated.data);
  });

  app.put("/api/v1/engagements/:engagementId/notes", async (request, reply) => {
    const params = EngagementIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "invalid_request");
    const body = UpdateEngagementNotesRequestSchema.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, "invalid_request");
    let result: ReturnType<NotesRepository["putEngagementNotes"]>;
    try {
      result = repository.putEngagementNotes(params.data.engagementId, body.data);
    } catch {
      return sendError(reply, 500, "invalid_persisted_data");
    }
    if (!result.ok) {
      if (result.error.code === "engagement_not_found") return sendError(reply, 404, result.error.code);
      if (result.error.code === "engagement_archived") {
        const conflict = UpdateEngagementNotesErrorSchema.safeParse({
          code: "engagement_archived",
        });
        if (!conflict.success) return sendError(reply, 500, "invalid_persisted_data");
        return reply.code(409).type("application/json").send(conflict.data);
      }
      if (result.error.code === "revision_conflict") {
        const conflict = UpdateEngagementNotesErrorSchema.safeParse({
          code: "revision_conflict",
          resourceType: "engagement_notes",
          resourceId: params.data.engagementId,
          currentRevision: result.error.currentRevision,
        });
        if (!conflict.success) return sendError(reply, 500, "invalid_persisted_data");
        return reply.code(409).type("application/json").send(conflict.data);
      }
      if (result.error.code === "storage_busy") return sendError(reply, 503, result.error.code);
      return sendError(reply, 400, "invalid_request");
    }
    const validated = EngagementNotesResponseSchema.safeParse(result.value);
    if (!validated.success) return sendError(reply, 500, "invalid_persisted_data");
    return reply.code(200).type("application/json").send(validated.data);
  });
}
