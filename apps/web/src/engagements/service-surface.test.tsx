// @vitest-environment jsdom
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { ENGAGEMENT_SERVICES_QUERY_ERROR_MESSAGE } from "./errors.js";
import { serviceSelectionKey } from "./inspector.js";
import { EngagementServicesSection } from "./service-surface.js";

const engagementId = "10000000-0000-4000-8000-000000000001";

const serviceA = {
  address: "192.0.2.10",
  port: 22,
  protocol: "tcp" as const,
  hostname: "host-a.test",
  serviceName: "ssh",
  product: "OpenSSH",
  version: "9.6",
  source: "nmap" as const,
  parserVersion: "nmap-xml-v1",
  runId: "run-1",
  artifactId: "artifact-1",
  artifactDigest: `sha256:${"a".repeat(64)}`,
  observedAt: "2026-08-13T12:00:00.000+02:00",
};

const serviceB = {
  address: "192.0.2.2",
  port: 443,
  protocol: "tcp" as const,
  hostname: null,
  serviceName: null,
  product: null,
  version: null,
  source: "nmap" as const,
  parserVersion: "nmap-xml-v1",
  runId: "run-1",
  artifactId: "artifact-2",
  artifactDigest: `sha256:${"b".repeat(64)}`,
  observedAt: "2026-08-13T11:00:00.000Z",
};

function response(payload: unknown, status = 200): Response {
  return { json: async () => payload, ok: status >= 200 && status < 300, status } as Response;
}

function ffufPath(url: string, artifactId = "artifact-9") {
  return {
    source: "ffuf" as const,
    parserVersion: "ffuf-json-v1" as const,
    url,
    status: 200,
    length: 1234,
    words: 10,
    lines: 5,
    redirectlocation: null,
    fuzz: "admin",
    runId: "run-1",
    artifactId,
    artifactDigest: `sha256:${"c".repeat(64)}`,
    observedAt: "2026-08-13T12:00:00.000Z",
  };
}

function httpProbe(url: string, artifactId = "artifact-7") {
  return {
    parserVersion: "http-probe-raw-v1" as const,
    url,
    fetchedAt: "2026-08-13T12:00:00.000Z",
    finalUrl: url,
    status: 200,
    title: "lab",
    selectedHeaders: { contentType: "text/html", server: null, poweredBy: null },
    hops: [],
    error: null,
    source: "http-probe" as const,
    runId: "run-1",
    artifactId,
    artifactDigest: `sha256:${"d".repeat(64)}`,
    observedAt: "2026-08-13T12:00:00.000Z",
  };
}

function routeSurfaceResponses(
  services: readonly unknown[],
  probes: readonly unknown[] = [],
  paths: readonly unknown[] = [],
) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/services")) return Promise.resolve(response(services));
    if (url.endsWith("/http-probes")) return Promise.resolve(response(probes));
    if (url.endsWith("/ffuf-results")) return Promise.resolve(response(paths));
    return Promise.resolve(response({ code: "invalid_request" }, 400));
  });
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
      <EngagementServicesSection engagementId={engagementId} />
    </QueryClientProvider>,
  );
}

describe("EngagementServicesSection", () => {
  it("shows compact loading without fake counters", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    renderSurface();
    expect(screen.getByRole("status", { name: "Loading attack surface" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Attack surface" })).toBeTruthy();
    expect(screen.queryByText("Runs")).toBeNull();
  });

  it("renders empty with truthful zeros and Nmap copy", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response([]))));
    renderSurface();
    expect(await screen.findByRole("heading", { name: "Attack surface" })).toBeTruthy();
    expect(await screen.findByText(/No services have been observed/i)).toBeTruthy();
    expect(screen.getByText("Services").previousElementSibling?.textContent).toBe("0");
    expect(screen.getByText("Hosts").previousElementSibling?.textContent).toBe("0");
    expect(screen.getByText("Evidence artifacts").previousElementSibling?.textContent).toBe("0");
    expect(screen.getByText("Latest observation")).toBeTruthy();
    expect(screen.queryByText("Runs")).toBeNull();
  });

  it("organizes services by selected target and renders identity with provenance", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response([serviceA, serviceB]))));
    renderSurface();
    expect(await screen.findByRole("heading", { name: "Attack surface" })).toBeTruthy();
    expect((await screen.findAllByRole("button", { name: /192\.0\.2\.2/ })).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /192\.0\.2\.10/ })).toBeTruthy();
    expect(screen.getByText("Services").previousElementSibling?.textContent).toBe("2");
    expect(screen.getByText("Hosts").previousElementSibling?.textContent).toBe("2");
    expect(screen.getByText("Evidence artifacts").previousElementSibling?.textContent).toBe("2");
    expect(screen.getByText("Latest observation").previousElementSibling?.textContent).toMatch(/11:00/);
    expect(screen.getAllByText(/13 Aug 2026/i).length).toBeGreaterThanOrEqual(1);

    // The first target sorts first and shows alone: no reconciling tables.
    expect(screen.getByText("443/tcp")).toBeTruthy();
    expect(screen.getAllByText("unknown").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("22/tcp")).toBeNull();
    expect(screen.getAllByText("Provenance")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /192\.0\.2\.10/ }));
    expect(screen.getByText("host-a.test")).toBeTruthy();
    expect(screen.getByText("22/tcp")).toBeTruthy();
    expect(screen.queryByText("443/tcp")).toBeNull();
    expect(screen.getByText("OpenSSH 9.6")).toBeTruthy();
    expect(screen.getAllByText("ssh").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Provenance").length).toBe(1);
    expect(screen.getAllByText("run-1").length).toBeGreaterThan(0);
    expect(screen.getAllByText(`sha256:${"a".repeat(64)}`).length).toBeGreaterThan(0);
    expect(screen.getAllByText("artifactDigest").length).toBeGreaterThan(0);
  });

  it("links each service row to its source XML evidence", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response([serviceA, serviceB]))));
    renderSurface();
    expect(await screen.findByRole("heading", { name: "Attack surface" })).toBeTruthy();

    let links = await screen.findAllByRole("link", { name: "XML" });
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe(
      `/api/v1/engagements/${engagementId}/artifacts/artifact-2/content`,
    );

    fireEvent.click(screen.getByRole("button", { name: /192\.0\.2\.10/ }));
    links = screen.getAllByRole("link", { name: "XML" });
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe(
      `/api/v1/engagements/${engagementId}/artifacts/artifact-1/content`,
    );
    for (const link of links) {
      expect(link.hasAttribute("download")).toBe(true);
    }
  });

  it("shows recoverable error without cached data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ json: async () => ({ code: "storage_busy" }), ok: false, status: 503 } as Response)),
    );
    renderSurface();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Attack surface unavailable" })).toBeTruthy();
    expect(screen.queryByText(ENGAGEMENT_SERVICES_QUERY_ERROR_MESSAGE)).toBeNull();
  });

  it("preserves cached data with stale warning on refresh failure", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(response([serviceA])));
    vi.stubGlobal("fetch", fetchMock);
    renderSurface();
    expect((await screen.findAllByText("192.0.2.10")).length).toBeGreaterThanOrEqual(1);
    fetchMock.mockImplementation(
      () => Promise.resolve({ json: async () => ({ code: "storage_busy" }), ok: false, status: 503 } as Response),
    );
    await queryClient.refetchQueries();
    await waitFor(() => expect(screen.getByText("Showing the last successful attack surface")).toBeTruthy());
    expect(screen.getAllByText("192.0.2.10").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });

  it("validates untrusted JSON and hides secrets", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response([{ ...serviceA, secret: "/private/path" }]))));
    renderSurface();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("secret")).toBeNull();
    expect(screen.queryByText("private")).toBeNull();
  });

  it("keys service rows by the canonical selection identity including protocol", async () => {
    const first = {
      ...serviceA,
      port: 53,
      serviceName: "domain",
      runId: "run-1",
      artifactId: "artifact-1",
      artifactDigest: `sha256:${"a".repeat(64)}`,
    };
    const second = {
      ...serviceA,
      port: 53,
      serviceName: "domain",
      runId: "run-2",
      artifactId: "artifact-2",
      artifactDigest: `sha256:${"b".repeat(64)}`,
    };
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response([first, second]))));
    const { container } = renderSurface();
    expect((await screen.findAllByText("53/tcp")).length).toBe(2);
    const rowKeys = [...container.querySelectorAll("[data-surface-row]")]
      .map((node) => node.getAttribute("data-surface-row"))
      .filter((key) => key?.startsWith("service:"));
    expect(rowKeys).toHaveLength(2);
    expect(rowKeys).toContain(
      serviceSelectionKey(first.address, first.port, first.protocol, first.artifactId),
    );
    expect(rowKeys).toContain(
      serviceSelectionKey(second.address, second.port, second.protocol, second.artifactId),
    );
  });

  it("retains the observed https scheme for ffuf-only discoveries on nonstandard ports", async () => {
    const web8080 = {
      ...serviceA,
      address: "192.0.2.10",
      port: 8080,
      serviceName: "http-proxy",
      hostname: null,
    };
    vi.stubGlobal(
      "fetch",
      routeSurfaceResponses([web8080], [], [ffufPath("https://192.0.2.10:8080/admin")]),
    );
    renderSurface();
    const browserLink = await screen.findByRole("link", { name: "Open in browser" });
    expect(browserLink.getAttribute("href")).toBe("https://192.0.2.10:8080");
    expect(screen.getByLabelText("Scheme for 192.0.2.10:8080")).toHaveProperty("value", "https");
  });

  it("keeps the probe scheme when probes and paths disagree on one origin", async () => {
    const probe = httpProbe("http://192.0.2.10:8080/");
    vi.stubGlobal(
      "fetch",
      routeSurfaceResponses([], [probe], [ffufPath("https://192.0.2.10:8080/admin")]),
    );
    renderSurface();
    const browserLink = await screen.findByRole("link", { name: "Open in browser" });
    expect(browserLink.getAttribute("href")).toBe("http://192.0.2.10:8080");
  });

  it("keeps the observed scheme when several runs probe one origin", async () => {
    const web8080 = {
      ...serviceA,
      address: "192.0.2.10",
      port: 8080,
      serviceName: "http-proxy",
      hostname: null,
    };
    vi.stubGlobal(
      "fetch",
      routeSurfaceResponses(
        [web8080],
        [
          httpProbe("https://192.0.2.10:8080/", "artifact-7"),
          httpProbe("https://192.0.2.10:8080/", "artifact-8"),
        ],
        [],
      ),
    );
    renderSurface();
    const browserLink = await screen.findByRole("link", { name: "Open in browser" });
    expect(browserLink.getAttribute("href")).toBe("https://192.0.2.10:8080");
  });

  it("renders hostname-addressed observations under the observed hostname", async () => {
    const web443 = {
      ...serviceA,
      address: "192.0.2.10",
      port: 443,
      serviceName: "https",
      hostname: "app.example.test",
    };
    vi.stubGlobal(
      "fetch",
      routeSurfaceResponses([web443], [httpProbe("https://app.example.test/")], []),
    );
    renderSurface();
    const browserLink = await screen.findByRole("link", { name: "Open in browser" });
    expect(browserLink.getAttribute("href")).toBe("https://app.example.test");
  });

  it("calls stale cached web observations stale instead of absent", async () => {
    const probe = httpProbe("https://192.0.2.10:8443/");
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/services")) return Promise.resolve(response([serviceA]));
      if (url.endsWith("/http-probes")) return Promise.resolve(response([probe]));
      if (url.endsWith("/ffuf-results")) return Promise.resolve(response([]));
      return Promise.resolve(response({ code: "invalid_request" }, 400));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSurface();
    expect(await screen.findByText("Services")).toBeTruthy();
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/http-probes")) {
        return Promise.resolve(response({ code: "storage_busy" }, 503));
      }
      if (url.endsWith("/services")) return Promise.resolve(response([serviceA]));
      if (url.endsWith("/ffuf-results")) return Promise.resolve(response([]));
      return Promise.resolve(response({ code: "invalid_request" }, 400));
    });
    await queryClient.refetchQueries();
    await waitFor(() => {
      expect(screen.getByText("Showing the last successful attack surface")).toBeTruthy();
    });
    expect(screen.getByText(/Web probes are stale/)).toBeTruthy();
    expect(screen.queryByText(/Showing services only/)).toBeNull();
  });

  it("reports never-loaded web observations as absent", async () => {
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/services")) return Promise.resolve(response([serviceA]));
      if (url.endsWith("/ffuf-results")) return Promise.resolve(response([]));
      return Promise.resolve(response({ code: "storage_busy" }, 503));
    });
    renderSurface();
    await waitFor(() => {
      expect(screen.getByText(/could not be loaded\. Showing services only/)).toBeTruthy();
    });
  });

  it("renders a shared-hostname observation once under its own target", async () => {
    const first = {
      ...serviceA,
      address: "192.0.2.10",
      port: 80,
      serviceName: "http",
      hostname: "shared.test",
      artifactId: "artifact-1",
      artifactDigest: `sha256:${"a".repeat(64)}`,
    };
    const second = {
      ...serviceA,
      address: "192.0.2.20",
      port: 80,
      serviceName: "http",
      hostname: "shared.test",
      artifactId: "artifact-2",
      artifactDigest: `sha256:${"b".repeat(64)}`,
    };
    vi.stubGlobal(
      "fetch",
      routeSurfaceResponses([first, second], [httpProbe("https://shared.test:80/")], []),
    );
    const { container } = renderSurface();
    const targets = await screen.findByRole("group", { name: "Targets" });
    const targetButton = (pattern: RegExp) => within(targets).getByRole("button", { name: pattern });
    expect(targetButton(/192\.0\.2\.10/)).toBeTruthy();
    const sharedOrigin = 'a[href="https://shared.test:80"]';
    expect(container.querySelector(sharedOrigin)).toBeNull();
    expect(screen.getByText(/Not probed yet/)).toBeTruthy();

    fireEvent.click(targetButton(/shared\.test/));
    await waitFor(() => {
      expect(container.querySelectorAll(sharedOrigin)).toHaveLength(1);
    });

    fireEvent.click(targetButton(/192\.0\.2\.20/));
    await waitFor(() => {
      expect(container.querySelector(sharedOrigin)).toBeNull();
    });
  });
});
