import {
  FFUF_MAX_JSON_BYTES,
  StoneCaptureSchema,
  StoneEngagementIdParamsSchema,
  StoneImportBodySchema,
  findInventedExecutionFacts,
} from "@blackglass/contracts";
import type { StoneTargetRepository } from "@blackglass/db";
import { countFfufJsonResults, countNmapXmlServices } from "@blackglass/domain";
import type { FastifyInstance, FastifyReply } from "fastify";

type Imports = Pick<StoneTargetRepository, "createCapture">;

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

// STONE-5 Nmap XML and ffuf JSON import routes. Identical content resolves to
// the existing capture (provenance pointer) so re-imports never double facts.
export function registerStoneImportRoutes(
  app: FastifyInstance,
  deps: { imports: Imports },
): void {
  const handleImport = async (
    request: { params: unknown; body: unknown },
    reply: FastifyReply,
    kind: "nmap_xml" | "ffuf_json",
    fallbackTitle: string,
  ) => {
    const invented = findInventedExecutionFacts(request.body);
    if (invented.length > 0) return sendError(reply, 400, "invalid_request");
    const params = StoneEngagementIdParamsSchema.safeParse(request.params);
    const body = StoneImportBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return sendError(reply, 400, "invalid_request");
    }
    if (body.data.contentText === undefined && body.data.contentDigest === undefined) {
      return sendError(reply, 400, "invalid_request");
    }
    // Presented import content is parsed with the matching typed parser before
    // anything is stored, so malformed uploads are never labeled as Nmap or
    // ffuf evidence. Digest-only imports carry no bytes to validate.
    if (body.data.contentText !== undefined) {
      const bytes = new TextEncoder().encode(body.data.contentText);
      if (kind === "ffuf_json" && bytes.length > FFUF_MAX_JSON_BYTES) {
        return sendError(reply, 400, "invalid_request");
      }
      const parsed =
        kind === "nmap_xml" ? countNmapXmlServices(bytes) : countFfufJsonResults(bytes);
      if (!parsed.ok) return sendError(reply, 400, "invalid_request");
    }
    const title = (body.data.title ?? fallbackTitle).trim();
    if (title.length === 0) return sendError(reply, 400, "invalid_request");
    let result: ReturnType<Imports["createCapture"]>;
    try {
      result = deps.imports.createCapture({
        engagementId: params.data.engagementId,
        targetId: body.data.targetId,
        leadId: body.data.leadId,
        kind,
        title,
        command: body.data.command,
        observation: body.data.observation,
        contentText: body.data.contentText,
        contentDigest: body.data.contentDigest,
        fileName: body.data.fileName,
        byteSize: body.data.byteSize,
        rawBody: request.body,
      });
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
  };

  app.post(
    "/api/v1/engagements/:engagementId/stone-imports/nmap-xml",
    async (request, reply) => handleImport(request, reply, "nmap_xml", "Nmap import"),
  );

  app.post(
    "/api/v1/engagements/:engagementId/stone-imports/ffuf-json",
    async (request, reply) => handleImport(request, reply, "ffuf_json", "Ffuf import"),
  );
}
