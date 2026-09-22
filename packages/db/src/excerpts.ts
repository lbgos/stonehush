import type { Attachment, Excerpt } from "@stonehush/contracts";
import {
  AttachmentCropSchema,
  AttachmentSchema,
  EXCERPT_CONTENT_MAX_BYTES,
  ExcerptSchema,
} from "@stonehush/contracts";
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema.js";
import {
  engagements,
  evidenceAttachments,
  evidenceExcerpts,
} from "./schema.js";

type Database = BetterSQLite3Database<typeof schema>;

export type ExcerptRepositoryError =
  | { code: "engagement_not_found" }
  | { code: "engagement_archived" }
  | { code: "excerpt_not_found" }
  | { code: "attachment_not_found" }
  | { code: "invalid_repository_input" }
  | { code: "storage_busy" };

export type ExcerptResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ExcerptRepositoryError };

export interface ExcerptRepositoryProviders {
  createId?: () => string;
  now?: () => Date;
}

export interface CreateExcerptInput {
  readonly engagementId: string;
  readonly runId: string;
  readonly artifactId: string;
  readonly artifactDigest: string;
  readonly stream: "stdout" | "stderr";
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly content: string;
  readonly redactions: number;
  readonly targetNote: string | null;
}

export interface CreateAttachmentInput {
  readonly engagementId: string;
  readonly filename: string;
  readonly mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  readonly sizeBytes: number;
  readonly digest: string;
  readonly caption: string;
  readonly targetLabel: string | null;
  readonly parentAttachmentId: string | null;
  readonly cropRectJson: string | null;
  readonly contentBase64: string;
}

function storageError(error: unknown): ExcerptRepositoryError {
  const code = (error as { code?: string })?.code;
  return {
    code: code === "SQLITE_BUSY" || code === "SQLITE_BUSY_TIMEOUT" ? "storage_busy" : "invalid_repository_input",
  };
}

function excerptFromRow(row: typeof evidenceExcerpts.$inferSelect): Excerpt | undefined {
  if (
    row.stream !== "stdout" &&
    row.stream !== "stderr"
  ) {
    return undefined;
  }
  const value: Excerpt = {
    contractVersion: 1,
    id: row.id,
    engagementId: row.engagementId,
    runId: row.runId,
    artifactId: row.artifactId,
    artifactDigest: row.artifactDigest,
    stream: row.stream,
    byteOffset: row.byteOffset,
    byteLength: row.byteLength,
    content: row.content,
    redactions: row.redactions,
    targetNote: row.targetNote,
    createdAt: row.createdAt,
  };
  return value;
}

const attachmentMetadataColumns = {
  id: evidenceAttachments.id,
  contractVersion: evidenceAttachments.contractVersion,
  engagementId: evidenceAttachments.engagementId,
  filename: evidenceAttachments.filename,
  mime: evidenceAttachments.mime,
  sizeBytes: evidenceAttachments.sizeBytes,
  digest: evidenceAttachments.digest,
  caption: evidenceAttachments.caption,
  targetLabel: evidenceAttachments.targetLabel,
  parentAttachmentId: evidenceAttachments.parentAttachmentId,
  cropRectJson: evidenceAttachments.cropRectJson,
  createdAt: evidenceAttachments.createdAt,
};

function attachmentFromRow(
  row: Omit<typeof evidenceAttachments.$inferSelect, "contentBase64">,
): Attachment | undefined {
  if (
    row.mime !== "image/png" &&
    row.mime !== "image/jpeg" &&
    row.mime !== "image/gif" &&
    row.mime !== "image/webp"
  ) {
    return undefined;
  }
  // Crop metadata is display-space only and never mutates the original bytes,
  // but a malformed value (for example `{}`) must not become a persisted
  // attachment that violates AttachmentCropSchema. Validate before accepting.
  let crop: Attachment["crop"] = null;
  if (row.cropRectJson !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.cropRectJson);
    } catch {
      return undefined;
    }
    const validated = AttachmentCropSchema.safeParse(parsed);
    if (!validated.success) return undefined;
    crop = validated.data;
  }
  const value: Attachment = {
    contractVersion: 1,
    id: row.id,
    engagementId: row.engagementId,
    filename: row.filename,
    mime: row.mime,
    sizeBytes: row.sizeBytes,
    digest: row.digest,
    caption: row.caption,
    targetLabel: row.targetLabel,
    parentAttachmentId: row.parentAttachmentId,
    crop,
    createdAt: row.createdAt,
  };
  return value;
}

export class ExcerptRepository {
  private readonly createId: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly db: Database,
    providers: ExcerptRepositoryProviders = {},
  ) {
    this.createId = providers.createId ?? randomUUID;
    this.now = providers.now ?? (() => new Date());
  }

  private engagementExists(engagementId: string): boolean {
    const row = this.db
      .select({ id: engagements.id })
      .from(engagements)
      .where(eq(engagements.id, engagementId))
      .get();
    return row !== undefined;
  }

  createExcerpt(input: CreateExcerptInput): ExcerptResult<Excerpt> {
    const row = {
      id: this.createId(),
      contractVersion: 1,
      engagementId: input.engagementId,
      runId: input.runId,
      artifactId: input.artifactId,
      artifactDigest: input.artifactDigest,
      stream: input.stream,
      byteOffset: input.byteOffset,
      byteLength: input.byteLength,
      content: input.content,
      redactions: input.redactions,
      targetNote: input.targetNote,
      createdAt: this.now().toISOString(),
    } as const;
    // Validate before inserting so contract-invalid values (for example an
    // empty runId) fail closed instead of persisting a row that later list
    // and get calls reject as invalid data.
    if (!ExcerptSchema.safeParse({ ...row }).success) {
      return { ok: false, error: { code: "invalid_repository_input" } };
    }
    // The schema bound counts characters while the column constrains UTF-8
    // bytes: multibyte content can pass the schema yet exceed the column.
    // Reject up front instead of letting the CHECK fail the insert.
    if (Buffer.byteLength(row.content, "utf8") > EXCERPT_CONTENT_MAX_BYTES) {
      return { ok: false, error: { code: "invalid_repository_input" } };
    }
    // The archived check and the insert run in one immediate transaction so
    // an archive racing this write cannot slip between a separate gate read
    // and the insert, on any connection. Reads stay available on archived
    // engagements; only this insert path refuses them.
    try {
      return this.db.transaction((client) => {
        const engagement = client
          .select({ status: engagements.status })
          .from(engagements)
          .where(eq(engagements.id, input.engagementId))
          .get();
        if (engagement === undefined) {
          return { ok: false as const, error: { code: "engagement_not_found" as const } };
        }
        if (engagement.status === "archived") {
          return { ok: false as const, error: { code: "engagement_archived" as const } };
        }
        client.insert(evidenceExcerpts).values(row).run();
        const excerpt = excerptFromRow({ ...row });
        if (excerpt === undefined) return { ok: false as const, error: { code: "invalid_repository_input" as const } };
        return { ok: true as const, value: excerpt };
      }, { behavior: "immediate" });
    } catch (error) {
      return { ok: false, error: storageError(error) };
    }
  }

  listExcerpts(engagementId: string): ExcerptResult<Excerpt[]> {
    try {
      if (!this.engagementExists(engagementId)) {
        return { ok: false, error: { code: "engagement_not_found" } };
      }
      const rows = this.db
        .select()
        .from(evidenceExcerpts)
        .where(eq(evidenceExcerpts.engagementId, engagementId))
        .orderBy(asc(evidenceExcerpts.createdAt), asc(evidenceExcerpts.id))
        .all();
      const excerpts: Excerpt[] = [];
      for (const row of rows) {
        const excerpt = excerptFromRow(row);
        if (excerpt === undefined) return { ok: false, error: { code: "invalid_repository_input" } };
        excerpts.push(excerpt);
      }
      return { ok: true, value: excerpts };
    } catch (error) {
      return { ok: false, error: storageError(error) };
    }
  }

  getExcerpt(engagementId: string, excerptId: string): ExcerptResult<Excerpt> {
    try {
      if (!this.engagementExists(engagementId)) {
        return { ok: false, error: { code: "engagement_not_found" } };
      }
      const row = this.db
        .select()
        .from(evidenceExcerpts)
        .where(
          and(
            eq(evidenceExcerpts.id, excerptId),
            eq(evidenceExcerpts.engagementId, engagementId),
          ),
        )
        .get();
      if (row === undefined) return { ok: false, error: { code: "excerpt_not_found" } };
      const excerpt = excerptFromRow(row);
      if (excerpt === undefined) return { ok: false, error: { code: "invalid_repository_input" } };
      return { ok: true, value: excerpt };
    } catch (error) {
      return { ok: false, error: storageError(error) };
    }
  }

  createAttachment(input: CreateAttachmentInput): ExcerptResult<Attachment> {
    const row = {
      id: this.createId(),
      contractVersion: 1,
      engagementId: input.engagementId,
      filename: input.filename,
      mime: input.mime,
      sizeBytes: input.sizeBytes,
      digest: input.digest,
      caption: input.caption,
      targetLabel: input.targetLabel,
      parentAttachmentId: input.parentAttachmentId,
      cropRectJson: input.cropRectJson,
      contentBase64: input.contentBase64,
      createdAt: this.now().toISOString(),
    } as const;
    // Validate before inserting so a malformed crop (for example `{}`)
    // fails closed instead of persisting a row that later reads reject.
    if (row.cropRectJson !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.cropRectJson);
      } catch {
        return { ok: false, error: { code: "invalid_repository_input" } };
      }
      if (!AttachmentCropSchema.safeParse(parsed).success) {
        return { ok: false, error: { code: "invalid_repository_input" } };
      }
    }
    // Validate the complete attachment contract, not just the crop: fields
    // like an over-bound sizeBytes would otherwise persist and fail every
    // contract-validating consumer on read.
    const candidate = attachmentFromRow({ ...row });
    if (candidate === undefined || !AttachmentSchema.safeParse(candidate).success) {
      return { ok: false, error: { code: "invalid_repository_input" } };
    }
    // Same atomicity as createExcerpt: the archived check and the insert
    // run in one immediate transaction so an archive racing this write
    // cannot slip between a separate gate read and the insert. The parent
    // check runs inside the same transaction (and its try boundary) so a
    // read failure maps to storage_busy or invalid_repository_input
    // instead of escaping. Order note: the parent check runs before the
    // engagement check, so an input naming both a missing engagement and
    // a dangling parent reports attachment_not_found. No route sends a
    // parent id on plain create and the derive path pre-verifies its
    // parent, so nothing reachable changes.
    try {
      return this.db.transaction((client) => {
        if (input.parentAttachmentId !== null) {
          const parent = client
            .select({ id: evidenceAttachments.id, engagementId: evidenceAttachments.engagementId })
            .from(evidenceAttachments)
            .where(eq(evidenceAttachments.id, input.parentAttachmentId))
            .get();
          if (parent === undefined || parent.engagementId !== input.engagementId) {
            return { ok: false as const, error: { code: "attachment_not_found" as const } };
          }
        }
        const engagement = client
          .select({ status: engagements.status })
          .from(engagements)
          .where(eq(engagements.id, input.engagementId))
          .get();
        if (engagement === undefined) {
          return { ok: false as const, error: { code: "engagement_not_found" as const } };
        }
        if (engagement.status === "archived") {
          return { ok: false as const, error: { code: "engagement_archived" as const } };
        }
        client.insert(evidenceAttachments).values(row).run();
        const attachment = attachmentFromRow({ ...row });
        if (attachment === undefined) {
          return { ok: false as const, error: { code: "invalid_repository_input" as const } };
        }
        return { ok: true as const, value: attachment };
      }, { behavior: "immediate" });
    } catch (error) {
      return { ok: false, error: storageError(error) };
    }
  }

  listAttachments(engagementId: string): ExcerptResult<Attachment[]> {
    try {
      if (!this.engagementExists(engagementId)) {
        return { ok: false, error: { code: "engagement_not_found" } };
      }
      const rows = this.db
        .select(attachmentMetadataColumns)
        .from(evidenceAttachments)
        .where(eq(evidenceAttachments.engagementId, engagementId))
        .orderBy(asc(evidenceAttachments.createdAt), asc(evidenceAttachments.id))
        .all();
      const attachments: Attachment[] = [];
      for (const row of rows) {
        const attachment = attachmentFromRow(row);
        if (attachment === undefined) {
          return { ok: false, error: { code: "invalid_repository_input" } };
        }
        attachments.push(attachment);
      }
      return { ok: true, value: attachments };
    } catch (error) {
      return { ok: false, error: storageError(error) };
    }
  }

  getAttachment(engagementId: string, attachmentId: string): ExcerptResult<Attachment> {
    try {
      if (!this.engagementExists(engagementId)) {
        return { ok: false, error: { code: "engagement_not_found" } };
      }
      const row = this.db
        .select(attachmentMetadataColumns)
        .from(evidenceAttachments)
        .where(
          and(
            eq(evidenceAttachments.id, attachmentId),
            eq(evidenceAttachments.engagementId, engagementId),
          ),
        )
        .get();
      if (row === undefined) return { ok: false, error: { code: "attachment_not_found" } };
      const attachment = attachmentFromRow(row);
      if (attachment === undefined) {
        return { ok: false, error: { code: "invalid_repository_input" } };
      }
      return { ok: true, value: attachment };
    } catch (error) {
      return { ok: false, error: storageError(error) };
    }
  }

  updateAttachmentCaption(
    engagementId: string,
    attachmentId: string,
    caption: string,
  ): ExcerptResult<Attachment> {
    // The archived check and the update run in one immediate transaction,
    // like the insert paths, so an archive racing a caption save cannot
    // mutate an archived engagement. Reads stay available; only the write
    // refuses. Error precedence matches the old read-then-write order:
    // missing engagement first, then missing row.
    try {
      return this.db.transaction((client) => {
        const engagement = client
          .select({ status: engagements.status })
          .from(engagements)
          .where(eq(engagements.id, engagementId))
          .get();
        if (engagement === undefined) {
          return { ok: false as const, error: { code: "engagement_not_found" as const } };
        }
        const current = client
          .select({ id: evidenceAttachments.id })
          .from(evidenceAttachments)
          .where(
            and(
              eq(evidenceAttachments.id, attachmentId),
              eq(evidenceAttachments.engagementId, engagementId),
            ),
          )
          .get();
        if (current === undefined) {
          return { ok: false as const, error: { code: "attachment_not_found" as const } };
        }
        if (engagement.status === "archived") {
          return { ok: false as const, error: { code: "engagement_archived" as const } };
        }
        client
          .update(evidenceAttachments)
          .set({ caption })
          .where(
            and(
              eq(evidenceAttachments.id, attachmentId),
              eq(evidenceAttachments.engagementId, engagementId),
            ),
          )
          .run();
        const updated = client
          .select(attachmentMetadataColumns)
          .from(evidenceAttachments)
          .where(
            and(
              eq(evidenceAttachments.id, attachmentId),
              eq(evidenceAttachments.engagementId, engagementId),
            ),
          )
          .get();
        const attachment = updated === undefined ? undefined : attachmentFromRow(updated);
        if (attachment === undefined) {
          return { ok: false as const, error: { code: "invalid_repository_input" as const } };
        }
        return { ok: true as const, value: attachment };
      }, { behavior: "immediate" });
    } catch (error) {
      return { ok: false, error: storageError(error) };
    }
  }

  // Raw bytes for the content endpoint. Membership is engagement-scoped like
  // every other read: foreign ids are identically absent.
  attachmentBytes(
    engagementId: string,
    attachmentId: string,
  ): ExcerptResult<{ mime: Attachment["mime"]; contentBase64: string; filename: string }> {
    try {
      if (!this.engagementExists(engagementId)) {
        return { ok: false, error: { code: "engagement_not_found" } };
      }
      const row = this.db
        .select({
          mime: evidenceAttachments.mime,
          filename: evidenceAttachments.filename,
          contentBase64: evidenceAttachments.contentBase64,
        })
        .from(evidenceAttachments)
        .where(
          and(
            eq(evidenceAttachments.id, attachmentId),
            eq(evidenceAttachments.engagementId, engagementId),
          ),
        )
        .get();
      if (row === undefined) return { ok: false, error: { code: "attachment_not_found" } };
      if (
        row.mime !== "image/png" &&
        row.mime !== "image/jpeg" &&
        row.mime !== "image/gif" &&
        row.mime !== "image/webp"
      ) {
        return { ok: false, error: { code: "invalid_repository_input" } };
      }
      return {
        ok: true,
        value: { mime: row.mime, contentBase64: row.contentBase64, filename: row.filename },
      };
    } catch (error) {
      return { ok: false, error: storageError(error) };
    }
  }
}
