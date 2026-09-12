// @vitest-environment jsdom

import { PersistedActionSchema, type PersistedAction } from "@stonehush/contracts";
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
});
