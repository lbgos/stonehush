import { createHash } from "node:crypto";

import {
  AttachmentErrorSchema,
  AttachmentListResponseSchema,
  ATTACHMENT_RAW_MAX_BYTES,
  AttachmentSchema,
  CreateAttachmentRequestSchema,
  CreateDerivedAttachmentRequestSchema,
  CreateExcerptRequestSchema,
  EXCERPT_SEARCH_SCAN_MAX_BYTES,
  ExcerptErrorSchema,
  ExcerptListResponseSchema,
  ExcerptSchema,
  ExcerptSearchQuerySchema,
  ExcerptSearchResponseSchema,
  ExcerptSourceListResponseSchema,
  EngagementIdParamsSchema,
  UpdateAttachmentRequestSchema,
} from "@stonehush/contracts";
import type {
  EngagementRepository,
  EvidenceGrantRepository,
  ExcerptRepository,
  RunOutputRepository,
} from "@stonehush/db";
import {
  ADVISOR_REDACTION_TOKEN,
  byteOffsetOfCharOffset,
  deriveAttachmentName,
  EXCERPT_EXTENDED_CONTEXT_BYTES,
  EXCERPT_REDACTION_CONTEXT_BYTES,
  EXCERPT_REDACTION_CONTEXT_CHARS,
  EXCERPT_SNIPPET_RADIUS_CHARS,
  findTextMatches,
  isCropRectValid,
  isSecretContinuationChar,
  projectMaskedSelection,
  selectionHasDanglingKeyEnd,
  selectionLooksLikeHiddenAssignmentValue,
  selectionMayHideUrlValue,
  selectionStartsMidToken,
  validateExcerptRange,
  windowSnippetFromChars,
} from "@stonehush/domain";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { EvidenceStore } from "./evidence/evidence-store.js";

export interface ExcerptRouteDependencies {
  readonly engagements: Pick<EngagementRepository, "getEngagement">;
  readonly excerpts: ExcerptRepository;
  readonly runs: Pick<RunOutputRepository, "runForEngagement" | "artifactsForRun">;
  readonly grants: Pick<EvidenceGrantRepository, "publishedArtifactForEngagement">;
  readonly store: Pick<EvidenceStore, "verifiedByteRange" | "verifiedDownload">;
}

type ExcerptMutationStatus = 400 | 404 | 409 | 500 | 503;

type ContractErrorSender = (
  reply: FastifyReply,
  status: ExcerptMutationStatus,
  code: string,
) => unknown;

function sendExcerptError(reply: FastifyReply, status: ExcerptMutationStatus, code: string) {
  return reply
    .code(status)
    .type("application/json")
    .send(ExcerptErrorSchema.parse({ code }));
}

function sendAttachmentError(reply: FastifyReply, status: ExcerptMutationStatus, code: string) {
  return reply
    .code(status)
    .type("application/json")
    .send(AttachmentErrorSchema.parse({ code }));
}

function storageStatus(error: { code: string }): 503 | 500 {
  return error.code === "storage_busy" ? 503 : 500;
}

// Shared repository failure mapping for excerpt and attachment reads and
// writes: unknown engagement, archived engagement, missing row, busy
// storage, and invalid persisted data each keep their exact status and code
// in every handler. notFoundCode names the missing-row shape of the caller
// (excerpts and attachments each keep their own error union).
function sendRepositoryError(
  reply: FastifyReply,
  error: { code: string },
  send: ContractErrorSender,
  notFoundCode: string,
): unknown {
  switch (error.code) {
    case "engagement_not_found":
      return send(reply, 404, "engagement_not_found");
    case "engagement_archived":
      return send(reply, 409, "engagement_archived");
    case "excerpt_not_found":
    case "attachment_not_found":
      return send(reply, 404, notFoundCode);
    default:
      return send(
        reply,
        storageStatus(error),
        error.code === "storage_busy" ? "storage_busy" : "invalid_persisted_data",
      );
  }
}

// Engagement gate shared by excerpt and attachment writes. Reads stay
// available on archived engagements; new annotations do not. The sender
// keeps each route's error shape.
async function engagementWriteGate(
  reply: FastifyReply,
  engagements: Pick<EngagementRepository, "getEngagement">,
  engagementId: string,
  send: ContractErrorSender,
): Promise<{ ok: true } | { ok: false }> {
  let found: ReturnType<EngagementRepository["getEngagement"]>;
  try {
    found = engagements.getEngagement(engagementId);
  } catch {
    send(reply, 500, "invalid_persisted_data");
    return { ok: false };
  }
  if (!found.ok) {
    if (found.error.code === "engagement_not_found") {
      send(reply, 404, "engagement_not_found");
      return { ok: false };
    }
    if (found.error.code === "storage_busy") {
      send(reply, 503, "storage_busy");
      return { ok: false };
    }
    send(reply, 500, "invalid_persisted_data");
    return { ok: false };
  }
  if (found.value.engagement.status === "archived") {
    send(reply, 409, "engagement_archived");
    return { ok: false };
  }
  return { ok: true };
}

type RunArtifactRows = Extract<
  ReturnType<RunOutputRepository["artifactsForRun"]>,
  { ok: true }
>["artifacts"];

// Shared run-membership gate for the excerpt-sources and search endpoints:
// the run must belong to the engagement, and artifact rows come from stored
// metadata only. Every failure keeps its exact status and code.
function loadRunArtifacts(
  reply: FastifyReply,
  runs: ExcerptRouteDependencies["runs"],
  engagementId: string,
  runId: string,
): { ok: true; runId: string; artifacts: RunArtifactRows } | { ok: false } {
  let run: ReturnType<RunOutputRepository["runForEngagement"]>;
  let artifacts: ReturnType<RunOutputRepository["artifactsForRun"]>;
  try {
    run = runs.runForEngagement(engagementId, runId);
    artifacts = runs.artifactsForRun(runId);
  } catch {
    sendExcerptError(reply, 500, "invalid_persisted_data");
    return { ok: false };
  }
  if (!run.ok) {
    if (run.code === "engagement_not_found") {
      sendExcerptError(reply, 404, "engagement_not_found");
    } else {
      sendExcerptError(reply, storageStatus({ code: run.code }), run.code);
    }
    return { ok: false };
  }
  if (run.run === undefined || run.run.engagementId !== engagementId) {
    sendExcerptError(reply, 404, "run_not_found");
    return { ok: false };
  }
  if (!artifacts.ok) {
    sendExcerptError(
      reply,
      storageStatus({ code: artifacts.code }),
      artifacts.code,
    );
    return { ok: false };
  }
  return { ok: true, runId: run.run.id, artifacts: artifacts.artifacts };
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: false });
const utf8StrictDecoder = new TextDecoder("utf-8", { fatal: true });

// Longest strict-UTF-8 prefix of a bounded scan cut. A budget cut can land
// mid-code-point; the trailing partial sequence is an incomplete read edge,
// not malformed source, so drop up to 3 trailing bytes (the longest
// possible incomplete sequence) instead of discarding valid matches.
// Genuinely invalid bytes match no trim and yield an empty prefix, which
// callers skip with scanCapped set.
export function completeUtf8Prefix(bytes: Buffer): Buffer {
  if (bytes.length === 0) return bytes;
  try {
    utf8StrictDecoder.decode(bytes);
    return bytes;
  } catch {
    // Fall through to trailing trims below.
  }
  for (let drop = 1; drop <= 3 && drop <= bytes.length; drop += 1) {
    const candidate = bytes.subarray(0, bytes.length - drop);
    try {
      utf8StrictDecoder.decode(candidate);
      return candidate;
    } catch {
      // Try a shorter prefix.
    }
  }
  return Buffer.alloc(0);
}

function sha256Digest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function registerExcerptRoutes(
  app: FastifyInstance,
  dependencies: ExcerptRouteDependencies,
): void {
  const { engagements, excerpts, runs, grants, store } = dependencies;

  app.post("/api/v1/engagements/:engagementId/excerpts", async (request, reply) => {
    const params = EngagementIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendExcerptError(reply, 400, "invalid_request");
    const body = CreateExcerptRequestSchema.safeParse(request.body);
    if (!body.success) return sendExcerptError(reply, 400, "invalid_request");
    const gate = await engagementWriteGate(reply, engagements, params.data.engagementId, sendExcerptError);
    if (!gate.ok) return reply;

    let run: ReturnType<RunOutputRepository["runForEngagement"]>;
    try {
      run = runs.runForEngagement(params.data.engagementId, body.data.runId);
    } catch {
      return sendExcerptError(reply, 500, "invalid_persisted_data");
    }
    if (!run.ok) {
      if (run.code === "engagement_not_found") {
        return sendExcerptError(reply, 404, "engagement_not_found");
      }
      return sendExcerptError(reply, storageStatus({ code: run.code }), run.code);
    }
    if (run.run === undefined) return sendExcerptError(reply, 404, "run_not_found");

    // Stable reference check: the artifact must be published evidence that
    // belongs to this engagement through run -> action membership, must be
    // attached to the claimed run, and must be an excerptable text stream.
    // The digest comes from storage, never from the caller.
    let artifact: ReturnType<EvidenceGrantRepository["publishedArtifactForEngagement"]>;
    try {
      artifact = grants.publishedArtifactForEngagement({
        engagementId: params.data.engagementId,
        artifactId: body.data.artifactId,
      });
    } catch {
      return sendExcerptError(reply, 500, "invalid_persisted_data");
    }
    if (
      artifact === undefined ||
      artifact.runId !== body.data.runId ||
      (artifact.kind !== "stdout" && artifact.kind !== "stderr") ||
      artifact.kind !== body.data.stream
    ) {
      return sendExcerptError(reply, 404, "artifact_not_found");
    }
    const range = validateExcerptRange(
      artifact.sizeBytes,
      body.data.byteOffset,
      body.data.byteLength,
    );
    if (!range.ok) return sendExcerptError(reply, 400, "range_rejected");

    // Redaction sees a bounded window around the requested slice, never just
    // the slice. Masking `supersecret` alone cannot recognize it as part of
    // `flag{supersecret}`; the wrappers live in the surrounding bytes. One
    // verified read covers prefix, selection, and suffix, so no extra
    // verification cost and no bytes reach the client beyond the masked
    // slice. The window stays server side; provenance still records exactly
    // the requested offsets.
    const contextStart = Math.max(0, body.data.byteOffset - EXCERPT_REDACTION_CONTEXT_BYTES);
    const contextEnd = Math.min(
      artifact.sizeBytes,
      body.data.byteOffset + body.data.byteLength + EXCERPT_REDACTION_CONTEXT_BYTES,
    );
    let expanded: Awaited<ReturnType<EvidenceStore["verifiedByteRange"]>>;
    try {
      expanded = await store.verifiedByteRange({
        artifactId: artifact.artifactId,
        expectedSizeBytes: artifact.sizeBytes,
        expectedDigest: artifact.digest,
        byteOffset: contextStart,
        byteLength: contextEnd - contextStart,
      });
    } catch {
      return sendExcerptError(reply, 409, "corrupt_artifact");
    }
    if (expanded.status === "missing") return sendExcerptError(reply, 409, "missing_artifact");
    if (expanded.status === "corrupt") return sendExcerptError(reply, 409, "corrupt_artifact");

    // Decode pieces separately so the requested char range needs no byte
    // map: concatenating the three decodes keeps requested coordinates
    // exact even beside malformed input, where re-encoding would drift.
    const relativeOffset = body.data.byteOffset - contextStart;
    const prefixText = utf8Decoder.decode(expanded.content.subarray(0, relativeOffset));
    const requestedText = utf8Decoder.decode(
      expanded.content.subarray(relativeOffset, relativeOffset + body.data.byteLength),
    );
    const suffixText = utf8Decoder.decode(
      expanded.content.subarray(relativeOffset + body.data.byteLength),
    );
    const expandedText = prefixText + requestedText + suffixText;
    const requestedStartChars = Array.from(prefixText).length;
    const requestedLengthChars = Array.from(requestedText).length;
    // A cut lookback that ends mid-token cannot prove the selection starts
    // at a safe boundary: a secret prefix may sit beyond the window. Reject
    // instead of persisting a possible inner secret slice.
    if (contextStart > 0 && selectionStartsMidToken(prefixText, requestedText)) {
      return sendExcerptError(reply, 400, "range_rejected");
    }
    // A cut lookback can also hide an assignment key across a wide gap:
    // `password` plus thousands of spaces plus `=hunter2` leaves no span
    // and no token boundary at the selection start. Reject value-side
    // selections rather than persisting a possible secret value.
    if (contextStart > 0 && selectionLooksLikeHiddenAssignmentValue(prefixText, requestedText)) {
      return sendExcerptError(reply, 400, "range_rejected");
    }
    // A selection holding a private-key END marker without its BEGIN
    // marker is the tail of a block whose head sits beyond the cut
    // lookback: no span can cover the body, so narrow masking persists it
    // raw. Selections holding the whole block mask through the block span
    // and never reach this reject. Widening left to include the BEGIN
    // marker fixes it.
    if (contextStart > 0 && selectionHasDanglingKeyEnd(requestedText)) {
      return sendExcerptError(reply, 400, "range_rejected");
    }
    // Mask before persistence. Spans found in the expanded context project
    // onto the selection, so inner secret bytes stay masked. Selections with
    // no overlap come back identical to narrow masking. truncatedAfter is
    // set only when bytes exist beyond the window, so an unterminated BEGIN
    // marker extends masking to the window end without touching ordinary
    // trailing text of fully visible files.
    const truncatedAfter = contextEnd < artifact.sizeBytes;
    let masked = projectMaskedSelection(
      expandedText,
      requestedStartChars,
      requestedLengthChars,
      truncatedAfter,
    );
    // Second-chance trigger search for URL-shaped values with a hidden
    // scheme. Userinfo patterns are unbounded, so a password longer than
    // the base window leaves no span and no gate fires when the selection
    // starts past a URL delimiter. When the lookback is cut, the selection
    // found no overlap, and the edge looks URL-shaped, one wider bounded
    // read hunts the scheme: overlapping spans replace the narrow result,
    // while ordinary text (emails, dividers) keeps narrow masking with the
    // same outcome plus one bounded read. No gates rerun here; the first
    // pass already failed closed on every cut-boundary shape it recognizes.
    if (
      !masked.overlapped &&
      contextStart > 0 &&
      selectionMayHideUrlValue(prefixText, requestedText)
    ) {
      const extendedStart = Math.max(0, body.data.byteOffset - EXCERPT_EXTENDED_CONTEXT_BYTES);
      let extended: Awaited<ReturnType<EvidenceStore["verifiedByteRange"]>>;
      try {
        extended = await store.verifiedByteRange({
          artifactId: artifact.artifactId,
          expectedSizeBytes: artifact.sizeBytes,
          expectedDigest: artifact.digest,
          byteOffset: extendedStart,
          byteLength: contextEnd - extendedStart,
        });
      } catch {
        return sendExcerptError(reply, 409, "corrupt_artifact");
      }
      if (extended.status === "missing") return sendExcerptError(reply, 409, "missing_artifact");
      if (extended.status === "corrupt") return sendExcerptError(reply, 409, "corrupt_artifact");
      const extendedRelative = body.data.byteOffset - extendedStart;
      const extendedPrefix = utf8Decoder.decode(extended.content.subarray(0, extendedRelative));
      const extendedText = extendedPrefix + requestedText + suffixText;
      const extendedStartChars = Array.from(extendedPrefix).length;
      const extendedMasked = projectMaskedSelection(
        extendedText,
        extendedStartChars,
        requestedLengthChars,
        truncatedAfter,
      );
      if (extendedMasked.overlapped) {
        masked = extendedMasked;
      } else if (extendedStart > 0) {
        // The extended window is still cut: a scheme may hide beyond it,
        // so a URL-shaped selection cannot be proven safe. Reject rather
        // than persisting the narrow result. Ordinary twins past the bound
        // (emails, dividers) reject here too; widening the selection below
        // the bound fixes them.
        return sendExcerptError(reply, 400, "range_rejected");
      }
    }
    const created = excerpts.createExcerpt({
      engagementId: params.data.engagementId,
      runId: body.data.runId,
      artifactId: artifact.artifactId,
      artifactDigest: artifact.digest,
      stream: body.data.stream,
      byteOffset: body.data.byteOffset,
      byteLength: body.data.byteLength,
      content: masked.text,
      redactions: masked.redactions,
      targetNote: body.data.targetNote ?? null,
    });
    if (!created.ok) {
      return sendRepositoryError(reply, created.error, sendExcerptError, "excerpt_not_found");
    }
    const validated = ExcerptSchema.safeParse(created.value);
    if (!validated.success) return sendExcerptError(reply, 500, "invalid_persisted_data");
    return reply.code(201).type("application/json").send(validated.data);
  });

  app.get("/api/v1/engagements/:engagementId/excerpts", async (request, reply) => {
    const params = EngagementIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendExcerptError(reply, 400, "invalid_request");
    let listed: ReturnType<ExcerptRepository["listExcerpts"]>;
    try {
      listed = excerpts.listExcerpts(params.data.engagementId);
    } catch {
      return sendExcerptError(reply, 500, "invalid_persisted_data");
    }
    if (!listed.ok) {
      return sendRepositoryError(reply, listed.error, sendExcerptError, "excerpt_not_found");
    }
    const validated = ExcerptListResponseSchema.safeParse(listed.value);
    if (!validated.success) return sendExcerptError(reply, 500, "invalid_persisted_data");
    return reply.code(200).type("application/json").send(validated.data);
  });

  // Byte-level artifact references for one run, served from stored metadata
  // only. A failed download keeps its reference, size, digest, and
  // completeness here with a retry action in the UI.
  app.get(
    "/api/v1/engagements/:engagementId/runs/:runId/excerpt-sources",
    async (request, reply) => {
      const params = EngagementIdParamsSchema.extend({ runId: CreateExcerptRequestSchema.shape.runId }).safeParse(
        request.params,
      );
      if (!params.success) return sendExcerptError(reply, 400, "invalid_request");
      const loaded = loadRunArtifacts(reply, runs, params.data.engagementId, params.data.runId);
      if (!loaded.ok) return reply;
      const refs = loaded.artifacts
        .filter((artifact) => artifact.runId === loaded.runId)
        .map((artifact) => ({
          artifactId: artifact.artifactId,
          kind: artifact.kind,
          sizeBytes: artifact.sizeBytes,
          digest: artifact.digest,
          completeness: artifact.completeness,
        }))
        .sort((left, right) => (left.artifactId < right.artifactId ? -1 : 1));
      const validated = ExcerptSourceListResponseSchema.safeParse(refs);
      if (!validated.success) return sendExcerptError(reply, 500, "invalid_persisted_data");
      return reply.code(200).type("application/json").send(validated.data);
    },
  );

  // Server-side search within one run's preserved text output. Matches carry
  // masked snippets with byte offsets for Keep excerpt; the full artifact is
  // never rendered or transferred. The scan stops at a bounded cap and says
  // so truthfully.
  app.get(
    "/api/v1/engagements/:engagementId/runs/:runId/output/search",
    async (request, reply) => {
      const params = EngagementIdParamsSchema.extend({
        runId: CreateExcerptRequestSchema.shape.runId,
      }).safeParse(request.params);
      if (!params.success) return sendExcerptError(reply, 400, "invalid_request");
      const query = ExcerptSearchQuerySchema.safeParse({
        q: (request.query as Record<string, unknown> | undefined)?.["q"],
        stream: (request.query as Record<string, unknown> | undefined)?.["stream"],
        limit:
          (request.query as Record<string, unknown> | undefined)?.["limit"] === undefined
            ? undefined
            : Number((request.query as Record<string, unknown>)?.["limit"]),
      });
      if (!query.success) return sendExcerptError(reply, 400, "invalid_request");
      const loaded = loadRunArtifacts(reply, runs, params.data.engagementId, params.data.runId);
      if (!loaded.ok) return reply;
      const eligible = loaded.artifacts
        .filter((artifact) => artifact.runId === loaded.runId)
        .filter((artifact) => artifact.kind === "stdout" || artifact.kind === "stderr")
        .filter((artifact) =>
          query.data.stream === undefined ? true : artifact.kind === query.data.stream,
        )
        .sort((left, right) => (left.artifactId < right.artifactId ? -1 : 1));
      // The scan covers at most 8 artifacts per request. Overflow is reported
      // through scanCapped so absence of a match is never misread as proof
      // of absence.
      const candidates = eligible.slice(0, 8);
      const matches: {
        artifactId: string;
        stream: "stdout" | "stderr";
        byteOffset: number;
        byteLength: number;
        snippet: string;
        redactions: number;
      }[] = [];
      const unavailableArtifactIds: string[] = [];
      let searchedBytes = 0;
      let scanCapped = eligible.length > candidates.length;
      for (const candidate of candidates) {
        if (matches.length >= query.data.limit) break;
        let download: Awaited<ReturnType<EvidenceStore["verifiedDownload"]>>;
        try {
          download = await store.verifiedDownload({
            artifactId: candidate.artifactId,
            expectedSizeBytes: candidate.sizeBytes,
            expectedDigest: candidate.digest,
          });
        } catch {
          unavailableArtifactIds.push(candidate.artifactId);
          continue;
        }
        if (download.status !== "ready") {
          unavailableArtifactIds.push(candidate.artifactId);
          continue;
        }
        const budget = Math.min(
          download.sizeBytes,
          EXCERPT_SEARCH_SCAN_MAX_BYTES - searchedBytes,
        );
        if (budget <= 0) {
          scanCapped = true;
          break;
        }
        const chunks: Buffer[] = [];
        let taken = 0;
        try {
          for await (const chunk of download.stream) {
            const room = budget - taken;
            if (room <= 0) break;
            const slice = chunk.subarray(0, Math.min(room, chunk.length));
            chunks.push(Buffer.from(slice));
            taken += slice.length;
            if (taken >= budget) break;
          }
        } catch {
          unavailableArtifactIds.push(candidate.artifactId);
          continue;
        } finally {
          // Draining stopped early: close the verified descriptor instead of
          // leaving the stream suspended.
          await download.stream.return?.(undefined);
        }
        if (taken < download.sizeBytes) scanCapped = true;
        const rawPrefix = Buffer.concat(chunks);
        // A budget cut can end mid-code-point; keep the complete prefix
        // searchable instead of discarding the whole artifact. Only the
        // complete bytes count as searched.
        const prefix = completeUtf8Prefix(rawPrefix);
        if (prefix.length < rawPrefix.length) scanCapped = true;
        if (prefix.length === 0) continue;
        searchedBytes += prefix.length;
        const text = utf8Decoder.decode(prefix);
        const hits = findTextMatches(text, query.data.q, query.data.limit - matches.length);
        const points = Array.from(text);
        for (const hit of hits) {
          const winStart = Math.max(0, hit.charOffset - EXCERPT_SNIPPET_RADIUS_CHARS);
          const winEnd = Math.min(
            points.length,
            hit.charOffset + hit.charLength + EXCERPT_SNIPPET_RADIUS_CHARS,
          );
          const ctxEnd = Math.min(points.length, winEnd + EXCERPT_REDACTION_CONTEXT_CHARS);
          const cutRight = ctxEnd < points.length || taken < download.sizeBytes;
          // At the scanned end with more bytes beyond the cap, the next
          // character is unknown: points[ctxEnd] is undefined, so the pair
          // check below would read it as a boundary and clear a token that
          // continues past the cap (for example `flag{supersecret` with the
          // brace still unread). Treat a trailing token run at an unknown
          // edge as unsafe instead.
          const rightUnknown = cutRight && ctxEnd >= points.length;
          const edgeRight =
            (cutRight &&
              !rightUnknown &&
              selectionStartsMidToken(
                points[ctxEnd - 1] ?? "",
                points[ctxEnd] ?? "",
              )) ||
            (rightUnknown && isSecretContinuationChar(points[ctxEnd - 1] ?? ""));
          let snippet: string;
          let redactions: number;
          if (edgeRight) {
            // A secret value may continue past the visible context edge.
            // Mask the whole snippet rather than risk a partial leak.
            snippet = `${winStart > 0 ? "..." : ""}${ADVISOR_REDACTION_TOKEN}${winEnd < points.length ? "..." : ""}`;
            redactions = 1;
          } else {
            const window = windowSnippetFromChars(text, hit.charOffset, hit.charLength);
            // Span discovery runs over the whole scanned prefix, not just
            // the display window: any trigger the scan saw must mask, no
            // matter how far behind the match it sits. Display still shows
            // only the window. The dropped left-edge whole-mask is
            // subsumed: left of the scan is the artifact start, so no
            // unknown edge remains there for spans to miss.
            const projected = projectMaskedSelection(
              text,
              winStart,
              winEnd - winStart,
              taken < download.sizeBytes,
            );
            snippet = `${window.truncatedBefore ? "..." : ""}${projected.text}${window.truncatedAfter ? "..." : ""}`;
            redactions = projected.redactions;
          }
          matches.push({
            artifactId: candidate.artifactId,
            stream: candidate.kind as "stdout" | "stderr",
            byteOffset: byteOffsetOfCharOffset(text, hit.charOffset),
            byteLength: Buffer.byteLength(
              points.slice(hit.charOffset, hit.charOffset + hit.charLength).join(""),
              "utf8",
            ),
            snippet,
            redactions,
          });
        }
      }
      const payload = {
        matches,
        searchedBytes,
        scanCapped,
        unavailableArtifactIds: [...new Set(unavailableArtifactIds)].sort(),
      };
      const validated = ExcerptSearchResponseSchema.safeParse(payload);
      if (!validated.success) return sendExcerptError(reply, 500, "invalid_persisted_data");
      return reply.code(200).type("application/json").send(validated.data);
    },
  );

  app.post(
    "/api/v1/engagements/:engagementId/attachments",
    // The contract allows 2M Base64 characters (1.5M raw bytes); without
    // this, Fastify's 1MiB default rejects valid 786KB-plus uploads before
    // the handler's own bound runs.
    { bodyLimit: 4 * 1024 * 1024 },
    async (request, reply) => {
    const params = EngagementIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendAttachmentError(reply, 400, "invalid_request");
    const body = CreateAttachmentRequestSchema.safeParse(request.body);
    if (!body.success) return sendAttachmentError(reply, 400, "invalid_request");
    const gate = await engagementWriteGate(reply, engagements, params.data.engagementId, sendAttachmentError);
    if (!gate.ok) return reply;
    let raw: Buffer;
    try {
      raw = Buffer.from(body.data.contentBase64, "base64");
    } catch {
      return sendAttachmentError(reply, 400, "invalid_request");
    }
    if (raw.length < 1 || raw.length > ATTACHMENT_RAW_MAX_BYTES) {
      return sendAttachmentError(reply, 400, "invalid_request");
    }
    const created = excerpts.createAttachment({
      engagementId: params.data.engagementId,
      filename: deriveAttachmentName(body.data.filename, "evidence-image"),
      mime: body.data.mime,
      sizeBytes: raw.length,
      digest: sha256Digest(raw),
      caption: body.data.caption ?? "",
      targetLabel: body.data.targetLabel ?? null,
      parentAttachmentId: null,
      cropRectJson: null,
      contentBase64: raw.toString("base64"),
    });
    if (!created.ok) {
      return sendRepositoryError(reply, created.error, sendAttachmentError, "attachment_not_found");
    }
    const validated = AttachmentSchema.safeParse(created.value);
    if (!validated.success) return sendAttachmentError(reply, 500, "invalid_persisted_data");
    return reply.code(201).type("application/json").send(validated.data);
    },
  );

  app.get("/api/v1/engagements/:engagementId/attachments", async (request, reply) => {
    const params = EngagementIdParamsSchema.safeParse(request.params);
    if (!params.success) return sendAttachmentError(reply, 400, "invalid_request");
    let listed: ReturnType<ExcerptRepository["listAttachments"]>;
    try {
      listed = excerpts.listAttachments(params.data.engagementId);
    } catch {
      return sendAttachmentError(reply, 500, "invalid_persisted_data");
    }
    if (!listed.ok) {
      return sendRepositoryError(reply, listed.error, sendAttachmentError, "attachment_not_found");
    }
    const validated = AttachmentListResponseSchema.safeParse(listed.value);
    if (!validated.success) return sendAttachmentError(reply, 500, "invalid_persisted_data");
    return reply.code(200).type("application/json").send(validated.data);
  });

  app.get(
    "/api/v1/engagements/:engagementId/attachments/:attachmentId/content",
    { exposeHeadRoute: false },
    async (request, reply) => {
      const params = EngagementIdParamsSchema.extend({
        attachmentId: ExcerptSchema.shape.id,
      }).safeParse(request.params);
      if (!params.success) return sendAttachmentError(reply, 400, "invalid_request");
      let bytes: ReturnType<ExcerptRepository["attachmentBytes"]>;
      try {
        bytes = excerpts.attachmentBytes(params.data.engagementId, params.data.attachmentId);
      } catch {
        return sendAttachmentError(reply, 500, "invalid_persisted_data");
      }
      if (!bytes.ok) {
        return sendRepositoryError(reply, bytes.error, sendAttachmentError, "attachment_not_found");
      }
      const raw = Buffer.from(bytes.value.contentBase64, "base64");
      return reply
        .code(200)
        .header("content-type", bytes.value.mime)
        .header("x-content-type-options", "nosniff")
        .header("cache-control", "private, no-store")
        .header("content-length", String(raw.length))
        .send(raw);
    },
  );

  app.patch("/api/v1/engagements/:engagementId/attachments/:attachmentId", async (request, reply) => {
    const params = EngagementIdParamsSchema.extend({
      attachmentId: ExcerptSchema.shape.id,
    }).safeParse(request.params);
    if (!params.success) return sendAttachmentError(reply, 400, "invalid_request");
    const body = UpdateAttachmentRequestSchema.safeParse(request.body);
    if (!body.success) return sendAttachmentError(reply, 400, "invalid_request");
    const gate = await engagementWriteGate(reply, engagements, params.data.engagementId, sendAttachmentError);
    if (!gate.ok) return reply;
    let updated: ReturnType<ExcerptRepository["updateAttachmentCaption"]>;
    try {
      updated = excerpts.updateAttachmentCaption(
        params.data.engagementId,
        params.data.attachmentId,
        body.data.caption,
      );
    } catch {
      return sendAttachmentError(reply, 500, "invalid_persisted_data");
    }
    if (!updated.ok) {
      return sendRepositoryError(reply, updated.error, sendAttachmentError, "attachment_not_found");
    }
    const validated = AttachmentSchema.safeParse(updated.value);
    if (!validated.success) return sendAttachmentError(reply, 500, "invalid_persisted_data");
    return reply.code(200).type("application/json").send(validated.data);
  });

  // Derived crops and annotations. The child copies the original bytes and
  // records the parent id plus an optional display-space crop rect; the
  // original row is never mutated.
  app.post(
    "/api/v1/engagements/:engagementId/attachments/:attachmentId/derived",
    async (request, reply) => {
      const params = EngagementIdParamsSchema.extend({
        attachmentId: ExcerptSchema.shape.id,
      }).safeParse(request.params);
      if (!params.success) return sendAttachmentError(reply, 400, "invalid_request");
      const body = CreateDerivedAttachmentRequestSchema.safeParse(request.body);
      if (!body.success) return sendAttachmentError(reply, 400, "invalid_request");
      if (
        body.data.crop !== undefined &&
        !isCropRectValid({ ...body.data.crop })
      ) {
        return sendAttachmentError(reply, 400, "invalid_request");
      }
      const gate = await engagementWriteGate(reply, engagements, params.data.engagementId, sendAttachmentError);
      if (!gate.ok) return reply;
      let parent: ReturnType<ExcerptRepository["getAttachment"]>;
      try {
        parent = excerpts.getAttachment(params.data.engagementId, params.data.attachmentId);
      } catch {
        return sendAttachmentError(reply, 500, "invalid_persisted_data");
      }
      if (!parent.ok) {
        if (parent.error.code === "engagement_not_found") {
          return sendAttachmentError(reply, 404, "engagement_not_found");
        }
        return sendAttachmentError(reply, 404, "attachment_not_found");
      }
      let parentBytes: ReturnType<ExcerptRepository["attachmentBytes"]>;
      try {
        parentBytes = excerpts.attachmentBytes(params.data.engagementId, params.data.attachmentId);
      } catch {
        return sendAttachmentError(reply, 500, "invalid_persisted_data");
      }
      if (!parentBytes.ok) {
        if (parentBytes.error.code === "engagement_not_found") {
          return sendAttachmentError(reply, 404, "engagement_not_found");
        }
        if (parentBytes.error.code === "attachment_not_found") {
          return sendAttachmentError(reply, 404, "attachment_not_found");
        }
        return sendAttachmentError(
          reply,
          storageStatus(parentBytes.error),
          parentBytes.error.code === "storage_busy" ? "storage_busy" : "invalid_persisted_data",
        );
      }
      const raw = Buffer.from(parentBytes.value.contentBase64, "base64");
      const created = excerpts.createAttachment({
        engagementId: params.data.engagementId,
        filename: deriveAttachmentName(
          body.data.caption === "" ? `${parent.value.filename}-derived` : body.data.caption,
          `${parent.value.filename}-derived`,
        ),
        mime: parent.value.mime,
        sizeBytes: raw.length,
        digest: sha256Digest(raw),
        caption: body.data.caption ?? "",
        targetLabel: parent.value.targetLabel,
        parentAttachmentId: parent.value.id,
        cropRectJson: body.data.crop === undefined ? null : JSON.stringify(body.data.crop),
        contentBase64: parentBytes.value.contentBase64,
      });
      if (!created.ok) {
        if (created.error.code === "engagement_archived") {
          return sendAttachmentError(reply, 409, "engagement_archived");
        }
        return sendAttachmentError(
          reply,
          storageStatus(created.error),
          created.error.code === "storage_busy" ? "storage_busy" : "invalid_persisted_data",
        );
      }
      const validated = AttachmentSchema.safeParse(created.value);
      if (!validated.success) return sendAttachmentError(reply, 500, "invalid_persisted_data");
      return reply.code(201).type("application/json").send(validated.data);
    },
  );
}
