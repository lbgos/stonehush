// @vitest-environment jsdom
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { ENGAGEMENT_HTTP_PROBES_QUERY_ERROR_MESSAGE } from "./errors.js";
import { EngagementHttpProbesSection } from "./http-probe-surface.js";

const engagementId = "10000000-0000-4000-8000-000000000001";

const probeA = {
  source: "http-probe" as const,
  parserVersion: "http-probe-raw-v1",
  url: "http://127.0.0.1:8080/",
  fetchedAt: "2026-09-03T00:00:00.000Z",
  finalUrl: "http://127.0.0.1:8080/",
  status: 200,
  title: "Lab Box",
  selectedHeaders: { contentType: "text/html", server: "lab", poweredBy: null },
  hops: [{ url: "http://127.0.0.1:8080/", status: 200, location: null }],
  error: null,
  runId: "run-1",
  artifactId: "artifact-1",
  artifactDigest: `sha256:${"a".repeat(64)}`,
  observedAt: "2026-09-03T00:00:00.000Z",
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
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderSurface() {
  return render(
    <QueryClientProvider client={queryClient}>
      <EngagementHttpProbesSection engagementId={engagementId} />
    </QueryClientProvider>,
  );
}

describe("EngagementHttpProbesSection", () => {
  it("shows loading state", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    renderSurface();
    expect(screen.getByRole("status", { name: "Loading probe results" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "HTTP probes" })).toBeTruthy();
  });

  it("renders empty with queue guidance", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response([]))));
    renderSurface();
    expect(await screen.findByRole("heading", { name: "HTTP probes" })).toBeTruthy();
    expect(await screen.findByText(/No probes yet/i)).toBeTruthy();
  });

  it("lists probed URLs with status and a raw download link", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response([probeA]))));
    renderSurface();
    expect(await screen.findByText("http://127.0.0.1:8080/")).toBeTruthy();
    expect(screen.getByText("200")).toBeTruthy();
    expect(screen.getByText("Lab Box")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Raw evidence" });
    expect(link.getAttribute("href")).toBe(
      `/api/v1/engagements/${engagementId}/artifacts/artifact-1/content`,
    );
  });

  it("selects only the linked URL and updates selection when the link changes", async () => {
    const other = { ...probeA, url: "http://127.0.0.1:8080/other" };
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response([probeA, other]))));
    const content = (selectedKey: string) => (
      <QueryClientProvider client={queryClient}>
        <EngagementHttpProbesSection engagementId={engagementId} selectedKey={selectedKey} onSelectKey={() => undefined} />
      </QueryClientProvider>
    );
    const { rerender } = render(content(`probe:${probeA.url}`));
    const first = await screen.findByRole("button", { name: probeA.url });
    const second = screen.getByRole("button", { name: other.url });
    expect(first.getAttribute("aria-current")).toBe("true");
    expect(second.hasAttribute("aria-current")).toBe(false);
    rerender(content(`probe:${other.url}`));
    expect(first.hasAttribute("aria-current")).toBe(false);
    expect(second.getAttribute("aria-current")).toBe("true");
  });

  it("shows recoverable error without cached data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ json: async () => ({ code: "storage_busy" }), ok: false, status: 503 } as Response)),
    );
    renderSurface();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Probe results unavailable" })).toBeTruthy();
    expect(screen.queryByText(ENGAGEMENT_HTTP_PROBES_QUERY_ERROR_MESSAGE)).toBeNull();
  });

  it("validates untrusted JSON and hides secrets", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response([{ ...probeA, secret: "/private/path" }]))));
    renderSurface();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("secret")).toBeNull();
    expect(screen.queryByText("private")).toBeNull();
  });
});
