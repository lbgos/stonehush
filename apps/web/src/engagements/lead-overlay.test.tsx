// @vitest-environment jsdom

import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { createAppRouter } from "../router.js";
import { leadQueryKey, leadAttemptsQueryKey } from "./leads-query.js";
import { pathSelectionKey, serviceSelectionKey } from "./inspector.js";

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

const OPEN_ID = "20000000-0000-4000-8000-000000000001";
const PARKED_ID = "20000000-0000-4000-8000-000000000002";
const ELSEWHERE_ID = "20000000-0000-4000-8000-000000000003";

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
    outcome: "inconclusive",
    conditions: null,
    evidenceArtifactIds: [],
    linkedFindingId: null,
    linkedObjectiveId: null,
    createdAt: TS,
    ...extra,
  };
}

function response(payload: unknown, status = 200): Response {
  return { json: async () => payload, ok: status >= 200 && status < 300, status } as Response;
}

interface Server {
  engagements: TestEngagement[];
  leads: Record<string, ReturnType<typeof lead>[]>;
  attempts: Record<string, ReturnType<typeof attempt>[]>;
  readLead?: (leadId: string, engagementId: string) => Response | Promise<Response> | undefined;
  readAttempts?: (leadId: string) => Response | Promise<Response> | undefined;
  paths?: readonly Record<string, unknown>[];
  parkLead?: (leadId: string) => Response | Promise<Response>;
  closeLead?: (leadId: string) => Response | Promise<Response>;
  reopenLead?: (leadId: string) => Response | Promise<Response>;
  dismissRevisit?: (leadId: string) => Response | Promise<Response>;
  recordAttempt?: (leadId: string, body: Record<string, unknown>) => Response | Promise<Response>;
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
    if (rest === "/ffuf-results") return Promise.resolve(response(server.paths ?? []));
    if (rest === "/services") return Promise.resolve(response([service]));
    if (rest === "/leads") return Promise.resolve(response(server.leads[engagementId] ?? []));
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
      if (tail === "/attempts" && isRead(init)) {
        return Promise.resolve(server.readAttempts?.(leadId) ?? response(server.attempts[leadId] ?? []));
      }
      if (tail === "/attempts" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Promise.resolve(server.recordAttempt?.(leadId, body) ?? response({ code: "invalid_request" }, 400));
      }
      if (tail === "/park" && init?.method === "POST") {
        return Promise.resolve(server.parkLead?.(leadId) ?? response({ code: "invalid_request" }, 400));
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

const testQueryClients = new Set<QueryClient>();

async function renderAt(engagementId: string, options: { selection?: string; seed?: (client: QueryClient) => void } = {}) {
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: [`/engagements/${engagementId}?sel=${encodeURIComponent(options.selection ?? SEL)}`] }),
  );
  await router.load();
  const queryClient = createAppQueryClient();
  testQueryClients.add(queryClient);
  options.seed?.(queryClient);
  render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return router;
}

async function linkedLeadButton(name: RegExp) {
  const list = await screen.findByRole("list", { name: "Leads linked to this evidence" });
  return within(list).getByRole("button", { name });
}

function dialog() {
  return screen.getByRole("dialog");
}

function typeSummary(value: string) {
  fireEvent.change(within(dialog()).getByLabelText("Attempt summary"), { target: { value } });
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
  cleanup();
  for (const client of testQueryClients) client.clear();
  testQueryClients.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("continue an evidence-linked lead from Surface", () => {
  it("opens the exact lead, records one explicit attempt, and returns to the same inspector", async () => {
    const server: Server = {
      engagements: [engagement],
      leads: {
        [engagement.id]: [
          lead(OPEN_ID, engagement.id, { nextStep: "Try the vendor default" }),
          lead(PARKED_ID, engagement.id, { disposition: "parked", parkReason: "No creds yet" }),
          lead(ELSEWHERE_ID, engagement.id, { title: "Other evidence", source: { kind: "http_probe", ref: "artifact-2" } }),
        ],
      },
      attempts: { [OPEN_ID]: [attempt(OPEN_ID, 1, "Tried admin/admin")] },
      recordAttempt: (leadId, body) => {
        const saved = attempt(leadId, 2, String(body["summary"]), {
          outcome: body["outcome"],
          conditions: body["conditions"] ?? null,
        });
        server.attempts[leadId] = [...(server.attempts[leadId] ?? []), saved];
        return response(saved, 201);
      },
    };
    const fetchMock = serve(server);
    const router = await renderAt(engagement.id);
    const searchBefore = { ...router.state.location.search };

    expect(screen.queryByRole("button", { name: /Other evidence/ })).toBeNull();
    const opener = await linkedLeadButton(/^Default creds 00000001, open$/);
    await linkedLeadButton(/^Default creds 00000002, parked$/);
    fireEvent.click(opener);

    expect(await within(dialog()).findByRole("heading", { name: "Default creds" })).toBeTruthy();
    expect(within(dialog()).getByText("Next step: Try the vendor default")).toBeTruthy();
    expect(await within(dialog()).findByText("1. Tried admin/admin")).toBeTruthy();
    expect(within(dialog()).getByText(/Opened from 192\.0\.2\.10:80/)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url) === `/api/v1/engagements/${engagement.id}/leads/${OPEN_ID}`)).toBe(true);
    expect(screen.getByRole("complementary", { name: "Selection inspector" })).toBeTruthy();
    expect(router.state.location.search).toEqual(searchBefore);

    typeSummary("Vendor default rejected");
    fireEvent.change(within(dialog()).getByLabelText("Outcome"), { target: { value: "ruled_out" } });
    fireEvent.change(within(dialog()).getByLabelText("Conditions, optional"), { target: { value: "Only over HTTP" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Record attempt" }));

    expect(await within(dialog()).findByText("2. Vendor default rejected")).toBeTruthy();
    expect(within(dialog()).getAllByText(/Vendor default rejected/)).toHaveLength(1);
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]![1]!.body))).toEqual({
      summary: "Vendor default rejected",
      outcome: "ruled_out",
      conditions: "Only over HTTP",
      evidenceArtifactIds: [],
    });

    // The cleared form leaves nothing to discard.
    fireEvent.click(within(dialog()).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(router.state.location.search).toEqual(searchBefore);
    expect(writes(fetchMock)).toEqual([`/api/v1/engagements/${engagement.id}/leads/${OPEN_ID}/attempts`]);

    // The ordinary Leads tab shows the same saved history.
    await router.navigate({ to: "/engagements/$engagementId", params: { engagementId: engagement.id }, search: { tab: "leads" } });
    const detailButtons = await screen.findAllByRole("button", { name: "Detail" });
    fireEvent.click(detailButtons[0]!);
    expect(await screen.findByText("2. Vendor default rejected")).toBeTruthy();
  });

  it("holds a typed attempt on Close, Escape, backdrop, and route changes until Discard", async () => {
    const server: Server = { engagements: [engagement, otherEngagement], leads: { [engagement.id]: [lead(OPEN_ID, engagement.id)] }, attempts: {} };
    const fetchMock = serve(server);
    const router = await renderAt(engagement.id);
    const opener = await linkedLeadButton(/Default creds/);
    fireEvent.click(opener);
    await within(dialog()).findByLabelText("Attempt summary");
    typeSummary("Half typed");

    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(within(dialog()).getByText("Discard the unsaved attempt or park reason?")).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Stay" }));
    expect(within(dialog()).queryByText(/Discard the unsaved/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss lead" }));
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(within(dialog()).queryByText(/Discard the unsaved/)).toBeNull();

    void router.navigate({ to: "/engagements/$engagementId", params: { engagementId: otherEngagement.id } });
    expect(await within(dialog()).findByText("Discard the unsaved attempt or park reason?")).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Stay" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/engagements/${engagement.id}`));
    expect(within(dialog()).getByDisplayValue("Half typed")).toBeTruthy();

    fireEvent.click(within(dialog()).getByRole("button", { name: "Close" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(writes(fetchMock)).toEqual([]);
  });

  it("keeps the draft after a failed save and holds a pending save until it lands", async () => {
    let finishSave: (value: Response) => void = () => undefined;
    let saves = 0;
    const server: Server = {
      engagements: [engagement],
      leads: { [engagement.id]: [lead(OPEN_ID, engagement.id)] },
      attempts: {},
      recordAttempt: (leadId, body) => {
        saves += 1;
        if (saves === 1) return response({ code: "storage_busy" }, 503);
        return new Promise<Response>((resolve) => {
          finishSave = (value) => {
            server.attempts[leadId] = [attempt(leadId, 1, String(body["summary"]))];
            resolve(value);
          };
        });
      },
    };
    serve(server);
    const router = await renderAt(engagement.id);
    fireEvent.click(await linkedLeadButton(/Default creds/));
    await within(dialog()).findByLabelText("Attempt summary");
    typeSummary("Checked TLS only");

    fireEvent.click(within(dialog()).getByRole("button", { name: "Record attempt" }));
    expect(await within(dialog()).findByText("Storage is busy. Try again.")).toBeTruthy();
    expect(within(dialog()).getByDisplayValue("Checked TLS only")).toBeTruthy();

    fireEvent.click(within(dialog()).getByRole("button", { name: "Record attempt" }));
    const saving = await within(dialog()).findByRole<HTMLButtonElement>("button", { name: "Saving" });
    expect(saving.disabled).toBe(true);
    fireEvent.click(saving);
    expect(within(dialog()).getByRole<HTMLButtonElement>("button", { name: "Close" }).disabled).toBe(true);
    fireEvent.keyDown(dialog(), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss lead" }));
    expect(screen.getByRole("dialog")).toBeTruthy();

    void router.navigate({ to: "/engagements/$engagementId", params: { engagementId: engagement.id }, search: { tab: "leads" } });
    expect(await within(dialog()).findByText("Saving. Leaving continues after the save finishes.")).toBeTruthy();
    expect(within(dialog()).queryByRole("button", { name: "Discard" })).toBeNull();
    expect(router.state.location.search.tab).toBeUndefined();

    finishSave(response(attempt(OPEN_ID, 1, "Checked TLS only"), 201));
    await waitFor(() => expect(router.state.location.search.tab).toBe("leads"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(saves).toBe(2);
  });

  it("opens a parked lead read-only in an archived engagement without writing", async () => {
    const server: Server = {
      engagements: [archivedEngagement],
      leads: {
        [archivedEngagement.id]: [
          lead(PARKED_ID, archivedEngagement.id, {
            disposition: "parked",
            parkReason: "No creds yet",
            testedConditions: "Only anonymous",
            revisitSuggestion: { trigger: "new_access", reason: "New access recorded", createdAt: TS, dismissed: false },
          }),
        ],
      },
      attempts: {},
    };
    const fetchMock = serve(server);
    await renderAt(archivedEngagement.id);
    fireEvent.click(await linkedLeadButton(/Default creds/));

    expect(await within(dialog()).findByText("Parked: No creds yet Tested under: Only anonymous.")).toBeTruthy();
    expect(within(dialog()).getByText(/This engagement is archived/)).toBeTruthy();
    expect(within(dialog()).queryByLabelText("Attempt summary")).toBeNull();
    expect(within(dialog()).queryByLabelText("Park reason")).toBeNull();
    for (const name of ["Reopen", "Close lead", "Dismiss"]) {
      expect(within(dialog()).getByRole<HTMLButtonElement>("button", { name }).disabled).toBe(true);
    }
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(writes(fetchMock)).toEqual([]);
  });

  it("shows missing, moved, mismatched, and failed reads honestly with Retry", async () => {
    let mode: "missing" | "moved" | "foreign" | "failed" | "ok" = "missing";
    const server: Server = {
      engagements: [engagement],
      leads: { [engagement.id]: [lead(OPEN_ID, engagement.id)] },
      attempts: {},
      readLead: (leadId, engagementId) => {
        if (mode === "missing") return response({ code: "lead_not_found" }, 404);
        if (mode === "moved") return response(lead(leadId, engagementId, { source: { kind: "nmap_service", ref: "artifact-9" } }));
        if (mode === "foreign") return response(lead(leadId, otherEngagement.id));
        if (mode === "failed") return response({ code: "storage_busy" }, 503);
        return undefined;
      },
      readAttempts: () => response({ code: "storage_busy" }, 503),
    };
    const fetchMock = serve(server);
    await renderAt(engagement.id);
    fireEvent.click(await linkedLeadButton(/Default creds/));

    expect(await within(dialog()).findByText("Lead not found")).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Selection inspector" })).toBeTruthy();
    for (const [next, title] of [
      ["moved", "Lead source changed"],
      ["foreign", "Lead unavailable"],
      ["failed", "Lead unavailable"],
    ] as const) {
      mode = next;
      fireEvent.click(within(dialog()).getByRole("button", { name: "Retry" }));
      expect(await within(dialog()).findByText(title)).toBeTruthy();
      expect(within(dialog()).queryByLabelText("Attempt summary")).toBeNull();
    }

    mode = "ok";
    fireEvent.click(within(dialog()).getByRole("button", { name: "Retry" }));
    expect(await within(dialog()).findByText("Attempts unavailable")).toBeTruthy();
    expect(within(dialog()).queryByText("No attempts recorded.")).toBeNull();
    expect(writes(fetchMock)).toEqual([]);
  });

  it("drops an open lead without a draft when the engagement changes and ignores its late read", async () => {
    let finishRead: (value: Response) => void = () => undefined;
    const server: Server = {
      engagements: [engagement, otherEngagement],
      leads: { [engagement.id]: [lead(OPEN_ID, engagement.id)], [otherEngagement.id]: [] },
      attempts: {},
      readLead: () => new Promise<Response>((resolve) => {
        finishRead = resolve;
      }),
    };
    serve(server);
    const router = await renderAt(engagement.id);
    fireEvent.click(await linkedLeadButton(/Default creds/));
    expect(within(dialog()).getByRole("status", { name: "Loading lead" })).toBeTruthy();

    await router.navigate({ to: "/engagements/$engagementId", params: { engagementId: otherEngagement.id } });
    expect(await screen.findByRole("heading", { level: 1, name: "Second lab" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    finishRead(response(lead(OPEN_ID, engagement.id)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Default creds")).toBeNull();
  });

  it("requires a new read even when a cached lead has the current clock timestamp", async () => {
    vi.spyOn(Date, "now").mockReturnValue(2_000_000_000_000);
    let finish: ((value: Response) => void) | undefined;
    serve({ engagements: [engagement], leads: { [engagement.id]: [lead(OPEN_ID, engagement.id)] }, attempts: {},
      readLead: () => new Promise((resolve) => { finish = resolve; }) });
    await renderAt(engagement.id, { seed: (client) => client.setQueryData(leadQueryKey(engagement.id, OPEN_ID), lead(OPEN_ID, engagement.id)) });
    fireEvent.click(await linkedLeadButton(/Default creds/));
    expect(within(dialog()).queryByLabelText("Attempt summary")).toBeNull();
    await waitFor(() => expect(finish).toBeDefined());
    finish?.(response(lead(OPEN_ID, engagement.id, { source: { kind: "nmap_service", ref: "artifact-elsewhere" } })));
    expect(await within(dialog()).findByText("Lead source changed")).toBeTruthy();
    expect(within(dialog()).queryByLabelText("Attempt summary")).toBeNull();
  });

  it("rejects a different saved lead id instead of substituting its form", async () => {
    serve({ engagements: [engagement], leads: { [engagement.id]: [lead(OPEN_ID, engagement.id)] }, attempts: {}, readLead: () => response(lead(PARKED_ID, engagement.id)) });
    await renderAt(engagement.id);
    fireEvent.click(await linkedLeadButton(/Default creds/));
    expect(await within(dialog()).findByText("Lead unavailable")).toBeTruthy();
    expect(within(dialog()).queryByLabelText("Attempt summary")).toBeNull();
  });

  it.each([
    [PARKED_ID, "00000001", "00000002"],
    ["20000000-0000-4000-8001-000000000001", "0-000000000001", "1-000000000001"],
  ])("keeps the distinguishing identifier for same-title lead %s in its header", async (secondId, firstSuffix, secondSuffix) => {
    const second = lead(secondId, engagement.id, { nextStep: "Second exact record" });
    const fetchMock = serve({ engagements: [engagement], leads: { [engagement.id]: [lead(OPEN_ID, engagement.id), second] }, attempts: {} });
    await renderAt(engagement.id);
    const first = await linkedLeadButton(new RegExp(`^Default creds ${firstSuffix}, open$`));
    const secondButton = await linkedLeadButton(new RegExp(`^Default creds ${secondSuffix}, open$`));
    expect(first.getAttribute("aria-label")).not.toBe(secondButton.getAttribute("aria-label"));
    fireEvent.click(secondButton);
    expect(await within(dialog()).findByText("Next step: Second exact record")).toBeTruthy();
    expect(within(dialog()).getByText(secondSuffix).getAttribute("title")).toBe(secondId);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(`/leads/${secondId}`))).toBe(true);
  });

  it.each(["wrong lead", "wrong engagement"])("rejects attempt history for the %s", async (kind) => {
    serve({ engagements: [engagement], leads: { [engagement.id]: [lead(OPEN_ID, engagement.id)] }, attempts: {},
      readAttempts: () => response([attempt(kind === "wrong lead" ? PARKED_ID : OPEN_ID, 1, "Foreign attempt", kind === "wrong engagement" ? { engagementId: otherEngagement.id } : {})]) });
    await renderAt(engagement.id);
    fireEvent.click(await linkedLeadButton(/Default creds/));
    expect(await within(dialog()).findByText("Attempts unavailable")).toBeTruthy();
    expect(within(dialog()).queryByText("1. Foreign attempt")).toBeNull();
    expect(within(dialog()).queryByText("No attempts recorded.")).toBeNull();
  });

  it("retains a draft through an invalid refreshed association and restores it on Retry", async () => {
    let mode = "valid";
    serve({ engagements: [engagement], leads: { [engagement.id]: [lead(OPEN_ID, engagement.id)] }, attempts: {},
      readLead: () => response(lead(OPEN_ID, engagement.id, mode === "valid" ? {} : { source: { kind: "nmap_service", ref: "moved-artifact" } })) });
    await renderAt(engagement.id);
    fireEvent.click(await linkedLeadButton(/Default creds/));
    const summary = await within(dialog()).findByLabelText("Attempt summary") as HTMLInputElement;
    typeSummary("Keep this exact draft");
    mode = "invalid";
    await Promise.all([...testQueryClients].map((client) => client.invalidateQueries({ queryKey: leadQueryKey(engagement.id, OPEN_ID) })));
    expect(await within(dialog()).findByText("Lead source changed")).toBeTruthy();
    expect(within(dialog()).getByLabelText("Attempt summary")).toBe(summary);
    expect(summary.value).toBe("Keep this exact draft");
    expect(within(dialog()).getByRole<HTMLButtonElement>("button", { name: "Record attempt" }).disabled).toBe(true);
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(within(dialog()).getByText("Discard the unsaved attempt or park reason?")).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Stay" }));
    mode = "valid";
    fireEvent.click(within(dialog()).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(within(dialog()).getByRole<HTMLButtonElement>("button", { name: "Record attempt" }).disabled).toBe(false));
    expect(within(dialog()).getByLabelText("Attempt summary")).toBe(summary);
    expect(summary.value).toBe("Keep this exact draft");
  });

  it("keeps the mounted draft on a refresh failure and preserves older attempts with a warning", async () => {
    let fail = false;
    serve({ engagements: [engagement], leads: { [engagement.id]: [lead(OPEN_ID, engagement.id)] }, attempts: { [OPEN_ID]: [attempt(OPEN_ID, 1, "Previous work")] },
      readLead: () => fail ? response({}, 503) : undefined,
      readAttempts: () => fail ? response({}, 503) : undefined });
    await renderAt(engagement.id);
    fireEvent.click(await linkedLeadButton(/Default creds/));
    const summary = await within(dialog()).findByLabelText("Attempt summary") as HTMLInputElement;
    expect(await within(dialog()).findByText("1. Previous work")).toBeTruthy();
    typeSummary("Preserved draft");
    fail = true;
    await Promise.all([...testQueryClients].map((client) => client.invalidateQueries({ queryKey: ["engagements", engagement.id, "leads"] })));
    expect(await within(dialog()).findByText("Refresh failed. Showing the lead as last read.")).toBeTruthy();
    expect(within(dialog()).getByText("Refresh failed. Showing the last loaded attempts.")).toBeTruthy();
    expect(within(dialog()).getByText("1. Previous work")).toBeTruthy();
    expect(within(dialog()).getByLabelText("Attempt summary")).toBe(summary);
    expect(summary.value).toBe("Preserved draft");
    expect(within(dialog()).getByRole<HTMLButtonElement>("button", { name: "Record attempt" }).disabled).toBe(true);
    expect(within(dialog()).getByRole<HTMLButtonElement>("button", { name: "Close lead" }).disabled).toBe(true);
    expect(within(dialog()).getByRole<HTMLButtonElement>("button", { name: "Park with reason" }).disabled).toBe(true);
    fail = false;
    fireEvent.click(within(dialog()).getAllByRole("button", { name: "Retry" })[0]!);
    await waitFor(() => expect(within(dialog()).getByRole<HTMLButtonElement>("button", { name: "Record attempt" }).disabled).toBe(false));
    expect(within(dialog()).getByLabelText("Attempt summary")).toBe(summary);
    expect(summary.value).toBe("Preserved draft");
  });

  it.each([false, true])("keeps park drafts visible after Close lead, with refresh failure %s", async (failRefresh) => {
    const initial = lead(OPEN_ID, engagement.id);
    let closed = false;
    const server: Server = {
      engagements: [engagement], leads: { [engagement.id]: [initial] }, attempts: {},
      readLead: () => closed && failRefresh ? response({}, 503) : undefined,
      closeLead: () => {
        closed = true;
        const saved = lead(OPEN_ID, engagement.id, { disposition: "closed" });
        server.leads[engagement.id] = [saved];
        return response(saved);
      },
    };
    const fetchMock = serve(server);
    await renderAt(engagement.id);
    fireEvent.click(await linkedLeadButton(/Default creds/));
    const reason = await within(dialog()).findByLabelText("Park reason") as HTMLInputElement;
    const conditions = within(dialog()).getByLabelText("Tested conditions, optional") as HTMLInputElement;
    fireEvent.change(reason, { target: { value: "Held park reason" } });
    fireEvent.change(conditions, { target: { value: "Held conditions" } });
    typeSummary("Held attempt");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Close lead" }));
    if (failRefresh) {
      expect(await within(dialog()).findByText("Refresh failed. Showing the lead as last read.")).toBeTruthy();
      for (const name of ["Record attempt", "Close lead", "Park with reason"]) {
        expect(within(dialog()).getByRole<HTMLButtonElement>("button", { name }).disabled).toBe(true);
      }
      expect(reason.value).toBe("Held park reason");
      server.readLead = () => undefined;
      fireEvent.click(within(dialog()).getByRole("button", { name: "Retry" }));
    }
    expect(await within(dialog()).findByText("Unsaved park draft. Reopen this lead to park it.")).toBeTruthy();
    expect(within(dialog()).getByLabelText("Park reason")).toBe(reason);
    expect(reason.value).toBe("Held park reason");
    expect(conditions.value).toBe("Held conditions");
    expect(within(dialog()).getByDisplayValue("Held attempt")).toBeTruthy();
    expect(within(dialog()).queryByRole("button", { name: "Park with reason" })).toBeNull();
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(within(dialog()).getByText("Discard the unsaved attempt or park reason?")).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Stay" }));
    expect(within(dialog()).getByDisplayValue("Held park reason")).toBeTruthy();
    expect(writes(fetchMock)).toEqual([`/api/v1/engagements/${engagement.id}/leads/${OPEN_ID}/close`]);
    fireEvent.click(within(dialog()).getByRole("button", { name: /^Close$/ }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each(["Record attempt", "Close lead", "Park with reason"])("keeps native body-focus keyboard events inside during and after %s", async (operation) => {
    let finish: ((value: Response) => void) | undefined;
    const hold = () => new Promise<Response>((resolve) => { finish = resolve; });
    const server: Server = {
      engagements: [engagement], leads: { [engagement.id]: [lead(OPEN_ID, engagement.id)] }, attempts: {},
      recordAttempt: hold, closeLead: hold, parkLead: hold,
    };
    serve(server);
    const router = await renderAt(engagement.id);
    const opener = await linkedLeadButton(/Default creds/);
    fireEvent.click(opener);
    await within(dialog()).findByLabelText("Attempt summary");
    const inspector = screen.getByRole("complementary", { name: "Selection inspector" });
    expect(inspector.hasAttribute("inert")).toBe(true);
    typeSummary("Keep after failed write");
    fireEvent.change(within(dialog()).getByLabelText("Park reason"), { target: { value: "Keep park reason" } });
    const control = within(dialog()).getByRole<HTMLButtonElement>("button", { name: operation });
    control.focus();
    fireEvent.click(control);
    await waitFor(() => expect(finish).toBeDefined());
    expect(control.disabled).toBe(true);
    expect(dialog().contains(document.activeElement)).toBe(true);
    document.body.tabIndex = -1;
    try {
      document.body.focus();
      expect(dialog().contains(document.activeElement)).toBe(true);
      fireEvent.keyDown(document.body, { key: "Tab" });
      expect(dialog().contains(document.activeElement)).toBe(true);
      fireEvent.keyDown(document.body, { key: "Tab", shiftKey: true });
      expect(dialog().contains(document.activeElement)).toBe(true);
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(within(dialog()).queryByText("Discard the unsaved attempt or park reason?")).toBeNull();
      expect(router.state.location.search.sel).toBe(SEL);
      finish?.(response({ code: "storage_busy" }, 503));
      expect(await within(dialog()).findByText("Storage is busy. Try again.")).toBeTruthy();
      await waitFor(() => expect(within(dialog()).getByRole<HTMLButtonElement>("button", { name: /^Close$/ }).disabled).toBe(false));
      document.body.focus();
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(within(dialog()).getByText("Discard the unsaved attempt or park reason?")).toBeTruthy();
      expect(within(dialog()).getByDisplayValue("Keep after failed write")).toBeTruthy();
      expect(within(dialog()).getByDisplayValue("Keep park reason")).toBeTruthy();
      expect(router.state.location.search.sel).toBe(SEL);
      fireEvent.click(within(dialog()).getByRole("button", { name: "Stay" }));
      fireEvent.keyDown(document.body, { key: "Escape" });
      fireEvent.click(within(dialog()).getByRole("button", { name: "Discard" }));
      await waitFor(() => expect(document.activeElement).toBe(opener));
      expect(inspector.hasAttribute("inert")).toBe(false);
      expect(router.state.location.search.sel).toBe(SEL);
    } finally {
      document.body.removeAttribute("tabindex");
    }
  });

  it("holds an outcome-only draft and restores field focus after backdrop Stay", async () => {
    serve({ engagements: [engagement], leads: { [engagement.id]: [lead(OPEN_ID, engagement.id)] }, attempts: {} });
    await renderAt(engagement.id);
    fireEvent.click(await linkedLeadButton(/Default creds/));
    const outcome = await within(dialog()).findByLabelText("Outcome");
    fireEvent.change(outcome, { target: { value: "inconclusive" } });
    outcome.focus();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss lead" }));
    expect(within(dialog()).getByText("Discard the unsaved attempt or park reason?")).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Stay" }));
    expect(document.activeElement).toBe(outcome);
    expect((outcome as HTMLSelectElement).value).toBe("inconclusive");
  });

  it("keeps a failed pending write and typed fields when blocked navigation resumes", async () => {
    let finish: ((value: Response) => void) | undefined;
    const fetchMock = serve({ engagements: [engagement], leads: { [engagement.id]: [lead(OPEN_ID, engagement.id)] }, attempts: {}, recordAttempt: () => new Promise((resolve) => { finish = resolve; }) });
    const router = await renderAt(engagement.id);
    fireEvent.click(await linkedLeadButton(/Default creds/));
    await within(dialog()).findByLabelText("Attempt summary");
    typeSummary("Failed pending snapshot");
    fireEvent.change(within(dialog()).getByLabelText("Conditions, optional"), { target: { value: "Authenticated only" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Record attempt" }));
    await waitFor(() => expect(finish).toBeDefined());
    void router.navigate({ to: "/engagements/$engagementId", params: { engagementId: engagement.id }, search: { tab: "notes" } });
    expect(await within(dialog()).findByText("Saving. Leaving continues after the save finishes.")).toBeTruthy();
    finish?.(response({ code: "storage_busy" }, 503));
    expect(await within(dialog()).findByText("Storage is busy. Try again.")).toBeTruthy();
    expect(within(dialog()).getByDisplayValue("Failed pending snapshot")).toBeTruthy();
    expect(within(dialog()).getByDisplayValue("Authenticated only")).toBeTruthy();
    expect(within(dialog()).getByRole("button", { name: "Discard" })).toBeTruthy();
    expect(router.state.location.search.tab).toBeUndefined();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Stay" }));
    expect(writes(fetchMock)).toHaveLength(1);
  });


  it.each([
    ["Close lead", "closeLead", "open"],
    ["Reopen", "reopenLead", "parked"],
    ["Dismiss", "dismissRevisit", "parked"],
  ] as const)("keeps a failed draft-free %s navigation until Stay or Leave", async (operation, handler, disposition) => {
    const finishes: ((value: Response) => void)[] = [];
    const current = lead(OPEN_ID, engagement.id, {
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
    const router = await renderAt(engagement.id);
    fireEvent.click(await linkedLeadButton(/Default creds/));
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
    fireEvent.click(await linkedLeadButton(/Default creds/));
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
  ] as const)("continues waiting navigation after a successful draft-free %s", async (operation, handler, disposition, nextDisposition) => {
    let finish: ((value: Response) => void) | undefined;
    const current = lead(OPEN_ID, engagement.id, {
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
    const router = await renderAt(engagement.id);
    fireEvent.click(await linkedLeadButton(/Default creds/));
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

  it("continues a new successful operation despite an older mutation error", async () => {
    let finish: ((value: Response) => void) | undefined;
    const current = lead(OPEN_ID, engagement.id, { disposition: "parked", parkReason: "No access yet" });
    const server: Server = {
      engagements: [engagement], leads: { [engagement.id]: [current] }, attempts: {},
      closeLead: () => Promise.resolve(response({ code: "storage_busy" }, 503)),
      reopenLead: () => new Promise<Response>((resolve) => { finish = resolve; }),
    };
    serve(server);
    const router = await renderAt(engagement.id);
    fireEvent.click(await linkedLeadButton(/Default creds/));
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

  it("continues waiting navigation when a typed failed attempt succeeds on retry", async () => {
    const finishes: ((value: Response) => void)[] = [];
    const server: Server = {
      engagements: [engagement], leads: { [engagement.id]: [lead(OPEN_ID, engagement.id)] }, attempts: {},
      recordAttempt: () => new Promise<Response>((resolve) => { finishes.push(resolve); }),
    };
    serve(server);
    const router = await renderAt(engagement.id);
    fireEvent.click(await linkedLeadButton(/Default creds/));
    await within(dialog()).findByLabelText("Attempt summary");
    typeSummary("Retry the saved attempt");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Record attempt" }));
    await waitFor(() => expect(finishes).toHaveLength(1));
    void router.navigate({ to: "/engagements/$engagementId", params: { engagementId: engagement.id }, search: { tab: "notes" } });
    expect(await within(dialog()).findByText("Saving. Leaving continues after the save finishes.")).toBeTruthy();
    finishes[0]?.(response({ code: "storage_busy" }, 503));
    expect(await within(dialog()).findByText("Storage is busy. Try again.")).toBeTruthy();
    expect(within(dialog()).getByText("Discard the unsaved attempt or park reason?")).toBeTruthy();
    expect(router.state.location.search.tab).toBeUndefined();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Record attempt" }));
    await waitFor(() => expect(finishes).toHaveLength(2));
    const saved = attempt(OPEN_ID, 1, "Retry the saved attempt");
    server.attempts[OPEN_ID] = [saved];
    finishes[1]?.(response(saved));
    await waitFor(() => expect(router.state.location.search.tab).toBe("notes"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("hides cached attempts until their fresh read settles", async () => {
    let finish: ((value: Response) => void) | undefined;
    serve({ engagements: [engagement], leads: { [engagement.id]: [lead(OPEN_ID, engagement.id)] }, attempts: {}, readAttempts: () => new Promise((resolve) => { finish = resolve; }) });
    await renderAt(engagement.id, { seed: (client) => client.setQueryData(leadAttemptsQueryKey(engagement.id, OPEN_ID), [attempt(OPEN_ID, 1, "Old cached attempt")]) });
    fireEvent.click(await linkedLeadButton(/Default creds/));
    await within(dialog()).findByLabelText("Attempt summary");
    expect(within(dialog()).getByRole("status", { name: "Loading attempts" })).toBeTruthy();
    expect(within(dialog()).queryByText("1. Old cached attempt")).toBeNull();
    finish?.(response([attempt(OPEN_ID, 2, "Fresh saved attempt")]));
    expect(await within(dialog()).findByText("2. Fresh saved attempt")).toBeTruthy();
    expect(within(dialog()).queryByText("1. Old cached attempt")).toBeNull();
  });

  it.each(["upper", "lower"])("returns through the original %s source region after overlay and inspector close", async (origin) => {
    const path = { source: "ffuf", parserVersion: "ffuf-json-v1", url: "http://192.0.2.10/admin", status: 200,
      length: 1234, words: 10, lines: 5, redirectlocation: null, fuzz: "admin", runId: "run-1", artifactId: "artifact-1",
      artifactDigest: `sha256:${"a".repeat(64)}`, observedAt: TS };
    const basis = "status 200, length 1234, words 10, lines 5";
    serve({ engagements: [engagement], leads: { [engagement.id]: [lead(OPEN_ID, engagement.id)] }, attempts: {}, paths: [path, { ...path, url: "http://192.0.2.10/login" }] });
    const router = await renderAt(engagement.id);
    const upper = await screen.findByRole("region", { name: "Path results for http://192.0.2.10" });
    const lower = screen.getByRole("region", { name: "ffuf discovery" });
    await within(lower).findByRole("button", { name: path.url });
    fireEvent.click(within(upper).getByRole("button", { name: basis }));
    const list = origin === "upper" ? upper : lower;
    const row = within(list).getByRole("button", { name: path.url }).closest("li")!;
    const opener = within(row).getByRole("button", { name: "Inspect" });
    fireEvent.click(opener);
    await waitFor(() => expect(router.state.location.search.sel).toBe(pathSelectionKey(path.url, path.artifactId)));
    const linked = await linkedLeadButton(/Default creds/);
    fireEvent.click(linked);
    await within(dialog()).findByLabelText("Attempt summary");
    fireEvent.click(within(upper).getByRole("button", { name: `Hide ${basis}` }));
    fireEvent.keyDown(dialog(), { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(linked));
    expect(screen.getByRole("complementary", { name: "Selection inspector" })).toBeTruthy();
    fireEvent.click(within(screen.getByRole("complementary", { name: "Selection inspector" })).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(router.state.location.search.sel).toBeUndefined());
    const expected = origin === "lower" ? opener : within(upper).getByRole("button", { name: `Restore ${basis}` });
    await waitFor(() => expect(document.activeElement).toBe(expected));
  });

  it("falls back to the same inspector when its linked opener disconnects", async () => {
    serve({ engagements: [engagement], leads: { [engagement.id]: [lead(OPEN_ID, engagement.id)] }, attempts: {} });
    await renderAt(engagement.id);
    const opener = await linkedLeadButton(/Default creds/);
    fireEvent.click(opener);
    await within(dialog()).findByLabelText("Attempt summary");
    opener.remove();
    fireEvent.keyDown(dialog(), { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("complementary", { name: "Selection inspector" })));
  });


  it("falls back to its original hidden upper group when both inspector and opener disconnect", async () => {
    const path = { source: "ffuf", parserVersion: "ffuf-json-v1", url: "http://192.0.2.10/admin", status: 200,
      length: 1234, words: 10, lines: 5, redirectlocation: null, fuzz: "admin", runId: "run-1", artifactId: "artifact-1",
      artifactDigest: `sha256:${"a".repeat(64)}`, observedAt: TS };
    const basis = "status 200, length 1234, words 10, lines 5";
    serve({ engagements: [engagement], leads: { [engagement.id]: [lead(OPEN_ID, engagement.id)] }, attempts: {}, paths: [path, { ...path, url: "http://192.0.2.10/login" }] });
    const router = await renderAt(engagement.id);
    const upper = await screen.findByRole("region", { name: "Path results for http://192.0.2.10" });
    fireEvent.click(within(upper).getByRole("button", { name: basis }));
    const row = within(upper).getByRole("button", { name: path.url }).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Inspect" }));
    await waitFor(() => expect(router.state.location.search.sel).toBe(pathSelectionKey(path.url, path.artifactId)));
    fireEvent.click(await linkedLeadButton(/Default creds/));
    await within(dialog()).findByLabelText("Attempt summary");
    fireEvent.click(within(upper).getByRole("button", { name: `Hide ${basis}` }));
    screen.getByRole("complementary", { name: "Selection inspector" }).remove();
    fireEvent.keyDown(dialog(), { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(within(upper).getByRole("button", { name: `Restore ${basis}` })));
    expect(router.state.location.search.sel).toBe(pathSelectionKey(path.url, path.artifactId));
  });

});
