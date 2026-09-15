// @vitest-environment jsdom

import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import {
  DeadlinePill,
  EngagementDeadlineSection,
  describeDeadline,
  fromDateTimeLocalValue,
  toDateTimeLocalValue,
} from "./deadline.js";
import { updateDeadlineRequest } from "./mutations.js";

const engagement: {
  contractVersion: number;
  id: string;
  revision: number;
  name: string;
  kind: string;
  status: string;
  description: null;
  authorizationContext: null;
  autoContinueWarnings: boolean;
  activeScopeRevisionId: null;
  deadlineAt: string | null;
  createdAt: string;
  updatedAt: string;
} = {
  contractVersion: 1,
  id: "10000000-0000-4000-8000-000000000001",
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

const readyStatus = { version: 1, overall: "ready", developmentStorage: "ready" };

function response(payload: unknown, status = 200): Response {
  return {
    json: async () => payload,
    ok: status >= 200 && status < 300,
    status,
  } as Response;
}

const testQueryClients = new Set<QueryClient>();

function renderSection(props: { archived?: boolean; engagementId?: string }) {
  const queryClient = createAppQueryClient();
  testQueryClients.add(queryClient);
  return render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <EngagementDeadlineSection
          archived={props.archived ?? false}
          engagementId={props.engagementId ?? engagement.id}
        />
      </QueryClientProvider>
    </ThemeProvider>,
  );
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
});

afterEach(() => {
  cleanup();
  for (const client of testQueryClients) client.clear();
  testQueryClients.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("describeDeadline", () => {
  const now = Date.parse("2026-08-12T12:00:00.000Z");

  it("stays neutral far out and warns under 24 hours", () => {
    expect(describeDeadline("2026-08-14T12:00:00.000Z", now)).toMatchObject({
      tone: "neutral",
    });
    expect(describeDeadline("2026-08-13T12:00:00.000Z", now)?.tone).toBe("neutral");
    expect(describeDeadline("2026-08-12T14:00:00.000Z", now)).toEqual({
      tone: "warning",
      label: "2h left",
    });
    expect(describeDeadline("2026-08-12T12:45:00.000Z", now)).toEqual({
      tone: "warning",
      label: "45m left",
    });
  });

  it("marks overdue deadlines red with overdue text", () => {
    expect(describeDeadline("2026-08-12T11:00:00.000Z", now)).toEqual({
      tone: "overdue",
      label: "Overdue by 1h",
    });
    expect(describeDeadline("2026-08-12T12:00:00.000Z", now)?.tone).toBe("overdue");
  });

  it("renders nothing for unparseable values", () => {
    expect(describeDeadline("not-a-date", now)).toBeUndefined();
  });
});

describe("DeadlinePill", () => {
  const now = Date.parse("2026-08-12T12:00:00.000Z");

  it("hides when no deadline is set and exposes tone otherwise", () => {
    const { rerender } = render(<DeadlinePill deadlineAt={null} now={now} />);
    expect(screen.queryByTestId("deadline-pill")).toBeNull();

    rerender(<DeadlinePill deadlineAt="2026-08-12T14:00:00.000Z" now={now} />);
    const warning = screen.getByTestId("deadline-pill");
    expect(warning.getAttribute("data-tone")).toBe("warning");
    expect(warning.textContent).toBe("2h left");

    rerender(<DeadlinePill deadlineAt="2026-08-12T11:00:00.000Z" now={now} />);
    const overdue = screen.getByTestId("deadline-pill");
    expect(overdue.getAttribute("data-tone")).toBe("overdue");
    expect(overdue.textContent).toMatch(/Overdue/);
  });
});

describe("deadline datetime-local conversion", () => {
  it("round-trips through the picker format", () => {
    const local = toDateTimeLocalValue("2026-08-14T12:00:00.000Z");
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    const iso = fromDateTimeLocalValue(local);
    expect(iso).toBe(new Date(local).toISOString());
    expect(toDateTimeLocalValue(null)).toBe("");
    expect(fromDateTimeLocalValue("")).toBeUndefined();
    expect(fromDateTimeLocalValue("not-a-date")).toBeUndefined();
  });
});

describe("updateDeadlineRequest", () => {
  it("patches the deadline route with one idempotency key", async () => {
    const updated = { ...engagement, revision: 3, deadlineAt: "2026-08-14T12:00:00.000Z" };
    const fetchMock = vi.fn(() => Promise.resolve(response(updated)));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      updateDeadlineRequest(
        engagement.id,
        { expectedRevision: 2, deadlineAt: "2026-08-14T12:00:00.000Z" },
        "deadline-key-00000000001",
      ),
    ).resolves.toMatchObject({ revision: 3, deadlineAt: "2026-08-14T12:00:00.000Z" });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/engagements/${engagement.id}/deadline`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          expectedRevision: 2,
          deadlineAt: "2026-08-14T12:00:00.000Z",
        }),
      }),
    );
  });
});

describe("EngagementDeadlineSection", () => {
  it("shows loading then the empty state with a validation message on bad input", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/system/status")) return Promise.resolve(response(readyStatus));
        if (url === `/api/v1/engagements/${engagement.id}`) {
          return new Promise<Response>(() => undefined);
        }
        return Promise.resolve(response([]));
      }),
    );
    renderSection({});
    expect(screen.getByRole("status", { name: "Loading deadline" })).toBeTruthy();
    cleanup();

    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/system/status")) return Promise.resolve(response(readyStatus));
        if (url === `/api/v1/engagements/${engagement.id}`) {
          return Promise.resolve(response({ engagement, activeScopeRevision: null }));
        }
        return Promise.resolve(response([]));
      }),
    );
    renderSection({});
    expect(await screen.findByText(/No deadline set/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Clear deadline" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Save deadline" }));
    expect(await screen.findByText("Enter a date and time, or clear the deadline.")).toBeTruthy();
  });

  it("recovers from a load error with retry", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/system/status")) return Promise.resolve(response(readyStatus));
      return Promise.resolve(response({ code: "storage_busy" }, 503));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSection({});
    expect(await screen.findByRole("heading", { name: "Deadline unavailable" })).toBeTruthy();
    const calls = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith(engagement.id)).length;
    const before = calls();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(calls()).toBeGreaterThan(before));
  });

  it("saves a picked deadline and clears it explicitly", async () => {
    let current = { ...engagement };
    const patches: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/system/status")) return Promise.resolve(response(readyStatus));
        if (url === `/api/v1/engagements/${engagement.id}/deadline` && init?.method === "PATCH") {
          const body = JSON.parse(String(init.body)) as {
            expectedRevision: number;
            deadlineAt: string | null;
          };
          patches.push(body);
          current = { ...current, revision: body.expectedRevision + 1, deadlineAt: body.deadlineAt };
          return Promise.resolve(response(current));
        }
        if (url === `/api/v1/engagements/${engagement.id}`) {
          return Promise.resolve(response({ engagement: current, activeScopeRevision: null }));
        }
        return Promise.resolve(response([current]));
      }),
    );
    renderSection({});
    expect(await screen.findByText(/No deadline set/)).toBeTruthy();

    const draft = toDateTimeLocalValue("2026-08-14T12:00:00.000Z");
    fireEvent.change(screen.getByLabelText("Date and time"), { target: { value: draft } });
    fireEvent.click(screen.getByRole("button", { name: "Save deadline" }));
    await waitFor(() =>
      expect(patches).toEqual([
        { expectedRevision: 2, deadlineAt: fromDateTimeLocalValue(draft) },
      ]),
    );
    expect(await screen.findByText(/Due /)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear deadline" }));
    await waitFor(() =>
      expect(patches).toEqual([
        { expectedRevision: 2, deadlineAt: fromDateTimeLocalValue(draft) },
        { expectedRevision: 3, deadlineAt: null },
      ]),
    );
    expect(await screen.findByText(/No deadline set/)).toBeTruthy();
  });

  it("disables writes on archived engagements", async () => {
    const archived = {
      ...engagement,
      status: "archived",
      deadlineAt: "2026-08-14T12:00:00.000Z",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/system/status")) return Promise.resolve(response(readyStatus));
        if (url === `/api/v1/engagements/${engagement.id}`) {
          return Promise.resolve(response({ engagement: archived, activeScopeRevision: null }));
        }
        return Promise.resolve(response([archived]));
      }),
    );
    renderSection({ archived: true });
    expect(await screen.findByText(/Due /)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Save deadline" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Clear deadline" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/archived/)).toBeTruthy();
  });
});
