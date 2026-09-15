// @vitest-environment jsdom
import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { engagementReportMarkdown, type ReportBundle } from "@stonehush/contracts";
import { createAppQueryClient } from "../query-client.js";
import { EngagementWorkspaceProvider } from "./workspace-context.js";
import { ActionPlanner } from "./action-planner.js";
import { EngagementFfufSection } from "./ffuf-surface.js";
import { useSaveEngagementNotesMutation } from "./notes-query.js";
import {
  useCreateFindingMutation,
  useFindingTransitionMutation,
} from "./findings-query.js";
import { reportQueryKey, reportQueryOptions } from "./report-query.js";
import { EngagementReportSection } from "./report.js";
import { isTerminalActionState } from "./action-query.js";

const engagementA = "10000000-0000-4000-8000-000000000001";
const engagementB = "10000000-0000-4000-8000-000000000002";

function bundleFixture(engagementId: string, overrides: Partial<ReportBundle> = {}): ReportBundle {
  return {
    contractVersion: 1,
    engagement: {
      id: engagementId,
      name: engagementId === engagementA ? "Lab A" : "Lab B",
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
    notesMarkdown: "",
    notesUpdatedAt: "2026-08-12T12:00:00.000Z",
    services: { total: 0, truncated: false, rows: [] },
    probes: { total: 0, truncated: false, rows: [] },
    ffufResults: { total: 0, truncated: false, rows: [] },
    evidenceArtifacts: { total: 0, truncated: false, rows: [] },
    generatedAt: "2026-08-12T13:00:00.000Z",
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return { json: async () => payload, ok: status >= 200 && status < 300, status } as Response;
}

const clients = new Set<QueryClient>();

function trackClient(client: QueryClient): QueryClient {
  clients.add(client);
  return client;
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
    value: vi.fn((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    }),
  });
  Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
  Element.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn(() => "blob:fake"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  for (const c of clients) c.clear();
  clients.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderReport(client: QueryClient, engagementId: string) {
  return render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <EngagementReportSection engagementId={engagementId} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

function NotesSaver({
  engagementId,
  markdown,
  expectedRevision = 0,
  onSettled,
}: {
  engagementId: string;
  markdown: string;
  expectedRevision?: number;
  onSettled: () => void;
}) {
  const save = useSaveEngagementNotesMutation(engagementId);
  useEffect(() => {
    save.mutate({ markdown, expectedRevision }, { onSettled });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function FindingCreator({
  engagementId,
  onSettled,
}: {
  engagementId: string;
  onSettled: (id?: string) => void;
}) {
  const create = useCreateFindingMutation(engagementId);
  useEffect(() => {
    create.mutate(
      { title: "Fresh finding", severity: "high", body: "# impact", evidenceArtifactIds: [] },
      {
        onSuccess: (finding) => onSettled(finding.id),
        onError: () => onSettled(undefined),
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function FindingResolver({
  engagementId,
  findingId,
  onSettled,
}: {
  engagementId: string;
  findingId: string;
  onSettled: () => void;
}) {
  const transition = useFindingTransitionMutation(engagementId, "resolve");
  useEffect(() => {
    transition.mutate(findingId, { onSettled });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

describe("report cache coherence", () => {
  it("uses scoped mount refetch while the global client stays non-refetching", () => {
    expect(reportQueryOptions(engagementA).refetchOnMount).toBe(true);
    expect(createAppQueryClient().getDefaultOptions().queries?.refetchOnMount).toBe(false);
  });

  it("terminal states cover succeeded, failed, and cancelled", () => {
    expect(isTerminalActionState("succeeded")).toBe(true);
    expect(isTerminalActionState("failed")).toBe(true);
    expect(isTerminalActionState("cancelled")).toBe(true);
    expect(isTerminalActionState("queued")).toBe(false);
    expect(isTerminalActionState("active")).toBe(false);
  });

  it("warms the report, saves notes, then revisits with fresh data", async () => {
    const v1 = bundleFixture(engagementA, { notesMarkdown: "notes-v1" });
    const v2 = bundleFixture(engagementA, {
      notesMarkdown: "notes-v2",
      generatedAt: "2026-08-12T14:00:00.000Z",
    });
    let reportCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith(`/engagements/${engagementA}/report`)) {
          reportCalls += 1;
          return Promise.resolve(jsonResponse(reportCalls === 1 ? v1 : v2));
        }
        if (url.endsWith(`/engagements/${engagementA}/notes`) && init?.method === "PUT") {
          return Promise.resolve(
            jsonResponse({
              engagementId: engagementA,
              markdown: "notes-v2",
              updatedAt: "2026-08-12T14:00:00.000Z",
              revision: 1,
            }),
          );
        }
        return Promise.reject(new Error(`unexpected ${url}`));
      }),
    );
    const client = trackClient(createAppQueryClient());
    await client.fetchQuery(reportQueryOptions(engagementA));
    expect(client.getQueryData(reportQueryKey(engagementA))).toEqual(v1);

    await new Promise<void>((resolve) => {
      render(
        <QueryClientProvider client={client}>
          <NotesSaver engagementId={engagementA} markdown="notes-v2" onSettled={() => resolve()} />
        </QueryClientProvider>,
      );
    });
    expect(client.getQueryState(reportQueryKey(engagementA))?.isInvalidated).toBe(true);

    renderReport(client, engagementA);
    expect(await screen.findByText(/notes-v2/)).toBeTruthy();
    expect(reportCalls).toBeGreaterThanOrEqual(2);
  });

  it("keeps engagements isolated when notes are saved", async () => {
    const a1 = bundleFixture(engagementA, { notesMarkdown: "a-v1" });
    const b1 = bundleFixture(engagementB, { notesMarkdown: "b-v1" });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith(`/engagements/${engagementA}/report`)) return Promise.resolve(jsonResponse(a1));
        if (url.endsWith(`/engagements/${engagementB}/report`)) return Promise.resolve(jsonResponse(b1));
        if (url.endsWith(`/engagements/${engagementA}/notes`) && init?.method === "PUT") {
          return Promise.resolve(
            jsonResponse({
              engagementId: engagementA,
              markdown: "a-v2",
              updatedAt: "2026-08-12T14:00:00.000Z",
              revision: 1,
            }),
          );
        }
        return Promise.reject(new Error(`unexpected ${url}`));
      }),
    );
    const client = trackClient(createAppQueryClient());
    await client.fetchQuery(reportQueryOptions(engagementA));
    await client.fetchQuery(reportQueryOptions(engagementB));

    await new Promise<void>((resolve) => {
      render(
        <QueryClientProvider client={client}>
          <NotesSaver engagementId={engagementA} markdown="a-v2" onSettled={() => resolve()} />
        </QueryClientProvider>,
      );
    });
    expect(client.getQueryState(reportQueryKey(engagementA))?.isInvalidated).toBe(true);
    expect(client.getQueryState(reportQueryKey(engagementB))?.isInvalidated).not.toBe(true);
    expect(client.getQueryData(reportQueryKey(engagementB))).toEqual(b1);
  });

  it("failed notes save does not fabricate report data", async () => {
    const v1 = bundleFixture(engagementA, { notesMarkdown: "stable-notes" });
    let reportCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith(`/engagements/${engagementA}/report`)) {
          reportCalls += 1;
          return Promise.resolve(jsonResponse(v1));
        }
        if (url.endsWith(`/engagements/${engagementA}/notes`) && init?.method === "PUT") {
          return Promise.resolve(jsonResponse({ code: "storage_busy" }, 503));
        }
        return Promise.reject(new Error(`unexpected ${url}`));
      }),
    );
    const client = trackClient(createAppQueryClient());
    await client.fetchQuery(reportQueryOptions(engagementA));

    await new Promise<void>((resolve) => {
      render(
        <QueryClientProvider client={client}>
          <NotesSaver engagementId={engagementA} markdown="should-fail" onSettled={() => resolve()} />
        </QueryClientProvider>,
      );
    });
    expect(client.getQueryState(reportQueryKey(engagementA))?.isInvalidated).not.toBe(true);
    expect(client.getQueryData(reportQueryKey(engagementA))).toEqual(v1);
    expect(reportCalls).toBe(1);
  });

  it("creating a finding refreshes the report with the new title", async () => {
    const v1 = bundleFixture(engagementA, { generatedAt: "2026-08-12T13:00:00.000Z" });
    const created = {
      contractVersion: 1,
      id: "20000000-0000-4000-8000-000000000001",
      engagementId: engagementA,
      title: "Fresh finding",
      severity: "high",
      status: "open",
      body: "# impact",
      evidenceArtifactIds: [],
      revision: 1,
      createdAt: "2026-08-12T14:00:00.000Z",
      updatedAt: "2026-08-12T14:00:00.000Z",
    };
    const v2 = bundleFixture(engagementA, {
      findings: [created as ReportBundle["findings"][number]],
      generatedAt: "2026-08-12T14:00:00.000Z",
    });
    let reportCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith(`/engagements/${engagementA}/report`)) {
          reportCalls += 1;
          return Promise.resolve(jsonResponse(reportCalls === 1 ? v1 : v2));
        }
        if (url.endsWith(`/engagements/${engagementA}/findings`) && init?.method === "POST") {
          return Promise.resolve(jsonResponse(created, 201));
        }
        if (url.endsWith(`/engagements/${engagementA}/findings`)) {
          return Promise.resolve(jsonResponse(reportCalls === 1 ? [] : [created]));
        }
        return Promise.reject(new Error(`unexpected ${url}`));
      }),
    );
    const client = trackClient(createAppQueryClient());
    await client.fetchQuery(reportQueryOptions(engagementA));

    const createdId = await new Promise<string | undefined>((resolve) => {
      render(
        <QueryClientProvider client={client}>
          <FindingCreator engagementId={engagementA} onSettled={resolve} />
        </QueryClientProvider>,
      );
    });
    expect(createdId).toBe(created.id);
    expect(client.getQueryState(reportQueryKey(engagementA))?.isInvalidated).toBe(true);

    renderReport(client, engagementA);
    expect(await screen.findByText(/Fresh finding/)).toBeTruthy();
  });

  it("resolving a finding refreshes the report status", async () => {
    const findingId = "20000000-0000-4000-8000-000000000001";
    const openFinding = {
      contractVersion: 1,
      id: findingId,
      engagementId: engagementA,
      title: "Resolvable finding",
      severity: "medium",
      status: "open",
      body: "# impact",
      evidenceArtifactIds: [],
      revision: 1,
      createdAt: "2026-08-12T12:00:00.000Z",
      updatedAt: "2026-08-12T12:00:00.000Z",
    };
    const resolvedFinding = { ...openFinding, status: "resolved", revision: 2, updatedAt: "2026-08-12T14:00:00.000Z" };
    const v1 = bundleFixture(engagementA, {
      findings: [openFinding as ReportBundle["findings"][number]],
    });
    const v2 = bundleFixture(engagementA, {
      findings: [resolvedFinding as ReportBundle["findings"][number]],
      generatedAt: "2026-08-12T14:00:00.000Z",
    });
    let reportCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith(`/engagements/${engagementA}/report`)) {
          reportCalls += 1;
          return Promise.resolve(jsonResponse(reportCalls === 1 ? v1 : v2));
        }
        if (url.endsWith(`/findings/${findingId}/resolve`)) return Promise.resolve(jsonResponse(resolvedFinding));
        if (url.endsWith("/findings")) return Promise.resolve(jsonResponse([openFinding]));
        return Promise.reject(new Error(`unexpected ${url}`));
      }),
    );
    const client = trackClient(createAppQueryClient());
    await client.fetchQuery(reportQueryOptions(engagementA));

    await new Promise<void>((resolve) => {
      render(
        <QueryClientProvider client={client}>
          <FindingResolver engagementId={engagementA} findingId={findingId} onSettled={() => resolve()} />
        </QueryClientProvider>,
      );
    });
    expect(client.getQueryState(reportQueryKey(engagementA))?.isInvalidated).toBe(true);

    renderReport(client, engagementA);
    expect(await screen.findByText(/\(resolved\)/)).toBeTruthy();
  });

  it("exports one bundle snapshot and marks background refresh", async () => {
    const bundle = bundleFixture(engagementA, {
      notesMarkdown: "export-notes",
      findings: [
        {
          contractVersion: 1,
          id: "20000000-0000-4000-8000-000000000001",
          engagementId: engagementA,
          title: "Export finding",
          severity: "low",
          status: "open",
          body: "detail",
          evidenceArtifactIds: [],
          revision: 1,
          createdAt: "2026-08-12T12:00:00.000Z",
          updatedAt: "2026-08-12T12:00:00.000Z",
        },
      ],
    });
    const expectedMarkdown = engagementReportMarkdown(bundle);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/report")) return Promise.resolve(jsonResponse(bundle));
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const clicked: string[] = [];
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(`${this.download}:${this.href}`);
    });
    const client = trackClient(createAppQueryClient());
    renderReport(client, engagementA);

    expect(await screen.findByText(/Export finding/)).toBeTruthy();
    expect(screen.getByText(/export-notes/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Download Markdown" }));
    await waitFor(() =>
      expect(clicked.some((entry) => entry.startsWith(`engagement-${engagementA}-report.md:`))).toBe(true),
    );
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/report?format=markdown"))).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Copy Markdown" }));
    await waitFor(() => expect(window.navigator.clipboard.writeText).toHaveBeenCalled());
    const copied = String(
      (window.navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? "",
    );
    expect(copied).toBe(expectedMarkdown);
    clickSpy.mockRestore();
  });

  it("disables exports while a background refresh is pending", async () => {
    const bundle = bundleFixture(engagementA, { notesMarkdown: "stable" });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    const client = trackClient(createAppQueryClient());
    client.setQueryData(reportQueryKey(engagementA), bundle);
    await client.invalidateQueries({ queryKey: reportQueryKey(engagementA) });
    renderReport(client, engagementA);

    expect(await screen.findByText("Refreshing report…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy Markdown" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Download JSON" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Download Markdown" })).toHaveProperty("disabled", true);
  });

  it("marks a failed refresh as stale instead of current", async () => {
    const bundle = bundleFixture(engagementA, { notesMarkdown: "last-good" });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse({ code: "oops" }, 500))));
    const client = trackClient(createAppQueryClient());
    client.setQueryData(reportQueryKey(engagementA), bundle);
    await client.invalidateQueries({ queryKey: reportQueryKey(engagementA) });
    renderReport(client, engagementA);

    expect(await screen.findByText("Showing the last successful report")).toBeTruthy();
    expect(screen.getByText(/last-good/)).toBeTruthy();
  });
});

describe("terminal action coherence", () => {
  const detail = {
    engagement: {
      contractVersion: 1,
      id: engagementA,
      revision: 1,
      name: "Terminal lab",
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
    activeScopeRevision: null,
  };

  function actionPayload(state: string, actionId: string) {
    return {
      contractVersion: 1,
      engagementId: engagementA,
      revision: 1,
      warningAcknowledgmentId: null,
      createdAt: "2026-08-12T12:10:00.000Z",
      updatedAt: "2026-08-12T12:10:00.000Z",
      action: {
        orchestrationProfile: "d2-v1",
        actionId,
        state,
        snapshots: [
          {
            normalizationProfile: "d1-v1",
            orchestrationProfile: "d2-v1",
            snapshotId: "40000000-0000-4000-8000-000000000002",
            version: 1,
            binding: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            actionId,
            canonicalTargets: [
              { kind: "ip", normalizationProfile: "d1-v1", family: 4, address: "192.0.2.10", zone: null },
            ],
            concreteDestinations: [
              { kind: "ip", normalizationProfile: "d1-v1", family: 4, address: "192.0.2.10", zone: null },
            ],
            typedOptions: { declaredPorts: null },
            resolutionSnapshots: [],
            scopeRevisionId: null,
            warningState: { reasonCodes: [], knownAdditions: [], acknowledgment: null },
          },
        ],
        queuedSnapshotVersion:
          state === "queued" || state === "succeeded" || state === "failed" ? 1 : null,
        warningAcknowledgment: null,
        pendingWarning: null,
        coveredDestinations: [],
        warningInteractions: 0,
        runState: null,
        resumeRequested: false,
        cleanupRequired: false,
        capabilityErrorCode: null,
      },
    };
  }

  function renderPlannerHarness(client: QueryClient) {
    return render(
      <ThemeProvider>
        <QueryClientProvider client={client}>
          <EngagementWorkspaceProvider openCreate={() => undefined}>
            <ActionPlanner archived={false} engagementId={engagementA} />
          </EngagementWorkspaceProvider>
        </QueryClientProvider>
      </ThemeProvider>,
    );
  }

  async function drivePlannerToTerminal(terminal: "succeeded" | "failed" | "cancelled") {
    const actionId = "40000000-0000-4000-8000-000000000001";
    let actionPolls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/v1/engagements/${engagementA}`) return Promise.resolve(jsonResponse(detail));
      if (url === "/api/v1/engagements") return Promise.resolve(jsonResponse([detail.engagement]));
      if (url.includes("/system/status")) return Promise.resolve(jsonResponse({ version: 1, overall: "ready", developmentStorage: "ready" }));
      if (url.endsWith("/services") || url.endsWith("/http-probes") || url.endsWith("/ffuf-results") || url.endsWith("/report")) {
        return Promise.resolve(jsonResponse(url.endsWith("/report") ? bundleFixture(engagementA) : []));
      }
      if (url.endsWith("/actions") && init?.method === "POST") {
        return Promise.resolve(jsonResponse(actionPayload("queued", actionId), 201));
      }
      if (url.includes(`/actions/${actionId}`) && (init?.method === undefined || init?.method === "GET")) {
        actionPolls += 1;
        return Promise.resolve(jsonResponse(actionPayload(terminal, actionId)));
      }
      return Promise.resolve(jsonResponse([]));
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = trackClient(createAppQueryClient());
    const spy = vi.spyOn(client, "invalidateQueries");
    renderPlannerHarness(client);

    const field = await screen.findByLabelText("Targets");
    fireEvent.change(field, { target: { value: "192.0.2.10" } });
    fireEvent.submit(screen.getByRole("button", { name: "Plan action" }).closest("form")!);

    const copy = terminal === "succeeded" ? /Action succeeded/ : terminal === "failed" ? /Action failed/ : /Action cancelled/;
    expect(await screen.findByText(copy, {}, { timeout: 5000 })).toBeTruthy();
    await waitFor(() => {
      const keys = spy.mock.calls.map(([arg]) => JSON.stringify((arg as { queryKey?: unknown })?.queryKey ?? ""));
      expect(keys.some((k) => k.includes('"report"'))).toBe(true);
    });

    const matching = (needle: string) =>
      spy.mock.calls.filter(([arg]) =>
        JSON.stringify((arg as { queryKey?: unknown })?.queryKey ?? "").includes(needle),
      ).length;
    expect(matching('"services"')).toBe(1);
    expect(matching('"report"')).toBe(1);
    const pollsAfterTerminal = actionPolls;
    await new Promise((r) => setTimeout(r, 300));
    expect(actionPolls).toBe(pollsAfterTerminal);
    expect(matching('"services"')).toBe(1);
    spy.mockRestore();
    cleanup();
  }

  it("planner failed terminal refreshes partials and report once without looping", async () => {
    await drivePlannerToTerminal("failed");
  }, 30000);

  it("planner cancelled terminal refreshes partials and report once without looping", async () => {
    await drivePlannerToTerminal("cancelled");
  }, 30000);

  it("ffuf terminal refreshes results and report once without looping", async () => {
    const actionId = "40000000-0000-4000-8000-00000000000f";
    let actionPolls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === `/api/v1/engagements/${engagementA}`) return Promise.resolve(jsonResponse(detail));
        if (url.endsWith("/ffuf-results") && (init?.method === undefined || init?.method === "GET")) {
          return Promise.resolve(jsonResponse([]));
        }
        if (url.endsWith("/ffuf-discoveries") && init?.method === "POST") {
          return Promise.resolve(jsonResponse(actionPayload("queued", actionId), 201));
        }
        if (url.includes(`/actions/${actionId}`)) {
          actionPolls += 1;
          return Promise.resolve(jsonResponse(actionPayload("failed", actionId)));
        }
        return Promise.resolve(jsonResponse(detail));
      }),
    );
    const client = trackClient(createAppQueryClient());
    const spy = vi.spyOn(client, "invalidateQueries");
    render(
      <QueryClientProvider client={client}>
        <EngagementFfufSection archived={false} engagementId={engagementA} />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("button", { name: "Launch discovery" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Origin"), { target: { value: "http://127.0.0.1:8080" } });
    fireEvent.change(screen.getByLabelText("Wordlist path"), { target: { value: "/wordlists/smoke.txt" } });
    fireEvent.click(screen.getByRole("button", { name: "Launch discovery" }));

    await waitFor(
      () => {
        const keys = spy.mock.calls.map(([arg]) => JSON.stringify((arg as { queryKey?: unknown })?.queryKey ?? ""));
        expect(keys.some((k) => k.includes("ffuf-results"))).toBe(true);
        expect(keys.some((k) => k.includes('"report"'))).toBe(true);
      },
      { timeout: 5000 },
    );
    const count = (needle: string) =>
      spy.mock.calls.filter(([arg]) =>
        JSON.stringify((arg as { queryKey?: unknown })?.queryKey ?? "").includes(needle),
      ).length;
    expect(count("ffuf-results")).toBe(1);
    expect(count('"report"')).toBe(1);
    const polls = actionPolls;
    await new Promise((r) => setTimeout(r, 300));
    expect(actionPolls).toBe(polls);
    expect(count("ffuf-results")).toBe(1);
    spy.mockRestore();
  }, 30000);
});
