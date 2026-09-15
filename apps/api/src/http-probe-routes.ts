import { EngagementHttpProbesParamsSchema, EngagementHttpProbesResponseSchema } from "@stonehush/contracts";
import type { HttpProbeRepository } from "@stonehush/db";
import type { FastifyInstance, FastifyReply } from "fastify";

function sendError(reply: FastifyReply, status: number, code: string) {
  return reply.code(status).type("application/json").send({ code });
}

export function registerHttpProbeRoutes(app: FastifyInstance, deps: { repository: Pick<HttpProbeRepository, "listForEngagement"> }) {
  app.get("/api/v1/engagements/:engagementId/http-probes", async (request, reply) => {
    const parsed = EngagementHttpProbesParamsSchema.safeParse(request.params);
    if (!parsed.success) return sendError(reply, 400, "invalid_request");
    const { engagementId } = parsed.data;
    let result: ReturnType<HttpProbeRepository["listForEngagement"]>;
    try { result = deps.repository.listForEngagement(engagementId); } catch { return sendError(reply, 500, "invalid_persisted_data"); }
    if (!result.ok) {
      if (result.code === "engagement_not_found") return sendError(reply, 404, "engagement_not_found");
      if (result.code === "storage_busy") return sendError(reply, 503, "storage_busy");
      return sendError(reply, 500, "invalid_persisted_data");
    }
    const validated = EngagementHttpProbesResponseSchema.safeParse(result.value);
    if (!validated.success) return sendError(reply, 500, "invalid_persisted_data");
    return reply.code(200).type("application/json").send(validated.data);
  });
}
