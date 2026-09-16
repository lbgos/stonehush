import { createHash, randomUUID } from "node:crypto";

import {
  WORKSPACE_BUNDLE_KIND,
  WORKSPACE_BUNDLE_MAX_EVIDENCE_BYTES,
  WORKSPACE_BUNDLE_MAX_EVIDENCE_FILE_BYTES,
  WORKSPACE_BUNDLE_MAX_JSON_BYTES,
  WORKSPACE_BUNDLE_VERSION,
  WorkspaceBundleSchema,
  WorkspaceBundleVersionProbeSchema,
  workspaceBundleRawBytes,
  type WorkspaceBundle,
  type WorkspaceBundleSummary,
} from "@stonehush/contracts";
import type {
  EngagementRepository,
  ExcerptRepository,
  LeadRepository,
  ObjectiveRepository,
  RunOutputRepository,
  SecretRepository,
} from "@stonehush/db";
import type { EngagementDatabase } from "@stonehush/db";
import {
  checkWorkspaceBundleBounds,
  orderAttachmentsForImport,
  planIdRemap,
  remapStoredRefs,
  summarizeWorkspaceBundle,
} from "@stonehush/domain";

import type { EvidenceStore } from "./evidence/evidence-store.js";
import type { FfufProjectionService } from "./evidence/ffuf-projection.js";
import type { HttpProbeProjectionService } from "./evidence/http-probe-projection.js";
import type { NmapProjectionService } from "./evidence/nmap-projection.js";

// Portable workspace bundle service (stone-9). Export assembles one
// versioned, hash-anchored file from live engagement records plus evidence
// bytes. Import creates a NEW engagement with fresh ids for every record so
// repeated imports never collide. Secrets, flags, and client identifiers
// travel only in an explicit private copy; proof values never travel at all
// because the server never stores them.

export type WorkspaceBundleErrorCode =
  | "invalid_request"
  | "engagement_not_found"
  | "storage_busy"
  | "invalid_persisted_data"
  | "unsupported_bundle_version"
  | "bundle_digest_mismatch"
  | "bundle_too_large";

export type WorkspaceBundleResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: WorkspaceBundleErrorCode } };

export interface WorkspaceBundleExport {
  readonly bundle: WorkspaceBundle;
}

export interface WorkspaceBundleImport {
  readonly engagementId: string;
  readonly summary: WorkspaceBundleSummary;
}

interface BundleRepositories {
  readonly engagements: Pick<
    EngagementRepository,
    | "getEngagement"
    | "createEngagement"
    | "getEngagementNotes"
    | "putEngagementNotes"
    | "listFindings"
    | "createFinding"
    | "resolveFinding"
  >;
  readonly leads: Pick<
    LeadRepository,
    "listLeads" | "listAttempts" | "createLead" | "parkLead" | "closeLead" | "recordAttempt"
  >;
  readonly excerpts: Pick<
    ExcerptRepository,
    "listExcerpts" | "listAttachments" | "attachmentBytes" | "createExcerpt" | "createAttachment"
  >;
  readonly secrets: Pick<
    SecretRepository,
    "listSecrets" | "createSecret" | "recordVerification"
  >;
  readonly objectives: Pick<
    ObjectiveRepository,
    "listObjectives" | "createObjective"
  >;
  readonly runs: Pick<RunOutputRepository, "listArtifactsForEngagement">;
}

export interface WorkspaceBundleDependencies extends BundleRepositories {
  // Raw sqlite handle for the rows no repository creates: the synthetic
  // import action/run, imported artifact rows, and private objective proof
  // metadata. No migration; all writes target existing tables.
  readonly sqlite: EngagementDatabase["sqlite"];
  readonly store: Pick<
    EvidenceStore,
    "verifiedDownload" | "openStagingFile" | "writeStagedChunk" | "finalizeStagedWrite" | "closeStagedFile" | "publish"
  >;
  readonly nmapProjection: Pick<NmapProjectionService, "projectForArtifact">;
  readonly httpProbeProjection: Pick<HttpProbeProjectionService, "projectForArtifact">;
  readonly ffufProjection: Pick<FfufProjectionService, "projectForArtifact">;
  readonly now?: () => Date;
}

function failed<T>(code: WorkspaceBundleErrorCode): WorkspaceBundleResult<T> {
  return { ok: false, error: { code } };
}

function mapRepositoryError(code: string): WorkspaceBundleErrorCode {
  if (code === "engagement_not_found") return "engagement_not_found";
  if (code === "storage_busy") return "storage_busy";
  return "invalid_persisted_data";
}

function sha256Hex(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function storageCode(error: unknown): WorkspaceBundleErrorCode {
  const code = (error as { code?: string })?.code;
  return code === "SQLITE_BUSY" || code === "SQLITE_BUSY_TIMEOUT" ?
      "storage_busy"
    : "invalid_persisted_data";
}

// Collect a verified download stream into one bounded buffer. Sizes were
// pre-checked against the bundle caps from artifact metadata, so reaching
// the cap here means the bytes changed mid-read and the export fails closed.
async function collectDownload(
  stream: AsyncGenerator<Buffer>,
  expectedSizeBytes: number,
): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      total += chunk.length;
      if (total > expectedSizeBytes) return undefined;
      chunks.push(chunk);
    }
  } catch {
    return undefined;
  }
  if (total !== expectedSizeBytes) return undefined;
  return Buffer.concat(chunks);
}

export async function exportWorkspaceBundle(
  engagementId: string,
  options: { readonly privateCopy: boolean },
  deps: WorkspaceBundleDependencies,
): Promise<WorkspaceBundleResult<WorkspaceBundleExport>> {
  const detail = deps.engagements.getEngagement(engagementId);
  if (!detail.ok) return failed(mapRepositoryError(detail.error.code));
  const notes = deps.engagements.getEngagementNotes(engagementId);
  if (!notes.ok) return failed(mapRepositoryError(notes.error.code));
  const findings = deps.engagements.listFindings(engagementId);
  if (!findings.ok) return failed(mapRepositoryError(findings.error.code));
  const leadRows = deps.leads.listLeads(engagementId);
  if (!leadRows.ok) return failed(mapRepositoryError(leadRows.error.code));
  const excerptRows = deps.excerpts.listExcerpts(engagementId);
  if (!excerptRows.ok) return failed(mapRepositoryError(excerptRows.error.code));
  const attachmentRows = deps.excerpts.listAttachments(engagementId);
  if (!attachmentRows.ok) return failed(mapRepositoryError(attachmentRows.error.code));
  const artifactRows = deps.runs.listArtifactsForEngagement(engagementId);
  if (!artifactRows.ok) return failed(mapRepositoryError(artifactRows.code));

  // Attempts follow their lead order with per-lead sequence order, so import
  // re-records them in the same order and sequence numbers line up.
  const attempts: WorkspaceBundle["attempts"] = [];
  for (const lead of leadRows.value) {
    const listed = deps.leads.listAttempts(engagementId, lead.id);
    if (!listed.ok) return failed(mapRepositoryError(listed.error.code));
    attempts.push(...listed.value);
  }

  // Raw totals first: an engagement over the transport cap is refused before
  // a single content byte is read.
  let rawTotal = 0;
  for (const artifact of artifactRows.artifacts) {
    if (artifact.sizeBytes > WORKSPACE_BUNDLE_MAX_EVIDENCE_FILE_BYTES) {
      return failed("bundle_too_large");
    }
    rawTotal += artifact.sizeBytes;
    if (rawTotal > WORKSPACE_BUNDLE_MAX_EVIDENCE_BYTES) {
      return failed("bundle_too_large");
    }
  }

  const evidence: WorkspaceBundle["evidence"] = [];
  for (const artifact of artifactRows.artifacts) {
    const download = await deps.store.verifiedDownload({
      artifactId: artifact.artifactId,
      expectedSizeBytes: artifact.sizeBytes,
      expectedDigest: artifact.digest,
    });
    if (download.status !== "ready") return failed("invalid_persisted_data");
    const bytes = await collectDownload(download.stream, artifact.sizeBytes);
    if (bytes === undefined) return failed("invalid_persisted_data");
    evidence.push({
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      sizeBytes: artifact.sizeBytes,
      digest: artifact.digest,
      completeness: artifact.completeness,
      artifactSlot: artifact.artifactSlot,
      originalRunId: artifact.runId,
      contentBase64: bytes.toString("base64"),
    });
  }

  const attachments: WorkspaceBundle["attachments"] = [];
  for (const attachment of attachmentRows.value) {
    const bytes = deps.excerpts.attachmentBytes(engagementId, attachment.id);
    if (!bytes.ok) return failed(mapRepositoryError(bytes.error.code));
    const raw = Buffer.from(bytes.value.contentBase64, "base64");
    if (raw.length !== attachment.sizeBytes || sha256Hex(raw) !== attachment.digest) {
      return failed("invalid_persisted_data");
    }
    attachments.push({ ...attachment, contentBase64: bytes.value.contentBase64 });
  }

  const engagement = detail.value.engagement;
  const bundle = {
    kind: WORKSPACE_BUNDLE_KIND,
    bundleVersion: WORKSPACE_BUNDLE_VERSION,
    exportedAt: (deps.now ?? (() => new Date()))().toISOString(),
    sourceEngagementId: engagement.id,
    sourceEngagementName: engagement.name,
    privateCopy: options.privateCopy,
    engagement: {
      name: engagement.name,
      kind: engagement.kind,
      deadlineAt: engagement.deadlineAt,
      description: options.privateCopy ? engagement.description : null,
      authorizationContext:
        options.privateCopy ? engagement.authorizationContext : null,
    },
    notes: {
      markdown: notes.value.markdown,
      updatedAt: notes.value.updatedAt,
    },
    leads: leadRows.value,
    attempts,
    excerpts: excerptRows.value,
    attachments,
    findings: findings.value,
    evidence,
    secrets: [],
    objectives: [],
  } as const;

  let secrets: WorkspaceBundle["secrets"] = [];
  let objectives: WorkspaceBundle["objectives"] = [];
  if (options.privateCopy) {
    const listedSecrets = deps.secrets.listSecrets(engagementId);
    if (!listedSecrets.ok) return failed(mapRepositoryError(listedSecrets.error.code));
    const listedObjectives = deps.objectives.listObjectives(engagementId);
    if (!listedObjectives.ok) {
      return failed(mapRepositoryError(listedObjectives.error.code));
    }
    secrets = listedSecrets.value;
    objectives = listedObjectives.value;
  }

  const parsed = WorkspaceBundleSchema.safeParse({
    ...bundle,
    secrets,
    objectives,
  });
  if (!parsed.success) return failed("invalid_persisted_data");
  if (checkWorkspaceBundleBounds(parsed.data).ok === false) {
    return failed("bundle_too_large");
  }
  // The record and byte caps above do not bound attachment image bytes, so
  // the finished file is measured directly: an export the import route would
  // refuse through its body limit is refused here instead of shipped.
  if (
    Buffer.byteLength(JSON.stringify(parsed.data), "utf8") >
    WORKSPACE_BUNDLE_MAX_JSON_BYTES
  ) {
    return failed("bundle_too_large");
  }
  return { ok: true, value: { bundle: parsed.data } };
}

interface VerifiedEvidenceBytes {
  readonly entry: WorkspaceBundle["evidence"][number];
  readonly bytes: Buffer;
}

interface VerifiedAttachmentBytes {
  readonly attachment: WorkspaceBundle["attachments"][number];
  readonly bytes: Buffer;
}

function decodeBounded(
  contentBase64: string,
  expectedSizeBytes: number,
): Buffer | undefined {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(contentBase64, "base64");
  } catch {
    return undefined;
  }
  if (bytes.length !== expectedSizeBytes) return undefined;
  return bytes;
}

export async function importWorkspaceBundle(
  input: unknown,
  deps: WorkspaceBundleDependencies,
): Promise<WorkspaceBundleResult<WorkspaceBundleImport>> {
  // Clear version error before full validation: a newer or foreign bundle
  // kind is unsupported, not merely malformed.
  const probe = WorkspaceBundleVersionProbeSchema.safeParse(input);
  if (!probe.success) return failed("invalid_request");
  if (
    probe.data.kind !== WORKSPACE_BUNDLE_KIND ||
    probe.data.bundleVersion !== WORKSPACE_BUNDLE_VERSION
  ) {
    return failed("unsupported_bundle_version");
  }
  const parsed = WorkspaceBundleSchema.safeParse(input);
  if (!parsed.success) return failed("invalid_request");
  const bundle = parsed.data;
  if (checkWorkspaceBundleBounds(bundle).ok === false) {
    return failed("bundle_too_large");
  }
  if (workspaceBundleRawBytes(bundle.evidence) > WORKSPACE_BUNDLE_MAX_EVIDENCE_BYTES) {
    return failed("bundle_too_large");
  }

  // Every carried byte is hash-checked before the first write, so a tampered
  // file is rejected without creating anything.
  const verifiedEvidence: VerifiedEvidenceBytes[] = [];
  for (const entry of bundle.evidence) {
    const bytes = decodeBounded(entry.contentBase64, entry.sizeBytes);
    if (bytes === undefined || sha256Hex(bytes) !== entry.digest) {
      return failed("bundle_digest_mismatch");
    }
    verifiedEvidence.push({ entry, bytes });
  }
  const verifiedAttachments: VerifiedAttachmentBytes[] = [];
  for (const attachment of bundle.attachments) {
    const bytes = decodeBounded(attachment.contentBase64, attachment.sizeBytes);
    if (bytes === undefined || sha256Hex(bytes) !== attachment.digest) {
      return failed("bundle_digest_mismatch");
    }
    verifiedAttachments.push({ attachment, bytes });
  }

  const now = (deps.now ?? (() => new Date()))().toISOString();
  const created = deps.engagements.createEngagement({
    name: bundle.engagement.name,
    kind: bundle.engagement.kind,
    description: bundle.engagement.description,
    authorizationContext: bundle.engagement.authorizationContext,
    autoContinueWarnings: false,
    ...(bundle.engagement.deadlineAt === null ?
      {}
    : { deadlineAt: bundle.engagement.deadlineAt }),
  });
  if (!created.ok) return failed("invalid_persisted_data");
  const engagementId = created.value.id;

  // Post-create failures compensate every database row this import wrote, so
  // a failed import never leaves a partial engagement behind. Published bytes
  // cannot be removed through the store interface; they stay as unreferenced
  // objects, exactly like interrupted runner uploads.
  const ledger: {
    actionId?: string;
    runId?: string;
    artifactIds: string[];
  } = { artifactIds: [] };
  const fail = <T>(code: WorkspaceBundleErrorCode): WorkspaceBundleResult<T> => {
    compensateImport(deps.sqlite, {
      engagementId,
      ...(ledger.actionId === undefined ? {} : { actionId: ledger.actionId }),
      ...(ledger.runId === undefined ? {} : { runId: ledger.runId }),
      artifactIds: ledger.artifactIds,
    });
    return failed(code);
  };

  const noted = deps.engagements.putEngagementNotes(engagementId, {
    markdown: bundle.notes.markdown,
    expectedRevision: 0,
  });
  if (!noted.ok) return fail("invalid_persisted_data");

  // One synthetic import run owns every rehydrated artifact. Runs require an
  // action parent; both rows are import provenance, never operator history.
  const actionId = randomUUID();
  const runId = randomUUID();
  ledger.actionId = actionId;
  ledger.runId = runId;
  try {
    deps.sqlite
      .prepare(
        "insert into actions (id, contract_version, engagement_id, revision, state, queued_snapshot_version, warning_interactions, run_state, resume_requested, cleanup_required, capability_error_code, pending_warning_json, created_at, updated_at) values (?,?,?,1,'succeeded',null,0,null,0,0,null,null,?,?)",
      )
      .run(actionId, 1, engagementId, now, now);
    deps.sqlite
      .prepare(
        "insert into runs (id, contract_version, action_id, engagement_id, attempt, state, current_lease_id, current_fence, terminal_kind, terminal_reason, created_at, updated_at) values (?,?,?,?,1,'succeeded',null,'1','succeeded',null,?,?)",
      )
      .run(runId, 1, actionId, engagementId, now, now);
  } catch (error) {
    return fail(storageCode(error));
  }

  // Evidence bytes move through the same staging plus exclusive publish path
  // as runner uploads, then land as new artifact rows under the import run.
  const newArtifactIds = verifiedEvidence.map(() => randomUUID());
  const artifactRemap = planIdRemap(
    verifiedEvidence.map(({ entry }) => entry.artifactId),
    newArtifactIds,
  );
  if (artifactRemap === undefined) return fail("invalid_persisted_data");
  for (let index = 0; index < verifiedEvidence.length; index += 1) {
    const item = verifiedEvidence[index] as VerifiedEvidenceBytes;
    const newArtifactId = newArtifactIds[index] as string;
    const stored = await publishImportedBytes(deps, item.bytes);
    if (stored === undefined) return fail("invalid_persisted_data");
    const renamed = deps.store.publish({
      uploadId: stored,
      artifactId: newArtifactId,
      expectedSizeBytes: item.entry.sizeBytes,
    });
    if (renamed.status !== "published") return fail("invalid_persisted_data");
    ledger.artifactIds.push(newArtifactId);
    const redaction =
      item.entry.kind === "stdout" || item.entry.kind === "stderr" ?
        { applied: 1, boundary: "runner_stream", preserved: 0 }
      : { applied: 0, boundary: "none", preserved: 1 };
    try {
      deps.sqlite
        .prepare(
          "insert into evidence_artifacts (artifact_id, contract_version, profile, run_id, fence, event_sequence, artifact_slot, kind, size_bytes, digest, relative_path, completeness, redaction_applied, redaction_boundary, raw_bytes_preserved, created_at) values (?,?,'d3-v1',?,'1',?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          newArtifactId,
          1,
          runId,
          index + 1,
          item.entry.artifactSlot,
          item.entry.kind,
          item.entry.sizeBytes,
          item.entry.digest,
          `published/${newArtifactId}`,
          item.entry.completeness,
          redaction.applied,
          redaction.boundary,
          redaction.preserved,
          now,
        );
    } catch (error) {
      return fail(storageCode(error));
    }
    // Re-derive discovery projections from the same bytes so the imported
    // engagement keeps its services, probes, and ffuf results.
    for (const projection of [
      deps.nmapProjection,
      deps.httpProbeProjection,
      deps.ffufProjection,
    ]) {
      const projected = await projection.projectForArtifact(newArtifactId);
      if (!projected.ok) return fail("invalid_persisted_data");
    }
  }

  const leadRemap = new Map<string, string>();
  for (const lead of bundle.leads) {
    const made = deps.leads.createLead(engagementId, {
      title: lead.title,
      ...(lead.target === null ? {} : { target: lead.target }),
      ...(lead.serviceRef === null ? {} : { serviceRef: lead.serviceRef }),
      source: {
        kind: lead.source.kind,
        ref: lead.source.ref,
        ...(lead.source.label === undefined ? {} : { label: lead.source.label }),
      },
      ...(lead.nextStep === null ? {} : { nextStep: lead.nextStep }),
    });
    if (!made.ok) return fail("invalid_persisted_data");
    const newLeadId = made.value.id;
    if (lead.disposition === "parked") {
      const parked = deps.leads.parkLead(engagementId, newLeadId, {
        reason: lead.parkReason ?? "Parked before export.",
        ...(lead.testedConditions === null ? {} : { testedConditions: lead.testedConditions }),
      });
      if (!parked.ok) return fail("invalid_persisted_data");
    } else if (lead.disposition === "closed") {
      const closed = deps.leads.closeLead(engagementId, newLeadId, {
        ...(lead.closedNote === null ? {} : { note: lead.closedNote }),
      });
      if (!closed.ok) return fail("invalid_persisted_data");
    }
    // Quiet revisit suggestions are not carried: they name transient runner
    // conditions from the source machine. The parked reason stays, so the
    // context that produced the suggestion is still visible.
    leadRemap.set(lead.id, newLeadId);
  }

  let objectiveRemap = new Map<string, string>();
  if (bundle.privateCopy) {
    const restored = restorePrivateRecords(deps, engagementId, bundle, now);
    if (!restored.ok) return fail(restored.error.code);
    objectiveRemap = new Map(restored.value);
  }

  const findingRemap = new Map<string, string>();
  for (const finding of bundle.findings) {
    const made = deps.engagements.createFinding(engagementId, {
      title: finding.title,
      severity: finding.severity,
      body: finding.body,
      evidenceArtifactIds: remapStoredRefs(finding.evidenceArtifactIds, artifactRemap),
    });
    if (!made.ok) return fail("invalid_persisted_data");
    if (finding.status === "resolved") {
      const resolved = deps.engagements.resolveFinding(engagementId, made.value.id);
      if (!resolved.ok) return fail("invalid_persisted_data");
    }
    findingRemap.set(finding.id, made.value.id);
  }

  for (const attempt of bundle.attempts) {
    const newLeadId = leadRemap.get(attempt.leadId);
    if (newLeadId === undefined) return fail("invalid_persisted_data");
    const recorded = deps.leads.recordAttempt(engagementId, newLeadId, {
      summary: attempt.summary,
      outcome: attempt.outcome,
      ...(attempt.conditions === null ? {} : { conditions: attempt.conditions }),
      evidenceArtifactIds: remapStoredRefs(attempt.evidenceArtifactIds, artifactRemap),
      ...(attempt.linkedFindingId === null ||
      findingRemap.get(attempt.linkedFindingId) === undefined ?
        {}
      : { linkedFindingId: findingRemap.get(attempt.linkedFindingId) as string }),
      ...(attempt.linkedObjectiveId === null ||
      objectiveRemap.get(attempt.linkedObjectiveId) === undefined ?
        {}
      : {
          linkedObjectiveId: objectiveRemap.get(attempt.linkedObjectiveId) as string,
        }),
    });
    if (!recorded.ok) return fail("invalid_persisted_data");
  }

  for (const excerpt of bundle.excerpts) {
    const newArtifactId = artifactRemap.get(excerpt.artifactId);
    if (newArtifactId === undefined) return fail("invalid_persisted_data");
    const made = deps.excerpts.createExcerpt({
      engagementId,
      runId,
      artifactId: newArtifactId,
      artifactDigest: excerpt.artifactDigest,
      stream: excerpt.stream,
      byteOffset: excerpt.byteOffset,
      byteLength: excerpt.byteLength,
      content: excerpt.content,
      redactions: excerpt.redactions,
      targetNote: excerpt.targetNote,
    });
    if (!made.ok) return fail("invalid_persisted_data");
  }

  // Parents before children via the domain ordering, which rejects missing
  // parents and cycles before the first attachment write.
  const ordered = orderAttachmentsForImport(
    verifiedAttachments.map(({ attachment }) => attachment),
  );
  if (!ordered.ok) return fail("invalid_persisted_data");
  const attachmentRemap = new Map<string, string>();
  for (const attachment of ordered.ordered) {
    const parent =
      attachment.parentAttachmentId === null ?
        null
      : (attachmentRemap.get(attachment.parentAttachmentId) ?? null);
    if (attachment.parentAttachmentId !== null && parent === null) {
      return fail("invalid_persisted_data");
    }
    const made = deps.excerpts.createAttachment({
      engagementId,
      filename: attachment.filename,
      mime: attachment.mime,
      sizeBytes: attachment.sizeBytes,
      digest: attachment.digest,
      caption: attachment.caption,
      targetLabel: attachment.targetLabel,
      parentAttachmentId: parent,
      cropRectJson: attachment.crop === null ? null : JSON.stringify(attachment.crop),
      contentBase64: attachment.contentBase64,
    });
    if (!made.ok) return fail("invalid_persisted_data");
    attachmentRemap.set(attachment.id, made.value.id);
  }

  return {
    ok: true,
    value: { engagementId, summary: summarizeWorkspaceBundle(bundle) },
  };
}

export interface ImportLedger {
  readonly engagementId: string;
  readonly actionId?: string;
  readonly runId?: string;
  readonly artifactIds: readonly string[];
}

// Best-effort removal of every database row one import created, in reverse
// dependency order. Runs when any post-create step fails so a failed import
// never leaves a partial engagement behind. Published bytes stay as
// unreferenced objects; the store interface offers no removal path and raw
// filesystem deletes would bypass its descriptor defenses.
function compensateImport(
  sqlite: WorkspaceBundleDependencies["sqlite"],
  created: ImportLedger,
): void {
  try {
    if (created.artifactIds.length > 0) {
      const placeholders = created.artifactIds.map(() => "?").join(",");
      const ids = [...created.artifactIds];
      sqlite
        .prepare(`delete from nmap_services where artifact_id in (${placeholders})`)
        .run(...ids);
      sqlite
        .prepare(`delete from http_probe_results where artifact_id in (${placeholders})`)
        .run(...ids);
      sqlite
        .prepare(`delete from ffuf_results where artifact_id in (${placeholders})`)
        .run(...ids);
    }
    if (created.runId !== undefined) {
      sqlite
        .prepare("delete from evidence_artifacts where run_id = ?")
        .run(created.runId);
    }
    sqlite
      .prepare("delete from evidence_excerpts where engagement_id = ?")
      .run(created.engagementId);
    sqlite
      .prepare(
        "delete from evidence_attachments where engagement_id = ? and parent_attachment_id is not null",
      )
      .run(created.engagementId);
    sqlite
      .prepare("delete from evidence_attachments where engagement_id = ?")
      .run(created.engagementId);
    sqlite
      .prepare("delete from lead_attempts where engagement_id = ?")
      .run(created.engagementId);
    sqlite.prepare("delete from leads where engagement_id = ?").run(created.engagementId);
    sqlite
      .prepare("delete from findings where engagement_id = ?")
      .run(created.engagementId);
    sqlite
      .prepare("delete from secret_verifications where engagement_id = ?")
      .run(created.engagementId);
    sqlite
      .prepare("delete from secrets where engagement_id = ?")
      .run(created.engagementId);
    sqlite
      .prepare("delete from objectives where engagement_id = ?")
      .run(created.engagementId);
    sqlite
      .prepare("delete from engagement_notes where engagement_id = ?")
      .run(created.engagementId);
    if (created.runId !== undefined) {
      sqlite
        .prepare("delete from runs where id = ? and engagement_id = ?")
        .run(created.runId, created.engagementId);
    }
    if (created.actionId !== undefined) {
      sqlite
        .prepare("delete from actions where id = ? and engagement_id = ?")
        .run(created.actionId, created.engagementId);
    }
    sqlite.prepare("delete from engagements where id = ?").run(created.engagementId);
  } catch {
    // The original error code still reports the failure. Remaining rows
    // belong to an engagement id that was never returned to the operator.
  }
}

// Staged write of already-verified import bytes. Returns the upload id for
// the exclusive publish step, or undefined when storage refuses.
async function publishImportedBytes(
  deps: WorkspaceBundleDependencies,
  bytes: Buffer,
): Promise<string | undefined> {
  const uploadId = randomUUID();
  const opened = deps.store.openStagingFile(uploadId);
  if (!opened.ok) return undefined;
  const fd = opened.fd;
  try {
    for (let offset = 0; offset < bytes.length; offset += 256 * 1024) {
      await deps.store.writeStagedChunk(fd, bytes.subarray(offset, offset + 256 * 1024));
    }
    await deps.store.finalizeStagedWrite(fd);
  } catch {
    try {
      await deps.store.closeStagedFile(fd);
    } catch {
      // The staging name is unique to this import; a failed write is never
      // published and never referenced.
    }
    return undefined;
  }
  try {
    await deps.store.closeStagedFile(fd);
  } catch {
    return undefined;
  }
  return uploadId;
}

// Private-copy records only. Secrets carry references and masked hints by
// construction; objectives restore proof digests and hints without proof
// values, which the server never stores. Returns the objective id remap for
// attempt linkage.
function restorePrivateRecords(
  deps: WorkspaceBundleDependencies,
  engagementId: string,
  bundle: WorkspaceBundle,
  now: string,
): WorkspaceBundleResult<ReadonlyMap<string, string>> {
  for (const secret of bundle.secrets) {
    const made = deps.secrets.createSecret(engagementId, {
      label: secret.label,
      ...(secret.username === null ? {} : { username: secret.username }),
      serviceRef: secret.serviceRef,
      secretRef: secret.secretRef,
      ...(secret.hint === null ? {} : { hint: secret.hint }),
    });
    if (!made.ok) return failed("invalid_persisted_data");
    for (const verification of secret.verifications) {
      const recorded = deps.secrets.recordVerification(engagementId, made.value.id, {
        result: verification.result,
        method: verification.method,
        ...(verification.note === null ? {} : { note: verification.note }),
      });
      if (!recorded.ok) return failed("invalid_persisted_data");
    }
  }

  const objectiveRemap = new Map<string, string>();
  for (const objective of bundle.objectives) {
    const made = deps.objectives.createObjective(engagementId, {
      name: objective.name,
      kind: objective.kind,
    });
    if (!made.ok) return failed("invalid_persisted_data");
    // Capture and submit transitions need the raw proof value, which never
    // leaves the source machine. The digest, hint, state, and timestamps are
    // restored directly so the record keeps working without the value.
    try {
      const result = deps.sqlite
        .prepare(
          "update objectives set state=?, proof_hint=?, proof_digest=?, captured_at=?, submitted_at=?, updated_at=? where id=? and engagement_id=?",
        )
        .run(
          objective.state,
          objective.proofHint,
          objective.proofDigest,
          objective.capturedAt,
          objective.submittedAt,
          now,
          made.value.id,
          engagementId,
        );
      if (result.changes !== 1) return failed("invalid_persisted_data");
    } catch (error) {
      return failed(storageCode(error));
    }
    objectiveRemap.set(objective.id, made.value.id);
  }
  return { ok: true, value: objectiveRemap };
}
