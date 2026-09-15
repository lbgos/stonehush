// @vitest-environment jsdom

import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

function notesLeakInStorage(snippets: readonly string[]): string | null {
  const storages = [window.localStorage, window.sessionStorage];
  for (const storage of storages) {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key === null) continue;
      const lowered = key.toLowerCase();
      if (lowered.includes("note") || lowered.includes("draft") || lowered.includes("markdown")) {
        return `storage key ${key}`;
      }
      const value = storage.getItem(key) ?? "";
      for (const snippet of snippets) {
        if (snippet !== "" && value.includes(snippet)) {
          return `storage key ${key} contains note content`;
        }
      }
    }
  }
  return null;
}

const testQueryClients = new Set<QueryClient>();

async function renderWorkspace(initialEntry: string) {
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
  return { ...view, router };
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

describe("engagement notes", () => {
  it("loads an empty scratchpad, tracks dirt, and saves explicitly", async () => {
    let stored = "";
    let storedRevision = 0;
    const puts: unknown[] = [];
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
        if (url.endsWith("/notes") && (init?.method === undefined || init.method === "GET")) {
          return Promise.resolve(
            response({
              engagementId: activeEngagement.id,
              markdown: stored,
              updatedAt: "2026-08-12T12:00:00.000Z",
              revision: storedRevision,
            }),
          );
        }
        if (url.endsWith("/notes") && init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as {
            markdown: string;
            expectedRevision: number;
          };
          puts.push(body);
          stored = body.markdown;
          storedRevision = body.expectedRevision + 1;
          return Promise.resolve(
            response({
              engagementId: activeEngagement.id,
              markdown: stored,
              updatedAt: "2026-08-12T12:01:00.000Z",
              revision: storedRevision,
            }),
          );
        }
        return Promise.resolve(response([]));
      }),
    );

    await renderWorkspace(`/engagements/${activeEngagement.id}?tab=notes`);

    const editor = (await screen.findByLabelText("Markdown")) as HTMLTextAreaElement;
    expect(editor.value).toBe("");
    const save = screen.getByRole("button", { name: "Save notes" });
    expect(save.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Saved")).toBeTruthy();

    fireEvent.change(editor, { target: { value: "# creds\nadmin / secret" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(save.hasAttribute("disabled")).toBe(false);

    fireEvent.click(save);
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    expect(puts).toEqual([{ markdown: "# creds\nadmin / secret", expectedRevision: 0 }]);
    expect((screen.getByLabelText("Markdown") as HTMLTextAreaElement).value).toBe(
      "# creds\nadmin / secret",
    );
  });

  it("shows a truthful error when saving fails", async () => {
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
          if (init?.method === "PUT") {
            return Promise.resolve(response({ code: "storage_busy" }, 503));
          }
          return Promise.resolve(
            response({
              engagementId: activeEngagement.id,
              markdown: "",
              updatedAt: "2026-08-12T12:00:00.000Z",
              revision: 0,
            }),
          );
        }
        return Promise.resolve(response([]));
      }),
    );

    await renderWorkspace(`/engagements/${activeEngagement.id}?tab=notes`);

    const editor = await screen.findByLabelText("Markdown");
    fireEvent.change(editor, { target: { value: "# observations" } });
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));

    expect(await screen.findByText("Storage is busy. Try again.")).toBeTruthy();
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });

  it("blocks in-app navigation when dirty; Stay preserves draft and Leave proceeds", async () => {
    const puts: unknown[] = [];
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
        if (url.endsWith("/notes") && (init?.method === undefined || init.method === "GET")) {
          return Promise.resolve(
            response({
              engagementId: activeEngagement.id,
              markdown: "",
              updatedAt: "2026-08-12T12:00:00.000Z",
              revision: 0,
            }),
          );
        }
        if (url.endsWith("/notes") && init?.method === "PUT") {
          puts.push(JSON.parse(String(init.body)));
          return Promise.resolve(
            response({
              engagementId: activeEngagement.id,
              markdown: "# draft",
              updatedAt: "2026-08-12T12:01:00.000Z",
              revision: 1,
            }),
          );
        }
        return Promise.resolve(response([]));
      }),
    );

    const { router } = await renderWorkspace(`/engagements/${activeEngagement.id}?tab=notes`);
    const editor = (await screen.findByLabelText("Markdown")) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "# draft" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    void router.navigate({ to: "/engagements" });
    const dialog = await screen.findByRole("alertdialog", { name: "Unsaved notes" });
    expect(router.state.location.pathname).toBe(`/engagements/${activeEngagement.id}`);

    fireEvent.click(within(dialog).getByRole("button", { name: "Stay" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(router.state.location.pathname).toBe(`/engagements/${activeEngagement.id}`);
    expect((screen.getByLabelText("Markdown") as HTMLTextAreaElement).value).toBe("# draft");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(puts).toEqual([]);
    expect(notesLeakInStorage(["# draft"])).toBeNull();

    void router.navigate({ to: "/engagements" });
    const releave = await screen.findByRole("alertdialog", { name: "Unsaved notes" });
    fireEvent.click(within(releave).getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/engagements"));
    expect(puts).toEqual([]);
  });

  it("does not block navigation when clean", async () => {
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
        return Promise.resolve(response([]));
      }),
    );

    const { router } = await renderWorkspace(`/engagements/${activeEngagement.id}?tab=notes`);
    await screen.findByLabelText("Markdown");
    expect(screen.getByText("Saved")).toBeTruthy();

    await router.navigate({ to: "/engagements" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/engagements"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("allows navigation after saving and after reverting to saved", async () => {
    let stored = "";
    let storedRevision = 0;
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
        if (url.endsWith("/notes") && (init?.method === undefined || init.method === "GET")) {
          return Promise.resolve(
            response({
              engagementId: activeEngagement.id,
              markdown: stored,
              updatedAt: "2026-08-12T12:00:00.000Z",
              revision: storedRevision,
            }),
          );
        }
        if (url.endsWith("/notes") && init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as {
            markdown: string;
            expectedRevision: number;
          };
          stored = body.markdown;
          storedRevision = body.expectedRevision + 1;
          return Promise.resolve(
            response({
              engagementId: activeEngagement.id,
              markdown: stored,
              updatedAt: "2026-08-12T12:01:00.000Z",
              revision: storedRevision,
            }),
          );
        }
        return Promise.resolve(response([]));
      }),
    );

    const { router } = await renderWorkspace(`/engagements/${activeEngagement.id}?tab=notes`);
    const editor = (await screen.findByLabelText("Markdown")) as HTMLTextAreaElement;

    fireEvent.change(editor, { target: { value: "# temp" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.change(editor, { target: { value: "" } });
    expect(screen.getByText("Saved")).toBeTruthy();
    await router.navigate({ to: "/engagements" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/engagements"));
    expect(screen.queryByRole("alertdialog")).toBeNull();

    await router.navigate({
      to: "/engagements/$engagementId",
      params: { engagementId: activeEngagement.id },
      search: { tab: "notes" },
    });
    const backEditor = (await screen.findByLabelText("Markdown")) as HTMLTextAreaElement;
    fireEvent.change(backEditor, { target: { value: "# final" } });
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    await router.navigate({ to: "/engagements" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/engagements"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("does not transplant a dirty draft when switching engagement", async () => {
    const secondEngagement = { ...activeEngagement, id: "10000000-0000-4000-8000-000000000002", name: "Second lab" };
    const stored: Record<string, string> = { [activeEngagement.id]: "", [secondEngagement.id]: "saved second" };
    const revisions: Record<string, number> = { [activeEngagement.id]: 0, [secondEngagement.id]: 1 };
    const puts: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/system/status")) return Promise.resolve(response(readyStatus));
        if (url === "/api/v1/engagements") {
          return Promise.resolve(response([activeEngagement, secondEngagement]));
        }
        if (url === `/api/v1/engagements/${activeEngagement.id}`) {
          return Promise.resolve(
            response({ engagement: activeEngagement, activeScopeRevision: null }),
          );
        }
        if (url === `/api/v1/engagements/${secondEngagement.id}`) {
          return Promise.resolve(
            response({ engagement: secondEngagement, activeScopeRevision: null }),
          );
        }
        if (url.endsWith("/services")) return Promise.resolve(response([]));
        const notesMatch = /^\/api\/v1\/engagements\/([^/]+)\/notes$/.exec(url);
        if (notesMatch?.[1] !== undefined) {
          const id = notesMatch[1];
          if (init?.method === "PUT") {
            puts.push(JSON.parse(String(init.body)));
            stored[id] = (JSON.parse(String(init.body)) as { markdown: string }).markdown;
          }
          return Promise.resolve(
            response({
              engagementId: id,
              markdown: stored[id] ?? "",
              updatedAt: "2026-08-12T12:00:00.000Z",
              revision: revisions[id] ?? 0,
            }),
          );
        }
        return Promise.resolve(response([]));
      }),
    );

    const { router } = await renderWorkspace(`/engagements/${activeEngagement.id}?tab=notes`);
    const editor = (await screen.findByLabelText("Markdown")) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "# first draft" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    void router.navigate({
      to: "/engagements/$engagementId",
      params: { engagementId: secondEngagement.id },
      search: { tab: "notes" },
    });
    const dialog = await screen.findByRole("alertdialog", { name: "Unsaved notes" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Leave" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/engagements/${secondEngagement.id}`),
    );

    const secondEditor = (await screen.findByLabelText("Markdown")) as HTMLTextAreaElement;
    expect(secondEditor.value).toBe("saved second");
    expect(puts).toEqual([]);
  });

  it("preserves newer edits made during save and stays dirty", async () => {
    let resolvePut: (() => void) | undefined;
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
        if (url.endsWith("/notes") && (init?.method === undefined || init.method === "GET")) {
          return Promise.resolve(
            response({
              engagementId: activeEngagement.id,
              markdown: "",
              updatedAt: "2026-08-12T12:00:00.000Z",
              revision: 0,
            }),
          );
        }
        if (url.endsWith("/notes") && init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as {
            markdown: string;
            expectedRevision: number;
          };
          return new Promise<Response>((resolve) => {
            resolvePut = () =>
              resolve(
                response({
                  engagementId: activeEngagement.id,
                  markdown: body.markdown,
                  updatedAt: "2026-08-12T12:01:00.000Z",
                  revision: body.expectedRevision + 1,
                }),
              );
          });
        }
        return Promise.resolve(response([]));
      }),
    );

    await renderWorkspace(`/engagements/${activeEngagement.id}?tab=notes`);
    const editor = (await screen.findByLabelText("Markdown")) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "first" } });
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
    expect(await screen.findByRole("button", { name: "Saving" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Markdown"), { target: { value: "second" } });
    expect(resolvePut).toBeDefined();
    resolvePut?.();
    await waitFor(() => expect(screen.getByText("Unsaved changes")).toBeTruthy());
    expect((screen.getByLabelText("Markdown") as HTMLTextAreaElement).value).toBe("second");
  });

  it("preserves a stale draft on 409 and recovers via explicit actions", async () => {
    let stored = "# server v1";
    let storedRevision = 1;
    const puts: { markdown: string; expectedRevision: number }[] = [];
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
        if (url.endsWith("/notes") && (init?.method === undefined || init.method === "GET")) {
          return Promise.resolve(
            response({
              engagementId: activeEngagement.id,
              markdown: stored,
              updatedAt: "2026-08-12T12:00:00.000Z",
              revision: storedRevision,
            }),
          );
        }
        if (url.endsWith("/notes") && init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as {
            markdown: string;
            expectedRevision: number;
          };
          puts.push(body);
          if (body.expectedRevision !== storedRevision) {
            return Promise.resolve(
              response(
                {
                  code: "revision_conflict",
                  resourceType: "engagement_notes",
                  resourceId: activeEngagement.id,
                  currentRevision: storedRevision,
                },
                409,
              ),
            );
          }
          stored = body.markdown;
          storedRevision += 1;
          return Promise.resolve(
            response({
              engagementId: activeEngagement.id,
              markdown: stored,
              updatedAt: "2026-08-12T12:01:00.000Z",
              revision: storedRevision,
            }),
          );
        }
        return Promise.resolve(response([]));
      }),
    );

    // Simulate the other tab winning before this tab loads its base.
    stored = "# other tab";
    storedRevision = 2;
    await renderWorkspace(`/engagements/${activeEngagement.id}?tab=notes`);
    const editor = (await screen.findByLabelText("Markdown")) as HTMLTextAreaElement;
    expect(editor.value).toBe("# other tab");

    // Make the server advance again so this tab's base goes stale.
    stored = "# newer server";
    storedRevision = 3;
    fireEvent.change(editor, { target: { value: "# my draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));

    expect(await screen.findByText("Notes changed elsewhere")).toBeTruthy();
    expect((screen.getByLabelText("Markdown") as HTMLTextAreaElement).value).toBe("# my draft");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(puts).toEqual([{ markdown: "# my draft", expectedRevision: 2 }]);

    fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    expect((screen.getByLabelText("Markdown") as HTMLTextAreaElement).value).toBe("# my draft");
    expect(puts).toEqual([
      { markdown: "# my draft", expectedRevision: 2 },
      { markdown: "# my draft", expectedRevision: 3 },
    ]);
    expect(notesLeakInStorage(["# my draft"])).toBeNull();
  });

  it("load server version clears dirty and saves next edit at the fresh revision", async () => {
    let stored = "# base";
    let storedRevision = 1;
    const puts: { markdown: string; expectedRevision: number }[] = [];
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
        if (url.endsWith("/notes") && (init?.method === undefined || init.method === "GET")) {
          return Promise.resolve(
            response({
              engagementId: activeEngagement.id,
              markdown: stored,
              updatedAt: "2026-08-12T12:00:00.000Z",
              revision: storedRevision,
            }),
          );
        }
        if (url.endsWith("/notes") && init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as {
            markdown: string;
            expectedRevision: number;
          };
          puts.push(body);
          if (body.expectedRevision !== storedRevision) {
            return Promise.resolve(
              response(
                {
                  code: "revision_conflict",
                  resourceType: "engagement_notes",
                  resourceId: activeEngagement.id,
                  currentRevision: storedRevision,
                },
                409,
              ),
            );
          }
          stored = body.markdown;
          storedRevision += 1;
          return Promise.resolve(
            response({
              engagementId: activeEngagement.id,
              markdown: stored,
              updatedAt: "2026-08-12T12:01:00.000Z",
              revision: storedRevision,
            }),
          );
        }
        return Promise.resolve(response([]));
      }),
    );

    await renderWorkspace(`/engagements/${activeEngagement.id}?tab=notes`);
    const editor = (await screen.findByLabelText("Markdown")) as HTMLTextAreaElement;
    expect(editor.value).toBe("# base");

    stored = "# server wins";
    storedRevision = 2;
    fireEvent.change(editor, { target: { value: "# mine" } });
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
    expect(await screen.findByText("Notes changed elsewhere")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Load server version" }));
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    expect((screen.getByLabelText("Markdown") as HTMLTextAreaElement).value).toBe("# server wins");
    expect(screen.getByRole("button", { name: "Save notes" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText("Notes changed elsewhere")).toBeNull();

    fireEvent.change(screen.getByLabelText("Markdown"), { target: { value: "# next" } });
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    expect(puts).toEqual([
      { markdown: "# mine", expectedRevision: 1 },
      { markdown: "# next", expectedRevision: 2 },
    ]);
  });

  it("keeps the draft when recovery GET fails and retries", async () => {
    let getCalls = 0;
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
        if (url.endsWith("/notes") && (init?.method === undefined || init.method === "GET")) {
          getCalls += 1;
          if (getCalls === 1) {
            return Promise.resolve(
              response({
                engagementId: activeEngagement.id,
                markdown: "",
                updatedAt: "2026-08-12T12:00:00.000Z",
                revision: 0,
              }),
            );
          }
          return Promise.resolve(response({ code: "storage_busy" }, 503));
        }
        if (url.endsWith("/notes") && init?.method === "PUT") {
          return Promise.resolve(
            response(
              {
                code: "revision_conflict",
                resourceType: "engagement_notes",
                resourceId: activeEngagement.id,
                currentRevision: 2,
              },
              409,
            ),
          );
        }
        return Promise.resolve(response([]));
      }),
    );

    await renderWorkspace(`/engagements/${activeEngagement.id}?tab=notes`);
    const editor = (await screen.findByLabelText("Markdown")) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "# local" } });
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));

    expect(await screen.findByText("Could not load the server version. Your edits are kept.")).toBeTruthy();
    expect((screen.getByLabelText("Markdown") as HTMLTextAreaElement).value).toBe("# local");
    expect(screen.queryByRole("button", { name: "Keep mine" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry loading server" }));
    await waitFor(() =>
      expect(screen.getByText("Could not load the server version. Your edits are kept.")).toBeTruthy(),
    );
    expect((screen.getByLabelText("Markdown") as HTMLTextAreaElement).value).toBe("# local");
  });

  it("does not upgrade the base on background refetch while dirty", async () => {
    let stored = "";
    let storedRevision = 0;
    let allowRefetch = false;
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
        if (url.endsWith("/notes") && (init?.method === undefined || init.method === "GET")) {
          if (allowRefetch) {
            return Promise.resolve(
              response({
                engagementId: activeEngagement.id,
                markdown: "# other tab",
                updatedAt: "2026-08-12T12:02:00.000Z",
                revision: 2,
              }),
            );
          }
          return Promise.resolve(
            response({
              engagementId: activeEngagement.id,
              markdown: stored,
              updatedAt: "2026-08-12T12:00:00.000Z",
              revision: storedRevision,
            }),
          );
        }
        if (url.endsWith("/notes") && init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as {
            markdown: string;
            expectedRevision: number;
          };
          if (allowRefetch || body.expectedRevision !== storedRevision) {
            return Promise.resolve(
              response(
                {
                  code: "revision_conflict",
                  resourceType: "engagement_notes",
                  resourceId: activeEngagement.id,
                  currentRevision: 2,
                },
                409,
              ),
            );
          }
          stored = body.markdown;
          storedRevision = body.expectedRevision + 1;
          return Promise.resolve(
            response({
              engagementId: activeEngagement.id,
              markdown: stored,
              updatedAt: "2026-08-12T12:01:00.000Z",
              revision: storedRevision,
            }),
          );
        }
        return Promise.resolve(response([]));
      }),
    );

    await renderWorkspace(`/engagements/${activeEngagement.id}?tab=notes`);
    const editor = (await screen.findByLabelText("Markdown")) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "# mine" } });
    allowRefetch = true;
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
    expect(await screen.findByText("Notes changed elsewhere")).toBeTruthy();
    expect((screen.getByLabelText("Markdown") as HTMLTextAreaElement).value).toBe("# mine");
  });
});
