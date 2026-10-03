// @vitest-environment jsdom

import type { RunOutputResponse } from "@stonehush/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResumeRunRow, useRememberedRun } from "./resume-run.js";
import { runOutputQueryKey } from "./run-output-query.js";
import { emptyWorkspaceState, loadWorkspaceState, parseWorkspaceState, saveWorkspaceState, workspaceStateKey, type WorkspaceStateStore } from "./workspace-state.js";

const ENGAGEMENT = "10000000-0000-4000-8000-000000000001";
const OTHER = "10000000-0000-4000-8000-000000000002";
const TS = "2026-10-03T10:00:00.000Z";
const LEAD = "20000000-0000-4000-8000-000000000001";
function output(id = "run-old", state: RunOutputResponse["run"]["state"] = "succeeded"): RunOutputResponse {
  return {
    run: { id, actionId: "action-old", state, terminalKind: state === "succeeded" || state === "failed" || state === "cancelled" ? state : null, terminalReason: null, updatedAt: TS },
    stdout: { present: false, truncated: false, content: "" },
    stderr: { present: false, truncated: false, content: "" },
  };
}
function response(body: unknown, status = 200) {
  return { status, json: async () => body } as Response;
}
function memoryStore() {
  const values = new Map<string, string>();
  const store: WorkspaceStateStore = {
    load: key => values.get(key) ?? null,
    save: (key, value) => { values.set(key, value); },
  };
  return store;
}
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  vi.unstubAllGlobals();
});
function renderRow(runId = "run-old", onForget = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  const onOpen = vi.fn();
  render(<QueryClientProvider client={client}><section data-resume-band="" tabIndex={-1}><ResumeRunRow engagementId={ENGAGEMENT} runId={runId} onOpen={onOpen} onForget={onForget} /></section></QueryClientProvider>);
  return { client, onOpen, onForget };
}

describe("remembered terminal run", () => {
  it("merges only the matching validated run id and preserves existing lead/state", () => {
    const store = memoryStore();
    saveWorkspaceState(store, ENGAGEMENT, { ...emptyWorkspaceState(), lastLeadId: LEAD, selectedTarget: "192.0.2.10", inspectorSelection: "service-1", launcherInputs: { ports: "80" }, drafts: { notes: "saved draft" }, filters: { runs: "failed" }, starredIds: ["star-1"], lastWordlistName: "words.txt" });
    const { result } = renderHook(() => useRememberedRun(ENGAGEMENT, store));
    act(() => result.current.remember({ engagementId: ENGAGEMENT, requestedRunId: "run-old", run: output().run }));
    expect(result.current.runId).toBe("run-old");
    const saved = loadWorkspaceState(store, ENGAGEMENT);
    expect(saved.lastLeadId).toBe(LEAD);
    expect(saved).toMatchObject({ selectedTarget: "192.0.2.10", inspectorSelection: "service-1", launcherInputs: { ports: "80" }, drafts: { notes: "saved draft" }, filters: { runs: "failed" }, starredIds: ["star-1"], lastWordlistName: "words.txt" });
    expect(store.load(workspaceStateKey(ENGAGEMENT))).not.toContain("stdout");
    act(() => result.current.forget(ENGAGEMENT, "run-old"));
    expect(result.current.runId).toBeNull();
    expect(loadWorkspaceState(store, ENGAGEMENT)).toEqual({ ...saved, selectedRunId: null, updatedAt: expect.any(String) });
  });

  it("isolates engagements and rejects nonterminal, mismatched and late foreign reads", () => {
    const store = memoryStore();
    const { result, rerender } = renderHook(({ id }) => useRememberedRun(id, store), { initialProps: { id: ENGAGEMENT } });
    const rememberA = result.current.remember;
    for (const state of ["queued", "leased", "running", "cancel_requested"] as const) {
      act(() => result.current.remember({ engagementId: ENGAGEMENT, requestedRunId: "run-old", run: output("run-old", state).run }));
    }
    act(() => result.current.remember({ engagementId: ENGAGEMENT, requestedRunId: "run-other", run: output().run }));
    expect(result.current.runId).toBeNull();
    act(() => result.current.remember({ engagementId: ENGAGEMENT, requestedRunId: "run-old", run: output().run }));
    rerender({ id: OTHER });
    act(() => rememberA({ engagementId: ENGAGEMENT, requestedRunId: "late-a", run: output("late-a").run }));
    expect(result.current.runId).toBeNull();
    expect(loadWorkspaceState(store, ENGAGEMENT).selectedRunId).toBe("run-old");
    act(() => result.current.remember({ engagementId: OTHER, requestedRunId: "run-b", run: output("run-b", "failed").run }));
    rerender({ id: ENGAGEMENT });
    expect(result.current.runId).toBe("run-old");
    expect(loadWorkspaceState(store, OTHER).selectedRunId).toBe("run-b");
  });

  it("does not claim persistence when storage denies reads or writes", () => {
    const denied: WorkspaceStateStore = { load: () => { throw new Error("denied"); }, save: () => { throw new Error("quota"); } };
    const { result } = renderHook(() => useRememberedRun(ENGAGEMENT, denied));
    act(() => result.current.remember({ engagementId: ENGAGEMENT, requestedRunId: "run-old", run: output().run }));
    expect(result.current.runId).toBeNull();
  });

  it("keeps the prior pointer when writes fail, including Forget", () => {
    const memory = memoryStore();
    saveWorkspaceState(memory, ENGAGEMENT, { ...emptyWorkspaceState(), selectedRunId: "run-old", lastLeadId: LEAD });
    const store: WorkspaceStateStore = { load: memory.load, save: () => { throw new Error("quota"); } };
    const { result } = renderHook(() => useRememberedRun(ENGAGEMENT, store));
    act(() => result.current.remember({ engagementId: ENGAGEMENT, requestedRunId: "run-new", run: output("run-new").run }));
    act(() => result.current.forget(ENGAGEMENT, "run-old"));
    expect(result.current.runId).toBe("run-old");
    expect(loadWorkspaceState(memory, ENGAGEMENT).lastLeadId).toBe(LEAD);
  });

  it("validates existing opaque run ids without requiring UUIDs", () => {
    expect(parseWorkspaceState(JSON.stringify({ version: 1, selectedRunId: "run-old" })).selectedRunId).toBe("run-old");
    for (const value of ["", "a".repeat(256), 3, null]) {
      expect(parseWorkspaceState(JSON.stringify({ version: 1, selectedRunId: value })).selectedRunId).toBeNull();
    }
  });
});

describe("Resume run row", () => {
  it("freshly reads the exact run and opens only that id, with no latest fallback", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => response(output()));
    vi.stubGlobal("fetch", fetchMock);
    const { onOpen } = renderRow();
    fireEvent.click(await screen.findByRole("button", { name: "Open run run-old, succeeded" }));
    expect(onOpen).toHaveBeenCalledWith("run-old");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`/api/v1/engagements/${ENGAGEMENT}/runs/run-old/output`);
  });

  it("keeps a transient failure and retries the exact saved pointer", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response({ code: "storage_busy" }, 503)).mockResolvedValueOnce(response(output()));
    vi.stubGlobal("fetch", fetchMock);
    const { onForget } = renderRow();
    expect(await screen.findByText("Run not loaded.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Forget" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Open run run-old, succeeded" })).toBeTruthy();
    expect(onForget).not.toHaveBeenCalled();
  });

  it("offers Forget and restores band focus after confirmed missing, even with cached data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ code: "run_not_found" }, 404)));
    const { client, onForget } = renderRow();
    client.setQueryData(runOutputQueryKey(ENGAGEMENT, "run-old"), output());
    const forget = await screen.findByRole("button", { name: "Forget" });
    expect(screen.queryByRole("button", { name: "Open run run-old, succeeded" })).toBeNull();
    fireEvent.click(forget);
    expect(onForget).toHaveBeenCalledWith("run-old");
    expect(document.activeElement?.hasAttribute("data-resume-band")).toBe(true);
  });

  it.each([output("foreign-run"), output("run-old", "running")])("withholds a mismatched or nonterminal response", async payload => {
    vi.stubGlobal("fetch", vi.fn(async () => response(payload)));
    const { onOpen } = renderRow();
    await screen.findByText("Run not loaded.");
    expect(screen.queryByRole("button", { name: /Open run/ })).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("refreshes a cached read on mount and labels transient stale data", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response(output())).mockResolvedValueOnce(response({ code: "storage_busy" }, 503));
    vi.stubGlobal("fetch", fetchMock);
    const { client } = renderRow();
    await screen.findByRole("button", { name: "Open run run-old, succeeded" });
    await act(() => client.refetchQueries({ queryKey: runOutputQueryKey(ENGAGEMENT, "run-old") }));
    expect(await screen.findByText("Refresh failed.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open run run-old, succeeded" })).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
