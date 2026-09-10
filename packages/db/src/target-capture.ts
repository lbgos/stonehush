import { createHash } from "node:crypto";

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, asc, eq } from "drizzle-orm";
import {
  STONE_CAPTURE_CONTRACT_VERSION,
  STONE_TARGET_CONTRACT_VERSION,
  findInventedExecutionFacts,
  originLabelForKind,
  type StoneCapture,
  type StoneCaptureKind,
  type StoneHostnameAssociation,
  type StoneTarget,
} from "@blackglass/contracts";
import {
  decideRedirectHostnameAssociation,
  planAddressChange,
  proposeRedirectHostnameAssociation,
} from "@blackglass/domain";

import * as schema from "./schema.js";
import {
  engagements,
  stoneAddressBindings,
  stoneCaptures,
  stoneHostnameAssociations,
  stoneTargets,
} from "./schema.js";

type Database = BetterSQLite3Database<typeof schema>;

export type StoneTargetCaptureErrorCode =
  | "engagement_not_found"
  | "target_not_found"
  | "association_not_found"
  | "invalid_request"
  | "storage_busy"
  | "invalid_persisted_data";

export type StoneTargetCaptureResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: StoneTargetCaptureErrorCode } };

export interface StoneTargetCaptureProviders {
  createId: () => string;
  now: () => Date;
}

export interface CreateStoneTargetInput {
  engagementId: string;
  label: string;
  initialAddress: string;
}

export interface CreateStoneCaptureInput {
  engagementId: string;
  targetId: string | null;
  leadId: string | null;
  kind: StoneCaptureKind;
  title: string;
  command?: string | undefined;
  observation?: string | undefined;
  contentText?: string | undefined;
  contentDigest?: string | undefined;
  fileName?: string | undefined;
  byteSize?: number | undefined;
  rawBody?: unknown;
}

function busyOrCorrupt(error: unknown): StoneTargetCaptureResult<never> {
  const code = (error as { code?: string })?.code;
  if (code === "SQLITE_BUSY" || code === "SQLITE_BUSY_TIMEOUT") {
    return { ok: false, error: { code: "storage_busy" } };
  }
  return { ok: false, error: { code: "invalid_persisted_data" } };
}

export function digestStoneCaptureContent(content: string | Uint8Array): string {
  const hash = createHash("sha256");
  hash.update(typeof content === "string" ? content : Buffer.from(content));
  return `sha256:${hash.digest("hex")}`;
}

// Digest resolution for captures. Presented content is always the digest
// source of truth: an asserted digest that mismatches recomputed content is
// rejected, so identical bytes cannot bypass dedupe under a second digest and
// foreign bytes cannot collapse onto another item digest. Asserted digests
// are honored only for digest-only imports whose bytes the server never saw.
// Captures with neither content nor digest are rejected: metadata-only
// digests would collide unrelated items sharing a title.
function resolveStoneCaptureDigest(input: CreateStoneCaptureInput): string | null {
  if (input.contentText !== undefined) {
    const computed = digestStoneCaptureContent(input.contentText);
    if (input.contentDigest !== undefined && input.contentDigest !== computed) {
      return null;
    }
    return computed;
  }
  return input.contentDigest ?? null;
}

function toTarget(row: typeof stoneTargets.$inferSelect): StoneTarget {
  return {
    contractVersion: STONE_TARGET_CONTRACT_VERSION,
    id: row.id,
    engagementId: row.engagementId,
    label: row.label,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class StoneTargetRepository {
  constructor(
    private readonly db: Database,
    private readonly providers: StoneTargetCaptureProviders,
  ) {}

  private requireEngagement(engagementId: string): boolean {
    const row = this.db
      .select({ id: engagements.id })
      .from(engagements)
      .where(eq(engagements.id, engagementId))
      .get();
    return row !== undefined;
  }

  createTarget(input: CreateStoneTargetInput): StoneTargetCaptureResult<StoneTarget> {
    try {
      if (!this.requireEngagement(input.engagementId)) {
        return { ok: false, error: { code: "engagement_not_found" } };
      }
      const label = input.label.trim();
      if (label.length === 0 || Array.from(label).length > 120) {
        return { ok: false, error: { code: "invalid_request" } };
      }
      const plan = planAddressChange([], { newAddressText: input.initialAddress });
      if (!plan.ok) return { ok: false, error: { code: "invalid_request" } };
      const now = this.providers.now().toISOString();
      const targetId = this.providers.createId();
      const bindingId = this.providers.createId();
      this.db.transaction(
        (tx) => {
          tx.insert(stoneTargets)
            .values({
              id: targetId,
              contractVersion: STONE_TARGET_CONTRACT_VERSION,
              engagementId: input.engagementId,
              label,
              revision: 1,
              createdAt: now,
              updatedAt: now,
            })
            .run();
          tx.insert(stoneAddressBindings)
            .values({
              id: bindingId,
              contractVersion: STONE_TARGET_CONTRACT_VERSION,
              engagementId: input.engagementId,
              targetId,
              bindingKind: plan.bindingKind,
              addressText: plan.addressText,
              status: "current",
              createdAt: now,
              supersededAt: null,
            })
            .run();
        },
        { behavior: "immediate" },
      );
      const row = this.db
        .select()
        .from(stoneTargets)
        .where(eq(stoneTargets.id, targetId))
        .get();
      if (row === undefined) return { ok: false, error: { code: "invalid_persisted_data" } };
      return { ok: true, value: toTarget(row) };
    } catch (error) {
      return busyOrCorrupt(error);
    }
  }

  listTargets(engagementId: string): StoneTargetCaptureResult<StoneTarget[]> {
    try {
      if (!this.requireEngagement(engagementId)) {
        return { ok: false, error: { code: "engagement_not_found" } };
      }
      const rows = this.db
        .select()
        .from(stoneTargets)
        .where(eq(stoneTargets.engagementId, engagementId))
        .orderBy(asc(stoneTargets.createdAt))
        .all();
      return { ok: true, value: rows.map(toTarget) };
    } catch (error) {
      return busyOrCorrupt(error);
    }
  }

  listBindings(input: {
    engagementId: string;
    targetId: string;
  }): StoneTargetCaptureResult<
    {
      bindings: {
        id: string;
        engagementId: string;
        targetId: string;
        bindingKind: "ip" | "hostname";
        addressText: string;
        status: "current" | "historical";
        createdAt: string;
        supersededAt: string | null;
      }[];
    }
  > {
    try {
      if (!this.requireEngagement(input.engagementId)) {
        return { ok: false, error: { code: "engagement_not_found" } };
      }
      const target = this.db
        .select()
        .from(stoneTargets)
        .where(eq(stoneTargets.id, input.targetId))
        .get();
      if (target === undefined || target.engagementId !== input.engagementId) {
        return { ok: false, error: { code: "target_not_found" } };
      }
      const rows = this.db
        .select()
        .from(stoneAddressBindings)
        .where(
          and(
            eq(stoneAddressBindings.targetId, input.targetId),
            eq(stoneAddressBindings.engagementId, input.engagementId),
          ),
        )
        .orderBy(asc(stoneAddressBindings.createdAt))
        .all();
      return {
        ok: true,
        value: {
          bindings: rows.map((row) => ({
            id: row.id,
            engagementId: row.engagementId,
            targetId: row.targetId,
            bindingKind: row.bindingKind,
            addressText: row.addressText,
            status: row.status,
            createdAt: row.createdAt,
            supersededAt: row.supersededAt,
          })),
        },
      };
    } catch (error) {
      return busyOrCorrupt(error);
    }
  }

  changeAddress(input: {
    engagementId: string;
    targetId: string;
    newAddress: string;
  }): StoneTargetCaptureResult<{ retiredBindingId: string | null; addressText: string }> {
    try {
      if (!this.requireEngagement(input.engagementId)) {
        return { ok: false, error: { code: "engagement_not_found" } };
      }
      const target = this.db
        .select()
        .from(stoneTargets)
        .where(eq(stoneTargets.id, input.targetId))
        .get();
      if (target === undefined || target.engagementId !== input.engagementId) {
        return { ok: false, error: { code: "target_not_found" } };
      }
      const existing = this.db
        .select()
        .from(stoneAddressBindings)
        .where(eq(stoneAddressBindings.targetId, input.targetId))
        .orderBy(asc(stoneAddressBindings.createdAt))
        .all();
      const plan = planAddressChange(
        existing.map((row) => ({
          id: row.id,
          addressText: row.addressText,
          bindingKind: row.bindingKind,
          status: row.status,
          createdAt: row.createdAt,
          supersededAt: row.supersededAt,
        })),
        { newAddressText: input.newAddress },
      );
      if (!plan.ok) return { ok: false, error: { code: "invalid_request" } };
      const now = this.providers.now().toISOString();
      const bindingId = this.providers.createId();
      this.db.transaction(
        (tx) => {
          if (plan.retiredBindingId !== null) {
            tx.update(stoneAddressBindings)
              .set({ status: "historical", supersededAt: now })
              .where(eq(stoneAddressBindings.id, plan.retiredBindingId))
              .run();
          }
          tx.insert(stoneAddressBindings)
            .values({
              id: bindingId,
              contractVersion: STONE_TARGET_CONTRACT_VERSION,
              engagementId: input.engagementId,
              targetId: input.targetId,
              bindingKind: plan.bindingKind,
              addressText: plan.addressText,
              status: "current",
              createdAt: now,
              supersededAt: null,
            })
            .run();
          tx.update(stoneTargets)
            .set({ revision: target.revision + 1, updatedAt: now })
            .where(eq(stoneTargets.id, input.targetId))
            .run();
        },
        { behavior: "immediate" },
      );
      return {
        ok: true,
        value: { retiredBindingId: plan.retiredBindingId, addressText: plan.addressText },
      };
    } catch (error) {
      return busyOrCorrupt(error);
    }
  }

  proposeHostnameAssociation(input: {
    engagementId: string;
    targetId: string;
    connectionAddress: string;
    requestedHostname: string;
  }): StoneTargetCaptureResult<StoneHostnameAssociation> {
    try {
      if (!this.requireEngagement(input.engagementId)) {
        return { ok: false, error: { code: "engagement_not_found" } };
      }
      const target = this.db
        .select()
        .from(stoneTargets)
        .where(eq(stoneTargets.id, input.targetId))
        .get();
      if (target === undefined || target.engagementId !== input.engagementId) {
        return { ok: false, error: { code: "target_not_found" } };
      }
      const now = this.providers.now().toISOString();
      const proposed = proposeRedirectHostnameAssociation({
        associationId: this.providers.createId(),
        targetId: input.targetId,
        engagementId: input.engagementId,
        connectionAddress: input.connectionAddress,
        requestedHostname: input.requestedHostname,
        createdAt: now,
      });
      if (!proposed.ok) return { ok: false, error: { code: "invalid_request" } };
      const offer = proposed.offer;
      this.db
        .insert(stoneHostnameAssociations)
        .values({
          id: offer.associationId,
          contractVersion: STONE_TARGET_CONTRACT_VERSION,
          engagementId: input.engagementId,
          targetId: input.targetId,
          connectionAddress: offer.connectionAddress,
          requestedHostname: offer.requestedHostname,
          status: "proposed",
          createdAt: now,
          decidedAt: null,
        })
        .run();
      return {
        ok: true,
        value: {
          contractVersion: STONE_TARGET_CONTRACT_VERSION,
          id: offer.associationId,
          engagementId: input.engagementId,
          targetId: input.targetId,
          connectionAddress: offer.connectionAddress,
          requestedHostname: offer.requestedHostname,
          status: "proposed",
          runnerOnlyNote: offer.runnerOnlyNote,
          nextStep: offer.nextStep,
          hostsFileEdited: false,
          createdAt: now,
          decidedAt: null,
        },
      };
    } catch (error) {
      return busyOrCorrupt(error);
    }
  }

  decideHostnameAssociation(input: {
    engagementId: string;
    associationId: string;
    decision: string;
  }): StoneTargetCaptureResult<StoneHostnameAssociation> {
    try {
      const row = this.db
        .select()
        .from(stoneHostnameAssociations)
        .where(eq(stoneHostnameAssociations.id, input.associationId))
        .get();
      if (row === undefined || row.engagementId !== input.engagementId) {
        return { ok: false, error: { code: "association_not_found" } };
      }
      if (row.status !== "proposed") {
        return { ok: false, error: { code: "invalid_request" } };
      }
      const now = this.providers.now().toISOString();
      const decided = decideRedirectHostnameAssociation(input.decision, now);
      if (!decided.ok) return { ok: false, error: { code: "invalid_request" } };
      this.db
        .update(stoneHostnameAssociations)
        .set({ status: decided.status, decidedAt: decided.decidedAt })
        .where(eq(stoneHostnameAssociations.id, input.associationId))
        .run();
      const updated = this.db
        .select()
        .from(stoneHostnameAssociations)
        .where(eq(stoneHostnameAssociations.id, input.associationId))
        .get();
      if (updated === undefined) {
        return { ok: false, error: { code: "invalid_persisted_data" } };
      }
      const association: StoneHostnameAssociation = {
        contractVersion: STONE_TARGET_CONTRACT_VERSION,
        id: updated.id,
        engagementId: updated.engagementId,
        targetId: updated.targetId,
        connectionAddress: updated.connectionAddress,
        requestedHostname: updated.requestedHostname,
        status: updated.status,
        runnerOnlyNote:
          "This name mapping applies to the runner only. An ordinary browser will not resolve it.",
        nextStep:
          "Next step: share the intended hostname with the operator and use it for HTTP host and TLS server name; do not edit the OS hosts file.",
        hostsFileEdited: false,
        createdAt: updated.createdAt,
        decidedAt: updated.decidedAt,
      };
      return { ok: true, value: association };
    } catch (error) {
      return busyOrCorrupt(error);
    }
  }

  createCapture(
    input: CreateStoneCaptureInput,
  ): StoneTargetCaptureResult<{ capture: StoneCapture; deduplicated: boolean }> {
    try {
      const invented = findInventedExecutionFacts(input.rawBody ?? {});
      if (invented.length > 0) {
        return { ok: false, error: { code: "invalid_request" } };
      }
      if (!this.requireEngagement(input.engagementId)) {
        return { ok: false, error: { code: "engagement_not_found" } };
      }
      if (input.targetId !== null) {
        const target = this.db
          .select()
          .from(stoneTargets)
          .where(eq(stoneTargets.id, input.targetId))
          .get();
        if (target === undefined || target.engagementId !== input.engagementId) {
          return { ok: false, error: { code: "target_not_found" } };
        }
      }
      const title = input.title.trim();
      if (title.length === 0 || Array.from(title).length > 120) {
        return { ok: false, error: { code: "invalid_request" } };
      }
      if (
        input.observation !== undefined &&
        (input.observation.includes("\n") || input.observation.includes("\r"))
      ) {
        return { ok: false, error: { code: "invalid_request" } };
      }
      const digest = resolveStoneCaptureDigest(input);
      if (digest === null) {
        return { ok: false, error: { code: "invalid_request" } };
      }
      const existing = this.db
        .select()
        .from(stoneCaptures)
        .where(
          and(
            eq(stoneCaptures.engagementId, input.engagementId),
            eq(stoneCaptures.contentDigest, digest),
          ),
        )
        .get();
      if (existing !== undefined) {
        // Dedupe: the same content resolves to the existing capture. The
        // returned provenance pointer is the existing item id itself; the
        // stored original keeps a null pointer. No facts double.
        return {
          ok: true,
          value: {
            capture: { ...toCapture(existing), provenanceExistingId: existing.id },
            deduplicated: true,
          },
        };
      }
      const now = this.providers.now().toISOString();
      const id = this.providers.createId();
      // byteSize is recomputed from presented content whenever content is
      // present; a client assertion is honored only for digest-only imports
      // whose bytes the server never saw.
      const byteSize =
        input.contentText !== undefined
          ? new TextEncoder().encode(input.contentText).length
          : (input.byteSize ?? 0);
      this.db
        .insert(stoneCaptures)
        .values({
          id,
          contractVersion: STONE_CAPTURE_CONTRACT_VERSION,
          engagementId: input.engagementId,
          targetId: input.targetId,
          leadId: input.leadId,
          kind: input.kind,
          originLabel: originLabelForKind(input.kind),
          title,
          command: input.command ?? null,
          observation: input.observation ?? null,
          contentDigest: digest,
          provenanceExistingId: null,
          byteSize,
          createdAt: now,
        })
        .run();
      const row = this.db
        .select()
        .from(stoneCaptures)
        .where(eq(stoneCaptures.id, id))
        .get();
      if (row === undefined) {
        return { ok: false, error: { code: "invalid_persisted_data" } };
      }
      return { ok: true, value: { capture: toCapture(row), deduplicated: false } };
    } catch (error) {
      return busyOrCorrupt(error);
    }
  }

  // Second import of identical content resolves to a provenance pointer at
  // the existing capture without doubling facts. No pointer row is written:
  // the returned capture carries provenanceExistingId set to the existing
  // item id, which is the reference the acceptance check requires.
  recordImportProvenance(input: {
    engagementId: string;
    existingCaptureId: string;
    kind: StoneCaptureKind;
    title: string;
    targetId: string | null;
  }): StoneTargetCaptureResult<{ capture: StoneCapture; deduplicated: boolean }> {
    try {
      const existing = this.db
        .select()
        .from(stoneCaptures)
        .where(eq(stoneCaptures.id, input.existingCaptureId))
        .get();
      if (existing === undefined || existing.engagementId !== input.engagementId) {
        return { ok: false, error: { code: "invalid_request" } };
      }
      return {
        ok: true,
        value: {
          capture: { ...toCapture(existing), provenanceExistingId: existing.id },
          deduplicated: true,
        },
      };
    } catch (error) {
      return busyOrCorrupt(error);
    }
  }

  listCaptures(engagementId: string): StoneTargetCaptureResult<StoneCapture[]> {
    try {
      if (!this.requireEngagement(engagementId)) {
        return { ok: false, error: { code: "engagement_not_found" } };
      }
      const rows = this.db
        .select()
        .from(stoneCaptures)
        .where(eq(stoneCaptures.engagementId, engagementId))
        .orderBy(asc(stoneCaptures.createdAt))
        .all();
      return { ok: true, value: rows.map(toCapture) };
    } catch (error) {
      return busyOrCorrupt(error);
    }
  }
}

function toCapture(row: typeof stoneCaptures.$inferSelect): StoneCapture {
  return {
    contractVersion: STONE_CAPTURE_CONTRACT_VERSION,
    id: row.id,
    engagementId: row.engagementId,
    targetId: row.targetId,
    leadId: row.leadId,
    kind: row.kind,
    originLabel: row.originLabel,
    title: row.title,
    command: row.command,
    observation: row.observation,
    contentDigest: row.contentDigest,
    provenanceExistingId: row.provenanceExistingId,
    byteSize: row.byteSize,
    createdAt: row.createdAt,
  };
}
