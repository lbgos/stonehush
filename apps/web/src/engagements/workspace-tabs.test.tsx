// @vitest-environment jsdom

import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import {
  act,
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
import { ExecutionTray } from "./workspace-tabs.js";
import { resolveEngagementTab } from "./workspace.js";

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

const readyStatus = { version: 1, overall: "ready", developmentStorage: "ready" };

function response(payload: unknown, status = 200): Response {
  return {
    json: async () => payload,
    ok: status >= 200 && status < 300,
    status,
  } as Response;
}

function runSummary(id: string, createdAt: string, state = "succeeded") {
  return {
    id,
    actionId: "40000000-0000-4000-8000-000000000001",
    state,
    terminalKind: state === "succeeded" ? "succeeded" : null,
    terminalReason: null,
    updatedAt: createdAt,
    createdAt,
    attempt: 1,
  };
}

function outputFor(runId: string, content: string) {
  return {
    run: {
      id: runId,
      actionId: "40000000-0000-4000-8000-000000000001",
      state: "succeeded",
      terminalKind: "succeeded",
      terminalReason: null,
      updatedAt: "2026-08-09T12:00:00.000Z",
    },
    stdout: {
      present: true,
      artifactId: `artifact-${runId}`,
      sizeBytes: content.length,
      digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      completeness: "complete",
      truncated: false,
      content,
    },
    stderr: { present: false, truncated: false, content: "" },
  };
}

function reportBundle(notesMarkdown: string, generatedAt: string) {
  return {
    contractVersion: 1,
    engagement: {
      id: activeEngagement.id,
      name: activeEngagement.name,
      kind: "lab",
      status: "active",
      description: null,
      authorizationContext: null,
      deadlineAt: null,
      revision: 1,
      createdAt: "2026-08-12T12:00:00.000Z",
      updatedAt: "2026-08-12T12:00:00.000Z",
    },
    findings: [],
    notesMarkdown,
    notesUpdatedAt: "2026-08-12T12:00:00.000Z",
    services: { total: 0, truncated: false, rows: [] },
    probes: { total: 0, truncated: false, rows: [] },
    ffufResults: { total: 0, truncated: false, rows: [] },
    evidenceArtifacts: { total: 0, truncated: false, rows: [] },
    generatedAt,
  };
}

// Shared defaults for endpoints the tabs do not focus on. Specific tests
// override notes, findings, report, and runs before falling back to this.
function baseStubResponse(url: string): Response | undefined {
  if (url.includes("/system/status")) return response(readyStatus);
  if (url === "/api/v1/engagements") return response([activeEngagement]);
  if (url === `/api/v1/engagements/${activeEngagement.id}`) {
    return response({ engagement: activeEngagement, activeScopeRevision: null });
  }
  if (url.endsWith("/services")) return response([]);
  if (url.endsWith("/http-probes")) return response([]);
  if (url.endsWith("/ffuf-results")) return response([]);
  if (url.endsWith("/settings/runner")) return response({ code: "storage_busy" }, 503);
  if (url.endsWith("/runs/latest/output")) return response({ code: "no_terminal_run" }, 404);
  if (url.endsWith("/notes")) {
    return response({
      engagementId: activeEngagement.id,
      markdown: "",
      updatedAt: "2026-08-12T12:00:00.000Z",
      revision: 0,
    });
  }
  if (url.endsWith("/findings")) return response([]);
  if (url.endsWith("/report")) return response(reportBundle("", "2026-08-12T13:00:00.000Z"));
  if (url.includes("/runs?")) return response({ runs: [], nextCursor: null });
  return undefined;
}

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    return Promise.resolve(handler(String(input), init));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const testQueryClients = new Set<QueryClient>();

async function renderTabs(initialEntry: string) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [initialEntry] }));
  await router.load();
  const queryClient = createAppQueryClient();
  testQueryClients.add(queryClient);
  const view = render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { ...view, queryClient, router };
}

function fetchUrls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(([input]) => String(input));
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

describe("engagement tab resolution", () => {
  it("defaults unknown and missing tabs to surface", () => {
    expect(resolveEngagementTab(undefined)).toBe("surface");
    expect(resolveEngagementTab("bogus")).toBe("surface");
    expect(resolveEngagementTab("")).toBe("surface");
    expect(resolveEngagementTab("surface")).toBe("surface");
    expect(resolveEngagementTab("runs")).toBe("runs");
    expect(resolveEngagementTab("notes")).toBe("notes");
    expect(resolveEngagementTab("findings")).toBe("findings");
    expect(resolveEngagementTab("report")).toBe("report");
  });
});

describe("engagement tabs", () => {
  it("defaults to the surface tab without search", async () => {
    stubFetch((url, init) => {
      if (init?.method !== undefined && init.method !== "GET") {
        return response({ code: "invalid_request" }, 400);
      }
      return baseStubResponse(url) ?? response({ code: "invalid_request" }, 400);
    });

    await renderTabs(`/engagements/${activeEngagement.id}`);

    expect(await screen.findByRole("heading", { name: "Attack surface" })).toBeTruthy();
    // The planner mounts after the engagement-detail query resolves on its own
    // key, so await it instead of assuming it lands in the same commit.
    expect(await screen.findByRole("button", { name: "Plan action" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Surface" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.queryByLabelText("Markdown")).toBeNull();
    expect(screen.queryByRole("heading", { name: "New finding" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Run history" })).toBeNull();
  });

  it("falls back to surface for an unknown tab", async () => {
    stubFetch((url, init) => {
      if (init?.method !== undefined && init.method !== "GET") {
        return response({ code: "invalid_request" }, 400);
      }
      return baseStubResponse(url) ?? response({ code: "invalid_request" }, 400);
    });

    await renderTabs(`/engagements/${activeEngagement.id}?tab=bogus`);

    expect(await screen.findByRole("heading", { name: "Attack surface" })).toBeTruthy();
    expect(screen.queryByLabelText("Markdown")).toBeNull();
  });

  it("renders the notes panel from the URL and hides surface content", async () => {
    stubFetch((url, init) => {
      if (init?.method !== undefined && init.method !== "GET") {
        return response({ code: "invalid_request" }, 400);
      }
      return baseStubResponse(url) ?? response({ code: "invalid_request" }, 400);
    });

    await renderTabs(`/engagements/${activeEngagement.id}?tab=notes`);

    expect(await screen.findByLabelText("Markdown")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Notes" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.queryByRole("heading", { name: "Attack surface" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "New finding" })).toBeNull();
  });

  it("renders the findings panel from the URL", async () => {
    stubFetch((url, init) => {
      if (init?.method !== undefined && init.method !== "GET") {
        return response({ code: "invalid_request" }, 400);
      }
      return baseStubResponse(url) ?? response({ code: "invalid_request" }, 400);
    });

    await renderTabs(`/engagements/${activeEngagement.id}?tab=findings`);

    expect(await screen.findByRole("heading", { name: "New finding" })).toBeTruthy();
    expect(screen.queryByLabelText("Markdown")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Attack surface" })).toBeNull();
  });

  it("renders the report panel from the URL", async () => {
    stubFetch((url, init) => {
      if (init?.method !== undefined && init.method !== "GET") {
        return response({ code: "invalid_request" }, 400);
      }
      return baseStubResponse(url) ?? response({ code: "invalid_request" }, 400);
    });

    await renderTabs(`/engagements/${activeEngagement.id}?tab=report`);

    expect(await screen.findByRole("heading", { name: "Markdown preview" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Attack surface" })).toBeNull();
    expect(screen.queryByLabelText("Markdown")).toBeNull();
  });

  it("keeps the exact selected run with no newest-run fallback", async () => {
    const historyPage = {
      runs: [
        runSummary("run-new", "2026-08-10T12:00:00.000Z"),
        runSummary("run-old", "2026-08-09T12:00:00.000Z"),
      ],
      nextCursor: null,
    };
    const fetchMock = stubFetch((url, init) => {
      if (init?.method !== undefined && init.method !== "GET") {
        return response({ code: "invalid_request" }, 400);
      }
      if (url.endsWith("/runs/run-old/output")) return response(outputFor("run-old", "exact-old-bytes"));
      if (url.endsWith("/runs/run-new/output")) return response(outputFor("run-new", "new-bytes"));
      if (url.includes("/runs?")) return response(historyPage);
      return baseStubResponse(url) ?? response({ code: "invalid_request" }, 400);
    });

    await renderTabs(`/engagements/${activeEngagement.id}?tab=runs&run=run-old`);

    const oldest = await screen.findByRole("button", { name: /run-old/ });
    expect(oldest.getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: /run-new/ }).getAttribute("aria-current")).toBeNull();
    await waitFor(() => {
      expect(screen.getByTestId("run-history-stdout").textContent).toBe("exact-old-bytes");
    });
    const urls = fetchUrls(fetchMock);
    expect(urls).toContain(`/api/v1/engagements/${activeEngagement.id}/runs/run-old/output`);
    expect(urls.some((entry) => entry.endsWith("/runs/run-new/output"))).toBe(false);
    // The Runs panel header also contains "Selected run output"; match the
    // common selection line exactly instead.
    const commonLine = screen.getByText(
      (_content, element) =>
        element instanceof HTMLParagraphElement &&
        element.textContent === "Selected run run-old",
    );
    expect(commonLine.getAttribute("title")).toBe("run-old");
  });

  it("preserves the selected run across tab switches", async () => {
    const historyPage = {
      runs: [
        runSummary("run-new", "2026-08-10T12:00:00.000Z"),
        runSummary("run-old", "2026-08-09T12:00:00.000Z"),
      ],
      nextCursor: null,
    };
    const fetchMock = stubFetch((url, init) => {
      if (init?.method !== undefined && init.method !== "GET") {
        return response({ code: "invalid_request" }, 400);
      }
      if (url.endsWith("/runs/run-old/output")) return response(outputFor("run-old", "exact-old-bytes"));
      if (url.endsWith("/runs/run-new/output")) return response(outputFor("run-new", "new-bytes"));
      if (url.includes("/runs?")) return response(historyPage);
      return baseStubResponse(url) ?? response({ code: "invalid_request" }, 400);
    });

    const { router } = await renderTabs(
      `/engagements/${activeEngagement.id}?tab=runs&run=run-old`,
    );
    await screen.findByRole("button", { name: /run-old/ });
    await waitFor(() => {
      expect(screen.getByTestId("run-history-stdout").textContent).toBe("exact-old-bytes");
    });

    fireEvent.click(screen.getByRole("link", { name: "Surface" }));
    expect(await screen.findByRole("heading", { name: "Attack surface" })).toBeTruthy();
    expect((router.state.location.search as Record<string, unknown>)["run"]).toBe("run-old");
    const commonLine = screen.getByText(
      (_content, element) =>
        element instanceof HTMLParagraphElement &&
        element.textContent === "Selected run run-old",
    );
    expect(commonLine.getAttribute("title")).toBe("run-old");

    fireEvent.click(screen.getByRole("link", { name: "Runs" }));
    const oldest = await screen.findByRole("button", { name: /run-old/ });
    expect(oldest.getAttribute("aria-current")).toBe("true");
    await waitFor(() => {
      expect(screen.getByTestId("run-history-stdout").textContent).toBe("exact-old-bytes");
    });
    expect(
      fetchUrls(fetchMock).some((entry) => entry.endsWith("/runs/run-new/output")),
    ).toBe(false);
  });

  it("maps an unknown run to an unavailable state without a latest fallback", async () => {
    const fetchMock = stubFetch((url, init) => {
      if (init?.method !== undefined && init.method !== "GET") {
        return response({ code: "invalid_request" }, 400);
      }
      if (url.includes("/runs?")) {
        return response({
          runs: [runSummary("run-old", "2026-08-09T12:00:00.000Z")],
          nextCursor: null,
        });
      }
      if (url.endsWith("/runs/run-missing/output")) {
        return response({ code: "run_not_found" }, 404);
      }
      return baseStubResponse(url) ?? response({ code: "invalid_request" }, 400);
    });

    await renderTabs(`/engagements/${activeEngagement.id}?tab=runs&run=run-missing`);

    expect(await screen.findByText("Run unavailable")).toBeTruthy();
    expect(
      fetchUrls(fetchMock).some((entry) => entry.endsWith("/runs/run-old/output")),
    ).toBe(false);
  });

  it("blocks tab switches while notes are dirty; Stay retains and Leave discards", async () => {
    stubFetch((url, init) => {
      if (url.endsWith("/notes") && init?.method === "PUT") {
        return response({
          engagementId: activeEngagement.id,
          markdown: "# draft",
          updatedAt: "2026-08-12T12:01:00.000Z",
          revision: 1,
        });
      }
      if (init?.method !== undefined && init.method !== "GET") {
        return response({ code: "invalid_request" }, 400);
      }
      return baseStubResponse(url) ?? response({ code: "invalid_request" }, 400);
    });

    const { router } = await renderTabs(`/engagements/${activeEngagement.id}?tab=notes`);
    const editor = (await screen.findByLabelText("Markdown")) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "# draft" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: "Surface" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Unsaved notes" });
    expect((router.state.location.search as Record<string, unknown>)["tab"] ?? null).not.toBe(
      "surface",
    );
    expect((screen.getByLabelText("Markdown") as HTMLTextAreaElement).value).toBe("# draft");

    fireEvent.click(within(dialog).getByRole("button", { name: "Stay" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect((screen.getByLabelText("Markdown") as HTMLTextAreaElement).value).toBe("# draft");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: "Surface" }));
    const releave = await screen.findByRole("alertdialog", { name: "Unsaved notes" });
    fireEvent.click(within(releave).getByRole("button", { name: "Leave" }));
    expect(await screen.findByRole("heading", { name: "Attack surface" })).toBeTruthy();
    expect(screen.queryByLabelText("Markdown")).toBeNull();

    fireEvent.click(screen.getByRole("link", { name: "Notes" }));
    const backEditor = (await screen.findByLabelText("Markdown")) as HTMLTextAreaElement;
    expect(backEditor.value).toBe("");
  });

  it("sees invalidated report data on revisit through existing hooks", async () => {    let stored = "notes-v1";
    let reportCalls = 0;
    stubFetch((url, init) => {
      if (url.endsWith(`/engagements/${activeEngagement.id}/report`)) {
        reportCalls += 1;
        return response(
          reportBundle(
            reportCalls === 1 ? "notes-v1" : "notes-v2",
            reportCalls === 1 ? "2026-08-12T13:00:00.000Z" : "2026-08-12T14:00:00.000Z",
          ),
        );
      }
      if (url.endsWith("/notes") && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as {
          markdown: string;
          expectedRevision: number;
        };
        stored = body.markdown;
        return response({
          engagementId: activeEngagement.id,
          markdown: stored,
          updatedAt: "2026-08-12T14:00:00.000Z",
          revision: body.expectedRevision + 1,
        });
      }
      if (url.endsWith("/notes")) {
        return response({
          engagementId: activeEngagement.id,
          markdown: stored,
          updatedAt: "2026-08-12T12:00:00.000Z",
          revision: 1,
        });
      }
      if (init?.method !== undefined && init.method !== "GET") {
        return response({ code: "invalid_request" }, 400);
      }
      return baseStubResponse(url) ?? response({ code: "invalid_request" }, 400);
    });

    await renderTabs(`/engagements/${activeEngagement.id}?tab=report`);
    expect(await screen.findByText(/notes-v1/)).toBeTruthy();
    expect(reportCalls).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByRole("link", { name: "Notes" }));
    const editor = (await screen.findByLabelText("Markdown")) as HTMLTextAreaElement;
    expect(editor.value).toBe("notes-v1");
    fireEvent.change(editor, { target: { value: "notes-v2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());

    fireEvent.click(screen.getByRole("link", { name: "Report" }));
    expect(await screen.findByText(/notes-v2/)).toBeTruthy();
    expect(reportCalls).toBeGreaterThanOrEqual(2);
  });

  it("routes New run to Surface and focuses the planner from another tab", async () => {
    stubFetch((url, init) => {
      if (init?.method !== undefined && init.method !== "GET") {
        return response({ code: "invalid_request" }, 400);
      }
      return baseStubResponse(url) ?? response({ code: "invalid_request" }, 400);
    });

    const { router } = await renderTabs(`/engagements/${activeEngagement.id}?tab=runs`);
    expect(await screen.findByText("No runs yet")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "New run" }));
    const targets = await screen.findByLabelText("Targets");
    expect(document.activeElement).toBe(targets);
    expect((router.state.location.search as Record<string, unknown>)["tab"]).toBe("surface");
  });

  it("blocks New run on a dirty draft; Stay launches nothing and keeps the draft", async () => {
    const fetchMock = stubFetch((url, init) => {
      if (url.endsWith("/notes") && init?.method === "PUT") {
        return response({
          engagementId: activeEngagement.id,
          markdown: "# draft",
          updatedAt: "2026-08-12T12:01:00.000Z",
          revision: 1,
        });
      }
      if (init?.method !== undefined && init.method !== "GET") {
        return response({ code: "invalid_request" }, 400);
      }
      return baseStubResponse(url) ?? response({ code: "invalid_request" }, 400);
    });

    await renderTabs(`/engagements/${activeEngagement.id}?tab=notes`);
    const editor = (await screen.findByLabelText("Markdown")) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "# draft" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "New run" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Unsaved notes" });
    expect((screen.getByLabelText("Markdown") as HTMLTextAreaElement).value).toBe("# draft");

    fireEvent.click(within(dialog).getByRole("button", { name: "Stay" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect((screen.getByLabelText("Markdown") as HTMLTextAreaElement).value).toBe("# draft");
    const writes = fetchMock.mock.calls.filter((call) => {
      const init = call[1] as RequestInit | undefined;
      return init?.method !== undefined && init.method !== "GET";
    });
    expect(writes).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "New run" }));
    const releave = await screen.findByRole("alertdialog", { name: "Unsaved notes" });
    fireEvent.click(within(releave).getByRole("button", { name: "Leave" }));
    const targets = await screen.findByLabelText("Targets");
    expect(document.activeElement).toBe(targets);
  });
});

describe("ExecutionTray coverage", () => {
  function renderTray() {
    const queryClient = createAppQueryClient();
    testQueryClients.add(queryClient);
    const onOpenRun = vi.fn();
    const view = render(
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <ExecutionTray engagementId={activeEngagement.id} onOpenRun={onOpenRun} />
        </QueryClientProvider>
      </ThemeProvider>,
    );
    return { ...view, onOpenRun, queryClient };
  }

  it("keeps paging past the first active run so older concurrent actives stay visible", async () => {
    const fetchMock = stubFetch((url, init) => {
      if (init?.method !== undefined && init.method !== "GET") {
        return response({ code: "invalid_request" }, 400);
      }
      if (url.includes("/runs?")) {
        if (url.includes("before=")) {
          return response({
            runs: [runSummary("run-active-old", "2026-08-10T11:00:00.000Z", "running")],
            nextCursor: null,
          });
        }
        return response({
          runs: [
            runSummary("run-active-new", "2026-08-10T12:00:00.000Z", "running"),
            runSummary("run-old-terminal", "2026-08-09T12:00:00.000Z"),
          ],
          nextCursor: "cursor-1",
        });
      }
      return response({ code: "invalid_request" }, 400);
    });

    renderTray();

    expect(await screen.findByTitle("run-active-new")).toBeTruthy();
    expect(await screen.findByTitle("run-active-old")).toBeTruthy();
    const tray = screen.getByLabelText("Execution tray");
    expect(tray.textContent).toMatch(/2 active/);
    expect(fetchUrls(fetchMock).some((entry) => entry.includes("before=cursor-1"))).toBe(true);
  });

  it("declares partial coverage with a working continue when older history remains unchecked", async () => {
    const fetchMock = stubFetch((url, init) => {
      if (init?.method !== undefined && init.method !== "GET") {
        return response({ code: "invalid_request" }, 400);
      }
      if (url.includes("/runs?")) {
        const match = url.match(/before=(cursor-\d+)/);
        if (match === null) {
          return response({
            runs: [runSummary("run-terminal-1", "2026-08-10T12:00:00.000Z")],
            nextCursor: "cursor-1",
          });
        }
        const page = Number(match[1]?.split("-")[1] ?? "0");
        if (page >= 8) return response({ runs: [], nextCursor: null });
        return response({
          runs: [runSummary(`run-terminal-${page + 1}`, "2026-08-10T11:00:00.000Z")],
          nextCursor: `cursor-${page + 1}`,
        });
      }
      return response({ code: "invalid_request" }, 400);
    });

    renderTray();

    const continueButton = await screen.findByRole("button", { name: "Check older runs" });
    expect(screen.getByText(/older history unchecked/)).toBeTruthy();
    // Auto-paged older terminals are history, not newly finished work.
    expect(screen.queryByText(/finished/)).toBeNull();

    fireEvent.click(continueButton);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Check older runs" })).toBeNull();
    });
    expect(fetchUrls(fetchMock).some((entry) => entry.includes("before=cursor-8"))).toBe(true);
  });

  it("does not announce appended historical terminals but still detects later completion", async () => {
    let completed = false;
    const fetchMock = stubFetch((url, init) => {
      if (init?.method !== undefined && init.method !== "GET") {
        return response({ code: "invalid_request" }, 400);
      }
      if (url.includes("/runs?")) {
        if (!url.includes("before=")) {
          return response({
            runs: [runSummary("run-terminal-a", "2026-08-10T12:00:00.000Z")],
            nextCursor: "cursor-1",
          });
        }
        return response({
          runs: [
            runSummary("run-terminal-old", "2026-08-09T12:00:00.000Z"),
            runSummary(
              "run-active-old",
              "2026-08-08T12:00:00.000Z",
              completed ? "succeeded" : "running",
            ),
          ],
          nextCursor: null,
        });
      }
      return response({ code: "invalid_request" }, 400);
    });
    const { queryClient } = renderTray();

    // The appended page arrives with an old terminal and an older active run.
    // The historical terminal must never read as newly finished work.
    expect(await screen.findByTitle("run-active-old")).toBeTruthy();
    expect(screen.getByText(/1 active/)).toBeTruthy();
    expect(screen.queryByText(/finished/)).toBeNull();
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);

    // The older active run completes; the tray announces that transition.
    completed = true;
    await act(async () => {
      await queryClient.refetchQueries();
    });
    await waitFor(() => {
      expect(screen.getByText(/1 finished/)).toBeTruthy();
    });
    expect(screen.getByText(/0 active/)).toBeTruthy();
  });
});
