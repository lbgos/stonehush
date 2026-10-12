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
import { emptyWorkspaceState, parseWorkspaceState, workspaceStateKey } from "./workspace-state.js";

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

describe("workspace inspector return context", () => {
  it.each([
    { origin: "upper", state: "hidden" }, { origin: "upper", state: "collapsed" },
    { origin: "lower", state: "hidden" }, { origin: "lower", state: "expanded" },
  ])("keeps $origin focus after real route navigation with the upper group $state", async ({ origin, state }) => {
    const path = {
      source: "ffuf", parserVersion: "ffuf-json-v1", url: "http://192.0.2.10/admin",
      status: 200, length: 1234, words: 10, lines: 5, redirectlocation: null,
      fuzz: "admin", runId: "run-1", artifactId: "artifact-9",
      artifactDigest: `sha256:${"c".repeat(64)}`, observedAt: "2026-08-13T12:00:00.000Z",
    };
    const basis = "status 200, length 1234, words 10, lines 5";
    stubFetch((url) => {
      if (url.endsWith("/ffuf-results")) return response([path, { ...path, url: "http://192.0.2.10/login" }]);
      return readEngagementResponse(url, [activeEngagement]) ?? response([]);
    });
    const { router } = await renderWorkspace(`/engagements/${activeEngagement.id}`);
    const upper = await screen.findByRole("region", { name: "Path results for http://192.0.2.10" });
    const lower = screen.getByRole("region", { name: "ffuf discovery" });
    await within(lower).findByRole("button", { name: path.url });
    const disclosure = within(upper).getByRole("button", { name: basis });
    fireEvent.click(disclosure);
    const list = origin === "upper" ? upper : lower;
    const row = within(list).getByRole("button", { name: path.url }).closest("li")!;
    const opener = within(row).getByRole("button", { name: "Inspect" });
    fireEvent.click(opener);
    await screen.findByRole("complementary", { name: "Selection inspector" });
    await waitFor(() => expect(router.state.location.search.sel).toBeDefined());
    if (state !== "expanded") fireEvent.click(state === "hidden" ? within(upper).getByRole("button", { name: `Hide ${basis}` }) : disclosure);
    fireEvent.click(screen.getByRole("button", { name: "Close inspector" }));
    await waitFor(() => expect(router.state.location.search.sel).toBeUndefined());
    const expected = origin === "lower" ? opener : within(upper).getByRole("button", { name: state === "hidden" ? `Restore ${basis}` : basis });
    await waitFor(() => expect(document.activeElement).toBe(expected));
  });
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

  it("keeps a lead draft inside the engagement that opened it", async () => {
    const secondEngagement = {
      ...activeEngagement,
      id: "10000000-0000-4000-8000-000000000003",
      name: "Second lab",
    };
    const webService = {
      address: "192.0.2.10",
      port: 80,
      protocol: "tcp",
      hostname: null,
      serviceName: "http",
      product: null,
      version: null,
      source: "nmap",
      parserVersion: "nmap-xml-v1",
      runId: "run-1",
      artifactId: "artifact-1",
      artifactDigest: `sha256:${"a".repeat(64)}`,
      observedAt: "2026-08-13T12:00:00.000Z",
    };
    const list = [activeEngagement, secondEngagement];
    const fetchMock = stubFetch((url, init) => {
      if (!isReadRequest(init)) return response({ code: "invalid_request" }, 400);
      return (
        readEngagementResponse(url, list, {}, {
          [activeEngagement.id]: [webService],
          [secondEngagement.id]: [webService],
        }) ?? response([])
      );
    });
    const { router } = await renderWorkspace(`/engagements/${activeEngagement.id}`);

    fireEvent.click(await screen.findByRole("button", { name: "Start a lead" }));
    const dialog = screen.getByRole("dialog", { name: "Start a lead" });
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Draft for A" } });

    await router.navigate({ to: "/engagements/$engagementId", params: { engagementId: secondEngagement.id } });
    expect(await screen.findByRole("heading", { level: 1, name: "Second lab" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Start a lead" })).toBeNull();
    expect(screen.queryByDisplayValue("Draft for A")).toBeNull();

    await router.navigate({ to: "/engagements/$engagementId", params: { engagementId: activeEngagement.id } });
    expect(await screen.findByRole("heading", { level: 1, name: "Target lab" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Start a lead" })).toBeNull();
    expect(fetchMock.mock.calls.some(([, init]) => !isReadRequest(init))).toBe(false);
  });

  it("opens Start a lead read-only for an archived engagement", async () => {
    const webService = {
      address: "192.0.2.10",
      port: 80,
      protocol: "tcp",
      hostname: null,
      serviceName: "http",
      product: null,
      version: null,
      source: "nmap",
      parserVersion: "nmap-xml-v1",
      runId: "run-1",
      artifactId: "artifact-1",
      artifactDigest: `sha256:${"a".repeat(64)}`,
      observedAt: "2026-08-13T12:00:00.000Z",
    };
    const fetchMock = stubFetch((url, init) => {
      if (!isReadRequest(init)) return response({ code: "invalid_request" }, 400);
      return (
        readEngagementResponse(url, [archivedEngagement], {}, { [archivedEngagement.id]: [webService] }) ??
        response([])
      );
    });
    await renderWorkspace(`/engagements/${archivedEngagement.id}`);

    fireEvent.click(await screen.findByRole("button", { name: "Start a lead" }));
    const dialog = screen.getByRole("dialog", { name: "Start a lead" });
    expect(within(dialog).getByText(/This engagement is archived/)).toBeTruthy();
    const save = within(dialog).getByRole<HTMLButtonElement>("button", { name: "Save lead" });
    expect(save.disabled).toBe(true);
    fireEvent.submit(save.closest("form")!);
    expect(fetchMock.mock.calls.some(([, init]) => !isReadRequest(init))).toBe(false);
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


describe("remembered run workspace integration", () => {
  it.each([activeEngagement, archivedEngagement])("opens the exact saved run in $status engagements outside the first history page", async (engagement) => {
    window.localStorage.setItem(workspaceStateKey(engagement.id), JSON.stringify({ ...emptyWorkspaceState(), selectedRunId: "run-old", drafts: { notes: "kept" } }));
    const fetchMock = stubFetch((url) => {
      const detail = readEngagementResponse(url, [engagement]);
      if (detail !== undefined) return detail;
      if (url.endsWith("/resume")) return response({ engagementId: engagement.id, nextStep: null, nextStepUpdatedAt: null, nextStepRevision: 0, changes: [], complete: true });
      if (url.includes("/runs?")) return response({ runs: [], nextCursor: "older" });
      if (url.endsWith("/runs/run-old/output")) return response({ run: { id: "run-old", actionId: "action-old", state: "succeeded", terminalKind: "succeeded", terminalReason: null, updatedAt: engagement.updatedAt }, stdout: { present: false, truncated: false, content: "" }, stderr: { present: false, truncated: false, content: "" } });
      return response([]);
    });
    const { router } = await renderWorkspace(`/engagements/${engagement.id}?target=192.0.2.10&sel=service-1`);
    fireEvent.click(await screen.findByRole("button", { name: "Open run run-old, succeeded" }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ tab: "runs", run: "run-old", target: "192.0.2.10", sel: "service-1" }));
    expect(await screen.findByRole("region", { name: "Selected run output" })).toBeTruthy();
    expect(parseWorkspaceState(window.localStorage.getItem(workspaceStateKey(engagement.id))).drafts).toEqual({ notes: "kept" });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/runs/latest/output"))).toBe(false);
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === undefined || init.method === "GET")).toBe(true);
  });
});

describe("remembered Surface workspace integration", () => {
  const oldService = { address: "192.0.2.20", port: 80, protocol: "tcp", hostname: null, serviceName: "http", product: "old observation", version: null, source: "nmap", parserVersion: "nmap-xml-v1", runId: "run-old", artifactId: "artifact-old", artifactDigest: `sha256:${"a".repeat(64)}`, observedAt: "2026-10-12T12:00:00.000Z" };
  const serviceKey = "service:192.0.2.20:80:tcp:artifact-old";
  const path = { source: "ffuf", parserVersion: "ffuf-json-v1", url: "http://192.0.2.20/admin", status: 403, length: 42, words: 2, lines: 1, redirectlocation: null, fuzz: "admin", runId: "run-path", artifactId: "artifact-path", artifactDigest: oldService.artifactDigest, observedAt: oldService.observedAt };
  const probe = { source: "http-probe", parserVersion: "http-probe-raw-v1", url: "http://192.0.2.20/", fetchedAt: oldService.observedAt, finalUrl: "http://192.0.2.20/", status: 403, title: "Restricted", selectedHeaders: { contentType: "text/html", server: null, poweredBy: null }, hops: [{ url: "http://192.0.2.20/", status: 403, location: null }], error: null, runId: "run-probe", artifactId: "artifact-probe", artifactDigest: oldService.artifactDigest, observedAt: oldService.observedAt };
  function savePointer(key = serviceKey) {
    window.localStorage.setItem(workspaceStateKey(activeEngagement.id), JSON.stringify({ ...emptyWorkspaceState(), selectedTarget: oldService.address, inspectorSelection: key, selectedRunId: "run-kept", drafts: { notes: "keep" } }));
  }
  function surfaceStub(overrides: (url: string) => Response | undefined = () => undefined) {
    return stubFetch((url) => {
      const override = overrides(url); if (override !== undefined) return override;
      if (url.endsWith("/services")) return response([{ ...oldService, address: "192.0.2.10", artifactId: "first-artifact" }, oldService]);
      if (url.endsWith("/http-probes")) return response([probe]);
      if (url.endsWith("/ffuf-results")) return response([path, { ...path, artifactId: "new-artifact", runId: "new-run" }]);
      if (url.endsWith("/resume")) return response({ engagementId: activeEngagement.id, nextStep: "Inspect the old admin response", nextStepUpdatedAt: null, nextStepRevision: 0, changes: [], complete: true });
      if (url.includes("/runs?")) return response({ runs: [], nextCursor: null });
      if (url.endsWith("/runs/run-kept/output")) return response({ run: { id: "run-kept", actionId: "action-kept", state: "succeeded", terminalKind: "succeeded", terminalReason: null, updatedAt: oldService.observedAt }, stdout: { present: false, truncated: false, content: "" }, stderr: { present: false, truncated: false, content: "" } });
      return readEngagementResponse(url, [activeEngagement, archivedEngagement]) ?? response([]);
    });
  }

  it.each([serviceKey, "probe:artifact-probe:http://192.0.2.20/", "path:artifact-path:http://192.0.2.20/admin"])("Home Resume restores exact %s without opening a run", async (key) => {
    savePointer(key); const fetchMock = surfaceStub();
    const { router } = await renderWorkspace("/");
    const resume = await screen.findByRole("region", { name: "Resume" });
    fireEvent.click(within(resume).getByRole("link", { name: "Target lab" }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ target: oldService.address, sel: key }));
    const inspector = await screen.findByRole("complementary", { name: "Selection inspector" });
    await waitFor(() => expect(within(inspector).getByRole("link", { name: "Raw evidence" }).getAttribute("href")).toContain(key.split(":")[1] === "artifact-probe" ? "artifact-probe" : key.startsWith("path:") ? "artifact-path" : "artifact-old"));
    expect(screen.queryByRole("region", { name: "Selected run output" })).toBeNull();
    expect(parseWorkspaceState(window.localStorage.getItem(workspaceStateKey(activeEngagement.id)))).toMatchObject({ selectedRunId: "run-kept", drafts: { notes: "keep" } });
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === undefined || init.method === "GET")).toBe(true);
  });

  it.each(["?tab=runs&run=run-explicit", "?target=192.0.2.10", "?sel=service:192.0.2.10:80:tcp:first-artifact", `?action=${ACTION_ID}`])("never replaces explicit route %s", async (search) => {
    savePointer(); surfaceStub();
    const { router } = await renderWorkspace(`/engagements/${activeEngagement.id}${search}`);
    await screen.findByRole("heading", { level: 1, name: "Target lab" });
    expect(router.state.location.search).toEqual(Object.fromEntries(new URLSearchParams(search)));
  });

  it("Clear and Back do not automatically reopen an inspector in the same visit", async () => {
    savePointer(); surfaceStub();
    const { router } = await renderWorkspace(`/engagements/${activeEngagement.id}`);
    await waitFor(() => expect(within(screen.getByRole("complementary", { name: "Selection inspector" })).getByRole("link", { name: "Raw evidence" })).toBeTruthy());
    fireEvent.click(within(screen.getByRole("complementary", { name: "Selection inspector" })).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(router.state.location.search.sel).toBeUndefined());
    expect(screen.queryByRole("complementary", { name: "Selection inspector" })).toBeNull();
    expect(parseWorkspaceState(window.localStorage.getItem(workspaceStateKey(activeEngagement.id))).inspectorSelection).toBe(serviceKey);
    router.history.back();
    await waitFor(() => expect(router.state.location.search.sel).toBe(serviceKey));
    await waitFor(() => expect(within(screen.getByRole("complementary", { name: "Selection inspector" })).getByRole("link", { name: "Raw evidence" })).toBeTruthy());
    router.history.forward();
    await waitFor(() => expect(router.state.location.search.sel).toBeUndefined());
    expect(screen.queryByRole("complementary", { name: "Selection inspector" })).toBeNull();
  });

  it("retains a failed fresh read with Retry, then restores the exact evidence", async () => {
    savePointer(); let failing = true;
    surfaceStub(url => url.endsWith("/services") && failing ? response({}, 503) : undefined);
    const { router } = await renderWorkspace(`/engagements/${activeEngagement.id}`);
    expect(await screen.findByText("The observation could not be refreshed.")).toBeTruthy();
    expect(parseWorkspaceState(window.localStorage.getItem(workspaceStateKey(activeEngagement.id))).inspectorSelection).toBe(serviceKey);
    failing = false;
    fireEvent.click(within(screen.getByRole("complementary", { name: "Selection inspector" })).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(within(screen.getByRole("complementary", { name: "Selection inspector" })).getByRole("link", { name: "Raw evidence" })).toBeTruthy());
    expect(router.state.location.search.sel).toBe(serviceKey);
  });

  it("confirmed missing keeps the pointer until Forget and never selects a newer same URL", async () => {
    const key = "path:artifact-path:http://192.0.2.20/admin";
    savePointer(key); surfaceStub(url => url.endsWith("/ffuf-results") ? response([{ ...path, artifactId: "new-artifact" }]) : undefined);
    const { router } = await renderWorkspace(`/engagements/${activeEngagement.id}`);
    expect(await screen.findByText("Selection unavailable")).toBeTruthy();
    expect(within(screen.getByRole("complementary", { name: "Selection inspector" })).queryByRole("link", { name: "Raw evidence" })).toBeNull();
    fireEvent.click(within(screen.getByRole("complementary", { name: "Selection inspector" })).getByRole("button", { name: "Forget" }));
    await waitFor(() => expect(router.state.location.search.sel).toBeUndefined());
    expect(screen.queryByRole("region", { name: "Last observation" })).toBeNull();
    expect(parseWorkspaceState(window.localStorage.getItem(workspaceStateKey(activeEngagement.id)))).toMatchObject({ selectedTarget: null, inspectorSelection: null, selectedRunId: "run-kept" });
  });

  it("a validated explicit inspection replaces the pointer, then resumes on a new visit", async () => {
    surfaceStub();
    const key = "path:artifact-path:http://192.0.2.20/admin";
    const { router } = await renderWorkspace(`/engagements/${activeEngagement.id}?target=192.0.2.20&sel=${encodeURIComponent(key)}`);
    await waitFor(() => expect(within(screen.getByRole("complementary", { name: "Selection inspector" })).getByRole("link", { name: "Raw evidence" })).toBeTruthy());
    await waitFor(() => expect(parseWorkspaceState(window.localStorage.getItem(workspaceStateKey(activeEngagement.id))).inspectorSelection).toBe(key));
    await router.navigate({ to: "/" });
    const resume = await screen.findByRole("region", { name: "Resume" });
    fireEvent.click(within(resume).getByRole("link", { name: "Target lab" }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ target: oldService.address, sel: key }));
    await waitFor(() => expect(within(screen.getByRole("complementary", { name: "Selection inspector" })).getByRole("link", { name: "Raw evidence" })).toBeTruthy());
  });

  it("restores an archived observation with read-only requests", async () => {
    window.localStorage.setItem(workspaceStateKey(archivedEngagement.id), JSON.stringify({ ...emptyWorkspaceState(), selectedTarget: oldService.address, inspectorSelection: serviceKey }));
    const fetchMock = surfaceStub();
    const { router } = await renderWorkspace(`/engagements/${archivedEngagement.id}`);
    await waitFor(() => expect(within(screen.getByRole("complementary", { name: "Selection inspector" })).getByRole("link", { name: "Raw evidence" })).toBeTruthy());
    expect(router.state.location.search).toMatchObject({ target: oldService.address, sel: serviceKey });
    expect(fetchMock.mock.calls.every(([, init]) => isReadRequest(init))).toBe(true);
  });

  it("keeps a remembered hostname context unavailable when its address association changes", async () => {
    const key = "probe:artifact-probe:http://admin.test/";
    savePointer(key);
    surfaceStub(url => {
      if (url.endsWith("/services")) return response([{ ...oldService, address: "192.0.2.30", hostname: "admin.test" }]);
      if (url.endsWith("/http-probes")) return response([{ ...probe, url: "http://admin.test/", finalUrl: "http://admin.test/", hops: [{ url: "http://admin.test/", status: 403, location: null }] }]);
      return undefined;
    });
    const { router } = await renderWorkspace(`/engagements/${activeEngagement.id}`);
    await screen.findByText("Selection unavailable");
    expect(router.state.location.search.target).toBe(oldService.address);
    expect(parseWorkspaceState(window.localStorage.getItem(workspaceStateKey(activeEngagement.id)))).toMatchObject({ selectedTarget: oldService.address, inspectorSelection: key });
    const restoredUrl = router.state.location.href;
    cleanup();
    for (const client of testQueryClients) client.clear();
    testQueryClients.clear();
    await renderWorkspace(restoredUrl);
    await screen.findByText("Selection unavailable");
    expect(parseWorkspaceState(window.localStorage.getItem(workspaceStateKey(activeEngagement.id)))).toMatchObject({ selectedTarget: oldService.address, inspectorSelection: key });
  });

  it("does not persist a source under a different explicit target", async () => {
    savePointer(); surfaceStub();
    const key = "path:artifact-path:http://192.0.2.20/admin";
    const { router } = await renderWorkspace(`/engagements/${activeEngagement.id}?target=192.0.2.10&sel=${encodeURIComponent(key)}`);
    await screen.findByText("Selection unavailable");
    expect(router.state.location.search).toMatchObject({ target: "192.0.2.10", sel: key });
    expect(parseWorkspaceState(window.localStorage.getItem(workspaceStateKey(activeEngagement.id))).inspectorSelection).toBe(serviceKey);
  });

  it("labels cached rows stale after a failed Home Resume read, including after Close", async () => {
    let failing = false;
    surfaceStub(url => url.endsWith("/services") && failing ? response({}, 503) : undefined);
    const { router } = await renderWorkspace(`/engagements/${activeEngagement.id}?target=192.0.2.20&sel=${encodeURIComponent(serviceKey)}`);
    await waitFor(() => expect(within(screen.getByRole("complementary", { name: "Selection inspector" })).getByRole("link", { name: "Raw evidence" })).toBeTruthy());
    await router.navigate({ to: "/" });
    const resume = await screen.findByRole("region", { name: "Resume" });
    failing = true;
    fireEvent.click(within(resume).getByRole("link", { name: "Target lab" }));
    await screen.findByText("The observation could not be refreshed.");
    expect(screen.getByText("Showing the last successful attack surface")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("complementary", { name: "Selection inspector" })).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(router.state.location.search.sel).toBeUndefined());
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Selection inspector" })).toBeNull());
    expect(screen.getByText("Showing the last successful attack surface")).toBeTruthy();
    failing = false;
    fireEvent.click(within(screen.getByRole("region", { name: "Stale data" })).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.queryByText("Showing the last successful attack surface")).toBeNull());
    expect(parseWorkspaceState(window.localStorage.getItem(workspaceStateKey(activeEngagement.id))).inspectorSelection).toBe(serviceKey);
  });

  it("allows an explicit inspection when storage rejects writes without claiming a saved pointer", async () => {
    surfaceStub();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    const { router } = await renderWorkspace(`/engagements/${activeEngagement.id}?sel=${encodeURIComponent(serviceKey)}`);
    await waitFor(() => expect(within(screen.getByRole("complementary", { name: "Selection inspector" })).getByRole("link", { name: "Raw evidence" })).toBeTruthy());
    expect(router.state.location.search.sel).toBe(serviceKey);
    expect(screen.queryByRole("region", { name: "Last observation" })).toBeNull();
    expect(parseWorkspaceState(window.localStorage.getItem(workspaceStateKey(activeEngagement.id))).inspectorSelection).toBeNull();
  });
});
