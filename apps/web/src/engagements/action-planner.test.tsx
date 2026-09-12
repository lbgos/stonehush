// @vitest-environment jsdom

import { PersistedActionSchema, type PersistedAction } from "@stonehush/contracts";
import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { createAppRouter } from "../router.js";
import { browserStorage, readFirstActionDefaults } from "./first-action.js";

const activeEngagement = {
  contractVersion: 1,
  id: "10000000-0000-4000-8000-000000000001",
  revision: 2,
  name: "Target lab",
  kind: "lab",
  status: "active",
  description: "Synthetic reserved lab",
  authorizationContext: null,
  autoContinueWarnings: false,
  activeScopeRevisionId: "20000000-0000-4000-8000-000000000010",
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
  revision: 3,
  activeScopeRevisionId: null,
};

const emptyRevision = {
  contractVersion: 1,
  id: "20000000-0000-4000-8000-000000000010",
  engagementId: activeEngagement.id,
  version: 1,
  rules: [],
  createdAt: "2026-08-12T12:06:00.000Z",
};

const ACTION_ID = "40000000-0000-4000-8000-000000000001";
const SNAPSHOT_ID = "40000000-0000-4000-8000-000000000002";
const BINDING = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const ipv4Target = {
  kind: "ip" as const,
  normalizationProfile: "d1-v1" as const,
  family: 4 as const,
  address: "192.0.2.10",
  zone: null,
};

const readyStatus = { version: 1, overall: "ready", developmentStorage: "ready" };

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

type TestEngagement = {
  contractVersion: number;
  id: string;
  revision: number;
  name: string;
  kind: string;
  status: string;
  description: string | null;
  authorizationContext: null;
  autoContinueWarnings: boolean;
  activeScopeRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
};

function readResponse(
  url: string,
  engagement: TestEngagement,
  revision: typeof emptyRevision | null,
): Response | undefined {
  if (url.includes("/system/status")) return response(readyStatus);
  if (url === "/api/v1/engagements") return response([engagement]);
  if (url.includes("/services") || url.includes("/http-probes")) return response([]);
  if (url === `/api/v1/engagements/${engagement.id}`) {
    return response({
      engagement: {
        ...engagement,
        activeScopeRevisionId: revision?.id ?? null,
      },
      activeScopeRevision: revision,
    });
  }
  return undefined;
}

function snapshotFields(state: PersistedAction["action"]["state"]) {
  return {
    normalizationProfile: "d1-v1" as const,
    orchestrationProfile: "d2-v1" as const,
    snapshotId: SNAPSHOT_ID,
    version: 1,
    binding: BINDING,
    actionId: ACTION_ID,
    canonicalTargets: [ipv4Target],
    concreteDestinations: [ipv4Target],
    typedOptions: { declaredPorts: null },
    resolutionSnapshots: [],
    scopeRevisionId: emptyRevision.id,
    warningState: {
      reasonCodes: state === "paused_for_warning" ? ["outside_scope"] : [],
      knownAdditions: [],
      acknowledgment: null,
    },
  };
}

function persistedAction(
  state: PersistedAction["action"]["state"],
  extras: Record<string, unknown> = {},
): PersistedAction {
  const acknowledgment = extras.warningAcknowledgment ?? null;
  return PersistedActionSchema.parse({
    contractVersion: 1,
    engagementId: activeEngagement.id,
    revision: extras.queuedSnapshotVersion === 2 ? 2 : 1,
    warningAcknowledgmentId: acknowledgment === null ? null : "ack-1",
    createdAt: "2026-08-12T12:10:00.000Z",
    updatedAt: "2026-08-12T12:10:00.000Z",
    action: {
      orchestrationProfile: "d2-v1",
      actionId: ACTION_ID,
      state,
      snapshots: [snapshotFields(state)],
      queuedSnapshotVersion: state === "queued" ? 1 : null,
      warningAcknowledgment: acknowledgment,
      pendingWarning:
        state === "paused_for_warning"
          ? { reasonCodes: ["outside_scope"], knownAdditions: [], pendingEventId: null }
          : null,
      coveredDestinations: [],
      warningInteractions: acknowledgment === null ? 0 : 1,
      runState: null,
      resumeRequested: false,
      cleanupRequired: false,
      capabilityErrorCode: state === "capability_error" ? "target_set_unrepresentable" : null,
      ...extras,
    },
  });
}

function operatorContinueAck() {
  return {
    actionId: ACTION_ID,
    snapshotId: SNAPSHOT_ID,
    snapshotVersion: 1,
    snapshotBinding: BINDING,
    scopeRevisionId: emptyRevision.id,
    reasonCodes: ["outside_scope"],
    knownAdditions: [],
    source: "operator_continue" as const,
    acknowledgedAt: "2026-08-12T12:11:00.000Z",
    pendingEventId: null,
    coveredDestinations: [],
  };
}

const testQueryClients = new Set<QueryClient>();

async function renderPlanner(engagement: TestEngagement = activeEngagement, search = "") {
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: [`/engagements/${engagement.id}${search}`] }),
  );
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

async function planTarget(value = "192.0.2.10") {
  const field = await screen.findByLabelText("Targets");
  fireEvent.change(field, { target: { value } });
  fireEvent.submit(screen.getByRole("button", { name: "Plan action" }).closest("form")!);
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

describe("action planner", () => {
  it("queues an in-scope plan without a warning card", async () => {
    const noScope = { ...activeEngagement, revision: 1, activeScopeRevisionId: null };
    const queued = persistedAction("queued");
    const fetchMock = stubFetch((url, init) => {
      if (url.endsWith("/actions") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toMatchObject({
          expectedEngagementRevision: 1,
          expectedActiveScopeRevisionId: null,
          targets: ["192.0.2.10"],
          declaredPorts: null,
        });
        return response(queued, 201);
      }
      return readResponse(url, noScope, null) ?? response({ code: "invalid_request" }, 400);
    });

    await renderPlanner(noScope);
    expect(await screen.findByRole("heading", { name: "Runs" })).toBeTruthy();
    await planTarget();

    expect(await screen.findByText(/Action queued/)).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Action needs a warning" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(
      fetchMock.mock.calls.some(([called]) => String(called).includes("/scope-revisions")),
    ).toBe(false);
  });

  it("shows one outside-scope warning and Continue queues without rewriting scope", async () => {
    const paused = persistedAction("paused_for_warning");
    const queued = persistedAction("queued", {
      warningAcknowledgment: operatorContinueAck(),
    });
    const fetchMock = stubFetch((url, init) => {
      if (url.endsWith("/actions") && init?.method === "POST") {
        return response(paused, 201);
      }
      if (url.endsWith(`/actions/${ACTION_ID}/continue`) && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({
          expectedRevision: 1,
          snapshotVersion: 1,
          snapshotBinding: BINDING,
        });
        return response(queued);
      }
      return readResponse(url, activeEngagement, emptyRevision) ?? response({ code: "invalid_request" }, 400);
    });

    await renderPlanner();
    expect(await screen.findByRole("heading", { name: "Runs" })).toBeTruthy();
    await planTarget();

    const dialog = await screen.findByRole("dialog", { name: "Action needs a warning" });
    expect(within(dialog).getByText(/outside the saved scope/)).toBeTruthy();
    expect(within(dialog).getByText(/One acknowledgment covers the whole action/)).toBeTruthy();
    expect(within(dialog).getAllByRole("button", { name: "Continue" })).toHaveLength(1);
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Continue" }));

    fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
    expect(await screen.findByText(/Saved scope was not changed/)).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Action needs a warning" })).toBeNull();
    expect(
      fetchMock.mock.calls.filter(([called]) => String(called).includes("/scope-revisions")),
    ).toHaveLength(0);
    expect(
      fetchMock.mock.calls.filter(([called]) => String(called).includes("/add-scope-and-run")),
    ).toHaveLength(0);
  });

  it("posts add-scope-and-run and queues without a second prompt", async () => {
    const paused = persistedAction("paused_for_warning");
    const queued = persistedAction("queued", {
      queuedSnapshotVersion: 2,
      snapshots: [
        snapshotFields("paused_for_warning"),
        {
          ...snapshotFields("queued"),
          version: 2,
          snapshotId: "40000000-0000-4000-8000-000000000003",
          binding: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          scopeRevisionId: "20000000-0000-4000-8000-000000000011",
        },
      ],
      warningAcknowledgment: {
        ...operatorContinueAck(),
        source: "add_scope_and_run",
        snapshotId: "40000000-0000-4000-8000-000000000003",
        snapshotVersion: 2,
        snapshotBinding: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        scopeRevisionId: "20000000-0000-4000-8000-000000000011",
        reasonCodes: [],
      },
    });
    const fetchMock = stubFetch((url, init) => {
      if (url.endsWith("/actions") && init?.method === "POST") return response(paused, 201);
      if (url.endsWith(`/actions/${ACTION_ID}/add-scope-and-run`) && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          expectedEngagementRevision: number;
          expectedActionRevision: number;
          rules: Array<{ kind: string; target?: { address?: string } }>;
        };
        expect(body.expectedEngagementRevision).toBe(2);
        expect(body.expectedActionRevision).toBe(1);
        expect(body.rules).toHaveLength(1);
        expect(body.rules[0]?.kind).toBe("ip");
        expect(body.rules[0]?.target?.address).toBe("192.0.2.10");
        return response(queued);
      }
      return readResponse(url, activeEngagement, emptyRevision) ?? response({ code: "invalid_request" }, 400);
    });

    await renderPlanner();
    await planTarget();
    const dialog = await screen.findByRole("dialog", { name: "Action needs a warning" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add to scope & run" }));

    expect(await screen.findByText(/A new saved-scope revision was created/)).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Action needs a warning" })).toBeNull();
    expect(
      fetchMock.mock.calls.filter(([called]) => String(called).includes("/add-scope-and-run")),
    ).toHaveLength(1);
  });

  it("reuses the add-scope-and-run idempotency key across an ordinary retry", async () => {
    const paused = persistedAction("paused_for_warning");
    const queued = persistedAction("queued", {
      queuedSnapshotVersion: 2,
      snapshots: [
        snapshotFields("paused_for_warning"),
        {
          ...snapshotFields("queued"),
          version: 2,
          snapshotId: "40000000-0000-4000-8000-000000000003",
          binding: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          scopeRevisionId: "20000000-0000-4000-8000-000000000011",
        },
      ],
      warningAcknowledgment: {
        ...operatorContinueAck(),
        source: "add_scope_and_run",
        snapshotId: "40000000-0000-4000-8000-000000000003",
        snapshotVersion: 2,
        snapshotBinding: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        scopeRevisionId: "20000000-0000-4000-8000-000000000011",
        reasonCodes: [],
      },
    });
    let addCalls = 0;
    const fetchMock = stubFetch((url, init) => {
      if (url.endsWith("/actions") && init?.method === "POST") return response(paused, 201);
      if (url.endsWith(`/actions/${ACTION_ID}/add-scope-and-run`) && init?.method === "POST") {
        addCalls += 1;
        if (addCalls === 1) return Promise.reject(new Error("offline"));
        return response(queued);
      }
      return readResponse(url, activeEngagement, emptyRevision) ?? response({ code: "invalid_request" }, 400);
    });

    await renderPlanner();
    await planTarget();
    const dialog = await screen.findByRole("dialog", { name: "Action needs a warning" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add to scope & run" }));
    expect(await screen.findByText("The engagement request failed.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add to scope & run" }));
    expect(await screen.findByText(/A new saved-scope revision was created/)).toBeTruthy();

    const addRequests = fetchMock.mock.calls.filter(([called]) =>
      String(called).includes("/add-scope-and-run"),
    );
    expect(addRequests).toHaveLength(2);
    const keys = addRequests.map(([, init]) => (init?.headers as Record<string, string>)["Idempotency-Key"]);
    expect(keys[0]).toBe(keys[1]);
    expect(JSON.parse(String(addRequests[0]?.[1]?.body))).toEqual(
      JSON.parse(String(addRequests[1]?.[1]?.body)),
    );
  });

  it("cancels a paused action without fabricating an acknowledgment", async () => {
    const paused = persistedAction("paused_for_warning");
    const cancelled = persistedAction("cancelled");
    const fetchMock = stubFetch((url, init) => {
      if (url.endsWith("/actions") && init?.method === "POST") return response(paused, 201);
      if (url.endsWith(`/actions/${ACTION_ID}/cancel`) && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ expectedRevision: 1 });
        expect(cancelled.action.warningAcknowledgment).toBeNull();
        return response(cancelled);
      }
      return readResponse(url, activeEngagement, emptyRevision) ?? response({ code: "invalid_request" }, 400);
    });

    await renderPlanner();
    await planTarget();
    const dialog = await screen.findByRole("dialog", { name: "Action needs a warning" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(await screen.findByText(/No warning acknowledgment was recorded/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      fetchMock.mock.calls.filter(([called]) => String(called).includes("/cancel")),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(([called]) => String(called).includes("/continue")),
    ).toHaveLength(0);
  });

  it("rejects malformed and duplicate targets without posting", async () => {
    const fetchMock = stubFetch((url, init) => {
      if (init?.method === "POST") return response({ code: "invalid_request" }, 400);
      return readResponse(url, activeEngagement, emptyRevision) ?? response({ code: "invalid_request" }, 400);
    });

    await renderPlanner();
    const field = await screen.findByLabelText("Targets");
    const form = field.closest("form");
    expect(form).toBeTruthy();

    fireEvent.change(field, { target: { value: "not a target" } });
    fireEvent.submit(form!);
    expect(await screen.findByText("Enter a valid IP, CIDR, hostname, or HTTP(S) URL.")).toBeTruthy();

    fireEvent.change(field, { target: { value: "192.0.2.10, 192.0.2.10" } });
    fireEvent.submit(form!);
    expect(await screen.findByText("Duplicate targets are not allowed.")).toBeTruthy();

    fireEvent.change(field, { target: { value: " \n " } });
    fireEvent.submit(form!);
    expect(await screen.findByText("Enter at least one target.")).toBeTruthy();

    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(0);
  });

  it("disables planning on an archived engagement", async () => {
    stubFetch(
      (url, init) =>
        readResponse(url, archivedEngagement, null) ??
        (init?.method === "POST"
          ? response({ code: "engagement_archived" }, 409)
          : response({ code: "invalid_request" }, 400)),
    );

    await renderPlanner(archivedEngagement);
    expect(await screen.findByText(/Actions cannot be planned/)).toBeTruthy();
    expect(screen.getByLabelText("Targets")).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Plan action" })).toHaveProperty("disabled", true);
  });

  it("shows a capability error without offering Continue", async () => {
    const failed = persistedAction("capability_error");
    stubFetch((url, init) => {
      if (url.endsWith("/actions") && init?.method === "POST") return response(failed, 201);
      return readResponse(url, { ...activeEngagement, revision: 1, activeScopeRevisionId: null }, null) ??
        response({ code: "invalid_request" }, 400);
    });

    await renderPlanner({ ...activeEngagement, revision: 1, activeScopeRevisionId: null });
    await planTarget();

    expect(await screen.findByRole("heading", { name: "This action cannot run" })).toBeTruthy();
    expect(screen.getByText(/cannot be represented/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Action needs a warning" })).toBeNull();
    // A DNS-style planning failure is not an Nmap outage: no Nmap diagnosis.
    expect(screen.queryByText(/cannot run as an Nmap scan/)).toBeNull();
  });

  it("continues on Enter and cancels on Escape from the warning card", async () => {
    const paused = persistedAction("paused_for_warning");
    const cancelled = persistedAction("cancelled");
    const queued = persistedAction("queued", {
      warningAcknowledgment: operatorContinueAck(),
    });
    let continueCount = 0;
    stubFetch((url, init) => {
      if (url.endsWith("/actions") && init?.method === "POST") return response(paused, 201);
      if (url.endsWith("/continue") && init?.method === "POST") {
        continueCount += 1;
        return response(queued);
      }
      if (url.endsWith("/cancel") && init?.method === "POST") return response(cancelled);
      return readResponse(url, activeEngagement, emptyRevision) ?? response({ code: "invalid_request" }, 400);
    });

    await renderPlanner();
    await planTarget();
    const dialog = await screen.findByRole("dialog", { name: "Action needs a warning" });
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(await screen.findByText(/Saved scope was not changed/)).toBeTruthy();
    expect(continueCount).toBe(1);

    await planTarget("198.51.100.10");
    const nextDialog = await screen.findByRole("dialog", { name: "Action needs a warning" });
    fireEvent.keyDown(nextDialog, { key: "Escape" });
    expect(await screen.findByText(/No warning acknowledgment was recorded/)).toBeTruthy();
  });

  it("refreshes after a revision conflict and shows the existing copy", async () => {
    const newer = { ...activeEngagement, revision: 5 };
    let current = activeEngagement;
    stubFetch((url, init) => {
      if (url.endsWith("/actions") && init?.method === "POST") {
        current = newer;
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
      return readResponse(url, current, emptyRevision) ?? response({ code: "invalid_request" }, 400);
    });

    await renderPlanner();
    expect(await screen.findByText("rev 2")).toBeTruthy();
    await planTarget();
    expect(
      await screen.findByText("This engagement changed. Showing the latest revision."),
    ).toBeTruthy();
    await waitFor(() => expect(screen.getByText("rev 5")).toBeTruthy());
    expect(screen.queryByRole("dialog", { name: "Action needs a warning" })).toBeNull();
  });

  it("normalizes unsorted duplicate TCP ports into sorted unique array", async () => {
    const queued = persistedAction("queued");
    stubFetch((url, init) => {
      if (url.endsWith("/actions") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toMatchObject({ declaredPorts: [22, 80, 443] });
        return response(queued, 201);
      }
      return readResponse(url, { ...activeEngagement, revision: 1, activeScopeRevisionId: null }, null) ?? response({ code: "invalid_request" }, 400);
    });

    await renderPlanner({ ...activeEngagement, revision: 1, activeScopeRevisionId: null });
    fireEvent.click(await screen.findByRole("radio", { name: /Fuller port pass/ }));
    const targetsField = await screen.findByLabelText("Targets");
    const portsField = await screen.findByLabelText(/^TCP ports/i);
    expect(portsField.getAttribute("placeholder")).toBe("22,80,443");
    fireEvent.change(targetsField, { target: { value: "192.0.2.10" } });
    fireEvent.change(portsField, { target: { value: "443,80,80,22" } });
    fireEvent.submit(screen.getByRole("button", { name: "Plan action" }).closest("form")!);
    expect(await screen.findByText(/Action queued/)).toBeTruthy();
  });

  it("rejects malformed TCP ports without posting", async () => {
    const fetchMock = stubFetch((url, init) => {
      if (init?.method === "POST") return response({ code: "invalid_request" }, 400);
      return readResponse(url, activeEngagement, emptyRevision) ?? response({ code: "invalid_request" }, 400);
    });

    await renderPlanner();
    fireEvent.click(await screen.findByRole("radio", { name: /Fuller port pass/ }));
    const portsField = await screen.findByLabelText(/^TCP ports/i);
    const form = portsField.closest("form")!;
    fireEvent.change(await screen.findByLabelText("Targets"), { target: { value: "192.0.2.10" } });

    for (const value of ["80,,443", "0", "65536", "80a", "80, 443,", "-1"]) {
      fireEvent.change(portsField, { target: { value } });
      fireEvent.submit(form);
      expect(await screen.findByText("Enter comma-separated ports 1-65535, for example 22,80,443.")).toBeTruthy();
    }
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("polls the current action to succeeded and invalidates services once", async () => {
    const noScope = { ...activeEngagement, revision: 1, activeScopeRevisionId: null };
    const queued = persistedAction("queued");
    const succeeded = persistedAction("succeeded", { queuedSnapshotVersion: 1, runState: null });
    const fetchMock = stubFetch((url, init) => {
      if (url.endsWith("/actions") && init?.method === "POST") return response(queued, 201);
      if (url.includes(`/actions/${ACTION_ID}`) && (init?.method === undefined || init?.method === "GET")) return response(succeeded);
      if (url.includes("/services") || url.includes("/http-probes")) return response([]);
      return readResponse(url, noScope, null) ?? response({ code: "invalid_request" }, 400);
    });
    const { queryClient } = await renderPlanner(noScope);
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await planTarget();
    expect(await screen.findByText(/Action succeeded/)).toBeTruthy();
    await waitFor(() => expect(spy.mock.calls.some(([a]) => JSON.stringify((a as { queryKey?: unknown })?.queryKey).includes("services"))).toBe(true));
    expect(spy.mock.calls.filter(([a]) => JSON.stringify((a as { queryKey?: unknown })?.queryKey).includes("services"))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes(`/actions/${ACTION_ID}`))).toHaveLength(1);
  });

  it("preserves queued state on failed poll, hides error while retrying, and shows succeeded after Refresh", async () => {
    const noScope = { ...activeEngagement, revision: 1, activeScopeRevisionId: null };
    const queued = persistedAction("queued");
    const succeeded = persistedAction("succeeded", { queuedSnapshotVersion: 1, runState: null });
    let pollCalls = 0;
    let releaseSecondPoll: ((value: Response) => void) | undefined;
    const fetchMock = stubFetch((url, init) => {
      if (url.endsWith("/actions") && init?.method === "POST") return response(queued, 201);
      if (url.includes(`/actions/${ACTION_ID}`) && (init?.method === undefined || init?.method === "GET")) {
        pollCalls += 1;
        if (pollCalls === 1) return response({ code: "request_failed" }, 500);
        if (pollCalls === 2) {
          return new Promise<Response>((resolve) => {
            releaseSecondPoll = resolve;
          });
        }
        return response(succeeded);
      }
      if (url.includes("/services") || url.includes("/http-probes")) return response([]);
      return readResponse(url, noScope, null) ?? response({ code: "invalid_request" }, 400);
    });
    const { queryClient } = await renderPlanner(noScope);
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await planTarget();
    expect(await screen.findByText(/Action queued/)).toBeTruthy();
    expect(await screen.findByText("Status update failed.")).toBeTruthy();
    expect(screen.queryByText(/Action succeeded/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.queryByText("Status update failed.")).toBeNull());
    expect(screen.getByText(/Action queued/)).toBeTruthy();
    releaseSecondPoll!(response(succeeded));
    expect(await screen.findByText(/Action succeeded/)).toBeTruthy();
    expect(screen.queryByText("Status update failed.")).toBeNull();
    await waitFor(() =>
      expect(
        spy.mock.calls.some(([a]) => JSON.stringify((a as { queryKey?: unknown })?.queryKey).includes("services")),
      ).toBe(true),
    );
    expect(
      spy.mock.calls.filter(([a]) => JSON.stringify((a as { queryKey?: unknown })?.queryKey).includes("services")),
    ).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes(`/actions/${ACTION_ID}`))).toHaveLength(2);
  });

  describe("first action profile", () => {
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

    function historyRow(overrides: Record<string, unknown>) {
      return {
        id: "run-00000000-0000-4000-8000-000000000001",
        actionId: ACTION_ID,
        state: "succeeded",
        terminalKind: "succeeded",
        terminalReason: null,
        updatedAt: "2026-08-12T12:15:00.000Z",
        createdAt: "2026-08-12T12:11:00.000Z",
        attempt: 1,
        ...overrides,
      };
    }

    function stubWithHistory(runs: unknown[]) {
      return stubFetch((url, _init) => {
        if (url.includes("/api/v1/advisor/status")) return response(unconfiguredAdvisor);
        if (url.includes("/runs")) return response({ runs, nextCursor: null });
        return readResponse(url, activeEngagement, emptyRevision) ?? response({ code: "invalid_request" }, 400);
      });
    }

    it("labels the three passes with what they cover", async () => {
      stubWithHistory([]);
      await renderPlanner();

      expect(await screen.findByRole("radio", { name: /Quick port pass/ })).toBeTruthy();
      expect(screen.getByRole("radio", { name: /Fuller port pass/ })).toBeTruthy();
      expect(screen.getByRole("radio", { name: /Web-origin inspection/ })).toBeTruthy();
      expect(screen.getByText(/Default Nmap ports for IP, CIDR, and hostname targets/)).toBeTruthy();
      expect(screen.getByText(/Direct HTTP\(S\) probe of URL targets, no Nmap/)).toBeTruthy();
      fireEvent.click(screen.getByText("What each pass covers"));
      expect(
        await screen.findByText(/URL targets run the HTTP probe and record status/),
      ).toBeTruthy();
    });

    it("remembers the ports default without restoring targets", async () => {
      const queued = persistedAction("queued");
      stubFetch((url, init) => {
        if (url.includes("/api/v1/advisor/status")) return response(unconfiguredAdvisor);
        if (url.includes("/runs")) return response({ runs: [], nextCursor: null });
        if (url.endsWith("/actions") && init?.method === "POST") return response(queued, 201);
        return readResponse(url, { ...activeEngagement, revision: 1, activeScopeRevisionId: null }, null) ?? response({ code: "invalid_request" }, 400);
      });

      await renderPlanner({ ...activeEngagement, revision: 1, activeScopeRevisionId: null });
      fireEvent.click(await screen.findByRole("radio", { name: /Fuller port pass/ }));
      const portsField = await screen.findByLabelText(/^TCP ports/i);
      expect((portsField as HTMLInputElement).value).toBe("22,80,443");
      fireEvent.change(await screen.findByLabelText("Targets"), { target: { value: "192.0.2.10" } });
      fireEvent.submit(screen.getByRole("button", { name: "Plan action" }).closest("form")!);
      expect(await screen.findByText(/Action queued/)).toBeTruthy();
      expect(window.localStorage.getItem("stonehush.firstActionDefaults")).toContain("fuller");

      cleanup();
      await renderPlanner({ ...activeEngagement, revision: 1, activeScopeRevisionId: null });
      expect((await screen.findByLabelText(/^TCP ports/i) as HTMLInputElement).value).toBe(
        "22,80,443",
      );
      expect(
        (await screen.findByRole("radio", { name: /Fuller port pass/ }) as HTMLInputElement).checked,
      ).toBe(true);
      expect((await screen.findByLabelText("Targets") as HTMLTextAreaElement).value).toBe("");
    });

    it("preserves a custom fuller ports value across profile switches", async () => {
      stubWithHistory([]);
      await renderPlanner();

      fireEvent.click(await screen.findByRole("radio", { name: /Fuller port pass/ }));
      const portsField = (await screen.findByLabelText(/^TCP ports/i)) as HTMLInputElement;
      fireEvent.change(portsField, { target: { value: "8080" } });
      expect(portsField.value).toBe("8080");
      fireEvent.click(await screen.findByRole("radio", { name: /Quick port pass/ }));
      expect((await screen.findByLabelText(/^TCP ports/i) as HTMLInputElement).value).toBe("");
      fireEvent.click(await screen.findByRole("radio", { name: /Fuller port pass/ }));
      expect((await screen.findByLabelText(/^TCP ports/i) as HTMLInputElement).value).toBe("8080");
      expect((await screen.findByLabelText("Targets") as HTMLTextAreaElement).value).toBe("");
    });

    it("refills the fuller preset when stored defaults pair fuller with empty ports", async () => {
      stubWithHistory([]);
      window.localStorage.setItem(
        "stonehush.firstActionDefaults",
        JSON.stringify({ profile: "fuller", declaredPorts: "" }),
      );
      await renderPlanner();

      expect(
        (await screen.findByRole("radio", { name: /Fuller port pass/ }) as HTMLInputElement).checked,
      ).toBe(true);
      expect((await screen.findByLabelText(/^TCP ports/i) as HTMLInputElement).value).toBe(
        "22,80,443",
      );
    });

    it("falls back when the storage object access itself throws", () => {
      const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get() {
          throw new Error("denied");
        },
      });
      try {
        // The planner must never evaluate the storage object directly; the
        // guarded helper falls back instead of throwing during render.
        const storage = browserStorage();
        expect(storage.getItem("stonehush.firstActionDefaults")).toBeNull();
        expect(() =>
          storage.setItem("stonehush.firstActionDefaults", "{}"),
        ).not.toThrow();
        expect(readFirstActionDefaults(storage)).toEqual({
          profile: "quick",
          declaredPorts: "",
        });
      } finally {
        if (descriptor !== undefined) Object.defineProperty(window, "localStorage", descriptor);
      }
    });

    it("loads a paused first scan from the action search and offers Continue", async () => {
      const paused = persistedAction("paused_for_warning");
      const queued = persistedAction("queued", {
        warningAcknowledgment: operatorContinueAck(),
      });
      let continued = false;
      const fetchMock = stubFetch((url, init) => {
        if (
          url === `/api/v1/engagements/${activeEngagement.id}/actions/${ACTION_ID}` &&
          (init?.method === undefined || init.method === "GET")
        ) {
          return response(continued ? queued : paused);
        }
        if (url.endsWith("/continue") && init?.method === "POST") {
          continued = true;
          return response(queued);
        }
        return readResponse(url, activeEngagement, emptyRevision) ?? response({ code: "invalid_request" }, 400);
      });

      await renderPlanner(activeEngagement, `?action=${ACTION_ID}`);

      const dialog = await screen.findByRole("dialog", { name: "Action needs a warning" });
      expect(within(dialog).getByText(/outside the saved scope/)).toBeTruthy();
      expect(
        fetchMock.mock.calls.some(
          ([called, init]) =>
            String(called).endsWith(`/actions/${ACTION_ID}`) &&
            (init?.method === undefined || init.method === "GET"),
        ),
      ).toBe(true);
      fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));

      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(([called, init]) =>
            String(called).endsWith("/continue") && init?.method === "POST",
          ),
        ).toBe(true),
      );
      expect(await screen.findByText(/Action queued/)).toBeTruthy();
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Action needs a warning" })).toBeNull(),
      );
    });

    it("shows a specific readiness summary next to the first action", async () => {
      stubWithHistory([]);
      await renderPlanner();

      expect(await screen.findByText("Control plane: ready.")).toBeTruthy();
      expect(await screen.findByText("Runner: no runs yet. The first scan appears here.")).toBeTruthy();
      expect(
        await screen.findByText("Advisor: not set up. Manual work is unaffected."),
      ).toBeTruthy();
    });

    it("reads runner disconnected differently from target not answering", async () => {
      stubWithHistory([
        historyRow({ state: "failed", terminalKind: "failed", terminalReason: "runner_lost" }),
      ]);
      await renderPlanner();
      expect(
        await screen.findByText(/Runner disconnected during the last run/),
      ).toBeTruthy();
      expect(screen.queryByText(/did not answer/)).toBeNull();
      cleanup();

      stubWithHistory([historyRow({})]);
      await renderPlanner();
      expect(
        await screen.findByText(/No new services means the target did not answer/),
      ).toBeTruthy();
      expect(screen.queryByText(/Runner disconnected/)).toBeNull();
    });

    it("names a missing Nmap binary from the last run", async () => {
      stubWithHistory([
        historyRow({ state: "failed", terminalKind: "failed", terminalReason: "nmap_unavailable" }),
      ]);
      await renderPlanner();
      expect(await screen.findByText(/Nmap is not available to the runner/)).toBeTruthy();
    });

    it("offers a retry while readiness queries fail", async () => {
      const fetchMock = stubFetch((url) => {
        if (url.includes("/api/v1/system/status")) return Promise.reject(new Error("offline"));
        if (url.includes("/api/v1/advisor/status")) return response(unconfiguredAdvisor);
        if (url.includes("/runs")) return response({ runs: [], nextCursor: null });
        return (
          readResponse(url, activeEngagement, emptyRevision) ??
          response({ code: "invalid_request" }, 400)
        );
      });
      await renderPlanner();

      expect(await screen.findByText(/Control plane: unreachable/)).toBeTruthy();
      const systemCalls = () =>
        fetchMock.mock.calls.filter(([url]) => String(url).includes("/system/status")).length;
      const before = systemCalls();
      fireEvent.click(await screen.findByRole("button", { name: "Retry status" }));
      await waitFor(() => expect(systemCalls()).toBeGreaterThan(before));
    });

    it("explains Nmap unavailability from the last run instead of the plan result", async () => {
      stubWithHistory([
        historyRow({ state: "failed", terminalKind: "failed", terminalReason: "nmap_unavailable" }),
      ]);
      await renderPlanner();

      expect(
        await screen.findByText(/Nmap is not available to the runner/),
      ).toBeTruthy();
    });

    it("rejects non-URL targets in web-origin inspection without posting", async () => {
      const fetchMock = stubWithHistory([]);
      await renderPlanner();

      fireEvent.click(await screen.findByRole("radio", { name: /Web-origin inspection/ }));
      fireEvent.change(await screen.findByLabelText("Targets"), {
        target: { value: "192.0.2.10" },
      });
      fireEvent.submit(screen.getByRole("button", { name: "Plan action" }).closest("form")!);

      expect(
        await screen.findByText(/Web-origin inspection needs an HTTP\(S\) URL/),
      ).toBeTruthy();
      expect(
        fetchMock.mock.calls.filter(
          ([url, init]) => String(url).endsWith("/actions") && init?.method === "POST",
        ),
      ).toHaveLength(0);
    });

    it("queues a web-origin URL target without Nmap ports", async () => {
      const queued = persistedAction("queued");
      const fetchMock = stubFetch((url, init) => {
        if (url.includes("/api/v1/advisor/status")) return response(unconfiguredAdvisor);
        if (url.includes("/runs")) return response({ runs: [], nextCursor: null });
        if (url.endsWith("/actions") && init?.method === "POST") {
          expect(JSON.parse(String(init.body))).toMatchObject({
            targets: ["https://host.test/"],
            declaredPorts: null,
          });
          return response(queued, 201);
        }
        return readResponse(url, { ...activeEngagement, revision: 1, activeScopeRevisionId: null }, null) ?? response({ code: "invalid_request" }, 400);
      });

      await renderPlanner({ ...activeEngagement, revision: 1, activeScopeRevisionId: null });
      fireEvent.click(await screen.findByRole("radio", { name: /Web-origin inspection/ }));
      fireEvent.change(await screen.findByLabelText("Targets"), {
        target: { value: "https://host.test/" },
      });
      fireEvent.submit(screen.getByRole("button", { name: "Plan action" }).closest("form")!);

      expect(await screen.findByText(/Action queued/)).toBeTruthy();
      expect(
        fetchMock.mock.calls.filter(
          ([url, init]) => String(url).endsWith("/actions") && init?.method === "POST",
        ),
      ).toHaveLength(1);
    });

    it("refreshes run history statefully after a queued creation", async () => {
      const queued = persistedAction("queued");
      let runs: unknown[] = [];
      const fetchMock = stubFetch((url, init) => {
        if (url.includes("/api/v1/advisor/status")) return response(unconfiguredAdvisor);
        if (url.includes("/runs") && (!init || init.method === undefined || init.method === "GET")) {
          return response({ runs, nextCursor: null });
        }
        if (url.endsWith("/actions") && init?.method === "POST") {
          runs = [
            historyRow({ state: "queued", id: "run-00000000-0000-4000-8000-000000000002" }),
          ];
          return response(queued, 201);
        }
        return readResponse(url, { ...activeEngagement, revision: 1, activeScopeRevisionId: null }, null) ?? response({ code: "invalid_request" }, 400);
      });

      await renderPlanner({ ...activeEngagement, revision: 1, activeScopeRevisionId: null });
      expect(
        await screen.findByText("Runner: no runs yet. The first scan appears here."),
      ).toBeTruthy();

      fireEvent.change(await screen.findByLabelText("Targets"), {
        target: { value: "192.0.2.10" },
      });
      fireEvent.submit(screen.getByRole("button", { name: "Plan action" }).closest("form")!);

      expect(await screen.findByText(/Action queued/)).toBeTruthy();
      // Invalidation after persistence refetches history; the new queued run appears.
      await waitFor(() =>
        expect(screen.queryByText("Runner: no runs yet. The first scan appears here.")).toBeNull(),
      );
      expect(
        fetchMock.mock.calls.some(([called]) => String(called).includes("/runs")),
      ).toBe(true);
    });

    it("shows completion freshness after the tracked action succeeds", async () => {
      const noScope = { ...activeEngagement, revision: 1, activeScopeRevisionId: null };
      const queued = persistedAction("queued");
      const succeeded = persistedAction("succeeded", { queuedSnapshotVersion: 1, runState: null });
      let runs: unknown[] = [];
      stubFetch((url, init) => {
        if (url.includes("/api/v1/advisor/status")) return response(unconfiguredAdvisor);
        if (url.includes("/runs") && (!init || init.method === undefined || init.method === "GET")) {
          return response({ runs, nextCursor: null });
        }
        if (url.endsWith("/actions") && init?.method === "POST") {
          runs = [
            historyRow({ state: "queued", id: "run-00000000-0000-4000-8000-000000000002" }),
          ];
          return response(queued, 201);
        }
        if (url.includes(`/actions/${ACTION_ID}`) && (init?.method === undefined || init?.method === "GET")) {
          runs = [historyRow({ state: "succeeded", terminalKind: "succeeded", terminalReason: null })];
          return response(succeeded);
        }
        if (url.includes("/services") || url.includes("/http-probes")) return response([]);
        return readResponse(url, noScope, null) ?? response({ code: "invalid_request" }, 400);
      });

      await renderPlanner(noScope);
      fireEvent.change(await screen.findByLabelText("Targets"), {
        target: { value: "192.0.2.10" },
      });
      fireEvent.submit(screen.getByRole("button", { name: "Plan action" }).closest("form")!);

      expect(await screen.findByText(/Action succeeded/)).toBeTruthy();
      // Terminal invalidation refetches history; the final copy replaces queued.
      expect(
        await screen.findByText(/No new services means the target did not answer/),
      ).toBeTruthy();
    });

    it("offers Retry status for advisor probe failures", async () => {
      for (const reason of ["unreachable", "probe_failed"] as const) {
        cleanup();
        stubFetch((url) => {
          if (url.includes("/api/v1/advisor/status")) {
            return response({ ...unconfiguredAdvisor, reason });
          }
          if (url.includes("/runs")) return response({ runs: [], nextCursor: null });
          return readResponse(url, activeEngagement, emptyRevision) ?? response({ code: "invalid_request" }, 400);
        });
        await renderPlanner();
        expect(
          await screen.findByText("Advisor: endpoint not answering. Manual work is unaffected."),
        ).toBeTruthy();
        expect(await screen.findByRole("button", { name: "Retry status" })).toBeTruthy();
      }
    });
  });
});
