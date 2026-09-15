import {
  SavedScopeComparisonInputSchema,
  SavedScopeRuleSchema,
  type CanonicalCidrTarget,
  type CanonicalIpTarget,
  type CanonicalTarget,
  type CanonicalUrlHost,
  type CanonicalUrlTarget,
  type ConcreteTargetCardinalityInput,
  type ExecutionCapabilityInput,
  type ExecutionCapabilityResult,
  type PortRangeNormalizationResult,
  type SavedScopeComparisonInput,
  type SavedScopeComparisonResult,
  type SavedScopeRule,
  type SaturatedCardinality,
  type ScopeComparisonReasonCode,
  type ScopeComparisonSubject,
  type ScopeDomainError,
  type ScopePortRange,
  type ScopePortRangeInput,
  type ScopeRuleNormalizationResult,
  type ScopeSubjectComparisonFact,
} from "@stonehush/contracts";

import { normalizeTarget } from "./normalize-target.js";

const MINIMUM_PORT = 1;
const MAXIMUM_PORT = 65_535;
const CARDINALITY_WARNING_THRESHOLD = 4_096n;
const CARDINALITY_SENTINEL = CARDINALITY_WARNING_THRESHOLD + 1n;

function invalidPortRange(
  range: ScopePortRangeInput,
): ScopeDomainError | null {
  for (const port of [range.from, range.to]) {
    if (!Number.isInteger(port)) {
      return Number.isFinite(port)
        ? { code: "invalid_port_range", port }
        : { code: "invalid_port_range" };
    }
    if (port < MINIMUM_PORT) {
      return {
        code: "invalid_port_range",
        port,
        minimumPort: MINIMUM_PORT,
      };
    }
    if (port > MAXIMUM_PORT) {
      return {
        code: "invalid_port_range",
        port,
        maximumPort: MAXIMUM_PORT,
      };
    }
  }

  return range.from > range.to
    ? { code: "invalid_port_range", from: range.from, to: range.to }
    : null;
}

export function normalizeScopePortRanges(
  ranges: readonly ScopePortRangeInput[],
): PortRangeNormalizationResult {
  const normalized: ScopePortRange[] = [];
  for (const range of ranges) {
    const error = invalidPortRange(range);
    if (error !== null) {
      return { ok: false, error };
    }
    normalized.push({ from: range.from, to: range.to });
  }

  normalized.sort((left, right) => left.from - right.from || left.to - right.to);
  const merged: ScopePortRange[] = [];
  for (const range of normalized) {
    const previous = merged.at(-1);
    if (previous === undefined || range.from > previous.to + 1) {
      merged.push({ ...range });
    } else {
      previous.to = Math.max(previous.to, range.to);
    }
  }

  return { ok: true, ranges: merged };
}

function portRangesFromUnknown(rule: unknown): unknown {
  if (typeof rule !== "object" || rule === null) {
    return undefined;
  }
  return (rule as { portRanges?: unknown }).portRanges;
}

export function normalizeScopeRules(
  rules: readonly SavedScopeRule[],
): ScopeRuleNormalizationResult {
  const ids = new Set<string>();
  const normalized: SavedScopeRule[] = [];

  for (const candidate of rules as readonly unknown[]) {
    const rawPortRanges = portRangesFromUnknown(candidate);
    if (Array.isArray(rawPortRanges) && rawPortRanges.length === 0) {
      return { ok: false, error: { code: "empty_port_restriction" } };
    }

    const parsed = SavedScopeRuleSchema.safeParse(candidate);
    if (!parsed.success) {
      return { ok: false, error: { code: "invalid_scope_input" } };
    }
    if (ids.has(parsed.data.id)) {
      return { ok: false, error: { code: "duplicate_scope_rule_id" } };
    }
    ids.add(parsed.data.id);

    if (parsed.data.portRanges === undefined) {
      normalized.push(parsed.data);
      continue;
    }

    const rangeResult = normalizeScopePortRanges(parsed.data.portRanges);
    if (!rangeResult.ok) {
      return rangeResult;
    }
    normalized.push({ ...parsed.data, portRanges: rangeResult.ranges });
  }

  return { ok: true, rules: normalized };
}

function hostEquals(left: CanonicalUrlHost, right: CanonicalUrlHost): boolean {
  if ("hostname" in left || "hostname" in right) {
    return (
      "hostname" in left && "hostname" in right && left.hostname === right.hostname
    );
  }
  return left.address === right.address && left.zone === right.zone;
}

function canonicalUrlIsCoherent(target: CanonicalUrlTarget): boolean {
  const normalized = normalizeTarget(target.url);
  return (
    normalized.ok &&
    normalized.target.kind === "url" &&
    normalized.target.normalizationProfile === target.normalizationProfile &&
    normalized.target.url === target.url &&
    normalized.target.origin === target.origin &&
    hostEquals(normalized.target.host, target.host) &&
    normalized.target.effectivePort === target.effectivePort &&
    normalized.target.pathAndQuery === target.pathAndQuery
  );
}

function ipv4ToBigInt(address: string): bigint {
  return address
    .split(".")
    .reduce((value, component) => (value << 8n) | BigInt(component), 0n);
}

function ipv6ToBigInt(address: string): bigint {
  const halves = address.split("::");
  const left = (halves[0] ?? "")
    .split(":")
    .filter(Boolean)
    .map((word) => BigInt(`0x${word}`));
  const right = (halves[1] ?? "")
    .split(":")
    .filter(Boolean)
    .map((word) => BigInt(`0x${word}`));
  const words =
    halves.length === 1
      ? left
      : [...left, ...Array<bigint>(8 - left.length - right.length).fill(0n), ...right];

  return words.reduce((value, word) => (value << 16n) | word, 0n);
}

function addressToBigInt(target: CanonicalIpTarget): bigint {
  return target.family === 4
    ? ipv4ToBigInt(target.address)
    : ipv6ToBigInt(target.address);
}

function addressBits(target: CanonicalIpTarget | CanonicalCidrTarget): number {
  return target.family === 4 ? 32 : 128;
}

function ipFromTarget(target: CanonicalTarget): CanonicalIpTarget | null {
  if (target.kind === "ip") {
    return target;
  }
  if (target.kind !== "url" || "hostname" in target.host) {
    return null;
  }
  return {
    normalizationProfile: target.normalizationProfile,
    kind: "ip",
    family: target.host.address.includes(":") ? 6 : 4,
    address: target.host.address,
    zone: target.host.zone,
  } as CanonicalIpTarget;
}

function cidrContainsIp(
  cidr: CanonicalCidrTarget,
  ip: CanonicalIpTarget,
): boolean {
  if (cidr.family !== ip.family) {
    return false;
  }
  const bits = addressBits(cidr);
  const shift = BigInt(bits - cidr.prefixLength);
  const network = cidr.family === 4 ? ipv4ToBigInt(cidr.network) : ipv6ToBigInt(cidr.network);
  return (addressToBigInt(ip) >> shift) === (network >> shift);
}

function cidrContainsCidr(
  outer: CanonicalCidrTarget,
  inner: CanonicalCidrTarget,
): boolean {
  if (outer.family !== inner.family || outer.prefixLength > inner.prefixLength) {
    return false;
  }
  const bits = addressBits(outer);
  const shift = BigInt(bits - outer.prefixLength);
  const outerNetwork = outer.family === 4
    ? ipv4ToBigInt(outer.network)
    : ipv6ToBigInt(outer.network);
  const innerNetwork = inner.family === 4
    ? ipv4ToBigInt(inner.network)
    : ipv6ToBigInt(inner.network);
  return (outerNetwork >> shift) === (innerNetwork >> shift);
}

function hostnameFromSubject(subject: ScopeComparisonSubject): string | null {
  if (subject.target.kind === "hostname") {
    return subject.target.hostname;
  }
  if (subject.target.kind === "url" && "hostname" in subject.target.host) {
    return subject.target.host.hostname;
  }
  if (subject.provenance.kind === "hostname_resolution") {
    return subject.provenance.sourceHostname.hostname;
  }
  return null;
}

function domainMatches(
  hostname: string,
  ruleHostname: string,
  includeSubdomains: boolean,
): boolean {
  return (
    hostname === ruleHostname ||
    (includeSubdomains && hostname.endsWith(`.${ruleHostname}`))
  );
}

function hostPredicateMatches(
  rule: SavedScopeRule,
  subject: ScopeComparisonSubject,
): boolean {
  if (rule.kind === "ip") {
    const ip = ipFromTarget(subject.target);
    return (
      ip !== null &&
      ip.family === rule.target.family &&
      ip.address === rule.target.address &&
      ip.zone === rule.target.zone
    );
  }
  if (rule.kind === "cidr") {
    if (subject.target.kind === "cidr") {
      return cidrContainsCidr(rule.target, subject.target);
    }
    const ip = ipFromTarget(subject.target);
    return ip !== null && cidrContainsIp(rule.target, ip);
  }
  if (rule.kind === "domain") {
    const hostname = hostnameFromSubject(subject);
    return (
      hostname !== null &&
      domainMatches(hostname, rule.target.hostname, rule.includeSubdomains)
    );
  }
  if (subject.target.kind !== "url") {
    return false;
  }
  const scheme = subject.target.origin.startsWith("https://") ? "https" : "http";
  return (
    scheme === rule.origin.scheme &&
    hostEquals(subject.target.host, rule.origin.host) &&
    subject.target.effectivePort === rule.origin.effectivePort
  );
}

function uncoveredPorts(
  ports: readonly number[] | null,
  ranges: readonly ScopePortRange[] | undefined,
): number[] | null {
  if (ranges === undefined) {
    return [];
  }
  if (ports === null) {
    return null;
  }
  return ports.filter(
    (port) => !ranges.some((range) => range.from <= port && port <= range.to),
  );
}

function outsideReason(
  subject: ScopeComparisonSubject,
  rules: readonly SavedScopeRule[],
  sawUnspecifiedPorts: boolean,
  bestUncoveredPorts: readonly number[] | null,
): ScopeComparisonReasonCode {
  if (rules.length === 0) {
    return "active_scope_empty";
  }
  if (sawUnspecifiedPorts) {
    return "ports_unspecified";
  }
  if (bestUncoveredPorts !== null) {
    return "ports_uncovered";
  }
  if (subject.provenance.kind === "redirect") {
    return "redirect_origin_outside_scope";
  }
  if (subject.target.kind === "url" && rules.some((rule) => rule.kind === "url-origin")) {
    return "origin_mismatch";
  }
  if (subject.target.kind === "ip" && subject.provenance.kind === "direct") {
    return "no_exact_ip_rule";
  }
  return "host_outside_scope";
}

function compareSubject(
  subject: ScopeComparisonSubject,
  rules: readonly SavedScopeRule[],
): ScopeSubjectComparisonFact {
  const matchedRuleIds: string[] = [];
  let sawUnspecifiedPorts = false;
  let bestUncoveredPorts: number[] | null = null;

  for (const rule of rules) {
    if (!hostPredicateMatches(rule, subject)) {
      continue;
    }
    const uncovered = uncoveredPorts(subject.declaredPorts, rule.portRanges);
    if (uncovered === null) {
      sawUnspecifiedPorts = true;
      continue;
    }
    if (uncovered.length === 0) {
      matchedRuleIds.push(rule.id);
      continue;
    }
    if (
      bestUncoveredPorts === null ||
      uncovered.length < bestUncoveredPorts.length
    ) {
      bestUncoveredPorts = uncovered;
    }
  }

  const outsideScope = matchedRuleIds.length === 0;
  return {
    subject,
    outsideScope,
    matchedRuleIds,
    reason: outsideScope
      ? outsideReason(subject, rules, sawUnspecifiedPorts, bestUncoveredPorts)
      : null,
    uncoveredPorts: bestUncoveredPorts ?? [],
  };
}

function recognizableComparisonError(input: unknown): ScopeDomainError | null {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const candidate = input as {
    currentActionId?: unknown;
    scopeRevisionId?: unknown;
    rules?: unknown;
    subjects?: unknown;
  };
  if (
    candidate.scopeRevisionId === null &&
    Array.isArray(candidate.rules) &&
    candidate.rules.length > 0
  ) {
    return { code: "invalid_scope_revision" };
  }
  if (Array.isArray(candidate.rules)) {
    const ids = new Set<string>();
    for (const rule of candidate.rules) {
      const id =
        typeof rule === "object" && rule !== null
          ? (rule as { id?: unknown }).id
          : undefined;
      if (typeof id === "string" && ids.has(id)) {
        return { code: "duplicate_scope_rule_id" };
      }
      if (typeof id === "string") {
        ids.add(id);
      }
      const ranges = portRangesFromUnknown(rule);
      if (Array.isArray(ranges) && ranges.length === 0) {
        return { code: "empty_port_restriction" };
      }
    }
  }
  if (typeof candidate.currentActionId === "string" && Array.isArray(candidate.subjects)) {
    for (const subject of candidate.subjects) {
      const provenance =
        typeof subject === "object" && subject !== null
          ? (subject as { provenance?: unknown }).provenance
          : undefined;
      if (typeof provenance !== "object" || provenance === null) {
        continue;
      }
      const value = provenance as { kind?: unknown; actionId?: unknown };
      if (
        value.kind !== "direct" &&
        typeof value.actionId === "string" &&
        value.actionId !== candidate.currentActionId
      ) {
        return { code: "invalid_current_action_provenance" };
      }
    }
  }
  return null;
}

export function compareSavedScope(
  input: SavedScopeComparisonInput,
): SavedScopeComparisonResult {
  const recognizedError = recognizableComparisonError(input);
  if (recognizedError !== null) {
    return { ok: false, error: recognizedError };
  }
  const parsed = SavedScopeComparisonInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "invalid_scope_input" } };
  }
  if (
    parsed.data.subjects.some(
      (subject) =>
        subject.target.kind === "url" &&
        !canonicalUrlIsCoherent(subject.target),
    )
  ) {
    return { ok: false, error: { code: "invalid_scope_input" } };
  }
  const normalizedRules = normalizeScopeRules(parsed.data.rules);
  if (!normalizedRules.ok) {
    return normalizedRules;
  }

  const subjectFacts =
    parsed.data.scopeRevisionId === null
      ? parsed.data.subjects.map((subject) => ({
          subject,
          outsideScope: false,
          matchedRuleIds: [],
          reason: null,
          uncoveredPorts: [],
        }))
      : parsed.data.subjects.map((subject) =>
          compareSubject(subject, normalizedRules.rules),
        );
  const matched = new Set(subjectFacts.flatMap((fact) => fact.matchedRuleIds));
  const reasons = new Set(
    subjectFacts.flatMap((fact) => (fact.reason === null ? [] : [fact.reason])),
  );

  return {
    ok: true,
    comparison: {
      scopeRevisionId: parsed.data.scopeRevisionId,
      outsideScope: subjectFacts.some((fact) => fact.outsideScope),
      matchedRuleIds: normalizedRules.rules
        .map((rule) => rule.id)
        .filter((id) => matched.has(id)),
      outsideSubjects: subjectFacts
        .filter((fact) => fact.outsideScope)
        .map((fact) => fact.subject),
      subjectFacts,
      reasonCodes: [...reasons],
    },
  };
}

interface AddressInterval {
  family: 4 | 6;
  from: bigint;
  to: bigint;
}

function cidrInterval(target: CanonicalCidrTarget): AddressInterval {
  const bits = addressBits(target);
  const from = target.family === 4
    ? ipv4ToBigInt(target.network)
    : ipv6ToBigInt(target.network);
  return {
    family: target.family,
    from,
    to: from + (1n << BigInt(bits - target.prefixLength)) - 1n,
  };
}

export function estimateConcreteTargetCardinality(
  input: ConcreteTargetCardinalityInput,
): SaturatedCardinality {
  const intervals = input.targets
    .filter((target): target is CanonicalCidrTarget => target.kind === "cidr")
    .map(cidrInterval)
    .sort((left, right) => {
      if (left.family !== right.family) {
        return left.family - right.family;
      }
      if (left.from !== right.from) {
        return left.from < right.from ? -1 : 1;
      }
      return left.to === right.to ? 0 : left.to < right.to ? -1 : 1;
    });

  const merged: AddressInterval[] = [];
  for (const interval of intervals) {
    const current = merged.at(-1);
    if (
      current !== undefined &&
      current.family === interval.family &&
      interval.from <= current.to + 1n
    ) {
      current.to = current.to > interval.to ? current.to : interval.to;
      continue;
    }
    merged.push({ ...interval });
  }

  let count = 0n;
  for (const interval of merged) {
    count += interval.to - interval.from + 1n;
    if (count >= CARDINALITY_SENTINEL) {
      return {
        estimatedConcreteTargets: 4_097,
        countSaturated: true,
        largeTargetWarning: true,
      };
    }
  }

  const exactIdentities = new Set<string>();
  for (const target of input.targets) {
    if (target.kind !== "ip") {
      continue;
    }
    const address = addressToBigInt(target);
    const coveredByCidr = merged.some(
      (interval) =>
        interval.family === target.family &&
        interval.from <= address &&
        address <= interval.to,
    );
    if (coveredByCidr) {
      continue;
    }
    const identity = `${target.family}:${target.address}%${target.zone ?? ""}`;
    if (exactIdentities.has(identity)) {
      continue;
    }
    exactIdentities.add(identity);
    count += 1n;
    if (count >= CARDINALITY_SENTINEL) {
      return {
        estimatedConcreteTargets: 4_097,
        countSaturated: true,
        largeTargetWarning: true,
      };
    }
  }

  return {
    estimatedConcreteTargets: Number(count),
    countSaturated: false,
    largeTargetWarning: false,
  };
}

export function selectExecutionRepresentation(
  capability: ExecutionCapabilityInput,
): ExecutionCapabilityResult {
  if (capability.supportsCompactRange) {
    return { ok: true, executionRepresentation: "compact" };
  }
  if (capability.supportsStreamingExpansion) {
    return { ok: true, executionRepresentation: "streamed_expansion" };
  }
  return { ok: false, error: { code: "capability_error" } };
}
