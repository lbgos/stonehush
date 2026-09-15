import {
  canonicalizeJson,
  CreateActionRequestSchema,
  DeclaredPortsSchema,
  FfufDiscoveryOptionsSchema,
  type ActionSnapshot,
  type CanonicalCidrTarget,
  type CanonicalIpTarget,
  type CanonicalTarget,
  type SavedScopeRule,
  type WarningContextAddition,
  type WarningReasonCode,
} from "@stonehush/contracts";
import {
  compareSavedScope,
  estimateConcreteTargetCardinality,
  normalizeTarget,
} from "@stonehush/domain";

import { bindActionSnapshot } from "./action-snapshot.js";
import {
  type ActionRepositoryError,
  type RepositoryResult,
} from "./repository.js";

type OperatorResult<T> = RepositoryResult<T, ActionRepositoryError>;

function failed<T>(error: ActionRepositoryError): OperatorResult<T> {
  return { ok: false, error };
}

export function declaredPortsFromTypedOptions(
  options: unknown,
): number[] | null {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    return null;
  }
  const parsed = DeclaredPortsSchema.safeParse(
    (options as { declaredPorts?: unknown }).declaredPorts,
  );
  return parsed.success ? parsed.data : null;
}

/**
 * Informational risk tier for a planned snapshot's typed options.
 * ffuf discovery is T2: one concise pre-run warning unless the engagement
 * auto-continues. Nmap (T1) and HTTP probing carry no tier warning.
 */
export function riskTierReasonsForTypedOptions(
  options: unknown,
): WarningReasonCode[] {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    return [];
  }
  const parsed = FfufDiscoveryOptionsSchema.safeParse(
    (options as { ffuf?: unknown }).ffuf,
  );
  return parsed.success ? ["risk_tier_t2"] : [];
}

function targetIdentity(target: CanonicalTarget): OperatorResult<string> {
  const canonical = canonicalizeJson(target);
  return canonical.ok
    ? { ok: true, value: canonical.canonicalJson }
    : failed({ code: "invalid_repository_input" });
}

function concreteIpFromTarget(target: CanonicalTarget): CanonicalIpTarget | null {
  if (target.kind === "ip") {
    return target;
  }
  if (target.kind !== "url" || "hostname" in target.host) {
    return null;
  }
  if (target.host.address.includes(":")) {
    return {
      kind: "ip",
      normalizationProfile: target.normalizationProfile,
      family: 6,
      address: target.host.address,
      zone: target.host.zone,
    };
  }
  return {
    kind: "ip",
    normalizationProfile: target.normalizationProfile,
    family: 4,
    address: target.host.address,
    zone: null,
  };
}

function concreteIpIdentity(target: CanonicalIpTarget): string {
  return `${target.family}:${target.address}%${target.zone ?? ""}`;
}

function concreteCardinalityTargets(
  targets: readonly CanonicalTarget[],
): Array<CanonicalIpTarget | CanonicalCidrTarget> {
  const concrete: Array<CanonicalIpTarget | CanonicalCidrTarget> = [];
  for (const target of targets) {
    if (target.kind === "cidr") {
      concrete.push(target);
      continue;
    }
    const ip = concreteIpFromTarget(target);
    if (ip !== null) concrete.push(ip);
  }
  return concrete;
}

function uniqueConcreteDestinations(
  targets: readonly CanonicalTarget[],
): CanonicalIpTarget[] {
  const destinations: CanonicalIpTarget[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    const ip = concreteIpFromTarget(target);
    if (ip === null) continue;
    const identity = concreteIpIdentity(ip);
    if (seen.has(identity)) continue;
    seen.add(identity);
    destinations.push(ip);
  }
  return destinations;
}

export function normalizeOperatorTargets(
  rawTargets: readonly string[],
): OperatorResult<CanonicalTarget[]> {
  const targets: CanonicalTarget[] = [];
  const seen = new Set<string>();
  for (const raw of rawTargets) {
    const normalized = normalizeTarget(raw);
    if (!normalized.ok) return failed({ code: "invalid_repository_input" });
    const identity = targetIdentity(normalized.target);
    if (!identity.ok) return identity;
    if (seen.has(identity.value)) {
      return failed({ code: "invalid_repository_input" });
    }
    seen.add(identity.value);
    targets.push(normalized.target);
  }
  return { ok: true, value: targets };
}

export function derivePlanningWarningState(input: {
  actionId: string;
  scopeRevisionId: string | null;
  rules: readonly SavedScopeRule[];
  targets: readonly CanonicalTarget[];
  declaredPorts: number[] | null;
}): OperatorResult<{
  reasonCodes: WarningReasonCode[];
  knownAdditions: WarningContextAddition[];
}> {
  const comparison = compareSavedScope({
    currentActionId: input.actionId,
    scopeRevisionId: input.scopeRevisionId,
    rules: [...input.rules],
    subjects: input.targets.map((target) => ({
      target,
      declaredPorts: input.declaredPorts,
      provenance: { kind: "direct" as const },
    })),
  });
  if (!comparison.ok) return failed({ code: "invalid_repository_input" });

  const reasonCodes: WarningReasonCode[] = [];
  const knownAdditions: WarningContextAddition[] = [];
  if (comparison.comparison.outsideScope) {
    reasonCodes.push("outside_scope");
  }

  const cardinality = estimateConcreteTargetCardinality({
    targets: concreteCardinalityTargets(input.targets),
  });
  if (cardinality.largeTargetWarning) {
    reasonCodes.push("large_target_set");
    knownAdditions.push({ estimatedConcreteTargets: 4_097 });
  }

  return { ok: true, value: { reasonCodes, knownAdditions } };
}

export function bindPlannedSnapshot(input: {
  actionId: string;
  snapshotId: string;
  version: number;
  scopeRevisionId: string | null;
  targets: readonly CanonicalTarget[];
  typedOptions: ActionSnapshot["typedOptions"];
  resolutionSnapshots: ActionSnapshot["resolutionSnapshots"];
  warningState: {
    reasonCodes: WarningReasonCode[];
    knownAdditions: WarningContextAddition[];
  };
}): OperatorResult<ActionSnapshot> {
  const snapshot: ActionSnapshot = {
    normalizationProfile: "d1-v1",
    orchestrationProfile: "d2-v1",
    snapshotId: input.snapshotId,
    version: input.version,
    binding: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    actionId: input.actionId,
    canonicalTargets: [...input.targets],
    concreteDestinations: uniqueConcreteDestinations(input.targets),
    typedOptions: input.typedOptions,
    resolutionSnapshots: [...input.resolutionSnapshots],
    scopeRevisionId: input.scopeRevisionId,
    warningState: {
      reasonCodes: [...input.warningState.reasonCodes],
      knownAdditions: [...input.warningState.knownAdditions],
      acknowledgment: null,
    },
  };
  const bound = bindActionSnapshot(snapshot);
  if (!bound.ok) return failed({ code: "invalid_repository_input" });
  return { ok: true, value: { ...snapshot, binding: bound.binding } };
}

export function parseCreateActionRequest(
  input: unknown,
): OperatorResult<ReturnType<typeof CreateActionRequestSchema.parse>> {
  const parsed = CreateActionRequestSchema.safeParse(input);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : failed({ code: "invalid_repository_input" });
}
