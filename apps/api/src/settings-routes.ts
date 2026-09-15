import {
  GetAdvisorSettingsResponseSchema,
  GetSettingsResponseSchema,
  UpdateAdvisorSettingsRequestSchema,
  UpdateSettingsRequestSchema,
} from "@stonehush/contracts";
import type { SettingsRepository } from "@stonehush/db";
import type { FastifyInstance, FastifyReply } from "fastify";

type SettingsStore = Pick<
  SettingsRepository,
  | "getRunnerSettings"
  | "updateRunnerSettings"
  | "getAdvisorSettings"
  | "updateAdvisorSettings"
>;

function sendError(reply: FastifyReply, status: number, code: string) {
  return reply.code(status).type("application/json").send({ code });
}

export function registerSettingsRoutes(app: FastifyInstance, deps: { repository: SettingsStore }) {
  app.get("/api/v1/settings/runner", async (_request, reply) => {
    let result: ReturnType<SettingsRepository["getRunnerSettings"]>;
    try {
      result = deps.repository.getRunnerSettings();
    } catch {
      return sendError(reply, 500, "invalid_persisted_data");
    }
    if (!result.ok) {
      if (result.error.code === "storage_busy") return sendError(reply, 503, "storage_busy");
      return sendError(reply, 500, "invalid_persisted_data");
    }
    const validated = GetSettingsResponseSchema.safeParse(result.value);
    if (!validated.success) return sendError(reply, 500, "invalid_persisted_data");
    return reply.code(200).type("application/json").send(validated.data);
  });

  app.put("/api/v1/settings/runner", async (request, reply) => {
    const body = UpdateSettingsRequestSchema.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, "invalid_request");
    let result: ReturnType<SettingsRepository["updateRunnerSettings"]>;
    try {
      result = deps.repository.updateRunnerSettings(body.data);
    } catch {
      return sendError(reply, 500, "invalid_persisted_data");
    }
    if (!result.ok) {
      if (result.error.code === "storage_busy") return sendError(reply, 503, "storage_busy");
      if (result.error.code === "invalid_persisted_data") {
        return sendError(reply, 500, "invalid_persisted_data");
      }
      return sendError(reply, 400, "invalid_request");
    }
    const validated = GetSettingsResponseSchema.safeParse(result.value);
    if (!validated.success) return sendError(reply, 500, "invalid_persisted_data");
    return reply.code(200).type("application/json").send(validated.data);
  });

  // Advisor scope. Only the env var name is persisted and served; the key
  // itself resolves from the environment at request time and is never logged
  // or echoed here.
  app.get("/api/v1/settings/advisor", async (_request, reply) => {
    let result: ReturnType<SettingsRepository["getAdvisorSettings"]>;
    try {
      result = deps.repository.getAdvisorSettings();
    } catch {
      return sendError(reply, 500, "invalid_persisted_data");
    }
    if (!result.ok) {
      if (result.error.code === "storage_busy") return sendError(reply, 503, "storage_busy");
      return sendError(reply, 500, "invalid_persisted_data");
    }
    const validated = GetAdvisorSettingsResponseSchema.safeParse(result.value);
    if (!validated.success) return sendError(reply, 500, "invalid_persisted_data");
    return reply.code(200).type("application/json").send(validated.data);
  });

  app.put("/api/v1/settings/advisor", async (request, reply) => {
    const body = UpdateAdvisorSettingsRequestSchema.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, "invalid_request");
    let result: ReturnType<SettingsRepository["updateAdvisorSettings"]>;
    try {
      result = deps.repository.updateAdvisorSettings(body.data);
    } catch {
      return sendError(reply, 500, "invalid_persisted_data");
    }
    if (!result.ok) {
      if (result.error.code === "storage_busy") return sendError(reply, 503, "storage_busy");
      if (result.error.code === "invalid_persisted_data") {
        return sendError(reply, 500, "invalid_persisted_data");
      }
      return sendError(reply, 400, "invalid_request");
    }
    const validated = GetAdvisorSettingsResponseSchema.safeParse(result.value);
    if (!validated.success) return sendError(reply, 500, "invalid_persisted_data");
    return reply.code(200).type("application/json").send(validated.data);
  });
}
