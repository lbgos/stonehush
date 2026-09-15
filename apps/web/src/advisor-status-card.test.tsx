// @vitest-environment jsdom

import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdvisorStatusCard } from "./advisor-status-card.js";
import { createAppQueryClient } from "./query-client.js";

const unconfiguredStatus = {
  configured: false,
  endpointReachable: null,
  modelId: "",
  endpointHost: "",
  publicEndpoint: false,
  optIn: false,
  keyEnvVar: "",
  keyPresent: false,
  latencyMs: null,
  reason: "unconfigured",
};

const connectedStatus = {
  configured: true,
  endpointReachable: true,
  modelId: "qwen3:8b",
  endpointHost: "127.0.0.1",
  publicEndpoint: false,
  optIn: false,
  keyEnvVar: "STONEHUSH_ADVISOR_API_KEY",
  keyPresent: true,
  latencyMs: 12,
  reason: "ok",
};

function response(payload: unknown, status = 200): Response {
  return {
    json: async () => payload,
    ok: status >= 200 && status < 300,
    status,
  } as Response;
}

async function renderCard() {
  const rootRoute = createRootRoute({ component: AdvisorStatusCard });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute,
  });
  await router.load();
  const queryClient = createAppQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { queryClient, router };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AdvisorStatusCard", () => {
  it("announces loading while the status request is in flight", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const { router } = await renderCard();

    expect(await screen.findByText("Checking advisor connection")).toBeTruthy();
    router.history.destroy();
  });

  it("shows unconfigured copy with a link to Settings", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response(unconfiguredStatus))));
    const { router } = await renderCard();

    expect(await screen.findByText("Advisor is not configured")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Open Advisor settings" });
    expect(link.getAttribute("href")).toBe("/settings?section=advisor");
    router.history.destroy();
  });

  it("shows the connected model, host, and latency without a full URL", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response(connectedStatus))));
    const { router } = await renderCard();

    expect(await screen.findByText("Advisor endpoint reachable")).toBeTruthy();
    const detail = await screen.findByText(
      /qwen3:8b endpoint at 127\.0\.0\.1 responded in 12 ms/,
    );
    expect(detail.textContent).not.toContain("http");
    expect(detail.textContent).toContain("model output not verified");
    router.history.destroy();
  });

  it("names the missing key variable without exposing key material", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          response({
            ...unconfiguredStatus,
            configured: true,
            keyEnvVar: "STONEHUSH_ADVISOR_API_KEY",
            reason: "key_unset",
          }),
        ),
      ),
    );
    const { router } = await renderCard();

    expect(await screen.findByText("Advisor API key is not set")).toBeTruthy();
    expect(await screen.findByText(/STONEHUSH_ADVISOR_API_KEY/)).toBeTruthy();
    router.history.destroy();
  });

  it("explains public endpoints that lack opt-in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          response({
            ...connectedStatus,
            endpointHost: "203.0.113.7",
            endpointReachable: null,
            keyPresent: true,
            latencyMs: null,
            publicEndpoint: true,
            reason: "public_not_opted_in",
          }),
        ),
      ),
    );
    const { router } = await renderCard();

    expect(await screen.findByText("Public endpoint needs opt-in")).toBeTruthy();
    expect(await screen.findByText(/203\.0\.113\.7 looks public/)).toBeTruthy();
    router.history.destroy();
  });

  it("explains unreachable endpoints", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          response({ ...connectedStatus, endpointReachable: false, reason: "unreachable" }),
        ),
      ),
    );
    const { router } = await renderCard();

    expect(await screen.findByText("Advisor endpoint is unreachable")).toBeTruthy();
    router.history.destroy();
  });

  it("recovers through Retry after a failed request", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValue(new Error("control plane is down"));
    vi.stubGlobal("fetch", fetchMock);
    const { router } = await renderCard();

    expect(await screen.findByText("Advisor status is unavailable")).toBeTruthy();
    fetchMock.mockImplementation(() => Promise.resolve(response(connectedStatus)));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Advisor endpoint reachable")).toBeTruthy();
    router.history.destroy();
  });
});
