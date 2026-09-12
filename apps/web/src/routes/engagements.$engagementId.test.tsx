// @vitest-environment jsdom

import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { createAppRouter } from "../router.js";
import { validateEngagementSearch } from "./engagements.$engagementId.js";

const activeEngagement = {
  contractVersion: 1,
  id: "10000000-0000-4000-8000-000000000001",
  revision: 1,
  name: "Target lab",
  kind: "lab",
  status: "active",
  description: null,
  authorizationContext: null,
  autoContinueWarnings: false,
  activeScopeRevisionId: null,
  deadlineAt: null,
  createdAt: "2026-08-12T12:00:00.000Z",
  updatedAt: "2026-08-12T12:00:00.000Z",
};

const readyStatus = { version: 1, overall: "ready", developmentStorage: "ready" };

function response(payload: unknown, status = 200): Response {
  return {
    json: async () => payload,
    ok: status >= 200 && status < 300,
    status,
  } as Response;
}

const testQueryClients = new Set<QueryClient>();

async function renderRoute(initialEntry: string) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [initialEntry] }));
  await router.load();
  const queryClient = createAppQueryClient();
  testQueryClients.add(queryClient);
  const view = render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { ...view, queryClient, router };
}

function stubBaseFetch() {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/system/status")) return Promise.resolve(response(readyStatus));
    if (url === "/api/v1/engagements") return Promise.resolve(response([activeEngagement]));
    if (url === `/api/v1/engagements/${activeEngagement.id}`) {
      return Promise.resolve(
        response({ engagement: activeEngagement, activeScopeRevision: null }),
      );
    }
    if (url.endsWith("/services")) return Promise.resolve(response([]));
    if (url.endsWith("/http-probes")) return Promise.resolve(response([]));
    if (url.endsWith("/ffuf-results")) return Promise.resolve(response([]));
    if (url.endsWith("/settings/runner")) return Promise.resolve(response({ code: "busy" }, 503));
    if (url.endsWith("/runs/latest/output")) {
      return Promise.resolve(response({ code: "no_terminal_run" }, 404));
    }
    if (url.endsWith("/runs/run-7/output")) {
      return Promise.resolve(response({ code: "run_not_found" }, 404));
    }
    if (init?.method !== undefined && init.method !== "GET") {
      return Promise.resolve(response({ code: "invalid_request" }, 400));
    }
    return Promise.resolve(response([]));
  });
}

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280, writable: true });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 900, writable: true });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }),
  });
  Object.defineProperty(window, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  for (const client of testQueryClients) client.clear();
  testQueryClients.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("engagement detail route search", () => {
  it("passes tab and run strings through and drops anything else", () => {
    expect(validateEngagementSearch({ tab: "notes", run: "run-1" })).toEqual({
      tab: "notes",
      run: "run-1",
    });
    expect(validateEngagementSearch({})).toEqual({});
    expect(
      validateEngagementSearch({ tab: "runs", unrelated: "x", limit: 20 }),
    ).toEqual({ tab: "runs" });
  });

  it("passes a paused-action id through and drops non-string values", () => {
    expect(validateEngagementSearch({ action: "action-1", tab: "runs" })).toEqual({
      action: "action-1",
      tab: "runs",
    });
    expect(validateEngagementSearch({ action: 5 })).toEqual({});
  });

  it("records the opened engagement for Resume", async () => {
    vi.stubGlobal("fetch", stubBaseFetch());
    window.localStorage.clear();
    await renderRoute(`/engagements/${activeEngagement.id}`);

    expect(await screen.findByRole("heading", { name: "Attack surface" })).toBeTruthy();
    expect(window.localStorage.getItem("stonehush.lastEngagementId")).toBe(activeEngagement.id);
  });

  it("drops non-string tab and run values", () => {
    expect(validateEngagementSearch({ tab: 3, run: ["run-1"] })).toEqual({});
    expect(validateEngagementSearch({ tab: null, run: undefined })).toEqual({});
  });

  it("renders the surface tab when no search is present", async () => {
    vi.stubGlobal("fetch", stubBaseFetch());
    await renderRoute(`/engagements/${activeEngagement.id}`);

    expect(await screen.findByRole("heading", { name: "Attack surface" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Surface" }).getAttribute("aria-current"),
    ).toBe("page");
  });

  it("renders surface for an unknown tab without failing", async () => {
    vi.stubGlobal("fetch", stubBaseFetch());
    await renderRoute(`/engagements/${activeEngagement.id}?tab=elsewhere`);

    expect(await screen.findByRole("heading", { name: "Attack surface" })).toBeTruthy();
    expect(screen.queryByLabelText("Markdown")).toBeNull();
  });

  it("carries a run id from the URL into the common selection line", async () => {
    vi.stubGlobal("fetch", stubBaseFetch());
    await renderRoute(`/engagements/${activeEngagement.id}?run=run-7`);

    expect(await screen.findByRole("heading", { name: "Attack surface" })).toBeTruthy();
    expect(screen.getByText(/Selected run/).textContent).toContain("run-7");
  });
});
