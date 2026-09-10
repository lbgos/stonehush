import { randomUUID } from "node:crypto";

import {
  AttachLeadAttemptRequestSchema,
  CloseLeadRequestSchema,
  CreateLeadAttemptRequestSchema,
  CreateLeadRequestSchema,
  LEAD_CONTRACT_VERSION,
  LeadAttemptSchema,
  LeadSchema,
  ParkLeadRequestSchema,
  SuggestLeadRevisitRequestSchema,
  type Lead,
  type LeadAttempt,
} from "@blackglass/contracts";
import {
  buildLeadOutline,
  citeParkReasonForRevisit,
  suggestLeadRevisit,
  transitionLeadDisposition,
  type RevisitSuppressReason,
} from "@blackglass/domain";
import { asc, eq, max } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema.js";
import {
  engagements,
  leadAttempts,
  leads,
  type LeadAttemptRow,
  type LeadRow,
} from "./schema.js";

type Database = BetterSQLite3Database<typeof schema>;

export interface LeadRepositoryProviders {
  createId?: () => string;
  now?: () => Date;
}

export type LeadRepositoryError =
  | { code: "engagement_not_found" }
  | { code: "engagement_archived" }
  | { code: "lead_not_found" }
  | { code: "attempt_not_found" }
  | { code: "invalid_lead_transition" }
  | { code: "revisit_suppressed"; reason: RevisitSuppressReason }
  | { code: "invalid_repository_input" }
  | { code: "invalid_persisted_data" }
  | { code: "storage_busy" };

export type LeadResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: LeadRepositoryError };

function failed<T>(error: LeadRepositoryError): LeadResult<T> {
  return { ok: false, error };
}

function isStorageBusy(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "SQLITE_BUSY" || error.code === "SQLITE_BUSY_TIMEOUT")
  );
}

function leadFromRow(row: LeadRow): LeadResult<Lead> {
  const parsed = LeadSchema.safeParse({
    contractVersion: row.contractVersion,
    id: row.id,
    engagementId: row.engagementId,
    title: row.title,
    target: row.target,
    serviceRef: row.serviceRef,
    source: {
      kind: row.sourceKind,
      ref: row.sourceRef,
      ...(row.sourceLabel === null ? {} : { label: row.sourceLabel }),
    },
    nextStep: row.nextStep,
    disposition: row.disposition,
    parkReason: row.parkReason,
    testedConditions: row.testedConditions,
    closedNote: row.closedNote,
    revisitSuggestion:
      row.revisitTrigger === null ||
      row.revisitReason === null ||
      row.revisitCreatedAt === null
        ? null
        : {
            trigger: row.revisitTrigger,
            reason: row.revisitReason,
            createdAt: row.revisitCreatedAt,
            dismissed: row.revisitDismissed,
          },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  return parsed.success
    ? { ok: true, value: parsed.data }
    : failed({ code: "invalid_persisted_data" });
}

function attemptFromRow(row: LeadAttemptRow): LeadResult<LeadAttempt> {
  let evidence: unknown;
  try {
    evidence = JSON.parse(row.evidenceArtifactIdsJson);
  } catch {
    return failed({ code: "invalid_persisted_data" });
  }
  const parsed = LeadAttemptSchema.safeParse({
    contractVersion: row.contractVersion,
    id: row.id,
    engagementId: row.engagementId,
    leadId: row.leadId,
    sequence: row.sequence,
    summary: row.summary,
    outcome: row.outcome,
    conditions: row.conditions,
    evidenceArtifactIds: evidence,
    linkedFindingId: row.linkedFindingId,
    linkedObjectiveId: row.linkedObjectiveId,
    createdAt: row.createdAt,
  });
  return parsed.success
    ? { ok: true, value: parsed.data }
    : failed({ code: "invalid_persisted_data" });
}

export class LeadRepository {
  private readonly createId: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly db: Database,
    providers: LeadRepositoryProviders = {},
  ) {
    this.createId = providers.createId ?? randomUUID;
    this.now = providers.now ?? (() => new Date());
  }

  private engagementStatus(
    engagementId: string,
  ): LeadResult<"active" | "archived"> {
    try {
      const row = this.db
        .select({ status: engagements.status })
        .from(engagements)
        .where(eq(engagements.id, engagementId))
        .get();
      if (row === undefined) return failed({ code: "engagement_not_found" });
      return { ok: true, value: row.status };
    } catch (error) {
      return failed({ code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data" });
    }
  }

  private readLead(engagementId: string, leadId: string): LeadResult<LeadRow> {
    try {
      const row = this.db
        .select()
        .from(leads)
        .where(eq(leads.id, leadId))
        .get();
      if (row === undefined || row.engagementId !== engagementId) {
        return failed({ code: "lead_not_found" });
      }
      return { ok: true, value: row };
    } catch (error) {
      return failed({ code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data" });
    }
  }

  private writeLeadRow(
    row: LeadRow,
    patch: Partial<LeadRow> & { updatedAt: string },
  ): LeadResult<Lead> {
    try {
      this.db
        .update(leads)
        .set(patch)
        .where(eq(leads.id, row.id))
        .run();
      const stored = this.db.select().from(leads).where(eq(leads.id, row.id)).get();
      if (stored === undefined) return failed({ code: "invalid_persisted_data" });
      return leadFromRow(stored);
    } catch (error) {
      return failed({ code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data" });
    }
  }

  createLead(engagementId: string, input: unknown): LeadResult<Lead> {
    const parsed = CreateLeadRequestSchema.safeParse(input);
    if (!parsed.success) return failed({ code: "invalid_repository_input" });
    const status = this.engagementStatus(engagementId);
    if (!status.ok) return status;
    if (status.value === "archived") return failed({ code: "engagement_archived" });
    const timestamp = this.now().toISOString();
    const row = {
      id: this.createId(),
      contractVersion: LEAD_CONTRACT_VERSION,
      engagementId,
      title: parsed.data.title,
      target: parsed.data.target ?? null,
      serviceRef: parsed.data.serviceRef ?? null,
      sourceKind: parsed.data.source.kind,
      sourceRef: parsed.data.source.ref,
      sourceLabel: parsed.data.source.label ?? null,
      nextStep: parsed.data.nextStep ?? null,
      disposition: "open" as const,
      parkReason: null,
      testedConditions: null,
      closedNote: null,
      revisitTrigger: null,
      revisitReason: null,
      revisitCreatedAt: null,
      revisitDismissed: false as const,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    try {
      this.db.insert(leads).values(row).run();
    } catch (error) {
      return failed({ code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data" });
    }
    const stored = this.db.select().from(leads).where(eq(leads.id, row.id)).get();
    if (stored === undefined) return failed({ code: "invalid_persisted_data" });
    return leadFromRow(stored);
  }

  listLeads(engagementId: string): LeadResult<Lead[]> {
    const status = this.engagementStatus(engagementId);
    if (!status.ok) return status;
    try {
      const rows = this.db
        .select()
        .from(leads)
        .where(eq(leads.engagementId, engagementId))
        .orderBy(asc(leads.createdAt), asc(leads.id))
        .all();
      const values: Lead[] = [];
      for (const row of rows) {
        const parsed = leadFromRow(row);
        if (!parsed.ok) return parsed;
        values.push(parsed.value);
      }
      return { ok: true, value: values };
    } catch (error) {
      return failed({ code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data" });
    }
  }

  getLead(engagementId: string, leadId: string): LeadResult<Lead> {
    const status = this.engagementStatus(engagementId);
    if (!status.ok) return status;
    const row = this.readLead(engagementId, leadId);
    if (!row.ok) return row;
    return leadFromRow(row.value);
  }

  parkLead(engagementId: string, leadId: string, input: unknown): LeadResult<Lead> {
    const parsed = ParkLeadRequestSchema.safeParse(input);
    if (!parsed.success) return failed({ code: "invalid_repository_input" });
    const status = this.engagementStatus(engagementId);
    if (!status.ok) return status;
    if (status.value === "archived") return failed({ code: "engagement_archived" });
    const row = this.readLead(engagementId, leadId);
    if (!row.ok) return row;
    const current = leadFromRow(row.value);
    if (!current.ok) return current;
    const transition = transitionLeadDisposition(current.value, "park", {
      reason: parsed.data.reason,
      testedConditions: parsed.data.testedConditions,
    });
    if (!transition.ok) return failed({ code: "invalid_lead_transition" });
    return this.writeLeadRow(row.value, {
      disposition: transition.value.disposition,
      parkReason: transition.value.parkReason,
      testedConditions: transition.value.testedConditions,
      closedNote: null,
      updatedAt: this.now().toISOString(),
    });
  }

  reopenLead(engagementId: string, leadId: string): LeadResult<Lead> {
    const status = this.engagementStatus(engagementId);
    if (!status.ok) return status;
    if (status.value === "archived") return failed({ code: "engagement_archived" });
    const row = this.readLead(engagementId, leadId);
    if (!row.ok) return row;
    const current = leadFromRow(row.value);
    if (!current.ok) return current;
    const transition = transitionLeadDisposition(current.value, "reopen");
    if (!transition.ok) return failed({ code: "invalid_lead_transition" });
    return this.writeLeadRow(row.value, {
      disposition: transition.value.disposition,
      parkReason: null,
      testedConditions: null,
      closedNote: null,
      revisitTrigger: null,
      revisitReason: null,
      revisitCreatedAt: null,
      revisitDismissed: false,
      updatedAt: this.now().toISOString(),
    });
  }

  closeLead(engagementId: string, leadId: string, input: unknown): LeadResult<Lead> {
    const parsed = CloseLeadRequestSchema.safeParse(input);
    if (!parsed.success) return failed({ code: "invalid_repository_input" });
    const status = this.engagementStatus(engagementId);
    if (!status.ok) return status;
    if (status.value === "archived") return failed({ code: "engagement_archived" });
    const row = this.readLead(engagementId, leadId);
    if (!row.ok) return row;
    const current = leadFromRow(row.value);
    if (!current.ok) return current;
    const transition = transitionLeadDisposition(current.value, "close", {
      note: parsed.data.note,
    });
    if (!transition.ok) return failed({ code: "invalid_lead_transition" });
    return this.writeLeadRow(row.value, {
      disposition: transition.value.disposition,
      parkReason: null,
      testedConditions: null,
      closedNote: transition.value.closedNote,
      revisitTrigger: null,
      revisitReason: null,
      revisitCreatedAt: null,
      revisitDismissed: false,
      updatedAt: this.now().toISOString(),
    });
  }

  // One quiet revisit suggestion. The parked reason is cited in the stored
  // text so the suggestion never claims the check will work elsewhere. The
  // citation is bounded to 500 chars so long park reasons cannot break the
  // revisit CHECK. The disposition is never changed here: no auto-reopen exists.
  suggestRevisit(engagementId: string, leadId: string, input: unknown): LeadResult<Lead> {
    const parsed = SuggestLeadRevisitRequestSchema.safeParse(input);
    if (!parsed.success) return failed({ code: "invalid_repository_input" });
    const status = this.engagementStatus(engagementId);
    if (!status.ok) return status;
    if (status.value === "archived") return failed({ code: "engagement_archived" });
    const row = this.readLead(engagementId, leadId);
    if (!row.ok) return row;
    const current = leadFromRow(row.value);
    if (!current.ok) return current;
    const citedReason = citeParkReasonForRevisit(
      current.value.parkReason,
      parsed.data.reason,
    );
    const suggestion = suggestLeadRevisit(
      current.value,
      {
        trigger: parsed.data.trigger,
        reason: citedReason,
        anonymous: parsed.data.anonymous,
        conditions: parsed.data.conditions,
      },
      this.now,
    );
    if (!suggestion.ok) {
      if (suggestion.error.code === "invalid_revisit_input") {
        return failed({ code: "invalid_repository_input" });
      }
      return failed({ code: "revisit_suppressed", reason: suggestion.error.reason });
    }
    return this.writeLeadRow(row.value, {
      revisitTrigger: suggestion.value.trigger,
      revisitReason: suggestion.value.reason,
      revisitCreatedAt: suggestion.value.createdAt,
      revisitDismissed: false,
      updatedAt: this.now().toISOString(),
    });
  }

  dismissRevisit(engagementId: string, leadId: string): LeadResult<Lead> {
    const status = this.engagementStatus(engagementId);
    if (!status.ok) return status;
    if (status.value === "archived") return failed({ code: "engagement_archived" });
    const row = this.readLead(engagementId, leadId);
    if (!row.ok) return row;
    if (row.value.revisitTrigger === null) return failed({ code: "invalid_lead_transition" });
    return this.writeLeadRow(row.value, {
      revisitDismissed: true,
      updatedAt: this.now().toISOString(),
    });
  }

  private nextAttemptSequence(leadId: string): number {
    const row = this.db
      .select({ value: max(leadAttempts.sequence) })
      .from(leadAttempts)
      .where(eq(leadAttempts.leadId, leadId))
      .get();
    const current = row?.value;
    return (typeof current === "number" ? current : 0) + 1;
  }

  recordAttempt(engagementId: string, leadId: string, input: unknown): LeadResult<LeadAttempt> {
    const parsed = CreateLeadAttemptRequestSchema.safeParse(input);
    if (!parsed.success) return failed({ code: "invalid_repository_input" });
    const status = this.engagementStatus(engagementId);
    if (!status.ok) return status;
    if (status.value === "archived") return failed({ code: "engagement_archived" });
    const lead = this.readLead(engagementId, leadId);
    if (!lead.ok) return lead;
    const uniqueEvidence = [...new Set(parsed.data.evidenceArtifactIds)];
    const row = {
      id: this.createId(),
      contractVersion: LEAD_CONTRACT_VERSION,
      engagementId,
      leadId,
      sequence: 0,
      summary: parsed.data.summary,
      outcome: parsed.data.outcome,
      conditions: parsed.data.conditions ?? null,
      evidenceArtifactIdsJson: JSON.stringify(uniqueEvidence),
      linkedFindingId: parsed.data.linkedFindingId ?? null,
      linkedObjectiveId: parsed.data.linkedObjectiveId ?? null,
      createdAt: this.now().toISOString(),
    };
    try {
      const sequence = this.nextAttemptSequence(leadId);
      this.db.insert(leadAttempts).values({ ...row, sequence }).run();
    } catch (error) {
      return failed({ code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data" });
    }
    const stored = this.db
      .select()
      .from(leadAttempts)
      .where(eq(leadAttempts.id, row.id))
      .get();
    if (stored === undefined) return failed({ code: "invalid_persisted_data" });
    return attemptFromRow(stored);
  }

  getAttempt(engagementId: string, attemptId: string): LeadResult<LeadAttempt> {
    const status = this.engagementStatus(engagementId);
    if (!status.ok) return status;
    try {
      const row = this.db
        .select()
        .from(leadAttempts)
        .where(eq(leadAttempts.id, attemptId))
        .get();
      if (row === undefined || row.engagementId !== engagementId) {
        return failed({ code: "attempt_not_found" });
      }
      return attemptFromRow(row);
    } catch (error) {
      return failed({ code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data" });
    }
  }

  listAttempts(engagementId: string, leadId: string): LeadResult<LeadAttempt[]> {
    const status = this.engagementStatus(engagementId);
    if (!status.ok) return status;
    const lead = this.readLead(engagementId, leadId);
    if (!lead.ok) return lead;
    try {
      const rows = this.db
        .select()
        .from(leadAttempts)
        .where(eq(leadAttempts.leadId, leadId))
        .orderBy(asc(leadAttempts.sequence))
        .all();
      const values: LeadAttempt[] = [];
      for (const row of rows) {
        if (row.engagementId !== engagementId) {
          return failed({ code: "invalid_persisted_data" });
        }
        const parsed = attemptFromRow(row);
        if (!parsed.ok) return parsed;
        values.push(parsed.value);
      }
      return { ok: true, value: values };
    } catch (error) {
      return failed({ code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data" });
    }
  }

  // Attach-afterward: move an attempt recorded under one lead onto another
  // lead of the same engagement, appended at the end of the new order.
  attachAttempt(
    engagementId: string,
    attemptId: string,
    input: unknown,
  ): LeadResult<LeadAttempt> {
    const parsed = AttachLeadAttemptRequestSchema.safeParse(input);
    if (!parsed.success) return failed({ code: "invalid_repository_input" });
    const status = this.engagementStatus(engagementId);
    if (!status.ok) return status;
    if (status.value === "archived") return failed({ code: "engagement_archived" });
    const target = this.readLead(engagementId, parsed.data.leadId);
    if (!target.ok) return target;
    try {
      const row = this.db
        .select()
        .from(leadAttempts)
        .where(eq(leadAttempts.id, attemptId))
        .get();
      if (row === undefined || row.engagementId !== engagementId) {
        return failed({ code: "attempt_not_found" });
      }
      const sequence = this.nextAttemptSequence(parsed.data.leadId);
      this.db
        .update(leadAttempts)
        .set({ leadId: parsed.data.leadId, sequence })
        .where(eq(leadAttempts.id, attemptId))
        .run();
      const stored = this.db
        .select()
        .from(leadAttempts)
        .where(eq(leadAttempts.id, attemptId))
        .get();
      if (stored === undefined) return failed({ code: "invalid_persisted_data" });
      return attemptFromRow(stored);
    } catch (error) {
      return failed({ code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data" });
    }
  }

  leadOutline(engagementId: string, leadId: string): LeadResult<{ outline: string }> {
    const lead = this.getLead(engagementId, leadId);
    if (!lead.ok) return lead;
    const attempts = this.listAttempts(engagementId, leadId);
    if (!attempts.ok) return attempts;
    return { ok: true, value: { outline: buildLeadOutline(lead.value, attempts.value) } };
  }
}
