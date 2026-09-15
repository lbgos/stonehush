// @vitest-environment jsdom

import {
  PersistedActionSchema,
  canonicalizeJson,
  type PersistedAction,
} from "@stonehush/contracts";
import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { CreateEngagementDialog } from "./create-dialog.js";
import { EngagementWorkspaceProvider, useEngagementWorkspace } from "./workspace-context.js";

const ENGAGEMENT_ID = "10000000-0000-4000-8000-000000000001";
const ACTION_ID = "40000000-0000-4000-8000-000000000001";
const SNAPSHOT_ID = "40000000-0000-4000-8000-000000000002";
const BINDING = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SCOPE_ID = "20000000-0000-4000-8000-000000000010";

const ipv4Target = {
  kind: "ip" as const,
  normalizationProfile: "d1-v1" as const,
  family: 4 as const,
  address: "192.0.2.10",
  zone: null,
};

function queuedAction(): PersistedAction {
  return PersistedActionSchema.parse({
    contractVersion: 1,
    engagementId: ENGAGEMENT_ID,
    revision: 1,
    warningAcknowledgmentId: null,
    createdAt: "2026-08-12T12:10:00.000Z",
    updatedAt: "2026-08-12T12:10:00.000Z",
    action: {
      orchestrationProfile: "d2-v1",
      actionId: ACTION_ID,
      state: "queued",
      snapshots: [
        {
          normalizationProfile: "d1-v1",
          orchestrationProfile: "d2-v1",
          snapshotId: SNAPSHOT_ID,
          version: 1,
          binding: BINDING,
          actionId: ACTION_ID,
          canonicalTargets: [ipv4Target],
          concreteDestinations: [ipv4Target],
          typedOptions: { declaredPorts: null },
          resolutionSnapshots: [],
          scopeRevisionId: null,
          warningState: { reasonCodes: [], knownAdditions: [], acknowledgment: null },
        },
      ],
      queuedSnapshotVersion: 1,
      warningAcknowledgment: null,
      pendingWarning: null,
      coveredDestinations: [],
      warningInteractions: 0,
      runState: null,
      resumeRequested: false,
      cleanupRequired: false,
      capabilityErrorCode: null,
    },
  });
}

function createdEngagement(name: string) {
  return {
    contractVersion: 1,
    id: ENGAGEMENT_ID,
    revision: 1,
    name,
    kind: "ctf",
    status: "active",
    description: null,
    authorizationContext: null,
    autoContinueWarnings: false,
    activeScopeRevisionId: null,
    deadlineAt: null,
    createdAt: "2026-08-12T12:00:00.000Z",
    updatedAt: "2026-08-12T12:00:00.000Z",
  };
}

function response(payload: unknown, status = 200): Response {
  return {
    json: async () => payload,
    ok: status >= 200 && status < 300,
    status,
  } as Response;
}

function NoticeProbe() {
  const { notice } = useEngagementWorkspace();
  return <p data-testid="notice-probe">{notice ?? ""}</p>;
}

function DialogHarness() {
  const [open, setOpen] = useState(true);
  return (
    <EngagementWorkspaceProvider openCreate={() => {}}>
      <NoticeProbe />
      <CreateEngagementDialog open={open} onOpenChange={setOpen} />
      <button type="button" onClick={() => setOpen(false)}>
        close-for-test
      </button>
      <button type="button" onClick={() => setOpen(true)}>
        open-for-test
      </button>
    </EngagementWorkspaceProvider>
  );
}

const testQueryClients = new Set<QueryClient>();

async function renderDialog() {
  const rootRoute = createRootRoute({ component: DialogHarness });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute,
  });
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
  return { queryClient, router };
}

function submitStart() {
  const form = screen.getByRole("button", { name: "Start engagement" }).closest("form");
  if (!form) throw new Error("Start engagement form is missing.");
  fireEvent.submit(form);
}

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    return Promise.resolve(handler(String(input), init));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function engagementHandler(name: string) {
  return (url: string, init?: RequestInit) => {
    if (url === "/api/v1/engagements" && init?.method === "POST") {
      return response(createdEngagement(name), 201);
    }
    if (url === `/api/v1/engagements/${ENGAGEMENT_ID}/actions` && init?.method === "POST") {
      return response(queuedAction(), 201);
    }
    if (
      url === `/api/v1/engagements/${ENGAGEMENT_ID}/scope-revisions` &&
      init?.method === "POST"
    ) {
      const body = JSON.parse(String(init.body)) as { rules: unknown[] };
      return response(
        {
          contractVersion: 1,
          id: SCOPE_ID,
          engagementId: ENGAGEMENT_ID,
          version: 1,
          rules: body.rules,
          createdAt: "2026-08-12T12:06:00.000Z",
        },
        201,
      );
    }
    if (url === `/api/v1/engagements/${ENGAGEMENT_ID}/notes` && init?.method !== "PUT") {
      return response({
        engagementId: ENGAGEMENT_ID,
        markdown: "",
        updatedAt: "2026-08-12T12:00:00.000Z",
        revision: 0,
      });
    }
    if (url === `/api/v1/engagements/${ENGAGEMENT_ID}/notes` && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { markdown: string };
      return response({
        engagementId: ENGAGEMENT_ID,
        markdown: body.markdown,
        updatedAt: "2026-08-12T12:01:00.000Z",
        revision: 1,
      });
    }
    return response({ code: "invalid_request" }, 400);
  };
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

describe("CreateEngagementDialog start", () => {
  it("creates an engagement with a suggested name and queues the first scan", async () => {
    const fetchMock = stubFetch(engagementHandler("Lab 192-0-2-10"));
    const { queryClient, router } = await renderDialog();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    fireEvent.change(screen.getByLabelText(/Targets/), { target: { value: "192.0.2.10" } });
    expect(await screen.findByText("Suggested name: Lab 192-0-2-10")).toBeTruthy();
    submitStart();

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/engagements/${ENGAGEMENT_ID}`),
    );
    const createCall = fetchMock.mock.calls.find(([url]) => url === "/api/v1/engagements");
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({
      name: "Lab 192-0-2-10",
      kind: "ctf",
    });
    const actionCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/actions"),
    );
    expect(JSON.parse(String(actionCall?.[1]?.body))).toMatchObject({
      expectedEngagementRevision: 1,
      expectedActiveScopeRevisionId: null,
      targets: ["192.0.2.10"],
      declaredPorts: null,
    });
    expect(window.localStorage.getItem("stonehush.lastEngagementId")).toBe(ENGAGEMENT_ID);
    // The readiness summary reads run history, so the start refreshes it.
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["engagements", ENGAGEMENT_ID, "runs"],
    });
  });

  it("accepts hostnames, URLs, and pasted lists", async () => {
    const fetchMock = stubFetch(engagementHandler("Lab target-host-test"));
    await renderDialog();

    fireEvent.change(screen.getByLabelText(/Targets/), {
      target: { value: "target-host.test, https://web.test/" },
    });
    submitStart();

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).endsWith("/actions")),
      ).toBe(true),
    );
    const actionCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/actions"));
    expect(JSON.parse(String(actionCall?.[1]?.body)).targets).toEqual([
      "target-host.test",
      "https://web.test/",
    ]);
  });

  it("saves targets as scope when checked", async () => {
    const fetchMock = stubFetch(engagementHandler("Lab 192-0-2-10"));
    const { router } = await renderDialog();

    fireEvent.change(screen.getByLabelText(/Targets/), { target: { value: "192.0.2.10" } });
    fireEvent.click(screen.getByLabelText("Also save these targets as scope"));
    submitStart();

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/engagements/${ENGAGEMENT_ID}`),
    );
    const scopeCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/scope-revisions"));
    expect(scopeCall).toBeTruthy();
    const actionCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/actions"));
    expect(JSON.parse(String(actionCall?.[1]?.body))).toMatchObject({
      expectedEngagementRevision: 2,
      expectedActiveScopeRevisionId: SCOPE_ID,
    });
  });

  it("starts a challenge file without inventing a target", async () => {
    const fetchMock = stubFetch(engagementHandler("Lab brief"));
    const { router } = await renderDialog();

    const file = new File(["find the flag"], "brief.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText(/Challenge file/), { target: { files: [file] } });
    expect(await screen.findByText("brief.txt")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "Lab brief" } });
    submitStart();

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/engagements/${ENGAGEMENT_ID}`),
    );
    expect(router.state.location.search).toMatchObject({ tab: "notes" });
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith("/actions")),
    ).toBe(false);
    const notesCall = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith("/notes") && init?.method === "PUT",
    );
    expect(notesCall).toBeTruthy();
    expect(String(notesCall?.[1]?.body)).toContain("find the flag");
  });

  it("saves challenge notes when targets and a file are combined", async () => {
    const fetchMock = stubFetch(engagementHandler("Lab brief"));
    const { router } = await renderDialog();

    const file = new File(["find the flag"], "brief.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText(/Challenge file/), { target: { files: [file] } });
    expect(await screen.findByText("brief.txt")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "Lab brief" } });
    fireEvent.change(screen.getByLabelText(/Targets/), { target: { value: "192.0.2.10" } });
    submitStart();

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/engagements/${ENGAGEMENT_ID}`),
    );
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => String(url).endsWith("/actions") && init?.method === "POST",
      ),
    ).toBe(true);
    const notesCall = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith("/notes") && init?.method === "PUT",
    );
    expect(notesCall).toBeTruthy();
    expect(String(notesCall?.[1]?.body)).toContain("find the flag");
  });

  it("announces when challenge notes cannot be saved", async () => {
    const fallback = engagementHandler("Lab brief");
    stubFetch((url, init) => {
      if (String(url).endsWith("/notes") && init?.method === "PUT") {
        return response({ code: "storage_busy" }, 503);
      }
      return fallback(url, init);
    });
    const { router } = await renderDialog();

    const file = new File(["find the flag"], "brief.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText(/Challenge file/), { target: { files: [file] } });
    expect(await screen.findByText("brief.txt")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "Lab brief" } });
    submitStart();

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/engagements/${ENGAGEMENT_ID}`),
    );
    expect(router.state.location.search).toMatchObject({ tab: "notes" });
    expect(screen.getByTestId("notice-probe").textContent).toContain("were not saved");
  });

  it("rejects an invalid platform URL and an empty start", async () => {
    const fetchMock = stubFetch(engagementHandler("Lab 192-0-2-10"));
    await renderDialog();

    submitStart();
    expect(
      await screen.findByText("Enter at least one target or attach a challenge file."),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Targets/), { target: { value: "192.0.2.10" } });
    fireEvent.change(screen.getByLabelText(/Platform URL/), { target: { value: "not a url" } });
    submitStart();
    expect(await screen.findByText(/Enter a valid URL/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not restore previous targets when reopened", async () => {
    stubFetch(engagementHandler("Lab 192-0-2-10"));
    await renderDialog();

    const targets = screen.getByLabelText(/Targets/) as HTMLTextAreaElement;
    fireEvent.change(targets, { target: { value: "192.0.2.10" } });
    expect(targets.value).toBe("192.0.2.10");
    fireEvent.click(screen.getByRole("button", { name: "close-for-test" }));
    fireEvent.click(screen.getByRole("button", { name: "open-for-test" }));

    expect((screen.getByLabelText(/Targets/) as HTMLTextAreaElement).value).toBe("");
  });

  it("ignores a stale file read when a newer file was picked", async () => {
    stubFetch(engagementHandler("Lab brief"));
    await renderDialog();

    const resolvers: Array<(text: string) => void> = [];
    vi.spyOn(File.prototype, "text").mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    fireEvent.change(screen.getByLabelText(/Challenge file/), {
      target: { files: [new File(["first content"], "a.txt", { type: "text/plain" })] },
    });
    fireEvent.change(screen.getByLabelText(/Challenge file/), {
      target: { files: [new File(["second content"], "b.txt", { type: "text/plain" })] },
    });
    expect(resolvers).toHaveLength(2);
    resolvers[1]!("second content");
    expect(await screen.findByText("b.txt")).toBeTruthy();
    // The earlier read finishes last; it must not replace the attachment.
    resolvers[0]!("first content");
    await waitFor(() => expect(screen.queryByText("a.txt")).toBeNull());
    expect(screen.getByText("b.txt")).toBeTruthy();
  });

  it("drops a pending file read when the dialog is closed and reopened", async () => {
    stubFetch(engagementHandler("Lab brief"));
    await renderDialog();

    let resolveRead!: (text: string) => void;
    vi.spyOn(File.prototype, "text").mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        }),
    );

    fireEvent.change(screen.getByLabelText(/Challenge file/), {
      target: { files: [new File(["late content"], "a.txt", { type: "text/plain" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: "close-for-test" }));
    resolveRead("late content");
    fireEvent.click(screen.getByRole("button", { name: "open-for-test" }));

    expect(await screen.findByRole("dialog", { name: "Start an engagement" })).toBeTruthy();
    expect(screen.queryByText("a.txt")).toBeNull();
  });

  it("blocks submit while a replacement file read is pending", async () => {
    const fetchMock = stubFetch(engagementHandler("Lab brief"));
    const { router } = await renderDialog();

    const resolvers: Array<(text: string) => void> = [];
    vi.spyOn(File.prototype, "text").mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    fireEvent.change(screen.getByLabelText(/Challenge file/), {
      target: { files: [new File(["first content"], "a.txt", { type: "text/plain" })] },
    });
    resolvers[0]!("first content");
    expect(await screen.findByText("a.txt")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "Lab brief" } });

    // Pick a replacement and submit before its read settles. The previously
    // loaded draft must not be persisted under the new pick.
    fireEvent.change(screen.getByLabelText(/Challenge file/), {
      target: { files: [new File(["second content"], "b.txt", { type: "text/plain" })] },
    });
    expect(await screen.findByText("Reading file…")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Start engagement" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    submitStart();
    expect(
      await screen.findByText("Still reading the challenge file. Wait a moment and try again."),
    ).toBeTruthy();
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => url === "/api/v1/engagements" && init?.method === "POST",
      ),
    ).toHaveLength(0);

    // Once the replacement resolves, retry persists the new file, not the old one.
    resolvers[1]!("second content");
    expect(await screen.findByText("b.txt")).toBeTruthy();
    submitStart();
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/engagements/${ENGAGEMENT_ID}`),
    );
    const notesCall = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith("/notes") && init?.method === "PUT",
    );
    expect(notesCall).toBeTruthy();
    expect(String(notesCall?.[1]?.body)).toContain("second content");
    expect(String(notesCall?.[1]?.body)).not.toContain("first content");
  });

  it("retries the scan on the same engagement instead of creating a second one", async () => {
    const fallback = engagementHandler("Lab 192-0-2-10");
    let actionCalls = 0;
    const fetchMock = stubFetch((url, init) => {
      if (url === `/api/v1/engagements/${ENGAGEMENT_ID}/actions` && init?.method === "POST") {
        actionCalls += 1;
        if (actionCalls === 1) return response({ code: "storage_busy" }, 503);
      }
      return fallback(url, init);
    });
    const { router } = await renderDialog();

    fireEvent.change(screen.getByLabelText(/Targets/), { target: { value: "192.0.2.10" } });
    submitStart();

    expect(await screen.findByText("Storage is busy. Try again.")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/");
    submitStart();

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/engagements/${ENGAGEMENT_ID}`),
    );
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => url === "/api/v1/engagements" && init?.method === "POST",
      ),
    ).toHaveLength(1);
    expect(actionCalls).toBe(2);
  });

  it("reuses the action key when the action response is lost after commit", async () => {
    const fallback = engagementHandler("Lab 192-0-2-10");
    const committed = new Map<string, unknown>();
    let actionCommits = 0;
    let loseFirst = true;
    const fetchMock = stubFetch((url, init) => {
      if (url === `/api/v1/engagements/${ENGAGEMENT_ID}/actions` && init?.method === "POST") {
        const key = String((init?.headers as Record<string, string>)["Idempotency-Key"]);
        if (committed.has(key)) return response(committed.get(key), 201);
        committed.set(key, queuedAction());
        actionCommits += 1;
        if (loseFirst) {
          loseFirst = false;
          throw new Error("offline");
        }
        return response(queuedAction(), 201);
      }
      return fallback(url, init);
    });
    const { router } = await renderDialog();

    fireEvent.change(screen.getByLabelText(/Targets/), { target: { value: "192.0.2.10" } });
    submitStart();

    expect(await screen.findByText("The engagement request failed.")).toBeTruthy();
    submitStart();

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/engagements/${ENGAGEMENT_ID}`),
    );
    expect(actionCommits).toBe(1);
    const keys = fetchMock.mock.calls
      .filter(([url, init]) => String(url).endsWith("/actions") && init?.method === "POST")
      .map(([, init]) => String((init?.headers as Record<string, string>)["Idempotency-Key"]));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("reuses the scope key when the scope response is lost after commit", async () => {
    const fallback = engagementHandler("Lab 192-0-2-10");
    const committed = new Map<string, unknown>();
    let scopeCommits = 0;
    let loseFirst = true;
    const fetchMock = stubFetch((url, init) => {
      if (
        url === `/api/v1/engagements/${ENGAGEMENT_ID}/scope-revisions` &&
        init?.method === "POST"
      ) {
        const key = String((init?.headers as Record<string, string>)["Idempotency-Key"]);
        if (committed.has(key)) return response(committed.get(key), 201);
        const body = JSON.parse(String(init?.body)) as { rules: unknown[] };
        const revision = {
          contractVersion: 1,
          id: SCOPE_ID,
          engagementId: ENGAGEMENT_ID,
          version: 1,
          rules: body.rules,
          createdAt: "2026-08-12T12:06:00.000Z",
        };
        committed.set(key, revision);
        scopeCommits += 1;
        if (loseFirst) {
          loseFirst = false;
          throw new Error("offline");
        }
        return response(revision, 201);
      }
      return fallback(url, init);
    });
    const { router } = await renderDialog();

    fireEvent.change(screen.getByLabelText(/Targets/), { target: { value: "192.0.2.10" } });
    fireEvent.click(screen.getByLabelText("Also save these targets as scope"));
    submitStart();

    expect(await screen.findByText("The engagement request failed.")).toBeTruthy();
    submitStart();

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/engagements/${ENGAGEMENT_ID}`),
    );
    expect(scopeCommits).toBe(1);
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => url === "/api/v1/engagements" && init?.method === "POST",
      ),
    ).toHaveLength(1);
    const scopeKeys = fetchMock.mock.calls
      .filter(([url, init]) => String(url).endsWith("/scope-revisions") && init?.method === "POST")
      .map(([, init]) => String((init?.headers as Record<string, string>)["Idempotency-Key"]));
    expect(scopeKeys).toHaveLength(2);
    expect(scopeKeys[0]).toBe(scopeKeys[1]);
  });

  it("retries a failed scope append on the same engagement", async () => {
    const fallback = engagementHandler("Lab 192-0-2-10");
    let scopeCalls = 0;
    const fetchMock = stubFetch((url, init) => {
      if (
        url === `/api/v1/engagements/${ENGAGEMENT_ID}/scope-revisions` &&
        init?.method === "POST"
      ) {
        scopeCalls += 1;
        if (scopeCalls === 1) return response({ code: "storage_busy" }, 503);
      }
      return fallback(url, init);
    });
    const { router } = await renderDialog();

    fireEvent.change(screen.getByLabelText(/Targets/), { target: { value: "192.0.2.10" } });
    fireEvent.click(screen.getByLabelText("Also save these targets as scope"));
    submitStart();

    expect(await screen.findByText("Storage is busy. Try again.")).toBeTruthy();
    submitStart();

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/engagements/${ENGAGEMENT_ID}`),
    );
    expect(scopeCalls).toBe(2);
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => url === "/api/v1/engagements" && init?.method === "POST",
      ),
    ).toHaveLength(1);
  });

  it("uses a new action key when retry targets change", async () => {
    const fallback = engagementHandler("Lab 192-0-2-10");
    let actionCalls = 0;
    const fetchMock = stubFetch((url, init) => {
      if (url === `/api/v1/engagements/${ENGAGEMENT_ID}/actions` && init?.method === "POST") {
        actionCalls += 1;
        if (actionCalls === 1) return response({ code: "storage_busy" }, 503);
        return fallback(url, init);
      }
      return fallback(url, init);
    });
    const { router } = await renderDialog();

    fireEvent.change(screen.getByLabelText(/Targets/), { target: { value: "192.0.2.10" } });
    submitStart();

    expect(await screen.findByText("Storage is busy. Try again.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Targets/), { target: { value: "198.51.100.25" } });
    submitStart();

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/engagements/${ENGAGEMENT_ID}`),
    );
    const actionCallsList = fetchMock.mock.calls.filter(
      ([url, init]) => String(url).endsWith("/actions") && init?.method === "POST",
    );
    expect(actionCallsList).toHaveLength(2);
    const keys = actionCallsList.map(([, init]) =>
      String((init?.headers as Record<string, string>)["Idempotency-Key"]),
    );
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("blocks a second submit while the first start is in flight", async () => {
    const fallback = engagementHandler("Lab 192-0-2-10");
    let engagementPosts = 0;
    let release!: (value: Response) => void;
    stubFetch((url, init) => {
      if (url === "/api/v1/engagements" && init?.method === "POST") {
        engagementPosts += 1;
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return fallback(url, init);
    });
    await renderDialog();

    fireEvent.change(screen.getByLabelText(/Targets/), { target: { value: "192.0.2.10" } });
    submitStart();

    const startingForm = await screen.findByRole("button", { name: "Starting" }).then((button) => button.closest("form"));
    if (!startingForm) throw new Error("Starting form is missing.");
    fireEvent.submit(startingForm);
    expect(engagementPosts).toBe(1);
    release(response(createdEngagement("Lab 192-0-2-10"), 201));
    await waitFor(() => expect(engagementPosts).toBe(1));
  });

  it("locks persisted metadata after partial creation with recovery", async () => {
    const fallback = engagementHandler("Lab 192-0-2-10");
    let actionCalls = 0;
    stubFetch((url, init) => {
      if (url === `/api/v1/engagements/${ENGAGEMENT_ID}/actions` && init?.method === "POST") {
        actionCalls += 1;
        if (actionCalls === 1) return response({ code: "storage_busy" }, 503);
        return fallback(url, init);
      }
      return fallback(url, init);
    });
    await renderDialog();

    const file = new File(["find the flag"], "brief.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText(/Challenge file/), { target: { files: [file] } });
    expect(await screen.findByText("brief.txt")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Targets/), { target: { value: "192.0.2.10" } });
    submitStart();

    expect(await screen.findByText("Storage is busy. Try again.")).toBeTruthy();
    expect((screen.getByLabelText(/Name/) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(/Type/) as HTMLSelectElement).disabled).toBe(true);
    // The attached file is persisted metadata too: creation stored its name in
    // the description, so it stays locked alongside the other saved options.
    expect((screen.getByLabelText(/Challenge file/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Remove" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(await screen.findByText(/is created/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open engagement" })).toBeTruthy();
  });

  it("disables Discard and start over while the follow-up scan is pending", async () => {
    const fallback = engagementHandler("Lab 192-0-2-10");
    let releaseAction!: (value: Response) => void;
    stubFetch((url, init) => {
      if (url === `/api/v1/engagements/${ENGAGEMENT_ID}/actions` && init?.method === "POST") {
        return new Promise<Response>((resolve) => {
          releaseAction = resolve;
        });
      }
      return fallback(url, init);
    });
    const { router } = await renderDialog();

    fireEvent.change(screen.getByLabelText(/Targets/), { target: { value: "192.0.2.10" } });
    submitStart();

    // The engagement exists while its first scan is still in flight. Discard
    // must stay disabled so the pending request cannot land on an abandoned
    // engagement.
    const discard = await screen.findByRole("button", { name: "Discard and start over" });
    expect((discard as HTMLButtonElement).disabled).toBe(true);

    releaseAction(response(queuedAction(), 201));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/engagements/${ENGAGEMENT_ID}`),
    );
  });

  it("locks scope inputs after the scope revision is saved", async () => {
    const fallback = engagementHandler("Lab 192-0-2-10");
    let actionCalls = 0;
    stubFetch((url, init) => {
      if (url === `/api/v1/engagements/${ENGAGEMENT_ID}/actions` && init?.method === "POST") {
        actionCalls += 1;
        if (actionCalls === 1) return response({ code: "storage_busy" }, 503);
        return fallback(url, init);
      }
      return fallback(url, init);
    });
    await renderDialog();

    fireEvent.change(screen.getByLabelText(/Targets/), { target: { value: "192.0.2.10" } });
    fireEvent.click(screen.getByLabelText("Also save these targets as scope"));
    submitStart();

    expect(await screen.findByText("Storage is busy. Try again.")).toBeTruthy();
    // Scope succeeded on attempt one, so the scope inputs stay fixed for retry.
    expect((screen.getByLabelText(/Targets/) as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByLabelText("Also save these targets as scope") as HTMLInputElement).disabled).toBe(true);
  });

  it("carries a paused first scan into the planner through the action search", async () => {
    const fallback = engagementHandler("Lab 192-0-2-10");
    stubFetch((url, init) => {
      if (url === `/api/v1/engagements/${ENGAGEMENT_ID}/actions` && init?.method === "POST") {
        const queued = queuedAction();
        return response(
          {
            ...queued,
            action: {
              ...queued.action,
              state: "paused_for_warning",
              queuedSnapshotVersion: null,
              pendingWarning: {
                reasonCodes: ["outside_scope"],
                knownAdditions: [],
                pendingEventId: null,
              },
            },
          },
          201,
        );
      }
      return fallback(url, init);
    });
    const { router } = await renderDialog();

    fireEvent.change(screen.getByLabelText(/Targets/), { target: { value: "192.0.2.10" } });
    submitStart();

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/engagements/${ENGAGEMENT_ID}`),
    );
    expect(router.state.location.search).toMatchObject({ action: ACTION_ID });
  });

  it("refreshes revision and scope together after a scan conflict", async () => {
    const fallback = engagementHandler("Lab 192-0-2-10");
    let actionCalls = 0;
    const fetchMock = stubFetch((url, init) => {
      if (url === `/api/v1/engagements/${ENGAGEMENT_ID}/actions` && init?.method === "POST") {
        actionCalls += 1;
        if (actionCalls === 1) {
          return response(
            {
              code: "revision_conflict",
              resourceType: "engagement",
              resourceId: ENGAGEMENT_ID,
              currentRevision: 5,
            },
            409,
          );
        }
        return fallback(url, init);
      }
      if (url === `/api/v1/engagements/${ENGAGEMENT_ID}` && init?.method !== "POST") {
        return response({
          engagement: {
            ...createdEngagement("Lab 192-0-2-10"),
            revision: 5,
            activeScopeRevisionId: SCOPE_ID,
            updatedAt: "2026-08-12T12:07:00.000Z",
          },
          activeScopeRevision: {
            contractVersion: 1,
            id: SCOPE_ID,
            engagementId: ENGAGEMENT_ID,
            version: 2,
            rules: [],
            createdAt: "2026-08-12T12:07:00.000Z",
          },
        });
      }
      return fallback(url, init);
    });
    const { router } = await renderDialog();

    fireEvent.change(screen.getByLabelText(/Targets/), { target: { value: "192.0.2.10" } });
    submitStart();

    expect(await screen.findByText("This engagement changed. Showing the latest revision.")).toBeTruthy();
    submitStart();

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/engagements/${ENGAGEMENT_ID}`),
    );
    const bodies = fetchMock.mock.calls
      .filter(([url, init]) => String(url).endsWith("/actions") && init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({
      expectedEngagementRevision: 5,
      expectedActiveScopeRevisionId: SCOPE_ID,
    });
  });

  it("ignores a stale conflict refresh after discard and a new start", async () => {
    const ENGAGEMENT_ID_B = "10000000-0000-4000-8000-000000000009";
    let createCalls = 0;
    let actionBCalls = 0;
    let releaseDetailA!: (value: Response) => void;
    const fetchMock = stubFetch((url, init) => {
      if (url === "/api/v1/engagements" && init?.method === "POST") {
        createCalls += 1;
        if (createCalls === 1) {
          return response({ ...createdEngagement("Lab A"), id: ENGAGEMENT_ID }, 201);
        }
        return response(
          { ...createdEngagement("Lab B"), id: ENGAGEMENT_ID_B, activeScopeRevisionId: null },
          201,
        );
      }
      if (url === `/api/v1/engagements/${ENGAGEMENT_ID}/actions` && init?.method === "POST") {
        return response(
          {
            code: "revision_conflict",
            resourceType: "engagement",
            resourceId: ENGAGEMENT_ID,
            currentRevision: 5,
          },
          409,
        );
      }
      if (url === `/api/v1/engagements/${ENGAGEMENT_ID}` && init?.method !== "POST") {
        return new Promise<Response>((resolve) => {
          releaseDetailA = resolve;
        });
      }
      if (url === `/api/v1/engagements/${ENGAGEMENT_ID_B}/actions` && init?.method === "POST") {
        actionBCalls += 1;
        if (actionBCalls === 1) return Promise.reject(new Error("offline"));
        return response(
          PersistedActionSchema.parse({ ...queuedAction(), engagementId: ENGAGEMENT_ID_B }),
          201,
        );
      }
      return response({ code: "invalid_request" }, 400);
    });
    await renderDialog();

    // Start engagement A. Its follow-up scan conflicts, and the detail
    // refresh stays pending while the dialog is closed and reopened.
    fireEvent.change(screen.getByLabelText(/Targets/), { target: { value: "192.0.2.10" } });
    submitStart();
    expect(await screen.findByText("This engagement changed. Showing the latest revision.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "close-for-test" }));
    fireEvent.click(screen.getByRole("button", { name: "open-for-test" }));

    // Start engagement B on the reopened dialog. Its first scan fails without
    // a conflict, so B stays retained with revision 1 and no scope id.
    fireEvent.change(screen.getByLabelText(/Targets/), { target: { value: "192.0.2.10" } });
    submitStart();
    expect(await screen.findByText("The engagement request failed.")).toBeTruthy();

    // The stale refresh for discarded engagement A resolves now. It must not
    // overwrite B's retained revision and scope id. Flush first so the retry
    // below reads whatever the refresh left behind, the way a later operator
    // retry would.
    releaseDetailA(
      response({
        engagement: {
          ...createdEngagement("Lab A"),
          id: ENGAGEMENT_ID,
          revision: 5,
          activeScopeRevisionId: SCOPE_ID,
          updatedAt: "2026-08-12T12:07:00.000Z",
        },
        activeScopeRevision: {
          contractVersion: 1,
          id: SCOPE_ID,
          engagementId: ENGAGEMENT_ID,
          version: 2,
          rules: [],
          createdAt: "2026-08-12T12:07:00.000Z",
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Retry B. The follow-up scan must carry B's own concurrency values.
    submitStart();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([called, init]) =>
            String(called) === `/api/v1/engagements/${ENGAGEMENT_ID_B}/actions` &&
            init?.method === "POST",
        ),
      ).toHaveLength(2),
    );
    const bodies = fetchMock.mock.calls
      .filter(
        ([called, init]) =>
          String(called) === `/api/v1/engagements/${ENGAGEMENT_ID_B}/actions` &&
          init?.method === "POST",
      )
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies[1]).toMatchObject({
      expectedEngagementRevision: 1,
      expectedActiveScopeRevisionId: null,
    });
  });

  it("creates a fresh engagement when targets change after a lost create response", async () => {
    let createCalls = 0;
    const fetchMock = stubFetch((url, init) => {
      if (url === "/api/v1/engagements" && init?.method === "POST") {
        createCalls += 1;
        // First attempt commits server side but its response is lost.
        if (createCalls === 1) return Promise.reject(new Error("offline"));
        return response(createdEngagement("Same name"), 201);
      }
      if (url === `/api/v1/engagements/${ENGAGEMENT_ID}/actions` && init?.method === "POST") {
        return response(queuedAction(), 201);
      }
      return response({ code: "invalid_request" }, 400);
    });
    await renderDialog();

    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "Same name" } });
    fireEvent.change(screen.getByLabelText(/Targets/), { target: { value: "192.0.2.10" } });
    submitStart();
    // Both the mutation error and the submit error report the lost response.
    expect(await screen.findAllByText("The engagement request failed.")).toHaveLength(2);

    // Close and reopen, then start again with the same name but a new target.
    // The abandoned create must not be replayed onto the new target.
    fireEvent.click(screen.getByRole("button", { name: "close-for-test" }));
    fireEvent.click(screen.getByRole("button", { name: "open-for-test" }));
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "Same name" } });
    fireEvent.change(screen.getByLabelText(/Targets/), { target: { value: "198.51.100.10" } });
    submitStart();

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([url, init]) => url === "/api/v1/engagements" && init?.method === "POST",
        ),
      ).toHaveLength(2),
    );
    const createPosts = fetchMock.mock.calls.filter(
      ([url, init]) => url === "/api/v1/engagements" && init?.method === "POST",
    );
    const keys = createPosts.map(
      ([, init]) => (init?.headers as Record<string, string>)["Idempotency-Key"],
    );
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(keys[1]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("reveals More options when a nested field fails validation", async () => {
    stubFetch(engagementHandler("Lab 192-0-2-10"));
    await renderDialog();

    fireEvent.change(screen.getByLabelText(/Targets/), { target: { value: "192.0.2.10" } });
    fireEvent.change(screen.getByLabelText(/Platform URL/), { target: { value: "not a url" } });
    submitStart();

    expect(await screen.findByText(/Enter a valid URL/)).toBeTruthy();
    const details = screen.getByText("More options").closest("details");
    expect(details?.open).toBe(true);
  });

  it("resends identical scope rule ids and canonical body on lost-response retry", async () => {
    const fallback = engagementHandler("Lab 192-0-2-10");
    const stored = new Map<string, { body: unknown; revision: unknown }>();
    let scopeCommits = 0;
    let loseFirst = true;
    const fetchMock = stubFetch((url, init) => {
      if (
        url === `/api/v1/engagements/${ENGAGEMENT_ID}/scope-revisions` &&
        init?.method === "POST"
      ) {
        const key = String((init?.headers as Record<string, string>)["Idempotency-Key"]);
        const body = JSON.parse(String(init?.body)) as unknown;
        const prev = stored.get(key);
        if (prev !== undefined) {
          // Real server semantics: same key replays only when the canonical
          // body digest matches, otherwise it conflicts.
          const prevJson = canonicalizeJson(prev.body);
          const nextJson = canonicalizeJson(body);
          if (
            prevJson.ok &&
            nextJson.ok &&
            prevJson.canonicalJson === nextJson.canonicalJson
          ) {
            return response(prev.revision, 201);
          }
          return response({ code: "idempotency_conflict" }, 409);
        }
        const revision = {
          contractVersion: 1,
          id: SCOPE_ID,
          engagementId: ENGAGEMENT_ID,
          version: 1,
          rules: (body as { rules: unknown }).rules,
          createdAt: "2026-08-12T12:06:00.000Z",
        };
        stored.set(key, { body, revision });
        scopeCommits += 1;
        if (loseFirst) {
          loseFirst = false;
          throw new Error("offline");
        }
        return response(revision, 201);
      }
      return fallback(url, init);
    });
    const { router } = await renderDialog();

    fireEvent.change(screen.getByLabelText(/Targets/), { target: { value: "192.0.2.10" } });
    fireEvent.click(screen.getByLabelText("Also save these targets as scope"));
    submitStart();

    expect(await screen.findByText("The engagement request failed.")).toBeTruthy();
    submitStart();

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/engagements/${ENGAGEMENT_ID}`),
    );
    expect(scopeCommits).toBe(1);
    const scopeCalls = fetchMock.mock.calls.filter(
      ([url, init]) => String(url).endsWith("/scope-revisions") && init?.method === "POST",
    );
    expect(scopeCalls).toHaveLength(2);
    const bodies = scopeCalls.map(([, init]) => JSON.parse(String(init?.body)));
    // Identical canonical body, including generated rule ids.
    expect(bodies[1]).toEqual(bodies[0]);
    const firstIds = (bodies[0] as { rules: Array<{ id: string }> }).rules.map((rule) => rule.id);
    const secondIds = (bodies[1] as { rules: Array<{ id: string }> }).rules.map((rule) => rule.id);
    expect(secondIds).toEqual(firstIds);
    const firstJson = canonicalizeJson(bodies[0]);
    const secondJson = canonicalizeJson(bodies[1]);
    expect(firstJson.ok && secondJson.ok).toBe(true);
    if (firstJson.ok && secondJson.ok) {
      expect(secondJson.canonicalJson).toBe(firstJson.canonicalJson);
    }
    const keys = scopeCalls.map(([, init]) =>
      String((init?.headers as Record<string, string>)["Idempotency-Key"]),
    );
    expect(keys[0]).toBe(keys[1]);
  });

  it("uses new scope ids and key when retry targets change", async () => {
    const fallback = engagementHandler("Lab 192-0-2-10");
    let scopeCalls = 0;
    const fetchMock = stubFetch((url, init) => {
      if (
        url === `/api/v1/engagements/${ENGAGEMENT_ID}/scope-revisions` &&
        init?.method === "POST"
      ) {
        scopeCalls += 1;
        if (scopeCalls === 1) return response({ code: "storage_busy" }, 503);
      }
      return fallback(url, init);
    });
    const { router } = await renderDialog();

    fireEvent.change(screen.getByLabelText(/Targets/), { target: { value: "192.0.2.10" } });
    fireEvent.click(screen.getByLabelText("Also save these targets as scope"));
    submitStart();

    expect(await screen.findByText("Storage is busy. Try again.")).toBeTruthy();
    // Scope has not been saved yet, so targets stay editable. New targets
    // mean a new scope intent with fresh rule ids and a new key.
    fireEvent.change(screen.getByLabelText(/Targets/), { target: { value: "198.51.100.25" } });
    submitStart();

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/engagements/${ENGAGEMENT_ID}`),
    );
    const scopeCallsList = fetchMock.mock.calls.filter(
      ([url, init]) => String(url).endsWith("/scope-revisions") && init?.method === "POST",
    );
    expect(scopeCallsList).toHaveLength(2);
    const bodies = scopeCallsList.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies[1]).not.toEqual(bodies[0]);
    const keys = scopeCallsList.map(([, init]) =>
      String((init?.headers as Record<string, string>)["Idempotency-Key"]),
    );
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("drops a prior read when an oversized replacement is picked", async () => {
    stubFetch(engagementHandler("Lab brief"));
    await renderDialog();

    const resolvers: Array<(text: string) => void> = [];
    vi.spyOn(File.prototype, "text").mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    fireEvent.change(screen.getByLabelText(/Targets/), { target: { value: "keep me" } });
    fireEvent.change(screen.getByLabelText(/Challenge file/), {
      target: { files: [new File(["first content"], "a.txt", { type: "text/plain" })] },
    });
    expect(resolvers).toHaveLength(1);
    const oversized = new File(["x"], "big.txt", { type: "text/plain" });
    Object.defineProperty(oversized, "size", { value: 300 * 1024 });
    fireEvent.change(screen.getByLabelText(/Challenge file/), {
      target: { files: [oversized] },
    });

    expect(
      await screen.findByText("That file is larger than 256 KB. Paste the relevant part instead."),
    ).toBeTruthy();
    expect(screen.queryByText("a.txt")).toBeNull();
    // Unrelated fields are preserved.
    expect((screen.getByLabelText(/Targets/) as HTMLTextAreaElement).value).toBe("keep me");
    // The earlier read finishes last; it must not restore the old file or clear the error.
    resolvers[0]!("first content");
    await waitFor(() =>
      expect(
        screen.getByText("That file is larger than 256 KB. Paste the relevant part instead."),
      ).toBeTruthy(),
    );
    expect(screen.queryByText("a.txt")).toBeNull();
  });

  it("clears a prior attachment when an oversized file replaces it", async () => {
    stubFetch(engagementHandler("Lab brief"));
    await renderDialog();

    const file = new File(["valid"], "ok.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText(/Challenge file/), { target: { files: [file] } });
    expect(await screen.findByText("ok.txt")).toBeTruthy();

    const oversized = new File(["x"], "big.txt", { type: "text/plain" });
    Object.defineProperty(oversized, "size", { value: 300 * 1024 });
    fireEvent.change(screen.getByLabelText(/Challenge file/), {
      target: { files: [oversized] },
    });

    expect(
      await screen.findByText("That file is larger than 256 KB. Paste the relevant part instead."),
    ).toBeTruthy();
    expect(screen.queryByText("ok.txt")).toBeNull();
  });
});
