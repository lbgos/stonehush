import { AdvisorStatusSchema, type AdvisorStatus } from "@stonehush/contracts";
import type { SettingsRepository } from "@stonehush/db";
import type { FastifyInstance, FastifyReply } from "fastify";

import {
  ADVISOR_PROBE_TIMEOUT_MS,
  classifyAdvisorEndpointHost,
  probeAdvisorEndpoint,
} from "./advisor-status-probe.js";

type AdvisorSettingsStore = Pick<SettingsRepository, "getAdvisorSettings">;

export interface AdvisorStatusRouteOptions {
  env?: NodeJS.ProcessEnv;
  probe?: typeof probeAdvisorEndpoint;
  probeTimeoutMs?: number;
  repository: AdvisorSettingsStore;
  statusTimeoutMs?: number;
}

export const ADVISOR_STATUS_TIMEOUT_MS = 6_000;

function sendError(reply: FastifyReply, status: number, code: string) {
  return reply.code(status).type("application/json").send({ code });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

function stripIpv6Brackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

export function registerAdvisorStatusRoutes(
  app: FastifyInstance,
  options: AdvisorStatusRouteOptions,
) {
  const probe = options.probe ?? probeAdvisorEndpoint;
  const probeTimeoutMs = options.probeTimeoutMs ?? ADVISOR_PROBE_TIMEOUT_MS;
  const statusTimeoutMs = options.statusTimeoutMs ?? ADVISOR_STATUS_TIMEOUT_MS;

  app.get("/api/v1/advisor/status", async (_request, reply) => {
    let stored: ReturnType<SettingsRepository["getAdvisorSettings"]>;
    try {
      stored = options.repository.getAdvisorSettings();
    } catch {
      return sendError(reply, 500, "invalid_persisted_data");
    }
    if (!stored.ok) {
      if (stored.error.code === "storage_busy") return sendError(reply, 503, "storage_busy");
      return sendError(reply, 500, "invalid_persisted_data");
    }
    const settings = stored.value;

    const base = {
      modelId: settings.modelId,
      endpointHost: "",
      publicEndpoint: false,
      optIn: settings.publicEndpointOptIn,
      keyEnvVar: settings.apiKeyEnvVar,
      keyPresent: false as boolean,
      latencyMs: null as number | null,
    };

    const sendStatus = (status: AdvisorStatus) => {
      const validated = AdvisorStatusSchema.safeParse(status);
      if (!validated.success) return sendError(reply, 500, "invalid_persisted_data");
      return reply.code(200).type("application/json").send(validated.data);
    };

    // No endpoint or model stored: nothing to test.
    if (settings.endpointBaseUrl === "" || settings.modelId === "") {
      return sendStatus({
        ...base,
        configured: false,
        endpointReachable: null,
        reason: "unconfigured",
      });
    }

    // Classify the endpoint host early. This is pure string handling with no
    // network call, so every later reason can report it truthfully.
    let endpointHost = "";
    let publicEndpoint = false;
    let endpointParsable = false;
    try {
      const endpoint = new URL(settings.endpointBaseUrl);
      if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
        throw new Error("unsupported advisor endpoint protocol");
      }
      endpointHost = stripIpv6Brackets(endpoint.hostname);
      publicEndpoint = classifyAdvisorEndpointHost(endpoint.hostname) === "public";
      endpointParsable = true;
    } catch {
      endpointParsable = false;
    }

    // An empty env var reference means the operator runs without a key: no
    // auth to resolve, so reachability is tested with keyPresent false. The
    // probe sends a bare GET with no Authorization header in every case. A
    // nonempty reference that is unset remains an explicit key_unset failure.
    let keyPresent = false;
    if (settings.apiKeyEnvVar !== "") {
      // Resolve the key from the environment by NAME ONLY at request time.
      // The value is checked for presence and then dropped: it is never
      // stored, never logged, and never echoed. Only present/absent leaves.
      const environment = options.env ?? process.env;
      const keyValue = environment[settings.apiKeyEnvVar];
      keyPresent = typeof keyValue === "string" && keyValue.length > 0;
      if (!keyPresent) {
        return sendStatus({
          ...base,
          configured: true,
          endpointHost,
          endpointReachable: null,
          publicEndpoint,
          reason: "key_unset",
        });
      }
    }

    if (!endpointParsable) {
      return sendStatus({
        ...base,
        configured: true,
        endpointReachable: false,
        keyPresent,
        reason: "probe_failed",
      });
    }

    // D6: a public endpoint without explicit opt-in is reported WITHOUT any
    // network call. This return happens before the probe by construction.
    if (publicEndpoint && !settings.publicEndpointOptIn) {
      return sendStatus({
        ...base,
        configured: true,
        endpointHost,
        endpointReachable: null,
        keyPresent,
        publicEndpoint: true,
        reason: "public_not_opted_in",
      });
    }

    const outcome = await Promise.race([
      probe(settings.endpointBaseUrl, { timeoutMs: probeTimeoutMs }).then(
        (result) => ({ probed: true as const, result }),
      ),
      delay(Math.max(1, statusTimeoutMs)).then(() => ({ probed: false as const })),
    ]);
    if (!outcome.probed) {
      return sendStatus({
        ...base,
        configured: true,
        endpointHost,
        endpointReachable: false,
        keyPresent,
        publicEndpoint,
        reason: "probe_failed",
      });
    }
    return sendStatus({
      ...base,
      configured: true,
      endpointHost,
      endpointReachable: outcome.result.reachable,
      keyPresent,
      latencyMs: outcome.result.latencyMs,
      publicEndpoint,
      reason: outcome.result.reachable ? "ok" : "unreachable",
    });
  });
}
