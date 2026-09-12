import { createHash } from "node:crypto";

import {
  AttachmentErrorSchema,
  AttachmentListResponseSchema,
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
  byteOffsetOfCharOffset,
  deriveAttachmentName,
  findTextMatches,
  isCropRectValid,
  maskExcerptText,
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

function sendExcerptError(reply: FastifyReply, status: ExcerptMutationStatus, code: string) {
  return reply
    .code(status)
    .type("application/json")
    .send(ExcerptErrorSchema.parse({ code }));
}

function sendAttachmentError(
  reply: FastifyReply,
  status: 400 | 404 | 409 | 500 | 503,
  code: string,
) {
  return reply
    .code(status)
    .type("application/json")
    .send(AttachmentErrorSchema.parse({ code }));
}

function storageStatus(error: { code: string }): 503 | 500 {
  return error.code === "storage_busy" ? 503 : 500;
}

// Engagement gate shared by excerpt and attachment writes. Reads stay
// available on archived engagements; new annotations do not. The sender
// keeps each route's error shape.
async function engagementWriteGate(
  reply: FastifyReply,
  engagements: Pick<EngagementRepository, "getEngagement">,
  engagementId: string,
  send: (reply: FastifyReply, status: 400 | 404 | 409 | 500 | 503, code: string) => unknown,
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

const utf8Decoder = new TextDecoder("utf-8", { fatal: false });
const utf8StrictDecoder = new TextDecoder("utf-8", { fatal: true });

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

    let bytes: Awaited<ReturnType<EvidenceStore["verifiedByteRange"]>>;
    try {
      bytes = await store.verifiedByteRange({
        artifactId: artifact.artifactId,
        expectedSizeBytes: artifact.sizeBytes,
        expectedDigest: artifact.digest,
        byteOffset: body.data.byteOffset,
        byteLength: body.data.byteLength,
      });
    } catch {
      return sendExcerptError(reply, 409, "corrupt_artifact");
    }
    if (bytes.status === "missing") return sendExcerptError(reply, 409, "missing_artifact");
    if (bytes.status === "corrupt") return sendExcerptError(reply, 409, "corrupt_artifact");

    // The write gate must hold at commit time, not just at request start. The
    // verified byte read above awaits I/O, so an archive could land in
    // between. Re-check synchronously here; the insert below is synchronous
    // with no await in between, so no interleave remains in this process.
    const commitGate = await engagementWriteGate(
      reply,
      engagements,
      params.data.engagementId,
      sendExcerptError,
    );
    if (!commitGate.ok) return reply;

    // Mask before persistence. The stored excerpt never carries raw secret
    // values, and the response carries the same masked text.
    const masked = maskExcerptText(utf8Decoder.decode(bytes.content));
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
      if (created.error.code === "engagement_not_found") {
        return sendExcerptError(reply, 404, "engagement_not_found");
      }
      return sendExcerptError(
        reply,
        storageStatus(created.error),
        created.error.code === "storage_busy" ? "storage_busy" : "invalid_persisted_data",
      );
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
      if (listed.error.code === "engagement_not_found") {
        return sendExcerptError(reply, 404, "engagement_not_found");
      }
      if (listed.error.code === "storage_busy") {
        return sendExcerptError(reply, 503, "storage_busy");
      }
      return sendExcerptError(reply, 500, "invalid_persisted_data");
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
      let run: ReturnType<RunOutputRepository["runForEngagement"]>;
      let artifacts: ReturnType<RunOutputRepository["artifactsForRun"]>;
      try {
        run = runs.runForEngagement(params.data.engagementId, params.data.runId);
        artifacts = runs.artifactsForRun(params.data.runId);
      } catch {
        return sendExcerptError(reply, 500, "invalid_persisted_data");
      }
      if (!run.ok) {
        if (run.code === "engagement_not_found") {
          return sendExcerptError(reply, 404, "engagement_not_found");
        }
        return sendExcerptError(reply, storageStatus({ code: run.code }), run.code);
      }
      if (run.run === undefined || run.run.engagementId !== params.data.engagementId) {
        return sendExcerptError(reply, 404, "run_not_found");
      }
      if (!artifacts.ok) {
        return sendExcerptError(
          reply,
          storageStatus({ code: artifacts.code }),
          artifacts.code,
        );
      }
      const refs = artifacts.artifacts
        .filter((artifact) => artifact.runId === run.run?.id)
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
      let run: ReturnType<RunOutputRepository["runForEngagement"]>;
      let artifacts: ReturnType<RunOutputRepository["artifactsForRun"]>;
      try {
        run = runs.runForEngagement(params.data.engagementId, params.data.runId);
        artifacts = runs.artifactsForRun(params.data.runId);
      } catch {
        return sendExcerptError(reply, 500, "invalid_persisted_data");
      }
      if (!run.ok) {
        if (run.code === "engagement_not_found") {
          return sendExcerptError(reply, 404, "engagement_not_found");
        }
        return sendExcerptError(reply, storageStatus({ code: run.code }), run.code);
      }
      if (run.run === undefined || run.run.engagementId !== params.data.engagementId) {
        return sendExcerptError(reply, 404, "run_not_found");
      }
      if (!artifacts.ok) {
        return sendExcerptError(
          reply,
          storageStatus({ code: artifacts.code }),
          artifacts.code,
        );
      }
      const eligible = artifacts.artifacts
        .filter((artifact) => artifact.runId === run.run?.id)
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
        searchedBytes += taken;
        if (taken < download.sizeBytes) scanCapped = true;
        const prefix = Buffer.concat(chunks);
        // Byte offsets are computed by re-encoding decoded text. When the
        // source bytes are not valid UTF-8, a replacement character occupies
        // one source byte but three re-encoded bytes, so offsets would point
        // at other evidence. Reject the unsafe mapping: count the bytes,
        // mark the scan incomplete so absence is never misread as proof of
        // absence, and return no matches for this artifact. Original bytes
        // are preserved untouched.
        try {
          utf8StrictDecoder.decode(prefix);
        } catch {
          scanCapped = true;
          continue;
        }
        const text = utf8Decoder.decode(prefix);
        const hits = findTextMatches(text, query.data.q, query.data.limit - matches.length);
        const points = Array.from(text);
        for (const hit of hits) {
          const window = windowSnippetFromChars(text, hit.charOffset, hit.charLength);
          const masked = maskExcerptText(window.snippet);
          matches.push({
            artifactId: candidate.artifactId,
            stream: candidate.kind as "stdout" | "stderr",
            byteOffset: byteOffsetOfCharOffset(text, hit.charOffset),
            byteLength: Buffer.byteLength(
              points.slice(hit.charOffset, hit.charOffset + hit.charLength).join(""),
              "utf8",
            ),
            snippet: masked.text,
            redactions: masked.redactions,
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

  app.post("/api/v1/engagements/:engagementId/attachments", async (request, reply) => {
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
    if (raw.length < 1 || raw.length > 2_000_000) {
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
      if (created.error.code === "engagement_not_found") {
        return sendAttachmentError(reply, 404, "engagement_not_found");
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
  });

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
      if (listed.error.code === "engagement_not_found") {
        return sendAttachmentError(reply, 404, "engagement_not_found");
      }
      return sendAttachmentError(
        reply,
        storageStatus(listed.error),
        listed.error.code === "storage_busy" ? "storage_busy" : "invalid_persisted_data",
      );
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
        if (bytes.error.code === "engagement_not_found") {
          return sendAttachmentError(reply, 404, "engagement_not_found");
        }
        if (bytes.error.code === "attachment_not_found") {
          return sendAttachmentError(reply, 404, "attachment_not_found");
        }
        return sendAttachmentError(
          reply,
          storageStatus(bytes.error),
          bytes.error.code === "storage_busy" ? "storage_busy" : "invalid_persisted_data",
        );
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
      if (updated.error.code === "engagement_not_found") {
        return sendAttachmentError(reply, 404, "engagement_not_found");
      }
      if (
        updated.error.code === "excerpt_not_found" ||
        updated.error.code === "attachment_not_found"
      ) {
        return sendAttachmentError(reply, 404, "attachment_not_found");
      }
      return sendAttachmentError(
        reply,
        storageStatus(updated.error),
        updated.error.code === "storage_busy" ? "storage_busy" : "invalid_persisted_data",
      );
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
