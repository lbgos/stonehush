import { normalizeTarget } from "./normalize-target.js";

export interface StoneBindingRecord {
  readonly id: string;
  readonly addressText: string;
  readonly bindingKind: "ip" | "hostname";
  readonly status: "current" | "historical";
  readonly createdAt: string;
  readonly supersededAt: string | null;
}

export type PlanAddressChangeErrorCode =
  | "invalid_target"
  | "address_unchanged";

export type PlanAddressChangeResult =
  | {
      ok: true;
      bindingKind: "ip" | "hostname";
      addressText: string;
      retiredBindingId: string | null;
    }
  | { ok: false; error: { code: PlanAddressChangeErrorCode } };

function bindingKindForNormalized(kind: string): "ip" | "hostname" {
  return kind === "hostname" ? "hostname" : "ip";
}

function displayForNormalized(target: {
  kind: string;
  address?: string;
  zone?: string | null;
  hostname?: string;
  url?: string;
}): string {
  if (target.kind === "hostname") return target.hostname ?? "";
  if (target.kind === "url") return target.url ?? "";
  const zone = target.zone ?? null;
  return zone === null ? (target.address ?? "") : `${target.address ?? ""}%${zone}`;
}

// Change a target address: the current binding becomes historical with a
// superseded timestamp while history rows are preserved untouched. Future
// actions resolve through currentBindingForActions only, so fresh attempts
// never carry old conclusions as current facts.
export function planAddressChange(
  current: readonly StoneBindingRecord[],
  input: { newAddressText: string },
): PlanAddressChangeResult {
  const trimmed = input.newAddressText.trim();
  const normalized = normalizeTarget(trimmed);
  if (!normalized.ok) return { ok: false, error: { code: "invalid_target" } };
  const target = normalized.target;
  if (target.kind === "cidr") return { ok: false, error: { code: "invalid_target" } };
  const addressText = displayForNormalized(target);
  const bindingKind = bindingKindForNormalized(target.kind);
  const active = current.find((binding) => binding.status === "current") ?? null;
  if (
    active !== null &&
    active.addressText === addressText &&
    active.bindingKind === bindingKind
  ) {
    return { ok: false, error: { code: "address_unchanged" } };
  }
  return {
    ok: true,
    bindingKind,
    addressText,
    retiredBindingId: active?.id ?? null,
  };
}

// Only the current binding is actionable. Historical bindings stay visible
// for provenance but are never returned as the action target.
export function currentBindingForActions(
  bindings: readonly StoneBindingRecord[],
): StoneBindingRecord | null {
  return bindings.find((binding) => binding.status === "current") ?? null;
}

export interface BindingComparability {
  readonly comparable: boolean;
  readonly reason: "same_binding" | "binding_changed";
}

// Comparability metadata: observations recorded under a historical binding
// stay comparable only with the same normalized binding.
export function describeComparability(
  recorded: Pick<StoneBindingRecord, "addressText" | "bindingKind">,
  current: Pick<StoneBindingRecord, "addressText" | "bindingKind">,
): BindingComparability {
  if (
    recorded.addressText === current.addressText &&
    recorded.bindingKind === current.bindingKind
  ) {
    return { comparable: true, reason: "same_binding" };
  }
  return { comparable: false, reason: "binding_changed" };
}

export interface AutoMergeProbe {
  readonly candidates: readonly string[];
  readonly reason: "ip_reuse_never_merges";
}

// Machines never auto-merge by reused IP. Target identity is the target row,
// never the address string, so a reset or reassigned address cannot fuse two
// machines. This probe always returns zero candidates by rule.
export function findAutoMergeCandidates(
  _targetIds: readonly string[],
  _candidateAddressText: string,
): AutoMergeProbe {
  return { candidates: [], reason: "ip_reuse_never_merges" };
}
