// @vitest-environment jsdom

import type { EngagementResumeResponse, EngagementSearchResult } from "@stonehush/contracts";
import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { createAppRouter } from "../router.js";
import { findingsQueryKey } from "./findings-query.js";
import { serviceSelectionKey } from "./inspector.js";

// Mounted Resume -> exact finding -> Back to Resume workflow.

const ENGAGEMENT_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_ID = "10000000-0000-4000-8000-000000000002";
const TS = "2026-08-12T12:00:00.000Z";
const CONTEXT = { run: "run-1", target: "192.0.2.10", sel: "svc-1", action: "action-1" };
const QUERY = "?tab=surface&run=run-1&target=192.0.2.10&sel=svc-1&action=action-1";

function engagement(id: string, name: string, status: "active" | "archived" = "active") {
  return {
    contractVersion: 1,
    id,
    revision: 1,
    name,
    kind: "lab",
    status,
    description: null,
    authorizationContext: null,
    autoContinueWarnings: false,
    activeScopeRevisionId: null,
    deadlineAt: null,
    createdAt: TS,
    updatedAt: TS,
  };
}

function findingId(index: number) {
  return `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function finding(id: string, title: string, overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: 1,
    id,
    engagementId: ENGAGEMENT_ID,
    title,
    severity: "high",
    status: "open",
    body: `${title} body`,
    evidenceArtifactIds: [],
    revision: 1,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

// Two distinct findings share a title; the Resume target sits last, below the fold.
const SAME_FIRST = findingId(5);
const SAME_LAST = findingId(11);
const MISSING = findingId(99);
const FINDINGS = Array.from({ length: 12 }, (_, index) =>
  finding(findingId(index), index === 5 || index === 11 ? "Exposed admin panel" : `Finding ${index}`),
);

function change(id: string, summary: string, at: string): EngagementResumeResponse["changes"][number] {
  return { kind: "finding", id, at, summary, snapshot: false };
}

const CHANGES = [
  change(SAME_LAST, "Finding recorded: Exposed admin panel.", "2026-08-13T12:00:00.000Z"),
  change(SAME_FIRST, "Finding recorded: Exposed admin panel.", "2026-08-13T11:00:00.000Z"),
  change(MISSING, "Finding recorded: Deleted finding.", "2026-08-13T10:00:00.000Z"),
];

function response(payload: unknown, status = 200): Response {
  return { json: async () => payload, ok: status >= 200 && status < 300, status } as Response;
}

interface Server {
  engagements: ReturnType<typeof engagement>[];
  findings: unknown[];
  readFindings?: (() => Response | Promise<Response>) | undefined;
  createFinding?: (() => Promise<Response>) | undefined;
  updateFinding?: (() => Promise<Response>) | undefined;
  search?: ((query: string) => EngagementSearchResult[]) | undefined;
  readServices?: (() => Response | Promise<Response>) | undefined;
}

function isRead(init?: RequestInit) {
  return init?.method === undefined || init.method === "GET";
}

function serve(server: Server) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes("/system/status")) return Promise.resolve(response({ version: 1, overall: "ready", developmentStorage: "ready" }));
    if (url === "/api/v1/engagements") return Promise.resolve(response(server.engagements));
    const match = /^\/api\/v1\/engagements\/([^/?]+)(\/[^?]*)?(\?.*)?$/.exec(url);
    const owner = server.engagements.find((entry) => entry.id === match?.[1]);
    if (owner === undefined) return Promise.resolve(response({ code: "engagement_not_found" }, 404));
    const rest = match?.[2] ?? "";
    if (rest === "") return Promise.resolve(response({ engagement: owner, activeScopeRevision: null }));
    if (rest === "/resume") {
      return Promise.resolve(response({
        engagementId: owner.id,
        nextStep: null,
        nextStepUpdatedAt: null,
        nextStepRevision: 0,
        changes: owner.id === ENGAGEMENT_ID ? CHANGES : [],
        complete: true,
      }));
    }
    if (rest === "/findings" && isRead(init)) {
      if (owner.id !== ENGAGEMENT_ID) return Promise.resolve(response([]));
      return Promise.resolve(server.readFindings?.() ?? response(server.findings));
    }
    if (rest === "/findings" && init?.method === "POST" && server.createFinding !== undefined) return server.createFinding();
    if (rest.startsWith("/findings/") && init?.method === "PUT" && server.updateFinding !== undefined) return server.updateFinding();
    if (rest === "/services") return Promise.resolve(server.readServices?.() ?? response([]));
    if (rest === "/search") {
      const query = decodeURIComponent(/\?q=(.*)$/.exec(url)?.[1] ?? "");
      const results = server.search?.(query) ?? [];
      const kinds = ["target", "hostname", "note", "lead", "finding", "artifact", "excerpt"] as const;
      return Promise.resolve(response({
        engagementId: owner.id,
        query,
        groups: Object.fromEntries(kinds.map((kind) => [kind, results.filter((result) => result.kind === kind)])),
        unindexedKinds: ["lead", "excerpt"],
      }));
    }
    if (!isRead(init)) return Promise.resolve(response({ code: "invalid_request" }, 400));
    return Promise.resolve(response([]));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function writes(fetchMock: ReturnType<typeof serve>) {
  return fetchMock.mock.calls.filter(([, init]) => !isRead(init)).map(([url]) => String(url));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const queryClients = new Set<QueryClient>();

async function renderWorkspace(entry: string) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [entry] }));
  await router.load();
  const queryClient = createAppQueryClient();
  queryClients.add(queryClient);
  render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return router;
}

async function resumeBand() {
  return screen.findByRole("region", { name: "Resume" });
}

async function openFromResume(summary: string, index = 0) {
  const band = await resumeBand();
  const rows = await within(band).findAllByRole("button", { name: summary });
  fireEvent.click(rows[index]!);
}

function row(id: string) {
  return document.querySelector<HTMLElement>(`[data-finding-id="${id}"]`);
}

async function expectFocused(id: string) {
  await waitFor(() => {
    expect(row(id)?.getAttribute("aria-current")).toBe("true");
    expect(row(id)?.contains(document.activeElement)).toBe(true);
  });
  expect(document.querySelectorAll('[aria-current="true"][data-finding-id]')).toHaveLength(1);
}

function backButton() {
  return screen.queryByRole("button", { name: "Back to Resume" });
}

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280, writable: true });
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
  Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  for (const client of queryClients) client.clear();
  queryClients.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("open recent findings from Resume", () => {
  it("keeps Resume return focus when the retained real inspector mounts after a delayed service read", async () => {
    const service = {
      address: "192.0.2.10", port: 80, protocol: "tcp", hostname: null, serviceName: "http", product: null, version: null,
      source: "nmap", parserVersion: "nmap-xml-v1", runId: "run-1", artifactId: "artifact-1",
      artifactDigest: `sha256:${"a".repeat(64)}`, observedAt: TS,
    };
    const sel = serviceSelectionKey(service.address, service.port, service.protocol, service.artifactId);
    const context = { ...CONTEXT, sel };
    let readServices = () => Promise.resolve(response([service]));
    serve({ engagements: [engagement(ENGAGEMENT_ID, "Target lab")], findings: FINDINGS, readServices: () => readServices() });
    const router = await renderWorkspace(`/engagements/${ENGAGEMENT_ID}?tab=surface&run=run-1&target=192.0.2.10&action=action-1&sel=${encodeURIComponent(sel)}`);
    expect(await screen.findByRole("complementary", { name: "Selection inspector" })).toBeTruthy();
    await openFromResume("Finding recorded: Exposed admin panel.", 0);
    await expectFocused(SAME_LAST);
    // A delayed remount must not take focus from the committed return.
    const held = deferred<Response>();
    readServices = () => held.promise;
    const client = [...queryClients].at(-1);
    client?.removeQueries({ queryKey: ["engagements", ENGAGEMENT_ID, "services"] });
    fireEvent.click(backButton()!);
    await waitFor(() => expect(router.state.location.search).toEqual({ tab: "surface", ...context }));
    await waitFor(async () => expect(document.activeElement).toBe(await resumeBand()));
    held.resolve(response([service]));
    const inspector = await screen.findByRole("complementary", { name: "Selection inspector" });
    expect(within(inspector).getAllByText(/192\.0\.2\.10/).length).toBeGreaterThan(0);
    await waitFor(async () => expect(document.activeElement).toBe(await resumeBand()));
  });

  it.each(["older", "missing", "foreign", "duplicate"])("does not let a %s ordinary list response overwrite the fresh arrival read", async (responseKind) => {
    const initial = deferred<Response>();
    let reads = 0;
    const current = finding(SAME_LAST, "Current saved claim", { status: "resolved", revision: 3 });
    serve({
      engagements: [engagement(ENGAGEMENT_ID, "Target lab")],
      findings: [current],
      readFindings: () => ++reads === 1 ? initial.promise : response([current]),
    });
    await renderWorkspace(`/engagements/${ENGAGEMENT_ID}${QUERY}`);
    await openFromResume("Finding recorded: Exposed admin panel.", 0);
    await expectFocused(SAME_LAST);
    expect(reads).toBe(2);
    expect(within(row(SAME_LAST)!).getByText("Current saved claim")).toBeTruthy();
    const client = [...queryClients].at(-1);
    const older = finding(SAME_LAST, "Older ordinary read", {
      revision: 1, ...(responseKind === "foreign" ? { engagementId: OTHER_ID } : {}),
    });
    initial.resolve(response(responseKind === "missing" ? [] : responseKind === "duplicate" ? [older, older] : [older]));
    await initial.promise;
    await waitFor(() => expect(client?.getQueryState(findingsQueryKey(ENGAGEMENT_ID))?.fetchStatus).toBe("idle"));
    expect(within(row(SAME_LAST)!).getByText("Current saved claim")).toBeTruthy();
    expect(screen.queryByText("Older ordinary read")).toBeNull();
    expect(client?.getQueryData(findingsQueryKey(ENGAGEMENT_ID))).toEqual([current]);
  });

  it.each(["foreign", "duplicate"])("does not publish a rejected %s arrival list through the ordinary query", async (responseKind) => {
    const initial = deferred<Response>();
    let reads = 0;
    const invalid = finding(SAME_LAST, "Rejected saved claim", responseKind === "foreign" ? { engagementId: OTHER_ID } : {});
    const records = responseKind === "duplicate" ? [invalid, invalid] : [invalid];
    serve({
      engagements: [engagement(ENGAGEMENT_ID, "Target lab")],
      findings: records,
      readFindings: () => ++reads === 1 ? initial.promise : response(records),
    });
    await renderWorkspace(`/engagements/${ENGAGEMENT_ID}${QUERY}`);
    await openFromResume("Finding recorded: Exposed admin panel.", 0);
    await within(await screen.findByRole("status", { name: "Finding from Resume" })).findByText("Saved findings could not be loaded.");
    expect(reads).toBe(2);
    initial.resolve(response(records));
    await initial.promise;
    const client = [...queryClients].at(-1);
    await waitFor(() => expect(client?.getQueryState(findingsQueryKey(ENGAGEMENT_ID))?.fetchStatus).toBe("idle"));
    expect(screen.queryByText("Rejected saved claim")).toBeNull();
    expect(row(SAME_LAST)).toBeNull();
    expect(client?.getQueryData(findingsQueryKey(ENGAGEMENT_ID))).toBeUndefined();
  });

  it.each([
    { run: "run-2" }, { target: "192.0.2.20" }, { sel: "svc-2" }, { action: "action-2" },
  ])("ends the Resume arrival on an unrelated same-tab context change %j", async (change) => {
    serve({ engagements: [engagement(ENGAGEMENT_ID, "Target lab")], findings: FINDINGS });
    const router = await renderWorkspace(`/engagements/${ENGAGEMENT_ID}${QUERY}`);
    await openFromResume("Finding recorded: Exposed admin panel.", 0);
    await expectFocused(SAME_LAST);
    await router.navigate({
      to: "/engagements/$engagementId",
      params: { engagementId: ENGAGEMENT_ID },
      search: { tab: "findings", ...CONTEXT, ...change },
    });
    await waitFor(() => expect(backButton()).toBeNull());
    expect(document.querySelector('[aria-current="true"][data-finding-id]')).toBeNull();
  });

  it("opens the exact same-title finding below the fold, keeps route context, and returns focus to Resume", async () => {
    const fetchMock = serve({ engagements: [engagement(ENGAGEMENT_ID, "Target lab")], findings: FINDINGS });
    const router = await renderWorkspace(`/engagements/${ENGAGEMENT_ID}${QUERY}`);

    await openFromResume("Finding recorded: Exposed admin panel.", 0);
    await waitFor(() => expect(router.state.location.search).toEqual({ tab: "findings", ...CONTEXT }));
    await expectFocused(SAME_LAST);
    expect(row(SAME_FIRST)?.hasAttribute("aria-current")).toBe(false);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "center" });

    fireEvent.click(backButton()!);
    await waitFor(() => expect(router.state.location.search).toEqual({ tab: "surface", ...CONTEXT }));
    await waitFor(async () => expect(document.activeElement).toBe(await resumeBand()));

    // The older same-title row opens its own record.
    await openFromResume("Finding recorded: Exposed admin panel.", 1);
    await expectFocused(SAME_FIRST);
    expect(writes(fetchMock)).toEqual([]);

    // Reload keeps the route but makes no return promise.
    cleanup();
    await renderWorkspace(`/engagements/${ENGAGEMENT_ID}?tab=findings`);
    expect(await screen.findByText("Finding 0")).toBeTruthy();
    expect(backButton()).toBeNull();
    expect(document.querySelector('[aria-current="true"][data-finding-id]')).toBeNull();
  });

  it("opens a renamed, resolved finding by identity while an older search match still reports changed", async () => {
    const renamed = finding(SAME_LAST, "Renamed admin panel", { status: "resolved", revision: 3 });
    const listed = [...FINDINGS.slice(0, 11), renamed];
    const oldSignature: EngagementSearchResult = {
      kind: "finding",
      id: SAME_LAST,
      title: "Exposed admin panel",
      snippet: "Exposed admin panel body",
      anchor: `finding:${SAME_LAST}`,
      unindexed: false,
    };
    serve({ engagements: [engagement(ENGAGEMENT_ID, "Target lab")], findings: listed, search: () => [oldSignature] });
    await renderWorkspace(`/engagements/${ENGAGEMENT_ID}${QUERY}`);

    // Resume still names the old title; identity opens the current record.
    await openFromResume("Finding recorded: Exposed admin panel.", 0);
    await expectFocused(SAME_LAST);
    expect(within(row(SAME_LAST)!).getByText("Renamed admin panel")).toBeTruthy();
    expect(within(row(SAME_LAST)!).getByText("resolved")).toBeTruthy();
    expect(row(SAME_FIRST)?.hasAttribute("aria-current")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Search notes and findings" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search notes and findings" }), { target: { value: "exposed" } });
    fireEvent.click(await screen.findByRole("button", { name: /Exposed admin panel/ }));
    expect(await screen.findByText(/Match changed/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Search again" })).toBeTruthy();
    expect(document.querySelector('[aria-current="true"][data-finding-id]')).toBeNull();
    expect(backButton()).toBeNull();
  });

  it("restores the ordinary Findings load when a failed search arrival is dismissed", async () => {
    let fail = true;
    serve({
      engagements: [engagement(ENGAGEMENT_ID, "Target lab")],
      findings: FINDINGS,
      readFindings: () => fail ? response({ code: "storage_busy" }, 503) : response(FINDINGS),
      search: () => [{
        kind: "finding", id: SAME_LAST, title: "Exposed admin panel", snippet: "Exposed admin panel body",
        anchor: `finding:${SAME_LAST}`, unindexed: false,
      }],
    });
    await renderWorkspace(`/engagements/${ENGAGEMENT_ID}${QUERY}`);
    fireEvent.click(await screen.findByRole("button", { name: "Search notes and findings" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search notes and findings" }), { target: { value: "exposed" } });
    fireEvent.click(await within(screen.getByRole("dialog")).findByRole("button", { name: /Exposed admin panel/ }));
    const notice = await screen.findByRole("status", { name: "Search result" });
    await within(notice).findByText("Saved findings could not be loaded.");
    fail = false;
    fireEvent.click(within(notice).getByRole("button", { name: "Dismiss" }));
    expect(await screen.findByText("Finding 0")).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Search result" })).toBeNull();
  });

  it("keeps the arrival through a failed read and Retry, then reports a missing finding without a fallback", async () => {
    let fail = true;
    const fetchMock = serve({
      engagements: [engagement(ENGAGEMENT_ID, "Target lab")],
      findings: FINDINGS,
      readFindings: () => (fail ? response({ code: "storage_busy" }, 503) : response(FINDINGS)),
    });
    const router = await renderWorkspace(`/engagements/${ENGAGEMENT_ID}${QUERY}`);

    await openFromResume("Finding recorded: Exposed admin panel.", 0);
    const notice = await screen.findByRole("status", { name: "Finding from Resume" });
    await within(notice).findByText("Saved findings could not be loaded.");
    expect(backButton()).toBeTruthy();
    fail = false;
    fireEvent.click(within(notice).getByRole("button", { name: "Retry" }));
    await expectFocused(SAME_LAST);
    expect(screen.queryByRole("status", { name: "Finding from Resume" })).toBeNull();

    fireEvent.click(backButton()!);
    await waitFor(() => expect(router.state.location.search.tab).toBe("surface"));
    await openFromResume("Finding recorded: Deleted finding.");
    const missing = await screen.findByRole("status", { name: "Finding from Resume" });
    await within(missing).findByText("Finding unavailable. It is no longer saved in this engagement.");
    expect(document.activeElement).toBe(missing);
    expect(within(missing).queryByRole("button", { name: "Retry" })).toBeNull();
    expect(document.querySelector('[aria-current="true"][data-finding-id]')).toBeNull();
    expect(backButton()).toBeTruthy();
    expect(writes(fetchMock)).toEqual([]);
  });

  it("never focuses from a foreign-owner list or a late read of an abandoned arrival, and ends on engagement switch", async () => {
    let reply: () => Response | Promise<Response> = () =>
      response([...FINDINGS, { ...finding(findingId(50), "Foreign"), engagementId: OTHER_ID }]);
    serve({
      engagements: [engagement(ENGAGEMENT_ID, "Target lab"), engagement(OTHER_ID, "Other lab")],
      findings: FINDINGS,
      readFindings: () => reply(),
    });
    const router = await renderWorkspace(`/engagements/${ENGAGEMENT_ID}${QUERY}`);

    await openFromResume("Finding recorded: Exposed admin panel.", 0);
    await within(await screen.findByRole("status", { name: "Finding from Resume" })).findByText("Saved findings could not be loaded.");
    expect(document.querySelector('[aria-current="true"][data-finding-id]')).toBeNull();

    // Abandon a held read for the older row, then open the newer one.
    fireEvent.click(backButton()!);
    await waitFor(() => expect(router.state.location.search.tab).toBe("surface"));
    const held = deferred<Response>();
    reply = () => held.promise;
    await openFromResume("Finding recorded: Exposed admin panel.", 1);
    await screen.findByText("Checking saved findings");
    fireEvent.click(backButton()!);
    await waitFor(() => expect(router.state.location.search.tab).toBe("surface"));
    reply = () => response(FINDINGS);
    await openFromResume("Finding recorded: Exposed admin panel.", 0);
    await expectFocused(SAME_LAST);
    held.resolve(response(FINDINGS));
    await held.promise;
    await new Promise((done) => setTimeout(done, 0));
    await expectFocused(SAME_LAST);
    expect(row(SAME_FIRST)?.hasAttribute("aria-current")).toBe(false);

    await router.navigate({ to: "/engagements/$engagementId", params: { engagementId: OTHER_ID }, search: { tab: "findings" } });
    await screen.findByRole("heading", { name: "Other lab" });
    await waitFor(() => expect(backButton()).toBeNull());
    expect(document.querySelector('[aria-current="true"][data-finding-id]')).toBeNull();
  });

  it("holds Back to Resume behind a finding draft: Stay keeps the arrival, unrelated navigation ends it, Leave returns", async () => {
    serve({ engagements: [engagement(ENGAGEMENT_ID, "Target lab")], findings: FINDINGS });
    const router = await renderWorkspace(`/engagements/${ENGAGEMENT_ID}${QUERY}`);

    await openFromResume("Finding recorded: Exposed admin panel.", 0);
    await expectFocused(SAME_LAST);
    const title = document.getElementById("finding-title") as HTMLInputElement;
    fireEvent.change(title, { target: { value: "unsaved finding" } });
    fireEvent.click(backButton()!);
    fireEvent.click(within(await screen.findByRole("alertdialog", { name: "Unsaved finding" })).getByRole("button", { name: "Stay" }));
    expect(router.state.location.search).toEqual({ tab: "findings", ...CONTEXT });
    expect(title.value).toBe("unsaved finding");
    expect(backButton()).toBeTruthy();
    expect(row(SAME_LAST)?.getAttribute("aria-current")).toBe("true");

    // A cancelled return is not replayed by a later visit to Surface.
    fireEvent.click(screen.getByRole("link", { name: "Notes" }));
    fireEvent.click(within(await screen.findByRole("alertdialog", { name: "Unsaved finding" })).getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(router.state.location.search.tab).toBe("notes"));
    fireEvent.click(screen.getByRole("link", { name: "Surface" }));
    const band = await resumeBand();
    expect(document.activeElement).not.toBe(band);
    fireEvent.click(screen.getByRole("link", { name: "Findings" }));
    expect(await screen.findByText("Finding 0")).toBeTruthy();
    expect(backButton()).toBeNull();
    expect(document.querySelector('[aria-current="true"][data-finding-id]')).toBeNull();

    // Leave continues the held return and focuses the band once Surface commits.
    fireEvent.click(screen.getByRole("link", { name: "Surface" }));
    await openFromResume("Finding recorded: Exposed admin panel.", 0);
    await expectFocused(SAME_LAST);
    fireEvent.change(document.getElementById("finding-title") as HTMLInputElement, { target: { value: "another draft" } });
    fireEvent.click(backButton()!);
    fireEvent.click(within(await screen.findByRole("alertdialog", { name: "Unsaved finding" })).getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ tab: "surface", ...CONTEXT }));
    await waitFor(async () => expect(document.activeElement).toBe(await resumeBand()));
  });

  it("holds Back to Resume during a pending save, then returns once the save lands", async () => {
    const created = deferred<Response>();
    serve({
      engagements: [engagement(ENGAGEMENT_ID, "Target lab")],
      findings: FINDINGS,
      createFinding: () => created.promise,
    });
    const router = await renderWorkspace(`/engagements/${ENGAGEMENT_ID}${QUERY}`);

    await openFromResume("Finding recorded: Exposed admin panel.", 0);
    await expectFocused(SAME_LAST);
    fireEvent.change(document.getElementById("finding-title") as HTMLInputElement, { target: { value: "Saved soon" } });
    fireEvent.click(screen.getByRole("button", { name: "Create finding" }));
    await screen.findByRole("button", { name: "Saving" });
    fireEvent.click(backButton()!);
    const pendingGuard = await screen.findByRole("alertdialog", { name: "Unsaved finding" });
    const leave = within(pendingGuard).getByRole<HTMLButtonElement>("button", { name: "Leave" });
    expect(leave.disabled).toBe(true);
    fireEvent.click(leave);
    expect(router.state.location.search.tab).toBe("findings");
    fireEvent.click(within(pendingGuard).getByRole("button", { name: "Stay" }));
    expect(router.state.location.search.tab).toBe("findings");

    created.resolve(response(finding(findingId(60), "Saved soon"), 201));
    await waitFor(() => expect((document.getElementById("finding-title") as HTMLInputElement).value).toBe(""));
    fireEvent.click(backButton()!);
    await waitFor(() => expect(router.state.location.search).toEqual({ tab: "surface", ...CONTEXT }));
    await waitFor(async () => expect(document.activeElement).toBe(await resumeBand()));
  });

  it("cannot leave a pending edit and retains the ordinary draft guard after a failed save", async () => {
    const edited = deferred<Response>();
    serve({
      engagements: [engagement(ENGAGEMENT_ID, "Target lab")], findings: FINDINGS,
      updateFinding: () => edited.promise,
    });
    const router = await renderWorkspace(`/engagements/${ENGAGEMENT_ID}${QUERY}`);
    await openFromResume("Finding recorded: Exposed admin panel.", 0);
    await expectFocused(SAME_LAST);
    fireEvent.click(within(row(SAME_LAST)!).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(row(SAME_LAST)!).getByLabelText("Title"), { target: { value: "Pending edited title" } });
    fireEvent.click(within(row(SAME_LAST)!).getByRole("button", { name: "Save edit" }));
    await within(row(SAME_LAST)!).findByRole("button", { name: "Saving" });
    fireEvent.click(backButton()!);
    const guard = await screen.findByRole("alertdialog", { name: "Unsaved finding" });
    const leave = within(guard).getByRole<HTMLButtonElement>("button", { name: "Leave" });
    expect(leave.disabled).toBe(true);
    fireEvent.click(leave);
    expect(router.state.location.search.tab).toBe("findings");
    edited.resolve(response({ code: "storage_busy" }, 503));
    await within(row(SAME_LAST)!).findByText("Storage is busy. Try again.");
    expect(within(row(SAME_LAST)!).getByDisplayValue("Pending edited title")).toBeTruthy();
    await waitFor(() => expect(leave.disabled).toBe(false));
    fireEvent.click(within(guard).getByRole("button", { name: "Stay" }));
    expect(backButton()).toBeTruthy();
    expect(router.state.location.search.tab).toBe("findings");
  });

  it("opens a finding read-only in an archived engagement without any write", async () => {
    const fetchMock = serve({ engagements: [engagement(ENGAGEMENT_ID, "Target lab", "archived")], findings: FINDINGS });
    const router = await renderWorkspace(`/engagements/${ENGAGEMENT_ID}${QUERY}`);

    await openFromResume("Finding recorded: Exposed admin panel.", 0);
    await expectFocused(SAME_LAST);
    expect(within(row(SAME_LAST)!).queryByRole("button", { name: "Edit" })).toBeNull();
    fireEvent.click(backButton()!);
    await waitFor(() => expect(router.state.location.search).toEqual({ tab: "surface", ...CONTEXT }));
    await waitFor(async () => expect(document.activeElement).toBe(await resumeBand()));
    expect(writes(fetchMock)).toEqual([]);
  });
});
