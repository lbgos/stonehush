import type { ActionSnapshot, NmapProjectedService, PersistedAction, RunHistorySummary, RunOutputResponse } from "@stonehush/contracts";
import { diffRuns, normalizeTarget } from "@stonehush/domain";
import { describe, expect, it } from "vitest";

import { actionBindingSummary, actionOptionsSummary, buildPriorAttempt, buildRunCompareInput, resolveRunComparison, runSideComplete, stableStringifyOptions } from "./run-compare.js";
import { priorComparisonRuns } from "./run-compare-panel.js";

const digest = `sha256:${"a".repeat(64)}`;
const run: RunHistorySummary = { id: "new", actionId: "action", state: "succeeded", terminalKind: "succeeded", terminalReason: null,
  createdAt: "2026-08-10T11:00:00.000Z", updatedAt: "2026-08-10T12:00:00.000Z", attempt: 1 };
function snapshot(target = "192.0.2.10"): ActionSnapshot {
  const normalized = normalizeTarget(target);
  if (!normalized.ok) throw new Error(normalized.error.code);
  return { normalizationProfile: "d1-v1", orchestrationProfile: "d2-v1", snapshotId: "snapshot", version: 1,
    binding: digest, actionId: "action", canonicalTargets: [normalized.target], concreteDestinations: [], typedOptions: { declaredPorts: [80, 443] },
    resolutionSnapshots: [], scopeRevisionId: null, warningState: { reasonCodes: [], knownAdditions: [], acknowledgment: null } };
}
function action(recorded = snapshot()): PersistedAction {
  return { contractVersion: 1, engagementId: "eng", revision: 1, warningAcknowledgmentId: null, createdAt: run.createdAt, updatedAt: run.updatedAt,
    action: { orchestrationProfile: "d2-v1", actionId: "action", state: "succeeded", snapshots: [recorded], queuedSnapshotVersion: 1,
      warningAcknowledgment: null, pendingWarning: null, coveredDestinations: [], warningInteractions: 0, runState: null,
      resumeRequested: false, cleanupRequired: false, capabilityErrorCode: null } };
}
function service(runId: string, port = 80): NmapProjectedService {
  return { source: "nmap", parserVersion: "nmap-xml-v1", address: "192.0.2.10", port, protocol: "tcp", hostname: null,
    serviceName: "http", product: null, version: null, runId, artifactId: `artifact-${runId}-${port}`, artifactDigest: digest, observedAt: run.updatedAt };
}
const empty = { services: [], probes: [], results: [] };
function output(): RunOutputResponse {
  return { run, stdout: { present: true, artifactId: "stdout", sizeBytes: 4, digest, completeness: "complete", truncated: false, content: "text" },
    stderr: { present: false, truncated: false, content: "" } };
}

describe("recorded comparison context", () => {
  it("uses queued target context even when observed addresses disappear", () => {
    const recorded = snapshot("192.0.2.0/24");
    const projections = { ...empty, services: [service("new"), service("old", 443)] };
    const before = resolveRunComparison({ ...run, id: "old" }, projections, action(recorded), "eng");
    const after = resolveRunComparison(run, projections, action(recorded), "eng");
    expect(before).toMatchObject({ ok: true, value: { tool: "nmap", origin: "192.0.2.0/24" } });
    expect(after).toMatchObject({ ok: true, value: { origin: "192.0.2.0/24" } });
  });
  it("refuses missing observations, ambiguous tools, and foreign action ownership", () => {
    expect(resolveRunComparison(run, empty, action(), "eng").ok).toBe(false);
    expect(resolveRunComparison(run, { ...empty, services: [service("new")] }, action(), "other").ok).toBe(false);
    expect(resolveRunComparison({ ...run, actionId: "foreign" }, { ...empty, services: [service("new")] }, action(), "eng").ok).toBe(false);
  });
  it("selects the queued snapshot, not an unrelated higher version", () => {
    const persisted = action();
    persisted.action.snapshots.push({ ...snapshot("192.0.2.11"), version: 2 });
    expect(resolveRunComparison(run, { ...empty, services: [service("new")] }, persisted, "eng"))
      .toMatchObject({ ok: true, value: { origin: "192.0.2.10" } });
    persisted.action.queuedSnapshotVersion = null;
    expect(resolveRunComparison(run, { ...empty, services: [service("new")] }, persisted, "eng").ok).toBe(false);
  });
  it("compares concrete DNS destinations while ignoring IDs, timestamp and TTL noise", () => {
    const before = snapshot("target.test");
    before.resolutionSnapshots = [{ canonicalQueryName: "target.test", resolverMode: "system", cnameChain: [],
      answers: [{ address: "192.0.2.10", family: 4, ttlSeconds: 60 }], resolvedAt: run.createdAt }];
    const equivalent = { ...before, snapshotId: "another", binding: `sha256:${"b".repeat(64)}`,
      resolutionSnapshots: before.resolutionSnapshots.map((row) => ({ ...row, resolvedAt: run.updatedAt, answers: row.answers.map((answer) => ({ ...answer, ttlSeconds: 10 })) })) };
    expect(actionBindingSummary(before)).toBe(actionBindingSummary(equivalent));
    const changed = { ...equivalent, resolutionSnapshots: equivalent.resolutionSnapshots.map((row) => ({ ...row,
      answers: row.answers.map((answer) => ({ ...answer, address: "192.0.2.11" })) })) };
    expect(actionBindingSummary(changed)).not.toBe(actionBindingSummary(before));
    expect(actionBindingSummary(changed)).toContain("192.0.2.11");
  });
  it("keeps options stable and reports the exact prior attempt", () => {
    const recorded = snapshot(); recorded.typedOptions = { threads: 40, rate: 100 };
    expect(actionOptionsSummary(recorded)).toBe(stableStringifyOptions({ rate: 100, threads: 40 }));
    expect(buildPriorAttempt({ run, optionsSummary: "recorded", conditionsChanged: true }))
      .toEqual({ runId: "new", attemptedAt: run.createdAt, outcome: "succeeded", optionsSummary: "recorded", conditionsChanged: true });
  });
});

describe("preserved output completeness", () => {
  it("requires success, exact output ownership, and at least one complete preserved stream", () => {
    expect(runSideComplete(run, output())).toBe(true);
    expect(runSideComplete(run, undefined)).toBe(false);
    expect(runSideComplete({ ...run, state: "cancelled" }, output())).toBe(false);
    expect(runSideComplete({ ...run, id: "foreign" }, output())).toBe(false);
    const absent = output(); absent.stdout = absent.stderr;
    expect(runSideComplete(run, absent)).toBe(false);
  });
  it.each(["partial", "truncated"] as const)("does not confuse %s artifact completeness with an intact preview", (completeness) => {
    const partial = output();
    if (!partial.stdout.present) throw new Error("fixture");
    partial.stdout.completeness = completeness;
    expect(runSideComplete(run, partial)).toBe(false);
  });
  it("carries truncation and stale output state into the incomplete caveat", () => {
    const truncated = output(); truncated.stdout.truncated = true;
    expect(runSideComplete(run, truncated)).toBe(false);
    const pending = output(); pending.run = { ...run, state: "running" };
    expect(runSideComplete(run, pending)).toBe(false);
  });
});

describe("exact observations and prior order", () => {
  it("shows new, changed and no longer observed services without claiming closure", () => {
    const older = { ...run, id: "old" };
    const context = { tool: "nmap", origin: "192.0.2.10", optionsSummary: "recorded", binding: "recorded" };
    const diff = diffRuns(buildRunCompareInput({ before: { run: older, context, complete: false }, after: { run, context, complete: true },
      projections: { ...empty, services: [service("old", 80), service("old", 22), { ...service("new", 80), product: "nginx" }, service("new", 443), service("foreign", 8080)] } }));
    expect(diff.newServices).toHaveLength(1);
    expect(diff.changedServices).toHaveLength(1);
    expect(diff.removedFromView).toEqual([expect.stringContaining("Not observed is not closed")]);
    expect(diff.caveats).toEqual([expect.stringContaining("incomplete")]);
  });
  it("offers only older terminal runs in admitted order, including the timestamp tie-break", () => {
    const earlier = { ...run, id: "old", createdAt: "2026-08-09T11:00:00.000Z" };
    const tie = { ...run, id: "a" };
    expect(priorComparisonRuns([{ ...run, id: "z" }, run, earlier, tie, { ...earlier, id: "pending", state: "running" }], run)).toEqual([earlier, tie]);
  });
});
