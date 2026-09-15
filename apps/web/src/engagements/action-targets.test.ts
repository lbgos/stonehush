import { PersistedActionSchema, type PersistedAction, type SavedScopeRule } from "@stonehush/contracts";
import { describe, expect, it } from "vitest";

import {
  buildAddScopeAndRunRules,
  DECLARED_PORTS_FIELD_ERROR,
  DUPLICATE_TARGETS_ERROR,
  EMPTY_TARGETS_ERROR,
  formatCanonicalTarget,
  latestActionSnapshot,
  parseDeclaredPorts,
  parsePlannedTargets,
  warningReasonCopy,
} from "./action-targets.js";
import { SCOPE_TARGET_FIELD_ERROR } from "./scope-rules.js";

const ACTION_ID = "40000000-0000-4000-8000-000000000001";
const SNAPSHOT_ID = "40000000-0000-4000-8000-000000000002";
const BINDING = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const ipv4Target = {
  kind: "ip" as const,
  normalizationProfile: "d1-v1" as const,
  family: 4 as const,
  address: "192.0.2.10",
  zone: null,
};

const ipv4Rule: SavedScopeRule = {
  id: "30000000-0000-4000-8000-000000000001",
  kind: "ip",
  target: {
    kind: "ip",
    normalizationProfile: "d1-v1",
    family: 4,
    address: "198.51.100.10",
    zone: null,
  },
};

function pausedAction(): PersistedAction {
  return PersistedActionSchema.parse({
    contractVersion: 1,
    engagementId: "10000000-0000-4000-8000-000000000001",
    revision: 1,
    warningAcknowledgmentId: null,
    createdAt: "2026-08-12T12:10:00.000Z",
    updatedAt: "2026-08-12T12:10:00.000Z",
    action: {
      orchestrationProfile: "d2-v1",
      actionId: ACTION_ID,
      state: "paused_for_warning",
      snapshots: [
        {
          normalizationProfile: "d1-v1",
          orchestrationProfile: "d2-v1",
          snapshotId: SNAPSHOT_ID,
          version: 1,
          binding: BINDING,
          actionId: ACTION_ID,
          canonicalTargets: [ipv4Target],
          concreteDestinations: [ipv4Target],
          typedOptions: { declaredPorts: null },
          resolutionSnapshots: [],
          scopeRevisionId: "20000000-0000-4000-8000-000000000010",
          warningState: {
            reasonCodes: ["outside_scope"],
            knownAdditions: [],
            acknowledgment: null,
          },
        },
      ],
      queuedSnapshotVersion: null,
      warningAcknowledgment: null,
      pendingWarning: {
        reasonCodes: ["outside_scope"],
        knownAdditions: [],
        pendingEventId: null,
      },
      coveredDestinations: [],
      warningInteractions: 0,
      runState: null,
      resumeRequested: false,
      cleanupRequired: false,
      capabilityErrorCode: null,
    },
  });
}

describe("parsePlannedTargets", () => {
  it("accepts newline and comma separated unique synthetic targets", () => {
    expect(parsePlannedTargets("192.0.2.10\n198.51.100.10, app.target.test")).toEqual({
      ok: true,
      targets: ["192.0.2.10", "198.51.100.10", "app.target.test"],
    });
  });

  it("rejects empty, duplicate, and malformed input without inventing targets", () => {
    expect(parsePlannedTargets("  \n , ")).toEqual({ ok: false, message: EMPTY_TARGETS_ERROR });
    expect(parsePlannedTargets("192.0.2.10, 192.0.2.10")).toEqual({
      ok: false,
      message: DUPLICATE_TARGETS_ERROR,
    });
    expect(parsePlannedTargets("not a target")).toEqual({
      ok: false,
      message: SCOPE_TARGET_FIELD_ERROR,
    });
  });
});

describe("warning and snapshot helpers", () => {
  it("maps reason codes and reads the latest snapshot", () => {
    expect(warningReasonCopy("outside_scope")).toContain("outside the saved scope");
    expect(formatCanonicalTarget(ipv4Target)).toBe("192.0.2.10");
    expect(latestActionSnapshot(pausedAction()).version).toBe(1);
    expect(latestActionSnapshot(pausedAction()).binding).toBe(BINDING);
  });
});

describe("buildAddScopeAndRunRules", () => {
  it("appends a drafted rule for a canonical target that is not already represented", () => {
    const rules = buildAddScopeAndRunRules([ipv4Rule], pausedAction(), ["192.0.2.10"]);
    expect(rules).toHaveLength(2);
    expect(rules[0]).toEqual(ipv4Rule);
    expect(rules[1]).toMatchObject({
      kind: "ip",
      target: ipv4Target,
    });
  });

  it("does not duplicate an already represented target", () => {
    const existing: SavedScopeRule = {
      id: "30000000-0000-4000-8000-000000000099",
      kind: "ip",
      target: ipv4Target,
    };
    expect(buildAddScopeAndRunRules([existing], pausedAction(), ["192.0.2.10"])).toEqual([existing]);
  });
});

describe("parseDeclaredPorts", () => {
  it("covers blank, normalization, empty segments, malformed tokens and bounds", () => {
    expect(parseDeclaredPorts("")).toEqual({ ok: true, declaredPorts: null });
    expect(parseDeclaredPorts("   ")).toEqual({ ok: true, declaredPorts: null });
    expect(parseDeclaredPorts("443,80,80,22")).toEqual({ ok: true, declaredPorts: [22, 80, 443] });
    expect(parseDeclaredPorts(" 443 , 22,80 ")).toEqual({ ok: true, declaredPorts: [22, 80, 443] });
    for (const input of ["80,,443", "80, 443,", ",80", "80a", "0", "65536", "-1", "80.5", "80-443"]) {
      expect(parseDeclaredPorts(input)).toEqual({ ok: false, message: DECLARED_PORTS_FIELD_ERROR });
    }
  });
});
