// @vitest-environment jsdom
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { EngagementVhostSection } from "./vhost-surface.js";

const engagementId = "10000000-0000-4000-8000-000000000001";

const detail = {
  engagement: {
    contractVersion: 1,
    id: engagementId,
    revision: 1,
    name: "Vhost lab",
    kind: "lab",
    status: "active",
    description: null,
    authorizationContext: null,
    autoContinueWarnings: false,
    activeScopeRevisionId: null,
    deadlineAt: null,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
  },
  activeScopeRevision: null,
};

function vhostResult(hostname: string, length = 1024, status = 200) {
  return {
    source: "ffuf-vhost" as const,
    parserVersion: "ffuf-vhost-v1",
    hostname,
    baseUrl: "http://192.0.2.10:80/",
    status,
    length,
    words: 40,
    lines: 12,
    runId: "run-1",
    artifactId: "artifact-1",
    artifactDigest: `sha256:${"a".repeat(64)}`,
    observedAt: "2026-09-03T00:00:00.000Z",
  };
}

const stoneTarget = {
  contractVersion: 1,
  id: "20000000-0000-4000-8000-000000000001",
  engagementId,
  label: "Target 1",
  revision: 1,
  createdAt: "2026-09-03T00:00:00.000Z",
  updatedAt: "2026-09-03T00:00:00.000Z",
};

function response(payload: unknown, status = 200): Response {
  return { json: async () => payload, ok: status >= 200 && status < 300, status } as Response;
}

let queryClient: ReturnType<typeof createAppQueryClient>;

beforeEach(() => {
  queryClient = createAppQueryClient();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: { getItem: () => null, setItem: () => undefined },
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => Promise.resolve(handler(url, init))),
  );
}

function renderSurface() {
  return render(
    <QueryClientProvider client={queryClient}>
      <EngagementVhostSection archived={false} engagementId={engagementId} />
    </QueryClientProvider>,
  );
}

describe("EngagementVhostSection", () => {
  it("renders the launch form with an empty state", async () => {
    stubFetch((url) => {
      if (url.endsWith("/vhost-results")) return response([]);
      if (url.endsWith("/stone-targets")) return response([]);
      if (url.endsWith("/settings/runner")) return response({}, 404);
      return response(detail);
    });
    renderSurface();
    expect(await screen.findByRole("button", { name: "Launch discovery" })).toBeTruthy();
    expect(await screen.findByText(/No vhost results yet/i)).toBeTruthy();
    expect(await screen.findByLabelText("Target IP")).toBeTruthy();
  });

  it("shows the baseline calibration note and filters wildcard responses", async () => {
    stubFetch((url) => {
      if (url.endsWith("/vhost-results")) {
        return response([
          vhostResult("a.internal", 512),
          vhostResult("b.internal", 512),
          vhostResult("c.internal", 512),
          vhostResult("admin.internal", 1024),
        ]);
      }
      if (url.endsWith("/stone-targets")) return response([stoneTarget]);
      if (url.endsWith("/settings/runner")) return response({}, 404);
      return response(detail);
    });
    renderSurface();
    expect(await screen.findByText(/Baseline status 200, length 512 bytes seen in 3 of 4 responses/)).toBeTruthy();
    expect(await screen.findByText("admin.internal")).toBeTruthy();
    expect(await screen.findByText("Propose association")).toBeTruthy();
    expect(await screen.findAllByText("Filtered by baseline")).toHaveLength(3);
  });

  it("keeps filtered responses listed with raw evidence when every response matches", async () => {
    stubFetch((url) => {
      if (url.endsWith("/vhost-results")) {
        return response([vhostResult("a.internal", 512), vhostResult("b.internal", 512)]);
      }
      if (url.endsWith("/stone-targets")) return response([stoneTarget]);
      if (url.endsWith("/settings/runner")) return response({}, 404);
      return response(detail);
    });
    renderSurface();
    expect(await screen.findByText(/no candidates remain/)).toBeTruthy();
    expect(await screen.findByText("a.internal")).toBeTruthy();
    expect(await screen.findAllByRole("link", { name: "Raw evidence" })).toHaveLength(2);
    expect(screen.queryByText("Propose association")).toBe(null);
  });

  it("proposes a hostname association and confirms explicitly", async () => {
    const association = {
      contractVersion: 1,
      id: "30000000-0000-4000-8000-000000000001",
      engagementId,
      targetId: stoneTarget.id,
      connectionAddress: "192.0.2.10",
      requestedHostname: "admin.internal",
      status: "proposed",
      runnerOnlyNote: "This name mapping applies to the runner only. An ordinary browser will not resolve it.",
      nextStep: "Next step: share the intended hostname with the operator and use it for HTTP host and TLS server name; do not edit the OS hosts file.",
      hostsFileEdited: false,
      createdAt: "2026-09-03T00:00:00.000Z",
      decidedAt: null,
    };
    stubFetch((url, init) => {
      if (url.endsWith("/vhost-results")) {
        return response([vhostResult("admin.internal", 1024), vhostResult("other.internal", 1025)]);
      }
      if (url.endsWith("/stone-targets")) return response([stoneTarget]);
      if (url.includes("/hostname-associations") && init?.method === "POST") return response(association, 201);
      if (url.includes("/decision") && init?.method === "POST") {
        return response({ ...association, status: "associated", decidedAt: "2026-09-03T00:01:00.000Z" });
      }
      if (url.endsWith("/settings/runner")) return response({}, 404);
      return response(detail);
    });
    renderSurface();
    const proposeButtons = await screen.findAllByRole("button", { name: "Propose association" });
    fireEvent.click(proposeButtons[0] as HTMLElement);
    await waitFor(() => expect(screen.getByText(/Status: proposed/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Associate" }));
    await waitFor(() => expect(screen.getByText(/Status: associated/)).toBeTruthy());
  });

  it("lists candidates with a raw evidence link", async () => {
    stubFetch((url) => {
      if (url.endsWith("/vhost-results")) {
        return response([vhostResult("admin.internal", 1024), vhostResult("portal.internal", 2048)]);
      }
      if (url.endsWith("/stone-targets")) return response([stoneTarget]);
      if (url.endsWith("/settings/runner")) return response({}, 404);
      return response(detail);
    });
    renderSurface();
    expect(await screen.findByText("admin.internal")).toBeTruthy();
    const link = await screen.findAllByRole("link", { name: "Raw evidence" });
    expect(link[0]?.getAttribute("href")).toBe(
      `/api/v1/engagements/${engagementId}/artifacts/artifact-1/content`,
    );
  });
});
