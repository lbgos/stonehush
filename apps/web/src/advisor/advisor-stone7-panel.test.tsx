// @vitest-environment jsdom

import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    answer: "The banner shows nginx.\n\nRun this check:\n$ nmap -sV 10.0.0.5",
    uncertainty: "",
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
  body: unknown;
}

async function renderStonePanel(history: unknown[] = []) {
  const posted: PostedCall[] = [];
  const stored: unknown[] = [...history];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST" && String(url).includes("/advisor/turns")) {
        const call = { url: String(url), body: JSON.parse(String(init?.body ?? "null")) as unknown };
        posted.push(call);
        const turn = pendingTurn();
        stored.unshift(turn);
        return response(turn);
      }
      if (String(url).includes("/advisor/status")) return response(okStatus);
      if (String(url).includes("/techniques")) {
        if (method === "GET") return response([]);
        return response({ code: "invalid_request" }, 400);
      }
      if (String(url).includes("/findings")) return response([]);
      if (String(url).includes("/advisor/turns")) {
        return response({ turns: stored, nextCursor: null });
      }
      throw new Error(`Unexpected fetch: ${String(url)}`);
    }),
  );
  function PanelRoute() {
    const [excerpts, setExcerpts] = useState(["artifact-1"]);
    const [findingIds, setFindingIds] = useState<string[]>([]);
    const [queryClient] = useState(() => createAppQueryClient());
    return (
      <QueryClientProvider client={queryClient}>
        <AdvisorPanel
          engagementId={ENGAGEMENT_ID}
          archived={false}
          excerpts={excerpts}
          findingIds={findingIds}
          onExcerptsChange={setExcerpts}
          onFindingIdsChange={setFindingIds}
          onClose={() => {}}
        />
      </QueryClientProvider>
    );
  }
  render(<PanelRoute />);
  return { posted };
}

beforeEach(() => {
  window.localStorage.clear();
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("advisor stone-7 panel", () => {
  it("shows a context preview with chosen excerpts before send", async () => {
    await renderStonePanel();
    const preview = await screen.findByText("Context preview (sent on Ask)");
    const region = preview.closest("div")?.parentElement;
    expect(region?.textContent).toContain("artifact artifact-1");
    expect(region?.textContent).toContain("scratchpad");
  });

  it("drafts an entry-point question on click", async () => {
    await renderStonePanel();
    fireEvent.click(screen.getByRole("button", { name: "What am I overlooking" }));
    const box = screen.getByLabelText(/Question/) as HTMLTextAreaElement;
    expect(box.value).toContain("overlooking");
  });

  it("sends the focused question unchanged at default depth", async () => {
    const { posted } = await renderStonePanel();
    const box = screen.getByLabelText(/Question/) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "What does this show?" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect((posted[0]?.body as { question?: unknown }).question).toBe(
      "What does this show?",
    );
  });

  it("advances hint depth only on request", async () => {
    const { posted } = await renderStonePanel();
    const box = screen.getByLabelText(/Question/) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "What does this show?" } });
    fireEvent.click(screen.getByRole("button", { name: "Next check" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect((posted[0]?.body as { question?: unknown }).question).toContain(
      "exactly one specific check",
    );
  });

  it("opens valid artifact citations at the saved passage", async () => {
    await renderStonePanel([succeededTurn()]);
    const panel = screen.getByRole("dialog");
    const link = await within(panel).findByRole("link", { name: /artifact-1/ });
    expect(link.getAttribute("href")).toBe(
      `/api/v1/engagements/${ENGAGEMENT_ID}/artifacts/artifact-1/content`,
    );
    expect(await within(panel).findByText(/Basis: 1 artifact/)).toBeDefined();
  });

  it("pins a paragraph into a note draft with citations", async () => {
    await renderStonePanel([succeededTurn()]);
    const panel = screen.getByRole("dialog");
    const pinButtons = await within(panel).findAllByRole("button", { name: "Pin to note" });
    fireEvent.click(pinButtons[0] as HTMLElement);
    expect(await within(panel).findByText(/Note draft/)).toBeDefined();
    expect(within(panel).getByText(/artifact artifact-1/).textContent).toContain("Sources");
  });

  it("renders supported checks as prefilled actions, never prose buttons", async () => {
    await renderStonePanel([succeededTurn()]);
    const panel = screen.getByRole("dialog");
    expect(
      await within(panel).findByRole("button", { name: /Use: nmap/ }),
    ).toBeDefined();
  });

  it("marks a suggested check ruled out and retries with a new reason", async () => {
    await renderStonePanel([succeededTurn()]);
    const panel = screen.getByRole("dialog");
    expect(await within(panel).findByText("Tried checks")).toBeDefined();
    fireEvent.click(await within(panel).findByRole("button", { name: "Mark ruled out" }));
    expect(
      await within(panel).findByText(/Already ruled out under the same conditions/),
    ).toBeDefined();
    fireEvent.click(
      within(panel).getByRole("button", { name: "Retry with new reason" }),
    );
    const input = within(panel).getByLabelText(
      /New reason to retry/,
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "new firmware" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Retry" }));
    expect(
      await within(panel).findByText(/new reason to retry: new firmware/),
    ).toBeDefined();
  });
});
