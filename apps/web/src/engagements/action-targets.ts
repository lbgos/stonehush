import type {
  ActionSnapshot,
  CanonicalTarget,
  PersistedAction,
  SavedScopeRule,
  WarningReasonCode,
} from "@stonehush/contracts";
import { normalizeTarget } from "@stonehush/domain";

import { createDraftScopeRule, SCOPE_TARGET_FIELD_ERROR } from "./scope-rules.js";

export const EMPTY_TARGETS_ERROR = "Enter at least one target.";
export const DUPLICATE_TARGETS_ERROR = "Duplicate targets are not allowed.";
export const DECLARED_PORTS_FIELD_ERROR =
  "Enter comma-separated ports 1-65535, for example 22,80,443.";

export type ParsedDeclaredPorts =
  | { ok: true; declaredPorts: number[] | null }
  | { ok: false; message: string };

export function parseDeclaredPorts(raw: string): ParsedDeclaredPorts {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, declaredPorts: null };
  const parts = trimmed.split(",");
  const unique = new Set<number>();
  for (const part of parts) {
    const token = part.trim();
    if (token.length === 0) return { ok: false, message: DECLARED_PORTS_FIELD_ERROR };
    if (!/^\d+$/.test(token)) return { ok: false, message: DECLARED_PORTS_FIELD_ERROR };
    const value = Number(token);
    if (!Number.isInteger(value) || value < 1 || value > 65_535)
      return { ok: false, message: DECLARED_PORTS_FIELD_ERROR };
    unique.add(value);
  }
  const ports = [...unique].sort((a, b) => a - b);
  return { ok: true, declaredPorts: ports };
}

export type ParsedPlannedTargets =
  | { ok: true; targets: string[] }
  | { ok: false; message: string };

export function parsePlannedTargets(raw: string): ParsedPlannedTargets {
  const tokens: string[] = [];
  for (const part of raw.split(/[\n,]+/)) {
    const token = part.trim();
    if (token.length === 0) continue;
    tokens.push(token);
  }

  if (tokens.length === 0) return { ok: false, message: EMPTY_TARGETS_ERROR };

  const seenRaw = new Set<string>();
  const seenCanonical = new Set<string>();
  for (const token of tokens) {
    if (seenRaw.has(token)) return { ok: false, message: DUPLICATE_TARGETS_ERROR };
    seenRaw.add(token);

    const normalized = normalizeTarget(token);
    if (!normalized.ok) return { ok: false, message: SCOPE_TARGET_FIELD_ERROR };

    const identity = formatCanonicalTarget(normalized.target);
    if (seenCanonical.has(identity)) return { ok: false, message: DUPLICATE_TARGETS_ERROR };
    seenCanonical.add(identity);
  }

  return { ok: true, targets: tokens };
}

// Canonical identities for idempotency fingerprints. Raw tokens keep user
// formatting and order, so equivalent inputs would mint different keys and a
// lost response retry could duplicate instead of replay. Sorting is safe here
// because creation intent treats the target set as unordered. Unparseable
// tokens fall back to themselves so key generation never throws.
export function canonicalTargetIdentities(targets: readonly string[]): string[] {
  const identities = targets.map((target) => {
    const normalized = normalizeTarget(target);
    return normalized.ok ? formatCanonicalTarget(normalized.target) : target;
  });
  return identities.sort();
}

export function latestActionSnapshot(action: PersistedAction): ActionSnapshot {
  return action.action.snapshots.reduce((latest, snapshot) =>
    snapshot.version > latest.version ? snapshot : latest,
  );
}

export function warningReasonCodes(action: PersistedAction): readonly WarningReasonCode[] {
  return action.action.pendingWarning?.reasonCodes ?? latestActionSnapshot(action).warningState.reasonCodes;
}

export function warningReasonSummary(reasonCodes: readonly WarningReasonCode[]): string {
  return reasonCodes.map(warningReasonCopy).join(" ");
}

export function warningReasonCopy(code: WarningReasonCode): string {
  switch (code) {
    case "outside_scope":
      return "At least one target is outside the saved scope.";
    case "large_target_set":
      return "This action covers a large target set.";
    case "risk_tier_t0":
      return "This action is labelled T0.";
    case "risk_tier_t1":
      return "This action is labelled T1.";
    case "risk_tier_t2":
      return "This action is labelled T2.";
    case "risk_tier_t3":
      return "This action is labelled T3.";
    case "risk_tier_t4":
      return "This action is labelled T4.";
  }
}

export function formatCanonicalTarget(target: CanonicalTarget): string {
  switch (target.kind) {
    case "ip":
      return target.zone === null ? target.address : `${target.address}%${target.zone}`;
    case "cidr":
      return `${target.network}/${String(target.prefixLength)}`;
    case "hostname":
      return target.hostname;
    case "url":
      return target.url;
  }
}

export function capabilityErrorCopy(
  code: NonNullable<PersistedAction["action"]["capabilityErrorCode"]>,
): string {
  switch (code) {
    case "required_resolution_unavailable":
      return "Required DNS resolution is unavailable. This is not a warning and cannot be continued.";
    case "target_set_unrepresentable":
      return "The requested target set cannot be represented. This is not a warning and cannot be continued.";
    case "capability_error":
      return "This action cannot run. Continue is not available.";
  }
}

function ruleIdentity(rule: SavedScopeRule): string {
  switch (rule.kind) {
    case "ip":
      return `ip:${formatCanonicalTarget(rule.target)}:${formatPortIdentity(rule.portRanges)}`;
    case "cidr":
      return `cidr:${formatCanonicalTarget(rule.target)}:${formatPortIdentity(rule.portRanges)}`;
    case "domain":
      return `domain:${rule.target.hostname}:${String(rule.includeSubdomains)}:${formatPortIdentity(rule.portRanges)}`;
    case "url-origin":
      return `url-origin:${formatUrlOriginIdentity(rule)}:${formatPortIdentity(rule.portRanges)}`;
  }
}

function formatPortIdentity(ranges: SavedScopeRule["portRanges"]): string {
  if (ranges === undefined) return "";
  return ranges.map((range) => `${String(range.from)}-${String(range.to)}`).join(",");
}

function formatUrlOriginIdentity(rule: Extract<SavedScopeRule, { kind: "url-origin" }>): string {
  if ("hostname" in rule.origin.host) {
    return `${rule.origin.scheme}:${rule.origin.host.hostname}:${String(rule.origin.effectivePort)}`;
  }
  const zone = "zone" in rule.origin.host ? rule.origin.host.zone : null;
  return `${rule.origin.scheme}:${rule.origin.host.address}%${zone ?? ""}:${String(rule.origin.effectivePort)}`;
}

function draftRulesFromRawTargets(rawTargets: readonly string[]): SavedScopeRule[] | undefined {
  const rules: SavedScopeRule[] = [];
  for (const rawTarget of rawTargets) {
    const drafted = createDraftScopeRule({
      includeSubdomains: false,
      portRanges: "",
      rawTarget,
    });
    if (!drafted.ok) return undefined;
    rules.push(drafted.rule);
  }
  return rules;
}

export function buildAddScopeAndRunRules(
  activeRules: readonly SavedScopeRule[],
  action: PersistedAction,
  rawTargets: readonly string[],
): SavedScopeRule[] {
  const fromCanonical: SavedScopeRule[] = [];
  let ambiguous = false;
  for (const target of latestActionSnapshot(action).canonicalTargets) {
    const drafted = createDraftScopeRule({
      includeSubdomains: false,
      portRanges: "",
      rawTarget: formatCanonicalTarget(target),
    });
    if (!drafted.ok) {
      ambiguous = true;
      break;
    }
    fromCanonical.push(drafted.rule);
  }

  const drafted = ambiguous ? draftRulesFromRawTargets(rawTargets) : fromCanonical;
  const additions = drafted ?? [];
  const existing = new Set(activeRules.map(ruleIdentity));
  return [...activeRules, ...additions.filter((rule) => !existing.has(ruleIdentity(rule)))];
}
