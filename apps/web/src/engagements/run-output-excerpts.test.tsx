// @vitest-environment jsdom

import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { createAppRouter } from "../router.js";

function response(payload: unknown, status = 200): Response {
  return {
    json: async () => payload,
    ok: status >= 200 && status < 300,
    status,
  } as Response;
}

const testQueryClients = new Set<QueryClient>();

async function renderAt(initialEntry: string) {
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
      media: "(min-width: 768px)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const client of testQueryClients) client.clear();
  testQueryClients.clear();
});

const ENGAGEMENT_ID = "10000000-0000-4000-8000-000000000001";

function engagementList() {
  return [
    {
      contractVersion: 1,
      id: ENGAGEMENT_ID,
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
    },
  ];
}

function engagementDetail() {
  return { engagement: engagementList()[0], activeScopeRevision: null };
}

const OUTPUT_CONTENT = "line one\nline two\npassword=hunter2\n";

function runOutput() {
  return {
    run: {
      id: "run-excerpt-1",
      actionId: "action-1",
      state: "succeeded",
      terminalKind: "succeeded",
      terminalReason: null,
      updatedAt: "2026-08-09T12:00:00.000Z",
    },
    stdout: {
      present: true,
      artifactId: "artifact-stdout",
      sizeBytes: OUTPUT_CONTENT.length,
      digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      completeness: "complete",
      truncated: false,
      content: OUTPUT_CONTENT,
    },
    stderr: { present: false, truncated: false, content: "" },
  };
}

const KEPT_EXCERPT = {
  contractVersion: 1,
  id: "20000000-0000-4000-8000-000000000001",
  engagementId: ENGAGEMENT_ID,
  runId: "run-excerpt-1",
  artifactId: "artifact-stdout",
  artifactDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  stream: "stdout",
  byteOffset: 9,
  byteLength: 8,
  content: "line two",
  redactions: 0,
  targetNote: null,
  createdAt: "2026-08-12T12:00:00.000Z",
};

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)));
}

describe("run output fast capture", () => {
  it("keeps an excerpt from a search match without rendering the whole file", async () => {
    const posts: { url: string; body: unknown }[] = [];
    stubFetch(async (url, init) => {
      if (url === "/api/v1/engagements") return response(engagementList());
      if (url === `/api/v1/engagements/${ENGAGEMENT_ID}`) return response(engagementDetail());
      if (url.endsWith("/services")) return response([]);
      if (url.endsWith("/runs/latest/output")) return response(runOutput());
      if (url.includes("/output/search")) {
        return response({
          matches: [
            {
              artifactId: "artifact-stdout",
              stream: "stdout",
              byteOffset: 9,
              byteLength: 8,
              snippet: "line one\nline two\npassword=[redacted]",
              redactions: 1,
            },
          ],
          searchedBytes: OUTPUT_CONTENT.length,
          scanCapped: false,
          unavailableArtifactIds: [],
        });
      }
      if (url.endsWith("/excerpts") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push({ url, body });
        return response({ ...KEPT_EXCERPT, ...body }, 201);
      }
      if (url.endsWith("/excerpts")) return response(posts.length > 0 ? [KEPT_EXCERPT] : []);
      if (url === "/api/v1/system/status") {
        return response({ version: 1, overall: "ready", developmentStorage: "ready" });
      }
      return response({ code: "invalid_request" }, 400);
    });

    await renderAt(`/engagements/${ENGAGEMENT_ID}`);
    fireEvent.click(screen.getByRole("tab", { name: "Raw output" }));
    await waitFor(() => {
      expect(screen.getByTestId("raw-output-stdout")).toBeTruthy();
    });

    fireEvent.change(screen.getByPlaceholderText("error, login, 10.0.0"), {
      target: { value: "line two" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => {
      expect(screen.getByTestId("run-output-search-match")).toBeTruthy();
    });
    // The full stream is hidden while searching: long output is never
    // rendered to search it.
    expect(screen.queryByTestId("raw-output-stdout")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Keep excerpt" }));
    await waitFor(() => {
      expect(posts.length).toBe(1);
    });
    expect(posts[0]?.body).toMatchObject({
      runId: "run-excerpt-1",
      artifactId: "artifact-stdout",
      stream: "stdout",
      byteOffset: 9,
      byteLength: 8,
    });
    // The kept excerpt carries no caller-supplied digest or content.
    expect(posts[0]?.body).not.toHaveProperty("artifactDigest");
    expect(posts[0]?.body).not.toHaveProperty("content");
  });

  it("keeps the evidence reference with retry when bytes fail verification", async () => {
    const calls: string[] = [];
    stubFetch(async (url) => {
      calls.push(url);
      if (url === "/api/v1/engagements") return response(engagementList());
      if (url === `/api/v1/engagements/${ENGAGEMENT_ID}`) return response(engagementDetail());
      if (url.endsWith("/services")) return response([]);
      if (url.endsWith("/runs/run-old/output")) return response({ code: "missing_artifact" }, 409);
      if (url.endsWith("/excerpt-sources")) {
        return response([
          {
            artifactId: "artifact-stdout",
            kind: "stdout",
            sizeBytes: 128,
            digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            completeness: "complete",
          },
        ]);
      }
      if (url === "/api/v1/system/status") {
        return response({ version: 1, overall: "ready", developmentStorage: "ready" });
      }
      return response({ code: "invalid_request" }, 400);
    });

    await renderAt(`/engagements/${ENGAGEMENT_ID}?tab=runs&run=run-old`);
    fireEvent.click(screen.getByRole("tab", { name: "Raw output" }));
    await waitFor(() => {
      expect(screen.getByText("Raw output unavailable")).toBeTruthy();
    });
    // Reference plus metadata survive the failed download.
    expect(await screen.findByText(/artifact-stdout/)).toBeTruthy();
    expect(screen.getByText(/128 bytes/)).toBeTruthy();

    const outputCalls = calls.filter((url) => url.endsWith("/runs/run-old/output")).length;
    const consolePanel = screen.getByRole("tabpanel", { name: "Raw output" });
    fireEvent.click(within(consolePanel).getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(
        calls.filter((url) => url.endsWith("/runs/run-old/output")).length,
      ).toBeGreaterThan(outputCalls);
    });
  });

  it("labels Add to lead as a future action until STONE-4", async () => {
    stubFetch(async (url, init) => {
      if (url === "/api/v1/engagements") return response(engagementList());
      if (url === `/api/v1/engagements/${ENGAGEMENT_ID}`) return response(engagementDetail());
      if (url.endsWith("/services")) return response([]);
      if (url.endsWith("/runs/latest/output")) return response(runOutput());
      if (url.endsWith("/excerpts") && init?.method !== "POST") return response([KEPT_EXCERPT]);
      if (url === "/api/v1/system/status") {
        return response({ version: 1, overall: "ready", developmentStorage: "ready" });
      }
      return response({ code: "invalid_request" }, 400);
    });

    await renderAt(`/engagements/${ENGAGEMENT_ID}`);
    fireEvent.click(screen.getByRole("tab", { name: "Raw output" }));
    await waitFor(() => {
      expect(screen.getByText("Kept excerpts")).toBeTruthy();
    });
    const addToLead = screen.getByRole("button", { name: "Add to lead" });
    expect(addToLead.hasAttribute("disabled")).toBe(true);
    expect(addToLead.getAttribute("title")).toBe("Leads arrive in STONE-4");
  });
});
