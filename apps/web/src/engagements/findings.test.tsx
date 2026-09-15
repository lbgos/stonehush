// @vitest-environment jsdom

import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { createAppRouter } from "../router.js";

const activeEngagement = {
  contractVersion: 1,
  id: "10000000-0000-4000-8000-000000000001",
  revision: 1,
  name: "Target lab",
  kind: "lab",
  status: "active",
  description: null,
  authorizationContext: null,
  autoContinueWarnings: false,
  activeScopeRevisionId: null,
  deadlineAt: null,
  createdAt: "2026-08-12T12:00:00.000Z",
  updatedAt: "2026-08-12T12:00:00.000Z",
};

const readyStatus = { version: 1, overall: "ready", developmentStorage: "ready" };

function response(payload: unknown, status = 200): Response {
  return {
    json: async () => payload,
    ok: status >= 200 && status < 300,
    status,
  } as Response;
}

function findingRecord(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: 1,
    id: "20000000-0000-4000-8000-000000000001",
    engagementId: activeEngagement.id,
    title: "Default credentials",
    severity: "high",
    status: "open",
    body: "# impact\nAdmin access.",
    evidenceArtifactIds: [],
    revision: 1,
    createdAt: "2026-08-12T12:00:00.000Z",
    updatedAt: "2026-08-12T12:00:00.000Z",
    ...overrides,
  };
}

function reportBundleFixture(findings: unknown[]) {
  return {
    contractVersion: 1,
    engagement: {
      id: activeEngagement.id,
      name: activeEngagement.name,
      kind: activeEngagement.kind,
      status: activeEngagement.status,
      description: activeEngagement.description,
      authorizationContext: activeEngagement.authorizationContext,
      deadlineAt: activeEngagement.deadlineAt,
      revision: activeEngagement.revision,
      createdAt: activeEngagement.createdAt,
      updatedAt: activeEngagement.updatedAt,
    },
    findings,
    notesMarkdown: "",
    notesUpdatedAt: "2026-08-12T12:00:00.000Z",
    services: { total: 0, truncated: false, rows: [] },
    probes: { total: 0, truncated: false, rows: [] },
    ffufResults: { total: 0, truncated: false, rows: [] },
    evidenceArtifacts: { total: 0, truncated: false, rows: [] },
    generatedAt: "2026-08-12T13:00:00.000Z",
  };
}

function stubFindingsWorkspace(
  handle: (url: string, init?: RequestInit) => Promise<Response> | undefined,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/system/status")) return Promise.resolve(response(readyStatus));
      if (url === "/api/v1/engagements") return Promise.resolve(response([activeEngagement]));
      if (url === `/api/v1/engagements/${activeEngagement.id}`) {
        return Promise.resolve(
          response({ engagement: activeEngagement, activeScopeRevision: null }),
        );
      }
      if (url.endsWith("/services")) return Promise.resolve(response([]));
      if (url.endsWith("/notes")) {
        return Promise.resolve(
          response({
            engagementId: activeEngagement.id,
            markdown: "",
            updatedAt: "2026-08-12T12:00:00.000Z",
            revision: 0,
          }),
        );
      }
      const handled = handle(url, init);
      if (handled !== undefined) return handled;
      return Promise.resolve(response([]));
    }),
  );
}

const testQueryClients = new Set<QueryClient>();

async function renderWorkspace(initialEntry: string) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [initialEntry] }));
  await router.load();
  const queryClient = createAppQueryClient();
  testQueryClients.add(queryClient);
  return render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
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

describe("engagement findings", () => {
  it("shows the empty state and creates a finding", async () => {
    let stored: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/system/status")) return Promise.resolve(response(readyStatus));
        if (url === "/api/v1/engagements") return Promise.resolve(response([activeEngagement]));
        if (url === `/api/v1/engagements/${activeEngagement.id}`) {
          return Promise.resolve(
            response({ engagement: activeEngagement, activeScopeRevision: null }),
          );
        }
        if (url.endsWith("/services")) return Promise.resolve(response([]));
        if (url.endsWith("/notes")) {
          return Promise.resolve(
            response({
              engagementId: activeEngagement.id,
              markdown: "",
              updatedAt: "2026-08-12T12:00:00.000Z",
              revision: 0,
            }),
          );
        }
        if (url.endsWith("/findings") && (init?.method === undefined || init.method === "GET")) {
          return Promise.resolve(response(stored));
        }
        if (url.endsWith("/findings") && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          stored = [findingRecord(body)];
          return Promise.resolve(response(stored[0], 201));
        }
        return Promise.resolve(response([]));
      }),
    );

    await renderWorkspace(`/engagements/${activeEngagement.id}?tab=findings`);

    expect(await screen.findByText("No findings yet")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Default credentials" },
    });
    fireEvent.change(screen.getByLabelText("Notes Markdown"), {
      target: { value: "# impact" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create finding" }));

    await waitFor(() =>
      expect(screen.getByText("1 open of 1 findings")).toBeTruthy(),
    );
  });

  it("resolves and reopens from the list", async () => {
    let stored = [findingRecord()];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/system/status")) return Promise.resolve(response(readyStatus));
        if (url === "/api/v1/engagements") return Promise.resolve(response([activeEngagement]));
        if (url === `/api/v1/engagements/${activeEngagement.id}`) {
          return Promise.resolve(
            response({ engagement: activeEngagement, activeScopeRevision: null }),
          );
        }
        if (url.endsWith("/services")) return Promise.resolve(response([]));
        if (url.endsWith("/notes")) {
          return Promise.resolve(
            response({
              engagementId: activeEngagement.id,
              markdown: "",
              updatedAt: "2026-08-12T12:00:00.000Z",
              revision: 0,
            }),
          );
        }
        if (url.endsWith("/findings") && (init?.method === undefined || init.method === "GET")) {
          return Promise.resolve(response(stored));
        }
        if (url.includes("/resolve") && init?.method === "POST") {
          stored = [findingRecord({ status: "resolved" })];
          return Promise.resolve(response(stored[0]));
        }
        if (url.includes("/reopen") && init?.method === "POST") {
          stored = [findingRecord({ status: "open" })];
          return Promise.resolve(response(stored[0]));
        }
        return Promise.resolve(response([]));
      }),
    );

    await renderWorkspace(`/engagements/${activeEngagement.id}?tab=findings`);

    fireEvent.click(await screen.findByRole("button", { name: "Resolve" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Reopen" })).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Resolve" })).toBeTruthy(),
    );
  });

  it("shows a truthful error when findings fail to load", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/system/status")) return Promise.resolve(response(readyStatus));
        if (url === "/api/v1/engagements") return Promise.resolve(response([activeEngagement]));
        if (url === `/api/v1/engagements/${activeEngagement.id}`) {
          return Promise.resolve(
            response({ engagement: activeEngagement, activeScopeRevision: null }),
          );
        }
        if (url.endsWith("/services")) return Promise.resolve(response([]));
        if (url.endsWith("/notes")) {
          return Promise.resolve(
            response({
              engagementId: activeEngagement.id,
              markdown: "",
              updatedAt: "2026-08-12T12:00:00.000Z",
              revision: 0,
            }),
          );
        }
        if (url.endsWith("/findings")) {
          return Promise.resolve(response({ code: "storage_busy" }, 503));
        }
        return Promise.resolve(response([]));
      }),
    );

    await renderWorkspace(`/engagements/${activeEngagement.id}?tab=findings`);

    expect(await screen.findByText("Findings unavailable")).toBeTruthy();
  });

  it("edits a finding and shows the saved content with evidence and status kept", async () => {
    let stored = [findingRecord({ evidenceArtifactIds: ["nmap-xml-1"] })];
    const putBodies: unknown[] = [];
    stubFindingsWorkspace((url, init) => {
      if (url.endsWith("/findings") && (init?.method === undefined || init.method === "GET")) {
        return Promise.resolve(response(stored));
      }
      if (url.endsWith(`/findings/${stored[0]?.id}`) && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        putBodies.push(body);
        const { expectedRevision: _dropped, ...update } = body;
        stored = [findingRecord({ ...stored[0], ...update, revision: 2 })];
        return Promise.resolve(response(stored[0]));
      }
      if (url.endsWith(`/engagements/${activeEngagement.id}/report`)) {
        return Promise.resolve(response(reportBundleFixture(stored)));
      }
      return undefined;
    });

    await renderWorkspace(`/engagements/${activeEngagement.id}?tab=findings`);
    await screen.findByText("Default credentials");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const row = screen.getByText("Default credentials").closest("li") as HTMLElement;
    const titleInput = row.querySelector(
      'input[id^="finding-edit-title-"]',
    ) as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: "Corrected title" } });
    fireEvent.click(screen.getByRole("button", { name: "Save edit" }));

    await waitFor(() => expect(screen.getByText("Corrected title")).toBeTruthy());
    expect(putBodies).toEqual([
      {
        title: "Corrected title",
        severity: "high",
        body: "# impact\nAdmin access.",
        expectedRevision: 1,
      },
    ]);
    expect(screen.getByText("1 evidence")).toBeTruthy();
    expect(screen.getByText("open")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save edit" })).toBeNull();

    fireEvent.click(screen.getByRole("link", { name: "Report" }));
    await waitFor(() => expect(screen.getByText(/Corrected title/)).toBeTruthy());
  });

  it("reloads the saved edit from the server on a fresh view", async () => {
    stubFindingsWorkspace((url, init) => {
      if (url.endsWith("/findings") && (init?.method === undefined || init.method === "GET")) {
        return Promise.resolve(
          response([findingRecord({ title: "Corrected title", revision: 2 })]),
        );
      }
      return undefined;
    });

    await renderWorkspace(`/engagements/${activeEngagement.id}?tab=findings`);
    expect(await screen.findByText("Corrected title")).toBeTruthy();
    expect(screen.getByText("open")).toBeTruthy();
  });

  it("cancels an edit without changing saved content", async () => {
    const putCalls: string[] = [];
    stubFindingsWorkspace((url, init) => {
      if (url.endsWith("/findings") && (init?.method === undefined || init.method === "GET")) {
        return Promise.resolve(response([findingRecord()]));
      }
      if (init?.method === "PUT") {
        putCalls.push(url);
        return Promise.resolve(response(findingRecord()));
      }
      return undefined;
    });

    await renderWorkspace(`/engagements/${activeEngagement.id}?tab=findings`);
    await screen.findByText("Default credentials");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const row = screen.getByText("Default credentials").closest("li") as HTMLElement;
    fireEvent.change(row.querySelector('input[id^="finding-edit-title-"]') as HTMLInputElement, {
      target: { value: "Discarded title" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByText("Default credentials")).toBeTruthy();
    expect(screen.queryByText("Discarded title")).toBeNull();
    expect(putCalls).toEqual([]);
  });

  it("disables save while the title is empty", async () => {
    stubFindingsWorkspace((url, init) => {
      if (url.endsWith("/findings") && (init?.method === undefined || init.method === "GET")) {
        return Promise.resolve(response([findingRecord()]));
      }
      return undefined;
    });

    await renderWorkspace(`/engagements/${activeEngagement.id}?tab=findings`);
    await screen.findByText("Default credentials");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const row = screen.getByText("Default credentials").closest("li") as HTMLElement;
    fireEvent.change(row.querySelector('input[id^="finding-edit-title-"]') as HTMLInputElement, {
      target: { value: "   " },
    });
    expect(screen.getByRole("button", { name: "Save edit" }).hasAttribute("disabled")).toBe(true);
  });

  it("keeps the draft on conflict and reloads the server version", async () => {
    let stored = [findingRecord()];
    stubFindingsWorkspace((url, init) => {
      if (url.endsWith("/findings") && (init?.method === undefined || init.method === "GET")) {
        return Promise.resolve(response(stored));
      }
      if (url.endsWith(`/findings/${stored[0]?.id}`) && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (body.expectedRevision !== 2) {
          return Promise.resolve(
            response(
              {
                code: "revision_conflict",
                resourceType: "finding",
                resourceId: stored[0]?.id,
                currentRevision: 2,
              },
              409,
            ),
          );
        }
        const { expectedRevision: _dropped, ...update } = body;
        stored = [findingRecord({ ...stored[0], ...update, revision: 3 })];
        return Promise.resolve(response(stored[0]));
      }
      return undefined;
    });

    await renderWorkspace(`/engagements/${activeEngagement.id}?tab=findings`);
    await screen.findByText("Default credentials");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const row = screen.getByText("Default credentials").closest("li") as HTMLElement;
    const titleInput = row.querySelector(
      'input[id^="finding-edit-title-"]',
    ) as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: "My draft title" } });
    fireEvent.click(screen.getByRole("button", { name: "Save edit" }));

    expect(await screen.findByText("This finding changed elsewhere. Your edits are kept.")).toBeTruthy();
    expect(titleInput.value).toBe("My draft title");

    stored = [findingRecord({ title: "Server title", revision: 2 })];
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() =>
      expect(
        (screen.getByText("Server title").closest("li") as HTMLElement).querySelector(
          'input[id^="finding-edit-title-"]',
        ),
      ).toBeTruthy(),
    );
    const reloaded = screen.getByText("Server title").closest("li") as HTMLElement;
    expect(
      (reloaded.querySelector('input[id^="finding-edit-title-"]') as HTMLInputElement).value,
    ).toBe("Server title");
  });

  it("prevents duplicate writes while saving", async () => {
    let stored = [findingRecord()];
    let putCalls = 0;
    let releasePut!: (value: Response) => void;
    stubFindingsWorkspace((url, init) => {
      if (url.endsWith("/findings") && (init?.method === undefined || init.method === "GET")) {
        return Promise.resolve(response(stored));
      }
      if (init?.method === "PUT") {
        putCalls += 1;
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const { expectedRevision: _dropped, ...update } = body;
        stored = [findingRecord({ ...stored[0], ...update, revision: 2 })];
        return new Promise<Response>((resolve) => {
          releasePut = resolve;
        });
      }
      return undefined;
    });

    await renderWorkspace(`/engagements/${activeEngagement.id}?tab=findings`);
    await screen.findByText("Default credentials");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const row = screen.getByText("Default credentials").closest("li") as HTMLElement;
    fireEvent.change(row.querySelector('input[id^="finding-edit-title-"]') as HTMLInputElement, {
      target: { value: "Saved title" },
    });
    const save = screen.getByRole("button", { name: "Save edit" });
    fireEvent.click(save);
    await waitFor(() => expect(putCalls).toBe(1));
    const saving = screen.getByRole("button", { name: "Saving" });
    expect(saving.hasAttribute("disabled")).toBe(true);
    fireEvent.click(saving);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(putCalls).toBe(1);

    releasePut(response(stored[0]));
    await waitFor(() => expect(screen.getByText("Saved title")).toBeTruthy());
    expect(putCalls).toBe(1);
  });

  it("keeps a dirty draft when another row refreshes the list", async () => {
    let stored = [
      findingRecord(),
      findingRecord({
        id: "20000000-0000-4000-8000-000000000002",
        title: "Second finding",
      }),
    ];
    stubFindingsWorkspace((url, init) => {
      if (url.endsWith("/findings") && (init?.method === undefined || init.method === "GET")) {
        return Promise.resolve(response(stored));
      }
      if (url.includes("/resolve") && init?.method === "POST") {
        stored = stored.map((entry) =>
          entry.id === "20000000-0000-4000-8000-000000000002"
            ? { ...entry, status: "resolved", revision: 2 }
            : entry,
        );
        return Promise.resolve(response(stored[1]));
      }
      return undefined;
    });

    await renderWorkspace(`/engagements/${activeEngagement.id}?tab=findings`);
    await screen.findByText("Second finding");

    const firstRow = screen.getByText("Default credentials").closest("li") as HTMLElement;
    fireEvent.click(
      firstRow.querySelector("button") as HTMLButtonElement,
    );
    const titleInput = firstRow.querySelector(
      'input[id^="finding-edit-title-"]',
    ) as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: "Dirty draft" } });

    const secondRow = screen.getByText("Second finding").closest("li") as HTMLElement;
    fireEvent.click(
      Array.from(secondRow.querySelectorAll("button")).find(
        (button) => button.textContent === "Resolve",
      ) as HTMLButtonElement,
    );

    await waitFor(() =>
      expect(
        (screen.getByText("Second finding").closest("li") as HTMLElement).textContent,
      ).toMatch(/resolved/),
    );
    expect(titleInput.value).toBe("Dirty draft");
  });

  it("keeps the draft when the save request fails offline", async () => {
    stubFindingsWorkspace((url, init) => {
      if (url.endsWith("/findings") && (init?.method === undefined || init.method === "GET")) {
        return Promise.resolve(response([findingRecord()]));
      }
      if (init?.method === "PUT") {
        return Promise.reject(new Error("offline"));
      }
      return undefined;
    });

    await renderWorkspace(`/engagements/${activeEngagement.id}?tab=findings`);
    await screen.findByText("Default credentials");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const row = screen.getByText("Default credentials").closest("li") as HTMLElement;
    const titleInput = row.querySelector(
      'input[id^="finding-edit-title-"]',
    ) as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: "Offline draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save edit" }));

    expect(await screen.findByText("The findings request failed.")).toBeTruthy();
    expect(titleInput.value).toBe("Offline draft");
  });
});
