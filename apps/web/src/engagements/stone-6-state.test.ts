// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useWorkspaceState } from "./workspace-state.js";

import {
  emptyWorkspaceState,
  loadWorkspaceState,
  parseWorkspaceState,
  saveWorkspaceState,
  workspaceStateKey,
  type WorkspaceStateStore,
} from "./workspace-state.js";
import {
  registeredStone6Slots,
  mountStone6Slot,
  registerStone6Slot,
  unmountStone6Slot,
  STONE_6_SLOT_NAMES,
} from "./extension-slots.js";

function memoryStore(initial: Record<string, string> = {}): WorkspaceStateStore {
  const data = new Map(Object.entries(initial));
  return {
    load: (key) => data.get(key) ?? null,
    save: (key, value) => {
      data.set(key, value);
    },
  };
}

const ENGAGEMENT_ID = "10000000-0000-4000-8000-000000000001";

describe("workspace state reload restores the narrowed view", () => {
  it("round-trips selection, drafts, filters, and starred ids", () => {
    const store = memoryStore();
    saveWorkspaceState(store, ENGAGEMENT_ID, {
      ...emptyWorkspaceState(),
      selectedTarget: "https://target.example/",
      selectedRunId: "run-3",
      inspectorSelection: "artifact:abc",
      launcherInputs: { threads: "40" },
      drafts: { notes: "draft text" },
      filters: { runs: "failed" },
      starredIds: ["target-1"],
      lastWordlistName: "common",
    });
    // Simulate a browser close and return: reload from the same store.
    const restored = loadWorkspaceState(store, ENGAGEMENT_ID);
    expect(restored.selectedTarget).toBe("https://target.example/");
    expect(restored.selectedRunId).toBe("run-3");
    expect(restored.drafts["notes"]).toBe("draft text");
    expect(restored.filters["runs"]).toBe("failed");
    expect(restored.starredIds).toEqual(["target-1"]);
    expect(restored.lastWordlistName).toBe("common");
  });

  it("resets corrupt or version-mismatched payloads instead of crashing", () => {
    expect(parseWorkspaceState("not-json").selectedTarget).toBe(null);
    expect(parseWorkspaceState(JSON.stringify({ version: 999 })).filters).toEqual({});
    expect(parseWorkspaceState(null).starredIds).toEqual([]);
    expect(workspaceStateKey(ENGAGEMENT_ID)).toContain(ENGAGEMENT_ID);
  });
});

describe("useWorkspaceState engagement switching", () => {
  it("reloads per engagement without a remount instead of leaking state", () => {
    const store = memoryStore();
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useWorkspaceState(id, store),
      { initialProps: { id: "eng-a" } },
    );
    act(() => {
      result.current.update({ selectedTarget: "https://a.example/" });
    });
    expect(result.current.state.selectedTarget).toBe("https://a.example/");

    // Host switches engagement on the same mounted component.
    rerender({ id: "eng-b" });
    expect(result.current.state.selectedTarget).toBe(null);

    act(() => {
      result.current.update({ selectedTarget: "https://b.example/" });
    });
    rerender({ id: "eng-a" });
    expect(result.current.state.selectedTarget).toBe("https://a.example/");
  });
});

describe("extension slots", () => {
  it("exposes the STONE-2 integration contract and reports absent hosts", () => {
    expect(STONE_6_SLOT_NAMES).toContain("engagement.resume");
    expect(STONE_6_SLOT_NAMES).toContain("engagement.search");
    const host = document.createElement("div");
    expect(mountStone6Slot("engagement.resume", { engagementId: ENGAGEMENT_ID, archived: false }, host)).toBe(false);
    const cleanup = vi.fn();
    registerStone6Slot("engagement.resume", () => cleanup);
    expect(registeredStone6Slots()).toContain("engagement.resume");
    expect(mountStone6Slot("engagement.resume", { engagementId: ENGAGEMENT_ID, archived: false }, host)).toBe(true);
    unmountStone6Slot("engagement.resume");
    expect(cleanup).toHaveBeenCalledTimes(1);
    // Second unmount is a safe no-op.
    unmountStone6Slot("engagement.resume");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("runs duplicate cleanup identities once per mount", () => {
    const host = document.createElement("div");
    const cleanup = vi.fn();
    registerStone6Slot("engagement.search", () => cleanup);
    expect(mountStone6Slot("engagement.search", { engagementId: ENGAGEMENT_ID, archived: false }, host)).toBe(true);
    expect(mountStone6Slot("engagement.search", { engagementId: ENGAGEMENT_ID, archived: false }, host)).toBe(true);
    unmountStone6Slot("engagement.search");
    expect(cleanup).toHaveBeenCalledTimes(2);
  });
});
