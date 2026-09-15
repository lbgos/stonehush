import {
  ActionCommandInputSchema,
  ActionPlanningAggregateSchema,
  AddScopeAndRunInputSchema,
  ContinueActionInputSchema,
  ContinueLateWarningInputSchema,
  LateWarningInputSchema,
  PlanActionInputSchema,
  ResolutionSnapshotInputSchema,
  RetryActionContextInputSchema,
  type ActionPlanningAggregate,
  type ActionPlanningError,
  type ActionPlanningResult,
  type ActionSnapshot,
  type CanonicalTarget,
  type CanonicalUrlHost,
  type ResolutionSnapshotResult,
  type RetryActionContextResult,
  type WarningAcknowledgment,
  type WarningAcknowledgmentSource,
  type WarningContextAddition,
  type WarningReasonCode,
} from "@stonehush/contracts";

import { normalizeTarget } from "./normalize-target.js";

function failure(code: ActionPlanningError["code"]): ActionPlanningResult {
  return { ok: false, error: { code } };
}

function parseWithoutThrow<T>(operation: () => T): T | null {
  try {
    return operation();
  } catch {
    return null;
  }
}

function freeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    freeze(child);
  }
  return value;
}

function accepted(action: ActionPlanningAggregate): ActionPlanningResult {
  const parsed = ActionPlanningAggregateSchema.safeParse(action);
  return parsed.success
    ? { ok: true, action: freeze(parsed.data) }
    : failure("invalid_action_planning_input");
}

function snapshotForVersion(
  action: ActionPlanningAggregate,
  version: number,
): ActionSnapshot | undefined {
  return action.snapshots.find((snapshot) => snapshot.version === version);
}

function queuedSnapshot(action: ActionPlanningAggregate): ActionSnapshot | undefined {
  return action.queuedSnapshotVersion === null
    ? undefined
    : snapshotForVersion(action, action.queuedSnapshotVersion);
}

function urlHostEquals(left: CanonicalUrlHost, right: CanonicalUrlHost): boolean {
  if ("hostname" in left || "hostname" in right) {
    return (
      "hostname" in left && "hostname" in right && left.hostname === right.hostname
    );
  }
  return left.address === right.address && left.zone === right.zone;
}

function targetIsCanonical(target: CanonicalTarget): boolean {
  const raw =
    target.kind === "ip"
      ? target.zone === null
        ? target.address
        : `${target.address}%${target.zone}`
      : target.kind === "cidr"
        ? `${target.network}/${target.prefixLength}`
        : target.kind === "hostname"
          ? target.hostname
          : target.url;
  const normalized = normalizeTarget(raw);
  if (!normalized.ok || normalized.target.kind !== target.kind) {
    return false;
  }
  if (target.kind === "ip" && normalized.target.kind === "ip") {
    return (
      normalized.target.family === target.family &&
      normalized.target.address === target.address &&
      normalized.target.zone === target.zone
    );
  }
  if (target.kind === "cidr" && normalized.target.kind === "cidr") {
    return (
      normalized.target.family === target.family &&
      normalized.target.network === target.network &&
      normalized.target.prefixLength === target.prefixLength &&
      normalized.target.hostBitsMasked === target.hostBitsMasked
    );
  }
  if (target.kind === "hostname" && normalized.target.kind === "hostname") {
    return normalized.target.hostname === target.hostname;
  }
  return (
    target.kind === "url" &&
    normalized.target.kind === "url" &&
    normalized.target.url === target.url &&
    normalized.target.origin === target.origin &&
    urlHostEquals(normalized.target.host, target.host) &&
    normalized.target.effectivePort === target.effectivePort &&
    normalized.target.pathAndQuery === target.pathAndQuery
  );
}

function hostnameIsCanonical(hostname: string): boolean {
  const normalized = normalizeTarget(hostname);
  return (
    normalized.ok &&
    normalized.target.kind === "hostname" &&
    normalized.target.hostname === hostname
  );
}

function addressIsCanonical(address: string): boolean {
  const normalized = normalizeTarget(address);
  return (
    normalized.ok &&
    normalized.target.kind === "ip" &&
    normalized.target.address === address &&
    normalized.target.zone === null
  );
}

function warningOriginIsCanonical(origin: string): boolean {
  const normalized = normalizeTarget(`${origin}/`);
  if (!normalized.ok || normalized.target.kind !== "url") {
    return false;
  }
  const host = normalized.target.host;
  const serializedHost =
    "hostname" in host
      ? host.hostname
      : host.address.includes(":")
        ? `[${host.address}${host.zone === null ? "" : `%25${host.zone}`}]`
        : host.address;
  return (
    `${normalized.target.url.startsWith("https:") ? "https" : "http"}://${serializedHost}:${normalized.target.effectivePort}` ===
    origin
  );
}

export function warningAdditionIsCanonical(
  addition: WarningContextAddition,
): boolean {
  if ("estimatedConcreteTargets" in addition) {
    return true;
  }
  if ("hostname" in addition) {
    return (
      hostnameIsCanonical(addition.hostname) &&
      addressIsCanonical(addition.address)
    );
  }
  return (
    warningOriginIsCanonical(addition.origin) &&
    addressIsCanonical(addition.resolvedAddress)
  );
}

function resolutionIsCanonical(
  resolution: ActionSnapshot["resolutionSnapshots"][number],
): boolean {
  return (
    hostnameIsCanonical(resolution.canonicalQueryName) &&
    resolution.cnameChain.every(hostnameIsCanonical) &&
    resolution.answers.every((answer) => {
      if (!addressIsCanonical(answer.address)) {
        return false;
      }
      return answer.family === (answer.address.includes(":") ? 6 : 4);
    })
  );
}

export function snapshotIsCanonical(snapshot: ActionSnapshot): boolean {
  return (
    snapshot.canonicalTargets.every(targetIsCanonical) &&
    snapshot.concreteDestinations.every(targetIsCanonical) &&
    snapshot.resolutionSnapshots.every(resolutionIsCanonical) &&
    snapshot.warningState.knownAdditions.every(warningAdditionIsCanonical)
  );
}

function actionIsCanonical(action: ActionPlanningAggregate): boolean {
  return (
    action.snapshots.every(snapshotIsCanonical) &&
    action.coveredDestinations.every(warningAdditionIsCanonical) &&
    (action.pendingWarning === null ||
      action.pendingWarning.knownAdditions.every(warningAdditionIsCanonical)) &&
    (action.warningAcknowledgment === null ||
      (action.warningAcknowledgment.knownAdditions.every(
        warningAdditionIsCanonical,
      ) &&
        action.warningAcknowledgment.coveredDestinations.every(
          warningAdditionIsCanonical,
        )))
  );
}

function latestSnapshot(action: ActionPlanningAggregate): ActionSnapshot {
  return action.snapshots.reduce((latest, candidate) =>
    candidate.version > latest.version ? candidate : latest,
  );
}

function acknowledgment(
  snapshot: ActionSnapshot,
  reasonCodes: readonly WarningReasonCode[],
  knownAdditions: readonly WarningContextAddition[],
  source: WarningAcknowledgmentSource,
  acknowledgedAt: string,
  pendingEventId: number | null,
): WarningAcknowledgment {
  return {
    actionId: snapshot.actionId,
    snapshotId: snapshot.snapshotId,
    snapshotVersion: snapshot.version,
    snapshotBinding: snapshot.binding,
    scopeRevisionId: snapshot.scopeRevisionId,
    reasonCodes: [...reasonCodes],
    knownAdditions: [...knownAdditions],
    source,
    acknowledgedAt,
    pendingEventId,
    coveredDestinations: [],
  };
}

export function createResolutionSnapshot(input: unknown): ResolutionSnapshotResult {
  const parsed = parseWithoutThrow(() =>
    ResolutionSnapshotInputSchema.safeParse(input),
  );
  if (parsed === null || !parsed.success) {
    return { ok: false, error: { code: "invalid_action_planning_input" } };
  }
  const candidate = {
    canonicalQueryName: parsed.data.canonicalQueryName,
    ...parsed.data.resolverResult,
  };
  if (!resolutionIsCanonical(candidate)) {
    return { ok: false, error: { code: "invalid_action_planning_input" } };
  }
  if (
    parsed.data.actionRequiresConcreteAddresses &&
    parsed.data.resolverResult.answers.length === 0
  ) {
    return { ok: false, error: { code: "required_resolution_unavailable" } };
  }
  return {
    ok: true,
    snapshot: freeze(candidate),
  };
}

export function planAction(input: unknown): ActionPlanningResult {
  const parsed = parseWithoutThrow(() => PlanActionInputSchema.safeParse(input));
  if (parsed === null || !parsed.success) {
    return failure("invalid_action_planning_input");
  }
  const { snapshot, representable, capabilityErrorCode, occurredAt } = parsed.data;
  if (snapshot.version !== 1 || !snapshotIsCanonical(snapshot)) {
    return failure("invalid_action_planning_input");
  }
  if (representable === (capabilityErrorCode !== null)) {
    return failure("invalid_action_planning_input");
  }

  const base: ActionPlanningAggregate = {
    orchestrationProfile: "d2-v1",
    actionId: snapshot.actionId,
    state: "planning",
    snapshots: [snapshot],
    queuedSnapshotVersion: null,
    warningAcknowledgment: null,
    pendingWarning: null,
    coveredDestinations: [],
    warningInteractions: 0,
    runState: null,
    resumeRequested: false,
    cleanupRequired: false,
    capabilityErrorCode: null,
  };
  if (!representable) {
    return accepted({
      ...base,
      state: "capability_error",
      capabilityErrorCode,
    });
  }

  const reasons = snapshot.warningState.reasonCodes;
  if (reasons.length === 0) {
    return accepted({
      ...base,
      state: "queued",
      queuedSnapshotVersion: snapshot.version,
    });
  }
  if (parsed.data.engagementAutoContinue) {
    return accepted({
      ...base,
      state: "queued",
      queuedSnapshotVersion: snapshot.version,
      warningAcknowledgment: acknowledgment(
        snapshot,
        reasons,
        snapshot.warningState.knownAdditions,
        "engagement_policy",
        occurredAt,
        null,
      ),
    });
  }
  return accepted({
    ...base,
    state: "paused_for_warning",
    pendingWarning: {
      reasonCodes: [...reasons],
      knownAdditions: [...snapshot.warningState.knownAdditions],
      pendingEventId: null,
    },
    warningInteractions: 1,
  });
}

export function continueAction(input: unknown): ActionPlanningResult {
  const parsed = parseWithoutThrow(() =>
    ContinueActionInputSchema.safeParse(input),
  );
  if (parsed === null || !parsed.success) {
    return failure("invalid_action_planning_input");
  }
  const { action, snapshotVersion, snapshotBinding, occurredAt } = parsed.data;
  if (!actionIsCanonical(action)) {
    return failure("invalid_action_planning_input");
  }
  if (action.state === "capability_error") {
    return failure("capability_error_not_overridable");
  }
  if (action.state === "queued" || action.queuedSnapshotVersion !== null) {
    return failure("action_already_queued");
  }
  if (action.state !== "paused_for_warning" || action.pendingWarning === null) {
    return failure("invalid_action_transition");
  }
  const snapshot = latestSnapshot(action);
  if (
    snapshot.version !== snapshotVersion ||
    snapshot.binding !== snapshotBinding
  ) {
    return failure("snapshot_binding_mismatch");
  }
  return accepted({
    ...action,
    state: "queued",
    queuedSnapshotVersion: snapshot.version,
    warningAcknowledgment: acknowledgment(
      snapshot,
      action.pendingWarning.reasonCodes,
      action.pendingWarning.knownAdditions,
      "operator_continue",
      occurredAt,
      null,
    ),
    pendingWarning: null,
  });
}

export function addScopeAndRun(input: unknown): ActionPlanningResult {
  const parsed = parseWithoutThrow(() =>
    AddScopeAndRunInputSchema.safeParse(input),
  );
  if (parsed === null || !parsed.success) {
    return failure("invalid_action_planning_input");
  }
  const { action, recheckedSnapshot, occurredAt } = parsed.data;
  if (!actionIsCanonical(action) || !snapshotIsCanonical(recheckedSnapshot)) {
    return failure("invalid_action_planning_input");
  }
  if (action.queuedSnapshotVersion !== null) {
    return failure("action_already_queued");
  }
  if (action.state !== "paused_for_warning") {
    return failure("invalid_action_transition");
  }
  const latestVersion = Math.max(...action.snapshots.map(({ version }) => version));
  if (
    recheckedSnapshot.actionId !== action.actionId ||
    recheckedSnapshot.version !== latestVersion + 1
  ) {
    return failure("invalid_action_planning_input");
  }
  const reasons = recheckedSnapshot.warningState.reasonCodes;
  return accepted({
    ...action,
    state: "queued",
    snapshots: [...action.snapshots, recheckedSnapshot],
    queuedSnapshotVersion: recheckedSnapshot.version,
    warningAcknowledgment: acknowledgment(
      recheckedSnapshot,
      reasons,
      recheckedSnapshot.warningState.knownAdditions,
      "add_scope_and_run",
      occurredAt,
      null,
    ),
    pendingWarning: null,
  });
}

export function activateAction(input: unknown): ActionPlanningResult {
  const parsed = parseWithoutThrow(() => ActionCommandInputSchema.safeParse(input));
  if (parsed === null || !parsed.success) {
    return failure("invalid_action_planning_input");
  }
  if (parsed.data.action.state !== "queued") {
    return failure("invalid_action_transition");
  }
  if (!actionIsCanonical(parsed.data.action)) {
    return failure("invalid_action_planning_input");
  }
  return accepted({
    ...parsed.data.action,
    state: "active",
    runState: "running",
  });
}

export function recordLateWarning(input: unknown): ActionPlanningResult {
  const parsed = parseWithoutThrow(() => LateWarningInputSchema.safeParse(input));
  if (parsed === null || !parsed.success) {
    return failure("invalid_action_planning_input");
  }
  const {
    action,
    reasonCodes,
    addition,
    pendingEventId,
    engagementAutoContinue,
    occurredAt,
    snapshotVersion,
    snapshotBinding,
  } = parsed.data;
  if (!actionIsCanonical(action) || !warningAdditionIsCanonical(addition)) {
    return failure("invalid_action_planning_input");
  }
  if (action.state !== "active" || action.runState !== "running") {
    return failure("invalid_action_transition");
  }
  const snapshot = queuedSnapshot(action);
  if (snapshot === undefined) {
    return failure("invalid_action_planning_input");
  }
  if (
    snapshot.version !== snapshotVersion ||
    snapshot.binding !== snapshotBinding
  ) {
    return failure("snapshot_binding_mismatch");
  }
  if (action.warningAcknowledgment !== null) {
    const coveredReasons = [
      ...new Set([
        ...action.warningAcknowledgment.reasonCodes,
        ...reasonCodes,
      ]),
    ];
    return accepted({
      ...action,
      warningAcknowledgment: {
        ...action.warningAcknowledgment,
        reasonCodes: coveredReasons,
        coveredDestinations: [
          ...action.warningAcknowledgment.coveredDestinations,
          addition,
        ],
      },
      coveredDestinations: [...action.coveredDestinations, addition],
    });
  }
  if (engagementAutoContinue) {
    return accepted({
      ...action,
      warningAcknowledgment: acknowledgment(
        snapshot,
        reasonCodes,
        [addition],
        "engagement_policy",
        occurredAt,
        pendingEventId,
      ),
      coveredDestinations: [...action.coveredDestinations, addition],
    });
  }
  return accepted({
    ...action,
    state: "active_paused_for_warning",
    pendingWarning: {
      reasonCodes: [...reasonCodes],
      knownAdditions: [addition],
      pendingEventId,
    },
    warningInteractions: 1,
  });
}

export function continueLateWarning(input: unknown): ActionPlanningResult {
  const parsed = parseWithoutThrow(() =>
    ContinueLateWarningInputSchema.safeParse(input),
  );
  if (parsed === null || !parsed.success) {
    return failure("invalid_action_planning_input");
  }
  const {
    action,
    snapshotVersion,
    snapshotBinding,
    pendingEventId,
    occurredAt,
  } = parsed.data;
  if (!actionIsCanonical(action)) {
    return failure("invalid_action_planning_input");
  }
  if (action.state !== "active_paused_for_warning" || action.pendingWarning === null) {
    return failure("invalid_action_transition");
  }
  if (action.runState !== "running") {
    return failure("invalid_run_transition");
  }
  const snapshot = queuedSnapshot(action);
  if (snapshot === undefined) {
    return failure("invalid_action_planning_input");
  }
  if (
    snapshot.version !== snapshotVersion ||
    snapshot.binding !== snapshotBinding
  ) {
    return failure("snapshot_binding_mismatch");
  }
  if (action.pendingWarning.pendingEventId !== pendingEventId) {
    return failure("invalid_run_transition");
  }
  return accepted({
    ...action,
    state: "active",
    warningAcknowledgment: acknowledgment(
      snapshot,
      action.pendingWarning.reasonCodes,
      action.pendingWarning.knownAdditions,
      "operator_continue",
      occurredAt,
      pendingEventId,
    ),
    pendingWarning: null,
    coveredDestinations: [
      ...action.coveredDestinations,
      ...action.pendingWarning.knownAdditions,
    ],
    resumeRequested: true,
  });
}

export function cancelAction(input: unknown): ActionPlanningResult {
  const parsed = parseWithoutThrow(() => ActionCommandInputSchema.safeParse(input));
  if (parsed === null || !parsed.success) {
    return failure("invalid_action_planning_input");
  }
  const { action } = parsed.data;
  if (!actionIsCanonical(action)) {
    return failure("invalid_action_planning_input");
  }
  if (action.state === "planning") {
    return accepted({ ...action, state: "cancelled" });
  }
  if (action.state === "paused_for_warning") {
    return accepted({ ...action, state: "cancelled", pendingWarning: null });
  }
  if (action.state === "queued") {
    return accepted({ ...action, state: "cancelled" });
  }
  if (
    action.state === "active_paused_for_warning" &&
    action.runState === "running"
  ) {
    return accepted({
      ...action,
      runState: "cancel_requested",
      cleanupRequired: true,
      resumeRequested: false,
    });
  }
  return failure("invalid_action_transition");
}

export function retryActionContext(input: unknown): RetryActionContextResult {
  const parsed = parseWithoutThrow(() =>
    RetryActionContextInputSchema.safeParse(input),
  );
  if (parsed === null || !parsed.success) {
    return { ok: false, error: { code: "invalid_action_planning_input" } };
  }
  const { action, warningAcknowledgmentId } = parsed.data;
  if (!actionIsCanonical(action)) {
    return { ok: false, error: { code: "invalid_action_planning_input" } };
  }
  if (action.state === "succeeded") {
    return { ok: false, error: { code: "run_not_retryable" } };
  }
  if (action.state !== "failed" && action.state !== "cancelled") {
    return { ok: false, error: { code: "invalid_action_transition" } };
  }
  const snapshot = queuedSnapshot(action);
  if (snapshot === undefined) {
    return { ok: false, error: { code: "invalid_action_transition" } };
  }
  return {
    ok: true,
    context: freeze({
      actionId: action.actionId,
      snapshotId: snapshot.snapshotId,
      snapshotVersion: snapshot.version,
      snapshotBinding: snapshot.binding,
      warningAcknowledgment:
        action.warningAcknowledgment === null
          ? null
          : structuredClone(action.warningAcknowledgment),
      warningAcknowledgmentId,
      resolutionRefreshed: false,
      newWarningBudget: false,
    }),
  };
}
