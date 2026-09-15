import {
  EngagementIdParamsSchema,
  EngagementNextStepRecordSchema,
  EngagementResumeChangeSchema,
  EngagementResumeErrorSchema,
  EngagementResumeResponseSchema,
  EngagementServicesResponseSchema,
  UpdateEngagementNextStepRequestSchema,
  parseEngagementResumeQuery,
} from "@stonehush/contracts";
import type {
  EngagementRepository,
  EngagementResumeRepository,
  NmapServiceRepository,
  RunOutputRepository,
} from "@stonehush/db";
import { buildResumeChanges, changesSinceLastVisit } from "@stonehush/domain";
import type { FastifyInstance, FastifyReply } from "fastify";

export interface EngagementResumeRouteDeps {
  readonly resume: Pick<EngagementResumeRepository, "getNextStep" | "putNextStep">;
  readonly engagements: Pick<
    EngagementRepository,
    "getEngagement" | "getEngagementNotes" | "listScopeRevisions"
  > &
    Partial<Pick<EngagementRepository, "listFindings">>;
  readonly runs?: Pick<RunOutputRepository, "listRunsForEngagement">;
  readonly services?: Pick<NmapServiceRepository, "listForEngagement">;
}

function sendResumeError(
  reply: FastifyReply,
  status: number,
  code: string,
  extra?: Record<string, unknown>,
) {
  const body = EngagementResumeErrorSchema.parse({ code, ...(extra ?? {}) });
  return reply.code(status).type("application/json").send(body);
}

function sendRepositoryError(
  reply: FastifyReply,
  error: { code: string },
) {
  switch (error.code) {
    case "engagement_not_found":
      return sendResumeError(reply, 404, "engagement_not_found");
    case "storage_busy":
      return sendResumeError(reply, 503, "storage_busy");
    default:
      return sendResumeError(reply, 500, "invalid_persisted_data");
  }
}

const RESUME_LIST_CAP = 200 as const;

type ResumeChangeInput = {
  kind: "note" | "finding" | "run" | "service" | "scope" | "ffuf" | "probe" | "artifact";
  id: string;
  at: string;
  summary: string;
  preEventRecord: boolean;
};

/**
 * STONE-6 resume routes. New engagement mutation surface (next step) plus a
 * read-only resume assembly from existing stores. Observations (services)
 * are projections, so they are labeled snapshot; lifecycle records (notes,
 * findings, runs, scope) are events. No fabricated timelines.
 */
export function registerEngagementResumeRoutes(
  app: FastifyInstance,
  deps: EngagementResumeRouteDeps,
): void {
  app.get("/api/v1/engagements/:engagementId/resume", async (request, reply) => {
    const params = EngagementIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendResumeError(reply, 400, "invalid_request");
    const parsedQuery = parseEngagementResumeQuery(request.query);
    if (!parsedQuery.ok) return sendResumeError(reply, 400, "invalid_request");
    const { engagementId } = params.data;

    let engagement: ReturnType<EngagementResumeRouteDeps["engagements"]["getEngagement"]>;
    try {
      engagement = deps.engagements.getEngagement(engagementId);
    } catch {
      return sendResumeError(reply, 500, "invalid_persisted_data");
    }
    if (!engagement.ok) return sendRepositoryError(reply, engagement.error);

    let stored: ReturnType<EngagementResumeRouteDeps["resume"]["getNextStep"]>;
    try {
      stored = deps.resume.getNextStep(engagementId);
    } catch {
      return sendResumeError(reply, 500, "invalid_persisted_data");
    }
    if (!stored.ok) return sendRepositoryError(reply, stored.error);

    const inputs: ResumeChangeInput[] = [];
    let truncated = false;
    try {
      const notes = deps.engagements.getEngagementNotes(engagementId);
      if (!notes.ok) return sendRepositoryError(reply, notes.error);
      if (notes.value.markdown.trim().length > 0) {
        inputs.push({
          kind: "note",
          id: "notes",
          at: notes.value.updatedAt,
          summary: "Engagement notes updated.",
          preEventRecord: false,
        });
      }
      if (deps.engagements.listFindings !== undefined) {
        const findings = deps.engagements.listFindings(engagementId);
        if (!findings.ok) return sendRepositoryError(reply, findings.error);
        if (findings.value.length > 50) truncated = true;
        for (const finding of findings.value.slice(0, 50)) {
          inputs.push({
            kind: "finding",
            id: finding.id,
            at: finding.createdAt,
            summary: `Finding recorded: ${finding.title}.`,
            preEventRecord: false,
          });
        }
      }
      if (deps.runs !== undefined) {
        const runs = deps.runs.listRunsForEngagement(engagementId, { limit: 50 });
        if (!runs.ok) return sendRepositoryError(reply, runs);
        if (runs.runs.length > 50) truncated = true;
        for (const run of runs.runs.slice(0, 50)) {
          inputs.push({
            kind: "run",
            id: run.id,
            at: run.updatedAt,
            summary: `Run ${run.id} ${run.state}.`,
            preEventRecord: false,
          });
        }
      }
      if (deps.services !== undefined) {
        const services = deps.services.listForEngagement(engagementId);
        if (!services.ok) return sendRepositoryError(reply, services);
        const validatedServices = EngagementServicesResponseSchema.safeParse(services.value);
        if (!validatedServices.success) return sendResumeError(reply, 500, "invalid_persisted_data");
        if (validatedServices.data.length > 50) truncated = true;
        for (const service of validatedServices.data.slice(0, 50)) {
          inputs.push({
            kind: "service",
            // Artifact id keeps the change id unique when several runs
            // observe the same address:port (duplicate React keys in
            // ResumeChangeList otherwise).
            id: `${service.address}:${service.port}:${service.artifactId}`,
            at: service.observedAt,
            summary: `Service observed at ${service.address}:${service.port}.`,
            preEventRecord: true,
          });
        }
      }
      const scopes = deps.engagements.listScopeRevisions(engagementId);
      if (!scopes.ok) return sendRepositoryError(reply, scopes.error);
      if (scopes.value.length > 20) truncated = true;
      for (const revision of scopes.value.slice(0, 20)) {
        inputs.push({
          kind: "scope",
          id: revision.id,
          at: revision.createdAt,
          summary: `Saved scope revision ${revision.version}.`,
          preEventRecord: false,
        });
      }
    } catch {
      return sendResumeError(reply, 500, "invalid_persisted_data");
    }

    const all = buildResumeChanges(inputs);
    const visible = changesSinceLastVisit(all, parsedQuery.value.since);
    const page = visible.slice(0, RESUME_LIST_CAP);
    const validated = EngagementResumeResponseSchema.safeParse({
      engagementId,
      nextStep: stored.value.nextStep,
      nextStepUpdatedAt: stored.value.revision === 0 ? null : stored.value.updatedAt,
      nextStepRevision: stored.value.revision,
      changes: page.map((change) => EngagementResumeChangeSchema.parse(change)),
      complete: truncated === false && visible.length <= RESUME_LIST_CAP,
    });
    if (!validated.success) return sendResumeError(reply, 500, "invalid_persisted_data");
    return reply.code(200).type("application/json").send(validated.data);
  });

  app.put("/api/v1/engagements/:engagementId/next-step", async (request, reply) => {
    const params = EngagementIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendResumeError(reply, 400, "invalid_request");
    const body = UpdateEngagementNextStepRequestSchema.safeParse(request.body);
    if (!body.success) return sendResumeError(reply, 400, "invalid_request");
    const { engagementId } = params.data;
    let result: ReturnType<EngagementResumeRouteDeps["resume"]["putNextStep"]>;
    try {
      result = deps.resume.putNextStep(engagementId, body.data);
    } catch {
      return sendResumeError(reply, 500, "invalid_persisted_data");
    }
    if (!result.ok) {
      switch (result.error.code) {
        case "engagement_not_found":
          return sendResumeError(reply, 404, "engagement_not_found");
        case "engagement_archived":
          return sendResumeError(reply, 409, "engagement_archived");
        case "revision_conflict":
          return sendResumeError(reply, 409, "revision_conflict", {
            resourceType: "engagement_next_step",
            resourceId: engagementId,
            currentRevision: result.error.currentRevision,
          });
        case "storage_busy":
          return sendResumeError(reply, 503, "storage_busy");
        default:
          return sendResumeError(reply, 400, "invalid_request");
      }
    }
    const validated = EngagementNextStepRecordSchema.safeParse(result.value);
    if (!validated.success) return sendResumeError(reply, 500, "invalid_persisted_data");
    return reply.code(200).type("application/json").send(validated.data);
  });
}
