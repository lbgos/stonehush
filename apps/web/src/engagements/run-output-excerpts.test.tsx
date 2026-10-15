// @vitest-environment jsdom

import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { createAppRouter } from "../router.js";
import { excerptsQueryKey, runOutputQueryKey } from "./run-output-query.js";

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
  const view = render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { ...view, router, queryClient };
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

// Shared workspace shell: engagement list and detail, services, and system
// status. Tests add only their run-output, search, excerpt, and source routes.
function shellResponse(url: string): Promise<Response> | undefined {
  if (url === "/api/v1/engagements") return Promise.resolve(response(engagementList()));
  if (url === `/api/v1/engagements/${ENGAGEMENT_ID}`) return Promise.resolve(response(engagementDetail()));
  if (url.endsWith("/services")) return Promise.resolve(response([]));
  if (url === "/api/v1/system/status") {
    return Promise.resolve(response({ version: 1, overall: "ready", developmentStorage: "ready" }));
  }
  return undefined;
}

describe("run output fast capture", () => {
  it("keeps an excerpt from a search match without rendering the whole file", async () => {
    const posts: { url: string; body: unknown }[] = [];
    stubFetch(async (url, init) => {
      const shell = shellResponse(url);
      if (shell !== undefined) return shell;
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
      const shell = shellResponse(url);
      if (shell !== undefined) return shell;
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

  it("resolves the latest failed run across history pages instead of guessing", async () => {
    // The 409 from the latest-output endpoint carries no run id. History is
    // newest-created first, so the first page holds only queued runs plus an
    // older completed decoy; the true latest terminal run sits on page two.
    // Picking the first terminal row would show the decoy's reference.
    const queued = (id: string) => ({
      id,
      actionId: "action-1",
      state: "queued",
      terminalKind: null,
      terminalReason: null,
      updatedAt: "2026-08-14T12:00:00.000Z",
      createdAt: "2026-08-14T12:00:00.000Z",
      attempt: 1,
    });
    const decoy = {
      id: "run-decoy",
      actionId: "action-1",
      state: "succeeded",
      terminalKind: "succeeded",
      terminalReason: null,
      updatedAt: "2026-08-10T12:00:00.000Z",
      createdAt: "2026-08-13T12:00:00.000Z",
      attempt: 1,
    };
    const latest = {
      id: "run-old",
      actionId: "action-1",
      state: "failed",
      terminalKind: "failed",
      terminalReason: null,
      updatedAt: "2026-08-12T12:00:00.000Z",
      createdAt: "2026-08-11T12:00:00.000Z",
      attempt: 1,
    };
    stubFetch(async (url) => {
      const shell = shellResponse(url);
      if (shell !== undefined) return shell;
      if (url.endsWith("/runs/latest/output")) return response({ code: "missing_artifact" }, 409);
      if (url.includes(`/api/v1/engagements/${ENGAGEMENT_ID}/runs?`)) {
        if (url.includes("before=")) return response({ runs: [latest], nextCursor: null });
        return response({ runs: [...Array.from({ length: 24 }, (_, index) => queued(`run-queued-${index}`)), decoy], nextCursor: "cursor-1" });
      }
      if (url.endsWith("/runs/run-old/excerpt-sources")) {
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
      if (url.endsWith("/runs/run-decoy/excerpt-sources")) {
        return response([
          {
            artifactId: "artifact-decoy",
            kind: "stdout",
            sizeBytes: 64,
            digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            completeness: "complete",
          },
        ]);
      }
      return response({ code: "invalid_request" }, 400);
    });

    await renderAt(`/engagements/${ENGAGEMENT_ID}?tab=runs`);
    fireEvent.click(screen.getByRole("tab", { name: "Raw output" }));
    await waitFor(() => {
      expect(screen.getByText("Raw output unavailable")).toBeTruthy();
    });
    // The panel shows the true latest terminal run, not the decoy.
    expect(await screen.findByText(/artifact-stdout/)).toBeTruthy();
    expect(screen.queryByText(/artifact-decoy/)).toBeNull();
  });

  it("labels Add to lead as a future action until STONE-4", async () => {
    stubFetch(async (url, init) => {
      const shell = shellResponse(url);
      if (shell !== undefined) return shell;
      if (url.endsWith("/runs/latest/output")) return response(runOutput());
      if (url.endsWith("/excerpts") && init?.method !== "POST") return response([KEPT_EXCERPT]);
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

  it("states skipped artifacts instead of reporting a complete scan", async () => {
    stubFetch(async (url) => {
      const shell = shellResponse(url);
      if (shell !== undefined) return shell;
      if (url.endsWith("/runs/latest/output")) return response(runOutput());
      if (url.includes("/output/search")) {
        return response({
          matches: [],
          searchedBytes: OUTPUT_CONTENT.length,
          scanCapped: false,
          unavailableArtifactIds: ["artifact-stderr"],
        });
      }
      return response({ code: "invalid_request" }, 400);
    });

    await renderAt(`/engagements/${ENGAGEMENT_ID}`);
    fireEvent.click(screen.getByRole("tab", { name: "Raw output" }));
    await waitFor(() => {
      expect(screen.getByTestId("raw-output-stdout")).toBeTruthy();
    });

    fireEvent.change(screen.getByPlaceholderText("error, login, 10.0.0"), {
      target: { value: "absent-term" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    // Zero matches with a skipped artifact must not read as proof of
    // absence: the summary names the skip.
    expect(await screen.findByText(/No matches for absent-term/)).toBeTruthy();
    expect(screen.getByText(/1 artifact was skipped: bytes unavailable\./)).toBeTruthy();
  });

  it("commits a keyboard selection for excerpt keeps", async () => {
    stubFetch(async (url) => {
      const shell = shellResponse(url);
      if (shell !== undefined) return shell;
      if (url.endsWith("/runs/latest/output")) return response(runOutput());
      return response({ code: "invalid_request" }, 400);
    });

    await renderAt(`/engagements/${ENGAGEMENT_ID}`);
    fireEvent.click(screen.getByRole("tab", { name: "Raw output" }));
    const pre = (await screen.findByTestId("raw-output-stdout")) as HTMLElement;
    // Keyboard selection (shift plus arrows) lands in the same element
    // without a mouse event: the pre is focusable and commits on key up.
    const textNode = pre.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 9);
    range.setEnd(textNode, 17);
    const selection = window.getSelection();
    if (selection === null) throw new Error("jsdom selection missing");
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.keyUp(pre);

    expect(await screen.findByText("Selected 8 bytes at offset 9.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep excerpt" })).toBeTruthy();
  });
});


function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function selectRange(start = 9, end = 17) {
  const pre = screen.getByTestId("raw-output-stdout");
  const range = document.createRange();
  range.setStart(pre.firstChild!, start);
  range.setEnd(pre.firstChild!, end);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.keyUp(pre);
}

describe("capture feedback ownership", () => {
  it.each(["success", "failure"] as const)("retains a newer range in the same source after old %s", async (outcome) => {
    const pending = deferred<Response>();
    let posts = 0;
    stubFetch(async (url, init) => {
      const shell = shellResponse(url);
      if (shell !== undefined) return shell;
      if (url.endsWith("/runs/latest/output")) return response(runOutput());
      if (url.endsWith("/excerpts") && init?.method === "POST") { posts += 1; return pending.promise; }
      if (url.endsWith("/excerpts")) return response([]);
      return response({ code: "invalid_request" }, 400);
    });
    await renderAt(`/engagements/${ENGAGEMENT_ID}`);
    fireEvent.click(screen.getByRole("tab", { name: "Raw output" }));
    await screen.findByTestId("raw-output-stdout");
    selectRange();
    fireEvent.click(screen.getByRole("button", { name: "Keep excerpt" }));
    await waitFor(() => expect(posts).toBe(1));
    selectRange(0, 4);
    await act(async () => { pending.resolve(outcome === "success" ? response(KEPT_EXCERPT, 201) : response({ code: "storage_busy" }, 503)); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Keep excerpt" }).hasAttribute("disabled")).toBe(false));
    expect(screen.getByText("Selected 4 bytes at offset 0.")).toBeTruthy();
    expect(screen.queryByText(/The excerpt could not be kept/)).toBeNull();
    expect(posts).toBe(1);
  });

  for (const mode of ["selection", "search"] as const) {
    for (const settles of ["success", "failure"] as const) {
      for (const returnToA of [false, true]) {
        it(`${mode}: old A ${settles} cannot affect ${returnToA ? "a new A visit" : "B"}`, async () => {
          const pending = deferred<Response>();
          const current = deferred<Response>();
          const posts: Record<string, unknown>[] = [];
          const saved: unknown[] = [];
          const outputA = runOutput();
          const outputB = { ...runOutput(), run: { ...runOutput().run, id: "run-excerpt-2" }, stdout: { ...runOutput().stdout, artifactId: "artifact-b" } };
          stubFetch(async (url, init) => {
            const shell = shellResponse(url);
            if (shell !== undefined) return shell;
            if (url.endsWith("/runs/run-excerpt-1/output")) return response(outputA);
            if (url.endsWith("/runs/run-excerpt-2/output")) return response(outputB);
            if (url.includes("/output/search")) return response({
              matches: [{ artifactId: url.includes("run-excerpt-2") ? "artifact-b" : "artifact-stdout", stream: "stdout", byteOffset: 9, byteLength: 8, snippet: "line two", redactions: 0 }],
              searchedBytes: OUTPUT_CONTENT.length, scanCapped: false, unavailableArtifactIds: [],
            });
            if (url.endsWith("/excerpts") && init?.method === "POST") {
              const body = JSON.parse(String(init.body)) as Record<string, unknown>;
              posts.push(body);
              const result = posts.length === 1 ? await pending.promise : posts.length === 2 && returnToA ? await current.promise : response({ ...KEPT_EXCERPT, ...body, id: `20000000-0000-4000-8000-${String(posts.length).padStart(12, "0")}` }, 201);
              if (result.ok) saved.push(await result.json());
              return result;
            }
            if (url.endsWith("/excerpts")) return response(saved);
            return response({ code: "invalid_request" }, 400);
          });
          const { router, queryClient } = await renderAt(`/engagements/${ENGAGEMENT_ID}?run=run-excerpt-1`);
          queryClient.setQueryData(runOutputQueryKey(ENGAGEMENT_ID, "run-excerpt-1"), outputA);
          queryClient.setQueryData(runOutputQueryKey(ENGAGEMENT_ID, "run-excerpt-2"), outputB);
          fireEvent.click(screen.getByRole("tab", { name: "Raw output" }));
          await screen.findByTestId("raw-output-stdout");
          const choose = async () => {
            if (mode === "selection") selectRange();
            else {
              fireEvent.change(screen.getByPlaceholderText("error, login, 10.0.0"), { target: { value: "line two" } });
              fireEvent.click(screen.getByRole("button", { name: "Search", exact: true }));
              await screen.findByTestId("run-output-search-match");
            }
          };
          await choose();
          fireEvent.click(screen.getByRole("button", { name: "Keep excerpt" }));
          await waitFor(() => expect(posts).toHaveLength(1));
          const go = async (run: string) => {
            await act(async () => { await router.navigate({ to: "/engagements/$engagementId", params: { engagementId: ENGAGEMENT_ID }, search: { run } }); });
            await screen.findByRole("region", { name: `stdout for run ${run}` });
          };
          await go("run-excerpt-2");
          if (returnToA) await go("run-excerpt-1");
          await choose();
          if (returnToA) {
            fireEvent.click(screen.getByRole("button", { name: "Keep excerpt" }));
            await waitFor(() => expect(posts).toHaveLength(2));
          }
          await act(async () => { pending.resolve(settles === "success" ? response(KEPT_EXCERPT, 201) : response({ code: "storage_busy" }, 503)); });
          await waitFor(() => expect(queryClient.isMutating()).toBe(returnToA ? 1 : 0));
          if (returnToA) {
            expect(screen.getAllByRole("button", { name: "Keeping" }).every((button) => button.hasAttribute("disabled"))).toBe(true);
            expect(screen.queryByText(/The excerpt could not be kept/)).toBeNull();
            await act(async () => { current.resolve(response({ code: "storage_busy" }, 503)); });
            await waitFor(() => expect(screen.getByText(/The excerpt could not be kept/)).toBeTruthy());
          }
          expect(screen.getByRole("button", { name: "Keep excerpt" }).hasAttribute("disabled")).toBe(false);
          if (!returnToA) expect(screen.queryByText(/The excerpt could not be kept/)).toBeNull();
          expect(screen.queryByText("Excerpt kept. Open the Findings tab to create a linked finding.")).toBeNull();
          if (mode === "selection") expect(screen.getByText("Selected 8 bytes at offset 9.")).toBeTruthy();
          expect(posts[0]).toEqual({ runId: "run-excerpt-1", artifactId: "artifact-stdout", stream: "stdout", byteOffset: 9, byteLength: 8 });
          expect(posts).toHaveLength(returnToA ? 2 : 1);
          if (settles === "success") expect(queryClient.getQueryData(excerptsQueryKey(ENGAGEMENT_ID))).toEqual([KEPT_EXCERPT]);
          fireEvent.click(screen.getByRole("button", { name: "Keep excerpt" }));
          await waitFor(() => expect(posts).toHaveLength(returnToA ? 3 : 2));
          expect(posts.at(-1)).toMatchObject({ runId: returnToA ? "run-excerpt-1" : "run-excerpt-2", artifactId: returnToA ? "artifact-stdout" : "artifact-b", byteOffset: 9, byteLength: 8 });
        });
      }
    }
  }
});
