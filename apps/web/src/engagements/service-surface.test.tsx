// @vitest-environment jsdom
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { ENGAGEMENT_SERVICES_QUERY_ERROR_MESSAGE } from "./errors.js";
import { pathSelectionKey, probeSelectionKey, serviceSelectionKey } from "./inspector.js";
import { engagementFfufResultsQueryKey } from "./query.js";
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
  it("isolates ephemeral filtering when switching engagements", async () => {
    const paths = [ffufPath("http://192.0.2.10/admin"), ffufPath("http://192.0.2.10/login")];
    vi.stubGlobal("fetch", routeSurfaceResponses([], [], paths));
    const surface = (id: string) => <QueryClientProvider client={queryClient}>
      <EngagementServicesSection engagementId={id} />
    </QueryClientProvider>;
    const { rerender } = render(surface(engagementId));
    const first = await screen.findByRole("region", { name: "Path responses from run run-1, artifact artifact-9" });
    fireEvent.click(within(first).getByRole("button", { name: "Hide" }));
    expect(within(first).getByText("2 results · 2 hidden")).toBeTruthy();
    rerender(surface("20000000-0000-4000-8000-000000000002"));
    const next = await screen.findByRole("region", { name: "Path responses from run run-1, artifact artifact-9" });
    expect(within(next).getByText("2 results · 0 hidden")).toBeTruthy();
  });

  it("keeps status, length, words and lines differences as separate results", async () => {
    const base = ffufPath("http://192.0.2.10/admin");
    const paths = [base, { ...base, url: "http://192.0.2.10/login" },
      { ...base, url: "http://192.0.2.10/status", status: 404 },
      { ...base, url: "http://192.0.2.10/length", length: 1235 },
      { ...base, url: "http://192.0.2.10/words", words: 11 },
      { ...base, url: "http://192.0.2.10/lines", lines: 6 }];
    vi.stubGlobal("fetch", routeSurfaceResponses([], [], paths)); renderSurface();
    const context = await screen.findByRole("region", { name: "Path responses from run run-1, artifact artifact-9" });
    expect(within(context).getAllByRole("button", { name: "Expand" })).toHaveLength(1);
    for (const path of paths.slice(2)) expect(within(context).getByRole("button", { name: path.url })).toBeTruthy();
  });

  it("groups exact metadata, retains singleton actions, and restores hidden rows without network calls", async () => {
    const paths = [ffufPath("http://192.0.2.10/admin"), ffufPath("http://192.0.2.10/login"),
      { ...ffufPath("http://192.0.2.10/secret"), status: 403 }];
    const fetchMock = routeSurfaceResponses([], [], paths);
    vi.stubGlobal("fetch", fetchMock); renderSurface();
    const context = await screen.findByRole("region", { name: "Path responses from run run-1, artifact artifact-9" });
    expect(within(context).getByText("2 results · status 200, length 1234, words 10, lines 5")).toBeTruthy();
    expect(within(context).queryByText(paths[0]!.url)).toBeNull();
    expect(within(context).getByRole("button", { name: paths[2]!.url })).toBeTruthy();
    const calls = fetchMock.mock.calls.length;
    fireEvent.click(within(context).getByRole("button", { name: "Expand" }));
    expect(within(context).getByRole("button", { name: paths[0]!.url })).toBeTruthy();
    const hide = within(context).getByRole("button", { name: "Hide" });
    hide.focus(); fireEvent.click(hide);
    expect(within(context).getByText("3 results · 2 hidden")).toBeTruthy();
    expect(within(context).queryByText(paths[0]!.url)).toBeNull();
    expect(document.activeElement).toBe(within(context).getByRole("button", { name: "Restore" }));
    fireEvent.click(within(context).getByRole("button", { name: "Restore" }));
    expect(within(context).getByRole("button", { name: paths[0]!.url })).toBeTruthy();
    fireEvent.click(within(context).getByRole("button", { name: "Hide" }));
    fireEvent.click(within(context).getByRole("button", { name: "Show all results" }));
    expect(within(context).getByText("3 results · 0 hidden")).toBeTruthy();
    expect(within(context).getAllByRole("link", { name: "Raw evidence" })).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });

  it("keeps a hidden selected result in the inspector with exact evidence and selection", async () => {
    const paths = [ffufPath("http://192.0.2.10/admin"), ffufPath("http://192.0.2.10/login")];
    vi.stubGlobal("fetch", routeSurfaceResponses([], [], paths)); renderSurface();
    const context = await screen.findByRole("region", { name: "Path responses from run run-1, artifact artifact-9" });
    fireEvent.click(within(context).getByRole("button", { name: "Expand" }));
    const row = within(context).getByRole("button", { name: paths[0]!.url }).closest("[data-surface-row]");
    expect(row?.getAttribute("data-surface-row")).toBe(pathSelectionKey(paths[0]!.url, paths[0]!.artifactId));
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Inspect" }));
    const inspector = await screen.findByRole("complementary", { name: "Selection inspector" });
    expect(within(inspector).getByRole("link", { name: "Raw evidence" }).getAttribute("href"))
      .toBe(`/api/v1/engagements/${engagementId}/artifacts/artifact-9/content`);
    fireEvent.click(within(context).getByRole("button", { name: "Hide" }));
    expect(screen.getByRole("complementary", { name: "Selection inspector" })).toBe(inspector);
    expect(within(inspector).getAllByText(paths[0]!.url)).toBeTruthy();
  });

  it("isolates matching metadata by run and artifact, preserving duplicate-URL evidence", async () => {
    const a = [ffufPath("http://192.0.2.10/admin"), ffufPath("http://192.0.2.10/login")];
    const b = a.map((path) => ({ ...path, artifactId: "artifact-10" }));
    const c = a.map((path) => ({ ...path, runId: "run-2", artifactId: "artifact-11" }));
    vi.stubGlobal("fetch", routeSurfaceResponses([], [], [...a, ...b])); renderSurface();
    const first = await screen.findByRole("region", { name: "Path responses from run run-1, artifact artifact-9" });
    const second = screen.getByRole("region", { name: "Path responses from run run-1, artifact artifact-10" });
    fireEvent.click(within(first).getByRole("button", { name: "Hide" }));
    expect(within(first).getByText("All results hidden.")).toBeTruthy();
    expect(within(second).getByText("2 results · 0 hidden")).toBeTruthy();
    fireEvent.click(within(second).getByRole("button", { name: "Expand" }));
    expect(within(second).getAllByRole("link", { name: "Raw evidence" })[0]?.getAttribute("href"))
      .toBe(`/api/v1/engagements/${engagementId}/artifacts/artifact-10/content`);
    queryClient.setQueryData(engagementFfufResultsQueryKey(engagementId), [...a, ...b, ...c]);
    const third = await screen.findByRole("region", { name: "Path responses from run run-2, artifact artifact-11" });
    expect(within(third).getByText("2 results · 0 hidden")).toBeTruthy();
    expect(within(third).getByRole("button", { name: "Expand" }).getAttribute("aria-expanded")).toBe("false");
    expect(within(first).getByText("2 results · 2 hidden")).toBeTruthy();
  });

  it("isolates filters by observed scheme and allows archived presentation filtering", async () => {
    const http = [ffufPath("http://192.0.2.10/admin"), ffufPath("http://192.0.2.10/login")];
    const https = http.map((path) => ({ ...path, url: path.url.replace("http:", "https:") }));
    const fetchMock = routeSurfaceResponses([], [], [...http, ...https]);
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<QueryClientProvider client={queryClient}>
      <EngagementServicesSection archived engagementId={engagementId} />
    </QueryClientProvider>);
    await screen.findAllByRole("region", { name: "Path responses from run run-1, artifact artifact-9" });
    const httpBlock = container.querySelector('[data-surface-origin="http://192.0.2.10"]');
    const httpsBlock = container.querySelector('[data-surface-origin="https://192.0.2.10"]');
    expect(httpBlock).toBeTruthy(); expect(httpsBlock).toBeTruthy();
    const calls = fetchMock.mock.calls.length;
    fireEvent.click(within(httpBlock as HTMLElement).getByRole("button", { name: "Hide" }));
    expect(within(httpBlock as HTMLElement).getByText("2 results · 2 hidden")).toBeTruthy();
    expect(within(httpsBlock as HTMLElement).getByText("2 results · 0 hidden")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });

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
    expect(screen.getByTestId("engagement-totals").textContent).toBe(
      "0 services · 0 hosts · 0 evidence artifacts",
    );
    expect(screen.queryByText("Runs")).toBeNull();
  });

  it("organizes services by selected target and renders identity with provenance", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response([serviceA, serviceB]))));
    renderSurface();
    expect(await screen.findByRole("heading", { name: "Attack surface" })).toBeTruthy();
    expect((await screen.findAllByRole("button", { name: /192\.0\.2\.2/ })).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /192\.0\.2\.10/ })).toBeTruthy();
    expect(screen.getByTestId("engagement-totals").textContent).toMatch(
      /^2 services · 2 hosts · 2 evidence artifacts · latest 13 Aug 2026, 11:00 UTC$/,
    );
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
    expect(screen.getByLabelText("Scheme for https://192.0.2.10:8080")).toHaveProperty("value", "https");
  });

  it("keeps disagreeing probe and path origins as separate blocks", async () => {
    const probe = httpProbe("http://192.0.2.10:8080/");
    vi.stubGlobal(
      "fetch",
      routeSurfaceResponses([], [probe], [ffufPath("https://192.0.2.10:8080/admin")]),
    );
    renderSurface();
    const links = await screen.findAllByRole("link", { name: "Open in browser" });
    const hrefs = links.map((link) => link.getAttribute("href")).sort();
    expect(hrefs).toEqual(["http://192.0.2.10:8080", "https://192.0.2.10:8080"]);
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

  it("keeps mixed IP and hostname observations on one service as separate origins", async () => {
    const web443 = {
      ...serviceA,
      address: "192.0.2.10",
      port: 443,
      serviceName: "https",
      hostname: "app.example.test",
    };
    vi.stubGlobal(
      "fetch",
      routeSurfaceResponses(
        [web443],
        [
          httpProbe("https://192.0.2.10/", "artifact-7"),
          httpProbe("https://192.0.2.10/", "artifact-8"),
          httpProbe("https://app.example.test/", "artifact-9"),
        ],
        [],
      ),
    );
    renderSurface();
    const links = await screen.findAllByRole("link", { name: "Open in browser" });
    const hrefs = links.map((link) => link.getAttribute("href")).sort();
    // Repeated IP observations share one block; the hostname observation
    // keeps its own authority instead of falling back to the IP.
    expect(hrefs).toEqual(["https://192.0.2.10", "https://app.example.test"]);
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
    expect(await screen.findByTestId("engagement-totals")).toBeTruthy();
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

  it("names which result set is stale when only one side has cached data", async () => {
    const probe = httpProbe("https://192.0.2.10:8443/");
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/services")) return Promise.resolve(response([serviceA]));
      if (url.endsWith("/http-probes")) return Promise.resolve(response([probe]));
      return Promise.resolve(response({ code: "storage_busy" }, 503));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSurface();
    expect(await screen.findByTestId("engagement-totals")).toBeTruthy();
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/services")) return Promise.resolve(response([serviceA]));
      return Promise.resolve(response({ code: "storage_busy" }, 503));
    });
    await queryClient.refetchQueries();
    await waitFor(() => {
      expect(
        screen.getByText(/Web probes are stale\. Path discovery results could not be loaded/),
      ).toBeTruthy();
    });
    expect(screen.queryByText(/results are stale\. Showing the last successful load/)).toBeNull();
  });

  it("counts web origins by scheme and authority, not host and port", async () => {
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
        [httpProbe("http://192.0.2.10:8080/")],
        [ffufPath("https://192.0.2.10:8080/admin")],
      ),
    );
    renderSurface();
    const target = await screen.findByRole("button", { name: /192\.0\.2\.10.*2 web/ });
    expect(target.textContent).toMatch(/1 paths/);
  });

  it("keeps overridden and observed scheme blocks on distinct controls", async () => {
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
        [httpProbe("http://192.0.2.10:8080/")],
        [ffufPath("https://192.0.2.10:8080/admin")],
      ),
    );
    const { container } = renderSurface();
    const httpLabel = "Scheme for http://192.0.2.10:8080";
    const httpsLabel = "Scheme for https://192.0.2.10:8080";
    expect(await screen.findByLabelText(httpLabel)).toBeTruthy();
    expect(screen.getByLabelText(httpsLabel)).toBeTruthy();
    // Overriding the HTTP block to HTTPS must not merge control identity
    // with the already observed HTTPS block.
    fireEvent.change(screen.getByLabelText(httpLabel), { target: { value: "https" } });
    await waitFor(() => {
      expect(screen.getByLabelText(httpLabel)).toBeTruthy();
    });
    expect(screen.getByLabelText(httpsLabel)).toBeTruthy();
    const rows = [...container.querySelectorAll("[data-surface-row]")].map((node) =>
      node.getAttribute("data-surface-row"),
    );
    expect(new Set(rows).size).toBe(rows.length);
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

  it("renders one origin block for repeated artifacts sharing an endpoint", async () => {
    const first = {
      ...serviceA,
      address: "192.0.2.10",
      port: 80,
      serviceName: "http",
      hostname: null,
      artifactId: "artifact-1",
      artifactDigest: `sha256:${"a".repeat(64)}`,
    };
    const second = {
      ...serviceA,
      address: "192.0.2.10",
      port: 80,
      serviceName: "http",
      hostname: null,
      artifactId: "artifact-2",
      artifactDigest: `sha256:${"b".repeat(64)}`,
    };
    vi.stubGlobal(
      "fetch",
      routeSurfaceResponses([first, second], [httpProbe("http://192.0.2.10:80/")], []),
    );
    const { container } = renderSurface();
    const label = "Scheme for http://192.0.2.10:80";
    expect(await screen.findByLabelText(label)).toBeTruthy();
    expect(screen.queryAllByLabelText(label)).toHaveLength(1);
    const rows = [...container.querySelectorAll("[data-surface-row]")].map((node) =>
      node.getAttribute("data-surface-row"),
    );
    expect(new Set(rows).size).toBe(rows.length);
    // Both artifacts keep their own service row.
    expect(rows).toContain(serviceSelectionKey("192.0.2.10", 80, "tcp", "artifact-1"));
    expect(rows).toContain(serviceSelectionKey("192.0.2.10", 80, "tcp", "artifact-2"));
  });

  it("restores focus to an externally opened probe row on inspector close", async () => {
    const web80 = {
      ...serviceA,
      address: "192.0.2.10",
      port: 80,
      serviceName: "http",
      hostname: null,
    };
    const probe = httpProbe("http://192.0.2.10:80/");
    const rowKey = probeSelectionKey(probe.url, probe.artifactId);
    vi.stubGlobal("fetch", routeSurfaceResponses([web80], [probe], []));
    const onSelectKey = vi.fn();
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <EngagementServicesSection
          engagementId={engagementId}
          onSelectKey={onSelectKey}
          selectedKey={rowKey}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Close inspector" }));
    expect(onSelectKey).toHaveBeenCalledWith(undefined);
    // The route owner clears the selection, unmounting the inspector.
    rerender(
      <QueryClientProvider client={queryClient}>
        <EngagementServicesSection engagementId={engagementId} onSelectKey={onSelectKey} />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      const active = document.activeElement;
      expect(
        active instanceof HTMLElement
          ? active.closest("[data-surface-row]")?.getAttribute("data-surface-row")
          : null,
      ).toBe(rowKey);
    });
  });

  it("clears launcher return context so inspector close targets its own row", async () => {
    const web80 = {
      ...serviceA,
      address: "192.0.2.10",
      port: 80,
      serviceName: "http",
      hostname: null,
    };
    const probe = httpProbe("http://192.0.2.10:80/");
    const rowKey = probeSelectionKey(probe.url, probe.artifactId);
    vi.stubGlobal("fetch", routeSurfaceResponses([web80], [probe], []));
    const onSelectKey = vi.fn();
    const surface = (selectedKey: string | undefined) => (
      <QueryClientProvider client={queryClient}>
        <EngagementServicesSection
          engagementId={engagementId}
          onSelectKey={onSelectKey}
          selectedKey={selectedKey}
        />
      </QueryClientProvider>
    );
    const { container, rerender } = render(surface(rowKey));
    await screen.findByRole("button", { name: "Close inspector" });
    // Borrow the shared return context through the launcher, then close it.
    const originBlock = container.querySelector('[data-surface-row^="origin:"]');
    expect(originBlock instanceof HTMLElement).toBe(true);
    fireEvent.click(
      within(originBlock as HTMLElement).getByRole("button", { name: "Discover paths" }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog as HTMLElement).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    // Close the inspector for the externally opened probe selection.
    fireEvent.click(screen.getByRole("button", { name: "Close inspector" }));
    expect(onSelectKey).toHaveBeenCalledWith(undefined);
    rerender(surface(undefined));
    await waitFor(() => {
      const active = document.activeElement;
      expect(
        active instanceof HTMLElement
          ? active.closest("[data-surface-row]")?.getAttribute("data-surface-row")
          : null,
      ).toBe(rowKey);
    });
  });
});
