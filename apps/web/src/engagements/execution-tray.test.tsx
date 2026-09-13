// @vitest-environment jsdom
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { EngagementWorkspaceProvider } from "./workspace-context.js";
import { RunHistoryPanel } from "./run-history-panel.js";
import { ExecutionTray, splitHeldBackIds } from "./workspace-tabs.js";

const ENGAGEMENT_ID = "eng-1";

function response(payload: unknown, status = 200): Response {
  return {
    json: async () => payload,
    ok: status >= 200 && status < 300,
    status,
  } as Response;
}

function runSummary(id: string, createdAt: string, state = "succeeded") {
  return {
    id,
    actionId: "action-1",
    state,
    terminalKind:
      state === "succeeded" ? "succeeded" : state === "failed" ? "failed" : state === "cancelled" ? "cancelled" : null,
    terminalReason: null,
    updatedAt: createdAt,
    createdAt,
    attempt: 1,
  };
}

const testQueryClients = new Set<QueryClient>();

function renderTray(onOpenRun: (runId: string) => void = () => undefined) {
  const queryClient = createAppQueryClient();
  testQueryClients.add(queryClient);
  return render(
    <QueryClientProvider client={queryClient}>
      <ExecutionTray engagementId={ENGAGEMENT_ID} onOpenRun={onOpenRun} />
    </QueryClientProvider>,
  );
}

function renderPanel(selectedRunId: string | undefined) {
  const queryClient = createAppQueryClient();
  testQueryClients.add(queryClient);
  const onSelect = vi.fn();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <EngagementWorkspaceProvider openCreate={() => undefined}>
        <RunHistoryPanel
          engagementId={ENGAGEMENT_ID}
          selectedRunId={selectedRunId}
          onSelect={onSelect}
        />
      </EngagementWorkspaceProvider>
    </QueryClientProvider>,
  );
  return { ...view, onSelect };
}

async function advancePanelTimers(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await act(async () => {});
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  for (const client of testQueryClients) client.clear();
  testQueryClients.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("splitHeldBackIds", () => {
  it("shows everything before a baseline exists", () => {
    expect(splitHeldBackIds(["a", "b"], undefined, undefined)).toEqual({
      heldBackCount: 0,
      visibleIds: ["a", "b"],
    });
  });

  it("holds back new arrivals while pinning the selection", () => {
    expect(splitHeldBackIds(["new", "a", "b"], ["a", "b"], "new")).toEqual({
      heldBackCount: 0,
      visibleIds: ["new", "a", "b"],
    });
    expect(splitHeldBackIds(["new", "a", "b"], ["a", "b"], "a")).toEqual({
      heldBackCount: 1,
      visibleIds: ["a", "b"],
    });
    expect(splitHeldBackIds(["a"], ["a", "b"], undefined)).toEqual({
      heldBackCount: 0,
      visibleIds: ["a"],
    });
  });
});

describe("execution tray", () => {
  it("stays quiet with no work and opens runs explicitly", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/runs?")) return response({ runs: [], nextCursor: null });
      return response({ code: "invalid_request" }, 400);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderTray();
    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    });
    expect(container.querySelector('section[aria-label="Execution tray"]')).toBeNull();
  });

  it("lists active work and routes through an explicit open action", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/runs?")) {
        return response({
          runs: [runSummary("run-1", "2026-08-10T12:00:00.000Z", "running")],
          nextCursor: null,
        });
      }
      return response({ code: "invalid_request" }, 400);
    });
    vi.stubGlobal("fetch", fetchMock);
    const onOpenRun = vi.fn();
    renderTray(onOpenRun);

    expect(await screen.findByText(/1 active/)).toBeTruthy();
    expect(screen.queryByText(/finished/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /run-1/ }));
    expect(onOpenRun).toHaveBeenCalledWith("run-1");
    // The tray never fetches preserved output by itself.
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/output"))).toBe(false);
  });

  it("announces background completion quietly without stealing focus", async () => {
    vi.useFakeTimers();
    try {
      let historyCalls = 0;
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/runs?")) {
          historyCalls += 1;
          const state = historyCalls < 2 ? "running" : "succeeded";
          return response({
            runs: [runSummary("run-1", "2026-08-10T12:00:00.000Z", state)],
            nextCursor: null,
          });
        }
        return response({ code: "invalid_request" }, 400);
      });
      vi.stubGlobal("fetch", fetchMock);
      renderTray();
      await advancePanelTimers(0);
      expect(screen.getByText(/1 active/)).toBeTruthy();

      const focused = document.activeElement;
      await advancePanelTimers(3_000);
      expect(screen.getByText(/1 finished/)).toBeTruthy();
      expect(document.activeElement).toBe(focused);
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the newest finished run when several complete", async () => {
    vi.useFakeTimers();
    try {
      let historyCalls = 0;
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/runs?")) {
          historyCalls += 1;
          if (historyCalls === 1) {
            return response({
              runs: [runSummary("run-1", "2026-08-10T12:00:00.000Z", "running")],
              nextCursor: null,
            });
          }
          return response({
            runs: [
              runSummary("run-new", "2026-08-10T12:01:00.000Z"),
              runSummary("run-old", "2026-08-10T12:00:00.000Z"),
            ],
            nextCursor: null,
          });
        }
        return response({ code: "invalid_request" }, 400);
      });
      vi.stubGlobal("fetch", fetchMock);
      renderTray();
      await advancePanelTimers(0);
      expect(screen.getByText(/1 active/)).toBeTruthy();

      await advancePanelTimers(3_000);
      expect(screen.getByText(/2 finished/)).toBeTruthy();
      expect(screen.getByTitle("run-new")).toBeTruthy();
      expect(screen.queryByTitle("run-old")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("run history stable order", () => {
  it("holds back new arrivals behind Show new results", async () => {
    vi.useFakeTimers();
    try {
      let historyCalls = 0;
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/runs?")) {
          historyCalls += 1;
          if (historyCalls === 1) {
            return response({
              runs: [runSummary("run-1", "2026-08-10T12:00:00.000Z", "running")],
              nextCursor: null,
            });
          }
          return response({
            runs: [
              runSummary("run-new", "2026-08-10T12:01:00.000Z"),
              runSummary("run-1", "2026-08-10T12:00:00.000Z", "running"),
            ],
            nextCursor: null,
          });
        }
        return response({ code: "invalid_request" }, 400);
      });
      vi.stubGlobal("fetch", fetchMock);
      renderPanel("run-1");
      await advancePanelTimers(0);
      expect(screen.getByText(/1 run shown/)).toBeTruthy();

      await advancePanelTimers(2_000);
      expect(screen.getByText(/1 new run arrived/)).toBeTruthy();
      // Order stays stable: the newcomer waits behind the affordance.
      expect(screen.getByText(/1 run shown/)).toBeTruthy();
      expect(screen.queryByRole("button", { name: /run-new/ })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Show new results" }));
      await advancePanelTimers(0);
      expect(screen.getByText(/2 runs shown/)).toBeTruthy();
      expect(screen.getByRole("button", { name: /run-new/ })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Show new results" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
