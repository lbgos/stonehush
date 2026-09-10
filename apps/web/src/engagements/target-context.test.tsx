// @vitest-environment jsdom

import { ThemeProvider } from "@blackglass/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { TargetContextPanel } from "./target-context.js";

const ENGAGEMENT_ID = "10000000-0000-4000-8000-000000000001";
const TARGET_ID = "10000000-0000-4000-8000-000000000002";
const BINDING_ID = "10000000-0000-4000-8000-000000000003";
const OLD_BINDING_ID = "10000000-0000-4000-8000-000000000004";

const target = {
  contractVersion: 1,
  id: TARGET_ID,
  engagementId: ENGAGEMENT_ID,
  label: "web01",
  revision: 1,
  createdAt: "2026-08-12T12:00:00.000Z",
  updatedAt: "2026-08-12T12:00:00.000Z",
};

const currentBinding = {
  contractVersion: 1,
  id: BINDING_ID,
  engagementId: ENGAGEMENT_ID,
  targetId: TARGET_ID,
  bindingKind: "ip",
  addressText: "10.0.0.9",
  status: "current",
  createdAt: "2026-08-12T12:01:00.000Z",
  supersededAt: null,
};

const historicalBinding = {
  contractVersion: 1,
  id: OLD_BINDING_ID,
  engagementId: ENGAGEMENT_ID,
  targetId: TARGET_ID,
  bindingKind: "ip",
  addressText: "10.0.0.5",
  status: "historical",
  createdAt: "2026-08-12T12:00:00.000Z",
  supersededAt: "2026-08-12T12:01:00.000Z",
};

function response(payload: unknown, status = 200): Response {
  return {
    json: async () => payload,
    ok: status >= 200 && status < 300,
    status,
  } as Response;
}

const testQueryClients = new Set<QueryClient>();

function renderPanel(origin: string | null = null) {
  const queryClient = createAppQueryClient();
  testQueryClients.add(queryClient);
  return render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TargetContextPanel
          engagementId={ENGAGEMENT_ID}
          accessContext={{
            accountRef: "op-account",
            connectionRef: "lab-vpn",
            lastConfirmedAt: "2026-08-12T12:05:00.000Z",
          }}
          origin={origin}
        />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

function stubTargetsFetch(extra?: (input: RequestInfo | URL) => Response | undefined) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const override = extra?.(input);
    if (override !== undefined) return Promise.resolve(override);
    if (url.endsWith("/bindings")) {
      return Promise.resolve(response({ current: [currentBinding], historical: [historicalBinding] }));
    }
    if (url.endsWith("/stone-targets")) {
      return Promise.resolve(response([target]));
    }
    return Promise.resolve(response({ code: "invalid_request" }, 400));
  });
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

describe("TargetContextPanel", () => {
  it("shows recorded wording, history, and four distinct copy actions", async () => {
    vi.stubGlobal("fetch", stubTargetsFetch());
    renderPanel("https://app.internal:443");

    const recorded = await screen.findByTestId("recorded-session");
    expect(recorded.textContent).toContain(
      "Recorded, Last confirmed 2026-08-12T12:05:00.000Z",
    );
    expect(await screen.findByText("10.0.0.9")).toBeDefined();
    expect(screen.getByText(/10\.0\.0\.5/)).toBeDefined();
    for (const label of ["Copy address", "Copy hostname", "Copy URL", "Copy command"]) {
      expect(screen.getByRole("button", { name: label })).toBeDefined();
    }
    expect(screen.getByLabelText("Target address changed")).toBeDefined();
    const panel = screen.getByLabelText("Target context");
    expect(panel.textContent?.toLowerCase()).not.toContain("live");
    expect(screen.queryByRole("button", { name: /edit hosts/i })).toBeNull();
  });

  it("surfaces missing inputs before copying a URL without an origin", async () => {
    vi.stubGlobal("fetch", stubTargetsFetch());
    renderPanel();

    expect(await screen.findByTestId("recorded-session")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Copy URL" }));
    expect(await screen.findByText("Missing: origin")).toBeDefined();
  });

  it("proposes a hostname association showing both addresses with runner-only wording", async () => {
    const association = {
      contractVersion: 1,
      id: "10000000-0000-4000-8000-000000000005",
      engagementId: ENGAGEMENT_ID,
      targetId: TARGET_ID,
      connectionAddress: "10.0.0.9",
      requestedHostname: "app.internal",
      status: "proposed",
      runnerOnlyNote:
        "This name mapping applies to the runner only. An ordinary browser will not resolve it.",
      nextStep:
        "Next step: share the intended hostname with the operator and use it for HTTP host and TLS server name; do not edit the OS hosts file.",
      hostsFileEdited: false,
      createdAt: "2026-08-12T12:02:00.000Z",
      decidedAt: null,
    };
    vi.stubGlobal(
      "fetch",
      stubTargetsFetch((input) =>
        String(input).includes("/hostname-associations") ? response(association, 201) : undefined,
      ),
    );
    renderPanel();

    expect(await screen.findByTestId("recorded-session")).toBeDefined();
    fireEvent.change(screen.getByLabelText("Requested hostname"), {
      target: { value: "app.internal" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Propose association" }));

    const offer = await screen.findByTestId("hostname-offer");
    expect(offer.textContent).toContain("10.0.0.9");
    expect(offer.textContent).toContain("app.internal");
    expect(offer.textContent).toContain("runner only");
    expect(offer.textContent).toContain("do not edit the OS hosts file");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Associate" })).toBeDefined();
    });
  });
});
