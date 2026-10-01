// @vitest-environment jsdom

import type { EngagementSearchResult } from "@stonehush/contracts";
import { findMatchOffset, searchCorpus } from "@stonehush/domain";
import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { createAppRouter } from "../router.js";

const ENGAGEMENT_ID = "10000000-0000-4000-8000-000000000001";
const engagement = {
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
const SAVED_NOTES = "# 𝔸 creds\n𝔹 root\nadmin panel at /𝔸admin\n";
const CONTEXT = `?tab=runs&run=run-1&target=10.0.0.5&sel=svc-1&action=action-1`;

function response(payload: unknown, status = 200): Response {
  return { json: async () => payload, ok: status >= 200 && status < 300, status } as Response;
}

function finding(id: string, title: string) {
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
    createdAt: "2026-08-12T12:00:00.000Z",
    updatedAt: "2026-08-12T12:00:00.000Z",
  };
}

const findings = [
  finding("20000000-0000-4000-8000-000000000001", "Default credentials"),
  finding("20000000-0000-4000-8000-000000000002", "Exposed admin panel"),
  finding("20000000-0000-4000-8000-000000000003", "Verbose errors"),
];

// Note result as the API builds it from the saved text at search time.
function noteResult(markdown: string, query: string): EngagementSearchResult {
  const title = "Engagement notes";
  const match = findMatchOffset(`${title}\n${markdown}`, query);
  const titlePoints = Array.from(title).length;
  const offset = match === null || match.index <= titlePoints ? 0 : match.index - titlePoints - 1;
  const result = searchCorpus(
    [{ kind: "note", id: "notes", title, text: markdown, anchor: `note:notes@${offset}` }],
    query,
  ).results[0];
  if (result === undefined) throw new Error("fixture does not match");
  return result;
}

function findingResult(id: string, title: string): EngagementSearchResult {
  const saved = findings.find((entry) => entry.id === id && entry.title === title);
  if (saved !== undefined) return searchCorpus([{ kind: "finding", id, title, text: saved.body, anchor: `finding:${id}` }], "admin").results[0] ?? { kind: "finding", id, title, snippet: `${title}\n${saved.body}`, anchor: `finding:${id}`, unindexed: false };
  return { kind: "finding", id, title, snippet: `${title}\n...`, anchor: `finding:${id}`, unindexed: false };
}

function searchPayload(query: string, results: readonly EngagementSearchResult[], engagementId = ENGAGEMENT_ID) {
  const kinds = ["target", "hostname", "note", "lead", "finding", "artifact", "excerpt"] as const;
  return {
    engagementId,
    query,
    groups: Object.fromEntries(kinds.map((kind) => [kind, results.filter((result) => result.kind === kind)])),
    unindexedKinds: ["lead", "excerpt"],
  };
}

interface Server {
  notes: (string | Response)[];
  findings: unknown[];
  search: (query: string, signal: AbortSignal | undefined) => Promise<Response>;
  searchCalls: string[];
  puts: number;
}

function stubServer(server: Server) {
  let notesReads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/system/status")) return Promise.resolve(response(readyStatus));
      if (url === "/api/v1/engagements") return Promise.resolve(response([engagement]));
      if (url === `/api/v1/engagements/${ENGAGEMENT_ID}`) {
        return Promise.resolve(response({ engagement, activeScopeRevision: null }));
      }
      const searchMatch = /\/search\?q=(.*)$/.exec(url);
      if (searchMatch !== null) {
        const query = decodeURIComponent(searchMatch[1] ?? "");
        server.searchCalls.push(query);
        return server.search(query, init?.signal ?? undefined);
      }
      if (url.endsWith("/notes")) {
        if (init?.method === "PUT") {
          server.puts += 1;
          return Promise.resolve(response({ code: "storage_busy" }, 503));
        }
        // Successive reads walk the list and then stay on its last entry.
        const markdown = server.notes[Math.min(notesReads, server.notes.length - 1)] ?? "";
        notesReads += 1;
        if (typeof markdown !== "string") return Promise.resolve(markdown);
        return Promise.resolve(
          response({ engagementId: ENGAGEMENT_ID, markdown, updatedAt: "2026-08-12T12:00:00.000Z", revision: 1 }),
        );
      }
      if (url.endsWith("/findings")) return Promise.resolve(response(server.findings));
      return Promise.resolve(response([]));
    }),
  );
}

function server(overrides: Partial<Server> = {}): Server {
  return {
    notes: [SAVED_NOTES],
    findings,
    search: (query) => Promise.resolve(response(searchPayload(query, []))),
    searchCalls: [],
    puts: 0,
    ...overrides,
  };
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

async function openSearch() {
  fireEvent.click(await screen.findByRole("button", { name: "Search notes and findings" }));
  return screen.getByRole("searchbox", { name: "Search notes and findings" }) as HTMLInputElement;
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

describe("search notes and findings", () => {
  it("opens from every tab and returns focus to Search without changing route context", async () => {
    stubServer(server());
    const router = await renderWorkspace(`/engagements/${ENGAGEMENT_ID}${CONTEXT}`);
    const before = router.state.location.search;

    const input = await openSearch();
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Search notes and findings" }));

    await openSearch();
    fireEvent.click(screen.getByRole("button", { name: "Close search" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Search notes and findings" }));
    expect(router.state.location.search).toEqual(before);

    for (const tab of ["surface", "notes", "findings", "leads", "report"]) {
      await router.navigate({ to: "/engagements/$engagementId", params: { engagementId: ENGAGEMENT_ID }, search: { tab } });
      expect(await screen.findByRole("button", { name: "Search notes and findings" })).toBeTruthy();
    }
  });

  it("bounds the query by code points and keeps it through failure and retry", async () => {
    let fail = true;
    const state = server({
      search: (query) =>
        Promise.resolve(fail ? response({ code: "storage_busy" }, 503) : response(searchPayload(query, []))),
    });
    stubServer(state);
    await renderWorkspace(`/engagements/${ENGAGEMENT_ID}?tab=runs`);
    const input = await openSearch();

    fireEvent.change(input, { target: { value: " 𝔸 " } });
    expect(screen.getByText("Type 2 or more characters.")).toBeTruthy();
    fireEvent.change(input, { target: { value: "𝔸".repeat(121) } });
    expect(screen.getByText("Use 120 characters or fewer.")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(state.searchCalls).toEqual([]);

    fireEvent.change(input, { target: { value: "zz" } });
    expect(await screen.findByText("Search failed.")).toBeTruthy();
    fail = false;
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No saved notes or findings match.")).toBeTruthy();
    expect(input.value).toBe("zz");
    expect(state.searchCalls).toEqual(["zz", "zz"]);
  });

  it("rejects a response for another engagement", async () => {
    stubServer(
      server({
        search: (query) =>
          Promise.resolve(
            response(searchPayload(query, [findingResult(findings[0]!.id, "Leaked")], "10000000-0000-4000-8000-000000000009")),
          ),
      }),
    );
    await renderWorkspace(`/engagements/${ENGAGEMENT_ID}?tab=runs`);
    fireEvent.change(await openSearch(), { target: { value: "leak" } });
    expect(await screen.findByText("Search failed.")).toBeTruthy();
    expect(screen.queryByText("Leaked")).toBeNull();
  });

  it("aborts a superseded request and never shows its late response", async () => {
    let releaseOld: (() => void) | undefined;
    let oldSignal: AbortSignal | undefined;
    stubServer(
      server({
        search: (query, signal) => {
          if (query === "ad") {
            oldSignal = signal;
            return new Promise((resolve) => {
              releaseOld = () => resolve(response(searchPayload(query, [findingResult(findings[0]!.id, "Old result")])));
            });
          }
          return Promise.resolve(response(searchPayload(query, [findingResult(findings[1]!.id, "New result")])));
        },
      }),
    );
    await renderWorkspace(`/engagements/${ENGAGEMENT_ID}?tab=runs`);
    const input = await openSearch();
    fireEvent.change(input, { target: { value: "ad" } });
    await waitFor(() => expect(oldSignal).toBeDefined());
    fireEvent.change(input, { target: { value: "adm" } });
    expect(await screen.findByText("New result")).toBeTruthy();
    expect(oldSignal?.aborted).toBe(true);
    releaseOld?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Old result")).toBeNull();
  });

  it("opens the exact saved passage on non-BMP text and keeps route context", async () => {
    stubServer(server({ search: (query) => Promise.resolve(response(searchPayload(query, [noteResult(SAVED_NOTES, query)]))) }));
    const router = await renderWorkspace(`/engagements/${ENGAGEMENT_ID}${CONTEXT}`);
    fireEvent.change(await openSearch(), { target: { value: "admin panel" } });
    fireEvent.click(await screen.findByRole("button", { name: /admin panel at/ }));

    const editor = (await screen.findByLabelText("Markdown")) as HTMLTextAreaElement;
    const start = SAVED_NOTES.indexOf("admin panel");
    await waitFor(() => expect([editor.selectionStart, editor.selectionEnd]).toEqual([start, start + 11]));
    expect(document.activeElement).toBe(editor);
    expect(within(screen.getByRole("status", { name: "Search result" })).getByText("Line 3")).toBeTruthy();
    expect(router.state.location.search).toEqual({
      tab: "notes",
      run: "run-1",
      target: "10.0.0.5",
      sel: "svc-1",
      action: "action-1",
    });
  });

  it("shows the saved passage beside a differing draft and never touches the draft", async () => {
    const state = server({
      search: (query) => Promise.resolve(response(searchPayload(query, [noteResult(SAVED_NOTES, query)]))),
    });
    stubServer(state);
    await renderWorkspace(`/engagements/${ENGAGEMENT_ID}?tab=notes`);
    const editor = (await screen.findByLabelText("Markdown")) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe(SAVED_NOTES));
    fireEvent.change(editor, { target: { value: "my local draft" } });
    editor.setSelectionRange(2, 2);

    fireEvent.change(await openSearch(), { target: { value: "admin panel" } });
    fireEvent.click(await screen.findByRole("button", { name: /admin panel at/ }));

    const notice = await screen.findByRole("status", { name: "Search result" });
    expect(await within(notice).findByText(/saved text, your draft is unchanged/)).toBeTruthy();
    expect(within(notice).getByText("admin panel")).toBeTruthy();
    expect(editor.value).toBe("my local draft");
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([2, 2]);
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(state.puts).toBe(0);

    // Typing the draft back to the saved text never jumps the selection.
    fireEvent.change(editor, { target: { value: SAVED_NOTES } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(editor.selectionStart).toBe(editor.selectionEnd);
  });

  it("opens a saved passage read-only in an archived engagement", async () => {
    const archived = { ...engagement, status: "archived" };
    stubServer(server({ search: (query) => Promise.resolve(response(searchPayload(query, [noteResult(SAVED_NOTES, query)]))) }));
    const fetchMock = vi.mocked(fetch);
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/api/v1/engagements") return Promise.resolve(response([archived]));
      if (url === `/api/v1/engagements/${ENGAGEMENT_ID}`) {
        return Promise.resolve(response({ engagement: archived, activeScopeRevision: null }));
      }
      return base(input, init);
    });
    await renderWorkspace(`/engagements/${ENGAGEMENT_ID}?tab=runs`);
    fireEvent.change(await openSearch(), { target: { value: "admin panel" } });
    fireEvent.click(await screen.findByRole("button", { name: /admin panel at/ }));

    const notice = await screen.findByRole("status", { name: "Search result" });
    expect(await within(notice).findByText(/Line 3/)).toBeTruthy();
    const editor = screen.getByLabelText("Markdown") as HTMLTextAreaElement;
    expect(editor.disabled).toBe(true);
    expect(document.activeElement).toBe(notice);
  });

  it("reports a changed match and searches again with the same query", async () => {
    const edited = SAVED_NOTES.replace("admin panel", "admin login");
    const state = server({
      notes: [edited],
      search: (query) => Promise.resolve(response(searchPayload(query, [noteResult(SAVED_NOTES, query)]))),
    });
    stubServer(state);
    await renderWorkspace(`/engagements/${ENGAGEMENT_ID}?tab=runs`);
    fireEvent.change(await openSearch(), { target: { value: "admin panel" } });
    fireEvent.click(await screen.findByRole("button", { name: /admin panel at/ }));

    expect(await screen.findByText(/Match changed/)).toBeTruthy();
    const editor = screen.getByLabelText("Markdown") as HTMLTextAreaElement;
    expect(editor.value).toBe(edited);
    expect(editor.selectionStart).toBe(editor.selectionEnd);

    fireEvent.click(screen.getByRole("button", { name: "Search again" }));
    const input = screen.getByRole("searchbox", { name: "Search notes and findings" }) as HTMLInputElement;
    expect(input.value).toBe("admin panel");
    await waitFor(() => expect(state.searchCalls).toEqual(["admin panel", "admin panel"]));
  });

  it("focuses the exact finding and reports a missing one as unavailable", async () => {
    const target = findings[1]!;
    const deletedId = "20000000-0000-4000-8000-000000000099";
    stubServer(
      server({
        search: (query) =>
          Promise.resolve(
            response(
              searchPayload(query, [findingResult(target.id, target.title), findingResult(deletedId, "Deleted finding")]),
            ),
          ),
      }),
    );
    await renderWorkspace(`/engagements/${ENGAGEMENT_ID}?tab=runs`);
    fireEvent.change(await openSearch(), { target: { value: "admin" } });
    fireEvent.click(await screen.findByRole("button", { name: /Exposed admin panel/ }));

    await waitFor(() => {
      const row = document.querySelector(`[data-finding-id="${target.id}"]`);
      expect(row?.getAttribute("aria-current")).toBe("true");
      expect(row?.contains(document.activeElement)).toBe(true);
    });
    expect(document.querySelectorAll('[aria-current="true"][data-finding-id]').length).toBe(1);

    fireEvent.change(await openSearch(), { target: { value: "deleted" } });
    fireEvent.click(await screen.findByRole("button", { name: /Deleted finding/ }));
    expect(await screen.findByText(/Finding unavailable/)).toBeTruthy();
    expect(document.querySelector('[aria-current="true"][data-finding-id]')).toBeNull();
  });

  it("refetches results when the dialog reopens", async () => {
    let title = "Old title";
    const state = server({
      search: (query) => Promise.resolve(response(searchPayload(query, [findingResult(findings[0]!.id, title)]))),
    });
    stubServer(state);
    await renderWorkspace(`/engagements/${ENGAGEMENT_ID}?tab=runs`);
    fireEvent.change(await openSearch(), { target: { value: "title" } });
    expect(await screen.findByRole("button", { name: /Old title/ })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    title = "Edited title";
    const input = await openSearch();
    expect(input.value).toBe("title");
    expect(await screen.findByRole("button", { name: /Edited title/ })).toBeTruthy();
    expect(state.searchCalls).toEqual(["title", "title"]);
  });

  it("drops a finding destination when the operator stays with an unsaved draft", async () => {
    const target = findings[1]!;
    stubServer(
      server({ search: (query) => Promise.resolve(response(searchPayload(query, [findingResult(target.id, target.title)]))) }),
    );
    await renderWorkspace(`/engagements/${ENGAGEMENT_ID}?tab=notes`);
    const editor = (await screen.findByLabelText("Markdown")) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe(SAVED_NOTES));
    fireEvent.change(editor, { target: { value: "unsaved" } });

    fireEvent.change(await openSearch(), { target: { value: "admin" } });
    fireEvent.click(await screen.findByRole("button", { name: /Exposed admin panel/ }));
    const guard = await screen.findByRole("alertdialog", { name: "Unsaved notes" });
    fireEvent.click(within(guard).getByRole("button", { name: "Stay" }));
    expect(editor.value).toBe("unsaved");

    fireEvent.click(screen.getByRole("link", { name: "Findings" }));
    fireEvent.click(within(await screen.findByRole("alertdialog", { name: "Unsaved notes" })).getByRole("button", { name: "Leave" }));
    expect(await screen.findByText(target.title)).toBeTruthy();
    expect(document.querySelector('[aria-current="true"][data-finding-id]')).toBeNull();
    expect(screen.queryByRole("status", { name: "Search result" })).toBeNull();
  });

  it.each(["create", "edit"])("protects a %s finding draft when choosing Notes and clears a cancelled destination", async (kind) => {
    stubServer(server({ search: (query) => Promise.resolve(response(searchPayload(query, [noteResult(SAVED_NOTES, query)]))) }));
    await renderWorkspace(`/engagements/${ENGAGEMENT_ID}?tab=findings`);
    await screen.findByText(findings[0]!.title);
    let input: HTMLInputElement;
    if (kind === "edit") {
      fireEvent.click(within(document.querySelector(`[data-finding-id="${findings[0]!.id}"]`) as HTMLElement).getByRole("button", { name: "Edit" }));
      input = document.getElementById(`finding-edit-title-${findings[0]!.id}`) as HTMLInputElement;
    } else input = document.getElementById("finding-title") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "unsaved finding" } });
    fireEvent.change(await openSearch(), { target: { value: "admin panel" } });
    fireEvent.click(await screen.findByRole("button", { name: /admin panel at/ }));
    fireEvent.click(within(await screen.findByRole("alertdialog", { name: "Unsaved finding" })).getByRole("button", { name: "Stay" }));
    expect(input.value).toBe("unsaved finding");
    fireEvent.click(screen.getByRole("link", { name: "Notes" }));
    fireEvent.click(within(await screen.findByRole("alertdialog", { name: "Unsaved finding" })).getByRole("button", { name: "Leave" }));
    await screen.findByLabelText("Markdown");
    expect(screen.queryByRole("status", { name: "Search result" })).toBeNull();
  });

  it("preserves a note draft and its editor on destination read failure", async () => {
    const state = server({ notes: [SAVED_NOTES, response({}, 503)], search: (query) => Promise.resolve(response(searchPayload(query, [noteResult(SAVED_NOTES, query)]))) });
    stubServer(state);
    await renderWorkspace(`/engagements/${ENGAGEMENT_ID}?tab=notes`);
    const editor = await screen.findByLabelText("Markdown") as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe(SAVED_NOTES));
    fireEvent.change(editor, { target: { value: "preserved draft" } });
    fireEvent.change(await openSearch(), { target: { value: "admin panel" } });
    fireEvent.click(await screen.findByRole("button", { name: /admin panel at/ }));
    expect(await screen.findByText("Saved notes could not be loaded.")).toBeTruthy();
    expect(screen.getByLabelText("Markdown")).toBe(editor);
    expect(editor.value).toBe("preserved draft");
    expect(state.puts).toBe(0);
  });

  it.each(["title", "body"])("rejects a finding whose saved %s changed before selection", async (field) => {
    const selected = findingResult(findings[1]!.id, findings[1]!.title);
    const state = server({ findings: findings.map((entry) => entry.id === selected.id ? { ...entry, [field]: "Changed saved text" } : entry), search: (query) => Promise.resolve(response(searchPayload(query, [selected]))) });
    stubServer(state);
    await renderWorkspace(`/engagements/${ENGAGEMENT_ID}?tab=runs`);
    fireEvent.change(await openSearch(), { target: { value: "admin" } });
    fireEvent.click(await screen.findByRole("button", { name: /Exposed admin panel/ }));
    expect(await screen.findByText(/Match changed/)).toBeTruthy();
    expect(document.querySelector('[aria-current="true"][data-finding-id]')).toBeNull();
  });

  it("keeps a same-tab finding edit draft during exact result focus", async () => {
    const target = findings[1]!;
    stubServer(server({ search: (query) => Promise.resolve(response(searchPayload(query, [findingResult(target.id, target.title)]))) }));
    await renderWorkspace(`/engagements/${ENGAGEMENT_ID}?tab=findings`);
    await screen.findByText(target.title);
    const row = document.querySelector(`[data-finding-id="${target.id}"]`) as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    const draft = document.getElementById(`finding-edit-body-${target.id}`) as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "local body" } });
    fireEvent.change(await openSearch(), { target: { value: "admin" } });
    fireEvent.click(await screen.findByRole("button", { name: /Exposed admin panel/ }));
    await waitFor(() => expect(row.contains(document.activeElement)).toBe(true));
    expect(document.getElementById(draft.id)).toBe(draft);
    expect(draft.value).toBe("local body");
  });


  it("rejects a response echoing an older query", async () => {
    stubServer(server({ search: () => Promise.resolve(response(searchPayload("older", [findingResult(findings[0]!.id, "Wrong query")]))) }));
    await renderWorkspace(`/engagements/${ENGAGEMENT_ID}?tab=runs`);
    fireEvent.change(await openSearch(), { target: { value: "current" } });
    expect(await screen.findByText("Search failed.")).toBeTruthy();
    expect(screen.queryByText("Wrong query")).toBeNull();
  });

  it("aborts destination validation when search reopens and ignores its late resolution", async () => {
    stubServer(server({ search: (query) => Promise.resolve(response(searchPayload(query, [noteResult(SAVED_NOTES, query)]))) }));
    await renderWorkspace(`/engagements/${ENGAGEMENT_ID}?tab=notes`);
    const editor = await screen.findByLabelText("Markdown") as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe(SAVED_NOTES));
    const fetchMock = vi.mocked(fetch);
    const base = fetchMock.getMockImplementation()!;
    let release: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation((input, init) => {
      if (String(input).endsWith("/notes")) {
        signal = init?.signal ?? undefined;
        return new Promise((resolve) => { release = () => resolve(response({ engagementId: ENGAGEMENT_ID, markdown: SAVED_NOTES, revision: 1, updatedAt: engagement.updatedAt })); });
      }
      return base(input, init);
    });
    fireEvent.change(await openSearch(), { target: { value: "admin panel" } });
    fireEvent.click(await screen.findByRole("button", { name: /admin panel at/ }));
    await waitFor(() => expect(signal).toBeDefined());
    const input = await openSearch();
    await waitFor(() => expect(signal?.aborted).toBe(true));
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(input);
    expect(screen.queryByRole("status", { name: "Search result" })).toBeNull();
  });


  it("keeps a pending notes save and a newer draft intact during search", async () => {
    const state = server({ search: (query) => Promise.resolve(response(searchPayload(query, [noteResult(SAVED_NOTES, query)]))) });
    stubServer(state);
    const fetchMock = vi.mocked(fetch);
    const base = fetchMock.getMockImplementation()!;
    let finishSave: (() => void) | undefined;
    fetchMock.mockImplementation((input, init) => {
      if (String(input).endsWith("/notes") && init?.method === "PUT") {
        state.puts += 1;
        return new Promise((resolve) => { finishSave = () => resolve(response({ engagementId: ENGAGEMENT_ID, markdown: "save snapshot", revision: 2, updatedAt: engagement.updatedAt })); });
      }
      return base(input, init);
    });
    await renderWorkspace(`/engagements/${ENGAGEMENT_ID}?tab=notes`);
    const editor = await screen.findByLabelText("Markdown") as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe(SAVED_NOTES));
    fireEvent.change(editor, { target: { value: "save snapshot" } });
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
    await waitFor(() => expect(finishSave).toBeDefined());
    fireEvent.change(editor, { target: { value: "newer local draft" } });
    fireEvent.change(await openSearch(), { target: { value: "admin panel" } });
    fireEvent.click(await screen.findByRole("button", { name: /admin panel at/ }));
    expect(await screen.findByText(/saved text, your draft is unchanged/)).toBeTruthy();
    expect(editor.value).toBe("newer local draft");
    expect(state.puts).toBe(1);
    finishSave?.();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save notes" })).toBeTruthy());
    expect(editor.value).toBe("newer local draft");
  });

  it("preserves notes conflict recovery and the revision fence after a failed search read", async () => {
    const fresh = response({ engagementId: ENGAGEMENT_ID, markdown: "server revision two", revision: 2, updatedAt: engagement.updatedAt });
    const state = server({ notes: [SAVED_NOTES, fresh, response({}, 503)], search: (query) => Promise.resolve(response(searchPayload(query, [noteResult(SAVED_NOTES, query)]))) });
    stubServer(state);
    const fetchMock = vi.mocked(fetch);
    const base = fetchMock.getMockImplementation()!;
    const writes: unknown[] = [];
    fetchMock.mockImplementation((input, init) => {
      if (String(input).endsWith("/notes") && init?.method === "PUT") {
        writes.push(JSON.parse(String(init.body)));
        return Promise.resolve(response({ code: "revision_conflict", resourceType: "engagement_notes", resourceId: ENGAGEMENT_ID, currentRevision: 2 }, 409));
      }
      return base(input, init);
    });
    await renderWorkspace(`/engagements/${ENGAGEMENT_ID}?tab=notes`);
    const editor = await screen.findByLabelText("Markdown") as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe(SAVED_NOTES));
    fireEvent.change(editor, { target: { value: "conflicted local draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }));
    const keepMine = await screen.findByRole("button", { name: "Keep mine" });
    fireEvent.change(await openSearch(), { target: { value: "admin panel" } });
    fireEvent.click(await screen.findByRole("button", { name: /admin panel at/ }));
    expect(await screen.findByText("Saved notes could not be loaded.")).toBeTruthy();
    expect(screen.getByLabelText("Markdown")).toBe(editor);
    expect(editor.value).toBe("conflicted local draft");
    expect(screen.getByRole("button", { name: "Keep mine" })).toBe(keepMine);
    expect(writes).toEqual([{ markdown: "conflicted local draft", expectedRevision: 1 }]);
    fireEvent.click(keepMine);
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toEqual({ markdown: "conflicted local draft", expectedRevision: 2 });
  });


  it("preserves a finding edit draft when destination validation fails", async () => {
    const target = findings[1]!;
    stubServer(server({ search: (query) => Promise.resolve(response(searchPayload(query, [findingResult(target.id, target.title)]))) }));
    await renderWorkspace(`/engagements/${ENGAGEMENT_ID}?tab=findings`);
    await screen.findByText(target.title);
    const row = document.querySelector(`[data-finding-id="${target.id}"]`) as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
    const draft = document.getElementById(`finding-edit-body-${target.id}`) as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "preserved edit" } });
    const fetchMock = vi.mocked(fetch);
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) => String(input).endsWith("/findings") ? Promise.resolve(response({}, 503)) : base(input, init));
    fireEvent.change(await openSearch(), { target: { value: "admin" } });
    fireEvent.click(await screen.findByRole("button", { name: /Exposed admin panel/ }));
    expect(await screen.findByText("Saved findings could not be loaded.")).toBeTruthy();
    expect(document.getElementById(draft.id)).toBe(draft);
    expect(draft.value).toBe("preserved edit");
    expect(document.querySelector('[aria-current="true"][data-finding-id]')).toBeNull();
  });

});
