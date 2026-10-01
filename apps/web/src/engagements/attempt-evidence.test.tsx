// @vitest-environment jsdom

import { LEAD_EVIDENCE_REFS_MAX } from "@stonehush/contracts";
import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { createAppRouter } from "../router.js";
import { addEvidenceId, fetchAttemptEvidenceCatalog, removeEvidenceId } from "./attempt-evidence.js";
import { serviceSelectionKey } from "./inspector.js";
import { workspaceStateKey } from "./workspace-state.js";

// The saved-evidence picker inside the shared lead attempt form, mounted
// through the real router for the Leads tab, the Surface overlay and Resume
// over a stubbed control plane.

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

const LEAD_ID = "20000000-0000-4000-8000-000000000001";
const FINDING_ID = "50000000-0000-4000-8000-00000000000a";

// Two rows a reader cannot tell apart without the full artifact id.
const TWIN_A = "art-7f3a9c-out-a";
const TWIN_B = "art-7f3a9c-out-b";

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

function attempt(leadId: string, sequence: number, body: Record<string, unknown>) {
  return {
    contractVersion: 1,
    id: `30000000-0000-4000-8000-00000000000${String(sequence)}`,
    engagementId: engagement.id,
    leadId,
    sequence,
    summary: body["summary"],
    outcome: body["outcome"] ?? "observed",
    conditions: body["conditions"] ?? null,
    evidenceArtifactIds: body["evidenceArtifactIds"] ?? [],
    linkedFindingId: body["linkedFindingId"] ?? null,
    linkedObjectiveId: null,
    createdAt: TS,
  };
}

function finding(id: string, engagementId: string) {
  return {
    contractVersion: 1,
    id,
    engagementId,
    title: "Weak admin password",
    severity: "high",
    status: "open",
    body: "",
    evidenceArtifactIds: [],
    revision: 0,
    createdAt: TS,
    updatedAt: TS,
  };
}

function artifact(artifactId: string, overrides: Record<string, unknown> = {}) {
  return {
    artifactId,
    digest: `sha256:${"b".repeat(64)}`,
    sizeBytes: 4096,
    kind: "stdout",
    completeness: "complete",
    runId: "run-7f3a9c",
    ...overrides,
  };
}

function report(
  engagementId: string,
  rows: readonly ReturnType<typeof artifact>[],
  total = rows.length,
) {
  const owner = [engagement, otherEngagement, archivedEngagement].find((entry) => entry.id === engagementId) ?? engagement;
  const empty = { total: 0, truncated: false, rows: [] };
  return {
    contractVersion: 1,
    engagement: {
      id: engagementId,
      name: owner.name,
      kind: owner.kind,
      status: owner.status,
      description: null,
      authorizationContext: null,
      deadlineAt: null,
      revision: owner.revision,
      createdAt: TS,
      updatedAt: TS,
    },
    findings: [],
    notesMarkdown: "",
    notesUpdatedAt: TS,
    services: empty,
    probes: empty,
    ffufResults: empty,
    evidenceArtifacts: { total, truncated: total > rows.length, rows },
    generatedAt: TS,
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
  artifacts?: Record<string, ReturnType<typeof artifact>[]>;
  readReport?: (engagementId: string, init?: RequestInit) => Response | Promise<Response> | undefined;
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
    if (rest === "/services") return Promise.resolve(response([service]));
    if (rest === "/leads") return Promise.resolve(response(server.leads[engagementId] ?? []));
    if (rest === "/findings" && isRead(init)) return Promise.resolve(response(server.findings?.[engagementId] ?? []));
    if (rest === "/report" && isRead(init)) {
      return Promise.resolve(
        server.readReport?.(engagementId, init) ?? response(report(engagementId, server.artifacts?.[engagementId] ?? [])),
      );
    }
    const leadMatch = /^\/leads\/([^/]+)(\/.*)?$/.exec(rest);
    if (leadMatch?.[1] !== undefined) {
      const leadId = leadMatch[1];
      const tail = leadMatch[2] ?? "";
      if (tail === "" && isRead(init)) {
        const found = (server.leads[engagementId] ?? []).find((entry) => entry.id === leadId);
        return Promise.resolve(found === undefined ? response({ code: "lead_not_found" }, 404) : response(found));
      }
      if (tail === "/attempts" && isRead(init)) return Promise.resolve(response(server.attempts[leadId] ?? []));
      if (tail === "/attempts" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Promise.resolve(server.recordAttempt?.(leadId, body) ?? response({ code: "invalid_request" }, 400));
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

function reportReads(fetchMock: ReturnType<typeof serve>) {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/report")).length;
}

function posts(fetchMock: ReturnType<typeof serve>) {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === "POST")
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}

const testQueryClients = new Set<QueryClient>();

async function renderAt(engagementId: string, search: string) {
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

// Surface opener for the lead linked to the selected service.
async function openFromSurface(engagementId = engagement.id) {
  const router = await renderAt(engagementId, `?sel=${encodeURIComponent(SEL)}`);
  const list = await screen.findByRole("list", { name: "Leads linked to this evidence" });
  const opener = within(list).getByRole("button", { name: /Default creds/ });
  fireEvent.click(opener);
  await within(dialog()).findByLabelText("Attempt summary");
  return { router, opener };
}

function dialog() {
  return screen.getByRole("dialog");
}

function evidenceField(scope: HTMLElement) {
  return within(scope).getByLabelText<HTMLInputElement>("Evidence artifact ids, comma separated");
}

function pickerToggle(scope: HTMLElement) {
  return within(scope).getByRole<HTMLButtonElement>("button", { name: /saved evidence$/ });
}

function rowButton(scope: HTMLElement, action: "Add" | "Remove", artifactId: string) {
  return within(scope).getByRole<HTMLButtonElement>("button", { name: `${action} ${artifactId}` });
}

function rows(scope: HTMLElement) {
  const list = within(scope).queryByRole("list", { name: "Saved artifacts" });
  return list === null ? [] : within(list).getAllByRole("listitem");
}

async function openPicker(scope: HTMLElement) {
  fireEvent.click(within(scope).getByRole("button", { name: "Choose saved evidence" }));
  return within(scope).findByRole("group", { name: "Saved evidence" });
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

describe("attempt evidence draft edits", () => {
  it("adds an exact id once, removes only that id, and keeps every other typed reference", () => {
    expect(addEvidenceId("", TWIN_A)).toBe(TWIN_A);
    expect(addEvidenceId(`manual-ref ${TWIN_A}`, TWIN_A)).toBe(`manual-ref ${TWIN_A}`);
    expect(addEvidenceId("manual-ref, manual-ref,, Not_Managed", TWIN_B)).toBe(`manual-ref, Not_Managed, ${TWIN_B}`);
    expect(removeEvidenceId(`artifact-1, artifact-10, ${TWIN_A}, artifact-1`, "artifact-1")).toBe(`artifact-10, ${TWIN_A}`);
    expect(removeEvidenceId("off-window-ref", TWIN_A)).toBe("off-window-ref");
  });

  it("refuses an addition above the distinct reference limit", () => {
    const full = Array.from({ length: LEAD_EVIDENCE_REFS_MAX }, (_, index) => `typed-${String(index)}`);
    expect(addEvidenceId(full.join(", "), TWIN_A)).toBeUndefined();
    expect(addEvidenceId([...full, full[0]].join(", "), full[1]!)).toBe([...full, full[0]].join(", "));
    expect(addEvidenceId(full.slice(1).join(", "), TWIN_A)?.split(", ")).toHaveLength(LEAD_EVIDENCE_REFS_MAX);
  });

  it("accepts only the exact engagement's catalog with unique artifact ids", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValueOnce(response(report(engagement.id, [artifact(TWIN_A)])));
    await expect(fetchAttemptEvidenceCatalog(engagement.id)).resolves.toMatchObject({ total: 1, rows: [{ artifactId: TWIN_A }] });
    fetchMock.mockResolvedValueOnce(response(report(otherEngagement.id, [artifact(TWIN_A)])));
    await expect(fetchAttemptEvidenceCatalog(engagement.id)).rejects.toThrow();
    fetchMock.mockResolvedValueOnce(response(report(engagement.id, [artifact(TWIN_A), artifact(TWIN_A)])));
    await expect(fetchAttemptEvidenceCatalog(engagement.id)).rejects.toThrow();
    fetchMock.mockResolvedValueOnce(response({ ...report(engagement.id, [artifact(TWIN_A)]), extra: true }));
    await expect(fetchAttemptEvidenceCatalog(engagement.id)).rejects.toThrow();
  });
});

describe("choose saved evidence while recording a lead attempt", () => {
  it("records exactly the chosen one of two similar artifacts from the Leads tab", async () => {
    const server: Server = {
      engagements: [engagement],
      leads: { [engagement.id]: [lead(LEAD_ID, engagement.id)] },
      attempts: {},
      artifacts: {
        [engagement.id]: [
          artifact(TWIN_A),
          artifact(TWIN_B),
          artifact("art-2e81-err", { kind: "stderr", completeness: "partial", sizeBytes: 12, runId: "run-2e81" }),
          artifact("art-2e81-raw", { kind: "tool_raw", completeness: "truncated", runId: "run-2e81" }),
        ],
      },
      recordAttempt: (leadId, body) => {
        const saved = attempt(leadId, 1, body);
        server.attempts[leadId] = [saved];
        return response(saved, 201);
      },
    };
    const fetchMock = serve(server);
    await renderAt(engagement.id, "?tab=leads");
    fireEvent.click(await screen.findByRole("button", { name: "Detail" }));
    const detail = (await screen.findByText("Lead detail")).parentElement!.parentElement!;
    await within(detail).findByLabelText("Attempt summary");
    expect(reportReads(fetchMock)).toBe(0);

    const picker = await openPicker(detail);
    expect(reportReads(fetchMock)).toBe(1);
    expect(document.activeElement).toBe(within(picker).getByLabelText("Filter saved evidence"));
    expect(await within(picker).findByText("4 saved artifacts.")).toBeTruthy();
    expect(rows(picker).map((row) => row.textContent)).toEqual([
      `stdout · 4096 bytes · completerun run-7f3a9c${TWIN_A}Add`,
      `stdout · 4096 bytes · completerun run-7f3a9c${TWIN_B}Add`,
      "stderr · 12 bytes · partialrun run-2e81art-2e81-errAdd",
      "tool raw output · 4096 bytes · truncatedrun run-2e81art-2e81-rawAdd",
    ]);

    fireEvent.click(rowButton(picker, "Add", TWIN_B));
    expect(evidenceField(detail).value).toBe(TWIN_B);
    expect(rowButton(picker, "Remove", TWIN_B)).toBeTruthy();
    expect(rowButton(picker, "Add", TWIN_A)).toBeTruthy();
    expect(rows(picker)[1]!.textContent).toMatch(/^Selected · stdout/);
    expect(rows(picker)[0]!.textContent).not.toMatch(/Selected/);
    expect(writes(fetchMock)).toEqual([]);

    fireEvent.change(within(detail).getByLabelText("Attempt summary"), { target: { value: "Read stdout of the second run" } });
    fireEvent.click(within(detail).getByRole("button", { name: "Record attempt" }));
    expect(await within(detail).findByText("1. Read stdout of the second run")).toBeTruthy();
    expect(posts(fetchMock)).toEqual([
      { summary: "Read stdout of the second run", outcome: "observed", evidenceArtifactIds: [TWIN_B] },
    ]);
    expect(evidenceField(detail).value).toBe("");
    expect(rowButton(picker, "Add", TWIN_B)).toBeTruthy();
    expect(reportReads(fetchMock)).toBe(1);
  });

  it("keeps typed references and picker rows in one draft, with the reference limit", async () => {
    const full = Array.from({ length: LEAD_EVIDENCE_REFS_MAX - 1 }, (_, index) => `typed-${String(index)}`);
    serve({
      engagements: [engagement],
      leads: { [engagement.id]: [lead(LEAD_ID, engagement.id)] },
      attempts: {},
      artifacts: { [engagement.id]: [artifact(TWIN_A), artifact(TWIN_B)] },
    });
    await openFromSurface();
    const field = evidenceField(dialog());
    fireEvent.change(field, { target: { value: `off-window-ref ${TWIN_A}, off-window-ref` } });
    const picker = await openPicker(dialog());
    await within(picker).findByText(/2 saved artifacts\./);
    expect(rowButton(picker, "Remove", TWIN_A)).toBeTruthy();
    expect(within(picker).getByText(/1 typed ID is not in this list and stays as typed\./)).toBeTruthy();

    fireEvent.click(rowButton(picker, "Add", TWIN_B));
    expect(field.value).toBe(`off-window-ref, ${TWIN_A}, ${TWIN_B}`);
    fireEvent.click(rowButton(picker, "Remove", TWIN_A));
    expect(field.value).toBe(`off-window-ref, ${TWIN_B}`);

    // Typing an id selects its row; deleting it from the text clears the row.
    fireEvent.change(field, { target: { value: `${TWIN_B} ${TWIN_A}` } });
    expect(rowButton(picker, "Remove", TWIN_A)).toBeTruthy();
    fireEvent.change(field, { target: { value: TWIN_B } });
    expect(rowButton(picker, "Add", TWIN_A)).toBeTruthy();

    fireEvent.change(field, { target: { value: [...full, TWIN_B].join(", ") } });
    expect(within(dialog()).getByText(`${String(LEAD_EVIDENCE_REFS_MAX)} of ${String(LEAD_EVIDENCE_REFS_MAX)} evidence IDs`)).toBeTruthy();
    expect(within(picker).getByText(`Evidence holds at most ${String(LEAD_EVIDENCE_REFS_MAX)} IDs. Remove one before adding another.`)).toBeTruthy();
    expect(rowButton(picker, "Add", TWIN_A).disabled).toBe(true);
    fireEvent.click(rowButton(picker, "Remove", TWIN_B));
    expect(field.value).toBe(full.join(", "));
    expect(within(picker).queryByText(/Evidence holds at most/)).toBeNull();
    fireEvent.click(rowButton(picker, "Add", TWIN_A));
    expect(field.value.split(", ")).toHaveLength(LEAD_EVIDENCE_REFS_MAX);
  });

  it("states a capped catalog, keeps the list bounded and reaches later rows", async () => {
    const catalog = Array.from({ length: 1000 }, (_, index) => artifact(`art-${String(index).padStart(4, "0")}`));
    serve({
      engagements: [engagement],
      leads: { [engagement.id]: [lead(LEAD_ID, engagement.id)] },
      attempts: {},
      readReport: (engagementId) => response(report(engagementId, catalog, 1450)),
    });
    await openFromSurface();
    const picker = await openPicker(dialog());
    expect(
      await within(picker).findByText(
        "Showing 1000 of 1450 saved artifacts. The list is incomplete. Type other IDs in the evidence field.",
      ),
    ).toBeTruthy();
    expect(rows(picker)).toHaveLength(50);
    expect(within(picker).getByText("Showing 50 of 1000")).toBeTruthy();

    fireEvent.click(within(picker).getByRole("button", { name: "Show 50 more" }));
    expect(rows(picker)).toHaveLength(100);
    await waitFor(() => expect(document.activeElement).toBe(rowButton(picker, "Add", "art-0050")));

    fireEvent.change(within(picker).getByLabelText("Filter saved evidence"), { target: { value: "ART-0999" } });
    expect(rows(picker)).toHaveLength(1);
    fireEvent.click(rowButton(picker, "Add", "art-0999"));
    expect(evidenceField(dialog()).value).toBe("art-0999");
    fireEvent.change(within(picker).getByLabelText("Filter saved evidence"), { target: { value: "no-such" } });
    expect(within(picker).getByText("No saved artifacts match this filter.")).toBeTruthy();
    expect(rows(picker)).toHaveLength(0);
  });

  it("says an engagement has no saved artifacts", async () => {
    serve({ engagements: [engagement], leads: { [engagement.id]: [lead(LEAD_ID, engagement.id)] }, attempts: {} });
    await openFromSurface();
    const picker = await openPicker(dialog());
    expect(await within(picker).findByText("No saved artifacts in this engagement.")).toBeTruthy();
    expect(rows(picker)).toHaveLength(0);
  });

  it.each(["limit", "refresh", "saving"])("focuses newly revealed metadata when Add is disabled by %s", async (state) => {
    const catalog = Array.from({ length: 51 }, (_, index) => artifact(`art-${String(index).padStart(4, "0")}`));
    let failRead = false;
    let finishSave: (value: Response) => void = () => undefined;
    serve({
      engagements: [engagement],
      leads: { [engagement.id]: [lead(LEAD_ID, engagement.id)] },
      attempts: {},
      readReport: (engagementId) => failRead ? response({ code: "storage_busy" }, 503) : response(report(engagementId, catalog)),
      recordAttempt: () => new Promise<Response>((resolve) => { finishSave = resolve; }),
    });
    await openFromSurface();
    let picker = await openPicker(dialog());
    await within(picker).findByText("51 saved artifacts.");
    if (state === "limit") {
      fireEvent.change(evidenceField(dialog()), { target: { value: Array.from({ length: LEAD_EVIDENCE_REFS_MAX }, (_, index) => `typed-${String(index)}`).join(", ") } });
    } else if (state === "refresh") {
      failRead = true;
      fireEvent.click(within(dialog()).getByRole("button", { name: "Hide saved evidence" }));
      picker = await openPicker(dialog());
      await within(picker).findByText("Refresh failed. Showing the list as last read. Retry to add from it.");
    } else {
      fireEvent.change(within(dialog()).getByLabelText("Attempt summary"), { target: { value: "Saving the draft" } });
      fireEvent.click(within(dialog()).getByRole("button", { name: "Record attempt" }));
      await within(dialog()).findByRole("button", { name: "Saving" });
    }
    const before = evidenceField(dialog()).value;
    const more = within(picker).getByRole("button", { name: "Show 1 more" });
    more.focus();
    fireEvent.click(more);
    expect(rows(picker)).toHaveLength(51);
    expect(rowButton(picker, "Add", "art-0050").disabled).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(rows(picker)[50]));
    expect(evidenceField(dialog()).value).toBe(before);
    if (state === "saving") {
      finishSave(response({ code: "storage_busy" }, 503));
      await within(dialog()).findByText("Storage is busy. Try again.");
    }
  });

  it.each([
    ["a failed read", () => response({ code: "storage_busy" }, 503)],
    ["a foreign engagement", () => response(report(otherEngagement.id, [artifact(TWIN_A)]))],
    ["duplicate artifact ids", () => response(report(engagement.id, [artifact(TWIN_A), artifact(TWIN_A)]))],
    ["a malformed bundle", () => response({ ...report(engagement.id, [artifact(TWIN_A)]), evidenceArtifacts: { total: 1, truncated: true, rows: [artifact(TWIN_A)] } })],
  ])("offers no choices after %s, still records typed ids, and adds after Retry", async (_name, bad) => {
    let fail = true;
    const server: Server = {
      engagements: [engagement],
      leads: { [engagement.id]: [lead(LEAD_ID, engagement.id)] },
      attempts: {},
      readReport: (engagementId) => (fail ? bad() : response(report(engagementId, [artifact(TWIN_A)]))),
      recordAttempt: (leadId, body) => response(attempt(leadId, 1, body), 201),
    };
    const fetchMock = serve(server);
    await openFromSurface();
    fireEvent.change(within(dialog()).getByLabelText("Attempt summary"), { target: { value: "Typed ref only" } });
    fireEvent.change(evidenceField(dialog()), { target: { value: "manual-ref" } });
    const picker = await openPicker(dialog());
    expect(await within(picker).findByText("Saved evidence could not be read. Typed IDs can still be recorded.")).toBeTruthy();
    expect(rows(picker)).toHaveLength(0);
    expect(within(picker).queryByText(TWIN_A)).toBeNull();

    fail = false;
    fireEvent.click(within(picker).getByRole("button", { name: "Retry saved evidence" }));
    fireEvent.click(await within(picker).findByRole("button", { name: `Add ${TWIN_A}` }));
    expect(evidenceField(dialog()).value).toBe(`manual-ref, ${TWIN_A}`);
    expect(within(dialog()).getByLabelText<HTMLInputElement>("Attempt summary").value).toBe("Typed ref only");
    expect(writes(fetchMock)).toEqual([]);

    fireEvent.change(evidenceField(dialog()), { target: { value: "manual-ref" } });
    fail = true;
    fireEvent.click(within(dialog()).getByRole("button", { name: "Hide saved evidence" }));
    await openPicker(dialog());
    expect(await within(dialog()).findByText(/Saved evidence could not be read|Refresh failed/)).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Record attempt" }));
    await waitFor(() => expect(posts(fetchMock)).toEqual([{ summary: "Typed ref only", outcome: "observed", evidenceArtifactIds: ["manual-ref"] }]));
  });

  it("shows a failed refresh as last read and blocks additions until a fresh read succeeds", async () => {
    let mode: "ok" | "fail" | "hold" = "ok";
    let release: (value: Response) => void = () => undefined;
    serve({
      engagements: [engagement],
      leads: { [engagement.id]: [lead(LEAD_ID, engagement.id)] },
      attempts: {},
      readReport: (engagementId) => {
        if (mode === "fail") return response({ code: "storage_busy" }, 503);
        if (mode === "hold") return new Promise<Response>((resolve) => { release = resolve; });
        return response(report(engagementId, [artifact(TWIN_A), artifact(TWIN_B)]));
      },
    });
    await openFromSurface();
    let picker = await openPicker(dialog());
    fireEvent.click(await within(picker).findByRole("button", { name: `Add ${TWIN_A}` }));

    mode = "fail";
    fireEvent.click(within(dialog()).getByRole("button", { name: "Hide saved evidence" }));
    expect(document.activeElement).toBe(pickerToggle(dialog()));
    picker = await openPicker(dialog());
    expect(await within(picker).findByText("Refresh failed. Showing the list as last read. Retry to add from it.")).toBeTruthy();
    expect(rowButton(picker, "Add", TWIN_B).disabled).toBe(true);
    // Removing is a plain draft edit and stays available.
    expect(rowButton(picker, "Remove", TWIN_A).disabled).toBe(false);

    mode = "hold";
    fireEvent.click(within(picker).getByRole("button", { name: "Retry saved evidence" }));
    expect(await within(picker).findByText("Checking saved evidence. Showing the list as last read.")).toBeTruthy();
    expect(rowButton(picker, "Add", TWIN_B).disabled).toBe(true);

    // The refreshed window no longer lists the chosen id; the draft keeps it.
    release(response(report(engagement.id, [artifact(TWIN_B)])));
    await waitFor(() => expect(rowButton(picker, "Add", TWIN_B).disabled).toBe(false));
    expect(evidenceField(dialog()).value).toBe(TWIN_A);
    expect(within(picker).getByText(/1 typed ID is not in this list and stays as typed\./)).toBeTruthy();
  });

  it("aborts a read when the picker hides and ignores its late answer", async () => {
    const pending: { resolve: (value: Response) => void; signal: AbortSignal | null | undefined }[] = [];
    serve({
      engagements: [engagement],
      leads: { [engagement.id]: [lead(LEAD_ID, engagement.id)] },
      attempts: {},
      readReport: (_engagementId, init) =>
        new Promise<Response>((resolve) => {
          pending.push({ resolve, signal: init?.signal });
        }),
    });
    await openFromSurface();
    let picker = await openPicker(dialog());
    expect(within(picker).getByText("Loading saved evidence")).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Hide saved evidence" }));
    expect(pending[0]?.signal?.aborted).toBe(true);
    pending[0]?.resolve(response(report(engagement.id, [artifact(TWIN_A)])));
    await new Promise((resolve) => setTimeout(resolve, 0));

    picker = await openPicker(dialog());
    expect(pending).toHaveLength(2);
    expect(within(picker).getByText("Loading saved evidence")).toBeTruthy();
    expect(rows(picker)).toHaveLength(0);
    pending[1]?.resolve(response(report(engagement.id, [artifact(TWIN_B)])));
    expect(await within(picker).findByRole("button", { name: `Add ${TWIN_B}` })).toBeTruthy();
    expect(within(picker).queryByText(TWIN_A)).toBeNull();
  });

  it("never lets a late catalog from a closed opening fill another engagement's form", async () => {
    let releaseFirst: (value: Response) => void = () => undefined;
    const server: Server = {
      engagements: [engagement, otherEngagement],
      leads: { [engagement.id]: [lead(LEAD_ID, engagement.id)], [otherEngagement.id]: [lead(LEAD_ID, otherEngagement.id)] },
      attempts: {},
      artifacts: { [otherEngagement.id]: [artifact(TWIN_B)] },
      readReport: (engagementId) =>
        engagementId === engagement.id ? new Promise<Response>((resolve) => { releaseFirst = resolve; }) : undefined,
    };
    serve(server);
    const { router } = await openFromSurface();
    await openPicker(dialog());
    fireEvent.click(within(dialog()).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    await router.navigate({ to: "/engagements/$engagementId", params: { engagementId: otherEngagement.id }, search: { sel: SEL } });
    const list = await screen.findByRole("list", { name: "Leads linked to this evidence" });
    fireEvent.click(within(list).getByRole("button", { name: /Default creds/ }));
    await within(dialog()).findByLabelText("Attempt summary");
    const picker = await openPicker(dialog());
    expect(await within(picker).findByRole("button", { name: `Add ${TWIN_B}` })).toBeTruthy();
    releaseFirst(response(report(engagement.id, [artifact(TWIN_A)])));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(within(picker).queryByText(TWIN_A)).toBeNull();
    expect(rows(picker)).toHaveLength(1);
  });

  it("holds a picker-only draft through Stay and drops it on Discard without writing", async () => {
    const fetchMock = serve({
      engagements: [engagement],
      leads: { [engagement.id]: [lead(LEAD_ID, engagement.id)] },
      attempts: {},
      artifacts: { [engagement.id]: [artifact(TWIN_A)] },
    });
    const { router, opener } = await openFromSurface();
    const searchBefore = { ...router.state.location.search };
    const picker = await openPicker(dialog());
    fireEvent.click(await within(picker).findByRole("button", { name: `Add ${TWIN_A}` }));

    fireEvent.click(within(dialog()).getByRole("button", { name: "Close" }));
    expect(within(dialog()).getByText("Discard the unsaved attempt or park reason?")).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Stay" }));
    expect(evidenceField(dialog()).value).toBe(TWIN_A);
    expect(rowButton(dialog(), "Remove", TWIN_A)).toBeTruthy();

    fireEvent.keyDown(dialog(), { key: "Escape" });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(router.state.location.search).toEqual(searchBefore);
    expect(writes(fetchMock)).toEqual([]);

    fireEvent.click(opener);
    await within(dialog()).findByLabelText("Attempt summary");
    expect(evidenceField(dialog()).value).toBe("");
  });

  it("keeps every field through a failed save, locks the picker while saving, and posts once per Record", async () => {
    const finishes: ((value: Response) => void)[] = [];
    const server: Server = {
      engagements: [engagement],
      leads: { [engagement.id]: [lead(LEAD_ID, engagement.id)] },
      attempts: {},
      findings: { [engagement.id]: [finding(FINDING_ID, engagement.id)] },
      artifacts: { [engagement.id]: [artifact(TWIN_A), artifact(TWIN_B)] },
      recordAttempt: (leadId, body) =>
        finishes.length === 0
          ? (finishes.push(() => undefined), response({ code: "storage_busy" }, 503))
          : new Promise<Response>((resolve) => {
              finishes.push((value) => {
                server.attempts[leadId] = [attempt(leadId, 1, body)];
                resolve(value);
              });
            }),
    };
    const fetchMock = serve(server);
    const { router } = await openFromSurface();
    const picker = await openPicker(dialog());
    fireEvent.click(await within(picker).findByRole("button", { name: `Add ${TWIN_B}` }));
    fireEvent.change(evidenceField(dialog()), { target: { value: `${TWIN_B}, manual-ref` } });
    fireEvent.change(within(dialog()).getByLabelText("Attempt summary"), { target: { value: "Replayed the login" } });
    fireEvent.change(within(dialog()).getByLabelText("Outcome"), { target: { value: "ruled_out" } });
    fireEvent.change(within(dialog()).getByLabelText("Conditions, optional"), { target: { value: "Only over HTTP" } });
    const chooser = within(dialog()).getByLabelText<HTMLSelectElement>("Finding, optional");
    await waitFor(() => expect(chooser.options).toHaveLength(2));
    fireEvent.change(chooser, { target: { value: FINDING_ID } });
    const expected = {
      summary: "Replayed the login",
      outcome: "ruled_out",
      conditions: "Only over HTTP",
      evidenceArtifactIds: [TWIN_B, "manual-ref"],
      linkedFindingId: FINDING_ID,
    };

    fireEvent.click(within(dialog()).getByRole("button", { name: "Record attempt" }));
    expect(await within(dialog()).findByText("Storage is busy. Try again.")).toBeTruthy();
    expect(posts(fetchMock)).toEqual([expected]);
    expect(within(dialog()).getByLabelText<HTMLInputElement>("Attempt summary").value).toBe("Replayed the login");
    expect(within(dialog()).getByLabelText<HTMLSelectElement>("Outcome").value).toBe("ruled_out");
    expect(within(dialog()).getByLabelText<HTMLInputElement>("Conditions, optional").value).toBe("Only over HTTP");
    expect(evidenceField(dialog()).value).toBe(`${TWIN_B}, manual-ref`);
    expect(chooser.value).toBe(FINDING_ID);
    expect(rowButton(picker, "Remove", TWIN_B)).toBeTruthy();

    fireEvent.click(within(dialog()).getByRole("button", { name: "Record attempt" }));
    await within(dialog()).findByRole("button", { name: "Saving" });
    expect(rowButton(picker, "Remove", TWIN_B).disabled).toBe(true);
    expect(rowButton(picker, "Add", TWIN_A).disabled).toBe(true);
    expect(evidenceField(dialog()).disabled).toBe(true);
    fireEvent.click(rowButton(picker, "Add", TWIN_A));
    expect(evidenceField(dialog()).value).toBe(`${TWIN_B}, manual-ref`);

    void router.navigate({ to: "/engagements/$engagementId", params: { engagementId: engagement.id }, search: { tab: "leads" } });
    expect(await within(dialog()).findByText("Saving. Leaving continues after the save finishes.")).toBeTruthy();
    finishes[1]?.(response(attempt(LEAD_ID, 1, expected), 201));
    await waitFor(() => expect(router.state.location.search.tab).toBe("leads"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(posts(fetchMock)).toEqual([expected, expected]);
  });

  it("opens the same picker from Resume and offers none in an archived engagement", async () => {
    window.localStorage.setItem(workspaceStateKey(engagement.id), JSON.stringify({ version: 1, lastLeadId: LEAD_ID }));
    const fetchMock = serve({
      engagements: [engagement, archivedEngagement],
      leads: { [engagement.id]: [lead(LEAD_ID, engagement.id)], [archivedEngagement.id]: [lead(LEAD_ID, archivedEngagement.id)] },
      attempts: {},
      artifacts: { [engagement.id]: [artifact(TWIN_A)] },
    });
    const router = await renderAt(engagement.id, "");
    const resume = await screen.findByRole("region", { name: "Resume" });
    const row = await within(resume).findByRole("region", { name: "Last lead" });
    fireEvent.click(await within(row).findByRole("button", { name: /Default creds/ }));
    await within(dialog()).findByLabelText("Attempt summary");
    const picker = await openPicker(dialog());
    fireEvent.click(await within(picker).findByRole("button", { name: `Add ${TWIN_A}` }));
    expect(evidenceField(dialog()).value).toBe(TWIN_A);
    expect(router.state.location.search).toEqual({});
    fireEvent.click(within(dialog()).getByRole("button", { name: "Close" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Discard" }));
    expect(writes(fetchMock)).toEqual([]);

    cleanup();
    const reads = reportReads(fetchMock);
    await openFromSurfaceArchived();
    expect(within(dialog()).queryByRole("button", { name: "Choose saved evidence" })).toBeNull();
    expect(reportReads(fetchMock)).toBe(reads);
  });
});

async function openFromSurfaceArchived() {
  await renderAt(archivedEngagement.id, `?sel=${encodeURIComponent(SEL)}`);
  const list = await screen.findByRole("list", { name: "Leads linked to this evidence" });
  fireEvent.click(within(list).getByRole("button", { name: /Default creds/ }));
  await within(dialog()).findByText(/This engagement is archived/);
}
