// @vitest-environment jsdom

import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { createAppRouter } from "../router.js";

const activeEngagement = {
  contractVersion: 1,
  id: "10000000-0000-4000-8000-000000000001",
  revision: 2,
  name: "Target lab",
  kind: "lab",
  status: "active",
  description: null,
  authorizationContext: null,
  autoContinueWarnings: false,
  activeScopeRevisionId: null,
  deadlineAt: null,
  createdAt: "2026-08-12T12:00:00.000Z",
  updatedAt: "2026-08-12T12:05:00.000Z",
};

const archivedEngagement = {
  ...activeEngagement,
  id: "10000000-0000-4000-8000-000000000002",
  name: "Parked box",
  kind: "ctf",
  status: "archived",
  revision: 3,
};

type TestEngagement = typeof activeEngagement | typeof archivedEngagement;

function response(payload: unknown, status = 200): Response {
  return {
    json: async () => payload,
    ok: status >= 200 && status < 300,
    status,
  } as Response;
}

function stubEngagementApi(list: TestEngagement[]) {
  const records = [...list];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/v1/advisor/status")) {
      return Promise.resolve(
        response({ configured: false, endpointReachable: null, modelId: "" }),
      );
    }
    if (url.includes("/system/status")) {
      return Promise.resolve(response({ version: 1, overall: "ready", developmentStorage: "ready" }));
    }
    const archiveMatch = /^\/api\/v1\/engagements\/([^/?]+)\/(archive|reopen)$/.exec(url);
    if (archiveMatch?.[1] !== undefined && init?.method === "POST") {
      const record = records.find((item) => item.id === archiveMatch[1]);
      if (record === undefined) return Promise.resolve(response({ code: "engagement_not_found" }, 404));
      const updated = {
        ...record,
        status: archiveMatch[2] === "archive" ? "archived" : "active",
        revision: record.revision + 1,
      };
      records.splice(records.indexOf(record), 1, updated);
      return Promise.resolve(response(updated));
    }
    if (url === "/api/v1/engagements") return Promise.resolve(response([...records]));
    const detailMatch = /^\/api\/v1\/engagements\/([^/?]+)$/.exec(url);
    if (detailMatch?.[1] !== undefined) {
      const record = records.find((item) => item.id === detailMatch[1]);
      if (record === undefined) return Promise.resolve(response({ code: "engagement_not_found" }, 404));
      return Promise.resolve(response({ engagement: record, activeScopeRevision: null }));
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const testQueryClients = new Set<QueryClient>();

async function renderAt(initialEntry: string) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [initialEntry] }));
  await router.load();
  const queryClient = createAppQueryClient();
  testQueryClients.add(queryClient);
  const result = render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { ...result, queryClient, router };
}

async function openRowMenu(rowName: RegExp) {
  const sidebar = await screen.findByRole("complementary", { name: "Primary" });
  const row = await within(sidebar).findByRole("link", { name: rowName });
  fireEvent.contextMenu(row);
  const menu = await screen.findByRole("menu");
  return { menu, row };
}

async function expandArchivedShelf() {
  const sidebar = await screen.findByRole("complementary", { name: "Primary" });
  const shelf = await within(sidebar).findByRole("button", { name: /Archived/ });
  if (shelf.getAttribute("aria-expanded") !== "true") {
    fireEvent.click(shelf);
  }
}

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280, writable: true });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 900, writable: true });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  for (const queryClient of testQueryClients) queryClient.clear();
  testQueryClients.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("engagement row context menu", () => {
  it("opens on right-click and copies the engagement ID", async () => {
    stubEngagementApi([activeEngagement]);
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await renderAt("/");

    const { menu } = await openRowMenu(/Target lab/);
    expect(within(menu).getByRole("menuitem", { name: "Open engagement" })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "Copy engagement name" })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "Copy engagement ID" })).toBeTruthy();
    expect(
      within(menu).getByRole("menuitem", { name: "Archive Target lab" }),
    ).toBeTruthy();

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy engagement ID" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(activeEngagement.id));
  });

  it("opens the engagement detail from the menu", async () => {
    stubEngagementApi([activeEngagement]);
    const { router } = await renderAt("/");

    const { menu } = await openRowMenu(/Target lab/);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Open engagement" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/engagements/${activeEngagement.id}`),
    );
  });

  it("archives from the menu, then offers reopen", async () => {
    const fetchMock = stubEngagementApi([activeEngagement]);
    await renderAt("/");

    const first = await openRowMenu(/Target lab/);
    fireEvent.click(within(first.menu).getByRole("menuitem", { name: "Archive Target lab" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input) === `/api/v1/engagements/${activeEngagement.id}/archive` &&
            init?.method === "POST",
        ),
      ).toBe(true),
    );

    const second = await (async () => {
      await expandArchivedShelf();
      return openRowMenu(/Target lab/);
    })();
    expect(
      within(second.menu).getByRole("menuitem", { name: "Reopen Target lab" }),
    ).toBeTruthy();
  });

  it("offers reopen on archived rows", async () => {
    stubEngagementApi([archivedEngagement]);
    await renderAt("/");

    await expandArchivedShelf();
    const { menu } = await openRowMenu(/Parked box/);
    expect(within(menu).getByRole("menuitem", { name: "Reopen Parked box" })).toBeTruthy();
    expect(within(menu).queryByRole("menuitem", { name: /Archive/ })).toBeNull();
  });
});
