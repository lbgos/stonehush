import {
  HealthResponseSchema,
  EngagementMutationErrorSchema,
  SYSTEM_STATUS_VERSION,
  SystemStatusResponseSchema,
  type Readiness,
} from "@stonehush/contracts";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import type {
  AdvisorTurnsRepository,
  EngagementRepository,
  EvidenceGrantRepository,
  ExcerptRepository,
  FfufRepository,
  HttpProbeRepository,
  NmapServiceRepository,
  OperatorCommandRepository,
  RunOutputRepository,
  RunRepository,
  RunnerRepository,
  SettingsRepository,
} from "@stonehush/db";

import { registerActionMutationRoutes } from "./action-mutation-routes.js";
import { registerActionRoutes } from "./action-routes.js";
import { registerArtifactDownloadRoutes } from "./artifact-download-routes.js";
import type { StorageQuiesceGate } from "./evidence/backup-lock.js";
import type { EvidencePublicationService } from "./evidence/evidence-publication.js";
import type { EvidenceStore } from "./evidence/evidence-store.js";
import { registerEngagementMutationRoutes } from "./engagement-mutation-routes.js";
import { registerEngagementNotesRoutes } from "./engagement-notes-routes.js";
import { registerEngagementRoutes } from "./engagement-routes.js";
import { registerExcerptRoutes } from "./excerpt-routes.js";
import { registerFindingRoutes } from "./finding-routes.js";
import { registerRunnerAuthHook, stripAuthorizationHeader } from "./runner-http.js";
import { registerRunnerEnrollmentRoutes } from "./runner-enrollment-routes.js";
import { registerRunnerControlRoutes } from "./runner-routes.js";
import { registerFfufRoutes } from "./ffuf-routes.js";
import { registerNmapServiceRoutes } from "./nmap-service-routes.js";
import { registerRunOutputRoutes } from "./run-output-routes.js";
import { registerRunHistoryRoutes } from "./run-history-routes.js";
import { registerRunnerEvidenceGrantRoutes } from "./runner-evidence-grant-routes.js";
import { registerRunnerEvidenceUploadRoutes } from "./runner-evidence-upload-routes.js";
import { registerHttpProbeRoutes } from "./http-probe-routes.js";
import { registerReportRoutes } from "./report-routes.js";
import { registerSettingsRoutes } from "./settings-routes.js";
import {
  registerAdvisorTurnRoutes,
  type AdvisorTurnRouteOptions,
} from "./advisor/advisor-turn-routes.js";
import {
  registerAdvisorStatusRoutes,
  type AdvisorStatusRouteOptions,
} from "./advisor-status-routes.js";

interface BuildAppOptions {
  getDevelopmentStorageReadiness: () => Readiness | Promise<Readiness>;
  engagementRepository: Pick<
    EngagementRepository,
    | "getEngagement"
    | "getFindingForEngagement"
    | "listEngagements"
    | "listScopeRevisions"
    | "getAction"
    | "retryActionContext"
    | "getEngagementNotes"
    | "putEngagementNotes"
  > &
    Partial<
      Pick<
        EngagementRepository,
        | "createFinding"
        | "listFindings"
        | "resolveFinding"
        | "reopenFinding"
        | "updateFinding"
        | "withWriteTx"
      >
    >;
  operatorCommandRepository?: Pick<
    OperatorCommandRepository,
    "executeOperatorCommand"
  >;
  runRepository?: Pick<
    RunRepository,
    "acquireLease" | "heartbeat" | "appendEvent" | "completeRun"
  >;
  runnerRepository?: Pick<
    RunnerRepository,
    | "authenticate"
    | "startEnrollmentChallenge"
    | "confirmEnrollment"
    | "revoke"
    | "acceptHandshake"
    | "requireAcceptedSession"
  >;
  evidenceGrantRepository?: Pick<
    EvidenceGrantRepository,
    "createGrant" | "publishedArtifactForEngagement"
  >;
  evidencePublication?: EvidencePublicationService;
  // Backup quiesce gate for grant admission; publication receives its own
  // gate instance from the runtime wiring.
  storageGate?: StorageQuiesceGate;
  // Operator artifact downloads are registered only when a verified managed
  // store is available; without it the route does not exist.
  evidenceStore?: Pick<EvidenceStore, "verifiedDownload" | "verifiedExcerpt" | "verifiedByteRange">;
  excerptRepository?: ExcerptRepository;
  nmapServiceRepository?: Pick<NmapServiceRepository, "listForEngagement">;
  settingsRepository?: Pick<
    SettingsRepository,
    | "getRunnerSettings"
    | "updateRunnerSettings"
    | "getAdvisorSettings"
    | "updateAdvisorSettings"
  >;
  advisorStatus?: Omit<AdvisorStatusRouteOptions, "repository">;
  advisorTurnsRepository?: Pick<
    AdvisorTurnsRepository,
    | "reserveOrReplay"
    | "completeTurn"
    | "listTurns"
    | "expireStalePending"
    | "lookupTurnByIdempotencyKey"
  >;
  advisorTurns?: Omit<
    AdvisorTurnRouteOptions,
    "engagements" | "turns" | "grants" | "store" | "settings"
  >;
  httpProbeRepository?: Pick<HttpProbeRepository, "listForEngagement">;
  ffufRepository?: Pick<FfufRepository, "listForEngagement">;
  runOutputRepository?: Pick<
    RunOutputRepository,
    | "latestTerminalRunForEngagement"
    | "runForEngagement"
    | "artifactsForRun"
    | "listArtifactsForEngagement"
    | "listRunsForEngagement"
  >;
  logger?: FastifyServerOptions["logger"];
  now?: () => Date;
}

export function buildApp({
  engagementRepository,
  getDevelopmentStorageReadiness,
  operatorCommandRepository,
  runRepository,
  runnerRepository,
  evidenceGrantRepository,
  evidencePublication,
  storageGate,
  evidenceStore,
  nmapServiceRepository,
  settingsRepository,
  advisorStatus,
  advisorTurnsRepository,
  advisorTurns,
  httpProbeRepository,
  ffufRepository,
  runOutputRepository,
  excerptRepository,
  logger = false,
  now,
}: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger:
      logger === false || logger === undefined
        ? false
        : {
            ...(typeof logger === "object" ? logger : {}),
            serializers: {
              ...(typeof logger === "object" ? logger.serializers : undefined),
              req(request) {
                return {
                  method: request.method,
                  url: request.url,
                  headers: stripAuthorizationHeader(
                    (request.headers ?? {}) as Record<string, unknown>,
                  ),
                };
              },
            },
          },
  });

  app.setErrorHandler((error, _request, reply) => {
    const clientError =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode < 500;
    return reply
      .code(clientError ? 400 : 500)
      .type("application/json")
      .send(
        EngagementMutationErrorSchema.parse({
          code: clientError ? "invalid_request" : "invalid_persisted_data",
        }),
      );
  });

  registerRunnerAuthHook(app, runnerRepository);
  registerEngagementRoutes(app, engagementRepository);
  registerEngagementNotesRoutes(app, engagementRepository);
  if (
    engagementRepository.createFinding !== undefined &&
    engagementRepository.listFindings !== undefined &&
    engagementRepository.resolveFinding !== undefined &&
    engagementRepository.reopenFinding !== undefined &&
    engagementRepository.updateFinding !== undefined
  ) {
    registerFindingRoutes(app, {
      createFinding: engagementRepository.createFinding.bind(engagementRepository),
      listFindings: engagementRepository.listFindings.bind(engagementRepository),
      resolveFinding: engagementRepository.resolveFinding.bind(engagementRepository),
      reopenFinding: engagementRepository.reopenFinding.bind(engagementRepository),
      updateFinding: engagementRepository.updateFinding.bind(engagementRepository),
    });
  }
  registerActionRoutes(app, engagementRepository);
  if (operatorCommandRepository !== undefined) {
    registerEngagementMutationRoutes(app, operatorCommandRepository);
    registerActionMutationRoutes(app, operatorCommandRepository);
    if (runnerRepository !== undefined) {
      registerRunnerEnrollmentRoutes(
        app,
        operatorCommandRepository,
        runnerRepository,
      );
    }
  }
  const withWriteTx = engagementRepository.withWriteTx;
  if (
    operatorCommandRepository !== undefined &&
    runRepository !== undefined &&
    runnerRepository !== undefined &&
    withWriteTx !== undefined
  ) {
    registerRunnerControlRoutes(app, {
      commandRepository: operatorCommandRepository,
      engagementRepository: {
        withWriteTx: withWriteTx.bind(engagementRepository),
      },
      runRepository,
      runnerRepository,
      ...(now === undefined ? {} : { now }),
    });
    if (evidenceGrantRepository !== undefined) {
      registerRunnerEvidenceGrantRoutes(app, {
        commandRepository: operatorCommandRepository,
        evidenceGrantRepository,
        ...(storageGate === undefined ? {} : { storageGate }),
      });
      if (evidencePublication !== undefined) {
        // Runner artifact uploads stream raw bytes. Without parseAs options
        // the parser receives the raw request stream and hands it to the
        // publication service untouched.
        app.addContentTypeParser("application/octet-stream", (_request, payload, done) => {
          done(null, payload);
        });
        registerRunnerEvidenceUploadRoutes(app, {
          publication: evidencePublication,
        });
      }
    }
  }

  if (evidenceStore !== undefined && evidenceGrantRepository !== undefined) {
    registerArtifactDownloadRoutes(app, {
      repository: evidenceGrantRepository,
      store: evidenceStore,
    });
  }
  if (nmapServiceRepository !== undefined) {
    registerNmapServiceRoutes(app, { repository: nmapServiceRepository });
  }
  if (settingsRepository !== undefined) {
    registerSettingsRoutes(app, { repository: settingsRepository });
    registerAdvisorStatusRoutes(app, { ...advisorStatus, repository: settingsRepository });
  }
  if (
    advisorTurnsRepository !== undefined &&
    settingsRepository !== undefined &&
    evidenceGrantRepository !== undefined &&
    evidenceStore !== undefined
  ) {
    registerAdvisorTurnRoutes(app, {
      ...advisorTurns,
      engagements: {
        getEngagement: engagementRepository.getEngagement.bind(engagementRepository),
        getFindingForEngagement: engagementRepository.getFindingForEngagement.bind(
          engagementRepository,
        ),
      },
      turns: advisorTurnsRepository,
      grants: evidenceGrantRepository,
      store: evidenceStore,
      settings: settingsRepository,
    });
  }
  if (httpProbeRepository !== undefined) {
    registerHttpProbeRoutes(app, { repository: httpProbeRepository });
  }
  if (ffufRepository !== undefined) {
    registerFfufRoutes(app, {
      results: ffufRepository,
      ...(operatorCommandRepository === undefined ? {} : { commands: operatorCommandRepository }),
    });
  }
  if (runOutputRepository !== undefined) {
    registerRunHistoryRoutes(app, {
      repository: runOutputRepository,
    });
  }
  if (
    evidenceStore !== undefined &&
    runOutputRepository !== undefined
  ) {
    registerRunOutputRoutes(app, {
      repository: runOutputRepository,
      store: evidenceStore,
    });
  }
  // STONE-3 fast capture. Additive: existing run-output and download routes
  // are untouched; excerpts, search, sources, and attachments live here.
  if (
    excerptRepository !== undefined &&
    evidenceGrantRepository !== undefined &&
    evidenceStore !== undefined &&
    runOutputRepository !== undefined
  ) {
    registerExcerptRoutes(app, {
      engagements: {
        getEngagement: engagementRepository.getEngagement.bind(engagementRepository),
      },
      excerpts: excerptRepository,
      runs: {
        runForEngagement: runOutputRepository.runForEngagement.bind(runOutputRepository),
        artifactsForRun: runOutputRepository.artifactsForRun.bind(runOutputRepository),
      },
      grants: evidenceGrantRepository,
      store: evidenceStore,
    });
  }
  const listFindings = engagementRepository.listFindings?.bind(engagementRepository);
  const listArtifactsForEngagement =
    runOutputRepository?.listArtifactsForEngagement?.bind(runOutputRepository);
  if (
    listFindings !== undefined &&
    nmapServiceRepository !== undefined &&
    httpProbeRepository !== undefined &&
    ffufRepository !== undefined &&
    listArtifactsForEngagement !== undefined
  ) {
    registerReportRoutes(app, {
      engagements: {
        getEngagement: engagementRepository.getEngagement.bind(engagementRepository),
        getEngagementNotes: engagementRepository.getEngagementNotes.bind(engagementRepository),
        listFindings,
      },
      services: nmapServiceRepository,
      probes: httpProbeRepository,
      ffuf: ffufRepository,
      outputs: {
        listArtifactsForEngagement,
      },
      ...(now === undefined ? {} : { now }),
    });
  }

  app.get("/health", async (_request, reply) => {
    const health = HealthResponseSchema.parse({ status: "ok" });
    return reply.code(200).type("application/json").send(health);
  });

  app.get("/api/v1/system/status", async (_request, reply) => {
    let developmentStorage: Readiness;
    try {
      developmentStorage = await getDevelopmentStorageReadiness();
    } catch {
      developmentStorage = "not_ready";
    }
    const status = SystemStatusResponseSchema.parse({
      version: SYSTEM_STATUS_VERSION,
      overall: developmentStorage,
      developmentStorage,
    });
    return reply
      .code(status.overall === "ready" ? 200 : 503)
      .type("application/json")
      .send(status);
  });

  return app;
}
