import {
  AccessIdParamsSchema,
  AccessListResponseSchema,
  AccessMutationErrorSchema,
  AccessQueryErrorSchema,
  AccessResponseSchema,
  CreateAccessRequestSchema,
  EngagementIdParamsSchema,
  type AccessRecord,
} from "@stonehush/contracts";
import type { AccessRepository, LeadRepository } from "@stonehush/db";
import { accessRevisitReason, parkedForLackOfAccess } from "@stonehush/domain";
import type { FastifyInstance, FastifyReply } from "fastify";

type AccessRoutesRepository = Pick<
  AccessRepository,
  "createAccess" | "listAccess" | "getAccess" | "refreshAccess"
>;

type AccessRevisitLeads = Pick<LeadRepository, "listLeads" | "suggestRevisit">;

function sendQueryError(
  reply: FastifyReply,
  status: 400 | 404 | 500 | 503,
  code: string,
) {
  return reply
    .code(status)
    .type("application/json")
    .send(AccessQueryErrorSchema.parse({ code }));
}

function sendMutationError(
  reply: FastifyReply,
  status: 400 | 404 | 409 | 500 | 503,
  code: string,
) {
  return reply
    .code(status)
    .type("application/json")
    .send(AccessMutationErrorSchema.parse({ code }));
}

function mutationStatus(code: string): 400 | 404 | 409 | 500 | 503 {
  if (
    code === "engagement_not_found" ||
    code === "access_not_found" ||
    code === "target_not_found" ||
    code === "lead_not_found" ||
    code === "secret_not_found"
  ) {
    return 404;
  }
  if (code === "engagement_archived") return 409;
  if (code === "storage_busy") return 503;
  if (code === "invalid_repository_input") return 400;
  return 500;
}

// AccessMutationErrorSchema has no invalid_repository_input variant, so a
// repo-level input rejection surfaces as invalid_request instead of throwing
// inside sendMutationError (which would escape as a 500).
function mutationErrorCode(code: string): string {
  return code === "invalid_repository_input" ? "invalid_request" : code;
}

// Recording new access fires the parked-lead revisit path: every parked lead
// kept for lack of access gets one quiet suggestion citing the new access.
// Suppressed leads are skipped silently, the recorded access is returned
// regardless, and no lead is ever reopened here.
export function fireNewAccessRevisit(
  leads: AccessRevisitLeads,
  engagementId: string,
  record: AccessRecord,
): void {
  let parked: ReturnType<AccessRevisitLeads["listLeads"]>;
  try {
    parked = leads.listLeads(engagementId);
  } catch {
    return;
  }
  if (!parked.ok) return;
  const reason = accessRevisitReason({ accessType: record.accessType, account: record.account });
  for (const lead of parked.value) {
    if (lead.disposition !== "parked") continue;
    if (!parkedForLackOfAccess(lead.parkReason, lead.testedConditions)) continue;
    if (lead.revisitSuggestion !== null && !lead.revisitSuggestion.dismissed) continue;
    try {
      leads.suggestRevisit(engagementId, lead.id, {
        trigger: "new_access",
        reason,
        anonymous: false,
      });
    } catch {
      continue;
    }
  }
}

// Access routes carry references only, never plaintext secret values. The
// contract has no value field and the repository stores secret ids alone, so
// nothing here can leak one; responses validate against the strict schemas.
export function registerAccessRoutes(
  app: FastifyInstance,
  repository: AccessRoutesRepository,
  options: { leads?: AccessRevisitLeads } = {},
): void {
  app.get("/api/v1/engagements/:engagementId/access", async (request, reply) => {
    const params = EngagementIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendQueryError(reply, 400, "invalid_request");
    let result: ReturnType<AccessRoutesRepository["listAccess"]>;
    try {
      result = repository.listAccess(params.data.engagementId);
    } catch {
      return sendQueryError(reply, 500, "invalid_persisted_data");
    }
    if (!result.ok) {
      if (result.error.code === "engagement_not_found") {
        return sendQueryError(reply, 404, result.error.code);
      }
      if (result.error.code === "storage_busy") {
        return sendQueryError(reply, 503, result.error.code);
      }
      return sendQueryError(reply, 500, "invalid_persisted_data");
    }
    const validated = AccessListResponseSchema.safeParse(result.value);
    if (!validated.success) return sendQueryError(reply, 500, "invalid_persisted_data");
    return reply.code(200).type("application/json").send(validated.data);
  });

  app.post("/api/v1/engagements/:engagementId/access", async (request, reply) => {
    const params = EngagementIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendMutationError(reply, 400, "invalid_request");
    const body = CreateAccessRequestSchema.safeParse(request.body);
    if (!body.success) return sendMutationError(reply, 400, "invalid_request");
    let result: ReturnType<AccessRoutesRepository["createAccess"]>;
    try {
      result = repository.createAccess(params.data.engagementId, body.data);
    } catch {
      return sendMutationError(reply, 500, "invalid_persisted_data");
    }
    if (!result.ok) {
      return sendMutationError(reply, mutationStatus(result.error.code), mutationErrorCode(result.error.code));
    }
    if (options.leads !== undefined) {
      fireNewAccessRevisit(options.leads, params.data.engagementId, result.value);
    }
    const validated = AccessResponseSchema.safeParse(result.value);
    if (!validated.success) return sendMutationError(reply, 500, "invalid_persisted_data");
    return reply.code(201).type("application/json").send(validated.data);
  });

  app.get("/api/v1/engagements/:engagementId/access/:accessId", async (request, reply) => {
    const params = AccessIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendQueryError(reply, 400, "invalid_request");
    let result: ReturnType<AccessRoutesRepository["getAccess"]>;
    try {
      result = repository.getAccess(params.data.engagementId, params.data.accessId);
    } catch {
      return sendQueryError(reply, 500, "invalid_persisted_data");
    }
    if (!result.ok) {
      if (
        result.error.code === "engagement_not_found" ||
        result.error.code === "access_not_found"
      ) {
        return sendQueryError(reply, 404, result.error.code);
      }
      if (result.error.code === "storage_busy") {
        return sendQueryError(reply, 503, result.error.code);
      }
      return sendQueryError(reply, 500, "invalid_persisted_data");
    }
    const validated = AccessResponseSchema.safeParse(result.value);
    if (!validated.success) return sendQueryError(reply, 500, "invalid_persisted_data");
    return reply.code(200).type("application/json").send(validated.data);
  });

  app.post("/api/v1/engagements/:engagementId/access/:accessId/refresh", async (request, reply) => {
    const params = AccessIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendMutationError(reply, 400, "invalid_request");
    let result: ReturnType<AccessRoutesRepository["refreshAccess"]>;
    try {
      result = repository.refreshAccess(params.data.engagementId, params.data.accessId);
    } catch {
      return sendMutationError(reply, 500, "invalid_persisted_data");
    }
    if (!result.ok) {
      return sendMutationError(reply, mutationStatus(result.error.code), mutationErrorCode(result.error.code));
    }
    const validated = AccessResponseSchema.safeParse(result.value);
    if (!validated.success) return sendMutationError(reply, 500, "invalid_persisted_data");
    return reply.code(200).type("application/json").send(validated.data);
  });
}
