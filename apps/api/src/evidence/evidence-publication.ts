import { createHash } from "node:crypto";

import type {
  CompleteEvidenceUploadErrorCode,
  CompleteEvidenceUploadRequest,
  EvidenceArtifactKind,
  PublishedCompleteness,
} from "@stonehush/contracts";
import type { EvidenceGrantRepository } from "@stonehush/db";

import type { EvidenceStore, EvidenceStorageErrorCode } from "./evidence-store.js";
import type { StorageQuiesceGate } from "./backup-lock.js";

// Publication orchestrator for ADR-0003 slice 3. The store owns the
// descriptor boundary; this service owns grant-state transitions and the
// strict publication order: stream, fsync file, fsync staging dir, durable
// putFinalized, no-replace rename, fsync published dir, metadata-after-file.
// When a quiesce gate is present, complete takes a nonblocking shared lock so
// an exclusive backup snapshot pauses finalization with
// storage_backup_quiesced instead of interleaving with the snapshot.

type PublicationHookResult =
  | { ok: true }
  | { ok: false; code: "storage_busy" | "invalid_persisted_data" };

type PublicationHook = (artifactId: string) => Promise<PublicationHookResult>;

export interface EvidencePublicationServiceOptions {
  repository: EvidenceGrantRepository;
  store: EvidenceStore;
  now?: () => Date;
  // Optional so existing deployments and focused tests without a lockfile
  // keep working; production wiring always provides one.
  quiesceGate?: StorageQuiesceGate;
  onPublicationCommitted?: PublicationHook;
}

export type PutOutcome =
  | { ok: true; acceptedBytes: number; digest: string }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "error"; code: PutErrorCode };

export type PutErrorCode =
  | CompleteEvidenceUploadErrorCode
  | "invalid_persisted_data"
  | "storage_busy"
  | "evidence_io_error"
  | "artifact_upload_in_progress";

export type CompleteOutcome =
  | {
      ok: true;
      disposition: "published" | "stored_artifact_replayed";
      artifactId: string;
      sizeBytes: number;
      digest: string;
      completeness: PublishedCompleteness;
    }
  | { ok: false; kind: "not_found" }
  | {
      ok: false;
      kind: "error";
      code:
        | CompleteEvidenceUploadErrorCode
        | "invalid_persisted_data"
        | "storage_busy"
        | "evidence_io_error";
    };

const STORE_CODE_TO_COMPLETE_ERROR: Partial<
  Record<EvidenceStorageErrorCode, CompleteEvidenceUploadErrorCode>
> = {
  artifact_symlink_rejected: "artifact_symlink_rejected",
  artifact_hardlink_rejected: "artifact_hardlink_rejected",
  artifact_not_regular_file: "artifact_not_regular_file",
  artifact_path_rejected: "artifact_path_rejected",
  artifact_published_root_changed: "artifact_published_root_changed",
  cross_filesystem_staging: "cross_filesystem_staging",
  evidence_roots_cross_device: "evidence_roots_cross_device",
};

interface GrantPublicationFields {
  readonly uploadId: string;
  readonly artifactId: string;
  readonly runId: string;
  readonly fence: string;
  readonly eventSequence: number;
  readonly artifactSlot: string;
  readonly kind: EvidenceArtifactKind;
}

export class EvidencePublicationService {
  private readonly repository: EvidenceGrantRepository;
  private readonly store: EvidenceStore;
  private readonly now: () => Date;
  private readonly quiesceGate: StorageQuiesceGate | undefined;
  private readonly onCommitted: PublicationHook | undefined;

  constructor(options: EvidencePublicationServiceOptions) {
    this.repository = options.repository;
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.quiesceGate = options.quiesceGate;
    this.onCommitted = options.onPublicationCommitted;
  }
  private async invokeCommitHook(artifactId: string): Promise<PublicationHookResult> {
    if (this.onCommitted === undefined) {
      return { ok: true };
    }

    try {
      return await this.onCommitted(artifactId);
    } catch {
      return { ok: false, code: "invalid_persisted_data" };
    }
  }

  // Streams the PUT body into the exclusive staging descriptor bounded by the
  // admission reservation. putFinalized becomes durable only after the
  // terminal byte count plus staging file and directory fsyncs.
  async handlePut(
    uploadId: string,
    runnerId: string,
    source: AsyncIterable<unknown>,
  ): Promise<PutOutcome> {
    const grant = this.repository.findGrantByUploadId(uploadId);
    if (grant === undefined || grant.runnerId !== runnerId) {
      return { ok: false, kind: "not_found" };
    }
    if (grant.state !== "in_progress" || grant.putFinalized) {
      return { ok: false, kind: "error", code: "artifact_upload_in_progress" };
    }

    const created = this.store.openStagingFile(uploadId);
    if (!created.ok) {
      if (created.code === "evidence_staging_name_taken") {
        return { ok: false, kind: "error", code: "artifact_upload_in_progress" };
      }
      if (created.code === "evidence_io_error") {
        return { ok: false, kind: "error", code: "evidence_io_error" };
      }
      const mapped = STORE_CODE_TO_COMPLETE_ERROR[created.code];
      return {
        ok: false,
        kind: "error",
        code: mapped ?? "invalid_persisted_data",
      };
    }
    const fd = created.fd;

    const hash = createHash("sha256");
    let acceptedBytes = 0;
    let overflow = false;
    try {
      for await (const chunk of source) {
        const buffer = toBuffer(chunk);
        if (buffer === undefined) continue;
        // Streaming cannot exceed the admission reservation.
        if (acceptedBytes + buffer.length > grant.reservationBytes) {
          overflow = true;
          break;
        }
        await this.store.writeStagedChunk(fd, buffer);
        hash.update(buffer);
        acceptedBytes += buffer.length;
      }
    } catch {
      // A mid-stream failure must leave the grant unfinalized so a restart
      // reports orphan_staging instead of advertising durable bytes.
      await this.store.closeStagedFile(fd).catch(() => undefined);
      return { ok: false, kind: "error", code: "evidence_io_error" };
    }

    if (overflow) {
      await this.store.closeStagedFile(fd).catch(() => undefined);
      this.repository.markGrantInterrupted({ uploadId, serverNow: this.now().toISOString() });
      return { ok: false, kind: "error", code: "artifact_quota_exceeded" };
    }

    const digest = `sha256:${hash.digest("hex")}`;
    try {
      await this.store.finalizeStagedWrite(fd);
      await this.store.closeStagedFile(fd);
      this.store.fsyncStagingDirectory();
    } catch {
      return { ok: false, kind: "error", code: "evidence_io_error" };
    }

    const finalized = this.repository.finalizePut({
      uploadId,
      runnerId,
      acceptedBytes,
      streamedDigest: digest,
      serverNow: this.now().toISOString(),
    });
    if (!finalized.ok) {
      switch (finalized.code) {
        case "grant_not_found":
          return { ok: false, kind: "not_found" };
        case "storage_busy":
          return { ok: false, kind: "error", code: "storage_busy" };
        case "invalid_persisted_data":
          return { ok: false, kind: "error", code: "invalid_persisted_data" };
        default:
          // Lost a race with a concurrent finalize or interruption.
          return { ok: false, kind: "error", code: "artifact_upload_in_progress" };
      }
    }
    return { ok: true, acceptedBytes, digest };
  }

  // Quiesce entry point: a nonblocking shared lock is held from before the
  // grant is inspected until after rename and metadata commit finish, so an
  // in-flight completion can never interleave with a backup snapshot.
  async handleComplete(
    uploadId: string,
    runnerId: string,
    request: CompleteEvidenceUploadRequest,
  ): Promise<CompleteOutcome> {
    if (this.quiesceGate === undefined) {
      return this.completeUnderSharedLock(uploadId, runnerId, request);
    }
    const gate = this.quiesceGate.acquireShared();
    if (!gate.ok) {
      return { ok: false, kind: "error", code: "storage_backup_quiesced" };
    }
    try {
      return await this.completeUnderSharedLock(uploadId, runnerId, request);
    } finally {
      gate.release();
    }
  }

  private async completeUnderSharedLock(
    uploadId: string,
    runnerId: string,
    request: CompleteEvidenceUploadRequest,
  ): Promise<CompleteOutcome> {
    const grant = this.repository.findGrantByUploadId(uploadId);
    if (grant === undefined || grant.runnerId !== runnerId) {
      return { ok: false, kind: "not_found" };
    }
    const serverNow = this.now().toISOString();

    // A published grant is immutable: same bytes replay, different declared
    // bytes are an identity conflict. No lease check is needed because no new
    // publication can occur.
    if (grant.state === "published") {
      if (
        request.sizeBytes === grant.acceptedBytes &&
        request.digest === grant.streamedDigest
      ) {
        const hook = await this.invokeCommitHook(grant.artifactId);
        if (!hook.ok) return { ok: false, kind: "error", code: hook.code };
        return replayResult(grant.artifactId, grant.acceptedBytes, grant.streamedDigest, request.completeness ?? "complete");
      }
      return { ok: false, kind: "error", code: "artifact_identity_conflict" };
    }
    if (grant.state !== "in_progress") {
      // An interrupted upload can no longer be completed by anyone.
      return { ok: false, kind: "not_found" };
    }
    if (!grant.putFinalized) {
      return { ok: false, kind: "error", code: "artifact_upload_in_progress" };
    }

    // Only a current unexpired lease owned by this runner may finalize.
    const authority = this.repository.checkUploadLeaseAuthority({
      grant,
      runnerId,
      serverNow,
    });
    if (!authority.ok) {
      return authority.code === "lease_expired" ||
        authority.code === "lease_owner_mismatch" ||
        authority.code === "stale_fence"
        ? { ok: false, kind: "error", code: authority.code }
        : { ok: false, kind: "error", code: "invalid_persisted_data" };
    }

    // Declared values must match the durably streamed prefix exactly.
    if (
      request.sizeBytes !== grant.acceptedBytes ||
      request.digest !== grant.streamedDigest
    ) {
      this.repository.markGrantInterrupted({ uploadId, serverNow });
      return { ok: false, kind: "error", code: "artifact_digest_mismatch" };
    }

    const identityRow = this.repository.publishedArtifactForIdentity({
      runId: grant.runId,
      fence: grant.fence,
      eventSequence: grant.eventSequence,
      artifactSlot: grant.artifactSlot,
    });
    if (identityRow !== undefined) {
      return await this.resolveIdentityRow(identityRow.artifactId, identityRow.sizeBytes, identityRow.digest, uploadId, request);
    }

    const published = this.store.publish({
      uploadId,
      artifactId: grant.artifactId,
      expectedSizeBytes: request.sizeBytes,
    });
    switch (published.status) {
      case "published": {
        const recorded = this.recordPublication(grant, request);
        if (!recorded.ok) return recorded;
        const hook = await this.invokeCommitHook(grant.artifactId);
        if (!hook.ok) return { ok: false, kind: "error", code: hook.code };
        return publishedResult(grant.artifactId, request.sizeBytes, request.digest, request.completeness ?? "complete");
      }
      case "destination_exists":
      case "source_missing":
        return this.resolveCrashWindowDestination(grant, request);
      case "failed":
        return mapStorageFailure(published.code);
    }
  }

  // Crash-window resolution per ADR-0003: after rename but before row commit
  // (staging gone, destination present), or a distinct source colliding on an
  // existing destination name. The decision reads the destination's actual
  // bytes through the descriptor boundary.
  private async resolveCrashWindowDestination(
    grant: GrantPublicationFields,
    request: CompleteEvidenceUploadRequest,
  ): Promise<CompleteOutcome> {
    const inspection = await this.store.inspectPublishedDestination(grant.artifactId);
    switch (inspection.status) {
      case "match": {
        if (
          inspection.sizeBytes !== request.sizeBytes ||
          inspection.digest !== request.digest
        ) {
          break;
        }
        try {
          this.store.fsyncPublishedDirectory();
        } catch {
          return { ok: false, kind: "error", code: "evidence_io_error" };
        }
        const recorded = this.recordPublication(grant, request);
        if (!recorded.ok) return recorded;
        if (recorded.outcome.status === "identity_exists") {
          return await this.resolveIdentityRow(
            recorded.outcome.artifact.artifactId,
            recorded.outcome.artifact.sizeBytes,
            recorded.outcome.artifact.digest,
            grant.uploadId,
            request,
          );
        }
        {
          const hook = await this.invokeCommitHook(grant.artifactId);
          if (!hook.ok) return { ok: false, kind: "error", code: hook.code };
        }
        return {
          ok: true,
          disposition: "stored_artifact_replayed",
          artifactId: grant.artifactId,
          sizeBytes: request.sizeBytes,
          digest: request.digest,
          completeness: request.completeness ?? "complete",
        };
      }
      case "missing":
        // Both names gone cannot be repaired silently.
        return { ok: false, kind: "error", code: "evidence_io_error" };
      default:
        break;
    }
    // A distinct source collided with an existing destination: the
    // destination stays untouched and the incoming upload is interrupted.
    this.repository.markGrantInterrupted({ uploadId: grant.uploadId, serverNow: this.now().toISOString() });
    return { ok: false, kind: "error", code: "artifact_already_published" };
  }

  private async resolveIdentityRow(
    artifactId: string,
    sizeBytes: number,
    digest: string,
    _uploadId: string,
    request: CompleteEvidenceUploadRequest,
  ): Promise<CompleteOutcome> {
    if (sizeBytes === request.sizeBytes && digest === request.digest) {
      const hook = await this.invokeCommitHook(artifactId);
      if (!hook.ok) return { ok: false, kind: "error", code: hook.code };
      return {
        ok: true,
        disposition: "stored_artifact_replayed",
        artifactId,
        sizeBytes,
        digest,
        completeness: request.completeness ?? "complete",
      };
    }
    return { ok: false, kind: "error", code: "artifact_identity_conflict" };
  }

  // Metadata-after-file commit point. On an identity race the stored row
  // decides replay versus conflict; the caller resolves it.
  private recordPublication(
    grant: GrantPublicationFields,
    request: CompleteEvidenceUploadRequest,
  ):
    | { ok: true; outcome: { status: "inserted" } | { status: "identity_exists"; artifact: { artifactId: string; sizeBytes: number; digest: string } } }
    | { ok: false; kind: "error"; code: "invalid_persisted_data" | "storage_busy" } {
    const result = this.repository.recordPublication({
      uploadId: grant.uploadId,
      artifactId: grant.artifactId,
      runId: grant.runId,
      fence: grant.fence,
      eventSequence: grant.eventSequence,
      artifactSlot: grant.artifactSlot,
      kind: grant.kind,
      sizeBytes: request.sizeBytes,
      digest: request.digest,
      completeness: request.completeness ?? "complete",
      occurredAt: this.now().toISOString(),
    });
    if (!result.ok) {
      return { ok: false, kind: "error", code: result.error.code };
    }
    if (result.outcome.status === "identity_exists") {
      return {
        ok: true,
        outcome: {
          status: "identity_exists",
          artifact: {
            artifactId: result.outcome.artifact.artifactId,
            sizeBytes: result.outcome.artifact.sizeBytes,
            digest: result.outcome.artifact.digest,
          },
        },
      };
    }
    return result;
  }
}

function replayResult(
  artifactId: string,
  sizeBytes: number,
  digest: string,
  completeness: PublishedCompleteness,
): CompleteOutcome {
  return {
    ok: true,
    disposition: "stored_artifact_replayed",
    artifactId,
    sizeBytes,
    digest,
    completeness,
  };
}

function publishedResult(
  artifactId: string,
  sizeBytes: number,
  digest: string,
  completeness: PublishedCompleteness,
): CompleteOutcome {
  return {
    ok: true,
    disposition: "published",
    artifactId,
    sizeBytes,
    digest,
    completeness,
  };
}

function mapStorageFailure(code: EvidenceStorageErrorCode): CompleteOutcome {
  const mapped = STORE_CODE_TO_COMPLETE_ERROR[code];
  if (mapped !== undefined) return { ok: false, kind: "error", code: mapped };
  return { ok: false, kind: "error", code: "invalid_persisted_data" };
}

function toBuffer(chunk: unknown): Buffer | undefined {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  return undefined;
}
