import {
  CreateAdvisorExplanationRequestSchema,
  type AdvisorEvidenceBlock,
  type AdvisorSuppliedEvidenceId,
} from "@stonehush/contracts";
import type { EngagementRepository, EvidenceGrantRepository } from "@stonehush/db";
import {
  ADVISOR_HISTORY_ENTRY_MAX_BYTES,
  ADVISOR_HISTORY_MAX_TURNS,
  advisorUtf8ByteLength,
  buildAdvisorExplanationPrompt,
  truncateUtf8Bytes,
  type AdvisorExplanationPrompt,
  type AdvisorHistoryTurn,
} from "@stonehush/domain";

import type { EvidenceStore } from "../evidence/evidence-store.js";

/**
 * Evidence context assembly for read-only explanations. Orchestrates
 * repository and store reads, so it lives in the API layer over narrow
 * Picks of the production types; the domain package keeps only pure
 * rules. Membership comes from per-ID scoped lookups that already
 * enforce BOTH run and action engagement matches; unknown and foreign
 * ids are identically absent, so no existence oracle exists. Every
 * requested id resolves before ANY store read, so a foreign id anywhere
 * in the selection means zero bytes leave the store. Success carries
 * only the redacted prompt, validated supplied ids, and safe bounded
 * metadata, never raw blocks, bytes, questions, or history.
 */

export const ADVISOR_EXCERPT_MAX_BYTES = 4_096 as const;
export const ADVISOR_FINDING_TEXT_MAX_BYTES = 2_000 as const;
export const ADVISOR_HISTORY_TURNS_MAX = ADVISOR_HISTORY_MAX_TURNS;

export interface AdvisorContextDeps {
  readonly engagements: Pick<EngagementRepository, "getEngagement" | "getFindingForEngagement">;
  readonly artifacts: Pick<EvidenceGrantRepository, "publishedArtifactForEngagement">;
  readonly excerpts: Pick<EvidenceStore, "verifiedExcerpt">;
}

export interface AssembleAdvisorContextInput {
  readonly request: unknown;
  /**
   * Route-supplied, engagement-scoped prior turns only. Never public input:
   * shape, count, and bytes are validated here before any dependency runs.
   */
  readonly history: readonly unknown[];
}

export type AssembleAdvisorContextErrorCode =
  | "invalid_input"
  | "unknown_artifact"
  | "unknown_finding"
  | "missing_artifact"
  | "corrupt_artifact"
  | "context_too_large"
  | "engagement_not_found"
  | "storage_busy"
  | "invalid_persisted_data";

export interface AdvisorContextExcerptMeta {
  readonly id: string;
  readonly truncated: boolean;
  readonly totalBytes: number;
}

export interface AdvisorContextSuccess {
  readonly prompt: AdvisorExplanationPrompt;
  readonly suppliedIds: readonly AdvisorSuppliedEvidenceId[];
  readonly redactions: number;
  readonly historyTruncated: boolean;
  readonly excerpts: readonly AdvisorContextExcerptMeta[];
}

export type AssembleAdvisorContextResult =
  | { readonly ok: true; readonly value: AdvisorContextSuccess }
  | { readonly ok: false; readonly error: { readonly code: AssembleAdvisorContextErrorCode } };

const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

function failed(code: AssembleAdvisorContextErrorCode): AssembleAdvisorContextResult {
  return { ok: false, error: { code } };
}

function storageError(error: unknown): AssembleAdvisorContextErrorCode {
  const code = (error as { code?: unknown }).code;
  return code === "SQLITE_BUSY" || code === "SQLITE_BUSY_TIMEOUT"
    ? "storage_busy"
    : "invalid_persisted_data";
}

function passthrough(code: string): AssembleAdvisorContextErrorCode {
  if (
    code === "engagement_not_found" ||
    code === "storage_busy" ||
    code === "invalid_persisted_data"
  ) {
    return code;
  }
  return "invalid_persisted_data";
}

function isHistoryTurn(value: unknown): value is AdvisorHistoryTurn {
  if (typeof value !== "object" || value === null) return false;
  const turn = value as { question?: unknown; answer?: unknown };
  return (
    typeof turn.question === "string" &&
    typeof turn.answer === "string" &&
    advisorUtf8ByteLength(turn.question) <= ADVISOR_HISTORY_ENTRY_MAX_BYTES &&
    advisorUtf8ByteLength(turn.answer) <= ADVISOR_HISTORY_ENTRY_MAX_BYTES
  );
}

export async function assembleAdvisorContext(
  input: AssembleAdvisorContextInput,
  deps: AdvisorContextDeps,
): Promise<AssembleAdvisorContextResult> {
  // Pure validation first: no dependency (and no store byte) is touched
  // until the request and history shapes, counts, and budgets check out.
  const request = CreateAdvisorExplanationRequestSchema.safeParse(input.request);
  if (!request.success) return failed("invalid_input");
  if (
    !Array.isArray(input.history) ||
    input.history.length > ADVISOR_HISTORY_TURNS_MAX ||
    !input.history.every(isHistoryTurn)
  ) {
    return failed("invalid_input");
  }
  const history = input.history as readonly AdvisorHistoryTurn[];
  const { engagementId, question, excerptArtifactIds, findingIds } = request.data;

  try {
    const engagement = deps.engagements.getEngagement(engagementId);
    if (!engagement.ok) return failed(passthrough(engagement.error.code));

    // Resolve every requested id before any store read: a single unknown or
    // foreign id anywhere fails the whole assembly with zero bytes read.
    const records = [];
    for (const artifactId of excerptArtifactIds) {
      const record = deps.artifacts.publishedArtifactForEngagement({ engagementId, artifactId });
      if (record === undefined) return failed("unknown_artifact");
      records.push(record);
    }
    const findings = [];
    for (const findingId of findingIds) {
      const found = deps.engagements.getFindingForEngagement(engagementId, findingId);
      if (!found.ok) {
        if (found.error.code === "finding_not_found") return failed("unknown_finding");
        return failed(passthrough(found.error.code));
      }
      findings.push(found.value);
    }

    const blocks: AdvisorEvidenceBlock[] = [];
    const suppliedIds: AdvisorSuppliedEvidenceId[] = [];
    const excerpts: AdvisorContextExcerptMeta[] = [];
    for (const record of records) {
      const excerpt = await deps.excerpts.verifiedExcerpt({
        artifactId: record.artifactId,
        expectedSizeBytes: record.sizeBytes,
        expectedDigest: record.digest,
        maxBytes: ADVISOR_EXCERPT_MAX_BYTES,
      });
      if (excerpt.status === "missing") return failed("missing_artifact");
      if (excerpt.status === "corrupt") return failed("corrupt_artifact");
      // Deterministic lossy decode plus a truthful byte-count marker when
      // the store truncated: 4096 content bytes plus the marker always fit
      // the 8192 per-block cap (finding title <= 120 chars plus 2000-byte
      // clipped body likewise fits).
      let text = utf8Decoder.decode(excerpt.content);
      if (excerpt.truncated) {
        text += `\n[excerpt truncated: first ${excerpt.content.length} of ${excerpt.totalBytes} bytes]`;
      }
      blocks.push({ kind: "artifact", id: record.artifactId, text });
      suppliedIds.push({ kind: "artifact", id: record.artifactId });
      excerpts.push({
        id: record.artifactId,
        truncated: excerpt.truncated,
        totalBytes: excerpt.totalBytes,
      });
    }
    for (const finding of findings) {
      blocks.push({
        kind: "finding",
        id: finding.id,
        text: `${finding.title}\n${truncateUtf8Bytes(finding.body, ADVISOR_FINDING_TEXT_MAX_BYTES)}`,
      });
      suppliedIds.push({ kind: "finding", id: finding.id });
    }

    const built = buildAdvisorExplanationPrompt({ question, evidenceBlocks: blocks, history });
    if (!built.ok) {
      return failed(built.error.code);
    }
    return {
      ok: true,
      value: {
        prompt: built.prompt,
        suppliedIds,
        redactions: built.prompt.redactions,
        historyTruncated: built.prompt.historyTruncated,
        excerpts,
      },
    };
  } catch (error) {
    return failed(storageError(error));
  }
}
