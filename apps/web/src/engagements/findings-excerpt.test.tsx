// @vitest-environment jsdom

import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { createAppRouter } from "../router.js";
import { requestFindingFromExcerpt } from "./run-output-query.js";

const ENGAGEMENT_ID = "10000000-0000-4000-8000-000000000001";

const activeEngagement = {
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
};

const readyStatus = { version: 1, overall: "ready", developmentStorage: "ready" };

function response(payload: unknown, status = 200): Response {
  return {
    json: async () => payload,
    ok: status >= 200 && status < 300,
    status,
  } as Response;
}

const STAGED_EXCERPT = {
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
  targetNote: "web on 10.0.0.5",
  createdAt: "2026-08-12T12:00:00.000Z",
};

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

function stubWorkspace(posts: { url: string; body: unknown }[], excerpts: unknown[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/system/status")) return Promise.resolve(response(readyStatus));
      if (url === "/api/v1/engagements") return Promise.resolve(response([activeEngagement]));
      if (url === `/api/v1/engagements/${ENGAGEMENT_ID}`) {
        return Promise.resolve(
          response({ engagement: activeEngagement, activeScopeRevision: null }),
        );
      }
      if (url.endsWith("/services")) return Promise.resolve(response([]));
      if (url.endsWith("/notes")) {
        return Promise.resolve(
          response({
            engagementId: ENGAGEMENT_ID,
            markdown: "",
            updatedAt: "2026-08-12T12:00:00.000Z",
            revision: 0,
          }),
        );
      }
      if (url.endsWith("/excerpts") && init?.method !== "POST") {
        return Promise.resolve(response(excerpts));
      }
      if (url.endsWith("/findings") && (init?.method === undefined || init.method === "GET")) {
        return Promise.resolve(response([]));
      }
      if (url.endsWith("/findings") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push({ url, body });
        return Promise.resolve(
          response(
            {
              contractVersion: 1,
              id: "30000000-0000-4000-8000-000000000001",
              engagementId: ENGAGEMENT_ID,
              title: body["title"],
              severity: body["severity"],
              status: "open",
              body: body["body"],
              evidenceArtifactIds: body["evidenceArtifactIds"],
              createdAt: "2026-08-12T12:00:00.000Z",
              updatedAt: "2026-08-12T12:00:00.000Z",
            },
            201,
          ),
        );
      }
      return Promise.resolve(response([]));
    }),
  );
}

describe("findings creation from excerpt", () => {
  it("prefills target, source, and excerpt with no artifact-ID field", async () => {
    const posts: { url: string; body: unknown }[] = [];
    stubWorkspace(posts);
    requestFindingFromExcerpt(ENGAGEMENT_ID, STAGED_EXCERPT as never);

    await renderWorkspace(`/engagements/${ENGAGEMENT_ID}?tab=findings`);

    const notes = (await screen.findByLabelText("Notes Markdown")) as HTMLTextAreaElement;
    await waitFor(() => {
      expect(notes.value).toContain("Source: run run-exce");
    });
    expect(notes.value).toContain("Target (operator note): web on 10.0.0.5");
    expect(notes.value).toContain("line two");
    expect(notes.value).toContain("artifact-stdout");
    // The ordinary flow carries no artifact-ID field.
    expect(screen.queryByLabelText(/artifact/i)).toBeNull();

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Open login page" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create finding" }));
    await waitFor(() => expect(posts.length).toBe(1));
    // Evidence linkage travels silently from the linked excerpt.
    expect(posts[0]?.body).toMatchObject({ evidenceArtifactIds: ["artifact-stdout"] });
  });

  it("links a saved excerpt from the picker and attaches its artifact", async () => {
    const posts: { url: string; body: unknown }[] = [];
    stubWorkspace(posts, [STAGED_EXCERPT]);

    await renderWorkspace(`/engagements/${ENGAGEMENT_ID}?tab=findings`);

    const picker = (await screen.findByLabelText("Linked excerpt")) as HTMLSelectElement;
    await waitFor(() => {
      expect(picker.options.length).toBeGreaterThan(1);
    });
    fireEvent.change(picker, { target: { value: STAGED_EXCERPT.id } });
    const notes = screen.getByLabelText("Notes Markdown") as HTMLTextAreaElement;
    expect(notes.value).toContain("Source: run run-exce");

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Picked excerpt finding" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create finding" }));
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0]?.body).toMatchObject({ evidenceArtifactIds: ["artifact-stdout"] });
  });
});
