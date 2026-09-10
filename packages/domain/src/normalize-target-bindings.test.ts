import { describe, expect, it } from "vitest";

import {
  currentBindingForActions,
  describeComparability,
  findAutoMergeCandidates,
  planAddressChange,
  type StoneBindingRecord,
} from "./normalize-target-bindings.js";

function binding(overrides: Partial<StoneBindingRecord> = {}): StoneBindingRecord {
  return {
    id: "binding-1",
    addressText: "10.0.0.5",
    bindingKind: "ip",
    status: "current",
    createdAt: "2026-08-12T12:00:00.000Z",
    supersededAt: null,
    ...overrides,
  };
}

describe("normalize-target bindings", () => {
  it("retires the current binding and preserves history on address change", () => {
    const plan = planAddressChange([binding()], { newAddressText: "10.0.0.9" });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.addressText).toBe("10.0.0.9");
    expect(plan.retiredBindingId).toBe("binding-1");
  });

  it("keeps old snapshots comparable only under the old binding", () => {
    expect(
      describeComparability(
        { addressText: "10.0.0.5", bindingKind: "ip" },
        { addressText: "10.0.0.9", bindingKind: "ip" },
      ),
    ).toEqual({ comparable: false, reason: "binding_changed" });
    expect(
      describeComparability(
        { addressText: "10.0.0.9", bindingKind: "ip" },
        { addressText: "10.0.0.9", bindingKind: "ip" },
      ).comparable,
    ).toBe(true);
  });

  it("routes fresh attempts through the current binding only", () => {
    const bindings = [
      binding({ id: "old", addressText: "10.0.0.5", status: "historical" }),
      binding({ id: "new", addressText: "10.0.0.9", status: "current" }),
    ];
    expect(currentBindingForActions(bindings)?.id).toBe("new");
  });

  it("never auto-merges machines by reused IP", () => {
    const probe = findAutoMergeCandidates(["target-a", "target-b"], "10.0.0.5");
    expect(probe.candidates).toEqual([]);
    expect(probe.reason).toBe("ip_reuse_never_merges");
  });

  it("rejects unchanged, invalid, and non-binding addresses", () => {
    expect(planAddressChange([binding()], { newAddressText: "10.0.0.5" })).toEqual({
      ok: false,
      error: { code: "address_unchanged" },
    });
    expect(planAddressChange([binding()], { newAddressText: "not a target!!!" })).toEqual({
      ok: false,
      error: { code: "invalid_target" },
    });
    expect(planAddressChange([binding()], { newAddressText: "10.0.0.0/24" })).toEqual({
      ok: false,
      error: { code: "invalid_target" },
    });
    expect(
      planAddressChange([binding()], { newAddressText: "https://app.internal:443/" }),
    ).toEqual({ ok: false, error: { code: "invalid_target" } });
  });
});
