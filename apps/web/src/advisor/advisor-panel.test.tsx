// @vitest-environment jsdom

import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";

import { AdvisorPanel } from "./advisor-panel.js";
import { createAppQueryClient } from "../query-client.js";

const ENGAGEMENT_ID = "10000000-0000-4000-8000-000000000001";
const TURN_ID = "10000000-0000-4000-8000-000000000002";

function pendingTurn() {
  return {
    id: TURN_ID,
    engagementId: ENGAGEMENT_ID,
    question: "What does this show?",
    modelId: "test-model",
    redactions: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "pending",
    answer: "",
    uncertainty: "",
    citations: [],
    abstained: null,
    errorCode: null,
  };
}

function succeededTurn(overrides: Record<string, unknown> = {}) {
  return {
    ...pendingTurn(),
    status: "succeeded",
    answer: "The banner shows HTTP.",
    uncertainty: "Version string was truncated.",
    citations: [{ raw: "artifact-1", valid: true, kind: "artifact" }],
    abstained: false,
    ...overrides,
  };
}

const okStatus = {
  configured: true,
  endpointReachable: true,
  modelId: "test-model",
  endpointHost: "127.0.0.1",
  publicEndpoint: false,
  optIn: false,
  keyEnvVar: "",
  keyPresent: false,
  latencyMs: 3,
  reason: "ok",
};

function response(payload: unknown, status = 200): Response {
  return {
    json: async () => payload,
    ok: status >= 200 && status < 300,
    status,
  } as Response;
}

interface PostedCall {
  url: string;
  key: string | null;
  body: unknown;
}

async function renderPanel(
  post: (call: PostedCall) => unknown,
  options?: {
    archived?: boolean;
    excerpts?: string[];
    findingIds?: string[];
    status?: unknown;
    findings?: unknown[];
    history?: unknown[];
    historyPages?: unknown[][];
    failPagedFetch?: boolean;
    onRequest?: (url: string, method: string) => void;
  },
) {
  const posted: PostedCall[] = [];
  // Stateful history: successful POSTs land in the list the panel reads,
  // mirroring server persistence plus query invalidation.
  const stored: unknown[] = [...(options?.history ?? [])];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      options?.onRequest?.(String(url), method);
      if (method === "POST") {
        const headers = new Headers(init?.headers);
        const call = {
          url: String(url),
          key: headers.get("Idempotency-Key"),
          body: JSON.parse(String(init?.body ?? "null")) as unknown,
        };
        posted.push(call);
        const turn = await post(call);
        stored.unshift(turn);
        return response(turn);
      }
      if (String(url).includes("/advisor/status")) {
        return response(options?.status ?? okStatus);
      }
      if (String(url).includes("/findings")) {
        return response(options?.findings ?? []);
      }
      if (String(url).includes("/advisor/turns")) {
        if (options?.historyPages !== undefined) {
          const parsed = new URL(String(url), "http://localhost");
          const beforeId = parsed.searchParams.get("beforeId");
          const pages = options.historyPages;
          let index = 0;
          if (beforeId !== null) {
            const found = pages.findIndex((page) =>
              page.some(
                (turn) =>
                  typeof turn === "object" &&
                  turn !== null &&
                  (turn as { id?: unknown }).id === beforeId,
              ),
            );
            if (found === -1) return response({ code: "invalid_request" }, 400);
            index = found + 1;
          }
          if (options?.failPagedFetch === true && index > 0) {
            return response({ code: "invalid_persisted_data" }, 500);
          }
          const page = pages[index] ?? [];
          const last = page[page.length - 1] as { createdAt?: unknown; id?: unknown } | undefined;
          const hasNext = index + 1 < pages.length;
          return response({
            turns: page,
            nextCursor:
              hasNext && typeof last?.createdAt === "string" && typeof last?.id === "string"
                ? { createdAt: last.createdAt, id: last.id }
                : null,
          });
        }
        return response({ turns: stored, nextCursor: null });
      }
      throw new Error(`Unexpected fetch: ${String(url)}`);
    }),
  );
  // State-driven archived flag so a test can flip the engagement to
  // archived and re-render the same mounted panel without losing
  // composer state. A plain mutation plus root rerender does not reach
  // the route component because the router reuses the matched element.
  let applyArchived: ((value: boolean) => void) | undefined;
  function PanelRoute() {
    const [archived, setArchived] = useState(options?.archived ?? false);
    const [excerpts, setExcerpts] = useState(options?.excerpts ?? ["artifact-1"]);
    const [findingIds, setFindingIds] = useState(options?.findingIds ?? []);
    const [queryClient] = useState(() => createAppQueryClient());
    applyArchived = setArchived;
    return (
      <QueryClientProvider client={queryClient}>
        <AdvisorPanel
          engagementId={ENGAGEMENT_ID}
          archived={archived}
          excerpts={excerpts}
          findingIds={findingIds}
          onExcerptsChange={setExcerpts}
          onFindingIdsChange={setFindingIds}
          onClose={() => {}}
        />
      </QueryClientProvider>
    );
  }
  const rootRoute = createRootRoute({ component: PanelRoute });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "settings",
        component: () => null,
      }),
    ]),
  });
  await router.load();
  const view = render(<RouterProvider router={router} />);
  return {
    posted,
    router,
    unmount: view.unmount,
    rerenderArchived: (archived: boolean) => {
      act(() => {
        applyArchived?.(archived);
      });
    },
  };
}

beforeEach(() => {
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }),
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    value: vi.fn(),
  });
});

function button(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

function askButton(): HTMLButtonElement {
  return button("Ask");
}

function questionBox(): HTMLTextAreaElement {
  return screen.getByLabelText(/Question/) as HTMLTextAreaElement;
}

async function askQuestion(question: string) {
  const box = screen.getByLabelText(/Question/) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: question } });
  fireEvent.click(screen.getByRole("button", { name: "Ask" }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("advisor panel composer", () => {
  it("disables Ask without an excerpt and explains finding-only entry", async () => {
    await renderPanel(() => pendingTurn(), { excerpts: [], findingIds: [FINDING_ID] });
    expect(askButton().disabled).toBe(true);
    await screen.findByText("Finding-only questions need at least one evidence excerpt.");
  });

  it("rejects overlong questions by byte count", async () => {
    await renderPanel(() => pendingTurn());
    const box = screen.getByLabelText(/Question/) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: `é${"x".repeat(2000)}` } });
    expect(askButton().disabled).toBe(true);
  });

  it("reuses the same key on retry after an ambiguous failure", async () => {
    let calls = 0;
    const { posted } = await renderPanel(() => {
      calls += 1;
      if (calls === 1) throw new TypeError("network down");
      return pendingTurn();
    });
    await askQuestion("What does this show?");
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[0]?.key).not.toBeNull();
    expect(posted[1]?.key).toBe(posted[0]?.key);
    expect(posted[1]?.body).toEqual(posted[0]?.body);
  });

  it("mints a fresh key only through New attempt", async () => {
    const { posted } = await renderPanel(() => pendingTurn());
    await askQuestion("What does this show?");
    await waitFor(() => expect(posted).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "New attempt" }));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]?.key).not.toBe(posted[0]?.key);
  });

  it("blocks retry and new attempt once archived after an ambiguous failure", async () => {
    let calls = 0;
    const { posted, rerenderArchived } = await renderPanel(() => {
      calls += 1;
      if (calls === 1) throw new TypeError("network down");
      return pendingTurn();
    });
    await askQuestion("What does this show?");
    await screen.findByRole("button", { name: "Retry" });
    await screen.findByRole("button", { name: "New attempt" });
    rerenderArchived(true);
    expect(askButton().disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New attempt" })).toBeNull();
    expect(posted).toHaveLength(1);
  });
});

const FINDING_ID = "10000000-0000-4000-8000-000000000003";

function testFinding(id: string, title: string) {
  return {
    contractVersion: 1,
    id,
    engagementId: ENGAGEMENT_ID,
    title,
    severity: "medium",
    status: "open",
    body: "",
    evidenceArtifactIds: [],
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("advisor panel states", () => {
  it("shows archived history read-only without a composer", async () => {
    await renderPanel(() => pendingTurn(), {
      archived: true,
      history: [succeededTurn()],
    });
    await screen.findByText(/Archived engagements are read-only/);
    expect((screen.getByLabelText(/Question/) as HTMLTextAreaElement).disabled).toBe(true);
    expect(askButton().disabled).toBe(true);
    await screen.findByText("The banner shows HTTP.");
  });

  it("links to settings when the advisor is unconfigured", async () => {
    await renderPanel(() => pendingTurn(), { status: { ...okStatus, reason: "unconfigured" } });
    const link = await screen.findByRole("link", { name: "Open Advisor settings" });
    expect(link.getAttribute("href")).toBe("/settings");
    expect(askButton().disabled).toBe(true);
  });

  it("renders uncertainty and inert unknown citations without raw HTML", async () => {
    await renderPanel(
      () =>
        succeededTurn({
          abstained: false,
          citations: [{ raw: "ghost", valid: false, kind: "unknown" }],
        }),
      { history: [] },
    );
    await askQuestion("What does this show?");
    const panel = screen.getByRole("dialog");
    await within(panel).findByText("Uncertainty");
    within(panel).getByText("unverified: ghost", { exact: false });
    expect(within(panel).queryByRole("link")).toBeNull();
  });

  it("maps terminal failures to friendly messages", async () => {
    await renderPanel(
      () => ({
        ...pendingTurn(),
        status: "provider_error",
        errorCode: "provider_unreachable",
      }),
      { history: [] },
    );
    await askQuestion("What does this show?");
    await screen.findByText("The model endpoint did not answer.");
  });

  it("sends checked findings with the selected excerpts", async () => {
    const { posted } = await renderPanel(() => pendingTurn(), {
      findings: [testFinding(FINDING_ID, "Open banner")],
    });
    fireEvent.click(await screen.findByRole("checkbox", { name: /Open banner/ }));
    await askQuestion("What does this show?");
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.body).toMatchObject({
      excerptArtifactIds: ["artifact-1"],
      findingIds: [FINDING_ID],
    });
  });

  it("sends the edited draft, not stale text, on New attempt", async () => {
    const { posted } = await renderPanel(() => pendingTurn());
    await askQuestion("First question?");
    await waitFor(() => expect(posted).toHaveLength(1));
    fireEvent.change(questionBox(), { target: { value: "Second question?" } });
    fireEvent.click(button("New attempt"));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect((posted[1]?.body as { question?: unknown }).question).toBe("Second question?");
    expect(posted[1]?.key).not.toBe(posted[0]?.key);
  });

  it("trims padded questions before sending", async () => {
    const { posted } = await renderPanel(() => pendingTurn());
    await askQuestion("  padded question?  ");
    await waitFor(() => expect(posted).toHaveLength(1));
    expect((posted[0]?.body as { question?: unknown }).question).toBe("padded question?");
  });

  it("locks finding selection when archived", async () => {
    await renderPanel(() => pendingTurn(), {
      archived: true,
      findings: [testFinding(FINDING_ID, "Open banner")],
    });
    const boxes = await screen.findAllByRole("checkbox", { name: /Open banner/ });
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) {
      expect((box as HTMLInputElement).disabled).toBe(true);
    }
  });

  it("surfaces pagination failures with retry", async () => {
    const answer = (label: string) => `Answer ${label}.`;
    const first = { ...succeededTurn(), id: "10000000-0000-4000-8000-000000000011", answer: answer("one") };
    const second = { ...succeededTurn(), id: "10000000-0000-4000-8000-000000000012", answer: answer("two") };
    const third = { ...succeededTurn(), id: "10000000-0000-4000-8000-000000000013", answer: answer("three") };
    await renderPanel(() => pendingTurn(), {
      history: [],
      historyPages: [[first, second], [third]],
      failPagedFetch: true,
    });
    await screen.findByText("Answer one.");
    await screen.findByText("Answer two.");
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await screen.findByText("Could not load more explanations.");
    const retries = screen.getAllByRole("button", { name: "Retry" });
    expect(retries).toHaveLength(1);
    fireEvent.click(retries[0] as HTMLButtonElement);
    await screen.findByText("Could not load more explanations.");
  });

  it("polls visible pending turns and stops after unmount", async () => {
    const gets: string[] = [];
    const { unmount } = await renderPanel(() => pendingTurn(), {
      history: [pendingTurn()],
      onRequest: (url, method) => {
        if (method === "GET" && url.includes("/advisor/turns")) gets.push(url);
      },
    });
    await screen.findByText("Running…");
    const initial = gets.length;
    expect(initial).toBeGreaterThanOrEqual(1);
    await new Promise((resolve) => setTimeout(resolve, 6500));
    expect(gets.length).toBeGreaterThan(initial);
    unmount();
    const frozen = gets.length;
    await new Promise((resolve) => setTimeout(resolve, 6000));
    expect(gets.length).toBe(frozen);
  }, 30000);

  it("gives a distinct new attempt its own poll budget after exhaustion", async () => {
    const gets: string[] = [];
    const { posted } = await renderPanel(() => pendingTurn(), {
      history: [],
      onRequest: (url, method) => {
        if (method === "GET" && url.includes("/advisor/turns")) gets.push(url);
      },
    });
    // Faithful timer registry: clearInterval really unregisters. The
    // helper below always targets the single live timer instead of a
    // stale captured id, and size is only asserted outside waitFor
    // because waitFor itself parks a transient interval while waiting.
    let nextTimerId = 1;
    const liveTimers = new Map<number, () => void>();
    const setIntervalSpy = vi.spyOn(window, "setInterval").mockImplementation(
      ((callback: () => void): number => {
        const id = nextTimerId;
        nextTimerId += 1;
        liveTimers.set(id, callback);
        return id;
      }) as unknown as typeof window.setInterval,
    );
    const clearIntervalSpy = vi.spyOn(window, "clearInterval").mockImplementation(
      ((id?: number): void => {
        if (id !== undefined) liveTimers.delete(id);
      }) as unknown as typeof window.clearInterval,
    );
    function soleLiveTimer(): number {
      const ids = Array.from(liveTimers.keys());
      expect(ids).toHaveLength(1);
      const id = ids[0];
      if (id === undefined) throw new Error("polling interval was not scheduled");
      return id;
    }
    try {
      await askQuestion("First question?");
      await screen.findByText("Running…");
      const firstId = soleLiveTimer();
      const baseline = gets.length;
      for (let round = 0; round < 12; round += 1) {
        const tick = liveTimers.get(soleLiveTimer());
        if (tick === undefined) throw new Error("polling interval died before exhaustion");
        tick();
        await waitFor(() => expect(gets.length).toBe(baseline + round + 1));
      }
      // Exhaustion self-clears: the timer unregisters and stops refetching.
      const lastTick = liveTimers.get(soleLiveTimer());
      if (lastTick === undefined) throw new Error("polling interval died before exhaustion");
      lastTick();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(liveTimers.has(firstId)).toBe(false);
      expect(liveTimers.size).toBe(0);
      expect(gets.length).toBe(baseline + 12);
      // A distinct new owned attempt registers a fresh timer with its own
      // budget while the old pending turn is still visible.
      fireEvent.change(questionBox(), { target: { value: "Second question?" } });
      fireEvent.click(button("New attempt"));
      await waitFor(() => expect(posted).toHaveLength(2));
      await waitFor(() => expect(gets.length).toBeGreaterThan(baseline + 12));
      expect(liveTimers.size).toBe(1);
      const secondId = soleLiveTimer();
      expect(secondId).not.toBe(firstId);
      const resumed = gets.length;
      const restart = liveTimers.get(secondId);
      if (restart === undefined) throw new Error("replacement interval died immediately");
      restart();
      await waitFor(() => expect(gets.length).toBe(resumed + 1));
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it("reconciles cancellation against persisted status", async () => {
    let gets = 0;
    let releaseHeldRequest!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHeldRequest = () => resolve(undefined);
    });
    await renderPanel(
      async () => {
        await held;
        return pendingTurn();
      },
      {
        onRequest: (url, method) => {
          if (method === "GET" && url.includes("/advisor/turns")) gets += 1;
        },
      },
    );
    fireEvent.change(questionBox(), { target: { value: "What does this show?" } });
    fireEvent.click(button("Ask"));
    await screen.findByRole("button", { name: "Cancel" });
    const before = gets;
    fireEvent.click(button("Cancel"));
    releaseHeldRequest();
    await waitFor(() => expect(gets).toBeGreaterThan(before));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("closes on Escape and restores trigger focus on unmount", async () => {
    const onClose = vi.fn();
    const trigger = document.createElement("button");
    trigger.textContent = "trigger";
    document.body.append(trigger);
    trigger.focus();
    const { unmount } = render(
      <QueryClientProvider client={createAppQueryClient()}>
        <AdvisorPanel
          engagementId={ENGAGEMENT_ID}
          archived={false}
          excerpts={["artifact-1"]}
          findingIds={[]}
          onExcerptsChange={() => {}}
          onFindingIdsChange={() => {}}
          onClose={onClose}
        />
      </QueryClientProvider>,
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
