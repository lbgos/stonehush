import {
  ACTION_PERSISTENCE_CONTRACT_VERSION,
  ACTION_SNAPSHOT_CANONICALIZATION_PROFILE,
  ActionSnapshotSchema,
  ActivatePersistedActionInputSchema,
  AddScopeAndRunPersistedActionInputSchema,
  CancelPersistedActionInputSchema,
  ContinuePersistedActionInputSchema,
  ContinuePersistedLateWarningInputSchema,
  MAX_CANONICAL_JSON_BYTES,
  PendingWarningSchema,
  PersistPlannedActionInputSchema,
  PersistedActionSchema,
  RecordPersistedLateWarningInputSchema,
  WarningAcknowledgmentSchema,
  WarningContextAdditionSchema,
  type ActionPlanningAggregate,
  type ActionPlanningError,
  type ActionSnapshot,
  type PersistedAction,
  type RetryActionContext,
  type WarningAcknowledgment,
  type WarningContextAddition,
} from "@stonehush/contracts";
import {
  activateAction,
  addScopeAndRun,
  cancelAction,
  continueAction,
  continueLateWarning,
  planAction,
  recordLateWarning,
  retryActionContext,
  snapshotIsCanonical,
  warningAdditionIsCanonical,
} from "@stonehush/domain";
import { and, asc, eq } from "drizzle-orm";

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { bindActionSnapshot } from "./action-snapshot.js";
import {
  type ActionRepositoryError,
  type DatabaseWriteClient,
  type RepositoryResult,
} from "./repository.js";
import {
  allocateQueuedRun,
  cancelQueuedRunForAction,
} from "./run.js";
import * as schema from "./schema.js";
import {
  actionCoveredDestinations,
  actionSnapshots,
  actionWarningAcknowledgments,
  actions,
  engagementActiveScopes,
  engagements,
  scopeRevisions,
  type ActionCoveredDestinationRow,
  type ActionRow,
  type ActionSnapshotRow,
  type ActionWarningAcknowledgmentRow,
} from "./schema.js";

export type ActionQueryClient =
  | DatabaseWriteClient
  | BetterSQLite3Database<typeof schema>;

export interface ActionPersistenceContext {
  readonly client: ActionQueryClient;
  readonly createId: () => string;
  readonly now: () => Date;
}

type ActionResult<T> = RepositoryResult<T, ActionRepositoryError>;

function failed<T>(error: ActionRepositoryError): ActionResult<T> {
  return { ok: false, error };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mapPlanningError(
  code: ActionPlanningError["code"],
): ActionRepositoryError {
  switch (code) {
    case "action_already_queued":
      return { code: "action_already_queued" };
    case "capability_error_not_overridable":
      return { code: "capability_error_not_overridable" };
    case "invalid_action_transition":
      return { code: "invalid_action_transition" };
    case "invalid_run_transition":
      return { code: "invalid_run_transition" };
    case "run_not_retryable":
      return { code: "run_not_retryable" };
    case "snapshot_binding_mismatch":
      return { code: "snapshot_binding_mismatch" };
    case "invalid_action_planning_input":
      return { code: "invalid_repository_input" };
  }
}

function requireSnapshotBinding(
  snapshot: ActionSnapshot,
): ActionResult<string> {
  const bound = bindActionSnapshot(snapshot);
  if (!bound.ok || bound.binding !== snapshot.binding) {
    return failed({ code: "snapshot_binding_mismatch" });
  }
  return { ok: true, value: bound.binding };
}

function currentEngagement(
  client: ActionQueryClient,
  engagementId: string,
): ActionResult<{
  id: string;
  status: string;
  autoContinueWarnings: boolean;
}> {
  const row = client
    .select({
      id: engagements.id,
      status: engagements.status,
      autoContinueWarnings: engagements.autoContinueWarnings,
    })
    .from(engagements)
    .where(eq(engagements.id, engagementId))
    .get();
  return row === undefined
    ? failed({ code: "engagement_not_found" })
    : { ok: true, value: row };
}

function requireActiveEngagement(
  client: ActionQueryClient,
  engagementId: string,
): ActionResult<{
  id: string;
  status: string;
  autoContinueWarnings: boolean;
}> {
  const engagement = currentEngagement(client, engagementId);
  if (!engagement.ok) return engagement;
  return engagement.value.status === "archived"
    ? failed({ code: "engagement_archived" })
    : engagement;
}

function requireOwnedScopeRevision(
  client: ActionQueryClient,
  engagementId: string,
  scopeRevisionId: string | null,
): ActionResult<true> {
  if (scopeRevisionId === null) return { ok: true, value: true };
  const row = client
    .select({ id: scopeRevisions.id })
    .from(scopeRevisions)
    .where(
      and(
        eq(scopeRevisions.id, scopeRevisionId),
        eq(scopeRevisions.engagementId, engagementId),
      ),
    )
    .get();
  return row === undefined
    ? failed({ code: "invalid_repository_input" })
    : { ok: true, value: true };
}

function currentActiveScopeRevisionId(
  client: ActionQueryClient,
  engagementId: string,
): string | null {
  return (
    client
      .select({ id: engagementActiveScopes.scopeRevisionId })
      .from(engagementActiveScopes)
      .where(eq(engagementActiveScopes.engagementId, engagementId))
      .get()?.id ?? null
  );
}

function requireActiveScopeBinding(
  client: ActionQueryClient,
  engagementId: string,
  scopeRevisionId: string | null,
): ActionResult<true> {
  return currentActiveScopeRevisionId(client, engagementId) === scopeRevisionId
    ? { ok: true, value: true }
    : failed({ code: "invalid_repository_input" });
}

function snapshotJsonForStorage(snapshot: ActionSnapshot): ActionResult<string> {
  const snapshotJson = JSON.stringify(snapshot);
  if (Buffer.byteLength(snapshotJson, "utf8") > MAX_CANONICAL_JSON_BYTES) {
    return failed({ code: "invalid_repository_input" });
  }
  return { ok: true, value: snapshotJson };
}

function snapshotFromRow(row: ActionSnapshotRow): ActionResult<ActionSnapshot> {
  const parsed = ActionSnapshotSchema.safeParse(parseJson(row.snapshotJson));
  if (
    !parsed.success ||
    parsed.data.snapshotId !== row.id ||
    parsed.data.actionId !== row.actionId ||
    parsed.data.version !== row.version ||
    parsed.data.binding !== row.binding ||
    parsed.data.scopeRevisionId !== row.scopeRevisionId ||
    row.canonicalizationProfile !== ACTION_SNAPSHOT_CANONICALIZATION_PROFILE
  ) {
    return failed({ code: "invalid_persisted_data" });
  }
  const bound = bindActionSnapshot(parsed.data);
  if (!bound.ok || bound.binding !== parsed.data.binding) {
    return failed({ code: "invalid_persisted_data" });
  }
  if (!snapshotIsCanonical(parsed.data)) {
    return failed({ code: "invalid_persisted_data" });
  }
  return { ok: true, value: parsed.data };
}

function additionFromJson(value: string): ActionResult<WarningContextAddition> {
  const parsed = WarningContextAdditionSchema.safeParse(parseJson(value));
  if (!parsed.success || !warningAdditionIsCanonical(parsed.data)) {
    return failed({ code: "invalid_persisted_data" });
  }
  return { ok: true, value: parsed.data };
}

function reasonCodesFromJson(value: string): ActionResult<string[]> {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    return failed({ code: "invalid_persisted_data" });
  }
  return { ok: true, value: parsed };
}

function acknowledgmentFromRows(
  row: ActionWarningAcknowledgmentRow,
  destinations: readonly ActionCoveredDestinationRow[],
): ActionResult<WarningAcknowledgment> {
  const reasonCodes = reasonCodesFromJson(row.reasonCodesJson);
  if (!reasonCodes.ok) return reasonCodes;
  const knownAdditionsParsed = parseJson(row.knownAdditionsJson);
  if (!Array.isArray(knownAdditionsParsed)) {
    return failed({ code: "invalid_persisted_data" });
  }
  const knownAdditions: WarningContextAddition[] = [];
  for (const candidate of knownAdditionsParsed) {
    const addition = WarningContextAdditionSchema.safeParse(candidate);
    if (!addition.success || !warningAdditionIsCanonical(addition.data)) {
      return failed({ code: "invalid_persisted_data" });
    }
    knownAdditions.push(addition.data);
  }

  const coveredDestinations: WarningContextAddition[] = [];
  const mergedReasons = [...reasonCodes.value];
  for (const destination of destinations) {
    const addition = additionFromJson(destination.destinationJson);
    if (!addition.ok) return addition;
    const extraReasons = reasonCodesFromJson(destination.reasonCodesJson);
    if (!extraReasons.ok) return extraReasons;
    if (destination.acknowledgedCover) coveredDestinations.push(addition.value);
    for (const code of extraReasons.value) {
      if (!mergedReasons.includes(code)) mergedReasons.push(code);
    }
  }

  const parsed = WarningAcknowledgmentSchema.safeParse({
    actionId: row.actionId,
    snapshotId: row.snapshotId,
    snapshotVersion: row.snapshotVersion,
    snapshotBinding: row.snapshotBinding,
    scopeRevisionId: row.scopeRevisionId,
    reasonCodes: mergedReasons,
    knownAdditions,
    source: row.source,
    acknowledgedAt: row.acknowledgedAt,
    pendingEventId: row.pendingEventId,
    coveredDestinations,
  });
  return parsed.success
    ? { ok: true, value: parsed.data }
    : failed({ code: "invalid_persisted_data" });
}

function pendingWarningFromRow(
  pendingWarningJson: string | null,
): ActionResult<ActionPlanningAggregate["pendingWarning"]> {
  if (pendingWarningJson === null) return { ok: true, value: null };
  const parsed = PendingWarningSchema.safeParse(parseJson(pendingWarningJson));
  if (
    !parsed.success ||
    !parsed.data.knownAdditions.every(warningAdditionIsCanonical)
  ) {
    return failed({ code: "invalid_persisted_data" });
  }
  return { ok: true, value: parsed.data };
}

function actionFromRows(
  row: ActionRow,
  snapshotRows: readonly ActionSnapshotRow[],
  acknowledgmentRow: ActionWarningAcknowledgmentRow | undefined,
  destinationRows: readonly ActionCoveredDestinationRow[],
): ActionResult<PersistedAction> {
  const snapshots: ActionSnapshot[] = [];
  for (const snapshotRow of snapshotRows) {
    const snapshot = snapshotFromRow(snapshotRow);
    if (!snapshot.ok) return snapshot;
    snapshots.push(snapshot.value);
  }

  const acknowledgment =
    acknowledgmentRow === undefined
      ? { ok: true as const, value: null }
      : acknowledgmentFromRows(acknowledgmentRow, destinationRows);
  if (!acknowledgment.ok) return acknowledgment;

  const coveredDestinations: WarningContextAddition[] = [];
  for (const destination of destinationRows) {
    const addition = additionFromJson(destination.destinationJson);
    if (!addition.ok) return addition;
    coveredDestinations.push(addition.value);
  }

  const pendingWarning = pendingWarningFromRow(row.pendingWarningJson);
  if (!pendingWarning.ok) return pendingWarning;

  const parsed = PersistedActionSchema.safeParse({
    contractVersion: row.contractVersion,
    engagementId: row.engagementId,
    revision: row.revision,
    warningAcknowledgmentId: acknowledgmentRow?.id ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    action: {
      orchestrationProfile: "d2-v1",
      actionId: row.id,
      state: row.state,
      snapshots,
      queuedSnapshotVersion: row.queuedSnapshotVersion,
      warningAcknowledgment: acknowledgment.value,
      pendingWarning: pendingWarning.value,
      coveredDestinations,
      warningInteractions: row.warningInteractions,
      runState: row.runState,
      resumeRequested: row.resumeRequested,
      cleanupRequired: row.cleanupRequired,
      capabilityErrorCode: row.capabilityErrorCode,
    },
  });
  return parsed.success
    ? { ok: true, value: parsed.data }
    : failed({ code: "invalid_persisted_data" });
}

function loadPersistedAction(
  client: ActionQueryClient,
  engagementId: string,
  actionId: string,
): ActionResult<PersistedAction> {
  const row = client
    .select()
    .from(actions)
    .where(and(eq(actions.engagementId, engagementId), eq(actions.id, actionId)))
    .get();
  if (row === undefined) return failed({ code: "action_not_found" });
  const snapshotRows = client
    .select()
    .from(actionSnapshots)
    .where(
      and(
        eq(actionSnapshots.engagementId, engagementId),
        eq(actionSnapshots.actionId, actionId),
      ),
    )
    .orderBy(asc(actionSnapshots.version))
    .all();
  const acknowledgmentRow = client
    .select()
    .from(actionWarningAcknowledgments)
    .where(
      and(
        eq(actionWarningAcknowledgments.engagementId, engagementId),
        eq(actionWarningAcknowledgments.actionId, actionId),
      ),
    )
    .get();
  const destinationRows = client
    .select()
    .from(actionCoveredDestinations)
    .where(
      and(
        eq(actionCoveredDestinations.engagementId, engagementId),
        eq(actionCoveredDestinations.actionId, actionId),
      ),
    )
    .orderBy(asc(actionCoveredDestinations.sequence))
    .all();
  return actionFromRows(row, snapshotRows, acknowledgmentRow, destinationRows);
}

function insertSnapshot(
  context: ActionPersistenceContext,
  engagementId: string,
  snapshot: ActionSnapshot,
): ActionResult<true> {
  const binding = requireSnapshotBinding(snapshot);
  if (!binding.ok) return binding;
  const owned = requireOwnedScopeRevision(
    context.client,
    engagementId,
    snapshot.scopeRevisionId,
  );
  if (!owned.ok) return owned;
  const snapshotJson = snapshotJsonForStorage(snapshot);
  if (!snapshotJson.ok) return snapshotJson;
  context.client
    .insert(actionSnapshots)
    .values({
      id: snapshot.snapshotId,
      contractVersion: ACTION_PERSISTENCE_CONTRACT_VERSION,
      actionId: snapshot.actionId,
      engagementId,
      version: snapshot.version,
      binding: snapshot.binding,
      canonicalizationProfile: ACTION_SNAPSHOT_CANONICALIZATION_PROFILE,
      scopeRevisionId: snapshot.scopeRevisionId,
      snapshotJson: snapshotJson.value,
      createdAt: context.now().toISOString(),
    })
    .run();
  return { ok: true, value: true };
}

function insertAcknowledgment(
  context: ActionPersistenceContext,
  engagementId: string,
  acknowledgment: WarningAcknowledgment,
): ActionResult<string> {
  const id = context.createId();
  context.client
    .insert(actionWarningAcknowledgments)
    .values({
      id,
      contractVersion: ACTION_PERSISTENCE_CONTRACT_VERSION,
      actionId: acknowledgment.actionId,
      engagementId,
      snapshotId: acknowledgment.snapshotId,
      snapshotVersion: acknowledgment.snapshotVersion,
      snapshotBinding: acknowledgment.snapshotBinding,
      scopeRevisionId: acknowledgment.scopeRevisionId,
      reasonCodesJson: JSON.stringify(acknowledgment.reasonCodes),
      knownAdditionsJson: JSON.stringify(acknowledgment.knownAdditions),
      source: acknowledgment.source,
      acknowledgedAt: acknowledgment.acknowledgedAt,
      pendingEventId: acknowledgment.pendingEventId,
    })
    .run();
  return { ok: true, value: id };
}

function insertCoveredDestinations(
  context: ActionPersistenceContext,
  engagementId: string,
  actionId: string,
  acknowledgmentId: string,
  previous: ActionPlanningAggregate,
  next: ActionPlanningAggregate,
): ActionResult<true> {
  const previousCount = previous.coveredDestinations.length;
  const newDestinations = next.coveredDestinations.slice(previousCount);
  if (newDestinations.length === 0) return { ok: true, value: true };
  if (next.warningAcknowledgment === null) {
    return failed({ code: "invalid_persisted_data" });
  }
  let acknowledgedCursor = previous.warningAcknowledgment?.coveredDestinations.length ?? 0;
  const nextAcknowledged = next.warningAcknowledgment.coveredDestinations;
  const accountedReasons =
    previous.warningAcknowledgment?.reasonCodes ??
    next.warningAcknowledgment.reasonCodes;
  const extraReasons = next.warningAcknowledgment.reasonCodes.filter(
    (code) => !accountedReasons.includes(code),
  );
  for (const [offset, destination] of newDestinations.entries()) {
    const nextAcknowledgedDestination = nextAcknowledged[acknowledgedCursor];
    const acknowledgedCover =
      nextAcknowledgedDestination !== undefined &&
      jsonEqual(nextAcknowledgedDestination, destination);
    if (acknowledgedCover) acknowledgedCursor += 1;
    context.client
      .insert(actionCoveredDestinations)
      .values({
        actionId,
        engagementId,
        acknowledgmentId,
        sequence: previousCount + offset + 1,
        destinationJson: JSON.stringify(destination),
        reasonCodesJson: JSON.stringify(extraReasons),
        acknowledgedCover,
        createdAt: context.now().toISOString(),
      })
      .run();
  }
  return { ok: true, value: true };
}

function abortWrite(result: { ok: false; error: ActionRepositoryError }): never {
  throw new Error(`action persist write aborted: ${result.error.code}`);
}

function allocateRunOnQueue(
  context: ActionPersistenceContext,
  engagementId: string,
  actionId: string,
  previousState: string | null,
  nextState: string,
): void {
  if (nextState !== "queued" || previousState === "queued") return;
  const allocated = allocateQueuedRun(context, { actionId, engagementId });
  if (!allocated.ok) {
    throw new Error(`action persist write aborted: ${allocated.error.code}`);
  }
}

function cancelRunOnQueuedCancel(
  context: ActionPersistenceContext,
  actionId: string,
  previousState: string,
  nextState: string,
): void {
  if (nextState !== "cancelled" || previousState !== "queued") return;
  const cancelled = cancelQueuedRunForAction(context, actionId);
  if (!cancelled.ok) {
    throw new Error(`action persist write aborted: ${cancelled.error.code}`);
  }
}

function writeActionProjection(
  context: ActionPersistenceContext,
  engagementId: string,
  persisted: PersistedAction,
  next: ActionPlanningAggregate,
): ActionResult<PersistedAction> {
  const existingVersions = new Set(
    persisted.action.snapshots.map((snapshot) => snapshot.version),
  );
  for (const snapshot of next.snapshots) {
    if (existingVersions.has(snapshot.version)) continue;
    const binding = requireSnapshotBinding(snapshot);
    if (!binding.ok) return binding;
    const owned = requireOwnedScopeRevision(
      context.client,
      engagementId,
      snapshot.scopeRevisionId,
    );
    if (!owned.ok) return owned;
    const snapshotJson = snapshotJsonForStorage(snapshot);
    if (!snapshotJson.ok) return snapshotJson;
  }

  const timestamp = context.now().toISOString();
  const pendingWarningJson =
    next.pendingWarning === null ? null : JSON.stringify(next.pendingWarning);
  context.client
    .update(actions)
    .set({
      revision: persisted.revision + 1,
      state: next.state,
      queuedSnapshotVersion: next.queuedSnapshotVersion,
      warningInteractions: next.warningInteractions,
      runState: next.runState,
      resumeRequested: next.resumeRequested,
      cleanupRequired: next.cleanupRequired,
      capabilityErrorCode: next.capabilityErrorCode,
      pendingWarningJson,
      updatedAt: timestamp,
    })
    .where(
      and(
        eq(actions.engagementId, engagementId),
        eq(actions.id, next.actionId),
        eq(actions.revision, persisted.revision),
      ),
    )
    .run();

  for (const snapshot of next.snapshots) {
    if (existingVersions.has(snapshot.version)) continue;
    const inserted = insertSnapshot(context, engagementId, snapshot);
    if (!inserted.ok) abortWrite(inserted);
  }

  let acknowledgmentId = persisted.warningAcknowledgmentId;
  if (next.warningAcknowledgment !== null && acknowledgmentId === null) {
    const inserted = insertAcknowledgment(
      context,
      engagementId,
      next.warningAcknowledgment,
    );
    if (!inserted.ok) abortWrite(inserted);
    acknowledgmentId = inserted.value;
  }
  if (next.warningAcknowledgment !== null && acknowledgmentId !== null) {
    const destinations = insertCoveredDestinations(
      context,
      engagementId,
      next.actionId,
      acknowledgmentId,
      persisted.action,
      next,
    );
    if (!destinations.ok) abortWrite(destinations);
  }

  allocateRunOnQueue(
    context,
    engagementId,
    next.actionId,
    persisted.action.state,
    next.state,
  );
  cancelRunOnQueuedCancel(
    context,
    next.actionId,
    persisted.action.state,
    next.state,
  );

  return loadPersistedAction(context.client, engagementId, next.actionId);
}

function mutateAction(
  context: ActionPersistenceContext,
  engagementId: string,
  actionId: string,
  expectedRevision: number,
  transition: (
    action: ActionPlanningAggregate,
  ) => ReturnType<typeof planAction>,
): ActionResult<PersistedAction> {
  const engagement = requireActiveEngagement(context.client, engagementId);
  if (!engagement.ok) return engagement;
  const current = loadPersistedAction(context.client, engagementId, actionId);
  if (!current.ok) return current;
  if (current.value.revision !== expectedRevision) {
    return failed({
      code: "revision_conflict",
      currentRevision: current.value.revision,
    });
  }
  const next = transition(current.value.action);
  if (!next.ok) return failed(mapPlanningError(next.error.code));
  return writeActionProjection(context, engagementId, current.value, next.action);
}

export function persistPlannedAction(
  context: ActionPersistenceContext,
  input: unknown,
): ActionResult<PersistedAction> {
  const parsed = PersistPlannedActionInputSchema.safeParse(input);
  if (!parsed.success) return failed({ code: "invalid_repository_input" });
  const binding = requireSnapshotBinding(parsed.data.snapshot);
  if (!binding.ok) return binding;
  const engagement = requireActiveEngagement(
    context.client,
    parsed.data.engagementId,
  );
  if (!engagement.ok) return engagement;
  const owned = requireOwnedScopeRevision(
    context.client,
    parsed.data.engagementId,
    parsed.data.snapshot.scopeRevisionId,
  );
  if (!owned.ok) return owned;
  const activeScope = requireActiveScopeBinding(
    context.client,
    parsed.data.engagementId,
    parsed.data.snapshot.scopeRevisionId,
  );
  if (!activeScope.ok) return activeScope;
  const snapshotJson = snapshotJsonForStorage(parsed.data.snapshot);
  if (!snapshotJson.ok) return snapshotJson;
  const existing = context.client
    .select({ id: actions.id })
    .from(actions)
    .where(eq(actions.id, parsed.data.snapshot.actionId))
    .get();
  if (existing !== undefined) return failed({ code: "invalid_repository_input" });

  const planned = planAction({
    snapshot: parsed.data.snapshot,
    engagementAutoContinue: engagement.value.autoContinueWarnings,
    representable: parsed.data.representable,
    capabilityErrorCode: parsed.data.capabilityErrorCode,
    occurredAt: parsed.data.occurredAt,
  });
  if (!planned.ok) return failed(mapPlanningError(planned.error.code));

  const timestamp = context.now().toISOString();
  const pendingWarningJson =
    planned.action.pendingWarning === null
      ? null
      : JSON.stringify(planned.action.pendingWarning);
  context.client
    .insert(actions)
    .values({
      id: planned.action.actionId,
      contractVersion: ACTION_PERSISTENCE_CONTRACT_VERSION,
      engagementId: parsed.data.engagementId,
      revision: 1,
      state: planned.action.state,
      queuedSnapshotVersion: planned.action.queuedSnapshotVersion,
      warningInteractions: planned.action.warningInteractions,
      runState: planned.action.runState,
      resumeRequested: planned.action.resumeRequested,
      cleanupRequired: planned.action.cleanupRequired,
      capabilityErrorCode: planned.action.capabilityErrorCode,
      pendingWarningJson,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .run();

  for (const snapshot of planned.action.snapshots) {
    const inserted = insertSnapshot(context, parsed.data.engagementId, snapshot);
    if (!inserted.ok) abortWrite(inserted);
  }

  if (planned.action.warningAcknowledgment !== null) {
    const inserted = insertAcknowledgment(
      context,
      parsed.data.engagementId,
      planned.action.warningAcknowledgment,
    );
    if (!inserted.ok) abortWrite(inserted);
  }

  allocateRunOnQueue(
    context,
    parsed.data.engagementId,
    planned.action.actionId,
    null,
    planned.action.state,
  );

  return loadPersistedAction(
    context.client,
    parsed.data.engagementId,
    planned.action.actionId,
  );
}

export function continuePersistedAction(
  context: ActionPersistenceContext,
  input: unknown,
): ActionResult<PersistedAction> {
  const parsed = ContinuePersistedActionInputSchema.safeParse(input);
  if (!parsed.success) return failed({ code: "invalid_repository_input" });
  return mutateAction(
    context,
    parsed.data.engagementId,
    parsed.data.actionId,
    parsed.data.expectedRevision,
    (action) =>
      continueAction({
        action,
        snapshotVersion: parsed.data.snapshotVersion,
        snapshotBinding: parsed.data.snapshotBinding,
        occurredAt: parsed.data.occurredAt,
      }),
  );
}

export function addScopeAndRunPersistedAction(
  context: ActionPersistenceContext,
  input: unknown,
): ActionResult<PersistedAction> {
  const parsed = AddScopeAndRunPersistedActionInputSchema.safeParse(input);
  if (!parsed.success) return failed({ code: "invalid_repository_input" });
  const binding = requireSnapshotBinding(parsed.data.recheckedSnapshot);
  if (!binding.ok) return binding;
  const engagement = requireActiveEngagement(
    context.client,
    parsed.data.engagementId,
  );
  if (!engagement.ok) return engagement;
  const activeScope = requireActiveScopeBinding(
    context.client,
    parsed.data.engagementId,
    parsed.data.recheckedSnapshot.scopeRevisionId,
  );
  if (!activeScope.ok) return activeScope;
  const snapshotJson = snapshotJsonForStorage(parsed.data.recheckedSnapshot);
  if (!snapshotJson.ok) return snapshotJson;
  return mutateAction(
    context,
    parsed.data.engagementId,
    parsed.data.actionId,
    parsed.data.expectedRevision,
    (action) =>
      addScopeAndRun({
        action,
        recheckedSnapshot: parsed.data.recheckedSnapshot,
        occurredAt: parsed.data.occurredAt,
      }),
  );
}

export function activatePersistedAction(
  context: ActionPersistenceContext,
  input: unknown,
): ActionResult<PersistedAction> {
  const parsed = ActivatePersistedActionInputSchema.safeParse(input);
  if (!parsed.success) return failed({ code: "invalid_repository_input" });
  return mutateAction(
    context,
    parsed.data.engagementId,
    parsed.data.actionId,
    parsed.data.expectedRevision,
    (action) => activateAction({ action }),
  );
}

export function cancelPersistedAction(
  context: ActionPersistenceContext,
  input: unknown,
): ActionResult<PersistedAction> {
  const parsed = CancelPersistedActionInputSchema.safeParse(input);
  if (!parsed.success) return failed({ code: "invalid_repository_input" });
  return mutateAction(
    context,
    parsed.data.engagementId,
    parsed.data.actionId,
    parsed.data.expectedRevision,
    (action) => cancelAction({ action }),
  );
}

export function recordPersistedLateWarning(
  context: ActionPersistenceContext,
  input: unknown,
): ActionResult<PersistedAction> {
  const parsed = RecordPersistedLateWarningInputSchema.safeParse(input);
  if (!parsed.success) return failed({ code: "invalid_repository_input" });
  const engagement = requireActiveEngagement(
    context.client,
    parsed.data.engagementId,
  );
  if (!engagement.ok) return engagement;
  return mutateAction(
    context,
    parsed.data.engagementId,
    parsed.data.actionId,
    parsed.data.expectedRevision,
    (action) =>
      recordLateWarning({
        action,
        runState: "running",
        snapshotVersion: parsed.data.snapshotVersion,
        snapshotBinding: parsed.data.snapshotBinding,
        reasonCodes: parsed.data.reasonCodes,
        addition: parsed.data.addition,
        pendingEventId: parsed.data.pendingEventId,
        engagementAutoContinue: engagement.value.autoContinueWarnings,
        occurredAt: parsed.data.occurredAt,
      }),
  );
}

export function continuePersistedLateWarning(
  context: ActionPersistenceContext,
  input: unknown,
): ActionResult<PersistedAction> {
  const parsed = ContinuePersistedLateWarningInputSchema.safeParse(input);
  if (!parsed.success) return failed({ code: "invalid_repository_input" });
  return mutateAction(
    context,
    parsed.data.engagementId,
    parsed.data.actionId,
    parsed.data.expectedRevision,
    (action) =>
      continueLateWarning({
        action,
        snapshotVersion: parsed.data.snapshotVersion,
        snapshotBinding: parsed.data.snapshotBinding,
        pendingEventId: parsed.data.pendingEventId,
        occurredAt: parsed.data.occurredAt,
      }),
  );
}

export function getPersistedAction(
  client: ActionQueryClient,
  engagementId: string,
  actionId: string,
): ActionResult<PersistedAction> {
  const engagement = currentEngagement(client, engagementId);
  if (!engagement.ok) return engagement;
  return loadPersistedAction(client, engagementId, actionId);
}

export function getPersistedRetryContext(
  client: ActionQueryClient,
  engagementId: string,
  actionId: string,
): ActionResult<RetryActionContext> {
  const persisted = getPersistedAction(client, engagementId, actionId);
  if (!persisted.ok) return persisted;
  const result = retryActionContext({
    action: persisted.value.action,
    warningAcknowledgmentId: persisted.value.warningAcknowledgmentId,
  });
  return result.ok
    ? { ok: true, value: result.context }
    : failed(mapPlanningError(result.error.code));
}
