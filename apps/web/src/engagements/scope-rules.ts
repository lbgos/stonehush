import type {
  CanonicalUrlOrigin,
  CanonicalUrlTarget,
  SavedScopeRule,
  ScopePortRange,
  ScopePortRangeInput,
} from "@stonehush/contracts";
import { normalizeScopePortRanges, normalizeTarget } from "@stonehush/domain";

import { createBrowserUuid } from "../lib/browser-uuid.js";

export const SCOPE_TARGET_FIELD_ERROR =
  "Enter a valid IP, CIDR, hostname, or HTTP(S) URL.";
export const SCOPE_PORT_FIELD_ERROR =
  "Enter ports as numbers or inclusive ranges, for example 80 or 8000-8100.";

export interface DraftScopeRuleInput {
  includeSubdomains: boolean;
  portRanges: string;
  rawTarget: string;
}

export type DraftScopeRuleResult =
  | { ok: true; rule: SavedScopeRule }
  | { ok: false; field: "portRanges" | "rawTarget"; message: string };

export function createDraftScopeRule(
  input: DraftScopeRuleInput,
  createId: () => string = createBrowserUuid,
): DraftScopeRuleResult {
  if (input.rawTarget.trim().length === 0) {
    return { ok: false, field: "rawTarget", message: SCOPE_TARGET_FIELD_ERROR };
  }

  const normalized = normalizeTarget(input.rawTarget);
  if (!normalized.ok) {
    return { ok: false, field: "rawTarget", message: SCOPE_TARGET_FIELD_ERROR };
  }

  const ports = parseOptionalPortRanges(input.portRanges);
  if (!ports.ok) return ports;

  const id = createId();
  const target = normalized.target;

  switch (target.kind) {
    case "ip":
      return { ok: true, rule: scopeRule({ id, kind: "ip", target }, ports.ranges) };
    case "cidr":
      return { ok: true, rule: scopeRule({ id, kind: "cidr", target }, ports.ranges) };
    case "hostname":
      return {
        ok: true,
        rule: scopeRule(
          { id, kind: "domain", target, includeSubdomains: input.includeSubdomains },
          ports.ranges,
        ),
      };
    case "url": {
      const scheme = schemeFromUrlTarget(target);
      if (scheme === undefined) {
        return { ok: false, field: "rawTarget", message: SCOPE_TARGET_FIELD_ERROR };
      }
      return {
        ok: true,
        rule: scopeRule(
          {
            id,
            kind: "url-origin",
            origin: {
              scheme,
              host: target.host,
              effectivePort: target.effectivePort,
            },
          },
          ports.ranges,
        ),
      };
    }
  }
}

export function parseOptionalPortRanges(
  value: string,
):
  | { ok: true; ranges: ScopePortRange[] | undefined }
  | { ok: false; field: "portRanges"; message: string } {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: true, ranges: undefined };

  const inputs: ScopePortRangeInput[] = [];
  for (const part of trimmed.split(",")) {
    const token = part.trim();
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(token);
    if (match === null || match[1] === undefined) {
      return { ok: false, field: "portRanges", message: SCOPE_PORT_FIELD_ERROR };
    }
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    inputs.push({ from, to });
  }

  const normalized = normalizeScopePortRanges(inputs);
  if (!normalized.ok) {
    return { ok: false, field: "portRanges", message: SCOPE_PORT_FIELD_ERROR };
  }
  return { ok: true, ranges: normalized.ranges };
}

export function formatScopeRuleTarget(rule: SavedScopeRule): string {
  switch (rule.kind) {
    case "ip":
      return formatIpAddress(rule.target.address, rule.target.zone);
    case "cidr":
      return `${rule.target.network}/${String(rule.target.prefixLength)}`;
    case "domain":
      return rule.target.hostname;
    case "url-origin":
      return formatUrlOrigin(rule.origin);
  }
}

export function formatScopePortRanges(
  ranges: readonly ScopePortRange[] | undefined,
): string | undefined {
  if (ranges === undefined) return undefined;
  return ranges
    .map((range) =>
      range.from === range.to ? String(range.from) : `${String(range.from)}-${String(range.to)}`,
    )
    .join(", ");
}

export function scopeRuleKindLabel(kind: SavedScopeRule["kind"]): string {
  switch (kind) {
    case "ip":
      return "IP";
    case "cidr":
      return "CIDR";
    case "domain":
      return "Domain";
    case "url-origin":
      return "URL origin";
  }
}

function scopeRule(rule: SavedScopeRule, portRanges: ScopePortRange[] | undefined): SavedScopeRule {
  return portRanges === undefined ? rule : { ...rule, portRanges };
}

function schemeFromUrlTarget(target: CanonicalUrlTarget): "http" | "https" | undefined {
  if (target.origin.startsWith("https:")) return "https";
  if (target.origin.startsWith("http:")) return "http";
  return undefined;
}

function formatIpAddress(address: string, zone: string | null): string {
  return zone === null ? address : `${address}%${zone}`;
}

function formatUrlOrigin(origin: CanonicalUrlOrigin): string {
  if ("hostname" in origin.host) {
    return `${origin.scheme}://${origin.host.hostname}:${String(origin.effectivePort)}`;
  }
  const address =
    origin.host.zone === null ? origin.host.address : `${origin.host.address}%${origin.host.zone}`;
  const host = address.includes(":") ? `[${address}]` : address;
  return `${origin.scheme}://${host}:${String(origin.effectivePort)}`;
}
