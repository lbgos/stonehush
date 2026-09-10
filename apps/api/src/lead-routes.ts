import {
  AttachLeadAttemptRequestSchema,
  CloseLeadRequestSchema,
  CreateLeadAttemptRequestSchema,
  CreateLeadRequestSchema,
  EngagementIdParamsSchema,
  LeadAttemptIdParamsSchema,
  LeadAttemptListResponseSchema,
  LeadAttemptResponseSchema,
  LeadIdParamsSchema,
  LeadListResponseSchema,
  LeadMutationErrorSchema,
  LeadOutlineResponseSchema,
  LeadQueryErrorSchema,
  LeadResponseSchema,
  ParkLeadRequestSchema,
  SuggestLeadRevisitRequestSchema,
} from "@blackglass/contracts";
import type { LeadRepository } from "@blackglass/db";
import type { FastifyInstance, FastifyReply } from "fastify";

type LeadRoutesRepository = Pick<
  LeadRepository,
  | "createLead"
  | "listLeads"
  | "getLead"
  | "parkLead"
  | "reopenLead"
  | "closeLead"
  | "suggestRevisit"
  | "dismissRevisit"
  | "recordAttempt"
  | "getAttempt"
  | "listAttempts"
  | "attachAttempt"
  | "leadOutline"
>;

function sendQueryError(
  reply: FastifyReply,
  status: 400 | 404 | 500 | 503,
  code: string,
) {
  return reply
    .code(status)
    .type("application/json")
    .send(LeadQueryErrorSchema.parse({ code }));
}

function sendMutationError(
  reply: FastifyReply,
  status: 400 | 404 | 409 | 500 | 503,
  code: string,
) {
  return reply
    .code(status)
    .type("application/json")
    .send(LeadMutationErrorSchema.parse({ code }));
}

function mutationStatus(code: string): 400 | 404 | 409 | 500 | 503 {
  if (code === "engagement_not_found" || code === "lead_not_found" || code === "attempt_not_found") {
    return 404;
  }
  if (
    code === "engagement_archived" ||
    code === "invalid_lead_transition" ||
    code === "revisit_suppressed"
  ) {
    return 409;
  }
  if (code === "storage_busy") return 503;
  if (code === "invalid_repository_input") return 400;
  return 500;
}

// LeadMutationErrorSchema has no invalid_repository_input variant, so a
// repo-level input rejection surfaces as invalid_request instead of throwing
// inside sendMutationError (which would escape as a 500).
function mutationErrorCode(code: string): string {
  return code === "invalid_repository_input" ? "invalid_request" : code;
}

export function registerLeadRoutes(
  app: FastifyInstance,
  repository: LeadRoutesRepository,
): void {
  app.get("/api/v1/engagements/:engagementId/leads", async (request, reply) => {
    const params = EngagementIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendQueryError(reply, 400, "invalid_request");
    let result: ReturnType<LeadRoutesRepository["listLeads"]>;
    try {
      result = repository.listLeads(params.data.engagementId);
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
    const validated = LeadListResponseSchema.safeParse(result.value);
    if (!validated.success) return sendQueryError(reply, 500, "invalid_persisted_data");
    return reply.code(200).type("application/json").send(validated.data);
  });

  app.post("/api/v1/engagements/:engagementId/leads", async (request, reply) => {
    const params = EngagementIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendMutationError(reply, 400, "invalid_request");
    const body = CreateLeadRequestSchema.safeParse(request.body);
    if (!body.success) return sendMutationError(reply, 400, "invalid_request");
    let result: ReturnType<LeadRoutesRepository["createLead"]>;
    try {
      result = repository.createLead(params.data.engagementId, body.data);
    } catch {
      return sendMutationError(reply, 500, "invalid_persisted_data");
    }
    if (!result.ok) {
      return sendMutationError(reply, mutationStatus(result.error.code), mutationErrorCode(result.error.code));
    }
    const validated = LeadResponseSchema.safeParse(result.value);
    if (!validated.success) return sendMutationError(reply, 500, "invalid_persisted_data");
    return reply.code(201).type("application/json").send(validated.data);
  });

  app.get("/api/v1/engagements/:engagementId/leads/:leadId", async (request, reply) => {
    const params = LeadIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendQueryError(reply, 400, "invalid_request");
    let result: ReturnType<LeadRoutesRepository["getLead"]>;
    try {
      result = repository.getLead(params.data.engagementId, params.data.leadId);
    } catch {
      return sendQueryError(reply, 500, "invalid_persisted_data");
    }
    if (!result.ok) {
      if (
        result.error.code === "engagement_not_found" ||
        result.error.code === "lead_not_found"
      ) {
        return sendQueryError(reply, 404, result.error.code);
      }
      if (result.error.code === "storage_busy") {
        return sendQueryError(reply, 503, result.error.code);
      }
      return sendQueryError(reply, 500, "invalid_persisted_data");
    }
    const validated = LeadResponseSchema.safeParse(result.value);
    if (!validated.success) return sendQueryError(reply, 500, "invalid_persisted_data");
    return reply.code(200).type("application/json").send(validated.data);
  });

  const transitions = [
    { operation: "park", schema: ParkLeadRequestSchema, call: "parkLead" },
    { operation: "close", schema: CloseLeadRequestSchema, call: "closeLead" },
    {
      operation: "revisit",
      schema: SuggestLeadRevisitRequestSchema,
      call: "suggestRevisit",
    },
  ] as const;

  for (const { operation, schema, call } of transitions) {
    app.post(
      `/api/v1/engagements/:engagementId/leads/:leadId/${operation}`,
      async (request, reply) => {
        const params = LeadIdParamsSchema.safeParse(request.params);
        if (!params.success) return sendMutationError(reply, 400, "invalid_request");
        const body = schema.safeParse(request.body);
        if (!body.success) return sendMutationError(reply, 400, "invalid_request");
        let result: ReturnType<LeadRoutesRepository["parkLead"]>;
        try {
          result = repository[call](
            params.data.engagementId,
            params.data.leadId,
            body.data,
          );
        } catch {
          return sendMutationError(reply, 500, "invalid_persisted_data");
        }
        if (!result.ok) {
          return sendMutationError(reply, mutationStatus(result.error.code), mutationErrorCode(result.error.code));
        }
        const validated = LeadResponseSchema.safeParse(result.value);
        if (!validated.success) {
          return sendMutationError(reply, 500, "invalid_persisted_data");
        }
        return reply.code(200).type("application/json").send(validated.data);
      },
    );
  }

  for (const operation of ["reopen", "revisit/dismiss"] as const) {
    const call = operation === "reopen" ? "reopenLead" : "dismissRevisit";
    app.post(
      `/api/v1/engagements/:engagementId/leads/:leadId/${operation}`,
      async (request, reply) => {
        const params = LeadIdParamsSchema.safeParse(request.params);
        if (!params.success) return sendMutationError(reply, 400, "invalid_request");
        let result: ReturnType<LeadRoutesRepository["reopenLead"]>;
        try {
          result = repository[call](params.data.engagementId, params.data.leadId);
        } catch {
          return sendMutationError(reply, 500, "invalid_persisted_data");
        }
        if (!result.ok) {
          return sendMutationError(reply, mutationStatus(result.error.code), mutationErrorCode(result.error.code));
        }
        const validated = LeadResponseSchema.safeParse(result.value);
        if (!validated.success) {
          return sendMutationError(reply, 500, "invalid_persisted_data");
        }
        return reply.code(200).type("application/json").send(validated.data);
      },
    );
  }

  app.get("/api/v1/engagements/:engagementId/leads/:leadId/attempts", async (request, reply) => {
    const params = LeadIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendQueryError(reply, 400, "invalid_request");
    let result: ReturnType<LeadRoutesRepository["listAttempts"]>;
    try {
      result = repository.listAttempts(params.data.engagementId, params.data.leadId);
    } catch {
      return sendQueryError(reply, 500, "invalid_persisted_data");
    }
    if (!result.ok) {
      if (
        result.error.code === "engagement_not_found" ||
        result.error.code === "lead_not_found"
      ) {
        return sendQueryError(reply, 404, result.error.code);
      }
      if (result.error.code === "storage_busy") {
        return sendQueryError(reply, 503, result.error.code);
      }
      return sendQueryError(reply, 500, "invalid_persisted_data");
    }
    const validated = LeadAttemptListResponseSchema.safeParse(result.value);
    if (!validated.success) return sendQueryError(reply, 500, "invalid_persisted_data");
    return reply.code(200).type("application/json").send(validated.data);
  });

  app.post("/api/v1/engagements/:engagementId/leads/:leadId/attempts", async (request, reply) => {
    const params = LeadIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendMutationError(reply, 400, "invalid_request");
    const body = CreateLeadAttemptRequestSchema.safeParse(request.body);
    if (!body.success) return sendMutationError(reply, 400, "invalid_request");
    let result: ReturnType<LeadRoutesRepository["recordAttempt"]>;
    try {
      result = repository.recordAttempt(
        params.data.engagementId,
        params.data.leadId,
        body.data,
      );
    } catch {
      return sendMutationError(reply, 500, "invalid_persisted_data");
    }
    if (!result.ok) {
      return sendMutationError(reply, mutationStatus(result.error.code), mutationErrorCode(result.error.code));
    }
    const validated = LeadAttemptResponseSchema.safeParse(result.value);
    if (!validated.success) return sendMutationError(reply, 500, "invalid_persisted_data");
    return reply.code(201).type("application/json").send(validated.data);
  });

  app.post("/api/v1/engagements/:engagementId/attempts/:attemptId/attach", async (request, reply) => {
    const params = LeadAttemptIdParamsSchema.extend({
      engagementId: EngagementIdParamsSchema.shape.engagementId,
    }).safeParse(request.params);
    if (!params.success) return sendMutationError(reply, 400, "invalid_request");
    const body = AttachLeadAttemptRequestSchema.safeParse(request.body);
    if (!body.success) return sendMutationError(reply, 400, "invalid_request");
    let result: ReturnType<LeadRoutesRepository["attachAttempt"]>;
    try {
      result = repository.attachAttempt(
        params.data.engagementId,
        params.data.attemptId,
        body.data,
      );
    } catch {
      return sendMutationError(reply, 500, "invalid_persisted_data");
    }
    if (!result.ok) {
      return sendMutationError(reply, mutationStatus(result.error.code), mutationErrorCode(result.error.code));
    }
    const validated = LeadAttemptResponseSchema.safeParse(result.value);
    if (!validated.success) return sendMutationError(reply, 500, "invalid_persisted_data");
    return reply.code(200).type("application/json").send(validated.data);
  });

  app.get("/api/v1/engagements/:engagementId/leads/:leadId/outline", async (request, reply) => {
    const params = LeadIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendQueryError(reply, 400, "invalid_request");
    let result: ReturnType<LeadRoutesRepository["leadOutline"]>;
    try {
      result = repository.leadOutline(params.data.engagementId, params.data.leadId);
    } catch {
      return sendQueryError(reply, 500, "invalid_persisted_data");
    }
    if (!result.ok) {
      if (
        result.error.code === "engagement_not_found" ||
        result.error.code === "lead_not_found"
      ) {
        return sendQueryError(reply, 404, result.error.code);
      }
      if (result.error.code === "storage_busy") {
        return sendQueryError(reply, 503, result.error.code);
      }
      return sendQueryError(reply, 500, "invalid_persisted_data");
    }
    const validated = LeadOutlineResponseSchema.safeParse(result.value);
    if (!validated.success) return sendQueryError(reply, 500, "invalid_persisted_data");
    return reply.code(200).type("application/json").send(validated.data);
  });
}
