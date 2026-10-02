// @vitest-environment jsdom

import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { createAppRouter } from "../router.js";
import { serviceSelectionKey } from "./inspector.js";
import { leadQueryKey } from "./leads-query.js";
import { WORKSPACE_STATE_KEY_PREFIX, parseWorkspaceState, workspaceStateKey } from "./workspace-state.js";

// Mounted Surface integration for the remembered Resume lead: the real
// router, workspace, Resume band, inspector, and shared lead overlay over a
// stubbed control plane and jsdom localStorage.

const TS = "2026-09-20T12:00:00.000Z";

const engagement = {
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
  createdAt: TS,
  updatedAt: TS,
};
const otherEngagement = { ...engagement, id: "10000000-0000-4000-8000-000000000002", name: "Second lab" };
const archivedEngagement = { ...engagement, id: "10000000-0000-4000-8000-000000000003", name: "Old box", status: "archived" };
type TestEngagement = typeof engagement;

const service = {
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
  observedAt: TS,
};
const SEL = serviceSelectionKey(service.address, service.port, service.protocol, service.artifactId);

const FIRST_ID = "20000000-0000-4000-8000-000000000001";
const SECOND_ID = "20000000-0000-4000-8000-000000000002";
const OTHER_ID = "20000000-0000-4000-8000-000000000003";

function lead(id: string, engagementId: string, overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: 1,
    id,
    engagementId,
    title: "Default creds",
    target: "192.0.2.10",
    serviceRef: "192.0.2.10:80/tcp",
    source: { kind: "nmap_service", ref: "artifact-1", label: "192.0.2.10:80/tcp http" },
    nextStep: null,
    disposition: "open",
    parkReason: null,
    testedConditions: null,
    closedNote: null,
    revisitSuggestion: null,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

function attempt(leadId: string, sequence: number, summary: string, extra: Record<string, unknown> = {}) {
  return {
    contractVersion: 1,
    id: `30000000-0000-4000-8000-00000000000${String(sequence)}`,
    engagementId: engagement.id,
    leadId,
    sequence,
    summary,
    outcome: "ruled_out",
    conditions: null,
    evidenceArtifactIds: [],
    linkedFindingId: null,
    linkedObjectiveId: null,
    createdAt: TS,
    ...extra,
  };
}

function finding(id: string, engagementId: string, overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: 1,
    id,
    engagementId,
    title: "Weak admin password",
    severity: "high",
    status: "open",
    body: "Admin accepts the vendor default.",
    evidenceArtifactIds: [],
    revision: 0,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

function response(payload: unknown, status = 200): Response {
  return { json: async () => payload, ok: status >= 200 && status < 300, status } as Response;
}

interface Server {
  engagements: TestEngagement[];
  leads: Record<string, ReturnType<typeof lead>[]>;
  attempts: Record<string, ReturnType<typeof attempt>[]>;
  findings?: Record<string, ReturnType<typeof finding>[]>;
  readFindings?: (engagementId: string) => Response | Promise<Response> | undefined;
  readLead?: (leadId: string, engagementId: string) => Response | Promise<Response> | undefined;
  recordAttempt?: (leadId: string, body: Record<string, unknown>) => Response | Promise<Response>;
  readAttempts?: (leadId: string) => Response | Promise<Response> | undefined;
  closeLead?: (leadId: string) => Response | Promise<Response>;
  reopenLead?: (leadId: string) => Response | Promise<Response>;
  dismissRevisit?: (leadId: string) => Response | Promise<Response>;
}

function isRead(init?: RequestInit) {
  return init?.method === undefined || init.method === "GET";
}

function serve(server: Server) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes("/system/status")) return Promise.resolve(response({ version: 1, overall: "ready", developmentStorage: "ready" }));
    if (url === "/api/v1/engagements") return Promise.resolve(response(server.engagements));
    const match = /^\/api\/v1\/engagements\/([^/?]+)(\/.*)?$/.exec(url);
    const engagementId = match?.[1];
    const rest = match?.[2] ?? "";
    const owner = server.engagements.find((entry) => entry.id === engagementId);
    if (engagementId === undefined || owner === undefined) return Promise.resolve(response({ code: "engagement_not_found" }, 404));
    if (rest === "") return Promise.resolve(response({ engagement: owner, activeScopeRevision: null }));
    if (rest === "/services") return Promise.resolve(response([service]));
    if (rest === "/leads") return Promise.resolve(response(server.leads[engagementId] ?? []));
    if (rest === "/findings" && isRead(init)) {
      return Promise.resolve(server.readFindings?.(engagementId) ?? response(server.findings?.[engagementId] ?? []));
    }
    const leadMatch = /^\/leads\/([^/]+)(\/.*)?$/.exec(rest);
    if (leadMatch?.[1] !== undefined) {
      const leadId = leadMatch[1];
      const tail = leadMatch[2] ?? "";
      if (tail === "" && isRead(init)) {
        const custom = server.readLead?.(leadId, engagementId);
        if (custom !== undefined) return Promise.resolve(custom);
        const found = (server.leads[engagementId] ?? []).find((entry) => entry.id === leadId);
        return Promise.resolve(found === undefined ? response({ code: "lead_not_found" }, 404) : response(found));
      }
      if (tail === "/attempts" && isRead(init)) return Promise.resolve(server.readAttempts?.(leadId) ?? response(server.attempts[leadId] ?? []));
      if (tail === "/attempts" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Promise.resolve(server.recordAttempt?.(leadId, body) ?? response({ code: "invalid_request" }, 400));
      }
      if (tail === "/close" && init?.method === "POST") {
        return Promise.resolve(server.closeLead?.(leadId) ?? response({ code: "invalid_request" }, 400));
      }
      if (tail === "/reopen" && init?.method === "POST") {
        return Promise.resolve(server.reopenLead?.(leadId) ?? response({ code: "invalid_request" }, 400));
      }
      if (tail === "/revisit/dismiss" && init?.method === "POST") {
        return Promise.resolve(server.dismissRevisit?.(leadId) ?? response({ code: "invalid_request" }, 400));
      }
      if (tail === "/outline") return Promise.resolve(response({ outline: "" }));
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

function leadReads(fetchMock: ReturnType<typeof serve>) {
  return fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => /\/leads\/[^/]+$/.test(url));
}

const testQueryClients = new Set<QueryClient>();

// Dashboard Resume and a reload both land on the bare engagement route.
async function renderAt(engagementId: string, search = "") {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [`/engagements/${engagementId}${search}`] }));
  await router.load();
  const queryClient = createAppQueryClient();
  testQueryClients.add(queryClient);
  render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return router;
}

function reload() {
  cleanup();
  for (const client of testQueryClients) client.clear();
  testQueryClients.clear();
}

function remember(engagementId: string, value: unknown) {
  window.localStorage.setItem(workspaceStateKey(engagementId), JSON.stringify({ version: 1, lastLeadId: value }));
}

function stored(engagementId: string) {
  return parseWorkspaceState(window.localStorage.getItem(workspaceStateKey(engagementId))).lastLeadId;
}

function band() {
  return screen.getByRole("region", { name: "Resume" });
}

async function lastLeadRow() {
  const resume = await screen.findByRole("region", { name: "Resume" });
  return within(resume).findByRole("region", { name: "Last lead" });
}

async function linkedLeadButton(name: RegExp) {
  const list = await screen.findByRole("list", { name: "Leads linked to this evidence" });
  return within(list).getByRole("button", { name });
}

function dialog() {
  return screen.getByRole("dialog");
}

function chooser() {
  return within(dialog()).getByLabelText<HTMLSelectElement>("Finding, optional");
}

function findingOptions() {
  return Array.from(chooser().options, (option) => option.textContent);
}

function linkedRows() {
  return within(dialog()).queryAllByText(/^Linked finding/).map((node) => node.textContent);
}

beforeEach(() => {
  window.localStorage.clear();
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
    value: vi.fn((callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0)),
  });
  Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  reload();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("resume the last inspected lead from Surface", () => {
  it("returns from a linked lead with one saved attempt to the same lead after reload", async () => {
    const server: Server = {
      engagements: [engagement],
      leads: { [engagement.id]: [lead(FIRST_ID, engagement.id, { nextStep: "Try the vendor default" })] },
      attempts: {},
      recordAttempt: (leadId, body) => {
        const saved = attempt(leadId, 1, String(body["summary"]));
        server.attempts[leadId] = [saved];
        return response(saved, 201);
      },
    };
    const fetchMock = serve(server);
    await renderAt(engagement.id, `?sel=${encodeURIComponent(SEL)}`);
    expect(within(await screen.findByRole("region", { name: "Resume" })).queryByRole("region", { name: "Last lead" })).toBeNull();

    fireEvent.click(await linkedLeadButton(/Default creds/));
    fireEvent.change(await within(dialog()).findByLabelText("Attempt summary"), { target: { value: "Vendor default rejected" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Record attempt" }));
    expect(await within(dialog()).findByText("1. Vendor default rejected")).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Close" }));
    expect(stored(engagement.id)).toBe(FIRST_ID);
    const raw = window.localStorage.getItem(workspaceStateKey(engagement.id)) ?? "";
    for (const copied of ["Default creds", "artifact-1", "192.0.2.10", "Vendor default", "vendor default"]) {
      expect(raw).not.toContain(copied);
    }

    reload();
    server.leads[engagement.id] = [lead(FIRST_ID, engagement.id, { title: "Renamed creds", nextStep: "Try the vendor default" })];
    const router = await renderAt(engagement.id);
    const row = await lastLeadRow();
    const open = await within(row).findByRole("button", { name: "Renamed creds 00000001, open" });
    expect(within(row).getByText("open")).toBeTruthy();
    expect(screen.queryByText("Default creds")).toBeNull();

    fireEvent.click(open);
    expect(await within(dialog()).findByRole("heading", { name: "Renamed creds" })).toBeTruthy();
    expect(within(dialog()).getByText("Opened from Resume · saved source 192.0.2.10:80/tcp http")).toBeTruthy();
    expect(within(dialog()).queryByText(/evidence artifact-1/)).toBeNull();
    expect(within(dialog()).getByText("Next step: Try the vendor default")).toBeTruthy();
    expect(await within(dialog()).findByText("1. Vendor default rejected")).toBeTruthy();
    expect(within(dialog()).getAllByText(/Vendor default rejected/)).toHaveLength(1);
    expect(screen.queryByRole("complementary", { name: "Selection inspector" })).toBeNull();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(open));
    expect(router.state.location.search).toEqual({});
    expect(writes(fetchMock)).toEqual([`/api/v1/engagements/${engagement.id}/leads/${FIRST_ID}/attempts`]);
  });

  it("keeps the inspector selection and route while a Resume lead is open, and guards its draft", async () => {
    serve({ engagements: [engagement, otherEngagement], leads: { [engagement.id]: [lead(FIRST_ID, engagement.id)] }, attempts: {} });
    remember(engagement.id, FIRST_ID);
    const router = await renderAt(engagement.id, `?sel=${encodeURIComponent(SEL)}`);
    const searchBefore = { ...router.state.location.search };
    const inspector = await screen.findByRole("complementary", { name: "Selection inspector" });
    const open = await within(await lastLeadRow()).findByRole("button", { name: /^Default creds 00000001, open$/ });
    fireEvent.click(open);
    await within(dialog()).findByLabelText("Attempt summary");
    expect(inspector.hasAttribute("inert")).toBe(true);
    fireEvent.change(within(dialog()).getByLabelText("Attempt summary"), { target: { value: "Half typed" } });

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(within(dialog()).getByText("Discard unsaved lead edits?")).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Stay" }));
    void router.navigate({ to: "/engagements/$engagementId", params: { engagementId: otherEngagement.id } });
    expect(await within(dialog()).findByText("Discard unsaved lead edits?")).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Stay" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/engagements/${engagement.id}`));
    expect(within(dialog()).getByDisplayValue("Half typed")).toBeTruthy();

    fireEvent.click(within(dialog()).getByRole("button", { name: "Close" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(document.activeElement).toBe(open));
    expect(inspector.isConnected).toBe(true);
    expect(inspector.hasAttribute("inert")).toBe(false);
    expect(router.state.location.search).toEqual(searchBefore);
    expect(stored(engagement.id)).toBe(FIRST_ID);
  });

  it("moves the pointer only to a validated same-title lead, never on a failed read", async () => {
    let failFirst = false;
    const server: Server = {
      engagements: [engagement],
      leads: { [engagement.id]: [lead(FIRST_ID, engagement.id), lead(SECOND_ID, engagement.id)] },
      attempts: {},
      readLead: (leadId) => (failFirst && leadId === FIRST_ID ? response({ code: "storage_busy" }, 503) : undefined),
    };
    serve(server);
    await renderAt(engagement.id, `?sel=${encodeURIComponent(SEL)}`);

    fireEvent.click(await linkedLeadButton(/^Default creds 00000002, open$/));
    await within(dialog()).findByLabelText("Attempt summary");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(stored(engagement.id)).toBe(SECOND_ID);
    expect(await within(await lastLeadRow()).findByRole("button", { name: /00000002, open$/ })).toBeTruthy();

    failFirst = true;
    fireEvent.click(await linkedLeadButton(/^Default creds 00000001, open$/));
    expect(await within(dialog()).findByText("Lead unavailable")).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(stored(engagement.id)).toBe(SECOND_ID);
    expect(within(await lastLeadRow()).getByRole("button", { name: /00000002, open$/ })).toBeTruthy();
    expect(within(await lastLeadRow()).queryByRole("button", { name: /00000001/ })).toBeNull();
  });

  it("keeps separate pointers per engagement and ignores a late read after a switch", async () => {
    let finishRead: ((value: Response) => void) | undefined;
    const server: Server = {
      engagements: [engagement, otherEngagement],
      leads: {
        [engagement.id]: [lead(FIRST_ID, engagement.id), lead(SECOND_ID, engagement.id)],
        [otherEngagement.id]: [lead(OTHER_ID, otherEngagement.id, { title: "Second box lead" })],
      },
      attempts: {},
      readLead: (leadId) => (leadId === SECOND_ID ? new Promise<Response>((resolve) => { finishRead = resolve; }) : undefined),
    };
    serve(server);
    remember(engagement.id, FIRST_ID);
    remember(otherEngagement.id, OTHER_ID);
    const router = await renderAt(engagement.id, `?sel=${encodeURIComponent(SEL)}`);
    expect(await within(await lastLeadRow()).findByRole("button", { name: /^Default creds 00000001, open$/ })).toBeTruthy();

    fireEvent.click(await linkedLeadButton(/^Default creds 00000002, open$/));
    await waitFor(() => expect(finishRead).toBeDefined());
    await router.navigate({ to: "/engagements/$engagementId", params: { engagementId: otherEngagement.id } });
    expect(await screen.findByRole("heading", { level: 1, name: "Second lab" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await within(await lastLeadRow()).findByRole("button", { name: /^Second box lead 00000003, open$/ })).toBeTruthy();
    expect(screen.queryByText("Default creds")).toBeNull();

    finishRead?.(response(lead(SECOND_ID, engagement.id)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stored(engagement.id)).toBe(FIRST_ID);
    expect(stored(otherEngagement.id)).toBe(OTHER_ID);

    await router.navigate({ to: "/engagements/$engagementId", params: { engagementId: engagement.id } });
    expect(await within(await lastLeadRow()).findByRole("button", { name: /^Default creds 00000001, open$/ })).toBeTruthy();
  });

  it("offers Forget only for a missing lead and Retry, keeping the pointer, for a failed read", async () => {
    let mode: "missing" | "failed" | "foreign" | "ok" = "failed";
    const fetchMock = serve({
      engagements: [engagement],
      leads: { [engagement.id]: [lead(FIRST_ID, engagement.id), lead(SECOND_ID, engagement.id)] },
      attempts: {},
      readLead: (leadId) => {
        if (mode === "failed") return response({ code: "storage_busy" }, 503);
        if (mode === "foreign") return response(lead(SECOND_ID, engagement.id));
        if (mode === "missing") return response({ code: "lead_not_found" }, 404);
        return leadId === FIRST_ID ? undefined : response({}, 500);
      },
    });
    remember(engagement.id, FIRST_ID);
    await renderAt(engagement.id);
    const row = await lastLeadRow();
    expect(await within(row).findByText(/Lead not loaded/)).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "Forget" })).toBeNull();

    mode = "foreign";
    fireEvent.click(within(row).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(leadReads(fetchMock)).toHaveLength(2));
    expect(await within(row).findByText(/Lead not loaded/)).toBeTruthy();
    expect(within(row).queryByRole("button", { name: /Default creds/ })).toBeNull();
    expect(stored(engagement.id)).toBe(FIRST_ID);

    mode = "ok";
    fireEvent.click(within(row).getByRole("button", { name: "Retry" }));
    expect(await within(row).findByRole("button", { name: /^Default creds 00000001, open$/ })).toBeTruthy();

    reload();
    mode = "missing";
    await renderAt(engagement.id);
    const missing = await lastLeadRow();
    expect(await within(missing).findByText(/Lead unavailable/)).toBeTruthy();
    expect(stored(engagement.id)).toBe(FIRST_ID);
    fireEvent.click(within(missing).getByRole("button", { name: "Forget" }));
    expect(within(band()).queryByRole("region", { name: "Last lead" })).toBeNull();
    expect(document.activeElement).toBe(band());
    expect(stored(engagement.id)).toBeNull();
    expect(leadReads(fetchMock).every((url) => url.endsWith(FIRST_ID))).toBe(true);
    expect(writes(fetchMock)).toEqual([]);
  });

  it("forgets from the overlay when the lead disappears after the row loaded", async () => {
    let missing = false;
    serve({ engagements: [engagement], leads: { [engagement.id]: [lead(FIRST_ID, engagement.id)] }, attempts: {},
      readLead: () => (missing ? response({ code: "lead_not_found" }, 404) : undefined) });
    remember(engagement.id, FIRST_ID);
    await renderAt(engagement.id);
    const open = await within(await lastLeadRow()).findByRole("button", { name: /Default creds/ });
    missing = true;
    fireEvent.click(open);
    expect(await within(dialog()).findByText("Lead not found")).toBeTruthy();
    expect(stored(engagement.id)).toBe(FIRST_ID);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Forget lead" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(stored(engagement.id)).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(band()));
    expect(within(band()).queryByRole("region", { name: "Last lead" })).toBeNull();
  });

  it("resumes a parked lead read-only in an archived engagement without writing", async () => {
    const fetchMock = serve({
      engagements: [archivedEngagement],
      leads: {
        [archivedEngagement.id]: [
          lead(FIRST_ID, archivedEngagement.id, { disposition: "parked", parkReason: "No creds yet", testedConditions: "Only anonymous" }),
        ],
      },
      attempts: {},
    });
    remember(archivedEngagement.id, FIRST_ID);
    await renderAt(archivedEngagement.id);
    const open = await within(await lastLeadRow()).findByRole("button", { name: /^Default creds 00000001, parked$/ });
    fireEvent.click(open);
    expect(await within(dialog()).findByText("Parked: No creds yet Tested under: Only anonymous.")).toBeTruthy();
    expect(within(dialog()).queryByLabelText("Attempt summary")).toBeNull();
    for (const name of ["Reopen", "Close lead"]) {
      expect(within(dialog()).getByRole<HTMLButtonElement>("button", { name }).disabled).toBe(true);
    }
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(open));
    expect(within(await lastLeadRow()).getByText("parked")).toBeTruthy();
    expect(writes(fetchMock)).toEqual([]);
  });

  it.each([
    ["legacy payload", JSON.stringify({ version: 1, selectedTarget: null })],
    ["path-shaped id", JSON.stringify({ version: 1, lastLeadId: "../../system/status" })],
    ["non-string id", JSON.stringify({ version: 1, lastLeadId: 42 })],
    ["other version", JSON.stringify({ version: 2, lastLeadId: FIRST_ID })],
    ["corrupt json", "{"],
  ])("shows no row and reads nothing for a %s", async (_name, raw) => {
    const fetchMock = serve({ engagements: [engagement], leads: { [engagement.id]: [lead(FIRST_ID, engagement.id)] }, attempts: {} });
    window.localStorage.setItem(workspaceStateKey(engagement.id), raw);
    await renderAt(engagement.id);
    await within(await screen.findByRole("region", { name: "Resume" })).findByText("Recent changes");
    expect(within(band()).queryByRole("region", { name: "Last lead" })).toBeNull();
    expect(within(band()).queryByText("Lead")).toBeNull();
    expect(leadReads(fetchMock)).toEqual([]);
  });

  it("keeps a closed lead and its opaque saved source without inventing a selection", async () => {
    const fetchMock = serve({
      engagements: [engagement],
      leads: { [engagement.id]: [lead(FIRST_ID, engagement.id, {
        disposition: "closed",
        source: { kind: "manual", ref: "opaque saved source" },
      })] },
      attempts: {},
    });
    remember(engagement.id, FIRST_ID);
    const router = await renderAt(engagement.id);
    const open = await within(await lastLeadRow()).findByRole("button", { name: /^Default creds 00000001, closed$/ });
    fireEvent.click(open);
    expect(await within(dialog()).findByText("Opened from Resume · saved source manual:opaque saved source")).toBeTruthy();
    expect(within(dialog()).queryByRole("button", { name: "Close lead" })).toBeNull();
    expect(within(dialog()).getByRole("button", { name: "Reopen" })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Selection inspector" })).toBeNull();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(document.activeElement).toBe(open));
    expect(router.state.location.search).toEqual({});
    expect(within(await lastLeadRow()).getByText("closed")).toBeTruthy();
    expect(writes(fetchMock)).toEqual([]);
  });

  it("does not remember a Surface lead whose evidence association changed", async () => {
    serve({
      engagements: [engagement],
      leads: { [engagement.id]: [lead(FIRST_ID, engagement.id), lead(SECOND_ID, engagement.id)] },
      attempts: {},
      readLead: (leadId) => leadId === SECOND_ID ? response(lead(SECOND_ID, engagement.id, { source: { kind: "nmap_service", ref: "other-artifact" } })) : undefined,
    });
    remember(engagement.id, FIRST_ID);
    await renderAt(engagement.id, `?sel=${encodeURIComponent(SEL)}`);
    fireEvent.click(await linkedLeadButton(/00000002, open$/));
    expect(await within(dialog()).findByText("Lead source changed")).toBeTruthy();
    expect(within(dialog()).queryByLabelText("Attempt summary")).toBeNull();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(stored(engagement.id)).toBe(FIRST_ID);
    expect(await within(await lastLeadRow()).findByRole("button", { name: /00000001, open$/ })).toBeTruthy();
  });

  it("ignores a late read after closing and validating another same-title lead", async () => {
    let finishRead: ((value: Response) => void) | undefined;
    serve({
      engagements: [engagement],
      leads: { [engagement.id]: [lead(FIRST_ID, engagement.id), lead(SECOND_ID, engagement.id)] },
      attempts: {},
      readLead: (leadId) => leadId === FIRST_ID ? new Promise<Response>((resolve) => { finishRead = resolve; }) : undefined,
    });
    await renderAt(engagement.id, `?sel=${encodeURIComponent(SEL)}`);
    fireEvent.click(await linkedLeadButton(/00000001, open$/));
    await waitFor(() => expect(finishRead).toBeDefined());
    expect(stored(engagement.id)).toBeNull();
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(await linkedLeadButton(/00000002, open$/));
    await within(dialog()).findByLabelText("Attempt summary");
    await waitFor(() => expect(stored(engagement.id)).toBe(SECOND_ID));
    finishRead?.(response(lead(FIRST_ID, engagement.id)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stored(engagement.id)).toBe(SECOND_ID);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(await within(await lastLeadRow()).findByRole("button", { name: /00000002, open$/ })).toBeTruthy();
  });

  it("keeps a Resume draft through a foreign-engagement refresh and attempt-read Retry", async () => {
    let foreign = false;
    let failAttempts = true;
    const fetchMock = serve({
      engagements: [engagement],
      leads: { [engagement.id]: [lead(FIRST_ID, engagement.id)] },
      attempts: { [FIRST_ID]: [attempt(FIRST_ID, 1, "Previous work")] },
      readLead: () => foreign ? response(lead(FIRST_ID, otherEngagement.id)) : undefined,
      readAttempts: () => failAttempts ? response({ code: "storage_busy" }, 503) : undefined,
    });
    remember(engagement.id, FIRST_ID);
    await renderAt(engagement.id);
    fireEvent.click(await within(await lastLeadRow()).findByRole("button", { name: /Default creds/ }));
    const summary = await within(dialog()).findByLabelText<HTMLInputElement>("Attempt summary");
    fireEvent.change(summary, { target: { value: "Draft stays local" } });
    expect(await within(dialog()).findByText("Attempts unavailable")).toBeTruthy();
    expect(within(dialog()).queryByText("No attempts recorded.")).toBeNull();
    failAttempts = false;
    fireEvent.click(within(dialog()).getByRole("button", { name: "Retry" }));
    expect(await within(dialog()).findByText("1. Previous work")).toBeTruthy();
    expect(summary.value).toBe("Draft stays local");

    foreign = true;
    await Promise.all([...testQueryClients].map((client) => client.invalidateQueries({ queryKey: leadQueryKey(engagement.id, FIRST_ID) })));
    expect(await within(dialog()).findByText("Lead unavailable")).toBeTruthy();
    expect(summary.isConnected).toBe(true);
    expect(summary.disabled).toBe(true);
    expect(summary.value).toBe("Draft stays local");
    expect(stored(engagement.id)).toBe(FIRST_ID);
    expect(stored(otherEngagement.id)).toBeNull();
    foreign = false;
    fireEvent.click(within(dialog()).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(summary.disabled).toBe(false));
    expect(summary.value).toBe("Draft stays local");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(within(dialog()).getByText("Discard unsaved lead edits?")).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Discard" }));
    expect(writes(fetchMock)).toEqual([]);
    expect(window.localStorage.getItem(workspaceStateKey(engagement.id))).not.toContain("Draft stays local");
  });

  it("keeps a draft guard when Forget clears a pointer after a fresh 404", async () => {
    let missing = false;
    serve({
      engagements: [engagement],
      leads: { [engagement.id]: [lead(FIRST_ID, engagement.id)] },
      attempts: {},
      readLead: () => missing ? response({ code: "lead_not_found" }, 404) : undefined,
    });
    remember(engagement.id, FIRST_ID);
    await renderAt(engagement.id);
    fireEvent.click(await within(await lastLeadRow()).findByRole("button", { name: /Default creds/ }));
    fireEvent.change(await within(dialog()).findByLabelText("Attempt summary"), { target: { value: "Still unsaved" } });
    missing = true;
    await Promise.all([...testQueryClients].map((client) => client.invalidateQueries({ queryKey: leadQueryKey(engagement.id, FIRST_ID) })));
    expect(await within(dialog()).findByText("Lead not found")).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Forget lead" }));
    expect(stored(engagement.id)).toBeNull();
    expect(within(dialog()).getByText("Discard unsaved lead edits?")).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Stay" }));
    expect(within(dialog()).getByDisplayValue("Still unsaved")).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(document.activeElement).toBe(band()));
    expect(within(band()).queryByRole("region", { name: "Last lead" })).toBeNull();
  });

  it("holds Resume navigation through a pending failed attempt, then allows Stay and save", async () => {
    let finishSave: ((value: Response) => void) | undefined;
    let failSave = true;
    const server: Server = {
      engagements: [engagement, otherEngagement],
      leads: { [engagement.id]: [lead(FIRST_ID, engagement.id)] },
      attempts: {},
      recordAttempt: (leadId, body) => {
        if (failSave) return new Promise<Response>((resolve) => { finishSave = resolve; });
        const saved = attempt(leadId, 1, String(body["summary"]));
        server.attempts[leadId] = [saved];
        return response(saved, 201);
      },
    };
    serve(server);
    remember(engagement.id, FIRST_ID);
    const router = await renderAt(engagement.id);
    fireEvent.click(await within(await lastLeadRow()).findByRole("button", { name: /Default creds/ }));
    fireEvent.change(await within(dialog()).findByLabelText("Attempt summary"), { target: { value: "Pending work" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Record attempt" }));
    await waitFor(() => expect(finishSave).toBeDefined());
    void router.navigate({ to: "/engagements/$engagementId", params: { engagementId: otherEngagement.id } });
    expect(await within(dialog()).findByText("Saving. Leaving continues after the save finishes.")).toBeTruthy();
    finishSave?.(response({ code: "storage_busy" }, 503));
    expect(await within(dialog()).findByText("Storage is busy. Try again.")).toBeTruthy();
    expect(router.state.location.pathname).toBe(`/engagements/${engagement.id}`);
    expect(within(dialog()).getByDisplayValue("Pending work")).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Stay" }));
    failSave = false;
    fireEvent.click(within(dialog()).getByRole("button", { name: "Record attempt" }));
    expect(await within(dialog()).findByText("1. Pending work")).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(stored(engagement.id)).toBe(FIRST_ID);
    expect(stored(otherEngagement.id)).toBeNull();
  });

  it.each([
    ["Close lead", "closeLead", "open"],
    ["Reopen", "reopenLead", "parked"],
    ["Dismiss", "dismissRevisit", "parked"],
  ] as const)("keeps a failed draft-free Resume %s navigation until Stay or Leave", async (operation, handler, disposition) => {
    const finishes: ((value: Response) => void)[] = [];
    const current = lead(FIRST_ID, engagement.id, {
      disposition,
      parkReason: disposition === "parked" ? "No access yet" : null,
      revisitSuggestion: operation === "Dismiss"
        ? { trigger: "new_access", reason: "New access may help", createdAt: TS, dismissed: false }
        : null,
    });
    const server: Server = {
      engagements: [engagement], leads: { [engagement.id]: [current] }, attempts: {},
      [handler]: () => new Promise<Response>((resolve) => { finishes.push(resolve); }),
    };
    const fetchMock = serve(server);
    remember(engagement.id, FIRST_ID);
    const router = await renderAt(engagement.id);
    fireEvent.click(await within(await lastLeadRow()).findByRole("button", { name: /Default creds/ }));
    await within(dialog()).findByLabelText("Attempt summary");
    const navigate = () => router.navigate({ to: "/engagements/$engagementId", params: { engagementId: engagement.id }, search: { tab: "notes" } });

    // First acknowledge with Stay, then prove a historical error does not
    // hold a clean route or prevent the same overlay opening again.
    fireEvent.click(within(dialog()).getByRole("button", { name: operation }));
    await waitFor(() => expect(finishes).toHaveLength(1));
    void navigate();
    expect(await within(dialog()).findByText("Saving. Leaving continues after the save finishes.")).toBeTruthy();
    expect(within(dialog()).queryByRole("button", { name: "Leave" })).toBeNull();
    expect(within(dialog()).queryByRole("button", { name: "Discard" })).toBeNull();
    finishes[0]?.(response({ code: "storage_busy" }, 503));
    expect(await within(dialog()).findByText("The change failed. Leave without applying it?")).toBeTruthy();
    expect(within(dialog()).getByText("Storage is busy. Try again.")).toBeTruthy();
    expect(router.state.location.search.tab).toBeUndefined();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Close" }));
    expect(within(dialog()).getByText("The change failed. Leave without applying it?")).toBeTruthy();
    expect(router.state.location.search.tab).toBeUndefined();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Stay" }));
    await waitFor(() => expect(within(dialog()).queryByText("The change failed. Leave without applying it?")).toBeNull());
    expect(within(dialog()).getByText("Storage is busy. Try again.")).toBeTruthy();
    expect(router.state.location.search.tab).toBeUndefined();
    await navigate();
    expect(router.state.location.search.tab).toBe("notes");
    expect(screen.queryByRole("dialog")).toBeNull();

    await router.navigate({ to: "/engagements/$engagementId", params: { engagementId: engagement.id }, search: { sel: SEL } });
    fireEvent.click(await within(await lastLeadRow()).findByRole("button", { name: /Default creds/ }));
    await within(dialog()).findByLabelText("Attempt summary");
    fireEvent.click(within(dialog()).getByRole("button", { name: operation }));
    await waitFor(() => expect(finishes).toHaveLength(2));
    void navigate();
    expect(await within(dialog()).findByText("Saving. Leaving continues after the save finishes.")).toBeTruthy();
    finishes[1]?.(response({ code: "storage_busy" }, 503));
    expect(await within(dialog()).findByText("The change failed. Leave without applying it?")).toBeTruthy();
    expect(within(dialog()).getByText("Storage is busy. Try again.")).toBeTruthy();
    expect(router.state.location.search.tab).toBeUndefined();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(router.state.location.search.tab).toBe("notes"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(writes(fetchMock)).toHaveLength(2);
  });

  it.each([
    ["Close lead", "closeLead", "open", "closed"],
    ["Reopen", "reopenLead", "parked", "open"],
    ["Dismiss", "dismissRevisit", "parked", "parked"],
  ] as const)("continues waiting navigation after a successful draft-free Resume %s", async (operation, handler, disposition, nextDisposition) => {
    let finish: ((value: Response) => void) | undefined;
    const current = lead(FIRST_ID, engagement.id, {
      disposition,
      parkReason: disposition === "parked" ? "No access yet" : null,
      revisitSuggestion: operation === "Dismiss"
        ? { trigger: "new_access", reason: "New access may help", createdAt: TS, dismissed: false }
        : null,
    });
    const server: Server = {
      engagements: [engagement], leads: { [engagement.id]: [current] }, attempts: {},
      [handler]: () => new Promise<Response>((resolve) => { finish = resolve; }),
    };
    serve(server);
    remember(engagement.id, FIRST_ID);
    const router = await renderAt(engagement.id);
    fireEvent.click(await within(await lastLeadRow()).findByRole("button", { name: /Default creds/ }));
    await within(dialog()).findByLabelText("Attempt summary");
    fireEvent.click(within(dialog()).getByRole("button", { name: operation }));
    await waitFor(() => expect(finish).toBeDefined());
    void router.navigate({ to: "/engagements/$engagementId", params: { engagementId: engagement.id }, search: { tab: "notes" } });
    expect(await within(dialog()).findByText("Saving. Leaving continues after the save finishes.")).toBeTruthy();
    const saved = { ...current, disposition: nextDisposition, revisitSuggestion: null };
    server.leads[engagement.id] = [saved];
    finish?.(response(saved));
    await waitFor(() => expect(router.state.location.search.tab).toBe("notes"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each([
    ["Close lead", "closeLead", "open", "closed"],
    ["Reopen", "reopenLead", "parked", "open"],
    ["Dismiss", "dismissRevisit", "parked", "parked"],
  ] as const)("continues a failed draft-free Resume %s navigation after a successful retry", async (operation, handler, disposition, nextDisposition) => {
    const finishes: ((value: Response) => void)[] = [];
    const current = lead(FIRST_ID, engagement.id, {
      disposition,
      parkReason: disposition === "parked" ? "No access yet" : null,
      revisitSuggestion: operation === "Dismiss"
        ? { trigger: "new_access", reason: "New access may help", createdAt: TS, dismissed: false }
        : null,
    });
    const server: Server = {
      engagements: [engagement], leads: { [engagement.id]: [current] }, attempts: {},
      [handler]: () => new Promise<Response>((resolve) => { finishes.push(resolve); }),
    };
    const fetchMock = serve(server);
    remember(engagement.id, FIRST_ID);
    const router = await renderAt(engagement.id);
    fireEvent.click(await within(await lastLeadRow()).findByRole("button", { name: /Default creds/ }));
    await within(dialog()).findByLabelText("Attempt summary");
    fireEvent.click(within(dialog()).getByRole("button", { name: operation }));
    await waitFor(() => expect(finishes).toHaveLength(1));
    void router.navigate({ to: "/engagements/$engagementId", params: { engagementId: engagement.id }, search: { tab: "notes" } });
    expect(await within(dialog()).findByText("Saving. Leaving continues after the save finishes.")).toBeTruthy();
    finishes[0]?.(response({ code: "storage_busy" }, 503));
    expect(await within(dialog()).findByText("The change failed. Leave without applying it?")).toBeTruthy();
    expect(within(dialog()).getByText("Storage is busy. Try again.")).toBeTruthy();
    expect(router.state.location.search.tab).toBeUndefined();

    fireEvent.click(within(dialog()).getByRole("button", { name: operation }));
    await waitFor(() => expect(finishes).toHaveLength(2));
    expect(within(dialog()).getByText("Saving. Leaving continues after the save finishes.")).toBeTruthy();
    expect(within(dialog()).queryByRole("button", { name: "Leave" })).toBeNull();
    expect(within(dialog()).queryByRole("button", { name: "Discard" })).toBeNull();
    expect(router.state.location.search.tab).toBeUndefined();
    const saved = { ...current, disposition: nextDisposition, revisitSuggestion: null };
    server.leads[engagement.id] = [saved];
    finishes[1]?.(response(saved));
    await waitFor(() => expect(router.state.location.search.tab).toBe("notes"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("The change failed. Leave without applying it?")).toBeNull();
    expect(writes(fetchMock)).toHaveLength(2);
  });

  it("continues a Resume operation despite an older mutation error", async () => {
    let finish: ((value: Response) => void) | undefined;
    const current = lead(FIRST_ID, engagement.id, { disposition: "parked", parkReason: "No access yet" });
    const server: Server = {
      engagements: [engagement], leads: { [engagement.id]: [current] }, attempts: {},
      closeLead: () => Promise.resolve(response({ code: "storage_busy" }, 503)),
      reopenLead: () => new Promise<Response>((resolve) => { finish = resolve; }),
    };
    serve(server);
    remember(engagement.id, FIRST_ID);
    const router = await renderAt(engagement.id);
    fireEvent.click(await within(await lastLeadRow()).findByRole("button", { name: /Default creds/ }));
    await within(dialog()).findByLabelText("Attempt summary");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Close lead" }));
    expect(await within(dialog()).findByText("Storage is busy. Try again.")).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Reopen" }));
    await waitFor(() => expect(finish).toBeDefined());
    void router.navigate({ to: "/engagements/$engagementId", params: { engagementId: engagement.id }, search: { tab: "notes" } });
    expect(await within(dialog()).findByText("Saving. Leaving continues after the save finishes.")).toBeTruthy();
    const saved = { ...current, disposition: "open", parkReason: null };
    server.leads[engagement.id] = [saved];
    finish?.(response(saved));
    await waitFor(() => expect(router.state.location.search.tab).toBe("notes"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("continues Resume navigation when a typed failed attempt succeeds on retry", async () => {
    const finishes: ((value: Response) => void)[] = [];
    const server: Server = {
      engagements: [engagement], leads: { [engagement.id]: [lead(FIRST_ID, engagement.id)] }, attempts: {},
      recordAttempt: () => new Promise<Response>((resolve) => { finishes.push(resolve); }),
    };
    serve(server);
    remember(engagement.id, FIRST_ID);
    const router = await renderAt(engagement.id);
    fireEvent.click(await within(await lastLeadRow()).findByRole("button", { name: /Default creds/ }));
    await within(dialog()).findByLabelText("Attempt summary");
    fireEvent.change(within(dialog()).getByLabelText("Attempt summary"), { target: { value: "Retry the saved attempt" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Record attempt" }));
    await waitFor(() => expect(finishes).toHaveLength(1));
    void router.navigate({ to: "/engagements/$engagementId", params: { engagementId: engagement.id }, search: { tab: "notes" } });
    expect(await within(dialog()).findByText("Saving. Leaving continues after the save finishes.")).toBeTruthy();
    finishes[0]?.(response({ code: "storage_busy" }, 503));
    expect(await within(dialog()).findByText("Storage is busy. Try again.")).toBeTruthy();
    expect(within(dialog()).getByText("Discard unsaved lead edits?")).toBeTruthy();
    expect(router.state.location.search.tab).toBeUndefined();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Record attempt" }));
    await waitFor(() => expect(finishes).toHaveLength(2));
    const saved = attempt(FIRST_ID, 1, "Retry the saved attempt");
    server.attempts[FIRST_ID] = [saved];
    finishes[1]?.(response(saved));
    await waitFor(() => expect(router.state.location.search.tab).toBe("notes"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reads and writes no remembered claim when browser storage is blocked", async () => {
    const getItem = Storage.prototype.getItem;
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key: string) {
      if (key.startsWith(WORKSPACE_STATE_KEY_PREFIX)) throw new DOMException("blocked", "SecurityError");
      return getItem.call(this, key);
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (key.startsWith(WORKSPACE_STATE_KEY_PREFIX)) throw new DOMException("blocked", "SecurityError");
      setItem.call(this, key, value);
    });
    const fetchMock = serve({ engagements: [engagement], leads: { [engagement.id]: [lead(FIRST_ID, engagement.id)] }, attempts: {} });
    await renderAt(engagement.id, `?sel=${encodeURIComponent(SEL)}`);
    const resume = await screen.findByRole("region", { name: "Resume" });
    expect(within(resume).queryByRole("region", { name: "Last lead" })).toBeNull();
    fireEvent.click(await linkedLeadButton(/Default creds/));
    await within(dialog()).findByLabelText("Attempt summary");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(within(band()).queryByRole("region", { name: "Last lead" })).toBeNull();
    expect(writes(fetchMock)).toEqual([]);
  });

  it("keeps the session working without claiming a lead when storage rejects the write", async () => {
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (key.startsWith(WORKSPACE_STATE_KEY_PREFIX)) throw new DOMException("full", "QuotaExceededError");
      setItem.call(this, key, value);
    });
    const server: Server = {
      engagements: [engagement],
      leads: { [engagement.id]: [lead(FIRST_ID, engagement.id)] },
      attempts: {},
      recordAttempt: (leadId, body) => {
        const saved = attempt(leadId, 1, String(body["summary"]));
        server.attempts[leadId] = [saved];
        return response(saved, 201);
      },
    };
    const fetchMock = serve(server);
    await renderAt(engagement.id, `?sel=${encodeURIComponent(SEL)}`);
    fireEvent.click(await linkedLeadButton(/Default creds/));
    fireEvent.change(await within(dialog()).findByLabelText("Attempt summary"), { target: { value: "Saved anyway" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Record attempt" }));
    expect(await within(dialog()).findByText("1. Saved anyway")).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(band()).queryByRole("region", { name: "Last lead" })).toBeNull();
    expect(window.localStorage.getItem(workspaceStateKey(engagement.id))).toBeNull();
    expect(writes(fetchMock)).toEqual([`/api/v1/engagements/${engagement.id}/leads/${FIRST_ID}/attempts`]);
  });
});

const FINDING_A = "50000000-0000-4000-8000-00000000000a";
const FINDING_B = "50000000-0000-4000-8000-00000000000b";

describe("link a saved finding while recording a lead attempt from Resume", () => {
  it("records one linked attempt and reads the same relation with the finding's current state after reload", async () => {
    const body = "Reused on <b>/admin</b>";
    const server: Server = {
      engagements: [engagement],
      leads: { [engagement.id]: [lead(FIRST_ID, engagement.id)] },
      attempts: {},
      findings: { [engagement.id]: [finding(FINDING_A, engagement.id), finding(FINDING_B, engagement.id, { body })] },
      recordAttempt: (leadId, payload) => {
        const saved = attempt(leadId, 1, String(payload["summary"]), { linkedFindingId: payload["linkedFindingId"] ?? null });
        server.attempts[leadId] = [saved];
        return response(saved, 201);
      },
    };
    const fetchMock = serve(server);
    remember(engagement.id, FIRST_ID);
    await renderAt(engagement.id);
    const open = await within(await lastLeadRow()).findByRole("button", { name: /Default creds/ });
    fireEvent.click(open);

    await waitFor(() =>
      expect(findingOptions()).toEqual(["None", "Weak admin password · open · 0000000a", "Weak admin password · open · 0000000b"]),
    );
    fireEvent.change(chooser(), { target: { value: FINDING_B } });
    fireEvent.change(within(dialog()).getByLabelText("Attempt summary"), { target: { value: "Admin accepted the vendor default" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Record attempt" }));
    expect(await within(dialog()).findByText("1. Admin accepted the vendor default")).toBeTruthy();
    await waitFor(() => expect(linkedRows()).toEqual(["Linked finding Weak admin password · open"]));
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]![1]!.body))).toEqual({
      summary: "Admin accepted the vendor default",
      outcome: "observed",
      evidenceArtifactIds: [],
      linkedFindingId: FINDING_B,
    });

    fireEvent.click(within(dialog()).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(open));
    const raw = window.localStorage.getItem(workspaceStateKey(engagement.id)) ?? "";
    for (const copied of [FINDING_B, "Weak admin password", "Admin accepted"]) expect(raw).not.toContain(copied);

    reload();
    server.findings![engagement.id] = [
      finding(FINDING_A, engagement.id),
      finding(FINDING_B, engagement.id, { title: "Admin password reused", status: "resolved", body, revision: 1 }),
    ];
    const router = await renderAt(engagement.id);
    const again = await within(await lastLeadRow()).findByRole("button", { name: /Default creds/ });
    fireEvent.click(again);
    expect(await within(dialog()).findByText("1. Admin accepted the vendor default")).toBeTruthy();
    await waitFor(() => expect(linkedRows()).toEqual(["Linked finding Admin password reused · resolved"]));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Show current body" }));
    expect(within(dialog()).getByText(body)).toBeTruthy();
    expect(dialog().querySelector("b")).toBeNull();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(again));
    expect(router.state.location.search).toEqual({});
    expect(writes(fetchMock)).toEqual([`/api/v1/engagements/${engagement.id}/leads/${FIRST_ID}/attempts`]);
  });

  it("holds a finding-only choice, keeps it through a failed save, and continues the waiting route after retry", async () => {
    const finishes: ((value: Response) => void)[] = [];
    const bodies: Record<string, unknown>[] = [];
    const server: Server = {
      engagements: [engagement],
      leads: { [engagement.id]: [lead(FIRST_ID, engagement.id)] },
      attempts: {},
      findings: { [engagement.id]: [finding(FINDING_A, engagement.id)] },
      recordAttempt: (_leadId, payload) => {
        bodies.push(payload);
        return new Promise<Response>((resolve) => { finishes.push(resolve); });
      },
    };
    serve(server);
    remember(engagement.id, FIRST_ID);
    const router = await renderAt(engagement.id);
    fireEvent.click(await within(await lastLeadRow()).findByRole("button", { name: /Default creds/ }));
    await waitFor(() => expect(findingOptions()).toEqual(["None", "Weak admin password · open"]));

    fireEvent.change(chooser(), { target: { value: FINDING_A } });
    void router.navigate({ to: "/engagements/$engagementId", params: { engagementId: engagement.id }, search: { tab: "notes" } });
    expect(await within(dialog()).findByText("Discard unsaved lead edits?")).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Stay" }));
    await waitFor(() => expect(router.state.location.search.tab).toBeUndefined());
    expect(chooser().value).toBe(FINDING_A);

    fireEvent.change(within(dialog()).getByLabelText("Attempt summary"), { target: { value: "Vendor default accepted" } });
    fireEvent.change(within(dialog()).getByLabelText("Conditions, optional"), { target: { value: "Over HTTP only" } });
    fireEvent.change(within(dialog()).getByLabelText("Outcome"), { target: { value: "inconclusive" } });
    fireEvent.change(within(dialog()).getByLabelText("Evidence artifact ids, comma separated"), { target: { value: "proof-1, proof-2" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Record attempt" }));
    await waitFor(() => expect(finishes).toHaveLength(1));
    expect(within(dialog()).getByRole<HTMLButtonElement>("button", { name: "Saving" }).disabled).toBe(true);
    void router.navigate({ to: "/engagements/$engagementId", params: { engagementId: engagement.id }, search: { tab: "notes" } });
    expect(await within(dialog()).findByText("Saving. Leaving continues after the save finishes.")).toBeTruthy();
    finishes[0]?.(response({ code: "storage_busy" }, 503));
    expect(await within(dialog()).findByText("Storage is busy. Try again.")).toBeTruthy();
    expect(chooser().value).toBe(FINDING_A);
    expect(within(dialog()).getByDisplayValue("Vendor default accepted")).toBeTruthy();
    expect(within(dialog()).getByDisplayValue("Over HTTP only")).toBeTruthy();
    expect(within(dialog()).getByLabelText<HTMLSelectElement>("Outcome").value).toBe("inconclusive");
    expect(within(dialog()).getByDisplayValue("proof-1, proof-2")).toBeTruthy();
    expect(router.state.location.search.tab).toBeUndefined();

    fireEvent.click(within(dialog()).getByRole("button", { name: "Record attempt" }));
    await waitFor(() => expect(finishes).toHaveLength(2));
    const saved = attempt(FIRST_ID, 1, "Vendor default accepted", { linkedFindingId: FINDING_A });
    server.attempts[FIRST_ID] = [saved];
    finishes[1]?.(response(saved, 201));
    await waitFor(() => expect(router.state.location.search.tab).toBe("notes"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(bodies).toEqual([1, 2].map(() => ({
      summary: "Vendor default accepted",
      outcome: "inconclusive",
      conditions: "Over HTTP only",
      evidenceArtifactIds: ["proof-1", "proof-2"],
      linkedFindingId: FINDING_A,
    })));
  });
});
