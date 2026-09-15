import {
  AdvisorExplanationSchema,
  AdvisorTurnErrorSchema,
  AdvisorTurnIdParamsSchema,
  AdvisorTurnListResponseSchema,
  AdvisorTurnSchema,
  CreateAdvisorTurnRequestSchema,
  commandJsonV1CreateAdvisorTurnDigest,
  parseAdvisorTurnListQuery,
  projectCommandJsonV1DigestInput,
  type AdvisorTurn,
} from "@stonehush/contracts";
import type {
  AdvisorTurnRecord,
  AdvisorTurnsRepository,
  EngagementRepository,
  EvidenceGrantRepository,
  SettingsRepository,
} from "@stonehush/db";
import {
  partitionAdvisorCitations,
  redactAdvisorText,
  truncateUtf8Bytes,
} from "@stonehush/domain";
import type { FastifyInstance, FastifyReply } from "fastify";

import {
  assembleAdvisorContext,
  type AdvisorContextDeps,
} from "./advisor-context.js";
import { classifyAdvisorEndpointHost } from "../advisor-status-probe.js";
import {
  postAdvisorChatCompletion,
  type AdvisorTransportErrorCode,
  type AdvisorTransportRequestFn,
} from "./advisor-transport.js";
import type { EvidenceStore } from "../evidence/evidence-store.js";
import {
  parseBoundedDigestInput,
  prepareLocalOperatorCommand,
  readIdempotencyKey,
} from "../operator-command.js";

export interface AdvisorTurnRouteDeps {
  engagements: Pick<EngagementRepository, "getEngagement" | "getFindingForEngagement">;
  turns: Pick<
    AdvisorTurnsRepository,
    | "reserveOrReplay"
    | "completeTurn"
    | "listTurns"
    | "expireStalePending"
    | "lookupTurnByIdempotencyKey"
  >;
  grants: Pick<EvidenceGrantRepository, "publishedArtifactForEngagement">;
  store: Pick<EvidenceStore, "verifiedExcerpt">;
  settings: Pick<SettingsRepository, "getAdvisorSettings">;
  transport?: { requestFn?: AdvisorTransportRequestFn };
  env?: NodeJS.ProcessEnv;
}

export type AdvisorTurnRouteOptions = Omit<
  AdvisorTurnRouteDeps,
  "engagements" | "turns" | "grants" | "store" | "settings"
>;

type ErrorCode =
  | "invalid_request"
  | "engagement_not_found"
  | "engagement_archived"
  | "idempotency_conflict"
  | "turn_in_progress"
  | "turn_not_found"
  | "unknown_artifact"
  | "unknown_finding"
  | "missing_artifact"
  | "corrupt_artifact"
  | "context_too_large"
  | "advisor_unconfigured"
  | "missing_key_env"
  | "key_unset"
  | "public_not_opted_in"
  | "storage_busy"
  | "invalid_persisted_data";

function sendError(reply: FastifyReply, status: number, code: ErrorCode) {
  return reply
    .code(status)
    .type("application/json")
    .send(AdvisorTurnErrorSchema.parse({ code }));
}

function sendRepositoryError(
  reply: FastifyReply,
  code: string,
  statuses: { notFound?: number } = {},
): ReturnType<FastifyReply["send"]> | undefined {
  switch (code) {
    case "engagement_not_found":
    case "turn_not_found":
    case "unknown_artifact":
    case "unknown_finding":
    case "missing_artifact":
      return sendError(reply, statuses.notFound ?? 404, code as ErrorCode);
    case "engagement_archived":
    case "idempotency_conflict":
      return sendError(reply, 409, code as ErrorCode);
    case "storage_busy":
      return sendError(reply, 503, code);
    default:
      return sendError(reply, 500, "invalid_persisted_data");
  }
}

function toAdvisorTurnResponse(record: AdvisorTurnRecord): AdvisorTurn | undefined {
  const partition = partitionAdvisorCitations(record.suppliedIds, record.citations);
  const citations = [
    ...partition.valid.map((entry) => ({ raw: entry.raw, valid: true as const, kind: entry.kind })),
    ...partition.invalid.map((raw) => ({ raw, valid: false as const, kind: "unknown" as const })),
  ];
  const parsed = AdvisorTurnSchema.safeParse({
    id: record.id,
    engagementId: record.engagementId,
    status: record.status,
    question: record.question,
    modelId: record.modelId,
    redactions: record.redactions,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    answer: record.answer,
    uncertainty: record.uncertainty,
    citations,
    abstained: record.abstained,
    errorCode: record.errorCode,
  });
  return parsed.success ? parsed.data : undefined;
}

function sendTurn(reply: FastifyReply, record: AdvisorTurnRecord) {
  const response = toAdvisorTurnResponse(record);
  if (response === undefined) return sendError(reply, 500, "invalid_persisted_data");
  return reply.code(200).type("application/json").send(response);
}

function transportFailureToCompletion(error: { code: AdvisorTransportErrorCode }):
  | { status: "cancelled" }
  | { status: "provider_error"; errorCode: "provider_timeout" | "provider_unreachable" | "provider_response_too_large" | "provider_redirect_rejected" }
  | { status: "parse_error"; errorCode: "provider_parse_error" } {
  switch (error.code) {
    case "cancelled":
      return { status: "cancelled" };
    case "provider_timeout":
      return { status: "provider_error", errorCode: "provider_timeout" };
    case "response_too_large":
      return { status: "provider_error", errorCode: "provider_response_too_large" };
    case "redirect_rejected":
      return { status: "provider_error", errorCode: "provider_redirect_rejected" };
    case "malformed_response":
      return { status: "parse_error", errorCode: "provider_parse_error" };
    default:
      return { status: "provider_error", errorCode: "provider_unreachable" };
  }
}

const HISTORY_TURNS = 10;
const HISTORY_PAGES = 3;
const HISTORY_PAGE_SIZE = 50;
const HISTORY_FIELD_BYTES = 2_000;

export function registerAdvisorTurnRoutes(app: FastifyInstance, deps: AdvisorTurnRouteDeps): void {
  const contextDeps: AdvisorContextDeps = {
    engagements: deps.engagements,
    artifacts: deps.grants,
    excerpts: deps.store,
  };

  app.post("/api/v1/engagements/:engagementId/advisor/turns", async (request, reply) => {
    // Mutation guard: a single valid key header is required before
    // any write path is reachable. The key validates idempotency only;
    // loopback binding at the server boundary is the network control.
    const key = readIdempotencyKey(request);
    if (key === undefined) return sendError(reply, 400, "invalid_request");
    const params = AdvisorTurnIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "invalid_request");
    const body = CreateAdvisorTurnRequestSchema.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, "invalid_request");
    const { engagementId } = params.data;
    if (body.data.engagementId !== engagementId) {
      return sendError(reply, 400, "invalid_request");
    }

    let engagement: { status: string };
    try {
      const result = deps.engagements.getEngagement(engagementId);
      if (!result.ok) {
        const mapped = sendRepositoryError(reply, result.error.code);
        if (mapped !== undefined) return mapped;
        return sendError(reply, 500, "invalid_persisted_data");
      }
      engagement = result.value.engagement;
    } catch {
      return sendError(reply, 500, "invalid_persisted_data");
    }
    if (engagement.status === "archived") {
      return sendError(reply, 409, "engagement_archived");
    }

    // Canonical digest over the concrete path plus the explicit ordered
    // request only. Model, settings, and history stay out so retries
    // survive drift; array order is preserved.
    const route = `/api/v1/engagements/${engagementId}/advisor/turns`;
    const path = parseBoundedDigestInput({ engagementId });
    const query = parseBoundedDigestInput({});
    const digestBody = parseBoundedDigestInput({
      question: body.data.question,
      excerptArtifactIds: body.data.excerptArtifactIds,
      findingIds: body.data.findingIds,
    });
    if (path === undefined || query === undefined || digestBody === undefined) {
      return sendError(reply, 400, "invalid_request");
    }
    const projected = projectCommandJsonV1DigestInput(commandJsonV1CreateAdvisorTurnDigest, {
      path,
      query,
      body: digestBody,
    });
    const prepared = prepareLocalOperatorCommand({
      key,
      route,
      operation: "advisor_turn",
      path: projected.path,
      query: projected.query,
      body: projected.body,
    });
    if (!prepared.ok) return sendError(reply, 400, "invalid_request");
    const requestDigest = prepared.command.requestDigest;

    // Early read-only replay: terminal rows return stored state with no
    // settings, evidence, or provider touch. A pending row runs the
    // scoped bounded expiry first so a stale key retries to its stored
    // expired resource instead of a permanent 409.
    let lookup: ReturnType<AdvisorTurnRouteDeps["turns"]["lookupTurnByIdempotencyKey"]>;
    try {
      lookup = deps.turns.lookupTurnByIdempotencyKey(engagementId, key);
    } catch {
      return sendError(reply, 500, "invalid_persisted_data");
    }
    if (!lookup.ok) {
      const mapped = sendRepositoryError(reply, lookup.error.code);
      if (mapped !== undefined) return mapped;
      return sendError(reply, 500, "invalid_persisted_data");
    }
    if (lookup.value.turn !== null) {
      const existing = lookup.value.turn;
      if (existing.requestDigest !== requestDigest) {
        return sendError(reply, 409, "idempotency_conflict");
      }
      if (existing.status !== "pending") return sendTurn(reply, existing);
      let refreshed: ReturnType<AdvisorTurnRouteDeps["turns"]["lookupTurnByIdempotencyKey"]>;
      try {
        const expired = deps.turns.expireStalePending(engagementId);
        if (!expired.ok) {
          const mapped = sendRepositoryError(reply, expired.error.code);
          if (mapped !== undefined) return mapped;
          return sendError(reply, 500, "invalid_persisted_data");
        }
        refreshed = deps.turns.lookupTurnByIdempotencyKey(engagementId, key);
      } catch {
        return sendError(reply, 500, "invalid_persisted_data");
      }
      if (!refreshed.ok) {
        const mapped = sendRepositoryError(reply, refreshed.error.code);
        if (mapped !== undefined) return mapped;
        return sendError(reply, 500, "invalid_persisted_data");
      }
      const current = refreshed.value.turn;
      if (current === null || current.status === "pending") {
        return sendError(reply, 409, "turn_in_progress");
      }
      return sendTurn(reply, current);
    }

    // Settings validation before any evidence or provider work. The key
    // resolves by name at request time; presence is checked but the value
    // is never logged or returned.
    let settings: { endpointBaseUrl: string; modelId: string; apiKeyEnvVar: string; publicEndpointOptIn: boolean };
    try {
      const result = deps.settings.getAdvisorSettings();
      if (!result.ok) {
        if (result.error.code === "storage_busy") return sendError(reply, 503, "storage_busy");
        return sendError(reply, 500, "invalid_persisted_data");
      }
      settings = result.value;
    } catch {
      return sendError(reply, 500, "invalid_persisted_data");
    }
    if (settings.endpointBaseUrl === "" || settings.modelId === "") {
      return sendError(reply, 409, "advisor_unconfigured");
    }
    let apiKey: string | null = null;
    if (settings.apiKeyEnvVar !== "") {
      const environment = deps.env ?? process.env;
      const keyValue = environment[settings.apiKeyEnvVar];
      if (typeof keyValue !== "string" || keyValue.length === 0) {
        return sendError(reply, 409, "key_unset");
      }
      apiKey = keyValue;
    }
    try {
      const endpoint = new URL(settings.endpointBaseUrl);
      if (
        (endpoint.protocol === "http:" || endpoint.protocol === "https:") &&
        classifyAdvisorEndpointHost(endpoint.hostname) === "public" &&
        !settings.publicEndpointOptIn
      ) {
        return sendError(reply, 409, "public_not_opted_in");
      }
    } catch {
      // Leave malformed endpoints to the transport mapping below.
    }

    // Premature-close abort registered before context work; removed in
    // finally. Request-body completion alone must never abort.
    const controller = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    reply.raw.on("close", onClose);
    try {
      if (controller.signal.aborted) return;

      // Stored scoped history only: newest succeeded turns first, then
      // chronological, bounded to three pages with no offset loops. The
      // current turn does not exist yet, so exclusion is structural.
      // No client history is accepted.
      const history: Array<{ question: string; answer: string }> = [];
      let cursor: { createdAt: string; id: string } | undefined;
      for (let page = 0; page < HISTORY_PAGES && history.length < HISTORY_TURNS; page += 1) {
        let listed: ReturnType<AdvisorTurnRouteDeps["turns"]["listTurns"]>;
        try {
          listed = deps.turns.listTurns(engagementId, {
            ...(cursor === undefined ? {} : { cursor }),
            limit: HISTORY_PAGE_SIZE,
          });
        } catch {
          return sendError(reply, 500, "invalid_persisted_data");
        }
        if (!listed.ok) {
          const mapped = sendRepositoryError(reply, listed.error.code);
          if (mapped !== undefined) return mapped;
          return sendError(reply, 500, "invalid_persisted_data");
        }
        for (const turn of listed.value.turns) {
          if (history.length >= HISTORY_TURNS) break;
          if (turn.status !== "succeeded") continue;
          history.push({
            question: truncateUtf8Bytes(turn.question, HISTORY_FIELD_BYTES),
            answer: truncateUtf8Bytes(turn.answer, HISTORY_FIELD_BYTES),
          });
        }
        if (listed.value.nextCursor === null || history.length >= HISTORY_TURNS) break;
        cursor = listed.value.nextCursor;
      }
      history.reverse();

      let assembled: Awaited<ReturnType<typeof assembleAdvisorContext>>;
      try {
        assembled = await assembleAdvisorContext(
          { request: body.data, history },
          contextDeps,
        );
      } catch {
        return sendError(reply, 500, "invalid_persisted_data");
      }
      if (!assembled.ok) {
        switch (assembled.error.code) {
          case "unknown_artifact":
          case "unknown_finding":
          case "missing_artifact":
            return sendError(reply, 404, assembled.error.code);
          case "corrupt_artifact":
            return sendError(reply, 500, assembled.error.code);
          case "context_too_large":
            return sendError(reply, 400, assembled.error.code);
          case "engagement_not_found":
            return sendError(reply, 404, assembled.error.code);
          case "storage_busy":
            return sendError(reply, 503, assembled.error.code);
          default:
            return sendError(reply, 500, "invalid_persisted_data");
        }
      }

      if (controller.signal.aborted) return;
      const redactedQuestion = redactAdvisorText(body.data.question);
      let reserved: ReturnType<AdvisorTurnRouteDeps["turns"]["reserveOrReplay"]>;
      try {
        reserved = deps.turns.reserveOrReplay({
          engagementId,
          idempotencyKey: key,
          requestDigest,
          question: redactedQuestion.text,
          suppliedIds: [...assembled.value.suppliedIds],
          modelId: settings.modelId,
        });
      } catch {
        return sendError(reply, 500, "invalid_persisted_data");
      }
      if (!reserved.ok) {
        const mapped = sendRepositoryError(reply, reserved.error.code);
        if (mapped !== undefined) return mapped;
        return sendError(reply, 500, "invalid_persisted_data");
      }
      if (reserved.value.disposition === "replayed") {
        // A concurrent duplicate won: sole inference winner already
        // decided, so this request never calls the provider.
        if (reserved.value.turn.status === "pending") {
          return sendError(reply, 409, "turn_in_progress");
        }
        return sendTurn(reply, reserved.value.turn);
      }
      const turnId = reserved.value.turn.id;

      const finalizeCancelled = async (): Promise<void> => {
        try {
          deps.turns.completeTurn({
            engagementId,
            turnId,
            requestDigest,
            completion: { status: "cancelled" },
          });
        } catch {
          // Finalization is best-effort once the client is gone.
        }
      };
      if (controller.signal.aborted) {
        await finalizeCancelled();
        return;
      }

      let transport: Awaited<ReturnType<typeof postAdvisorChatCompletion>>;
      try {
        transport = await postAdvisorChatCompletion(
          {
            messages: [
              { role: "system", content: assembled.value.prompt.system },
              { role: "user", content: assembled.value.prompt.user },
            ],
            baseUrl: settings.endpointBaseUrl,
            model: settings.modelId,
            apiKey,
            publicOptIn: settings.publicEndpointOptIn,
          },
          { signal: controller.signal, ...(deps.transport?.requestFn === undefined ? {} : { requestFn: deps.transport.requestFn }) },
        );
      } catch {
        // An unexpected provider throw must still finalize the reserved
        // row: cancelled when the client is gone, terminal failure
        // otherwise. Never strand pending, never leak the raw error.
        if (controller.signal.aborted) {
          await finalizeCancelled();
          return;
        }
        return finishFailed(reply, deps, engagementId, turnId, requestDigest, key, {
          status: "provider_error",
          errorCode: "provider_unreachable",
        });
      }
      if (controller.signal.aborted) {
        // Late-provider resolve race: the output is discarded and the
        // row finalizes as cancelled, never resurrected.
        await finalizeCancelled();
        return;
      }
      if (!transport.ok) {
        const completion = transportFailureToCompletion(transport.error);
        let finished: ReturnType<AdvisorTurnRouteDeps["turns"]["completeTurn"]>;
        try {
          finished = deps.turns.completeTurn({
            engagementId,
            turnId,
            requestDigest,
            completion,
          });
        } catch {
          return sendError(reply, 500, "invalid_persisted_data");
        }
        if (!finished.ok) return sendCompletionError(reply, deps, engagementId, key, finished.error.code);
        return sendTurn(reply, finished.value.turn);
      }

      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(transport.untrustedContent);
      } catch {
        return finishFailed(reply, deps, engagementId, turnId, requestDigest, key, {
          status: "parse_error",
          errorCode: "provider_parse_error",
        });
      }
      return sendTurnFromExplanation(reply, deps, engagementId, turnId, requestDigest, key, parsedBody, {
        questionRedactions: redactedQuestion.redactions,
        promptRedactions: assembled.value.prompt.redactions,
      });
    } finally {
      reply.raw.off("close", onClose);
    }
  });

  app.get("/api/v1/engagements/:engagementId/advisor/turns", async (request, reply) => {
    const params = AdvisorTurnIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendError(reply, 400, "invalid_request");
    const query = parseAdvisorTurnListQuery(request.query);
    if (!query.ok) return sendError(reply, 400, "invalid_request");
    let listed: ReturnType<AdvisorTurnRouteDeps["turns"]["listTurns"]>;
    try {
      listed = deps.turns.listTurns(params.data.engagementId, {
        ...(query.value.before === undefined ? {} : { cursor: query.value.before }),
        limit: query.value.limit,
      });
    } catch {
      return sendError(reply, 500, "invalid_persisted_data");
    }
    if (!listed.ok) {
      const mapped = sendRepositoryError(reply, listed.error.code);
      if (mapped !== undefined) return mapped;
      return sendError(reply, 500, "invalid_persisted_data");
    }
    const turns: AdvisorTurn[] = [];
    for (const record of listed.value.turns) {
      const response = toAdvisorTurnResponse(record);
      if (response === undefined) return sendError(reply, 500, "invalid_persisted_data");
      turns.push(response);
    }
    const validated = AdvisorTurnListResponseSchema.safeParse({
      turns,
      nextCursor: listed.value.nextCursor,
    });
    if (!validated.success) return sendError(reply, 500, "invalid_persisted_data");
    return reply.code(200).type("application/json").send(validated.data);
  });
}

function sendCompletionError(
  reply: FastifyReply,
  deps: AdvisorTurnRouteDeps,
  engagementId: string,
  key: string,
  code: string,
) {
  if (code === "turn_expired" || code === "engagement_archived") {
    let reread: ReturnType<AdvisorTurnRouteDeps["turns"]["lookupTurnByIdempotencyKey"]>;
    try {
      reread = deps.turns.lookupTurnByIdempotencyKey(engagementId, key);
    } catch {
      return sendError(reply, 500, "invalid_persisted_data");
    }
    if (reread.ok && reread.value.turn !== null) return sendTurn(reply, reread.value.turn);
    return sendError(reply, 500, "invalid_persisted_data");
  }
  const mapped = sendRepositoryError(reply, code);
  if (mapped !== undefined) return mapped;
  return sendError(reply, 500, "invalid_persisted_data");
}

function finishFailed(
  reply: FastifyReply,
  deps: AdvisorTurnRouteDeps,
  engagementId: string,
  turnId: string,
  requestDigest: string,
  key: string,
  completion:
    | { status: "parse_error"; errorCode: "provider_parse_error" }
    | { status: "provider_error"; errorCode: "provider_timeout" | "provider_unreachable" | "provider_response_too_large" | "provider_redirect_rejected" },
) {
  let finished: ReturnType<AdvisorTurnRouteDeps["turns"]["completeTurn"]>;
  try {
    finished = deps.turns.completeTurn({ engagementId, turnId, requestDigest, completion });
  } catch {
    return sendError(reply, 500, "invalid_persisted_data");
  }
  if (!finished.ok) return sendCompletionError(reply, deps, engagementId, key, finished.error.code);
  return sendTurn(reply, finished.value.turn);
}

async function sendTurnFromExplanation(
  reply: FastifyReply,
  deps: AdvisorTurnRouteDeps,
  engagementId: string,
  turnId: string,
  requestDigest: string,
  key: string,
  parsedBody: unknown,
  counts: {
    questionRedactions: number;
    promptRedactions: number;
  },
) {
  const explanation = AdvisorExplanationSchema.safeParse(parsedBody);
  if (!explanation.success) {
    return finishFailed(reply, deps, engagementId, turnId, requestDigest, key, {
      status: "parse_error",
      errorCode: "provider_parse_error",
    });
  }
  const answer = redactAdvisorText(explanation.data.answer);
  const uncertainty = redactAdvisorText(explanation.data.uncertainty);
  const citations: string[] = [];
  let outputRedactions = answer.redactions + uncertainty.redactions;
  for (const citation of explanation.data.citations) {
    const redacted = redactAdvisorText(citation);
    outputRedactions += redacted.redactions;
    citations.push(redacted.text);
  }
  const rebuilt = AdvisorExplanationSchema.safeParse({
    profile: explanation.data.profile,
    answer: answer.text,
    uncertainty: uncertainty.text,
    citations,
    abstained: explanation.data.abstained,
  });
  if (!rebuilt.success) {
    return finishFailed(reply, deps, engagementId, turnId, requestDigest, key, {
      status: "parse_error",
      errorCode: "provider_parse_error",
    });
  }
  let finished: ReturnType<AdvisorTurnRouteDeps["turns"]["completeTurn"]>;
  try {
    finished = deps.turns.completeTurn({
      engagementId,
      turnId,
      requestDigest,
      completion: {
        status: "succeeded",
        explanation: rebuilt.data,
        redactions: counts.questionRedactions + counts.promptRedactions + outputRedactions,
      },
    });
  } catch {
    return sendError(reply, 500, "invalid_persisted_data");
  }
  if (!finished.ok) return sendCompletionError(reply, deps, engagementId, key, finished.error.code);
  return sendTurn(reply, finished.value.turn);
}
