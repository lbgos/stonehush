// @vitest-environment jsdom

import { EngagementSchema, ScopeRevisionSchema } from "@stonehush/contracts";
import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createBrowserHistory, createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { createAppRouter } from "../router.js";
import { engagementDetailQueryKey } from "./query.js";

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
  revision: 3,
};

const ipv4Rule = {
  id: "30000000-0000-4000-8000-000000000001",
  kind: "ip" as const,
  target: {
    kind: "ip" as const,
    normalizationProfile: "d1-v1" as const,
    family: 4 as const,
    address: "198.51.100.10",
    zone: null,
  },
};

const cidrRule = {
  id: "30000000-0000-4000-8000-000000000002",
  kind: "cidr" as const,
  target: {
    kind: "cidr" as const,
    normalizationProfile: "d1-v1" as const,
    family: 4 as const,
    network: "192.0.2.0",
    prefixLength: 24,
    hostBitsMasked: false,
  },
};

const populatedRevision = {
  contractVersion: 1,
  id: "20000000-0000-4000-8000-000000000010",
  engagementId: activeEngagement.id,
  version: 1,
  rules: [ipv4Rule, cidrRule],
  createdAt: "2026-08-12T12:06:00.000Z",
};

const readyStatus = { version: 1, overall: "ready", developmentStorage: "ready" };
const SYNTHETIC_TARGETS = [
  "192.0.2.0/24",
  "198.51.100.10",
  "2001:db8::1",
  "example.test",
  "https://app.example.test",
] as const;

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
  authorizationContext: string | null;
  autoContinueWarnings: boolean;
  activeScopeRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
};

function readResponse(
  url: string,
  engagement: TestEngagement,
  revision: typeof populatedRevision | { contractVersion: number; id: string; engagementId: string; version: number; rules: unknown[]; createdAt: string } | null,
): Response | undefined {
  if (url.includes("/system/status")) return response(readyStatus);
  if (url === "/api/v1/engagements") return response([engagement]);
  if (/^\/api\/v1\/engagements\/[^/]+\/services$/.test(url)) return response([]);
  if (/^\/api\/v1\/engagements\/[^/]+\/http-probes$/.test(url)) return response([]);
  if (/^\/api\/v1\/engagements\/[^/]+\/ffuf-results$/.test(url)) return response([]);
  if (/^\/api\/v1\/engagements\/[^/]+\/vhost-results$/.test(url)) return response([]);
  if (/^\/api\/v1\/engagements\/[^/]+\/gitleaks-matches$/.test(url)) return response([]);
  if (/^\/api\/v1\/engagements\/[^/]+\/findings$/.test(url)) return response([]);
  const reportMatch = /^\/api\/v1\/engagements\/([^/]+)\/report$/.exec(url);
  if (reportMatch?.[1] !== undefined) {
    return response({
      contractVersion: 1,
      engagement: {
        id: engagement.id,
        name: engagement.name,
        kind: engagement.kind,
        status: engagement.status,
        description: engagement.description,
        authorizationContext: engagement.authorizationContext,
        deadlineAt: null,
        revision: engagement.revision,
        createdAt: engagement.createdAt,
        updatedAt: engagement.updatedAt,
      },
      findings: [],
      notesMarkdown: "",
      notesUpdatedAt: engagement.updatedAt,
      services: { total: 0, truncated: false, rows: [] },
      probes: { total: 0, truncated: false, rows: [] },
      ffufResults: { total: 0, truncated: false, rows: [] },
      evidenceArtifacts: { total: 0, truncated: false, rows: [] },
      generatedAt: engagement.updatedAt,
    });
  }
  const notesMatch = /^\/api\/v1\/engagements\/([^/]+)\/notes$/.exec(url);
  if (notesMatch?.[1] !== undefined) {
    return response({
      engagementId: notesMatch[1],
      markdown: "",
      updatedAt: engagement.updatedAt,
      revision: 0,
    });
  }
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

const testQueryClients = new Set<QueryClient>();
const testHistories = new Set<ReturnType<typeof createMemoryHistory>>();

async function renderEditor(engagementId = activeEngagement.id, browserHistory = false) {
  const path = `/engagements/${engagementId}`;
  if (browserHistory) window.history.replaceState({}, "", path);
  const history = browserHistory ? createBrowserHistory() : createMemoryHistory({ initialEntries: [path] });
  testHistories.add(history);
  const router = createAppRouter(history);
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
});

afterEach(() => {
  cleanup();
  for (const client of testQueryClients) client.clear();
  testQueryClients.clear();
  for (const history of testHistories) history.destroy();
  testHistories.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("saved-scope editor", () => {
  it("shows a recoverable scope error distinct from the empty state", async () => {
    stubFetch((url) => {
      if (url === `/api/v1/engagements/${activeEngagement.id}`) {
        return { json: async () => ({ code: "storage_busy" }), ok: false, status: 503 } as Response;
      }
      return readResponse(url, activeEngagement, null) ?? response({ code: "invalid_request" }, 400);
    });

    await renderEditor();

    expect(await screen.findByRole("heading", { name: "Saved scope unavailable" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "No saved scope yet" })).toBeNull();
    // The deadline section reports the same failed refresh with its own card.
    const scopeRegion = screen.getByRole("region", { name: "Saved scope" });
    expect(within(scopeRegion).getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("shows a distinct empty state when there is no active revision", async () => {
    stubFetch((url) => readResponse(url, activeEngagement, null) ?? response({ code: "invalid_request" }, 400));

    await renderEditor();

    expect(await screen.findByRole("heading", { name: "No saved scope yet" })).toBeTruthy();
    expect(screen.getAllByText(/Scope is context, not authorization/).length).toBeGreaterThan(0);
    expect(within(screen.getByRole("region", { name: "Saved scope" })).queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Save scope" })).toHaveProperty("disabled", true);
  });

  it("renders active rules, version, and revision id from the detail payload", async () => {
    const engagement = {
      ...activeEngagement,
      revision: 3,
      activeScopeRevisionId: populatedRevision.id,
    };
    stubFetch((url) => readResponse(url, engagement, populatedRevision) ?? response({ code: "invalid_request" }, 400));

    await renderEditor();

    expect(await screen.findByText("198.51.100.10")).toBeTruthy();
    expect(screen.getByText("192.0.2.0/24")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText(populatedRevision.id)).toBeTruthy();
    expect(screen.getByText("rev 3")).toBeTruthy();
    expect(screen.getByText("198.51.100.10").className).toContain("font-mono");
    expect(screen.getByText(populatedRevision.id).className).toContain("font-mono");
  });

  it("saves canonical rules with an idempotency key and shows the new revision", async () => {
    const createdRevision = {
      contractVersion: 1,
      id: "20000000-0000-4000-8000-000000000011",
      engagementId: activeEngagement.id,
      version: 1,
      rules: [ipv4Rule],
      createdAt: "2026-08-12T12:07:00.000Z",
    };
    let current: TestEngagement = { ...activeEngagement };
    let revision: typeof populatedRevision | null = null;
    const keys: string[] = [];
    const fetchMock = stubFetch((url, init) => {
      if (url.endsWith("/scope-revisions") && init?.method === "POST") {
        keys.push((init.headers as Record<string, string>)["Idempotency-Key"] ?? "");
        const body = JSON.parse(String(init.body)) as {
          expectedRevision: number;
          rules: Array<{ kind: string; target?: { address?: string }; origin?: unknown }>;
        };
        expect(body.expectedRevision).toBe(2);
        expect(body.rules).toHaveLength(1);
        expect(body.rules[0]).toMatchObject({
          kind: "ip",
          target: {
            kind: "ip",
            normalizationProfile: "d1-v1",
            family: 4,
            address: "198.51.100.10",
            zone: null,
          },
        });
        expect(body.rules[0]).not.toMatchObject({ target: "198.51.100.10" });
        current = {
          ...current,
          revision: 3,
          activeScopeRevisionId: createdRevision.id,
          updatedAt: createdRevision.createdAt,
        };
        revision = { ...createdRevision, rules: body.rules as typeof createdRevision.rules };
        return response(revision, 201);
      }
      return (
        readResponse(url, current, revision) ?? response({ code: "invalid_request" }, 400)
      );
    });

    await renderEditor();
    expect(await screen.findByRole("heading", { name: "No saved scope yet" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Target"), { target: { value: "198.51.100.10" } });
    fireEvent.click(screen.getByRole("button", { name: "Save scope" }));

    expect(await screen.findByText(createdRevision.id)).toBeTruthy();
    await waitFor(() => expect(screen.getByText("rev 3")).toBeTruthy());
    expect(screen.getByText("198.51.100.10")).toBeTruthy();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    const scopePosts = fetchMock.mock.calls.filter(([url, init]) => {
      return String(url).endsWith("/scope-revisions") && (init as RequestInit | undefined)?.method === "POST";
    });
    expect(scopePosts).toHaveLength(1);
  });

  it("posts the active rules plus the newly added canonical rule", async () => {
    const engagement = {
      ...activeEngagement,
      revision: 3,
      activeScopeRevisionId: populatedRevision.id,
    };
    const createdRevision = {
      ...populatedRevision,
      id: "20000000-0000-4000-8000-000000000012",
      version: 2,
      createdAt: "2026-08-12T12:08:00.000Z",
    };
    let current: TestEngagement = engagement;
    let revision: typeof populatedRevision | typeof createdRevision | null = populatedRevision;
    stubFetch((url, init) => {
      if (url.endsWith("/scope-revisions") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          expectedRevision: number;
          rules: Array<{ kind: string; target?: { hostname?: string } }>;
        };
        expect(body.expectedRevision).toBe(3);
        expect(body.rules).toHaveLength(3);
        expect(body.rules[0]).toMatchObject({ kind: "ip" });
        expect(body.rules[1]).toMatchObject({ kind: "cidr" });
        expect(body.rules[2]).toMatchObject({
          kind: "domain",
          includeSubdomains: true,
          target: { kind: "hostname", hostname: "example.test" },
        });
        current = {
          ...current,
          revision: 4,
          activeScopeRevisionId: createdRevision.id,
          updatedAt: createdRevision.createdAt,
        };
        revision = { ...createdRevision, rules: body.rules as typeof createdRevision.rules };
        return response(revision, 201);
      }
      return readResponse(url, current, revision) ?? response({ code: "invalid_request" }, 400);
    });

    await renderEditor();
    expect(await screen.findByText("198.51.100.10")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Target"), { target: { value: "example.test" } });
    fireEvent.click(screen.getByLabelText("Include subdomains for domain rules"));
    fireEvent.click(screen.getByRole("button", { name: "Save scope" }));

    expect(await screen.findByText(createdRevision.id)).toBeTruthy();
    expect(screen.getByText("example.test")).toBeTruthy();
  });

  it("does not POST when the target is malformed", async () => {
    const fetchMock = stubFetch(
      (url) => readResponse(url, activeEngagement, null) ?? response({ code: "invalid_request" }, 400),
    );

    await renderEditor();
    expect(await screen.findByLabelText("Target")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Target"), { target: { value: "not a target" } });
    fireEvent.click(screen.getByRole("button", { name: "Save scope" }));

    expect(
      await screen.findByText("Enter a valid IP, CIDR, hostname, or HTTP(S) URL."),
    ).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).includes("/scope-revisions") && (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toBe(false);
  });

  it("keeps archived engagements view-only", async () => {
    const archivedRevision = {
      ...populatedRevision,
      engagementId: archivedEngagement.id,
    };
    const engagement = {
      ...archivedEngagement,
      activeScopeRevisionId: archivedRevision.id,
    };
    const fetchMock = stubFetch(
      (url) => readResponse(url, engagement, archivedRevision) ?? response({ code: "invalid_request" }, 400),
    );

    await renderEditor(archivedEngagement.id);

    expect(await screen.findByText("198.51.100.10")).toBeTruthy();
    expect(
      screen.getByText("This engagement is archived. Saved scope can be viewed but not changed."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save scope" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Add rule" })).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Target")).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Save scope" }));
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).includes("/scope-revisions") && (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toBe(false);
  });

  it("refetches engagement and scope after a revision conflict", async () => {
    const newerEngagement: TestEngagement = {
      ...activeEngagement,
      revision: 5,
      activeScopeRevisionId: populatedRevision.id,
      description: "Newer note",
    };
    let current: TestEngagement = { ...activeEngagement };
    let revision: typeof populatedRevision | null = null;
    stubFetch((url, init) => {
      if (url.endsWith("/scope-revisions") && init?.method === "POST") {
        current = newerEngagement;
        revision = populatedRevision;
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
      return readResponse(url, current, revision) ?? response({ code: "invalid_request" }, 400);
    });

    await renderEditor();
    expect(await screen.findByLabelText("Target")).toBeTruthy();
    expect(screen.getByText("rev 2")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Target"), { target: { value: "example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Save scope" }));

    expect(
      await screen.findByText("This engagement changed. Showing the latest revision."),
    ).toBeTruthy();
    await waitFor(() => expect(screen.getByText("rev 5")).toBeTruthy());
    expect(screen.getByText("Newer note")).toBeTruthy();
    expect(screen.getByText("198.51.100.10")).toBeTruthy();
    expect(screen.getByText(populatedRevision.id)).toBeTruthy();
  });

  it("uses only reserved and synthetic fixture values", async () => {
    stubFetch(
      (url) =>
        readResponse(
          url,
          { ...activeEngagement, activeScopeRevisionId: populatedRevision.id },
          populatedRevision,
        ) ?? response({ code: "invalid_request" }, 400),
    );
    await renderEditor();
    expect(await screen.findByText("198.51.100.10")).toBeTruthy();
    expect(screen.getByText("192.0.2.0/24")).toBeTruthy();
    expect(SYNTHETIC_TARGETS).toContain("198.51.100.10");
    expect(screen.queryByText(/example\.com/i)).toBeNull();
    expect(screen.queryByText(/10\.0\.0\./)).toBeNull();
  });
});


const scopeB = { ...activeEngagement, id: "10000000-0000-4000-8000-000000000003", name: "Scope B" };
const aTarget = "198.51.100.77";
const bTarget = "192.0.2.88";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function setupScopeNavigation({ cached = true, pending = false, archived = false, browserHistory = false } = {}) {
  const records = new Map([activeEngagement, { ...scopeB, status: archived ? "archived" : "active" }]
    .map((record) => [record.id, EngagementSchema.parse(record)]));
  const revisions = new Map<string, ReturnType<typeof ScopeRevisionSchema.parse>>();
  const posts: Array<{ engagementId: string; body: { expectedRevision: number; rules: unknown[] } }> = [];
  const request = deferred<Response>();
  let failDetail = false;
  let completeSave: (() => Response) | undefined;
  stubFetch((url, init) => {
    const match = /^\/api\/v1\/engagements\/([^/]+)\/scope-revisions$/.exec(url);
    if (match?.[1] !== undefined && init?.method === "POST") {
      const engagementId = match[1];
      const body = JSON.parse(String(init.body)) as (typeof posts)[number]["body"];
      posts.push({ engagementId, body });
      const record = records.get(engagementId)!;
      const revision = ScopeRevisionSchema.parse({ ...populatedRevision, engagementId, rules: body.rules });
      const success = () => {
        records.set(engagementId, { ...record, revision: record.revision + 1, activeScopeRevisionId: revision.id });
        revisions.set(engagementId, revision);
        return response(revision, 201);
      };
      if (pending && engagementId === activeEngagement.id) {
        completeSave = success;
        return request.promise;
      }
      return success();
    }
    if (url === "/api/v1/engagements") return response([...records.values()]);
    const id = /^\/api\/v1\/engagements\/([^/?]+)/.exec(url)?.[1];
    if (failDetail && url === `/api/v1/engagements/${activeEngagement.id}`) return response({}, 503);
    const record = records.get(id ?? activeEngagement.id) ?? activeEngagement;
    return readResponse(url, record, revisions.get(record.id) ?? null) ?? response({}, 400);
  });
  const view = await renderEditor(activeEngagement.id, browserHistory);
  await screen.findByRole("heading", { name: "No saved scope yet" });
  if (cached) view.queryClient.setQueryData(engagementDetailQueryKey(scopeB.id), {
    engagement: records.get(scopeB.id), activeScopeRevision: null,
  });
  const clickEngagement = (id: string) => {
    const sidebar = screen.getByRole("complementary", { name: "Primary" });
    const link = sidebar.querySelector<HTMLAnchorElement>(`a[href="/engagements/${id}"]`);
    if (link === null) throw new Error("Missing engagement link");
    fireEvent.click(link);
  };
  return {
    ...view, posts, clickEngagement,
    failDetail: (value: boolean) => { failDetail = value; },
    finish: (success: boolean) => {
      if (completeSave === undefined) throw new Error("No pending save");
      request.resolve(success ? completeSave() : response({ code: "storage_busy" }, 503));
    },
  };
}

function enterScopeTarget(value: string) {
  fireEvent.change(screen.getByLabelText("Target"), { target: { value } });
}

async function discardScopeNavigation() {
  const dialog = await screen.findByRole("alertdialog", { name: "Unsaved scope" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
}

describe("saved-scope draft ownership", () => {
  it.each([
    [true, "typed"], [true, "staged"], [false, "typed"], [false, "staged"],
  ] as const)("guards %s cached navigation with a %s draft and never saves it under B", async (cached, mode) => {
    const env = await setupScopeNavigation({ cached });
    enterScopeTarget(aTarget);
    if (mode === "staged") fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    env.clickEngagement(scopeB.id);
    const dialog = await screen.findByRole("alertdialog", { name: "Unsaved scope" });
    expect(env.router.state.location.pathname).toBe(`/engagements/${activeEngagement.id}`);
    fireEvent.click(within(dialog).getByRole("button", { name: "Stay" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    if (mode === "typed") expect(screen.getByLabelText("Target")).toHaveProperty("value", aTarget);
    else expect(screen.getByText(aTarget)).toBeTruthy();
    env.clickEngagement(scopeB.id);
    await discardScopeNavigation();
    await screen.findByRole("heading", { level: 1, name: scopeB.name });
    expect(await screen.findByLabelText("Target")).toHaveProperty("value", "");
    expect(screen.queryByText(aTarget)).toBeNull();
    expect(screen.getByRole("button", { name: "Save scope" })).toHaveProperty("disabled", true);
    expect(env.posts).toHaveLength(0);
    enterScopeTarget(bTarget);
    fireEvent.click(screen.getByRole("button", { name: "Save scope" }));
    await waitFor(() => expect(screen.getByLabelText("Target")).toHaveProperty("value", ""));
    expect(env.posts).toHaveLength(1);
    expect(env.posts[0]).toMatchObject({ engagementId: scopeB.id, body: { expectedRevision: 2 } });
    expect(JSON.stringify(env.posts[0]?.body.rules)).toContain(bTarget);
    expect(JSON.stringify(env.posts[0]?.body.rules)).not.toContain(aTarget);
    enterScopeTarget("B unsaved");
    env.clickEngagement(activeEngagement.id);
    await discardScopeNavigation();
    await screen.findByRole("heading", { level: 1, name: activeEngagement.name });
    expect(screen.getByLabelText("Target")).toHaveProperty("value", "");
    expect(screen.queryByText(bTarget)).toBeNull();
    expect(env.posts).toHaveLength(1);
  });

  it.each([true, false])("holds navigation until A save settles, success=%s", async (success) => {
    const env = await setupScopeNavigation({ pending: true });
    enterScopeTarget(aTarget);
    fireEvent.click(screen.getByRole("button", { name: "Save scope" }));
    await waitFor(() => expect(env.posts).toHaveLength(1));
    env.clickEngagement(scopeB.id);
    const dialog = await screen.findByRole("alertdialog", { name: "Unsaved scope" });
    expect(within(dialog).queryByRole("button", { name: "Discard" })).toBeNull();
    expect(screen.getByLabelText("Target")).toHaveProperty("disabled", true);
    expect(env.router.state.location.pathname).toBe(`/engagements/${activeEngagement.id}`);
    await act(async () => env.finish(success));
    if (!success) {
      await screen.findByRole("button", { name: "Discard" });
      expect(screen.getByLabelText("Target")).toHaveProperty("value", aTarget);
      expect(env.router.state.location.pathname).toBe(`/engagements/${activeEngagement.id}`);
      fireEvent.click(within(dialog).getByRole("button", { name: "Stay" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      env.clickEngagement(scopeB.id);
      await discardScopeNavigation();
    }
    await screen.findByRole("heading", { level: 1, name: scopeB.name });
    enterScopeTarget(bTarget);
    expect(screen.getByLabelText("Target")).toHaveProperty("value", bTarget);
    expect(within(screen.getByRole("region", { name: "Saved scope" })).queryByRole("alert")).toBeNull();
    expect(env.posts).toHaveLength(1);
    expect(env.posts[0]?.engagementId).toBe(activeEngagement.id);
    expect(JSON.stringify(env.posts[0]?.body.rules)).toContain(aTarget);
    expect(env.queryClient.getQueryData(engagementDetailQueryKey(activeEngagement.id))).toMatchObject({
      activeScopeRevision: success ? { engagementId: activeEngagement.id } : null,
    });
  });

  // Bypass the route guard deliberately to prove component ownership also
  // fences late success/error callbacks, including a new A visit.
  it.each([[true, false], [false, false], [true, true], [false, true]] as const)(
    "isolates late A completion, success=%s, return to A=%s", async (success, returnToA) => {
      const env = await setupScopeNavigation({ pending: true });
      enterScopeTarget(aTarget);
      fireEvent.click(screen.getByRole("button", { name: "Save scope" }));
      await waitFor(() => expect(env.posts).toHaveLength(1));
      await act(async () => { await env.router.navigate({
        to: "/engagements/$engagementId", params: { engagementId: scopeB.id }, ignoreBlocker: true,
      }); });
      await screen.findByRole("heading", { level: 1, name: scopeB.name });
      expect(screen.getByLabelText("Target")).toHaveProperty("value", "");
      if (returnToA) {
        await act(async () => { await env.router.navigate({
          to: "/engagements/$engagementId", params: { engagementId: activeEngagement.id }, ignoreBlocker: true,
        }); });
        await screen.findByRole("heading", { level: 1, name: activeEngagement.name });
      }
      enterScopeTarget(bTarget);
      await act(async () => env.finish(success));
      await waitFor(() => expect(env.queryClient.isMutating()).toBe(0));
      expect(screen.getByLabelText("Target")).toHaveProperty("value", bTarget);
      expect(screen.getByRole("button", { name: "Save scope" })).toHaveProperty("disabled", false);
      expect(within(screen.getByRole("region", { name: "Saved scope" })).queryByRole("alert")).toBeNull();
      expect(env.posts).toHaveLength(1);
      expect(env.posts[0]?.engagementId).toBe(activeEngagement.id);
    },
  );

  it("keeps the draft through a failed detail refresh and recovery", async () => {
    const env = await setupScopeNavigation();
    enterScopeTarget(aTarget);
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    enterScopeTarget(bTarget);
    env.failDetail(true);
    await act(async () => { await env.queryClient.refetchQueries({ queryKey: engagementDetailQueryKey(activeEngagement.id), exact: true }); });
    await screen.findByText("Showing the last successful saved scope");
    expect(screen.getByLabelText("Target")).toHaveProperty("value", bTarget);
    expect(screen.getByText(aTarget)).toBeTruthy();
    env.failDetail(false);
    await act(async () => { await env.queryClient.refetchQueries({ queryKey: engagementDetailQueryKey(activeEngagement.id), exact: true }); });
    await waitFor(() => expect(screen.queryByText("Showing the last successful saved scope")).toBeNull());
    expect(screen.getByLabelText("Target")).toHaveProperty("value", bTarget);
    expect(screen.getByText(aTarget)).toBeTruthy();
    expect(env.posts).toHaveLength(0);
  });

  it("guards tab and Back/Forward navigation and treats options as draft state", async () => {
    const env = await setupScopeNavigation({ browserHistory: true });
    env.clickEngagement(scopeB.id);
    await screen.findByRole("heading", { level: 1, name: scopeB.name });
    fireEvent.click(screen.getByLabelText("Include subdomains for domain rules"));
    env.router.history.back();
    const dialog = await screen.findByRole("alertdialog", { name: "Unsaved scope" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByLabelText("Include subdomains for domain rules")).toHaveProperty("checked", true);
    env.router.history.back();
    await discardScopeNavigation();
    await screen.findByRole("heading", { level: 1, name: activeEngagement.name });
    env.router.history.forward();
    await screen.findByRole("heading", { level: 1, name: scopeB.name });
    expect(screen.getByLabelText("Include subdomains for domain rules")).toHaveProperty("checked", false);
    fireEvent.change(screen.getByLabelText("Ports"), { target: { value: "443" } });
    const tabs = screen.getByRole("navigation", { name: "Engagement sections" });
    fireEvent.click(within(tabs).getByRole("link", { name: "Notes" }));
    await discardScopeNavigation();
    await screen.findByLabelText("Markdown");
    expect(env.posts).toHaveLength(0);
  });

  it("keeps same-surface selection and action navigation available with a draft", async () => {
    const env = await setupScopeNavigation();
    enterScopeTarget(aTarget);
    await act(async () => { await env.router.navigate({
      to: "/engagements/$engagementId", params: { engagementId: activeEngagement.id },
      search: { target: bTarget, action: "40000000-0000-4000-8000-000000000001" },
    }); });
    expect(env.router.state.location.search).toMatchObject({ target: bTarget, action: "40000000-0000-4000-8000-000000000001" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByLabelText("Target")).toHaveProperty("value", aTarget);
    fireEvent.click(within(screen.getByRole("navigation", { name: "Engagement sections" })).getByRole("link", { name: "Surface" }));
    await waitFor(() => expect(env.router.state.location.search.tab).toBe("surface"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByLabelText("Target")).toHaveProperty("value", aTarget);
    expect(env.posts).toHaveLength(0);
  });

  it("discards A only by choice before opening archived B read-only", async () => {
    const env = await setupScopeNavigation({ archived: true });
    enterScopeTarget(aTarget);
    void env.router.navigate({ to: "/engagements/$engagementId", params: { engagementId: scopeB.id } });
    await discardScopeNavigation();
    await screen.findByRole("heading", { level: 1, name: scopeB.name });
    expect(screen.getByLabelText("Target")).toHaveProperty("value", "");
    expect(screen.getByLabelText("Target")).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Save scope" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Add rule" })).toHaveProperty("disabled", true);
    expect(env.posts).toHaveLength(0);
  });
});
