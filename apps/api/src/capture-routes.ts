import {
  CreateStoneCaptureRequestSchema,
  StoneCaptureListResponseSchema,
  StoneCaptureSchema,
  StoneEngagementIdParamsSchema,
  findInventedExecutionFacts,
} from "@blackglass/contracts";
import type { StoneTargetRepository } from "@blackglass/db";
import type { FastifyInstance, FastifyReply } from "fastify";

type Captures = Pick<
  StoneTargetRepository,
  "createCapture" | "listCaptures"
>;

function sendError(reply: FastifyReply, status: number, code: string) {
  return reply.code(status).type("application/json").send({ code });
}

function mapError(reply: FastifyReply, code: string) {
  switch (code) {
    case "engagement_not_found":
    case "target_not_found":
      return sendError(reply, 404, code);
    case "storage_busy":
      return sendError(reply, 503, code);
    case "invalid_request":
      return sendError(reply, 400, code);
    default:
      return sendError(reply, 500, "invalid_persisted_data");
  }
}

// STONE-5 external capture routes (terminal paste, file/screenshot drop).
// Operator creation accepts user-supplied details only; invented runner
// execution facts are rejected before persistence.
export function registerStoneCaptureRoutes(
  app: FastifyInstance,
  deps: { captures: Captures },
): void {
  app.post("/api/v1/engagements/:engagementId/stone-captures", async (request, reply) => {
    const invented = findInventedExecutionFacts(request.body);
    if (invented.length > 0) return sendError(reply, 400, "invalid_request");
    const params = StoneEngagementIdParamsSchema.safeParse(request.params);
    const body = CreateStoneCaptureRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return sendError(reply, 400, "invalid_request");
    }
    if (body.data.engagementId !== params.data.engagementId) {
      return sendError(reply, 400, "invalid_request");
    }
    let result: ReturnType<Captures["createCapture"]>;
    try {
      result = deps.captures.createCapture({ ...body.data, rawBody: request.body });
    } catch {
      return sendError(reply, 500, "invalid_persisted_data");
    }
    if (!result.ok) return mapError(reply, result.error.code);
    const validated = StoneCaptureSchema.safeParse(result.value.capture);
    if (!validated.success) return sendError(reply, 500, "invalid_persisted_data");
    return reply
      .code(result.value.deduplicated ? 200 : 201)
      .type("application/json")
      .send({ deduplicated: result.value.deduplicated, capture: validated.data });
  });

  app.get("/api/v1/engagements/:engagementId/stone-captures", async (request, reply) => {
    const params = StoneEngagementIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "invalid_request");
    let result: ReturnType<Captures["listCaptures"]>;
    try {
      result = deps.captures.listCaptures(params.data.engagementId);
    } catch {
      return sendError(reply, 500, "invalid_persisted_data");
    }
    if (!result.ok) return mapError(reply, result.error.code);
    const validated = StoneCaptureListResponseSchema.safeParse(result.value);
    if (!validated.success) return sendError(reply, 500, "invalid_persisted_data");
    return reply.code(200).type("application/json").send(validated.data);
  });
}
