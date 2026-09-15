import {
  CanonicalTargetSchema,
  NmapTcpConnectOptionsSchema,
  type CanonicalTarget,
} from "@stonehush/contracts";

import { normalizeTarget } from "./normalize-target.js";
import { normalizeScopePortRanges } from "./saved-scope.js";

/**
 * Build deterministic Nmap TCP connect argv.
 * Order exactly: -sT, optional -sV, -Tn, optional -Pn, --version-intensity,
 * --max-retries, generated -p, generated -oX <xmlPath>, then canonical targets.
 * No shell, each argv element is a literal string.
 * URL targets are nmap_capability_unsupported for this bounded slice.
 */

export type BuildNmapArgvResult =
  | { ok: true; argv: string[] }
  | { ok: false; error: { code: "invalid_nmap_action_contract" | "nmap_capability_unsupported" } };

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") && !value.includes("\0");
}

function hasPathTraversal(value: string): boolean {
  return value.includes("..") && value.split("/").includes("..");
}

function formatNmapPorts(ranges: readonly { from: number; to: number }[]): string {
  return ranges
    .map((r) => (r.from === r.to ? String(r.from) : `${r.from}-${r.to}`))
    .join(",");
}

function serializeTarget(target: CanonicalTarget): string | null {
  try {
    switch (target.kind) {
      case "ip":
        return target.zone === null ? target.address : `${target.address}%${target.zone}`;
      case "cidr":
        return `${target.network}/${target.prefixLength}`;
      case "hostname":
        return target.hostname;
      case "url":
        return null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function serializeForNormalize(target: CanonicalTarget): string | null {
  switch (target.kind) {
    case "ip":
      return target.zone === null ? target.address : `${target.address}%${target.zone}`;
    case "cidr":
      return `${target.network}/${target.prefixLength}`;
    case "hostname":
      return target.hostname;
    case "url":
      return null;
    default:
      return null;
  }
}

export function buildNmapArgv(input: unknown): BuildNmapArgvResult {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return { ok: false, error: { code: "invalid_nmap_action_contract" } };
    }
    const record = input as Record<string, unknown>;
    const optionsParse = NmapTcpConnectOptionsSchema.safeParse(record.options);
    if (!optionsParse.success) {
      return { ok: false, error: { code: "invalid_nmap_action_contract" } };
    }
    const options = optionsParse.data;

    const rawTargets = record.canonicalTargets;
    if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
      return { ok: false, error: { code: "invalid_nmap_action_contract" } };
    }
    const canonicalTargets: CanonicalTarget[] = [];
    for (const candidate of rawTargets) {
      const parsedTarget = CanonicalTargetSchema.safeParse(candidate);
      if (!parsedTarget.success) {
        return { ok: false, error: { code: "invalid_nmap_action_contract" } };
      }
      canonicalTargets.push(parsedTarget.data);
    }

    const xmlPath = record.xmlPath;
    if (typeof xmlPath !== "string" || xmlPath.length < 1 || xmlPath.length > 1024) {
      return { ok: false, error: { code: "invalid_nmap_action_contract" } };
    }
    if (!isAbsolutePath(xmlPath) || hasPathTraversal(xmlPath)) {
      return { ok: false, error: { code: "invalid_nmap_action_contract" } };
    }
    if (xmlPath.includes("\0")) {
      return { ok: false, error: { code: "invalid_nmap_action_contract" } };
    }

    // URL targets are not valid Nmap target syntax for this slice
    // Semantic D1 canonicality: every non-URL candidate must round-trip through normalizeTarget identically
    for (const t of canonicalTargets) {
      if (t.kind === "url") {
        return { ok: false, error: { code: "nmap_capability_unsupported" } };
      }
      const serialized = serializeForNormalize(t);
      if (serialized === null) {
        return { ok: false, error: { code: "invalid_nmap_action_contract" } };
      }
      let normalized: ReturnType<typeof normalizeTarget>;
      try {
        normalized = normalizeTarget(serialized);
      } catch {
        return { ok: false, error: { code: "invalid_nmap_action_contract" } };
      }
      if (!normalized.ok) {
        return { ok: false, error: { code: "invalid_nmap_action_contract" } };
      }
      if (t.kind === "ip") {
        if (
          normalized.target.kind !== "ip" ||
          normalized.target.family !== t.family ||
          normalized.target.address !== t.address ||
          normalized.target.zone !== t.zone
        ) {
          return { ok: false, error: { code: "invalid_nmap_action_contract" } };
        }
      } else if (t.kind === "cidr") {
        if (
          normalized.target.kind !== "cidr" ||
          normalized.target.family !== t.family ||
          normalized.target.network !== t.network ||
          normalized.target.prefixLength !== t.prefixLength
        ) {
          return { ok: false, error: { code: "invalid_nmap_action_contract" } };
        }
        // hostBitsMasked is snapshot metadata; do not require equality
      } else if (t.kind === "hostname") {
        if (normalized.target.kind !== "hostname" || normalized.target.hostname !== t.hostname) {
          return { ok: false, error: { code: "invalid_nmap_action_contract" } };
        }
      }
    }

    const argv: string[] = [];

    argv.push("-sT");
    if (options.serviceDetection) argv.push("-sV");
    argv.push(`-${options.timingTemplate}`);
    if (options.skipHostDiscovery) argv.push("-Pn");
    argv.push("--version-intensity", String(options.versionIntensity));
    argv.push("--max-retries", String(options.maxRetries));

    if (options.ports !== undefined && options.ports.length > 0) {
      const normalized = normalizeScopePortRanges(options.ports);
      if (!normalized.ok) {
        return { ok: false, error: { code: "invalid_nmap_action_contract" } };
      }
      if (normalized.ranges.length > 0) {
        argv.push("-p", formatNmapPorts(normalized.ranges));
      }
    }

    argv.push("-oX", xmlPath);

    for (const target of canonicalTargets) {
      const serialized = serializeTarget(target);
      if (serialized === null || serialized.length === 0 || serialized.length > 4096 || serialized.includes("\0")) {
        return { ok: false, error: { code: "invalid_nmap_action_contract" } };
      }
      argv.push(serialized);
    }

    for (const arg of argv) {
      if (arg.includes("\0")) {
        return { ok: false, error: { code: "invalid_nmap_action_contract" } };
      }
    }

    return { ok: true, argv };
  } catch {
    return { ok: false, error: { code: "invalid_nmap_action_contract" } };
  }
}
