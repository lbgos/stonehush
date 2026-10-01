// @vitest-environment jsdom

import type { EngagementResumeResponse } from "@stonehush/contracts";
import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { EngagementResumeView } from "./resume-view.js";

const id = "10000000-0000-4000-8000-000000000001";
const runId = "30000000-0000-4000-8000-000000000003";
const engagement = {
  contractVersion: 1,
  id,
  revision: 2,
  name: "Target lab",
  kind: "lab",
  status: "active",
  description: null,
  authorizationContext: null,
  autoContinueWarnings: false,
  activeScopeRevisionId: null,
  deadlineAt: null,
  createdAt: "2026-08-12T12:00:00.000Z",
  updatedAt: "2026-08-12T12:05:00.000Z",
};

function response(payload: unknown, status = 200): Response {
  return { json: async () => payload, ok: status >= 200 && status < 300, status } as Response;
}

function resume(overrides: Partial<EngagementResumeResponse> = {}): EngagementResumeResponse {
  const changes: EngagementResumeResponse["changes"] = [
    { kind: "run", id: runId, at: "2026-08-13T12:00:00.000Z", summary: `Run ${runId} succeeded.`, snapshot: false },
    { kind: "service", id: "192.0.2.10:80:a", at: "2026-08-13T11:00:00.000Z", summary: "Service observed at 192.0.2.10:80.", snapshot: true },
  ];
  for (let index = 0; index < 10; index += 1) {
    changes.push({
      kind: "scope",
      id: `scope-${index}`,
      at: `2026-08-12T${String(10 - index).padStart(2, "0")}:00:00.000Z`,
      summary: `Saved scope revision ${10 - index}.`,
      snapshot: false,
    });
  }
  return {
    engagementId: id,
    nextStep: "Probe port 8080 next.",
    nextStepUpdatedAt: "2026-08-13T09:30:00.000Z",
    nextStepRevision: 3,
    changes,
    complete: true,
    ...overrides,
  };
}

const clients = new Set<QueryClient>();
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.clear();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  });
});

function stub(
  resumeReply: () => Response | Promise<Response>,
  detail: Omit<typeof engagement, "deadlineAt"> & { deadlineAt: string | null } = engagement,
) {
  const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url === `/api/v1/engagements/${id}/resume`) return Promise.resolve(resumeReply());
    if (url === `/api/v1/engagements/${id}`) {
      return Promise.resolve(response({ engagement: detail, activeScopeRevision: null }));
    }
    return Promise.resolve(response({ code: "invalid_request" }, 400));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderView(
  props: {
    archived?: boolean;
    onOpenFinding?: (identity: { engagementId: string; findingId: string }) => void;
    onOpenRun?: (runId: string) => void;
  } = {},
) {
  const client = createAppQueryClient();
  clients.add(client);
  return render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <EngagementResumeView
          engagementId={id}
          archived={props.archived ?? false}
          onOpenFinding={props.onOpenFinding}
          onOpenRun={props.onOpenRun}
        />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe("EngagementResumeView", () => {
  it("shows the newest eight with times and snapshot labels, and keeps toggle focus", async () => {
    stub(() => response(resume({ complete: false })));
    renderView();
    const list = await screen.findByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(8);
    expect(screen.getByText("8 of 12")).toBeTruthy();
    expect(within(list).getByText("snapshot")).toBeTruthy();
    expect(within(list).getByText("13 Aug 2026, 11:00 UTC").getAttribute("datetime")).toBe("2026-08-13T11:00:00.000Z");
    expect(screen.getByDisplayValue("Probe port 8080 next.")).toBeTruthy();
    expect(screen.getByText("13 Aug 2026, 09:30 UTC")).toBeTruthy();
    // Hidden rows exist, so the incomplete note waits for the full list.
    expect(screen.queryByText("Older changes are not listed.")).toBeNull();
    expect(screen.queryByText(/since/i)).toBeNull();

    const toggle = screen.getByRole("button", { name: "Show all 12" });
    toggle.focus();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe("Show newest 8");
    expect(within(list).getAllByRole("listitem")).toHaveLength(12);
    expect(screen.getByText("Older changes are not listed.")).toBeTruthy();
    fireEvent.click(toggle);
    expect(within(list).getAllByRole("listitem")).toHaveLength(8);
    expect(document.activeElement).toBe(toggle);
  });

  it("opens run rows by run id and leaves other kinds plain", async () => {
    stub(() => response(resume()));
    const onOpenRun = vi.fn();
    renderView({ onOpenRun });
    const list = await screen.findByRole("list");
    fireEvent.click(within(list).getByRole("button", { name: `Run ${runId} succeeded.` }));
    expect(onOpenRun).toHaveBeenCalledWith(runId);
    expect(within(list).getAllByRole("button")).toHaveLength(1);
  });

  it("opens finding rows by exact id with their recorded time and keeps invalid ids plain", async () => {
    const findingId = "20000000-0000-4000-8000-000000000002";
    const changes: EngagementResumeResponse["changes"] = [
      { kind: "finding", id: findingId, at: "2026-08-13T12:00:00.000Z", summary: "Finding recorded: Admin panel.", snapshot: false },
      { kind: "finding", id: "20000000-0000-4000-8000-000000000001", at: "2026-08-13T11:00:00.000Z", summary: "Finding recorded: Admin panel.", snapshot: false },
      { kind: "finding", id: "../findings", at: "2026-08-13T10:00:00.000Z", summary: "Finding recorded: Bad id.", snapshot: false },
      { kind: "note", id: "notes", at: "2026-08-13T09:00:00.000Z", summary: "Engagement notes updated.", snapshot: false },
    ];
    stub(() => response(resume({ changes })));
    const onOpenFinding = vi.fn();
    renderView({ onOpenFinding });
    const list = await screen.findByRole("list");
    const sameTitle = within(list).getAllByRole("button", { name: "Finding recorded: Admin panel." });
    expect(sameTitle).toHaveLength(2);
    fireEvent.click(sameTitle[0]!);
    expect(onOpenFinding).toHaveBeenCalledExactlyOnceWith({ engagementId: id, findingId });
    expect(within(list).getAllByRole("button")).toHaveLength(2);
    expect(within(list).getByText("Finding recorded: Bad id.").tagName).toBe("SPAN");
    expect(within(list).getByText("Engagement notes updated.").tagName).toBe("SPAN");
    expect(within(list).getByText("13 Aug 2026, 12:00 UTC").getAttribute("datetime")).toBe("2026-08-13T12:00:00.000Z");
  });

  it("saves with Enter from the next-step input", async () => {
    const fetchMock = stub(() => response(resume()));
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PUT") {
        return Promise.resolve(response({ engagementId: id, nextStep: "Check the admin path.", revision: 4, updatedAt: "2026-08-13T13:00:00.000Z" }));
      }
      if (url.endsWith("/resume")) return Promise.resolve(response(resume()));
      return Promise.resolve(response({ engagement, activeScopeRevision: null }));
    });
    renderView();
    const input = await screen.findByLabelText("Next step");
    fireEvent.change(input, { target: { value: "Check the admin path." } });
    expect(screen.getByText("Not saved")).toBeTruthy();
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(true),
    );
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ nextStep: "Check the admin path.", expectedRevision: 3 });
  });

  it("keeps loading, failure, and empty states compact", async () => {
    stub(() => new Promise<Response>(() => undefined));
    renderView();
    expect(screen.getAllByText("Loading").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Recent changes" })).toBeTruthy();
    cleanup();

    const fetchMock = stub(() => response({ code: "storage_busy" }, 503));
    renderView();
    expect(await screen.findByText(/Resume unavailable/)).toBeTruthy();
    expect(screen.getByText("Not loaded.")).toBeTruthy();
    const before = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/resume")).length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/resume")).length).toBeGreaterThan(before),
    );
    cleanup();

    stub(() => response(resume({ nextStep: null, nextStepUpdatedAt: null, nextStepRevision: 0, changes: [] })));
    renderView();
    expect(await screen.findByText("No changes recorded.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("reads as text when archived", async () => {
    stub(() => response(resume()), { ...engagement, status: "archived", deadlineAt: "2026-08-14T12:00:00.000Z" });
    renderView({ archived: true });
    expect(await screen.findByText("Probe port 8080 next.")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(await screen.findByText(/Due 14 Aug 2026/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save deadline" })).toBeNull();
    expect(screen.getByText("Archived, read only.")).toBeTruthy();
    // Reading history stays available.
    expect(screen.getByRole("button", { name: "Show all 12" })).toBeTruthy();
  });
});
