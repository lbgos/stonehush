import {
  EngagementIdParamsSchema,
  ReportBundleSchema,
  ReportFormatQuerySchema,
  ReportQueryErrorSchema,
  capReportRows,
  engagementReportMarkdown,
  type ReportBundle,
} from "@stonehush/contracts";
import type {
  EngagementRepository,
  FfufRepository,
  HttpProbeRepository,
  NmapServiceRepository,
  RunOutputRepository,
} from "@stonehush/db";
import type { FastifyInstance, FastifyReply } from "fastify";

export interface ReportRouteDependencies {
  readonly engagements: Pick<
    EngagementRepository,
    "getEngagement" | "getEngagementNotes" | "listFindings"
  >;
  readonly services: Pick<NmapServiceRepository, "listForEngagement">;
  readonly probes: Pick<HttpProbeRepository, "listForEngagement">;
  readonly ffuf: Pick<FfufRepository, "listForEngagement">;
  readonly outputs: Pick<RunOutputRepository, "listArtifactsForEngagement">;
  readonly now?: () => Date;
}

function sendQueryError(
  reply: FastifyReply,
  status: 400 | 404 | 500 | 503,
  code: string,
) {
  return reply
    .code(status)
    .type("application/json")
    .send(ReportQueryErrorSchema.parse({ code }));
}

export function registerReportRoutes(
  app: FastifyInstance,
  dependencies: ReportRouteDependencies,
): void {
  const { engagements, services, probes, ffuf, outputs } = dependencies;
  const now = dependencies.now ?? (() => new Date());

  app.get("/api/v1/engagements/:engagementId/report", async (request, reply) => {
    const params = EngagementIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendQueryError(reply, 400, "invalid_request");
    const query = ReportFormatQuerySchema.safeParse(request.query);
    if (!query.success) return sendQueryError(reply, 400, "invalid_request");
    const { engagementId } = params.data;

    let bundle: ReportBundle;
    try {
      bundle = buildReportBundle(engagementId, {
        engagements,
        services,
        probes,
        ffuf,
        outputs,
        generatedAt: now().toISOString(),
      });
    } catch (error) {
      const code =
        error instanceof ReportBuildError ? error.code : "invalid_persisted_data";
      if (code === "engagement_not_found") return sendQueryError(reply, 404, code);
      if (code === "storage_busy") return sendQueryError(reply, 503, code);
      return sendQueryError(reply, 500, "invalid_persisted_data");
    }
    const validated = ReportBundleSchema.safeParse(bundle);
    if (!validated.success) return sendQueryError(reply, 500, "invalid_persisted_data");

    if (query.data.format === "markdown") {
      const markdown = engagementReportMarkdown(validated.data);
      return reply
        .code(200)
        .header("content-type", "text/markdown; charset=utf-8")
        .header(
          "content-disposition",
          `attachment; filename="engagement-${engagementId}-report.md"`,
        )
        .header("cache-control", "private, no-store")
        .send(markdown);
    }
    return reply.code(200).type("application/json").send(validated.data);
  });
}

type ReportBuildInputs = Pick<
  ReportRouteDependencies,
  "engagements" | "services" | "probes" | "ffuf" | "outputs"
> & { readonly generatedAt: string };

class ReportBuildError extends Error {
  readonly code: "engagement_not_found" | "storage_busy" | "invalid_persisted_data";

  constructor(code: ReportBuildError["code"]) {
    super(code);
    this.code = code;
  }
}

function throwForCode(code: string): never {
  if (code === "engagement_not_found") throw new ReportBuildError(code);
  if (code === "storage_busy") throw new ReportBuildError(code);
  throw new ReportBuildError("invalid_persisted_data");
}

// Read-only assembly: every lookup tolerates archived engagements; only
// unknown engagements fail. Rows keep repository order into the cap.
function buildReportBundle(
  engagementId: string,
  inputs: ReportBuildInputs,
): ReportBundle {
  const detail = inputs.engagements.getEngagement(engagementId);
  if (!detail.ok) throwForCode(detail.error.code);
  const notes = inputs.engagements.getEngagementNotes(engagementId);
  if (!notes.ok) throwForCode(notes.error.code);
  const findings = inputs.engagements.listFindings(engagementId);
  if (!findings.ok) throwForCode(findings.error.code);
  const serviceRows = inputs.services.listForEngagement(engagementId);
  if (!serviceRows.ok) throwForCode(serviceRows.code);
  const probeRows = inputs.probes.listForEngagement(engagementId);
  if (!probeRows.ok) throwForCode(probeRows.code);
  const ffufRows = inputs.ffuf.listForEngagement(engagementId);
  if (!ffufRows.ok) throwForCode(ffufRows.code);
  const artifactRows = inputs.outputs.listArtifactsForEngagement(engagementId);
  if (!artifactRows.ok) throwForCode(artifactRows.code);

  const engagement = detail.value.engagement;
  const evidenceRows = artifactRows.artifacts.map((artifact) => ({
    artifactId: artifact.artifactId,
    digest: artifact.digest,
    sizeBytes: artifact.sizeBytes,
    kind: artifact.kind,
    completeness: artifact.completeness,
    runId: artifact.runId,
  }));

  return {
    contractVersion: 1,
    engagement: {
      id: engagement.id,
      name: engagement.name,
      kind: engagement.kind,
      status: engagement.status,
      description: engagement.description,
      authorizationContext: engagement.authorizationContext,
      deadlineAt: engagement.deadlineAt,
      revision: engagement.revision,
      createdAt: engagement.createdAt,
      updatedAt: engagement.updatedAt,
    },
    findings: findings.value,
    notesMarkdown: notes.value.markdown,
    notesUpdatedAt: notes.value.updatedAt,
    services: capReportRows(serviceRows.value) as ReportBundle["services"],
    probes: capReportRows(probeRows.value) as ReportBundle["probes"],
    ffufResults: capReportRows(ffufRows.value) as ReportBundle["ffufResults"],
    evidenceArtifacts: capReportRows(evidenceRows) as ReportBundle["evidenceArtifacts"],
    generatedAt: inputs.generatedAt,
  };
}
