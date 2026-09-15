import {
  LatestRunOutputParamsSchema,
  RUN_OUTPUT_MAX_BYTES,
  RunOutputErrorSchema,
  RunOutputParamsSchema,
  RunOutputResponseSchema,
  type RunOutputResponse,
} from "@stonehush/contracts";
import type { RunOutputRepository } from "@stonehush/db";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { EvidenceStore } from "./evidence/evidence-store.js";

export interface RunOutputDependencies {
  readonly repository: Pick<
    RunOutputRepository,
    "latestTerminalRunForEngagement" | "runForEngagement" | "artifactsForRun"
  >;
  readonly store: Pick<EvidenceStore, "verifiedExcerpt">;
}

type OutputErrorCode = Extract<
  { code: string },
  unknown
> extends never
  ? never
  : string;

function sendOutputError(reply: FastifyReply, status: number, code: string) {
  const body = RunOutputErrorSchema.parse({ code });
  return reply.code(status).type("application/json").send(body);
}

function isStorageBusy(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "SQLITE_BUSY" || error.code === "SQLITE_BUSY_TIMEOUT")
  );
}

function decodeExcerpt(content: Buffer): string {
  return content.toString("utf8");
}

async function buildStream(
  artifacts: readonly {
    artifactId: string;
    kind: string;
    sizeBytes: number;
    digest: string;
    completeness: "complete" | "partial" | "truncated";
  }[],
  kind: "stdout" | "stderr",
  store: Pick<EvidenceStore, "verifiedExcerpt">,
): Promise<
  | { ok: true; value: RunOutputResponse["stdout"] }
  | { ok: false; code: "missing_artifact" | "corrupt_artifact" }
> {
  const matches = artifacts.filter((artifact) => artifact.kind === kind);
  if (matches.length === 0) {
    return { ok: true, value: { present: false, truncated: false, content: "" } };
  }
  matches.sort((left, right) => {
    if (left.sizeBytes !== right.sizeBytes) return right.sizeBytes - left.sizeBytes;
    return left.artifactId < right.artifactId ? -1 : 1;
  });
  const selected = matches[0];
  if (selected === undefined) {
    return { ok: true, value: { present: false, truncated: false, content: "" } };
  }
  let excerpt: Awaited<ReturnType<EvidenceStore["verifiedExcerpt"]>>;
  try {
    excerpt = await store.verifiedExcerpt({
      artifactId: selected.artifactId,
      expectedSizeBytes: selected.sizeBytes,
      expectedDigest: selected.digest,
      maxBytes: RUN_OUTPUT_MAX_BYTES,
    });
  } catch {
    return { ok: false, code: "corrupt_artifact" };
  }
  if (excerpt.status === "missing") return { ok: false, code: "missing_artifact" };
  if (excerpt.status === "corrupt") return { ok: false, code: "corrupt_artifact" };
  const content = decodeExcerpt(excerpt.content);
  const value = {
    present: true as const,
    artifactId: selected.artifactId,
    sizeBytes: selected.sizeBytes,
    digest: selected.digest,
    completeness: selected.completeness,
    truncated: excerpt.truncated,
    content,
  };
  return { ok: true, value };
}

async function respondForRun(
  reply: FastifyReply,
  dependencies: RunOutputDependencies,
  run: {
    id: string;
    actionId: string;
    state: "queued" | "leased" | "running" | "cancel_requested" | "succeeded" | "failed" | "cancelled";
    terminalKind: "succeeded" | "failed" | "cancelled" | null;
    terminalReason: string | null;
    updatedAt: string;
  },
) {
  let artifactsResult: ReturnType<RunOutputRepository["artifactsForRun"]>;
  try {
    artifactsResult = dependencies.repository.artifactsForRun(run.id);
  } catch (error) {
    if (isStorageBusy(error)) return sendOutputError(reply, 503, "storage_busy");
    return sendOutputError(reply, 500, "invalid_persisted_data");
  }
  if (!artifactsResult.ok) {
    if (artifactsResult.code === "storage_busy") {
      return sendOutputError(reply, 503, "storage_busy");
    }
    return sendOutputError(reply, 500, "invalid_persisted_data");
  }
  const stdout = await buildStream(artifactsResult.artifacts, "stdout", dependencies.store);
  if (!stdout.ok) {
    return sendOutputError(reply, 409, stdout.code);
  }
  const stderr = await buildStream(artifactsResult.artifacts, "stderr", dependencies.store);
  if (!stderr.ok) {
    return sendOutputError(reply, 409, stderr.code);
  }
  const payload = {
    run: {
      id: run.id,
      actionId: run.actionId,
      state: run.state,
      terminalKind: run.terminalKind,
      terminalReason: run.terminalReason,
      updatedAt: run.updatedAt,
    },
    stdout: stdout.value,
    stderr: stderr.value,
  };
  const validated = RunOutputResponseSchema.safeParse(payload);
  if (!validated.success) {
    return sendOutputError(reply, 500, "invalid_persisted_data");
  }
  return reply.code(200).type("application/json").send(validated.data);
}

export function registerRunOutputRoutes(
  app: FastifyInstance,
  dependencies: RunOutputDependencies,
): void {
  app.get(
    "/api/v1/engagements/:engagementId/runs/latest/output",
    { exposeHeadRoute: false },
    async (request, reply) => {
      if (request.headers.range !== undefined) {
        return sendOutputError(reply, 400, "invalid_request");
      }
      const params = LatestRunOutputParamsSchema.safeParse(request.params);
      if (!params.success) return sendOutputError(reply, 400, "invalid_request");
      let latest: ReturnType<RunOutputRepository["latestTerminalRunForEngagement"]>;
      try {
        latest = dependencies.repository.latestTerminalRunForEngagement(
          params.data.engagementId,
        );
      } catch (error) {
        if (isStorageBusy(error)) return sendOutputError(reply, 503, "storage_busy");
        return sendOutputError(reply, 500, "invalid_persisted_data");
      }
      if (!latest.ok) {
        if (latest.code === "engagement_not_found") {
          return sendOutputError(reply, 404, "engagement_not_found");
        }
        if (latest.code === "storage_busy") {
          return sendOutputError(reply, 503, "storage_busy");
        }
        return sendOutputError(reply, 500, "invalid_persisted_data");
      }
      if (latest.run === undefined) {
        return sendOutputError(reply, 404, "no_terminal_run");
      }
      return respondForRun(reply, dependencies, latest.run);
    },
  );

  app.get(
    "/api/v1/engagements/:engagementId/runs/:runId/output",
    { exposeHeadRoute: false },
    async (request, reply) => {
      if (request.headers.range !== undefined) {
        return sendOutputError(reply, 400, "invalid_request");
      }
      const params = RunOutputParamsSchema.safeParse(request.params);
      if (!params.success) return sendOutputError(reply, 400, "invalid_request");
      let found: ReturnType<RunOutputRepository["runForEngagement"]>;
      try {
        found = dependencies.repository.runForEngagement(
          params.data.engagementId,
          params.data.runId,
        );
      } catch (error) {
        if (isStorageBusy(error)) return sendOutputError(reply, 503, "storage_busy");
        return sendOutputError(reply, 500, "invalid_persisted_data");
      }
      if (!found.ok) {
        if (found.code === "engagement_not_found") {
          return sendOutputError(reply, 404, "engagement_not_found");
        }
        if (found.code === "storage_busy") {
          return sendOutputError(reply, 503, "storage_busy");
        }
        return sendOutputError(reply, 500, "invalid_persisted_data");
      }
      if (found.run === undefined) {
        return sendOutputError(reply, 404, "run_not_found");
      }
      if (
        found.run.state !== "succeeded" &&
        found.run.state !== "failed" &&
        found.run.state !== "cancelled"
      ) {
        return sendOutputError(reply, 404, "run_not_found");
      }
      return respondForRun(reply, dependencies, found.run);
    },
  );
}

export type { OutputErrorCode };
