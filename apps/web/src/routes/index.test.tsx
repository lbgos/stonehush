// @vitest-environment jsdom

import { PersistedActionSchema, type PersistedAction } from "@stonehush/contracts";
import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { createAppRouter } from "../router.js";

const ENGAGEMENT_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_ID = "10000000-0000-4000-8000-000000000002";
const ACTION_ID = "40000000-0000-4000-8000-000000000001";
const SNAPSHOT_ID = "40000000-0000-4000-8000-000000000002";
const BINDING = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SCOPE_ID = "20000000-0000-4000-8000-000000000010";

const ipv4Target = {
  kind: "ip" as const,
  normalizationProfile: "d1-v1" as const,
  family: 4 as const,
  address: "192.0.2.10",
  zone: null,
};

function listedEngagement(id: string, name: string, updatedAt: string) {
  return {
    contractVersion: 1,
    id,
    revision: 1,
    name,
    kind: "lab",
    status: "active",
    description: null,
    authorizationContext: null,
    autoContinueWarnings: false,
    activeScopeRevisionId: null,
    deadlineAt: null,
    createdAt: "2026-08-12T12:00:00.000Z",
    updatedAt,
  };
}

function queuedAction(): PersistedAction {
  return PersistedActionSchema.parse({
    contractVersion: 1,
    engagementId: ENGAGEMENT_ID,
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
          canonicalTargets: [ipv4Target],
          concreteDestinations: [ipv4Target],
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

const readyStatus = { version: 1, overall: "ready", developmentStorage: "ready" };

function pausedAction(): PersistedAction {
  const queued = queuedAction();
  return PersistedActionSchema.parse({
    ...queued,
    action: {
      ...queued.action,
      state: "paused_for_warning",
      queuedSnapshotVersion: null,
      pendingWarning: { reasonCodes: ["outside_scope"], knownAdditions: [], pendingEventId: null },
      snapshots: queued.action.snapshots.map((snapshot) => ({
        ...snapshot,
        warningState: { reasonCodes: ["outside_scope"], knownAdditions: [], acknowledgment: null },
      })),
    },
  });
}
const unconfiguredAdvisor = {
  configured: false,
  endpointReachable: null,
  modelId: "",
  endpointHost: "",
  publicEndpoint: false,
  optIn: false,
  keyEnvVar: "",
  keyPresent: false,
  latencyMs: null,
  reason: "unconfigured",
};

function response(payload: unknown, status = 200): Response {
  return {
    json: async () => payload,
    ok: status >= 200 && status < 300,
    status,
  } as Response;
}

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    return Promise.resolve(handler(String(input), init));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function openingHandler() {
  const first = listedEngagement(ENGAGEMENT_ID, "First lab", "2026-08-12T12:00:00.000Z");
  const second = listedEngagement(OTHER_ID, "Second lab", "2026-08-12T13:00:00.000Z");
  return (url: string, init?: RequestInit) => {
    if (url.includes("/api/v1/system/status")) return response(readyStatus);
    if (url.includes("/api/v1/advisor/status")) return response(unconfiguredAdvisor);
    if (url === "/api/v1/engagements" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { name: string; kind: string };
      return response({ ...first, name: body.name, kind: body.kind }, 201);
    }
    if (url === "/api/v1/engagements") return response([first, second]);
    if (url === `/api/v1/engagements/${ENGAGEMENT_ID}/actions` && init?.method === "POST") {
      return response(queuedAction(), 201);
    }
    if (url === `/api/v1/engagements/${ENGAGEMENT_ID}`) {
      return response({ engagement: first, activeScopeRevision: null });
    }
    if (url.includes("/runs/latest/output")) {
      return response({ code: "no_terminal_run" }, 404);
    }
    if (url.includes("/runs")) {
      return response({ runs: [], nextCursor: null });
    }
    if (url.includes("/services") || url.includes("/http-probes") || url.includes("/ffuf-results")) {
      return response([]);
    }
    return response({ code: "invalid_request" }, 400);
  };
}

const testQueryClients = new Set<QueryClient>();

async function renderOpening(initialEntry = "/") {
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

describe("opening screen", () => {
  it("favors Resume and Start with no stats dashboard", async () => {
    stubFetch(openingHandler());
    window.localStorage.setItem("stonehush.lastEngagementId", OTHER_ID);
    await renderOpening();

    expect(await screen.findByRole("heading", { name: "Resume" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Start with a target" })).toBeTruthy();
    const main = document.querySelector("main");
    expect(main).not.toBeNull();
    expect(within(main as HTMLElement).getByRole("link", { name: "Second lab" })).toBeTruthy();
    expect(screen.queryByText("Control plane")).toBeNull();
    expect(screen.queryByText("System ready")).toBeNull();
    expect(await screen.findByText("Control plane: ready.")).toBeTruthy();
    expect(
      await screen.findByText("Advisor: not set up. Manual work is unaffected."),
    ).toBeTruthy();
    expect(
      within(main as HTMLElement).queryByText("Advisor is not configured"),
    ).toBeNull();
  });

  it("resumes the most recent engagement without a stored id", async () => {
    stubFetch(openingHandler());
    await renderOpening();

    const main = document.querySelector("main");
    expect(await screen.findByRole("heading", { name: "Resume" })).toBeTruthy();
    expect(within(main as HTMLElement).getByRole("link", { name: "Second lab" })).toBeTruthy();
  });

  it("starts a scan from a pasted IP and reopens the same work", async () => {
    const fetchMock = stubFetch(openingHandler());
    const { queryClient, router } = await renderOpening();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    fireEvent.change(await screen.findByLabelText("Target"), {
      target: { value: "192.0.2.10" },
    });
    const form = screen.getByRole("button", { name: "Start scan" }).closest("form");
    if (!form) throw new Error("Start scan form is missing.");
    fireEvent.submit(form);

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/engagements/${ENGAGEMENT_ID}`),
    );
    const createCall = fetchMock.mock.calls.find(
      ([url, init]) => url === "/api/v1/engagements" && init?.method === "POST",
    );
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({
      name: "Lab 192-0-2-10",
      kind: "ctf",
    });
    const actionCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/actions"));
    expect(JSON.parse(String(actionCall?.[1]?.body))).toMatchObject({
      targets: ["192.0.2.10"],
      declaredPorts: null,
    });
    expect(window.localStorage.getItem("stonehush.lastEngagementId")).toBe(ENGAGEMENT_ID);
    // The readiness summary reads run history, so the start refreshes it.
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["engagements", ENGAGEMENT_ID, "runs"],
    });
  });

  it("rejects an empty start without posting", async () => {
    const fetchMock = stubFetch(openingHandler());
    await renderOpening();

    const form = (await screen.findByRole("button", { name: "Start scan" })).closest("form");
    if (!form) throw new Error("Start scan form is missing.");
    fireEvent.submit(form);

    expect(await screen.findByText("Enter at least one target.")).toBeTruthy();
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(0);
  });

  it("does not reuse a previous target after reload", async () => {
    stubFetch(openingHandler());
    const first = await renderOpening();

    fireEvent.change(await screen.findByLabelText("Target"), {
      target: { value: "192.0.2.10" },
    });
    expect((screen.getByLabelText("Target") as HTMLTextAreaElement).value).toBe("192.0.2.10");
    first.unmount();

    await renderOpening();
    expect((await screen.findByLabelText("Target") as HTMLTextAreaElement).value).toBe("");
  });

  it("carries a paused first scan into the planner through the action search", async () => {
    const base = openingHandler();
    stubFetch((url, init) => {
      if (url === `/api/v1/engagements/${ENGAGEMENT_ID}/actions` && init?.method === "POST") {
        return response(pausedAction(), 201);
      }
      return base(url, init);
    });
    const { router } = await renderOpening();

    fireEvent.change(await screen.findByLabelText("Target"), {
      target: { value: "192.0.2.10" },
    });
    const form = screen.getByRole("button", { name: "Start scan" }).closest("form");
    if (!form) throw new Error("Start scan form is missing.");
    fireEvent.submit(form);

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/engagements/${ENGAGEMENT_ID}`),
    );
    expect(router.state.location.search).toMatchObject({ action: ACTION_ID });
  });

  it("retries the scan on the same engagement instead of creating a second one", async () => {
    const base = openingHandler();
    let actionCalls = 0;
    const fetchMock = stubFetch((url, init) => {
      if (url === `/api/v1/engagements/${ENGAGEMENT_ID}/actions` && init?.method === "POST") {
        actionCalls += 1;
        if (actionCalls === 1) return response({ code: "storage_busy" }, 503);
        return response(queuedAction(), 201);
      }
      return base(url, init);
    });
    const { router } = await renderOpening();

    fireEvent.change(await screen.findByLabelText("Target"), {
      target: { value: "192.0.2.10" },
    });
    const form = screen.getByRole("button", { name: "Start scan" }).closest("form");
    if (!form) throw new Error("Start scan form is missing.");
    fireEvent.submit(form);

    expect(await screen.findByText("Storage is busy. Try again.")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/");
    fireEvent.submit(form);

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/engagements/${ENGAGEMENT_ID}`),
    );
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => url === "/api/v1/engagements" && init?.method === "POST",
      ),
    ).toHaveLength(1);
    expect(actionCalls).toBe(2);
  });

  it("refreshes the engagement revision after a scan conflict and still creates once", async () => {
    const base = openingHandler();
    let actionCalls = 0;
    const fetchMock = stubFetch((url, init) => {
      if (url === `/api/v1/engagements/${ENGAGEMENT_ID}/actions` && init?.method === "POST") {
        actionCalls += 1;
        if (actionCalls === 1) {
          return response(
            {
              code: "revision_conflict",
              resourceType: "engagement",
              resourceId: ENGAGEMENT_ID,
              currentRevision: 5,
            },
            409,
          );
        }
        return response(queuedAction(), 201);
      }
      // The conflict refresh refetches detail for both revision and scope.
      if (url === `/api/v1/engagements/${ENGAGEMENT_ID}` && init?.method !== "POST") {
        const first = listedEngagement(ENGAGEMENT_ID, "First lab", "2026-08-12T12:00:00.000Z");
        return response({
          engagement: {
            ...first,
            revision: 5,
            activeScopeRevisionId: SCOPE_ID,
            updatedAt: "2026-08-12T12:07:00.000Z",
          },
          activeScopeRevision: {
            contractVersion: 1,
            id: SCOPE_ID,
            engagementId: ENGAGEMENT_ID,
            version: 2,
            rules: [],
            createdAt: "2026-08-12T12:07:00.000Z",
          },
        });
      }
      return base(url, init);
    });
    const { router } = await renderOpening();

    fireEvent.change(await screen.findByLabelText("Target"), {
      target: { value: "192.0.2.10" },
    });
    const form = screen.getByRole("button", { name: "Start scan" }).closest("form");
    if (!form) throw new Error("Start scan form is missing.");
    fireEvent.submit(form);

    expect(await screen.findByText("This engagement changed. Showing the latest revision.")).toBeTruthy();
    fireEvent.submit(form);

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/engagements/${ENGAGEMENT_ID}`),
    );
    const actionBodies = fetchMock.mock.calls
      .filter(([url, init]) => String(url).endsWith("/actions") && init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(actionBodies).toHaveLength(2);
    expect(actionBodies[1]).toMatchObject({
      expectedEngagementRevision: 5,
      expectedActiveScopeRevisionId: SCOPE_ID,
    });
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => url === "/api/v1/engagements" && init?.method === "POST",
      ),
    ).toHaveLength(1);
  });

  it("offers Retry status when the control plane store is not ready", async () => {
    const base = openingHandler();
    stubFetch((url, init) => {
      if (url.includes("/api/v1/system/status")) {
        return response(
          { version: 1, overall: "not_ready", developmentStorage: "not_ready" },
          503,
        );
      }
      return base(url, init);
    });
    await renderOpening();

    expect(
      await screen.findByText("Control plane: storage not ready. Queued work waits."),
    ).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Retry status" })).toBeTruthy();
  });

  it("reuses the engagement key when the first response is lost after commit", async () => {
    const base = openingHandler();
    const committed = new Map<string, unknown>();
    let engagementCommits = 0;
    let loseFirst = true;
    const fetchMock = stubFetch((url, init) => {
      if (url === "/api/v1/engagements" && init?.method === "POST") {
        const key = String((init.headers as Record<string, string>)["Idempotency-Key"]);
        if (committed.has(key)) return response(committed.get(key), 201);
        const body = JSON.parse(String(init.body)) as { name: string; kind: string };
        const first = listedEngagement(ENGAGEMENT_ID, body.name, "2026-08-12T12:00:00.000Z");
        committed.set(key, { ...first, kind: body.kind });
        engagementCommits += 1;
        // Server committed but the response never arrived.
        if (loseFirst) {
          loseFirst = false;
          throw new Error("offline");
        }
        return response(committed.get(key), 201);
      }
      return base(url, init);
    });
    const { router } = await renderOpening();

    fireEvent.change(await screen.findByLabelText("Target"), {
      target: { value: "192.0.2.10" },
    });
    const form = screen.getByRole("button", { name: "Start scan" }).closest("form");
    if (!form) throw new Error("Start scan form is missing.");
    fireEvent.submit(form);

    expect(await screen.findByText("The engagement request failed.")).toBeTruthy();
    fireEvent.submit(form);

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/engagements/${ENGAGEMENT_ID}`),
    );
    expect(engagementCommits).toBe(1);
    const keys = fetchMock.mock.calls
      .filter(([url, init]) => url === "/api/v1/engagements" && init?.method === "POST")
      .map(([, init]) => String((init?.headers as Record<string, string>)["Idempotency-Key"]));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("reuses the action key when the action response is lost after commit", async () => {
    const base = openingHandler();
    const committed = new Map<string, unknown>();
    let actionCommits = 0;
    let loseFirst = true;
    const fetchMock = stubFetch((url, init) => {
      if (url === `/api/v1/engagements/${ENGAGEMENT_ID}/actions` && init?.method === "POST") {
        const key = String((init.headers as Record<string, string>)["Idempotency-Key"]);
        if (committed.has(key)) return response(committed.get(key), 201);
        committed.set(key, queuedAction());
        actionCommits += 1;
        if (loseFirst) {
          loseFirst = false;
          throw new Error("offline");
        }
        return response(queuedAction(), 201);
      }
      return base(url, init);
    });
    const { router } = await renderOpening();

    fireEvent.change(await screen.findByLabelText("Target"), {
      target: { value: "192.0.2.10" },
    });
    const form = screen.getByRole("button", { name: "Start scan" }).closest("form");
    if (!form) throw new Error("Start scan form is missing.");
    fireEvent.submit(form);

    expect(await screen.findByText("The engagement request failed.")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/");
    fireEvent.submit(form);

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/engagements/${ENGAGEMENT_ID}`),
    );
    expect(actionCommits).toBe(1);
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => url === "/api/v1/engagements" && init?.method === "POST",
      ),
    ).toHaveLength(1);
    const keys = fetchMock.mock.calls
      .filter(([url, init]) => String(url).endsWith("/actions") && init?.method === "POST")
      .map(([, init]) => String((init?.headers as Record<string, string>)["Idempotency-Key"]));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("uses a new action key when the retry targets change", async () => {
    const base = openingHandler();
    let actionCalls = 0;
    const fetchMock = stubFetch((url, init) => {
      if (url === `/api/v1/engagements/${ENGAGEMENT_ID}/actions` && init?.method === "POST") {
        actionCalls += 1;
        if (actionCalls === 1) return response({ code: "storage_busy" }, 503);
        return response(queuedAction(), 201);
      }
      return base(url, init);
    });
    const { router } = await renderOpening();

    fireEvent.change(await screen.findByLabelText("Target"), {
      target: { value: "192.0.2.10" },
    });
    const form = screen.getByRole("button", { name: "Start scan" }).closest("form");
    if (!form) throw new Error("Start scan form is missing.");
    fireEvent.submit(form);

    expect(await screen.findByText("Storage is busy. Try again.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Target"), {
      target: { value: "198.51.100.25" },
    });
    fireEvent.submit(form);

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/engagements/${ENGAGEMENT_ID}`),
    );
    const actionCallsList = fetchMock.mock.calls.filter(
      ([url, init]) => String(url).endsWith("/actions") && init?.method === "POST",
    );
    expect(actionCallsList).toHaveLength(2);
    const keys = actionCallsList.map(([, init]) =>
      String((init?.headers as Record<string, string>)["Idempotency-Key"]),
    );
    expect(keys[0]).not.toBe(keys[1]);
    const bodies = actionCallsList.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies[1]).toMatchObject({ targets: ["198.51.100.25"] });
  });

  it("blocks a second submit while the first start is in flight", async () => {
    const base = openingHandler();
    let engagementPosts = 0;
    let release!: (value: Response) => void;
    stubFetch((url, init) => {
      if (url === "/api/v1/engagements" && init?.method === "POST") {
        engagementPosts += 1;
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return base(url, init);
    });
    await renderOpening();

    fireEvent.change(await screen.findByLabelText("Target"), {
      target: { value: "192.0.2.10" },
    });
    const form = screen.getByRole("button", { name: "Start scan" }).closest("form");
    if (!form) throw new Error("Start scan form is missing.");
    fireEvent.submit(form);

    expect(await screen.findByRole("button", { name: "Starting" })).toBeTruthy();
    fireEvent.submit(form);
    expect(engagementPosts).toBe(1);
    release(response(listedEngagement(ENGAGEMENT_ID, "Lab 192-0-2-10", "2026-08-12T12:00:00.000Z"), 201));
    await waitFor(() => expect(engagementPosts).toBe(1));
  });

  it("locks persisted name and type after partial creation with a recovery link", async () => {
    const base = openingHandler();
    let actionCalls = 0;
    stubFetch((url, init) => {
      if (url === `/api/v1/engagements/${ENGAGEMENT_ID}/actions` && init?.method === "POST") {
        actionCalls += 1;
        if (actionCalls === 1) return response({ code: "storage_busy" }, 503);
        return response(queuedAction(), 201);
      }
      return base(url, init);
    });
    await renderOpening();

    fireEvent.change(await screen.findByLabelText("Target"), {
      target: { value: "192.0.2.10" },
    });
    const form = screen.getByRole("button", { name: "Start scan" }).closest("form");
    if (!form) throw new Error("Start scan form is missing.");
    fireEvent.submit(form);

    expect(await screen.findByText("Storage is busy. Try again.")).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Type") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText("Target") as HTMLTextAreaElement).disabled).toBe(false);
    expect(await screen.findByText(/is created/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open engagement" })).toBeTruthy();
  });

  it("shows Retry status for advisor probe failures", async () => {
    const base = openingHandler();
    for (const reason of ["unreachable", "probe_failed"] as const) {
      cleanup();
      stubFetch((url, init) => {
        if (url.includes("/api/v1/advisor/status")) {
          return response({ ...unconfiguredAdvisor, reason });
        }
        return base(url, init);
      });
      await renderOpening();
      expect(await screen.findByText("Advisor: endpoint not answering. Manual work is unaffected.")).toBeTruthy();
      expect(await screen.findByRole("button", { name: "Retry status" })).toBeTruthy();
    }
  });
});
