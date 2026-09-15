import {
  decodeRunHistoryCursor,
  encodeRunHistoryCursor,
  parseRunHistoryQuery,
  RunHistoryErrorSchema,
  RunHistoryParamsSchema,
  RunHistoryResponseSchema,
} from "@stonehush/contracts";
import type { RunOutputRepository } from "@stonehush/db";
import type { FastifyInstance, FastifyReply } from "fastify";

export interface RunHistoryDependencies {
  readonly repository: Pick<RunOutputRepository, "listRunsForEngagement">;
}

function sendHistoryError(reply: FastifyReply, status: number, code: string) {
  const body = RunHistoryErrorSchema.parse({ code });
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

export function registerRunHistoryRoutes(
  app: FastifyInstance,
  dependencies: RunHistoryDependencies,
): void {
  app.get(
    "/api/v1/engagements/:engagementId/runs",
    { exposeHeadRoute: false },
    async (request, reply) => {
      const params = RunHistoryParamsSchema.safeParse(request.params);
      if (!params.success) return sendHistoryError(reply, 400, "invalid_request");
      const parsedQuery = parseRunHistoryQuery(request.query);
      if (!parsedQuery.ok) return sendHistoryError(reply, 400, "invalid_request");
      const engagementId = params.data.engagementId;
      let before: { createdAt: string; id: string } | undefined;
      if (parsedQuery.value.before !== undefined) {
        const decoded = decodeRunHistoryCursor(
          parsedQuery.value.before,
          engagementId,
        );
        if (!decoded.ok) return sendHistoryError(reply, 400, "invalid_request");
        before = decoded.value;
      }
      const limit = parsedQuery.value.limit;
      let listed: ReturnType<RunOutputRepository["listRunsForEngagement"]>;
      try {
        listed =
          before === undefined
            ? dependencies.repository.listRunsForEngagement(engagementId, { limit })
            : dependencies.repository.listRunsForEngagement(engagementId, {
                limit,
                before,
              });
      } catch (error) {
        if (isStorageBusy(error)) return sendHistoryError(reply, 503, "storage_busy");
        return sendHistoryError(reply, 500, "invalid_persisted_data");
      }
      if (!listed.ok) {
        if (listed.code === "engagement_not_found") {
          return sendHistoryError(reply, 404, "engagement_not_found");
        }
        if (listed.code === "storage_busy") {
          return sendHistoryError(reply, 503, "storage_busy");
        }
        return sendHistoryError(reply, 500, "invalid_persisted_data");
      }
      const hasMore = listed.runs.length > limit;
      const page = hasMore ? listed.runs.slice(0, limit) : listed.runs;
      const summaries = page.map((run) => ({
        id: run.id,
        actionId: run.actionId,
        state: run.state,
        terminalKind: run.terminalKind,
        terminalReason: run.terminalReason,
        updatedAt: run.updatedAt,
        createdAt: run.createdAt,
        attempt: run.attempt,
      }));
      const last = summaries[summaries.length - 1];
      const nextCursor =
        hasMore && last !== undefined
          ? encodeRunHistoryCursor({
              engagementId,
              createdAt: last.createdAt,
              id: last.id,
            })
          : null;
      const validated = RunHistoryResponseSchema.safeParse({
        runs: summaries,
        nextCursor,
      });
      if (!validated.success) {
        return sendHistoryError(reply, 500, "invalid_persisted_data");
      }
      return reply.code(200).type("application/json").send(validated.data);
    },
  );
}
