// @vitest-environment jsdom

import { PersistedActionSchema, type PersistedAction } from "@stonehush/contracts";
import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
  description: "Synthetic reserved lab",
  authorizationContext: "RO-2026-08 authorized lab",
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
  description: null,
  authorizationContext: null,
  revision: 3,
};

const readyStatus = { version: 1, overall: "ready", developmentStorage: "ready" };

const ACTION_ID = "40000000-0000-4000-8000-000000000001";
const SNAPSHOT_ID = "40000000-0000-4000-8000-000000000002";
const BINDING = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function queuedAction(): PersistedAction {
  return PersistedActionSchema.parse({
    contractVersion: 1,
    engagementId: activeEngagement.id,
    revision: 1,
    warningAcknowledgmentId: null,
    createdAt: "2026-08-12T12:10:00.000Z",
    updatedAt: "2026-08-12T12:10:00.000Z",
    action: {
      orchestrationProfile: "d2-v1",
      actionId: ACTION_ID,
      state: "queued",
      snapshots: [
        {
          normalizationProfile: "d1-v1",
          orchestrationProfile: "d2-v1",
          snapshotId: SNAPSHOT_ID,
          version: 1,
          binding: BINDING,
          actionId: ACTION_ID,
          canonicalTargets: [
            {
              kind: "ip",
              normalizationProfile: "d1-v1",
              family: 4,
              address: "192.0.2.10",
              zone: null,
            },
          ],
          concreteDestinations: [
            {
              kind: "ip",
              normalizationProfile: "d1-v1",
              family: 4,
              address: "192.0.2.10",
              zone: null,
            },
          ],
          typedOptions: { declaredPorts: null },
          resolutionSnapshots: [],
          scopeRevisionId: null,
          warningState: { reasonCodes: [], knownAdditions: [], acknowledgment: null },
        },
      ],
      queuedSnapshotVersion: 1,
      warningAcknowledgment: null,
      pendingWarning: null,
      coveredDestinations: [],
      warningInteractions: 0,
      runState: null,
      resumeRequested: false,
      cleanupRequired: false,
      capabilityErrorCode: null,
    },
  });
}

function isReadRequest(init?: RequestInit) {
  return init?.method === undefined || init.method === "GET";
}

type TestEngagement = typeof activeEngagement | typeof archivedEngagement;

function readEngagementResponse(
  url: string,
  list: readonly TestEngagement[],
  scopes: Readonly<Record<string, unknown>> = {},
  services: Readonly<Record<string, unknown[]>> = {},
): Response | undefined {
  if (url.includes("/system/status")) return response(readyStatus);
  if (url === "/api/v1/engagements") return response([...list]);
  const servicesMatch = /^\/api\/v1\/engagements\/([^/?]+)\/services$/.exec(url);
  if (servicesMatch?.[1] !== undefined) {
    const engagement = list.find((item) => item.id === servicesMatch[1]);
    if (engagement === undefined) return response({ code: "engagement_not_found" }, 404);
    return response(services[servicesMatch[1]] ?? []);
  }
  const probesMatch = /^\/api\/v1\/engagements\/([^/?]+)\/http-probes$/.exec(url);
  if (probesMatch?.[1] !== undefined) {
    const engagement = list.find((item) => item.id === probesMatch[1]);
    if (engagement === undefined) return response({ code: "engagement_not_found" }, 404);
    return response([]);
  }
  const match = /^\/api\/v1\/engagements\/([^/?]+)$/.exec(url);
  if (match?.[1] === undefined) return undefined;
  const engagement = list.find((item) => item.id === match[1]);
  if (engagement === undefined) return response({ code: "engagement_not_found" }, 404);
  return response({
    engagement,
    activeScopeRevision: scopes[engagement.id] ?? null,
  });
}

function response(payload: unknown, status = 200): Response {
  return {
    json: async () => payload,
    ok: status >= 200 && status < 300,
    status,
  } as Response;
}

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    return Promise.resolve(handler(url, init));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const testQueryClients = new Set<QueryClient>();

async function renderWorkspace(initialEntry = "/engagements") {
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

describe("engagement workspace", () => {
  it("shows a primary empty state without synthetic records", async () => {
    stubFetch((url, init) => {
      if (!isReadRequest(init)) return response({ code: "invalid_request" }, 400);
      return readEngagementResponse(url, []) ?? response([]);
    });

    await renderWorkspace();

    expect(await screen.findByRole("heading", { name: "No engagements yet" })).toBeTruthy();
    expect(screen.queryByText("Service sweep")).toBeNull();
    expect(screen.getAllByRole("button", { name: "New engagement" }).length).toBeGreaterThan(0);
  });

  it("announces initial loading inside the stable shell", async () => {
    stubFetch(() => new Promise<Response>(() => undefined));
    await renderWorkspace();

    expect(screen.getAllByRole("status", { name: "Loading engagements" }).length).toBeGreaterThan(0);
    expect(screen.getByTestId("application-shell")).toBeTruthy();
  });

  it("shows a recoverable list error and retries", async () => {
    const fetchMock = stubFetch((url) => {
      if (url.includes("/system/status")) return response(readyStatus);
      return { json: async () => ({ code: "storage_busy" }), ok: false, status: 503 } as Response;
    });

    await renderWorkspace();
    expect(await screen.findByRole("heading", { name: "Engagements unavailable" })).toBeTruthy();
    const engagementCalls = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/v1/engagements")).length;
    const beforeRetry = engagementCalls();
    for (const button of screen.getAllByRole("button", { name: "Retry" })) {
      fireEvent.click(button);
    }
    await waitFor(() => expect(engagementCalls()).toBeGreaterThan(beforeRetry));
  });

  it("creates one engagement, closes only after success, and reveals the record", async () => {
    const created = { ...activeEngagement, name: "Northstar lab" };
    let list: unknown[] = [];
    const keys: string[] = [];
    stubFetch((url, init) => {
      if (url === "/api/v1/engagements" && init?.method === "POST") {
        keys.push((init.headers as Record<string, string>)["Idempotency-Key"] ?? "");
        list = [created];
        return response(created, 201);
      }
      if (url.endsWith("/actions") && init?.method === "POST") {
        return response(queuedAction(), 201);
      }
      if (isReadRequest(init)) {
        return readEngagementResponse(url, list as TestEngagement[]) ?? response(list);
      }
      return response(list);
    });

    await renderWorkspace();
    expect(await screen.findByRole("heading", { name: "No engagements yet" })).toBeTruthy();

    const createButtons = screen.getAllByRole("button", { name: "New engagement" });
    fireEvent.click(createButtons[0]!);
    const dialog = await screen.findByRole("dialog", { name: "Start an engagement" });
    expect(document.activeElement).toBe(screen.getByLabelText(/Name/));

    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "Northstar lab" } });
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "lab" } });
    fireEvent.change(screen.getByLabelText(/Targets/), { target: { value: "192.0.2.10" } });
    fireEvent.submit(within(dialog).getByRole("button", { name: "Start engagement" }).closest("form")!);

    expect(await screen.findByRole("heading", { level: 1, name: "Northstar lab" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getAllByText("Lab").length).toBeGreaterThan(0);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.length).toBeGreaterThanOrEqual(22);
  });

  it("keeps the dialog open and shows a local validation error", async () => {
    stubFetch((url, init) => {
      if (!isReadRequest(init)) return response({ code: "invalid_request" }, 400);
      return readEngagementResponse(url, []) ?? response([]);
    });
    await renderWorkspace();
    fireEvent.click(screen.getAllByRole("button", { name: "New engagement" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "Start an engagement" });
    fireEvent.submit(within(dialog).getByRole("button", { name: "Start engagement" }).closest("form")!);
    expect(await screen.findByText("Enter at least one target or attach a challenge file.")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Start an engagement" })).toBeTruthy();
    expect(screen.queryByText("Engagement created")).toBeNull();
  });

  it("shows a server failure without a success state", async () => {
    stubFetch((url, init) => {
      if (init?.method === "POST") return response({ code: "storage_busy" }, 503);
      return readEngagementResponse(url, []) ?? response([]);
    });
    await renderWorkspace();
    fireEvent.click(screen.getAllByRole("button", { name: "New engagement" })[0]!);
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "Busy lab" } });
    fireEvent.change(screen.getByLabelText(/Targets/), { target: { value: "192.0.2.10" } });
    fireEvent.submit(screen.getByRole("button", { name: "Start engagement" }).closest("form")!);
    expect((await screen.findAllByText("Storage is busy. Try again.")).length).toBeGreaterThan(0);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Busy lab" })).toBeNull();
  });

  it("closes the create dialog with Escape and restores focus", async () => {
    stubFetch((url, init) => {
      if (!isReadRequest(init)) return response({ code: "invalid_request" }, 400);
      return readEngagementResponse(url, []) ?? response([]);
    });
    await renderWorkspace();
    const trigger = screen.getAllByRole("button", { name: "New engagement" })[0]!;
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Start an engagement" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Start an engagement" })).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("archives an active engagement and reopens the archived result", async () => {
    let current = { ...activeEngagement };
    stubFetch((url, init) => {
      if (url.endsWith("/archive") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ expectedRevision: current.revision });
        current = { ...current, status: "archived", revision: current.revision + 1 };
        return response(current);
      }
      if (url.endsWith("/reopen") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ expectedRevision: current.revision });
        current = { ...current, status: "active", revision: current.revision + 1 };
        return response(current);
      }
      return readEngagementResponse(url, [current]) ?? response([current]);
    });

    await renderWorkspace(`/engagements/${activeEngagement.id}`);
    expect(await screen.findByRole("heading", { level: 1, name: "Target lab" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Archive engagement" }));
    expect(await screen.findByRole("button", { name: "Reopen engagement" })).toBeTruthy();
    expect(screen.getAllByText("Archived").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Reopen engagement" }));
    expect(await screen.findByRole("button", { name: "Archive engagement" })).toBeTruthy();
  });

  it("refreshes after a revision conflict and does not keep the stale action result", async () => {
    const newer = { ...activeEngagement, revision: 5, name: "Target lab", description: "Newer note" };
    let list = [activeEngagement];
    stubFetch((url, init) => {
      if (url.endsWith("/archive") && init?.method === "POST") {
        list = [newer];
        return response(
          {
            code: "revision_conflict",
            resourceType: "engagement",
            resourceId: activeEngagement.id,
            currentRevision: 5,
          },
          409,
        );
      }
      return readEngagementResponse(url, list) ?? response(list);
    });

    await renderWorkspace(`/engagements/${activeEngagement.id}`);
    expect(await screen.findByText("rev 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Archive engagement" }));
    expect(
      await screen.findByText("This engagement changed. Showing the latest revision."),
    ).toBeTruthy();
    await waitFor(() => expect(screen.getByText("rev 5")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Archive engagement" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reopen engagement" })).toBeNull();
  });

  it("lists archived engagements separately from active ones", async () => {
    stubFetch((url, init) => {
      if (!isReadRequest(init)) return response({ code: "invalid_request" }, 400);
      return (
        readEngagementResponse(url, [activeEngagement, archivedEngagement]) ??
        response([activeEngagement, archivedEngagement])
      );
    });
    await renderWorkspace();
    expect((await screen.findAllByText("Target lab")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Archived").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Parked box").length).toBeGreaterThan(0);
  });

  it("filters the loaded sidebar list locally without inventing results", async () => {
    stubFetch((url, init) => {
      if (!isReadRequest(init)) return response({ code: "invalid_request" }, 400);
      return (
        readEngagementResponse(url, [activeEngagement, archivedEngagement]) ??
        response([activeEngagement, archivedEngagement])
      );
    });
    await renderWorkspace();
    expect((await screen.findAllByText("Target lab")).length).toBeGreaterThan(0);

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter engagements" }), {
      target: { value: "Parked" },
    });
    expect(screen.queryByText("No engagements match this filter.")).toBeNull();
    expect(screen.getAllByText("Parked box").length).toBeGreaterThan(0);

    const sidebar = screen.getByRole("complementary", { name: "Primary" });
    expect(within(sidebar).queryByText("Target lab")).toBeNull();

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter engagements" }), {
      target: { value: "zz-missing" },
    });
    expect(screen.getByText("No engagements match this filter.")).toBeTruthy();
  });

  it("shows planner and scope editor without disconnected placeholders", async () => {
    stubFetch((url, init) => {
      if (!isReadRequest(init)) return response({ code: "invalid_request" }, 400);
      return readEngagementResponse(url, [activeEngagement]) ?? response([activeEngagement]);
    });
    await renderWorkspace(`/engagements/${activeEngagement.id}`);
    expect(await screen.findByRole("heading", { level: 1, name: "Target lab" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeTruthy();
    expect(screen.getByText("Synthetic reserved lab")).toBeTruthy();
    expect(screen.getByText("Authorization")).toBeTruthy();
    expect(screen.getByText("RO-2026-08 authorized lab")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Engagement context" })).toBeTruthy();
    expect(screen.queryByText("Auto-continue warnings")).toBeNull();
    expect(await screen.findByRole("heading", { name: "No saved scope yet" })).toBeTruthy();
    expect(screen.getAllByText(/Scope is context, not authorization/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "New run" }));
    expect(document.activeElement).toBe(await screen.findByLabelText("Targets"));
    expect(screen.getByTestId("workspace-notice").textContent).toBe("");
    expect(screen.getByRole("heading", { name: "Runs" })).toBeTruthy();
    expect(screen.queryByText("Next in this engagement")).toBeNull();
    expect(screen.queryByRole("button", { name: /Evidence/ })).toBeNull();

    fireEvent.click(screen.getAllByRole("link", { name: "Stonehush home" })[0]!);
    expect(await screen.findByRole("heading", { level: 1, name: "Start" })).toBeTruthy();
    expect(screen.getByTestId("workspace-notice").textContent).toBe("");
  });

  it("keeps hook order stable when the engagement list resolves from pending", async () => {
    let resolveEngagements: (value: Response) => void = () => undefined;
    const pendingEngagements = new Promise<Response>((resolve) => {
      resolveEngagements = resolve;
    });
    stubFetch((url, init) => {
      if (url.includes("/system/status")) return response(readyStatus);
      if (url === "/api/v1/engagements" && isReadRequest(init)) return pendingEngagements;
      if (url.startsWith("/api/v1/engagements/") && isReadRequest(init)) {
        return response({ engagement: activeEngagement, activeScopeRevision: null });
      }
      return response([]);
    });

    const hookError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await renderWorkspace();

    expect(screen.getAllByRole("status", { name: "Loading engagements" }).length).toBeGreaterThan(0);

    resolveEngagements(response([activeEngagement]));
    expect((await screen.findAllByText("Target lab")).length).toBeGreaterThan(0);

    const messages = hookError.mock.calls.flat().map((entry) => String(entry)).join("\n");
    expect(messages).not.toMatch(/Rendered fewer hooks/i);
    expect(messages).not.toMatch(/Rendered more hooks/i);
    expect(messages).not.toMatch(/order of Hooks/i);
    hookError.mockRestore();
  });
});
