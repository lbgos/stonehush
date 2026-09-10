import {
  ChangeTargetAddressRequestSchema,
  CreateStoneTargetBodySchema,
  DecideHostnameAssociationRequestSchema,
  ProposeStoneAssociationBodySchema,
  StoneAddressBindingListSchema,
  StoneAssociationIdParamsSchema,
  StoneEngagementIdParamsSchema,
  StoneHostnameAssociationSchema,
  StoneTargetIdParamsSchema,
  StoneTargetListResponseSchema,
  StoneTargetSchema,
} from "@blackglass/contracts";
import type { StoneTargetRepository } from "@blackglass/db";
import type { FastifyInstance, FastifyReply } from "fastify";

type Targets = Pick<
  StoneTargetRepository,
  | "createTarget"
  | "listTargets"
  | "listBindings"
  | "changeAddress"
  | "proposeHostnameAssociation"
  | "decideHostnameAssociation"
>;

function sendError(reply: FastifyReply, status: number, code: string) {
  return reply.code(status).type("application/json").send({ code });
}

function mapError(reply: FastifyReply, code: string) {
  switch (code) {
    case "engagement_not_found":
      return sendError(reply, 404, code);
    case "target_not_found":
    case "association_not_found":
      return sendError(reply, 404, code);
    case "storage_busy":
      return sendError(reply, 503, code);
    case "invalid_request":
      return sendError(reply, 400, code);
    default:
      return sendError(reply, 500, "invalid_persisted_data");
  }
}

// STONE-5 target identity routes. Mounted by the control plane alongside the
// existing engagement routes once STONE-2 extension wiring lands; kept in a
// dedicated module so this slice adds files only.
export function registerStoneTargetRoutes(
  app: FastifyInstance,
  deps: { targets: Targets },
): void {
  app.post("/api/v1/engagements/:engagementId/stone-targets", async (request, reply) => {
    const params = StoneEngagementIdParamsSchema.safeParse(request.params);
    const body = CreateStoneTargetBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return sendError(reply, 400, "invalid_request");
    let result: ReturnType<Targets["createTarget"]>;
    try {
      result = deps.targets.createTarget({
        engagementId: params.data.engagementId,
        label: body.data.label,
        initialAddress: body.data.initialAddress,
      });
    } catch {
      return sendError(reply, 500, "invalid_persisted_data");
    }
    if (!result.ok) return mapError(reply, result.error.code);
    const validated = StoneTargetSchema.safeParse(result.value);
    if (!validated.success) return sendError(reply, 500, "invalid_persisted_data");
    return reply.code(201).type("application/json").send(validated.data);
  });

  app.get("/api/v1/engagements/:engagementId/stone-targets", async (request, reply) => {
    const params = StoneEngagementIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "invalid_request");
    let result: ReturnType<Targets["listTargets"]>;
    try {
      result = deps.targets.listTargets(params.data.engagementId);
    } catch {
      return sendError(reply, 500, "invalid_persisted_data");
    }
    if (!result.ok) return mapError(reply, result.error.code);
    const validated = StoneTargetListResponseSchema.safeParse(result.value);
    if (!validated.success) return sendError(reply, 500, "invalid_persisted_data");
    return reply.code(200).type("application/json").send(validated.data);
  });

  app.get(
    "/api/v1/engagements/:engagementId/stone-targets/:targetId/bindings",
    async (request, reply) => {
      const params = StoneTargetIdParamsSchema.safeParse(request.params);
      if (!params.success) return sendError(reply, 400, "invalid_request");
      let result: ReturnType<Targets["listBindings"]>;
      try {
        result = deps.targets.listBindings({
          engagementId: params.data.engagementId,
          targetId: params.data.targetId,
        });
      } catch {
        return sendError(reply, 500, "invalid_persisted_data");
      }
      if (!result.ok) return mapError(reply, result.error.code);
      // Rows are scoped to the requested engagement above and carry their own
      // engagement and target ids, so the response never relabels foreign rows.
      const bindings = StoneAddressBindingListSchema.safeParse(
        result.value.bindings.map((binding) => ({
          contractVersion: 1,
          engagementId: binding.engagementId,
          targetId: binding.targetId,
          id: binding.id,
          bindingKind: binding.bindingKind,
          addressText: binding.addressText,
          status: binding.status,
          createdAt: binding.createdAt,
          supersededAt: binding.supersededAt,
        })),
      );
      if (!bindings.success) return sendError(reply, 500, "invalid_persisted_data");
      const current = bindings.data.filter((binding) => binding.status === "current");
      const historical = bindings.data.filter((binding) => binding.status === "historical");
      return reply.code(200).type("application/json").send({ current, historical });
    },
  );

  app.post(
    "/api/v1/engagements/:engagementId/stone-targets/:targetId/address-change",
    async (request, reply) => {
      const params = StoneTargetIdParamsSchema.safeParse(request.params);
      const body = ChangeTargetAddressRequestSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return sendError(reply, 400, "invalid_request");
      }
      if (body.data.targetId !== params.data.targetId) {
        return sendError(reply, 400, "invalid_request");
      }
      let result: ReturnType<Targets["changeAddress"]>;
      try {
        result = deps.targets.changeAddress({
          engagementId: params.data.engagementId,
          targetId: params.data.targetId,
          newAddress: body.data.newAddress,
        });
      } catch {
        return sendError(reply, 500, "invalid_persisted_data");
      }
      if (!result.ok) return mapError(reply, result.error.code);
      return reply.code(200).type("application/json").send({
        targetId: params.data.targetId,
        addressText: result.value.addressText,
        retiredBindingId: result.value.retiredBindingId,
      });
    },
  );

  app.post(
    "/api/v1/engagements/:engagementId/stone-targets/:targetId/hostname-associations",
    async (request, reply) => {
      const params = StoneTargetIdParamsSchema.safeParse(request.params);
      const body = ProposeStoneAssociationBodySchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return sendError(reply, 400, "invalid_request");
      }
      let result: ReturnType<Targets["proposeHostnameAssociation"]>;
      try {
        result = deps.targets.proposeHostnameAssociation({
          engagementId: params.data.engagementId,
          targetId: params.data.targetId,
          connectionAddress: body.data.connectionAddress,
          requestedHostname: body.data.requestedHostname,
        });
      } catch {
        return sendError(reply, 500, "invalid_persisted_data");
      }
      if (!result.ok) return mapError(reply, result.error.code);
      const validated = StoneHostnameAssociationSchema.safeParse(result.value);
      if (!validated.success) return sendError(reply, 500, "invalid_persisted_data");
      return reply.code(201).type("application/json").send(validated.data);
    },
  );

  app.post(
    "/api/v1/engagements/:engagementId/stone-hostname-associations/:associationId/decision",
    async (request, reply) => {
      const params = StoneAssociationIdParamsSchema.safeParse(request.params);
      const body = DecideHostnameAssociationRequestSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return sendError(reply, 400, "invalid_request");
      }
      let result: ReturnType<Targets["decideHostnameAssociation"]>;
      try {
        result = deps.targets.decideHostnameAssociation({
          engagementId: params.data.engagementId,
          associationId: params.data.associationId,
          decision: body.data.decision,
        });
      } catch {
        return sendError(reply, 500, "invalid_persisted_data");
      }
      if (!result.ok) return mapError(reply, result.error.code);
      const validated = StoneHostnameAssociationSchema.safeParse(result.value);
      if (!validated.success) return sendError(reply, 500, "invalid_persisted_data");
      return reply.code(200).type("application/json").send(validated.data);
    },
  );
}
