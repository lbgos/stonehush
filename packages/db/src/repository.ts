import { randomUUID } from "node:crypto";

import {
  AddScopeAndRunActionRequestSchema,
  AppendScopeRevisionInputSchema,
  CreateEngagementInputSchema,
  CreateFindingRequestSchema,
  ENGAGEMENT_CONTRACT_VERSION,
  EngagementNotesSchema,
  EngagementSchema,
  EngagementWithActiveScopeSchema,
  FINDING_CONTRACT_VERSION,
  FindingSchema,
  FFUF_DEFAULT_MATCH_CODES,
  FfufDiscoveryLaunchRequestSchema,
  FfufDiscoveryLaunchSchema,
  RUNNER_SETTINGS_DEFAULTS,
  RunnerSettingsSchema,
  ScopeRevisionSchema,
  UpdateEngagementDeadlineRequestSchema,
  UpdateEngagementNotesRequestSchema,
  UpdateFindingRequestSchema,
  type AcceptHeartbeatResult,
  type AppendScopeRevisionInput,
  type CreateEngagementInput,
  type Engagement,
  type EngagementNotes,
  type EngagementStatus,
  type EngagementWithActiveScope,
  type Finding,
  type CanonicalUrlHost,
  type PersistedAction,
  type PersistedRun,
  type PersistedRunEvent,
  type RetryActionContext,
  type ScopeRevision,
  type SavedScopeRule,
} from "@stonehush/contracts";
import { normalizeScopeRules, normalizeTarget } from "@stonehush/domain";
import { and, asc, eq, inArray, max } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import type * as schema from "./schema.js";
import {
  activatePersistedAction,
  addScopeAndRunPersistedAction,
  cancelPersistedAction,
  continuePersistedAction,
  continuePersistedLateWarning,
  getPersistedAction,
  getPersistedRetryContext,
  persistPlannedAction,
  recordPersistedLateWarning,
  type ActionPersistenceContext,
} from "./action.js";
import {
  bindPlannedSnapshot,
  declaredPortsFromTypedOptions,
  derivePlanningWarningState,
  normalizeOperatorTargets,
  parseCreateActionRequest,
  riskTierReasonsForTypedOptions,
} from "./action-operator.js";
import {
  acquireRunLease,
  allocateQueuedRun,
  appendRunEvent,
  completePersistedRun,
  expirePersistedRunLease,
  getPersistedRun,
  heartbeatRunLease,
  retryPersistedRun,
  type AcquiredRunLease,
  type RunResult,
  type StoredRunEventResult,
} from "./run.js";
import {
  engagementActiveScopes,
  engagementNotes,
  engagements,
  evidenceArtifacts,
  findings,
  runs,
  scopeRevisions,
  settings,
  type EngagementNotesRow,
  type EngagementRow,
  type FindingRow,
  type ScopeRevisionRow,
} from "./schema.js";

export type RepositoryError =
  | { code: "engagement_archived" }
  | { code: "engagement_not_found" }
  | { code: "finding_not_found" }
  | { code: "invalid_engagement_transition" }
  | { code: "invalid_finding_transition" }
  | { code: "invalid_persisted_data" }
  | { code: "invalid_repository_input" }
  | {
      code: "revision_conflict";
      currentRevision: number;
      resourceType?: "engagement" | "action";
      resourceId?: string;
    }
  | { code: "storage_busy" };

export type ActionRepositoryError =
  | RepositoryError
  | { code: "action_already_queued" }
  | { code: "action_not_found" }
  | { code: "capability_error_not_overridable" }
  | { code: "invalid_action_transition" }
  | { code: "invalid_run_transition" }
  | { code: "run_not_retryable" }
  | { code: "snapshot_binding_mismatch" };

export type RepositoryResult<T, E = RepositoryError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export interface RepositoryProviders {
  createId?: () => string;
  now?: () => Date;
}

type DatabaseSchema = typeof schema;
export type DatabaseWriteClient = Parameters<
  Parameters<BetterSQLite3Database<DatabaseSchema>["transaction"]>[0]
>[0];
export interface EngagementWriteTransaction {
  readonly client: DatabaseWriteClient;
  now(): Date;
  createEngagement(input: unknown): RepositoryResult<Engagement>;
  archive(
    engagementId: string,
    expectedRevision: number,
  ): RepositoryResult<Engagement>;
  reopen(
    engagementId: string,
    expectedRevision: number,
  ): RepositoryResult<Engagement>;
  updateAutoContinueWarnings(
    engagementId: string,
    expectedRevision: number,
    autoContinueWarnings: boolean,
  ): RepositoryResult<Engagement>;
  updateDeadline(
    engagementId: string,
    expectedRevision: number,
    deadlineAt: string | null,
  ): RepositoryResult<Engagement>;
  appendScopeRevision(input: unknown): RepositoryResult<ScopeRevision>;
  getEngagement(
    engagementId: string,
  ): RepositoryResult<EngagementWithActiveScope>;
  getEngagementNotes(engagementId: string): RepositoryResult<EngagementNotes>;
  putEngagementNotes(
    engagementId: string,
    input: unknown,
  ): RepositoryResult<EngagementNotes>;
  createFinding(
    engagementId: string,
    input: unknown,
  ): RepositoryResult<Finding>;
  listFindings(engagementId: string): RepositoryResult<Finding[]>;
  getFindingForEngagement(
    engagementId: string,
    findingId: string,
  ): RepositoryResult<Finding>;
  resolveFinding(
    engagementId: string,
    findingId: string,
  ): RepositoryResult<Finding>;
  reopenFinding(
    engagementId: string,
    findingId: string,
  ): RepositoryResult<Finding>;
  updateFinding(
    engagementId: string,
    findingId: string,
    input: unknown,
  ): RepositoryResult<Finding>;
  getAction(
    engagementId: string,
    actionId: string,
  ): RepositoryResult<PersistedAction, ActionRepositoryError>;
  persistPlannedAction(
    input: unknown,
  ): RepositoryResult<PersistedAction, ActionRepositoryError>;
  planOperatorAction(
    engagementId: string,
    input: unknown,
  ): RepositoryResult<PersistedAction, ActionRepositoryError>;
  planFfufDiscoveryAction(
    engagementId: string,
    input: unknown,
  ): RepositoryResult<PersistedAction, ActionRepositoryError>;
  continueAction(
    input: unknown,
  ): RepositoryResult<PersistedAction, ActionRepositoryError>;
  addScopeAndRunAction(
    input: unknown,
  ): RepositoryResult<PersistedAction, ActionRepositoryError>;
  addScopeAndRunOperatorAction(
    engagementId: string,
    actionId: string,
    input: unknown,
  ): RepositoryResult<PersistedAction, ActionRepositoryError>;
  activateAction(
    input: unknown,
  ): RepositoryResult<PersistedAction, ActionRepositoryError>;
  cancelAction(
    input: unknown,
  ): RepositoryResult<PersistedAction, ActionRepositoryError>;
  recordLateWarning(
    input: unknown,
  ): RepositoryResult<PersistedAction, ActionRepositoryError>;
  continueLateWarning(
    input: unknown,
  ): RepositoryResult<PersistedAction, ActionRepositoryError>;
  createQueuedRun(input: unknown): RunResult<PersistedRun>;
  acquireLease(input: unknown): RunResult<AcquiredRunLease>;
  heartbeat(
    input: unknown,
  ): RunResult<AcceptHeartbeatResult & { expiryWriteCount: number }>;
  expireLease(input: unknown): RunResult<{
    run: PersistedRun;
    event: PersistedRunEvent;
    automaticallyRequeued: boolean;
  }>;
  appendEvent(input: unknown): RunResult<StoredRunEventResult>;
  completeRun(input: unknown): RunResult<StoredRunEventResult>;
  retryRun(input: unknown): RunResult<PersistedRun>;
  getRun(runId: string): RunResult<PersistedRun>;
}

function failed<T, E = RepositoryError>(error: E): RepositoryResult<T, E> {
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

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function parseRules(rulesJson: string): unknown {
  try {
    return JSON.parse(rulesJson);
  } catch {
    return undefined;
  }
}

function canonicalUrlHostsEqual(
  left: CanonicalUrlHost,
  right: CanonicalUrlHost,
): boolean {
  if ("hostname" in left || "hostname" in right) {
    return (
      "hostname" in left &&
      "hostname" in right &&
      left.hostname === right.hostname
    );
  }
  return left.address === right.address && left.zone === right.zone;
}

function scopeRuleIsCanonical(rule: SavedScopeRule): boolean {
  if (rule.kind === "domain") {
    const normalized = normalizeTarget(rule.target.hostname);
    return (
      normalized.ok &&
      normalized.target.kind === "hostname" &&
      normalized.target.hostname === rule.target.hostname
    );
  }
  if (rule.kind === "url-origin") {
    const host =
      "hostname" in rule.origin.host
        ? rule.origin.host.hostname
        : rule.origin.host.address.includes(":")
          ? `[${rule.origin.host.address}${rule.origin.host.zone === null ? "" : `%25${rule.origin.host.zone}`}]`
          : rule.origin.host.address;
    const normalized = normalizeTarget(
      `${rule.origin.scheme}://${host}:${rule.origin.effectivePort}/`,
    );
    return (
      normalized.ok &&
      normalized.target.kind === "url" &&
      normalized.target.url.startsWith(`${rule.origin.scheme}://`) &&
      normalized.target.effectivePort === rule.origin.effectivePort &&
      canonicalUrlHostsEqual(rule.origin.host, normalized.target.host)
    );
  }
  const target = rule.target;
  const raw =
    target.kind === "cidr"
      ? `${target.network}/${target.prefixLength}`
      : target.zone === null
        ? target.address
        : `${target.address}%${target.zone}`;
  const normalized = normalizeTarget(raw);
  if (!normalized.ok || normalized.target.kind !== target.kind) return false;
  return target.kind === "cidr" && normalized.target.kind === "cidr"
    ? normalized.target.family === target.family &&
        normalized.target.network === target.network &&
        normalized.target.prefixLength === target.prefixLength
    : target.kind === "ip" &&
        normalized.target.kind === "ip" &&
        normalized.target.family === target.family &&
        normalized.target.address === target.address &&
        normalized.target.zone === target.zone;
}

function normalizeValidatedRules(
  rules: readonly SavedScopeRule[],
): ReturnType<typeof normalizeScopeRules> {
  const normalized = normalizeScopeRules(rules);
  if (!normalized.ok) return normalized;
  return normalized.rules.every(scopeRuleIsCanonical)
    ? normalized
    : { ok: false, error: { code: "invalid_scope_input" } };
}

function engagementFromRow(
  row: EngagementRow,
  activeScopeRevisionId: string | null,
): RepositoryResult<Engagement> {
  const parsed = EngagementSchema.safeParse({
    contractVersion: row.contractVersion,
    id: row.id,
    revision: row.revision,
    name: row.name,
    kind: row.kind,
    status: row.status,
    description: row.description,
    authorizationContext: row.authorizationContext,
    autoContinueWarnings: row.autoContinueWarnings,
    activeScopeRevisionId,
    deadlineAt: row.deadlineAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  return parsed.success
    ? { ok: true, value: parsed.data }
    : failed({ code: "invalid_persisted_data" });
}

function scopeRevisionFromRow(
  row: ScopeRevisionRow,
): RepositoryResult<ScopeRevision> {
  const parsed = ScopeRevisionSchema.safeParse({
    contractVersion: row.contractVersion,
    id: row.id,
    engagementId: row.engagementId,
    version: row.version,
    rules: parseRules(row.rulesJson),
    createdAt: row.createdAt,
  });
  if (!parsed.success) return failed({ code: "invalid_persisted_data" });
  const normalized = normalizeValidatedRules(parsed.data.rules);
  if (!normalized.ok || JSON.stringify(normalized.rules) !== row.rulesJson) {
    return failed({ code: "invalid_persisted_data" });
  }
  return { ok: true, value: parsed.data };
}

function engagementNotesFromRow(row: EngagementNotesRow): RepositoryResult<EngagementNotes> {
  const parsed = EngagementNotesSchema.safeParse({
    engagementId: row.engagementId,
    markdown: row.markdown,
    updatedAt: row.updatedAt,
    revision: row.revision,
  });
  return parsed.success
    ? { ok: true, value: parsed.data }
    : failed({ code: "invalid_persisted_data" });
}

function findingFromRow(row: FindingRow): RepositoryResult<Finding> {
  let evidenceArtifactIds: unknown;
  try {
    evidenceArtifactIds = JSON.parse(row.evidenceArtifactIdsJson);
  } catch {
    return failed({ code: "invalid_persisted_data" });
  }
  const parsed = FindingSchema.safeParse({
    contractVersion: row.contractVersion,
    id: row.id,
    engagementId: row.engagementId,
    title: row.title,
    severity: row.severity,
    status: row.status,
    body: row.body,
    evidenceArtifactIds,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  return parsed.success
    ? { ok: true, value: parsed.data }
    : failed({ code: "invalid_persisted_data" });
}

function readEngagementWithActiveScope(
  client: DatabaseWriteClient | BetterSQLite3Database<DatabaseSchema>,
  engagementId: string,
): RepositoryResult<EngagementWithActiveScope> {
  const joined = client
    .select({
      engagement: engagements,
      activeScopeRevisionId: engagementActiveScopes.scopeRevisionId,
      activeScopeRevision: scopeRevisions,
    })
    .from(engagements)
    .leftJoin(
      engagementActiveScopes,
      eq(engagementActiveScopes.engagementId, engagements.id),
    )
    .leftJoin(
      scopeRevisions,
      eq(scopeRevisions.id, engagementActiveScopes.scopeRevisionId),
    )
    .where(eq(engagements.id, engagementId))
    .get();
  if (joined === undefined) return failed({ code: "engagement_not_found" });
  if (
    joined.activeScopeRevisionId !== null &&
    (joined.activeScopeRevision === null ||
      joined.activeScopeRevision.engagementId !== joined.engagement.id)
  ) {
    return failed({ code: "invalid_persisted_data" });
  }
  const activeScope =
    joined.activeScopeRevision === null
      ? { ok: true as const, value: null }
      : scopeRevisionFromRow(joined.activeScopeRevision);
  if (!activeScope.ok) return activeScope;
  const engagement = engagementFromRow(
    joined.engagement,
    activeScope.value?.id ?? null,
  );
  if (!engagement.ok) return engagement;
  const output = EngagementWithActiveScopeSchema.safeParse({
    engagement: engagement.value,
    activeScopeRevision: activeScope.value,
  });
  return output.success
    ? { ok: true, value: output.data }
    : failed({ code: "invalid_persisted_data" });
}

class TransactionRepository implements EngagementWriteTransaction {
  constructor(
    readonly client: DatabaseWriteClient,
    private readonly nextId: () => string,
    private readonly clock: () => Date,
  ) {}

  now(): Date {
    return this.clock();
  }

  private currentEngagement(
    engagementId: string,
  ): RepositoryResult<EngagementRow> {
    const row = this.client
      .select()
      .from(engagements)
      .where(eq(engagements.id, engagementId))
      .get();
    return row === undefined
      ? failed({ code: "engagement_not_found" })
      : { ok: true, value: row };
  }

  createEngagement(input: unknown): RepositoryResult<Engagement> {
    const parsed = CreateEngagementInputSchema.safeParse(input);
    if (!parsed.success) return failed({ code: "invalid_repository_input" });
    const timestamp = this.clock().toISOString();
    const row = {
      id: this.nextId(),
      contractVersion: ENGAGEMENT_CONTRACT_VERSION,
      revision: 1,
      name: parsed.data.name,
      kind: parsed.data.kind,
      status: "active" as const,
      description: parsed.data.description,
      authorizationContext: parsed.data.authorizationContext,
      autoContinueWarnings: parsed.data.autoContinueWarnings,
      deadlineAt: parsed.data.deadlineAt ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const valid = EngagementSchema.safeParse({
      ...row,
      activeScopeRevisionId: null,
    });
    if (!valid.success) return failed({ code: "invalid_repository_input" });
    this.client.insert(engagements).values(row).run();
    return { ok: true, value: valid.data };
  }

  archive(
    engagementId: string,
    expectedRevision: number,
  ): RepositoryResult<Engagement> {
    return this.setStatus(engagementId, expectedRevision, "archived");
  }

  reopen(
    engagementId: string,
    expectedRevision: number,
  ): RepositoryResult<Engagement> {
    return this.setStatus(engagementId, expectedRevision, "active");
  }

  setStatus(
    engagementId: string,
    expectedRevision: number,
    status: EngagementStatus,
  ): RepositoryResult<Engagement> {
    const current = this.currentEngagement(engagementId);
    if (!current.ok) return current;
    if (current.value.revision !== expectedRevision) {
      return failed({
        code: "revision_conflict",
        currentRevision: current.value.revision,
      });
    }
    if (current.value.status === status) {
      return failed({ code: "invalid_engagement_transition" });
    }
    const updatedAt = this.clock().toISOString();
    this.client
      .update(engagements)
      .set({ status, revision: expectedRevision + 1, updatedAt })
      .where(
        and(
          eq(engagements.id, engagementId),
          eq(engagements.revision, expectedRevision),
        ),
      )
      .run();
    return engagementFromRow(
      { ...current.value, status, revision: expectedRevision + 1, updatedAt },
      this.activeScopeId(engagementId),
    );
  }

  updateAutoContinueWarnings(
    engagementId: string,
    expectedRevision: number,
    autoContinueWarnings: boolean,
  ): RepositoryResult<Engagement> {
    const current = this.currentEngagement(engagementId);
    if (!current.ok) return current;
    if (current.value.revision !== expectedRevision) {
      return failed({
        code: "revision_conflict",
        currentRevision: current.value.revision,
      });
    }
    if (current.value.status === "archived") {
      return failed({ code: "engagement_archived" });
    }
    const updatedAt = this.clock().toISOString();
    this.client
      .update(engagements)
      .set({
        autoContinueWarnings,
        revision: expectedRevision + 1,
        updatedAt,
      })
      .where(
        and(
          eq(engagements.id, engagementId),
          eq(engagements.revision, expectedRevision),
        ),
      )
      .run();
    return engagementFromRow(
      {
        ...current.value,
        autoContinueWarnings,
        revision: expectedRevision + 1,
        updatedAt,
      },
      this.activeScopeId(engagementId),
    );
  }

  updateDeadline(
    engagementId: string,
    expectedRevision: number,
    deadlineAt: string | null,
  ): RepositoryResult<Engagement> {
    const parsed = UpdateEngagementDeadlineRequestSchema.safeParse({
      expectedRevision,
      deadlineAt,
    });
    if (!parsed.success) return failed({ code: "invalid_repository_input" });
    const current = this.currentEngagement(engagementId);
    if (!current.ok) return current;
    if (current.value.revision !== expectedRevision) {
      return failed({
        code: "revision_conflict",
        currentRevision: current.value.revision,
      });
    }
    if (current.value.status === "archived") {
      return failed({ code: "engagement_archived" });
    }
    const updatedAt = this.clock().toISOString();
    this.client
      .update(engagements)
      .set({
        deadlineAt: parsed.data.deadlineAt,
        revision: expectedRevision + 1,
        updatedAt,
      })
      .where(
        and(
          eq(engagements.id, engagementId),
          eq(engagements.revision, expectedRevision),
        ),
      )
      .run();
    return engagementFromRow(
      {
        ...current.value,
        deadlineAt: parsed.data.deadlineAt,
        revision: expectedRevision + 1,
        updatedAt,
      },
      this.activeScopeId(engagementId),
    );
  }

  appendScopeRevision(input: unknown): RepositoryResult<ScopeRevision> {
    const parsed = AppendScopeRevisionInputSchema.safeParse(input);
    if (!parsed.success) return failed({ code: "invalid_repository_input" });
    const normalized = normalizeValidatedRules(parsed.data.rules);
    if (!normalized.ok) return failed({ code: "invalid_repository_input" });
    const current = this.currentEngagement(parsed.data.engagementId);
    if (!current.ok) return current;
    if (current.value.revision !== parsed.data.expectedRevision) {
      return failed({
        code: "revision_conflict",
        currentRevision: current.value.revision,
      });
    }
    if (current.value.status === "archived") {
      return failed({ code: "engagement_archived" });
    }

    const latest = this.client
      .select({ version: max(scopeRevisions.version) })
      .from(scopeRevisions)
      .where(eq(scopeRevisions.engagementId, parsed.data.engagementId))
      .get();
    const timestamp = this.clock().toISOString();
    const row = {
      id: this.nextId(),
      contractVersion: ENGAGEMENT_CONTRACT_VERSION,
      engagementId: parsed.data.engagementId,
      version: (latest?.version ?? 0) + 1,
      rulesJson: JSON.stringify(normalized.rules),
      createdAt: timestamp,
    };
    const output = scopeRevisionFromRow(row);
    if (!output.ok) return failed({ code: "invalid_repository_input" });

    this.client.insert(scopeRevisions).values(row).run();
    this.client
      .insert(engagementActiveScopes)
      .values({
        engagementId: parsed.data.engagementId,
        scopeRevisionId: row.id,
      })
      .onConflictDoUpdate({
        target: engagementActiveScopes.engagementId,
        set: { scopeRevisionId: row.id },
      })
      .run();
    this.client
      .update(engagements)
      .set({ revision: parsed.data.expectedRevision + 1, updatedAt: timestamp })
      .where(
        and(
          eq(engagements.id, parsed.data.engagementId),
          eq(engagements.revision, parsed.data.expectedRevision),
        ),
      )
      .run();
    return output;
  }

  private activeScopeId(engagementId: string): string | null {
    return (
      this.client
        .select({ id: engagementActiveScopes.scopeRevisionId })
        .from(engagementActiveScopes)
        .where(eq(engagementActiveScopes.engagementId, engagementId))
        .get()?.id ?? null
    );
  }

  private actionContext(): ActionPersistenceContext {
    return {
      client: this.client,
      createId: this.nextId,
      now: this.clock,
    };
  }

  getEngagement(
    engagementId: string,
  ): RepositoryResult<EngagementWithActiveScope> {
    return readEngagementWithActiveScope(this.client, engagementId);
  }

  getEngagementNotes(engagementId: string): RepositoryResult<EngagementNotes> {
    const current = this.currentEngagement(engagementId);
    if (!current.ok) return current;
    const row = this.client
      .select()
      .from(engagementNotes)
      .where(eq(engagementNotes.engagementId, engagementId))
      .get();
    if (row === undefined) {
      return {
        ok: true,
        value: {
          engagementId,
          markdown: "",
          updatedAt: current.value.updatedAt,
          revision: 0,
        },
      };
    }
    return engagementNotesFromRow(row);
  }

  putEngagementNotes(
    engagementId: string,
    input: unknown,
  ): RepositoryResult<EngagementNotes> {
    const parsed = UpdateEngagementNotesRequestSchema.safeParse(input);
    if (!parsed.success) return failed({ code: "invalid_repository_input" });
    const current = this.currentEngagement(engagementId);
    if (!current.ok) return current;
    if (current.value.status === "archived") {
      return failed({ code: "engagement_archived" });
    }
    const expectedRevision = parsed.data.expectedRevision;
    const existing = this.client
      .select()
      .from(engagementNotes)
      .where(eq(engagementNotes.engagementId, engagementId))
      .get();
    const currentRevision = existing?.revision ?? 0;
    if (expectedRevision !== currentRevision) {
      return failed({
        code: "revision_conflict",
        currentRevision,
      });
    }
    if (expectedRevision >= Number.MAX_SAFE_INTEGER) {
      return failed({ code: "invalid_repository_input" });
    }
    const nextRevision = expectedRevision + 1;
    const updatedAt = this.clock().toISOString();
    if (existing === undefined) {
      this.client
        .insert(engagementNotes)
        .values({
          engagementId,
          markdown: parsed.data.markdown,
          updatedAt,
          revision: nextRevision,
        })
        .run();
    } else {
      this.client
        .update(engagementNotes)
        .set({
          markdown: parsed.data.markdown,
          updatedAt,
          revision: nextRevision,
        })
        .where(
          and(
            eq(engagementNotes.engagementId, engagementId),
            eq(engagementNotes.revision, expectedRevision),
          ),
        )
        .run();
    }
    const stored = this.client
      .select()
      .from(engagementNotes)
      .where(eq(engagementNotes.engagementId, engagementId))
      .get();
    if (stored === undefined) return failed({ code: "invalid_persisted_data" });
    if (stored.revision !== nextRevision) {
      return failed({
        code: "revision_conflict",
        currentRevision: stored.revision,
      });
    }
    return engagementNotesFromRow(stored);
  }

  createFinding(
    engagementId: string,
    input: unknown,
  ): RepositoryResult<Finding> {
    const parsed = CreateFindingRequestSchema.safeParse(input);
    if (!parsed.success) return failed({ code: "invalid_repository_input" });
    const current = this.currentEngagement(engagementId);
    if (!current.ok) return current;
    if (current.value.status === "archived") {
      return failed({ code: "engagement_archived" });
    }
    if (parsed.data.evidenceArtifactIds.length > 0) {
      const uniqueIds = [...new Set(parsed.data.evidenceArtifactIds)];
      const owned = this.client
        .select({ artifactId: evidenceArtifacts.artifactId })
        .from(evidenceArtifacts)
        .innerJoin(runs, eq(runs.id, evidenceArtifacts.runId))
        .where(
          and(
            eq(runs.engagementId, engagementId),
            inArray(evidenceArtifacts.artifactId, uniqueIds),
          ),
        )
        .all();
      if (owned.length !== uniqueIds.length) {
        return failed({ code: "invalid_repository_input" });
      }
    }
    const timestamp = this.clock().toISOString();
    const row = {
      id: this.nextId(),
      contractVersion: FINDING_CONTRACT_VERSION,
      engagementId,
      title: parsed.data.title,
      severity: parsed.data.severity,
      status: "open" as const,
      body: parsed.data.body,
      evidenceArtifactIdsJson: JSON.stringify(parsed.data.evidenceArtifactIds),
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.client.insert(findings).values(row).run();
    const stored = this.client
      .select()
      .from(findings)
      .where(eq(findings.id, row.id))
      .get();
    if (stored === undefined) return failed({ code: "invalid_persisted_data" });
    return findingFromRow(stored);
  }

  listFindings(engagementId: string): RepositoryResult<Finding[]> {
    const current = this.currentEngagement(engagementId);
    if (!current.ok) return current;
    const rows = this.client
      .select()
      .from(findings)
      .where(eq(findings.engagementId, engagementId))
      .orderBy(asc(findings.createdAt), asc(findings.id))
      .all();
    const values: Finding[] = [];
    for (const row of rows) {
      const parsed = findingFromRow(row);
      if (!parsed.ok) return parsed;
      values.push(parsed.value);
    }
    return { ok: true, value: values };
  }

  // Narrow read-only scoped finding lookup for evidence assembly. Unlike
  // mutations it stays available on archived engagements; a missing row or
  // a row owned by another engagement is identically finding_not_found.
  getFindingForEngagement(
    engagementId: string,
    findingId: string,
  ): RepositoryResult<Finding> {
    const current = this.currentEngagement(engagementId);
    if (!current.ok) return current;
    const row = this.client
      .select()
      .from(findings)
      .where(eq(findings.id, findingId))
      .get();
    if (row === undefined || row.engagementId !== engagementId) {
      return failed({ code: "finding_not_found" });
    }
    return findingFromRow(row);
  }

  private setFindingStatus(
    engagementId: string,
    findingId: string,
    status: "open" | "resolved",
  ): RepositoryResult<Finding> {
    const current = this.currentEngagement(engagementId);
    if (!current.ok) return current;
    if (current.value.status === "archived") {
      return failed({ code: "engagement_archived" });
    }
    const row = this.client
      .select()
      .from(findings)
      .where(eq(findings.id, findingId))
      .get();
    if (row === undefined || row.engagementId !== engagementId) {
      return failed({ code: "finding_not_found" });
    }
    if (row.status === status) {
      return failed({ code: "invalid_finding_transition" });
    }
    const updatedAt = this.clock().toISOString();
    this.client
      .update(findings)
      .set({ status, updatedAt, revision: row.revision + 1 })
      .where(eq(findings.id, findingId))
      .run();
    const stored = this.client
      .select()
      .from(findings)
      .where(eq(findings.id, findingId))
      .get();
    if (stored === undefined) return failed({ code: "invalid_persisted_data" });
    return findingFromRow(stored);
  }

  resolveFinding(
    engagementId: string,
    findingId: string,
  ): RepositoryResult<Finding> {
    return this.setFindingStatus(engagementId, findingId, "resolved");
  }

  reopenFinding(
    engagementId: string,
    findingId: string,
  ): RepositoryResult<Finding> {
    return this.setFindingStatus(engagementId, findingId, "open");
  }

  // Content edit for title, severity, and body. Evidence references and
  // status stay untouched by this slice. The required expectedRevision
  // covers all three editable fields: a stale writer gets revision_conflict
  // with the current revision instead of silently overwriting.
  updateFinding(
    engagementId: string,
    findingId: string,
    input: unknown,
  ): RepositoryResult<Finding> {
    const parsed = UpdateFindingRequestSchema.safeParse(input);
    if (!parsed.success) return failed({ code: "invalid_repository_input" });
    const current = this.currentEngagement(engagementId);
    if (!current.ok) return current;
    if (current.value.status === "archived") {
      return failed({ code: "engagement_archived" });
    }
    const row = this.client
      .select()
      .from(findings)
      .where(eq(findings.id, findingId))
      .get();
    if (row === undefined || row.engagementId !== engagementId) {
      return failed({ code: "finding_not_found" });
    }
    const expectedRevision = parsed.data.expectedRevision;
    if (expectedRevision !== row.revision) {
      return failed({
        code: "revision_conflict",
        currentRevision: row.revision,
      });
    }
    if (expectedRevision >= Number.MAX_SAFE_INTEGER) {
      return failed({ code: "invalid_repository_input" });
    }
    const nextRevision = expectedRevision + 1;
    const updatedAt = this.clock().toISOString();
    this.client
      .update(findings)
      .set({
        title: parsed.data.title,
        severity: parsed.data.severity,
        body: parsed.data.body,
        updatedAt,
        revision: nextRevision,
      })
      .where(
        and(eq(findings.id, findingId), eq(findings.revision, expectedRevision)),
      )
      .run();
    const stored = this.client
      .select()
      .from(findings)
      .where(eq(findings.id, findingId))
      .get();
    if (stored === undefined) return failed({ code: "invalid_persisted_data" });
    if (stored.revision !== nextRevision) {
      return failed({
        code: "revision_conflict",
        currentRevision: stored.revision,
      });
    }
    return findingFromRow(stored);
  }

  getAction(
    engagementId: string,
    actionId: string,
  ): RepositoryResult<PersistedAction, ActionRepositoryError> {
    return getPersistedAction(this.client, engagementId, actionId);
  }

  planOperatorAction(
    engagementId: string,
    input: unknown,
  ): RepositoryResult<PersistedAction, ActionRepositoryError> {
    const parsed = parseCreateActionRequest(input);
    if (!parsed.ok) return parsed;
    const detail = this.getEngagement(engagementId);
    if (!detail.ok) return detail;
    const engagement = detail.value.engagement;
    if (engagement.revision !== parsed.value.expectedEngagementRevision) {
      return failed({
        code: "revision_conflict",
        currentRevision: engagement.revision,
        resourceType: "engagement",
        resourceId: engagement.id,
      });
    }
    if (engagement.status === "archived") {
      return failed({ code: "engagement_archived" });
    }
    if (
      engagement.activeScopeRevisionId !==
      parsed.value.expectedActiveScopeRevisionId
    ) {
      return failed({ code: "invalid_repository_input" });
    }

    const targets = normalizeOperatorTargets(parsed.value.targets);
    if (!targets.ok) return targets;
    const actionId = this.nextId();
    const warning = derivePlanningWarningState({
      actionId,
      scopeRevisionId: engagement.activeScopeRevisionId,
      rules: detail.value.activeScopeRevision?.rules ?? [],
      targets: targets.value,
      declaredPorts: parsed.value.declaredPorts,
    });
    if (!warning.ok) return warning;
    const snapshot = bindPlannedSnapshot({
      actionId,
      snapshotId: this.nextId(),
      version: 1,
      scopeRevisionId: engagement.activeScopeRevisionId,
      targets: targets.value,
      typedOptions: { declaredPorts: parsed.value.declaredPorts },
      resolutionSnapshots: [],
      warningState: warning.value,
    });
    if (!snapshot.ok) return snapshot;
    return this.persistPlannedAction({
      engagementId,
      snapshot: snapshot.value,
      representable: true,
      capabilityErrorCode: null,
      occurredAt: this.clock().toISOString(),
    });
  }

  planFfufDiscoveryAction(
    engagementId: string,
    input: unknown,
  ): RepositoryResult<PersistedAction, ActionRepositoryError> {
    const requested = FfufDiscoveryLaunchRequestSchema.safeParse(input);
    if (!requested.success) return failed({ code: "invalid_repository_input" });
    // Stored runner settings are defaults under explicit request values:
    // absent numerics and an absent or empty wordlist fall back to storage.
    // Read through this transaction so the plan observes one snapshot.
    let stored = { ...RUNNER_SETTINGS_DEFAULTS };
    try {
      const row = this.client
        .select()
        .from(settings)
        .where(eq(settings.scope, "runner"))
        .get();
      if (row !== undefined) {
        let persisted: unknown;
        try {
          persisted = JSON.parse(row.valueJson);
        } catch {
          return failed({ code: "invalid_persisted_data" });
        }
        const validated = RunnerSettingsSchema.safeParse(persisted);
        if (!validated.success) return failed({ code: "invalid_persisted_data" });
        stored = validated.data;
      }
    } catch (error) {
      return failed({
        code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data",
      });
    }
    const request = requested.data;
    const requestedWordlist = request.wordlistPath?.trim() ?? "";
    const parsed = FfufDiscoveryLaunchSchema.safeParse({
      expectedEngagementRevision: request.expectedEngagementRevision,
      expectedActiveScopeRevisionId: request.expectedActiveScopeRevisionId,
      origin: request.origin,
      wordlistPath: requestedWordlist === "" ? stored.ffufWordlistPath : requestedWordlist,
      rate: request.rate ?? stored.ffufRate,
      threads: request.threads ?? stored.ffufThreads,
      timeoutSeconds: request.timeoutSeconds ?? stored.ffufTimeoutSeconds,
      maxTimeSeconds: request.maxTimeSeconds ?? stored.ffufMaxTimeSeconds,
      ...(request.matchStatusCodes === undefined
        ? { matchStatusCodes: [...FFUF_DEFAULT_MATCH_CODES] }
        : { matchStatusCodes: [...request.matchStatusCodes] }),
    });
    if (!parsed.success) return failed({ code: "invalid_repository_input" });
    const detail = this.getEngagement(engagementId);
    if (!detail.ok) return detail;
    const engagement = detail.value.engagement;
    if (engagement.revision !== parsed.data.expectedEngagementRevision) {
      return failed({
        code: "revision_conflict",
        currentRevision: engagement.revision,
        resourceType: "engagement",
        resourceId: engagement.id,
      });
    }
    if (engagement.status === "archived") {
      return failed({ code: "engagement_archived" });
    }
    if (
      engagement.activeScopeRevisionId !==
      parsed.data.expectedActiveScopeRevisionId
    ) {
      return failed({ code: "invalid_repository_input" });
    }

    const targets = normalizeOperatorTargets([parsed.data.origin]);
    if (!targets.ok) return targets;
    const canonical = targets.value[0];
    if (targets.value.length !== 1 || canonical?.kind !== "url") {
      return failed({ code: "invalid_repository_input" });
    }
    const typedOptions = {
      declaredPorts: null,
      ffuf: {
        // The warned canonical URL, not the raw operator string, so the
        // executed argv always matches the acknowledged target context.
        origin: canonical.url,
        wordlistPath: parsed.data.wordlistPath,
        rate: parsed.data.rate,
        threads: parsed.data.threads,
        timeoutSeconds: parsed.data.timeoutSeconds,
        maxTimeSeconds: parsed.data.maxTimeSeconds,
        matchStatusCodes: [...parsed.data.matchStatusCodes],
      },
    };
    const actionId = this.nextId();
    const warning = derivePlanningWarningState({
      actionId,
      scopeRevisionId: engagement.activeScopeRevisionId,
      rules: detail.value.activeScopeRevision?.rules ?? [],
      targets: targets.value,
      declaredPorts: null,
    });
    if (!warning.ok) return warning;
    // ffuf discovery is T2: exactly one concise pre-run warning unless the
    // engagement auto-continues. The tier rides the shared warning path.
    for (const reason of riskTierReasonsForTypedOptions(typedOptions)) {
      if (!warning.value.reasonCodes.includes(reason)) {
        warning.value.reasonCodes.push(reason);
      }
    }
    const snapshot = bindPlannedSnapshot({
      actionId,
      snapshotId: this.nextId(),
      version: 1,
      scopeRevisionId: engagement.activeScopeRevisionId,
      targets: targets.value,
      typedOptions,
      resolutionSnapshots: [],
      warningState: warning.value,
    });
    if (!snapshot.ok) return snapshot;
    return this.persistPlannedAction({
      engagementId,
      snapshot: snapshot.value,
      representable: true,
      capabilityErrorCode: null,
      occurredAt: this.clock().toISOString(),
    });
  }

  addScopeAndRunOperatorAction(
    engagementId: string,
    actionId: string,
    input: unknown,
  ): RepositoryResult<PersistedAction, ActionRepositoryError> {
    const parsed = AddScopeAndRunActionRequestSchema.safeParse(input);
    if (!parsed.success) return failed({ code: "invalid_repository_input" });
    const current = this.getAction(engagementId, actionId);
    if (!current.ok) return current;
    if (current.value.revision !== parsed.data.expectedActionRevision) {
      return failed({
        code: "revision_conflict",
        currentRevision: current.value.revision,
        resourceType: "action",
        resourceId: actionId,
      });
    }
    if (current.value.action.state === "queued") {
      return failed({ code: "action_already_queued" });
    }
    if (current.value.action.state !== "paused_for_warning") {
      return failed({ code: "invalid_action_transition" });
    }
    const latest = current.value.action.snapshots.reduce<
      (typeof current.value.action.snapshots)[number] | undefined
    >(
      (winner, candidate) =>
        winner === undefined || candidate.version > winner.version
          ? candidate
          : winner,
      undefined,
    );
    if (latest === undefined) {
      return failed({ code: "invalid_persisted_data" });
    }
    const scope = this.appendScopeRevision({
      engagementId,
      expectedRevision: parsed.data.expectedEngagementRevision,
      rules: parsed.data.rules,
    });
    if (!scope.ok) {
      return scope.error.code === "revision_conflict"
        ? failed({
            ...scope.error,
            resourceType: "engagement",
            resourceId: engagementId,
          })
        : scope;
    }
    const warning = derivePlanningWarningState({
      actionId,
      scopeRevisionId: scope.value.id,
      rules: scope.value.rules,
      targets: latest.canonicalTargets,
      declaredPorts: declaredPortsFromTypedOptions(latest.typedOptions),
    });
    if (!warning.ok) {
      throw new Error("action persist write aborted: invalid_repository_input");
    }
    // Re-planning preserves the action's informational risk tier (ffuf stays T2).
    for (const reason of riskTierReasonsForTypedOptions(latest.typedOptions)) {
      if (!warning.value.reasonCodes.includes(reason)) {
        warning.value.reasonCodes.push(reason);
      }
    }
    const snapshot = bindPlannedSnapshot({
      actionId,
      snapshotId: this.nextId(),
      version: latest.version + 1,
      scopeRevisionId: scope.value.id,
      targets: latest.canonicalTargets,
      typedOptions: latest.typedOptions,
      resolutionSnapshots: latest.resolutionSnapshots,
      warningState: warning.value,
    });
    if (!snapshot.ok) {
      throw new Error("action persist write aborted: invalid_repository_input");
    }
    const queued = this.addScopeAndRunAction({
      engagementId,
      actionId,
      expectedRevision: parsed.data.expectedActionRevision,
      recheckedSnapshot: snapshot.value,
      occurredAt: this.clock().toISOString(),
    });
    if (!queued.ok) {
      throw new Error(`action persist write aborted: ${queued.error.code}`);
    }
    return queued;
  }

  persistPlannedAction(
    input: unknown,
  ): RepositoryResult<PersistedAction, ActionRepositoryError> {
    return persistPlannedAction(this.actionContext(), input);
  }

  continueAction(
    input: unknown,
  ): RepositoryResult<PersistedAction, ActionRepositoryError> {
    return continuePersistedAction(this.actionContext(), input);
  }

  addScopeAndRunAction(
    input: unknown,
  ): RepositoryResult<PersistedAction, ActionRepositoryError> {
    return addScopeAndRunPersistedAction(this.actionContext(), input);
  }

  activateAction(
    input: unknown,
  ): RepositoryResult<PersistedAction, ActionRepositoryError> {
    return activatePersistedAction(this.actionContext(), input);
  }

  cancelAction(
    input: unknown,
  ): RepositoryResult<PersistedAction, ActionRepositoryError> {
    return cancelPersistedAction(this.actionContext(), input);
  }

  recordLateWarning(
    input: unknown,
  ): RepositoryResult<PersistedAction, ActionRepositoryError> {
    return recordPersistedLateWarning(this.actionContext(), input);
  }

  continueLateWarning(
    input: unknown,
  ): RepositoryResult<PersistedAction, ActionRepositoryError> {
    return continuePersistedLateWarning(this.actionContext(), input);
  }

  createQueuedRun(input: unknown): RunResult<PersistedRun> {
    return allocateQueuedRun(this.actionContext(), input);
  }

  acquireLease(input: unknown): RunResult<AcquiredRunLease> {
    return acquireRunLease(this.actionContext(), input);
  }

  heartbeat(
    input: unknown,
  ): RunResult<AcceptHeartbeatResult & { expiryWriteCount: number }> {
    return heartbeatRunLease(this.actionContext(), input);
  }

  expireLease(input: unknown): RunResult<{
    run: PersistedRun;
    event: PersistedRunEvent;
    automaticallyRequeued: boolean;
  }> {
    return expirePersistedRunLease(this.actionContext(), input);
  }

  appendEvent(input: unknown): RunResult<StoredRunEventResult> {
    return appendRunEvent(this.actionContext(), input);
  }

  completeRun(input: unknown): RunResult<StoredRunEventResult> {
    return completePersistedRun(this.actionContext(), input);
  }

  retryRun(input: unknown): RunResult<PersistedRun> {
    return retryPersistedRun(this.actionContext(), input);
  }

  getRun(runId: string): RunResult<PersistedRun> {
    return getPersistedRun(this.client, runId);
  }
}

export class EngagementRepository {
  private readonly createId: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly db: BetterSQLite3Database<DatabaseSchema>,
    providers: RepositoryProviders = {},
  ) {
    this.createId = providers.createId ?? randomUUID;
    this.now = providers.now ?? (() => new Date());
  }

  private runMutation<T, E = RepositoryError>(
    mutation: (
      repository: EngagementWriteTransaction,
    ) => RepositoryResult<T, E>,
    transaction?: EngagementWriteTransaction,
  ): RepositoryResult<T, E> {
    if (transaction !== undefined) return mutation(transaction);
    try {
      return this.withWriteTx(mutation);
    } catch (error) {
      return failed({
        code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data",
      } as E);
    }
  }

  withWriteTx<T>(
    operation: (
      repository: EngagementWriteTransaction,
    ) => T extends PromiseLike<unknown> ? never : T,
  ): T;
  withWriteTx(operation: (repository: EngagementWriteTransaction) => unknown): unknown {
    return this.db.transaction(
      (transaction) => {
        const value = operation(
          new TransactionRepository(transaction, this.createId, this.now),
        );
        if (isPromiseLike(value)) {
          throw new TypeError("Write transaction callback must be synchronous.");
        }
        return value;
      },
      { behavior: "immediate" },
    );
  }

  createEngagement(
    input: CreateEngagementInput | unknown,
    transaction?: EngagementWriteTransaction,
  ): RepositoryResult<Engagement> {
    return this.runMutation(
      (repository) => repository.createEngagement(input),
      transaction,
    );
  }

  archive(
    engagementId: string,
    expectedRevision: number,
    transaction?: EngagementWriteTransaction,
  ): RepositoryResult<Engagement> {
    return this.runMutation(
      (repository) => repository.archive(engagementId, expectedRevision),
      transaction,
    );
  }

  reopen(
    engagementId: string,
    expectedRevision: number,
    transaction?: EngagementWriteTransaction,
  ): RepositoryResult<Engagement> {
    return this.runMutation(
      (repository) => repository.reopen(engagementId, expectedRevision),
      transaction,
    );
  }

  updateAutoContinueWarnings(
    engagementId: string,
    expectedRevision: number,
    autoContinueWarnings: boolean,
    transaction?: EngagementWriteTransaction,
  ): RepositoryResult<Engagement> {
    return this.runMutation(
      (repository) =>
        repository.updateAutoContinueWarnings(
          engagementId,
          expectedRevision,
          autoContinueWarnings,
        ),
      transaction,
    );
  }

  updateDeadline(
    engagementId: string,
    expectedRevision: number,
    deadlineAt: string | null,
    transaction?: EngagementWriteTransaction,
  ): RepositoryResult<Engagement> {
    return this.runMutation(
      (repository) =>
        repository.updateDeadline(engagementId, expectedRevision, deadlineAt),
      transaction,
    );
  }

  appendScopeRevision(
    input: AppendScopeRevisionInput | unknown,
    transaction?: EngagementWriteTransaction,
  ): RepositoryResult<ScopeRevision> {
    return this.runMutation(
      (repository) => repository.appendScopeRevision(input),
      transaction,
    );
  }

  getEngagement(engagementId: string): RepositoryResult<EngagementWithActiveScope> {
    try {
      return readEngagementWithActiveScope(this.db, engagementId);
    } catch (error) {
      return failed({
        code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data",
      });
    }
  }

  getEngagementNotes(engagementId: string): RepositoryResult<EngagementNotes> {
    try {
      const engagement = this.db
        .select()
        .from(engagements)
        .where(eq(engagements.id, engagementId))
        .get();
      if (engagement === undefined) return failed({ code: "engagement_not_found" });
      const row = this.db
        .select()
        .from(engagementNotes)
        .where(eq(engagementNotes.engagementId, engagementId))
        .get();
      if (row === undefined) {
        return {
          ok: true,
          value: {
            engagementId,
            markdown: "",
            updatedAt: engagement.updatedAt,
            revision: 0,
          },
        };
      }
      return engagementNotesFromRow(row);
    } catch (error) {
      return failed({
        code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data",
      });
    }
  }

  putEngagementNotes(
    engagementId: string,
    input: unknown,
    transaction?: EngagementWriteTransaction,
  ): RepositoryResult<EngagementNotes> {
    return this.runMutation(
      (repository) => repository.putEngagementNotes(engagementId, input),
      transaction,
    );
  }

  createFinding(
    engagementId: string,
    input: unknown,
    transaction?: EngagementWriteTransaction,
  ): RepositoryResult<Finding> {
    return this.runMutation(
      (repository) => repository.createFinding(engagementId, input),
      transaction,
    );
  }

  listFindings(engagementId: string): RepositoryResult<Finding[]> {
    try {
      const engagement = this.db
        .select({ id: engagements.id })
        .from(engagements)
        .where(eq(engagements.id, engagementId))
        .get();
      if (engagement === undefined) return failed({ code: "engagement_not_found" });
      const rows = this.db
        .select()
        .from(findings)
        .where(eq(findings.engagementId, engagementId))
        .orderBy(asc(findings.createdAt), asc(findings.id))
        .all();
      const values: Finding[] = [];
      for (const row of rows) {
        const parsed = findingFromRow(row);
        if (!parsed.ok) return parsed;
        values.push(parsed.value);
      }
      return { ok: true, value: values };
    } catch (error) {
      return failed({
        code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data",
      });
    }
  }

  getFindingForEngagement(
    engagementId: string,
    findingId: string,
  ): RepositoryResult<Finding> {
    try {
      const engagement = this.db
        .select({ id: engagements.id })
        .from(engagements)
        .where(eq(engagements.id, engagementId))
        .get();
      if (engagement === undefined) return failed({ code: "engagement_not_found" });
      const row = this.db
        .select()
        .from(findings)
        .where(eq(findings.id, findingId))
        .get();
      if (row === undefined || row.engagementId !== engagementId) {
        return failed({ code: "finding_not_found" });
      }
      return findingFromRow(row);
    } catch (error) {
      return failed({
        code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data",
      });
    }
  }

  resolveFinding(
    engagementId: string,
    findingId: string,
    transaction?: EngagementWriteTransaction,
  ): RepositoryResult<Finding> {
    return this.runMutation(
      (repository) => repository.resolveFinding(engagementId, findingId),
      transaction,
    );
  }

  reopenFinding(
    engagementId: string,
    findingId: string,
    transaction?: EngagementWriteTransaction,
  ): RepositoryResult<Finding> {
    return this.runMutation(
      (repository) => repository.reopenFinding(engagementId, findingId),
      transaction,
    );
  }

  updateFinding(
    engagementId: string,
    findingId: string,
    input: unknown,
    transaction?: EngagementWriteTransaction,
  ): RepositoryResult<Finding> {
    return this.runMutation(
      (repository) => repository.updateFinding(engagementId, findingId, input),
      transaction,
    );
  }

  listEngagements(): RepositoryResult<Engagement[]> {
    try {
      const rows = this.db
        .select({
          engagement: engagements,
          activeScopeRevisionId: engagementActiveScopes.scopeRevisionId,
          joinedScopeRevisionId: scopeRevisions.id,
          joinedScopeEngagementId: scopeRevisions.engagementId,
        })
        .from(engagements)
        .leftJoin(
          engagementActiveScopes,
          eq(engagementActiveScopes.engagementId, engagements.id),
        )
        .leftJoin(
          scopeRevisions,
          eq(scopeRevisions.id, engagementActiveScopes.scopeRevisionId),
        )
        .orderBy(asc(engagements.createdAt), asc(engagements.id))
        .all();
      const values: Engagement[] = [];
      for (const row of rows) {
        if (
          row.activeScopeRevisionId !== null &&
          (row.activeScopeRevisionId !== row.joinedScopeRevisionId ||
            row.joinedScopeEngagementId !== row.engagement.id)
        ) {
          return failed({ code: "invalid_persisted_data" });
        }
        const parsed = engagementFromRow(
          row.engagement,
          row.activeScopeRevisionId,
        );
        if (!parsed.ok) return parsed;
        values.push(parsed.value);
      }
      return { ok: true, value: values };
    } catch (error) {
      return failed({
        code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data",
      });
    }
  }

  persistPlannedAction(
    input: unknown,
    transaction?: EngagementWriteTransaction,
  ): RepositoryResult<PersistedAction, ActionRepositoryError> {
    return this.runMutation(
      (repository) => repository.persistPlannedAction(input),
      transaction,
    );
  }

  planOperatorAction(
    engagementId: string,
    input: unknown,
    transaction?: EngagementWriteTransaction,
  ): RepositoryResult<PersistedAction, ActionRepositoryError> {
    return this.runMutation(
      (repository) => repository.planOperatorAction(engagementId, input),
      transaction,
    );
  }

  planFfufDiscoveryAction(
    engagementId: string,
    input: unknown,
    transaction?: EngagementWriteTransaction,
  ): RepositoryResult<PersistedAction, ActionRepositoryError> {
    return this.runMutation(
      (repository) => repository.planFfufDiscoveryAction(engagementId, input),
      transaction,
    );
  }

  continueAction(
    input: unknown,
    transaction?: EngagementWriteTransaction,
  ): RepositoryResult<PersistedAction, ActionRepositoryError> {
    return this.runMutation(
      (repository) => repository.continueAction(input),
      transaction,
    );
  }

  addScopeAndRunAction(
    input: unknown,
    transaction?: EngagementWriteTransaction,
  ): RepositoryResult<PersistedAction, ActionRepositoryError> {
    return this.runMutation(
      (repository) => repository.addScopeAndRunAction(input),
      transaction,
    );
  }

  addScopeAndRunOperatorAction(
    engagementId: string,
    actionId: string,
    input: unknown,
    transaction?: EngagementWriteTransaction,
  ): RepositoryResult<PersistedAction, ActionRepositoryError> {
    return this.runMutation(
      (repository) =>
        repository.addScopeAndRunOperatorAction(engagementId, actionId, input),
      transaction,
    );
  }

  activateAction(
    input: unknown,
    transaction?: EngagementWriteTransaction,
  ): RepositoryResult<PersistedAction, ActionRepositoryError> {
    return this.runMutation(
      (repository) => repository.activateAction(input),
      transaction,
    );
  }

  cancelAction(
    input: unknown,
    transaction?: EngagementWriteTransaction,
  ): RepositoryResult<PersistedAction, ActionRepositoryError> {
    return this.runMutation(
      (repository) => repository.cancelAction(input),
      transaction,
    );
  }

  recordLateWarning(
    input: unknown,
    transaction?: EngagementWriteTransaction,
  ): RepositoryResult<PersistedAction, ActionRepositoryError> {
    return this.runMutation(
      (repository) => repository.recordLateWarning(input),
      transaction,
    );
  }

  continueLateWarning(
    input: unknown,
    transaction?: EngagementWriteTransaction,
  ): RepositoryResult<PersistedAction, ActionRepositoryError> {
    return this.runMutation(
      (repository) => repository.continueLateWarning(input),
      transaction,
    );
  }

  getAction(
    engagementId: string,
    actionId: string,
  ): RepositoryResult<PersistedAction, ActionRepositoryError> {
    try {
      return getPersistedAction(this.db, engagementId, actionId);
    } catch (error) {
      return failed({
        code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data",
      });
    }
  }

  retryActionContext(
    engagementId: string,
    actionId: string,
  ): RepositoryResult<RetryActionContext, ActionRepositoryError> {
    try {
      return getPersistedRetryContext(this.db, engagementId, actionId);
    } catch (error) {
      return failed({
        code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data",
      });
    }
  }

  listScopeRevisions(
    engagementId: string,
  ): RepositoryResult<ScopeRevision[]> {
    try {
      const rows = this.db
        .select()
        .from(scopeRevisions)
        .where(eq(scopeRevisions.engagementId, engagementId))
        .orderBy(asc(scopeRevisions.version))
        .all();
      if (
        rows.length === 0 &&
        this.db
          .select({ id: engagements.id })
          .from(engagements)
          .where(eq(engagements.id, engagementId))
          .get() === undefined
      ) {
        return failed({ code: "engagement_not_found" });
      }
      const values: ScopeRevision[] = [];
      for (const row of rows) {
        const parsed = scopeRevisionFromRow(row);
        if (!parsed.ok) return parsed;
        values.push(parsed.value);
      }
      return { ok: true, value: values };
    } catch (error) {
      return failed({
        code: isStorageBusy(error) ? "storage_busy" : "invalid_persisted_data",
      });
    }
  }
}
