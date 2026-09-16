import { describe, expect, it } from "vitest";

import { accessRevisitReason, parkedForLackOfAccess } from "./access.js";

describe("access revisit rules", () => {
  it("recognizes leads parked for lack of access", () => {
    expect(parkedForLackOfAccess("Needs credentials I do not have", null)).toBe(true);
    expect(
      parkedForLackOfAccess("Dead end for now", "Only checked without authentication"),
    ).toBe(true);
    expect(parkedForLackOfAccess("Got 403 on every path", null)).toBe(true);
  });

  it("ignores parked leads with unrelated reasons", () => {
    expect(parkedForLackOfAccess("Waiting on a slower scan", "Timing out often")).toBe(false);
    expect(parkedForLackOfAccess(null, null)).toBe(false);
  });

  it("cites the new access without secret material and without reopening language", () => {
    const reason = accessRevisitReason({ accessType: "ssh", account: "deploy" });
    expect(reason).toContain("Recorded SSH access");
    expect(reason).toContain("deploy");
    expect(reason).not.toMatch(/reopen/i);
    expect(reason).not.toMatch(/will work|guaranteed|live shell/i);
    expect(reason.length).toBeLessThanOrEqual(300);
  });

  it("never mentions secret references or values", () => {
    const reason = accessRevisitReason({ accessType: "database", account: "app" });
    expect(reason).not.toMatch(/secret|password|flag\{/i);
  });
});
