import {
  EngagementGitleaksParamsSchema,
  GitleaksErrorSchema,
  GitleaksMatchesResponseSchema,
  GitleaksScanRequestSchema,
  GitleaksScanResponseSchema,
  type GitleaksErrorCode,
} from "@stonehush/contracts";
import type { EngagementRepository, GitleaksRepository } from "@stonehush/db";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { ScanEngagementEvidenceResult, GitleaksScanner } from "./evidence/gitleaks-scan.js";

export type { GitleaksScanner };

type Engagements = Pick<EngagementRepository, "getEngagement">;
type Scans = Pick<GitleaksRepository, "createScan" | "latestForEngagement">;

function sendError(reply: FastifyReply, status: number, code: GitleaksErrorCode) {
  return reply
    .code(status)
    .type("application/json")
    .send(GitleaksErrorSchema.parse({ code }));
}

function scanStatus(code: string): number {
  switch (code) {
    case "gitleaks_missing":
    case "storage_busy":
      return 503;
    case "evidence_too_large":
      return 413;
    case "gitleaks_failed":
    case "gitleaks_parse_error":
    case "gitleaks_output_too_large":
      return 502;
    default:
      return 500;
  }
}

// Local secret scan over captured engagement evidence (T0, read-only).
// Values never reach this layer: the scanner persists only the redacted
// rule, file, line, and fingerprint rows returned by the domain parser.
export function registerGitleaksRoutes(
  app: FastifyInstance,
  deps: { engagements: Engagements; scans: Scans; scanner: GitleaksScanner },
): void {
  app.post("/api/v1/engagements/:engagementId/gitleaks-scans", async (request, reply) => {
    const params = EngagementGitleaksParamsSchema.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "invalid_request");
    const body = GitleaksScanRequestSchema.safeParse(request.body ?? {});
    if (!body.success) return sendError(reply, 400, "invalid_request");
    const { engagementId } = params.data;

    let engagement: ReturnType<Engagements["getEngagement"]>;
    try {
      engagement = deps.engagements.getEngagement(engagementId);
    } catch {
      return sendError(reply, 500, "invalid_persisted_data");
    }
    if (!engagement.ok) {
      if (engagement.error.code === "engagement_not_found") {
        return sendError(reply, 404, "engagement_not_found");
      }
      if (engagement.error.code === "storage_busy") return sendError(reply, 503, "storage_busy");
      return sendError(reply, 500, "invalid_persisted_data");
    }
    if (engagement.value.engagement.status === "archived") {
      return sendError(reply, 409, "engagement_archived");
    }

    let scanned: ScanEngagementEvidenceResult;
    try {
      scanned = await deps.scanner.scan(engagementId);
    } catch {
      return sendError(reply, 500, "invalid_persisted_data");
    }
    if (!scanned.ok) {
      return sendError(reply, scanStatus(scanned.error.code), scanned.error.code as GitleaksErrorCode);
    }

    let stored: ReturnType<Scans["createScan"]>;
    try {
      stored = deps.scans.createScan(engagementId, {
        matches: scanned.value.matches,
        truncated: scanned.value.truncated,
      });
    } catch {
      return sendError(reply, 500, "invalid_persisted_data");
    }
    if (!stored.ok) {
      if (stored.code === "engagement_not_found") return sendError(reply, 404, "engagement_not_found");
      // The engagement was archived while the detector ran: the
      // repository refused the write inside its transaction.
      if (stored.code === "engagement_archived") return sendError(reply, 409, "engagement_archived");
      if (stored.code === "storage_busy") return sendError(reply, 503, "storage_busy");
      return sendError(reply, 500, "invalid_persisted_data");
    }
    const validated = GitleaksScanResponseSchema.safeParse(stored.value);
    if (!validated.success) return sendError(reply, 500, "invalid_persisted_data");
    return reply.code(201).type("application/json").send(validated.data);
  });

  app.get("/api/v1/engagements/:engagementId/gitleaks-matches", async (request, reply) => {
    const params = EngagementGitleaksParamsSchema.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "invalid_request");
    let latest: ReturnType<Scans["latestForEngagement"]>;
    try {
      latest = deps.scans.latestForEngagement(params.data.engagementId);
    } catch {
      return sendError(reply, 500, "invalid_persisted_data");
    }
    if (!latest.ok) {
      if (latest.code === "engagement_not_found") return sendError(reply, 404, "engagement_not_found");
      if (latest.code === "storage_busy") return sendError(reply, 503, "storage_busy");
      return sendError(reply, 500, "invalid_persisted_data");
    }
    const validated = GitleaksMatchesResponseSchema.safeParse(latest.value?.matches ?? []);
    if (!validated.success) return sendError(reply, 500, "invalid_persisted_data");
    return reply.code(200).type("application/json").send(validated.data);
  });
}
