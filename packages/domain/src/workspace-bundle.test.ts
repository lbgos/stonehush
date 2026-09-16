import { describe, expect, it } from "vitest";

import {
  checkWorkspaceBundleBounds,
  planIdRemap,
  remapStoredRefs,
  summarizeWorkspaceBundle,
} from "./workspace-bundle.js";

function emptyBundle(privateCopy = false) {
  return {
    privateCopy,
    leads: [],
    attempts: [],
    excerpts: [],
    attachments: [],
    findings: [],
    evidence: [],
    secrets: [],
    objectives: [],
  };
}

describe("workspace bundle rules", () => {
  it("summarizes record counts", () => {
    const summary = summarizeWorkspaceBundle({
      ...emptyBundle(true),
      leads: [{ id: "a" }, { id: "b" }] as never,
      evidence: [{ sizeBytes: 1 }] as never,
    });
    expect(summary.leads).toBe(2);
    expect(summary.evidence).toBe(1);
    expect(summary.privateCopy).toBe(true);
  });

  it("accepts an empty bundle within bounds", () => {
    expect(checkWorkspaceBundleBounds(emptyBundle()).ok).toBe(true);
  });

  it("refuses oversized evidence totals before decoding bytes", () => {
    const result = checkWorkspaceBundleBounds({
      ...emptyBundle(),
      evidence: [{ sizeBytes: 16 * 1024 * 1024 + 1 }] as never,
    });
    expect(result).toEqual({ ok: false, code: "bundle_too_large" });
  });

  it("plans a one-to-one id remap", () => {
    const remap = planIdRemap(["old-1", "old-2"], ["new-1", "new-2"]);
    expect(remap?.get("old-1")).toBe("new-1");
    expect(remap?.get("old-2")).toBe("new-2");
  });

  it("fails the remap closed on length or duplicate mismatch", () => {
    expect(planIdRemap(["old-1"], ["new-1", "new-2"])).toBeUndefined();
    expect(planIdRemap(["old-1", "old-1"], ["new-1", "new-2"])).toBeUndefined();
  });

  it("rewrites known refs and keeps unknown ones", () => {
    const remap = new Map([["old-1", "new-1"]]);
    expect(remapStoredRefs(["old-1", "outside"], remap)).toEqual([
      "new-1",
      "outside",
    ]);
  });
});
