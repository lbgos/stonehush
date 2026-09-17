import {
  FFUF_MAX_JSON_BYTES,
  HAR_MAX_FILE_BYTES,
  NMAP_MAX_XML_BYTES,
  StoneCaptureSchema,
  StoneEngagementIdParamsSchema,
  StoneImportBodySchema,
  findInventedExecutionFacts,
} from "@stonehush/contracts";
import type { StoneTargetRepository } from "@stonehush/db";
import {
  countFfufJsonResults,
  countNmapXmlServices,
  parseHarImport,
} from "@stonehush/domain";
import type { FastifyInstance, FastifyReply } from "fastify";

type Imports = Pick<StoneTargetRepository, "createCapture">;

type StoneImportKind = "nmap_xml" | "ffuf_json" | "har";

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

interface ImportValidation {
  ok: boolean;
  fallbackTitle: string;
  errorCode: string;
}

function validateNmapXml(bytes: Uint8Array): ImportValidation {
  const parsed = countNmapXmlServices(bytes);
  if (!parsed.ok) return { ok: false, fallbackTitle: "", errorCode: "invalid_request" };
  return { ok: true, fallbackTitle: "Nmap import", errorCode: "" };
}

function validateFfufJson(bytes: Uint8Array): ImportValidation {
  if (bytes.length > FFUF_MAX_JSON_BYTES) {
    return { ok: false, fallbackTitle: "", errorCode: "invalid_request" };
  }
  const parsed = countFfufJsonResults(bytes);
  if (!parsed.ok) return { ok: false, fallbackTitle: "", errorCode: "invalid_request" };
  return { ok: true, fallbackTitle: "Ffuf import", errorCode: "" };
}

// Proxy HAR selections are validated entry by entry. Rejections keep their
// specific code so the operator learns what to fix in the proxy export.
function validateHar(bytes: Uint8Array): ImportValidation {
  const parsed = parseHarImport(bytes);
  if (!parsed.ok) {
    return { ok: false, fallbackTitle: "", errorCode: parsed.error.code };
  }
  return { ok: true, fallbackTitle: parsed.value.title, errorCode: "" };
}

// STONE-5 Nmap XML and ffuf JSON import routes, plus the STONE-11 proxy HAR
// selection import. Identical content resolves to the existing capture
// (provenance pointer) so re-imports never double facts.
export function registerStoneImportRoutes(
  app: FastifyInstance,
  deps: { imports: Imports },
): void {
  const handleImport = async (
    request: { params: unknown; body: unknown },
    reply: FastifyReply,
    kind: StoneImportKind,
    validate: (bytes: Uint8Array) => ImportValidation,
  ) => {
    const invented = findInventedExecutionFacts(request.body);
    if (invented.length > 0) return sendError(reply, 400, "invalid_request");
    const params = StoneEngagementIdParamsSchema.safeParse(request.params);
    const body = StoneImportBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return sendError(reply, 400, "invalid_request");
    }
    // Presented import content is parsed with the matching typed parser before
    // anything is stored, so malformed uploads are never labeled as Nmap,
    // ffuf, or proxy evidence. Content is required by the import boundary, so
    // there are always bytes to validate.
    const bytes = new TextEncoder().encode(body.data.contentText);
    const validated = validate(bytes);
    if (!validated.ok) return sendError(reply, 400, validated.errorCode);
    const title = (body.data.title ?? validated.fallbackTitle).trim();
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
    const stored = StoneCaptureSchema.safeParse(result.value.capture);
    if (!stored.success) return sendError(reply, 500, "invalid_persisted_data");
    return reply
      .code(result.value.deduplicated ? 200 : 201)
      .type("application/json")
      .send({ deduplicated: result.value.deduplicated, capture: stored.data });
  };

  // Route body limits match the parser bounds so reachable uploads are never
  // cut off by the framework default before validation runs. The HAR limit
  // covers JSON escaping: content travels JSON-encoded, so escape-heavy
  // files are larger on the wire than the validated file bytes. Content made
  // only of control characters can still exceed it; that stays refused by
  // the framework before unbounded memory use.
  app.post(
    "/api/v1/engagements/:engagementId/stone-imports/nmap-xml",
    { bodyLimit: NMAP_MAX_XML_BYTES },
    async (request, reply) => handleImport(request, reply, "nmap_xml", validateNmapXml),
  );

  app.post(
    "/api/v1/engagements/:engagementId/stone-imports/ffuf-json",
    { bodyLimit: FFUF_MAX_JSON_BYTES },
    async (request, reply) => handleImport(request, reply, "ffuf_json", validateFfufJson),
  );

  app.post(
    "/api/v1/engagements/:engagementId/stone-imports/har",
    { bodyLimit: HAR_MAX_FILE_BYTES * 2 + 262_144 },
    async (request, reply) => handleImport(request, reply, "har", validateHar),
  );
}
