import {
  WarningContextAdditionSchema,
  WarningReasonCodeSchema,
  type ActionPlanningAggregate,
  type ActionPlanningResult,
  type ActionSnapshot,
  type ResolutionSnapshot,
  type WarningContextAddition,
  type WarningReasonCode,
} from "@stonehush/contracts";
import { describe, expect, it } from "vitest";

import resolutionFixtureData from "../../../docs/architecture/fixtures/d1/resolution-snapshot.json" with {
  type: "json",
};
import stateMachineFixtureData from "../../../docs/architecture/fixtures/d2/state-machine.json" with {
  type: "json",
};
import warningFixtureData from "../../../docs/architecture/fixtures/d1/warning-flow.json" with {
  type: "json",
};
import {
  activateAction,
  addScopeAndRun,
  cancelAction,
  continueAction,
  continueLateWarning,
  createResolutionSnapshot,
  planAction,
  recordLateWarning,
  retryActionContext,
  snapshotIsCanonical,
  warningAdditionIsCanonical,
} from "./action-planning.js";

interface WarningFixtureCase {
  id: string;
  given: {
    actionId: string;
    snapshotHash?: string;
    scopeRevisionId?: string | null;
    knownReasonCodes?: WarningReasonCode[];
    engagementAutoContinue?: boolean;
    warningAcknowledgmentId?: string;
    event?: {
      at?: string;
      newScopeRevisionId?: string;
      postRecheckSnapshotHash?: string;
      postRecheckReasonCodes?: WarningReasonCode[];
      destination?: WarningContextAddition;
    };
  };
  expected?: {
    actionState?: string;
    warningInteractions?: number;
    acknowledgment?: {
      actionId?: string;
      snapshotHash?: string;
      scopeRevisionId?: string | null;
      reasonCodes?: WarningReasonCode[];
      knownAdditions?: WarningContextAddition[];
      source?: string;
      acknowledgedAt?: string;
      coveredDestinations?: WarningContextAddition[];
    };
  };
  error?: { code: string };
}

interface ResolutionFixtureCase {
  id: string;
  given: {
    canonicalQueryName: string;
    actionRequiresConcreteAddresses?: boolean;
    resolverResult: Omit<ResolutionSnapshot, "canonicalQueryName">;
  };
  expected?: { resolutionSnapshot: ResolutionSnapshot };
  error?: { code: string };
}

interface FreezeSnapshotFixtureCase {
  id: "d1.snapshot.freezes-planning-context";
  given: {
    actionId: string;
    canonicalTargets: ActionSnapshot["canonicalTargets"];
    typedOptions: { ports: number[] };
    resolutionSnapshots: ResolutionSnapshot[];
    scopeRevisionId: string | null;
    warningState: {
      reasonCodes: WarningReasonCode[];
      acknowledgment: null;
    };
  };
}

interface D2ActionFixtureCase {
  id: string;
  given: Record<string, unknown>;
  expected?: Record<string, unknown>;
  error?: { code: string };
}

const warningCases = warningFixtureData.cases as WarningFixtureCase[];
const resolutionCases = resolutionFixtureData.cases as ResolutionFixtureCase[];
const d2ActionCases = stateMachineFixtureData.cases as D2ActionFixtureCase[];
const defaultTime = "2026-08-09T12:00:00.000Z";

function warningCase(id: string): WarningFixtureCase {
  const testCase = warningCases.find((candidate) => candidate.id === id);
  if (testCase === undefined) {
    throw new Error(`Missing warning fixture: ${id}`);
  }
  return testCase;
}

function resolutionCase(id: string): ResolutionFixtureCase {
  const testCase = resolutionCases.find((candidate) => candidate.id === id);
  if (testCase === undefined) {
    throw new Error(`Missing resolution fixture: ${id}`);
  }
  return testCase;
}

function d2Case(id: string): D2ActionFixtureCase {
  const testCase = d2ActionCases.find((candidate) => candidate.id === id);
  if (testCase === undefined) throw new Error(`Missing D2 fixture: ${id}`);
  return testCase;
}

function d2String(fields: Record<string, unknown>, key: string): string {
  const value = fields[key];
  if (typeof value !== "string") throw new Error(`D2 field ${key} is not a string`);
  return value;
}

function d2Number(fields: Record<string, unknown>, key: string): number {
  const value = fields[key];
  if (typeof value !== "number") throw new Error(`D2 field ${key} is not a number`);
  return value;
}

function d2Addition(
  fields: Record<string, unknown>,
  key: string,
): WarningContextAddition {
  const parsed = WarningContextAdditionSchema.safeParse(fields[key]);
  if (!parsed.success) throw new Error(`D2 field ${key} is not a warning addition`);
  return parsed.data;
}

function d2Reasons(
  fields: Record<string, unknown>,
  key: string,
): WarningReasonCode[] {
  const value = fields[key];
  if (!Array.isArray(value)) throw new Error(`D2 field ${key} is not an array`);
  return value.map((candidate) => WarningReasonCodeSchema.parse(candidate));
}

function snapshot(options: {
  actionId: string;
  binding?: string | undefined;
  version?: number | undefined;
  scopeRevisionId?: string | null | undefined;
  reasons?: WarningReasonCode[] | undefined;
  additions?: WarningContextAddition[] | undefined;
}): ActionSnapshot {
  const version = options.version ?? 1;
  return {
    normalizationProfile: "d1-v1",
    orchestrationProfile: "d2-v1",
    snapshotId: `snapshot-${version}`,
    version,
    binding: options.binding ?? `sha256:fixture-${options.actionId}-${version}`,
    actionId: options.actionId,
    canonicalTargets: [
      {
        normalizationProfile: "d1-v1",
        kind: "hostname",
        hostname: "app.target.test",
      },
    ],
    concreteDestinations: [
      {
        normalizationProfile: "d1-v1",
        kind: "ip",
        family: 4,
        address: "192.0.2.40",
        zone: null,
      },
    ],
    typedOptions: { ports: [80, 443] },
    resolutionSnapshots: [
      {
        canonicalQueryName: "app.target.test",
        resolverMode: "system",
        cnameChain: [],
        answers: [{ address: "192.0.2.40", family: 4, ttlSeconds: 60 }],
        resolvedAt: defaultTime,
      },
    ],
    scopeRevisionId: options.scopeRevisionId ?? null,
    warningState: {
      reasonCodes: options.reasons ?? [],
      knownAdditions: options.additions ?? [],
      acknowledgment: null,
    },
  };
}

function actionFrom(result: ActionPlanningResult): ActionPlanningAggregate {
  if (!result.ok) {
    throw new Error(`Expected successful action result, received ${result.error.code}`);
  }
  return result.action;
}

function plan(
  plannedSnapshot: ActionSnapshot,
  engagementAutoContinue = false,
): ActionPlanningAggregate {
  return actionFrom(
    planAction({
      snapshot: plannedSnapshot,
      engagementAutoContinue,
      representable: true,
      capabilityErrorCode: null,
      occurredAt: defaultTime,
    }),
  );
}

function activate(action: ActionPlanningAggregate): ActionPlanningAggregate {
  return actionFrom(activateAction({ action }));
}

function lateWarning(
  action: ActionPlanningAggregate,
  addition: WarningContextAddition,
  options: {
    reasonCodes?: WarningReasonCode[] | undefined;
    autoContinue?: boolean | undefined;
    pendingEventId?: number | undefined;
    occurredAt?: string | undefined;
  } = {},
): ActionPlanningAggregate {
  const queuedSnapshot = action.snapshots.find(
    ({ version }) => version === action.queuedSnapshotVersion,
  );
  if (queuedSnapshot === undefined) {
    throw new Error("Late-warning adapter requires a queued snapshot");
  }
  return actionFrom(
    recordLateWarning({
      action,
      runState: "running",
      snapshotVersion: queuedSnapshot.version,
      snapshotBinding: queuedSnapshot.binding,
      reasonCodes: options.reasonCodes ?? ["outside_scope"],
      addition,
      pendingEventId: options.pendingEventId ?? 1,
      engagementAutoContinue: options.autoContinue ?? false,
      occurredAt: options.occurredAt ?? defaultTime,
    }),
  );
}

describe("D1 resolution snapshot fixtures", () => {
  it.each([
    "d1.resolution.records-complete-answer-evidence",
    "d1.resolution.ttl-may-be-unavailable",
  ])("executes %s", (id) => {
    const testCase = resolutionCase(id);
    expect(
      createResolutionSnapshot({
        ...testCase.given,
        actionRequiresConcreteAddresses: false,
      }),
    ).toEqual({ ok: true, snapshot: testCase.expected?.resolutionSnapshot });
  });

  it("executes the required-address capability fixture", () => {
    const testCase = resolutionCase(
      "d1.resolution.required-address-failure-is-capability-error",
    );
    expect(createResolutionSnapshot(testCase.given)).toEqual({
      ok: false,
      error: { code: testCase.error?.code },
    });
  });

  it.each([
    { canonicalQueryName: "Target.Test", address: "192.0.2.7", family: 4 },
    { canonicalQueryName: "target.test", address: "192.0.2.007", family: 4 },
    { canonicalQueryName: "target.test", address: "2001:0db8::1", family: 6 },
  ])("rejects noncanonical resolver evidence %#", (candidate) => {
    expect(
      createResolutionSnapshot({
        canonicalQueryName: candidate.canonicalQueryName,
        resolverResult: {
          resolverMode: "system",
          cnameChain: [],
          answers: [
            {
              address: candidate.address,
              family: candidate.family,
              ttlSeconds: null,
            },
          ],
          resolvedAt: defaultTime,
        },
        actionRequiresConcreteAddresses: true,
      }),
    ).toEqual({
      ok: false,
      error: { code: "invalid_action_planning_input" },
    });
  });
});

describe("pre-run warning flow", () => {
  it("executes the no-warning queue fixture", () => {
    const testCase = warningCase(
      "d1.warning.no-reasons-queues-without-interaction",
    );
    const action = plan(snapshot({ actionId: testCase.given.actionId }));
    expect(action).toMatchObject({
      state: testCase.expected?.actionState,
      warningInteractions: testCase.expected?.warningInteractions,
      warningAcknowledgment: null,
      queuedSnapshotVersion: 1,
    });
  });

  it("executes the combined one-warning fixture", () => {
    const testCase = warningCase("d1.warning.prerun-reasons-combine-once");
    const action = plan(
      snapshot({
        actionId: testCase.given.actionId,
        reasons: testCase.given.knownReasonCodes,
      }),
    );
    expect(action).toMatchObject({
      state: "paused_for_warning",
      queuedSnapshotVersion: null,
      warningInteractions: 1,
      pendingWarning: {
        reasonCodes: testCase.given.knownReasonCodes,
        knownAdditions: [],
        pendingEventId: null,
      },
    });
  });

  it("executes Continue against the exact immutable snapshot", () => {
    const testCase = warningCase("d1.warning.continue-records-and-queues");
    const plannedSnapshot = snapshot({
      actionId: testCase.given.actionId,
      binding: testCase.given.snapshotHash,
      scopeRevisionId: testCase.given.scopeRevisionId,
      reasons: testCase.given.knownReasonCodes,
    });
    const action = actionFrom(
      continueAction({
        action: plan(plannedSnapshot),
        snapshotVersion: 1,
        snapshotBinding: plannedSnapshot.binding,
        occurredAt: testCase.given.event?.at,
      }),
    );
    expect(action).toMatchObject({
      state: testCase.expected?.actionState,
      queuedSnapshotVersion: 1,
      warningInteractions: 1,
      warningAcknowledgment: {
        actionId: testCase.expected?.acknowledgment?.actionId,
        snapshotBinding: testCase.expected?.acknowledgment?.snapshotHash,
        scopeRevisionId: testCase.expected?.acknowledgment?.scopeRevisionId,
        reasonCodes: testCase.expected?.acknowledgment?.reasonCodes,
        source: testCase.expected?.acknowledgment?.source,
        acknowledgedAt: testCase.expected?.acknowledgment?.acknowledgedAt,
        pendingEventId: null,
        coveredDestinations: [],
      },
    });
    expect(action.snapshots[0]?.scopeRevisionId).toBe(
      testCase.given.scopeRevisionId,
    );
  });

  it("executes add-scope recheck once and binds the appended snapshot", () => {
    const testCase = warningCase(
      "d1.warning.add-scope-rechecks-without-second-prompt",
    );
    const before = snapshot({
      actionId: testCase.given.actionId,
      binding: testCase.given.snapshotHash,
      scopeRevisionId: testCase.given.scopeRevisionId,
      reasons: testCase.given.knownReasonCodes,
    });
    const after = snapshot({
      actionId: testCase.given.actionId,
      binding: testCase.given.event?.postRecheckSnapshotHash,
      scopeRevisionId: testCase.given.event?.newScopeRevisionId,
      reasons: testCase.given.event?.postRecheckReasonCodes,
      version: 2,
    });
    const action = actionFrom(
      addScopeAndRun({
        action: plan(before),
        recheckedSnapshot: after,
        occurredAt: testCase.given.event?.at,
      }),
    );
    expect(action.snapshots).toEqual([before, after]);
    expect(action).toMatchObject({
      state: "queued",
      queuedSnapshotVersion: 2,
      warningInteractions: 1,
      warningAcknowledgment: {
        snapshotVersion: 2,
        snapshotBinding: after.binding,
        scopeRevisionId: after.scopeRevisionId,
        reasonCodes: after.warningState.reasonCodes,
        source: "add_scope_and_run",
      },
    });
  });

  it("queues after add-scope even when recheck clears every reason", () => {
    const before = snapshot({
      actionId: "action-scope-clears-warning",
      reasons: ["outside_scope"],
      scopeRevisionId: "scope-revision-1",
    });
    const after = snapshot({
      actionId: before.actionId,
      version: 2,
      reasons: [],
      scopeRevisionId: "scope-revision-2",
    });
    const action = actionFrom(
      addScopeAndRun({
        action: plan(before),
        recheckedSnapshot: after,
        occurredAt: defaultTime,
      }),
    );
    expect(action).toMatchObject({
      state: "queued",
      queuedSnapshotVersion: 2,
      warningInteractions: 1,
      warningAcknowledgment: {
        reasonCodes: [],
        source: "add_scope_and_run",
      },
    });
  });

  it("rejects a stale snapshot version even when its binding matches", () => {
    const first = snapshot({
      actionId: "action-stale-snapshot",
      reasons: ["outside_scope"],
    });
    const second = snapshot({
      actionId: first.actionId,
      version: 2,
      reasons: ["large_target_set"],
    });
    const paused = plan(first);
    expect(
      continueAction({
        action: { ...paused, snapshots: [first, second] },
        snapshotVersion: 1,
        snapshotBinding: first.binding,
        occurredAt: defaultTime,
      }),
    ).toEqual({ ok: false, error: { code: "snapshot_binding_mismatch" } });
  });

  it("executes pre-run engagement auto-continue", () => {
    const testCase = warningCase("d1.warning.prerun-auto-continue");
    const action = plan(
      snapshot({
        actionId: testCase.given.actionId,
        binding: testCase.given.snapshotHash,
        scopeRevisionId: testCase.given.scopeRevisionId,
        reasons: testCase.given.knownReasonCodes,
      }),
      true,
    );
    expect(action).toMatchObject({
      state: "queued",
      warningInteractions: 0,
      warningAcknowledgment: {
        source: "engagement_policy",
        snapshotBinding: testCase.given.snapshotHash,
        reasonCodes: testCase.given.knownReasonCodes,
      },
    });
  });
});

describe("late warning flow", () => {
  const redirectAddition = {
    origin: "https://other.test:443",
    resolvedAddress: "192.0.2.41",
  } as const;

  it("executes first-late pause and exact-context Continue", () => {
    const pauseCase = warningCase("d1.warning.first-late-reason-pauses-once");
    const continueCase = warningCase("d1.warning.late-continue-resumes");
    const plannedSnapshot = snapshot({
      actionId: continueCase.given.actionId,
      binding: continueCase.given.snapshotHash,
      scopeRevisionId: continueCase.given.scopeRevisionId,
    });
    const paused = lateWarning(activate(plan(plannedSnapshot)), redirectAddition, {
      pendingEventId: 17,
    });
    expect(paused).toMatchObject({
      state: pauseCase.expected?.actionState,
      runState: "running",
      warningInteractions: 1,
      warningAcknowledgment: null,
      pendingWarning: {
        reasonCodes: ["outside_scope"],
        knownAdditions: [redirectAddition],
        pendingEventId: 17,
      },
    });

    const resumed = actionFrom(
      continueLateWarning({
        action: paused,
        snapshotVersion: 1,
        snapshotBinding: plannedSnapshot.binding,
        pendingEventId: 17,
        occurredAt: continueCase.given.event?.at,
      }),
    );
    expect(resumed).toMatchObject({
      state: continueCase.expected?.actionState,
      runState: "running",
      resumeRequested: true,
      warningAcknowledgment: {
        snapshotBinding: plannedSnapshot.binding,
        scopeRevisionId: plannedSnapshot.scopeRevisionId,
        reasonCodes: ["outside_scope"],
        knownAdditions: [redirectAddition],
        source: "operator_continue",
        pendingEventId: 17,
      },
      coveredDestinations: [redirectAddition],
    });
  });

  it("rejects a mismatched late event or Continue context", () => {
    const plannedSnapshot = snapshot({ actionId: "action-exact-context" });
    const active = activate(plan(plannedSnapshot));
    expect(
      recordLateWarning({
        action: active,
        runState: "running",
        snapshotVersion: 1,
        snapshotBinding: "sha256:different",
        reasonCodes: ["outside_scope"],
        addition: redirectAddition,
        pendingEventId: 4,
        engagementAutoContinue: false,
        occurredAt: defaultTime,
      }),
    ).toEqual({ ok: false, error: { code: "snapshot_binding_mismatch" } });

    const paused = lateWarning(active, redirectAddition, { pendingEventId: 4 });
    expect(
      continueLateWarning({
        action: paused,
        snapshotVersion: 1,
        snapshotBinding: plannedSnapshot.binding,
        pendingEventId: 5,
        occurredAt: defaultTime,
      }),
    ).toEqual({ ok: false, error: { code: "invalid_run_transition" } });

    expect(
      recordLateWarning({
        action: active,
        runState: "running",
        snapshotVersion: 1,
        snapshotBinding: plannedSnapshot.binding,
        reasonCodes: ["outside_scope"],
        addition: {
          hostname: "Other.Test",
          address: "192.0.2.41",
        },
        pendingEventId: 6,
        engagementAutoContinue: false,
        occurredAt: defaultTime,
      }),
    ).toEqual({
      ok: false,
      error: { code: "invalid_action_planning_input" },
    });
  });

  it("executes late Cancel as a truthful cancel request", () => {
    const testCase = warningCase("d1.warning.late-cancel-cancels");
    const paused = lateWarning(
      activate(plan(snapshot({ actionId: testCase.given.actionId }))),
      redirectAddition,
    );
    const cancelled = actionFrom(cancelAction({ action: paused }));
    expect(cancelled).toMatchObject({
      state: "active_paused_for_warning",
      runState: "cancel_requested",
      cleanupRequired: true,
      resumeRequested: false,
      warningAcknowledgment: null,
    });
    expect(
      continueLateWarning({
        action: cancelled,
        snapshotVersion: 1,
        snapshotBinding: cancelled.snapshots[0]?.binding,
        pendingEventId: 1,
        occurredAt: defaultTime,
      }),
    ).toEqual({ ok: false, error: { code: "invalid_run_transition" } });
  });

  it("executes late auto-continue without pausing", () => {
    const testCase = warningCase("d1.warning.late-auto-continue-does-not-pause");
    const addition = testCase.given.event?.destination;
    if (addition === undefined) {
      throw new Error("Late auto-continue fixture requires a destination");
    }
    const action = lateWarning(
      activate(
        plan(
          snapshot({
            actionId: testCase.given.actionId,
            binding: testCase.given.snapshotHash,
            scopeRevisionId: testCase.given.scopeRevisionId,
          }),
        ),
      ),
      addition,
      { autoContinue: true, occurredAt: testCase.given.event?.at },
    );
    expect(action).toMatchObject({
      state: "active",
      runState: "running",
      warningInteractions: 0,
      warningAcknowledgment: {
        source: "engagement_policy",
        reasonCodes: ["outside_scope"],
        knownAdditions: [addition],
        pendingEventId: 1,
      },
    });
  });

  it("appends later destinations and reasons without mutating the snapshot", () => {
    const plannedSnapshot = snapshot({
      actionId: "action-covered-late",
      reasons: ["outside_scope"],
    });
    const acknowledged = actionFrom(
      continueAction({
        action: plan(plannedSnapshot),
        snapshotVersion: 1,
        snapshotBinding: plannedSnapshot.binding,
        occurredAt: defaultTime,
      }),
    );
    const active = activate(acknowledged);
    const frozenSnapshot = structuredClone(active.snapshots[0]);
    const later = {
      origin: "https://third.test:443",
      resolvedAddress: "192.0.2.42",
    } as const;
    const updated = lateWarning(active, later, {
      reasonCodes: ["outside_scope", "risk_tier_t2"],
      pendingEventId: 2,
    });
    expect(updated.state).toBe("active");
    expect(updated.warningInteractions).toBe(1);
    expect(updated.warningAcknowledgment?.reasonCodes).toEqual([
      "outside_scope",
      "risk_tier_t2",
    ]);
    expect(updated.warningAcknowledgment?.coveredDestinations).toEqual([later]);
    expect(updated.coveredDestinations).toEqual([later]);
    expect(updated.snapshots[0]).toEqual(frozenSnapshot);
  });
});

describe("capability, retry, immutability, and adversarial boundaries", () => {
  it("keeps capability errors non-overridable", () => {
    const testCase = warningCase(
      "d1.warning.unrepresentable-expansion-is-not-overridable",
    );
    const plannedSnapshot = snapshot({ actionId: testCase.given.actionId });
    const capability = actionFrom(
      planAction({
        snapshot: plannedSnapshot,
        engagementAutoContinue: false,
        representable: false,
        capabilityErrorCode: testCase.error?.code,
        occurredAt: defaultTime,
      }),
    );
    expect(capability).toMatchObject({
      state: "capability_error",
      queuedSnapshotVersion: null,
      warningInteractions: 0,
      capabilityErrorCode: testCase.error?.code,
    });
    expect(
      continueAction({
        action: capability,
        snapshotVersion: 1,
        snapshotBinding: plannedSnapshot.binding,
        occurredAt: defaultTime,
      }),
    ).toEqual({
      ok: false,
      error: { code: "capability_error_not_overridable" },
    });
  });

  it("preserves the queued snapshot and acknowledgment for retry", () => {
    const testCase = warningCase("d1.warning.retry-reuses-action-warning-budget");
    const plannedSnapshot = snapshot({
      actionId: testCase.given.actionId,
      binding: testCase.given.snapshotHash,
      reasons: ["outside_scope"],
    });
    const acknowledged = actionFrom(
      continueAction({
        action: plan(plannedSnapshot),
        snapshotVersion: 1,
        snapshotBinding: plannedSnapshot.binding,
        occurredAt: defaultTime,
      }),
    );
    const cancelled = actionFrom(cancelAction({ action: acknowledged }));
    const callerAction = structuredClone(cancelled);
    const result = retryActionContext({
      action: callerAction,
      warningAcknowledgmentId: testCase.given.warningAcknowledgmentId,
    });
    expect(result).toMatchObject({
      ok: true,
      context: {
        actionId: testCase.given.actionId,
        snapshotBinding: testCase.given.snapshotHash,
        warningAcknowledgment: acknowledged.warningAcknowledgment,
        warningAcknowledgmentId: testCase.given.warningAcknowledgmentId,
        resolutionRefreshed: false,
        newWarningBudget: false,
      },
    });
    if (!result.ok) {
      throw new Error("Expected retry context");
    }
    expect(result.context.warningAcknowledgment).not.toBe(
      callerAction.warningAcknowledgment,
    );
    expect(Object.isFrozen(callerAction.warningAcknowledgment)).toBe(false);
  });

  it("supports the accepted planning cancellation edge", () => {
    const paused = plan(
      snapshot({
        actionId: "action-planning-cancel",
        reasons: ["outside_scope"],
      }),
    );
    const planning: ActionPlanningAggregate = {
      ...paused,
      state: "planning",
      pendingWarning: null,
      warningInteractions: 0,
    };
    expect(cancelAction({ action: planning })).toMatchObject({
      ok: true,
      action: {
        state: "cancelled",
        queuedSnapshotVersion: null,
        warningAcknowledgment: null,
      },
    });
  });

  it("freezes a cloned queued context without mutating caller input", () => {
    const fixtureCase = resolutionFixtureData.cases.find(
      ({ id }) => id === "d1.snapshot.freezes-planning-context",
    ) as FreezeSnapshotFixtureCase | undefined;
    if (fixtureCase === undefined) {
      throw new Error("Missing immutable snapshot fixture");
    }
    const input = {
      ...snapshot({ actionId: fixtureCase.given.actionId }),
      canonicalTargets: fixtureCase.given.canonicalTargets,
      typedOptions: fixtureCase.given.typedOptions,
      resolutionSnapshots: fixtureCase.given.resolutionSnapshots,
      scopeRevisionId: fixtureCase.given.scopeRevisionId,
      warningState: {
        ...fixtureCase.given.warningState,
        knownAdditions: [],
      },
    };
    const action = plan(input);
    fixtureCase.given.typedOptions.ports.push(8_080);
    expect(action.snapshots[0]?.typedOptions).toEqual({ ports: [80, 443] });
    expect(Object.isFrozen(action)).toBe(true);
    expect(Object.isFrozen(action.snapshots)).toBe(true);
    expect(Object.isFrozen(action.snapshots[0]?.typedOptions)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
  });

  it("rejects unknown untrusted input without reflection or mutation", () => {
    const sentinel = "do-not-reflect-<script>alert(1)</script>";
    const input = {
      snapshot: snapshot({ actionId: "action-untrusted" }),
      engagementAutoContinue: false,
      representable: true,
      capabilityErrorCode: null,
      occurredAt: defaultTime,
      untrustedPluginField: sentinel,
    };
    const before = structuredClone(input);
    const result = planAction(input);
    expect(result).toEqual({
      ok: false,
      error: { code: "invalid_action_planning_input" },
    });
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(input).toEqual(before);
    expect(Object.isFrozen(input)).toBe(false);
  });

  it("fails closed instead of throwing for cyclic untrusted options", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const cyclicSnapshot = {
      ...snapshot({ actionId: "action-cyclic" }),
      typedOptions: { cyclic },
    };
    expect(
      planAction({
        snapshot: cyclicSnapshot,
        engagementAutoContinue: false,
        representable: true,
        capabilityErrorCode: null,
        occurredAt: defaultTime,
      }),
    ).toEqual({
      ok: false,
      error: { code: "invalid_action_planning_input" },
    });

    const paused = structuredClone(
      plan(
        snapshot({
          actionId: "action-cyclic-aggregate",
          reasons: ["outside_scope"],
        }),
      ),
    );
    const pausedSnapshot = paused.snapshots[0];
    if (pausedSnapshot === undefined) {
      throw new Error("Expected planning snapshot");
    }
    pausedSnapshot.typedOptions = { cyclic };
    expect(
      continueAction({
        action: paused,
        snapshotVersion: 1,
        snapshotBinding: pausedSnapshot.binding,
        occurredAt: defaultTime,
      }),
    ).toEqual({
      ok: false,
      error: { code: "invalid_action_planning_input" },
    });
  });

  it("rejects a noninitial snapshot version and noncanonical target context", () => {
    expect(
      planAction({
        snapshot: snapshot({ actionId: "action-version-2", version: 2 }),
        engagementAutoContinue: false,
        representable: true,
        capabilityErrorCode: null,
        occurredAt: defaultTime,
      }),
    ).toEqual({
      ok: false,
      error: { code: "invalid_action_planning_input" },
    });

    const invalidTargetSnapshot = {
      ...snapshot({ actionId: "action-invalid-target" }),
      canonicalTargets: [
        {
          normalizationProfile: "d1-v1",
          kind: "hostname",
          hostname: "Target.Test",
        },
      ],
    };
    expect(
      planAction({
        snapshot: invalidTargetSnapshot,
        engagementAutoContinue: false,
        representable: true,
        capabilityErrorCode: null,
        occurredAt: defaultTime,
      }),
    ).toEqual({
      ok: false,
      error: { code: "invalid_action_planning_input" },
    });
  });
});


describe("applicable D2 Action state fixtures", () => {
  it("executes warning routing and late-warning Action fixtures", () => {
    const routing = d2Case("d2.state.d1-warning-and-capability-routing");
    const routingExpected = routing.expected ?? {};
    const warnedSnapshot = snapshot({
      actionId: "action-d2-routing",
      reasons: ["outside_scope"],
    });
    const preRunPaused = plan(warnedSnapshot);
    const preRunContinued = actionFrom(
      continueAction({
        action: preRunPaused,
        snapshotVersion: 1,
        snapshotBinding: warnedSnapshot.binding,
        occurredAt: defaultTime,
      }),
    );
    expect(preRunPaused.state).toBe(routingExpected["preRunWarningState"]);
    expect(preRunContinued.state).toBe(routingExpected["preRunContinuedState"]);

    const pauseFixture = d2Case("d2.state.late-warning-pauses-before-connect");
    const pauseExpected = pauseFixture.expected ?? {};
    const lateSnapshot = snapshot({
      actionId: d2String(pauseFixture.given, "actionId"),
      binding: d2String(pauseFixture.given, "snapshotDigest"),
    });
    const active = activate(plan(lateSnapshot));
    const paused = lateWarning(
      active,
      d2Addition(pauseFixture.given, "pendingDestination"),
      {
        reasonCodes: d2Reasons(pauseFixture.given, "reasonCodes"),
        pendingEventId: d2Number(pauseExpected, "pendingEventId"),
      },
    );
    expect(paused).toMatchObject({
      state: pauseExpected["actionState"],
      runState: pauseExpected["runState"],
      warningInteractions: pauseExpected["warningInteractions"],
      pendingWarning: { pendingEventId: pauseExpected["pendingEventId"] },
    });

    const continueFixture = d2Case(
      "d2.state.late-continue-binds-context-and-resumes",
    );
    const continueExpected = continueFixture.expected ?? {};
    const continueSnapshot = snapshot({
      actionId: d2String(continueFixture.given, "actionId"),
      binding: d2String(continueFixture.given, "snapshotDigest"),
      scopeRevisionId: d2String(continueFixture.given, "scopeRevisionId"),
    });
    const continuePendingId = d2Number(continueFixture.given, "pendingEventId");
    const pendingAddition = d2Addition(
      continueFixture.given,
      "pendingDestination",
    );
    const continuePaused = lateWarning(
      activate(plan(continueSnapshot)),
      pendingAddition,
      {
        reasonCodes: d2Reasons(continueFixture.given, "reasonCodes"),
        pendingEventId: continuePendingId,
      },
    );
    const resumed = actionFrom(
      continueLateWarning({
        action: continuePaused,
        snapshotVersion: 1,
        snapshotBinding: continueSnapshot.binding,
        pendingEventId: continuePendingId,
        occurredAt: defaultTime,
      }),
    );
    expect(resumed).toMatchObject({
      state: continueExpected["actionState"],
      runState: continueExpected["runState"],
      resumeRequested: true,
      warningAcknowledgment: {
        pendingEventId: continuePendingId,
        knownAdditions: [pendingAddition],
        source: "operator_continue",
      },
    });

    const autoFixture = d2Case("d2.state.late-auto-continue-never-pauses");
    const autoExpected = autoFixture.expected ?? {};
    const auto = lateWarning(
      activate(
        plan(snapshot({ actionId: d2String(autoFixture.given, "actionId") })),
      ),
      d2Addition(autoFixture.given, "pendingDestination"),
      {
        reasonCodes: d2Reasons(autoFixture.given, "reasonCodes"),
        autoContinue: true,
      },
    );
    expect(auto).toMatchObject({
      state: autoExpected["actionState"],
      runState: autoExpected["runState"],
      warningInteractions: autoExpected["warningInteractions"],
      warningAcknowledgment: {
        source: autoExpected["acknowledgmentSource"],
      },
    });

    const coveredFixture = d2Case(
      "d2.state.late-covered-destination-appends-without-pause",
    );
    const coveredExpected = coveredFixture.expected ?? {};
    const coveredSnapshot = snapshot({
      actionId: d2String(coveredFixture.given, "actionId"),
      reasons: ["outside_scope"],
    });
    const acknowledged = actionFrom(
      continueAction({
        action: plan(coveredSnapshot),
        snapshotVersion: 1,
        snapshotBinding: coveredSnapshot.binding,
        occurredAt: defaultTime,
      }),
    );
    const coveredAddition = d2Addition(
      coveredFixture.given,
      "pendingDestination",
    );
    const covered = lateWarning(activate(acknowledged), coveredAddition);
    expect(covered).toMatchObject({
      state: coveredExpected["actionState"],
      runState: coveredExpected["runState"],
      coveredDestinations: [coveredAddition],
      warningAcknowledgment: { coveredDestinations: [coveredAddition] },
    });

    const cancelFixture = d2Case("d2.state.late-cancel-awaits-cleanup");
    const cancelExpected = cancelFixture.expected ?? {};
    const cancelSnapshot = snapshot({
      actionId: d2String(cancelFixture.given, "actionId"),
    });
    const cancelPaused = lateWarning(
      activate(plan(cancelSnapshot)),
      { hostname: "other.test", address: "192.0.2.67" },
      { pendingEventId: 67 },
    );
    const cancelled = actionFrom(cancelAction({ action: cancelPaused }));
    expect(cancelled).toMatchObject({
      state: cancelExpected["actionState"],
      runState: cancelExpected["runState"],
      cleanupRequired: cancelExpected["cleanupRequired"],
      warningAcknowledgment: null,
    });

    const rejectFixture = d2Case(
      "d2.state.late-continue-after-cancel-rejected",
    );
    expect(
      continueLateWarning({
        action: cancelled,
        snapshotVersion: 1,
        snapshotBinding: cancelSnapshot.binding,
        pendingEventId: d2Number(rejectFixture.given, "pendingEventId"),
        occurredAt: defaultTime,
      }),
    ).toEqual({ ok: false, error: { code: rejectFixture.error?.code } });

    const capability = actionFrom(
      planAction({
        snapshot: snapshot({ actionId: "action-d2-capability" }),
        engagementAutoContinue: false,
        representable: false,
        capabilityErrorCode: "target_set_unrepresentable",
        occurredAt: defaultTime,
      }),
    );
    expect(capability.state).toBe(routingExpected["unrepresentableState"]);
  });

  it("executes append-only planning and retry Action fixtures", () => {
    const addFixture = d2Case("d2.state.add-scope-appends-planning-version");
    const addExpected = addFixture.expected ?? {};
    const before = snapshot({
      actionId: d2String(addFixture.given, "actionId"),
      reasons: ["outside_scope"],
    });
    const after = snapshot({
      actionId: before.actionId,
      binding: d2String(addFixture.given, "postRecheckDigest"),
      version: 2,
    });
    const appended = actionFrom(
      addScopeAndRun({
        action: plan(before),
        recheckedSnapshot: after,
        occurredAt: defaultTime,
      }),
    );
    expect(appended.snapshots.map(({ version }) => version)).toEqual(
      addExpected["versionsAfter"],
    );
    expect(appended.snapshots[0]).toEqual(before);
    expect(appended).toMatchObject({
      queuedSnapshotVersion: addExpected["queuedSnapshotVersion"],
      warningAcknowledgment: { source: addExpected["warningSource"] },
    });

    const finalFixture = d2Case("d2.state.queued-snapshot-is-final");
    const queued = appended;
    const queuedBefore = structuredClone(queued);
    expect(
      addScopeAndRun({
        action: queued,
        recheckedSnapshot: snapshot({
          actionId: queued.actionId,
          version: d2Number(finalFixture.given, "attemptedVersion"),
        }),
        occurredAt: defaultTime,
      }),
    ).toEqual({ ok: false, error: { code: finalFixture.error?.code } });
    expect(queued).toEqual(queuedBefore);

    const retryFixture = d2Case("d2.state.retry-preserves-action-identity");
    const retryExpected = retryFixture.expected ?? {};
    const retryActionId = d2String(retryFixture.given, "actionId");
    const retryFirstSnapshot = snapshot({ actionId: retryActionId });
    const retrySecondSnapshot = snapshot({
      actionId: retryActionId,
      version: d2Number(retryFixture.given, "queuedSnapshotVersion"),
    });
    const retryAction: ActionPlanningAggregate = {
      ...plan(retryFirstSnapshot),
      snapshots: [retryFirstSnapshot, retrySecondSnapshot],
      queuedSnapshotVersion: retrySecondSnapshot.version,
      state: "failed",
    };
    const retryBefore = structuredClone(retryAction);
    const retry = retryActionContext({
      action: retryAction,
      warningAcknowledgmentId: d2String(
        retryFixture.given,
        "warningAcknowledgmentId",
      ),
    });
    expect(retry).toMatchObject({
      ok: true,
      context: {
        actionId: retryExpected["actionId"],
        snapshotVersion: retryExpected["queuedSnapshotVersion"],
        warningAcknowledgmentId: retryExpected["warningAcknowledgmentId"],
        resolutionRefreshed: false,
        newWarningBudget: false,
      },
    });
    expect(retryAction).toEqual(retryBefore);

    const successfulFixture = d2Case(
      "d2.state.successful-run-retry-rejected",
    );
    const succeeded: ActionPlanningAggregate = {
      ...plan(
        snapshot({
          actionId: d2String(successfulFixture.given, "actionId"),
        }),
      ),
      state: "succeeded",
    };
    expect(
      retryActionContext({
        action: succeeded,
        warningAcknowledgmentId: null,
      }),
    ).toEqual({
      ok: false,
      error: { code: successfulFixture.error?.code },
    });
  });
});

describe("exported snapshot canonicality", () => {
  it("rejects noncanonical stored target and addition shapes", () => {
    const valid = snapshot({ actionId: "action-canonical" });
    expect(snapshotIsCanonical(valid)).toBe(true);
    expect(
      snapshotIsCanonical({
        ...valid,
        canonicalTargets: [
          {
            normalizationProfile: "d1-v1",
            kind: "hostname",
            hostname: "Target.Test",
          },
        ],
      }),
    ).toBe(false);
    expect(
      warningAdditionIsCanonical({
        hostname: "cdn.target.test",
        address: "192.0.2.50",
      }),
    ).toBe(true);
    expect(
      warningAdditionIsCanonical({
        hostname: "Target.Test",
        address: "192.0.2.41",
      }),
    ).toBe(false);
  });
});
