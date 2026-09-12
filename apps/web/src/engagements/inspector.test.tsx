// @vitest-environment jsdom
import type { PersistedAction } from "@stonehush/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import {
  PausedRunWarning,
  SurfaceInspector,
  decodeSurfaceSelection,
  defaultSchemeForPort,
  focusSurfaceRow,
  isServiceRowSelected,
  launcherWarningKind,
  serviceSelectionKey,
  isWebServiceCandidate,
  parseOriginScheme,
  pathInspectorRecord,
  probeInspectorRecord,
  restoreSurfacePosition,
  serviceInspectorRecord,
  splitOriginUrl,
  withOriginScheme,
} from "./inspector.js";

const engagementId = "10000000-0000-4000-8000-000000000001";

function launchedAction(
  state: PersistedAction["action"]["state"],
  pendingWarning: PersistedAction["action"]["pendingWarning"] = null,
): PersistedAction {
  return { action: { state, pendingWarning } } as PersistedAction;
}

const queuedAction = launchedAction("queued");
const pausedAction = launchedAction("paused_for_warning", {
  reasonCodes: ["outside_scope"],
  knownAdditions: [],
  pendingEventId: null,
});
const activePausedAction = launchedAction("active_paused_for_warning", {
  reasonCodes: ["outside_scope"],
  knownAdditions: [],
  pendingEventId: 7,
});
const succeededAction = launchedAction("succeeded");

const webService = {
  address: "192.0.2.10",
  port: 80,
  protocol: "tcp" as const,
  hostname: "lab.test",
  serviceName: "http",
  product: "nginx",
  version: "1.25",
  source: "nmap" as const,
  parserVersion: "nmap-xml-v1",
  runId: "run-1",
  artifactId: "artifact-1",
  artifactDigest: `sha256:${"a".repeat(64)}`,
  observedAt: "2026-08-13T12:00:00.000Z",
};

const sshService = {
  ...webService,
  port: 22,
  serviceName: "ssh",
  product: "OpenSSH",
  version: "9.6",
};

const probe = {
  source: "http-probe" as const,
  parserVersion: "http-probe-raw-v1" as const,
  url: "http://192.0.2.10/",
  fetchedAt: "2026-09-03T00:00:00.000Z",
  finalUrl: "http://192.0.2.10/",
  status: 200,
  title: "Lab Box",
  selectedHeaders: { contentType: "text/html", server: "nginx", poweredBy: null },
  hops: [{ url: "http://192.0.2.10/", status: 200, location: null }],
  error: null,
  runId: "run-2",
  artifactId: "artifact-2",
  artifactDigest: `sha256:${"b".repeat(64)}`,
  observedAt: "2026-09-03T00:00:00.000Z",
};

const pathResult = {
  source: "ffuf" as const,
  parserVersion: "ffuf-json-v1" as const,
  url: "http://192.0.2.10/admin",
  status: 200,
  length: 128,
  words: 4,
  lines: 8,
  redirectlocation: null,
  fuzz: "admin",
  runId: "run-3",
  artifactId: "artifact-3",
  artifactDigest: `sha256:${"c".repeat(64)}`,
  observedAt: "2026-09-03T01:00:00.000Z",
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
  Object.defineProperty(window, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(window, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubFindings(records: unknown[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/findings")) return Promise.resolve(response(records));
      return Promise.resolve(response({ code: "invalid_request" }, 400));
    }),
  );
}

function renderInspector(
  record: Parameters<typeof SurfaceInspector>[0]["record"],
  overrides: Partial<Parameters<typeof SurfaceInspector>[0]> = {},
) {
  const onClose = overrides.onClose ?? vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <SurfaceInspector
        engagementId={engagementId}
        loading={false}
        onClose={onClose}
        record={record}
        selectionKey={record?.key ?? "service:192.0.2.10:80"}
        {...overrides}
      />
    </QueryClientProvider>,
  );
  return { onClose };
}

describe("surface selection keys", () => {
  it("round-trips service, probe, and path keys", () => {
    expect(decodeSurfaceSelection("service:192.0.2.10:80")).toEqual({
      kind: "service",
      key: "service:192.0.2.10:80",
      address: "192.0.2.10",
      port: 80,
    });
    expect(decodeSurfaceSelection("probe:http://192.0.2.10/")).toEqual({
      kind: "probe",
      key: "probe:http://192.0.2.10/",
      url: "http://192.0.2.10/",
    });
    expect(decodeSurfaceSelection("path:http://192.0.2.10/admin")).toEqual({
      kind: "path",
      key: "path:http://192.0.2.10/admin",
      url: "http://192.0.2.10/admin",
    });
  });

  it("decodes provenance-aware keys with artifact and protocol", () => {
    expect(decodeSurfaceSelection("service:192.0.2.10:80:tcp:artifact-1")).toEqual({
      kind: "service",
      key: "service:192.0.2.10:80:tcp:artifact-1",
      address: "192.0.2.10",
      port: 80,
      protocol: "tcp",
      artifactId: "artifact-1",
    });
    expect(decodeSurfaceSelection("service:[2001:db8::1]:80:tcp:artifact-1")).toEqual({
      kind: "service",
      key: "service:[2001:db8::1]:80:tcp:artifact-1",
      address: "2001:db8::1",
      port: 80,
      protocol: "tcp",
      artifactId: "artifact-1",
    });
    expect(decodeSurfaceSelection("probe:artifact-2:http://192.0.2.10/")).toEqual({
      kind: "probe",
      key: "probe:artifact-2:http://192.0.2.10/",
      artifactId: "artifact-2",
      url: "http://192.0.2.10/",
    });
    expect(decodeSurfaceSelection("path:artifact-3:http://192.0.2.10/admin")).toEqual({
      kind: "path",
      key: "path:artifact-3:http://192.0.2.10/admin",
      artifactId: "artifact-3",
      url: "http://192.0.2.10/admin",
    });
  });

  it("distinguishes repeated observations of identical address and port", () => {
    const firstScan = { ...webService, artifactId: "art-1" };
    const secondScan = { ...webService, artifactId: "art-2" };
    const all = [firstScan, secondScan];
    const firstKey = serviceSelectionKey(firstScan.address, firstScan.port, firstScan.protocol, firstScan.artifactId);
    const secondKey = serviceSelectionKey(secondScan.address, secondScan.port, secondScan.protocol, secondScan.artifactId);
    expect(isServiceRowSelected(firstScan, firstKey, all)).toBe(true);
    expect(isServiceRowSelected(secondScan, firstKey, all)).toBe(false);
    expect(isServiceRowSelected(firstScan, secondKey, all)).toBe(false);
    expect(isServiceRowSelected(secondScan, secondKey, all)).toBe(true);
    // Ambiguous old key matches multiple scans: neither is selected
    const oldKey = "service:192.0.2.10:80";
    expect(isServiceRowSelected(firstScan, oldKey, all)).toBe(false);
    expect(isServiceRowSelected(secondScan, oldKey, all)).toBe(false);
    // Unambiguous old key matches single scan: selected
    expect(isServiceRowSelected(firstScan, oldKey, [firstScan])).toBe(true);
  });

  it("rejects unknown kinds, bad ports, and non-http targets", () => {
    expect(decodeSurfaceSelection(undefined)).toBeUndefined();
    expect(decodeSurfaceSelection("")).toBeUndefined();
    expect(decodeSurfaceSelection("lead:abc")).toBeUndefined();
    expect(decodeSurfaceSelection("service:192.0.2.10")).toBeUndefined();
    expect(decodeSurfaceSelection("service:192.0.2.10:0")).toBeUndefined();
    expect(decodeSurfaceSelection("service:192.0.2.10:99999")).toBeUndefined();
    expect(decodeSurfaceSelection("service:192.0.2.10:http")).toBeUndefined();
    expect(decodeSurfaceSelection("probe:ftp://example.test/")).toBeUndefined();
    expect(decodeSurfaceSelection("probe:not-a-url")).toBeUndefined();
    expect(decodeSurfaceSelection("noseparator")).toBeUndefined();
  });
});

describe("origin helpers", () => {
  it("splits origins with default-port normalization", () => {
    expect(splitOriginUrl("http://Example.TEST:80/a")).toEqual({
      origin: "http://example.test",
      host: "example.test",
      port: 80,
      scheme: "http",
    });
    expect(splitOriginUrl("https://example.test:8443/a")).toEqual({
      origin: "https://example.test:8443",
      host: "example.test",
      port: 8443,
      scheme: "https",
    });
    expect(splitOriginUrl("https://example.test/a")).toEqual({
      origin: "https://example.test",
      host: "example.test",
      port: 443,
      scheme: "https",
    });
    expect(splitOriginUrl("ftp://example.test/")).toBeUndefined();
    expect(splitOriginUrl("not a url")).toBeUndefined();
  });

  it("reads and rewrites the visible scheme", () => {
    expect(parseOriginScheme("https://example.test")).toBe("https");
    expect(parseOriginScheme("http://example.test:8080")).toBe("http");
    expect(withOriginScheme("http://example.test:8080", "https")).toBe(
      "https://example.test:8080",
    );
    expect(withOriginScheme("https://example.test", "http")).toBe("http://example.test");
    expect(withOriginScheme("http://[2001:db8::1]", "https")).toBe("https://[2001:db8::1]");
    expect(withOriginScheme("http://[2001:db8::1]:8080/query?a=1", "https")).toBe(
      "https://[2001:db8::1]:8080/query?a=1",
    );
    expect(withOriginScheme("2001:db8::1", "http")).toBe("http://[2001:db8::1]");
    expect(withOriginScheme("[2001:db8::1]:80", "http")).toBe("http://[2001:db8::1]");
    expect(withOriginScheme("[2001:db8::1]:80", "https")).toBe("https://[2001:db8::1]:80");
  });

  it("keeps invalid ports verbatim so validation rejects the target", () => {
    // An unparseable or out-of-range port must never be dropped: dropping it
    // would submit a different endpoint than the operator typed.
    const invalid = [
      "http://host:bad",
      "host:80abc",
      "host:99999",
      "http://[2001:db8::1]:bad",
      "[2001:db8::1]:80abc",
      "[2001:db8::1]junk",
      "http://host:0",
    ];
    for (const origin of invalid) {
      for (const scheme of ["http", "https"] as const) {
        expect(splitOriginUrl(withOriginScheme(origin, scheme))).toBeUndefined();
      }
    }
    // Valid ports still normalize, including default-port elision.
    expect(withOriginScheme("http://host:8080", "https")).toBe("https://host:8080");
    expect(withOriginScheme("http://host:80", "http")).toBe("http://host");
  });

  it("maps launcher warning display to the current action state", () => {
    expect(launcherWarningKind(undefined)).toBe("none");
    expect(launcherWarningKind(queuedAction)).toBe("none");
    expect(launcherWarningKind(pausedAction)).toBe("warning-card");
    expect(launcherWarningKind(activePausedAction)).toBe("paused-run");
    expect(launcherWarningKind(succeededAction)).toBe("none");
  });

  it("shows the paused run warning without Continue or Add to scope", () => {
    render(<PausedRunWarning action={activePausedAction} />);
    expect(screen.getByRole("heading", { name: "Action paused for warning" })).toBeTruthy();
    expect(screen.getByText(/outside the saved scope/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(screen.queryByRole("button", { name: /scope/i })).toBeNull();
  });

  it("detects web candidates and port defaults", () => {
    expect(isWebServiceCandidate(webService)).toBe(true);
    expect(isWebServiceCandidate(sshService)).toBe(false);
    expect(isWebServiceCandidate({ ...sshService, port: 8080 })).toBe(true);
    expect(defaultSchemeForPort(443)).toBe("https");
    expect(defaultSchemeForPort(8443)).toBe("https");
    expect(defaultSchemeForPort(80)).toBe("http");
    expect(defaultSchemeForPort(8080)).toBe("http");
  });
});

describe("surface focus helpers", () => {
  it("focuses the row button and restores scroll", () => {
    const scrollTo = window.scrollTo as ReturnType<typeof vi.fn>;
    document.body.innerHTML =
      `<div data-surface-row="service:192.0.2.10:80"><button type="button">row</button></div>` +
      `<div data-surface-row="probe:http://x/"><span>plain</span></div>`;
    const button = document.querySelector("button");
    expect(button).not.toBeNull();
    expect(focusSurfaceRow("service:192.0.2.10:80")).toBe(true);
    expect(document.activeElement).toBe(button);
    expect(focusSurfaceRow("service:missing:1")).toBe(false);
    restoreSurfacePosition(420, "service:192.0.2.10:80");
    expect(scrollTo).toHaveBeenCalledWith(0, 420);
    expect(document.activeElement).toBe(button);
    document.body.innerHTML = "";
  });
});

describe("surface inspector", () => {
  it("shows observation while technical ids stay behind evidence details", async () => {
    stubFindings([]);
    const record = serviceInspectorRecord(webService, engagementId);
    renderInspector(record);

    expect(await screen.findByRole("complementary", { name: "Selection inspector" })).toBeTruthy();
    const observation = screen.getByRole("region", { name: "Observation" });
    expect(within(observation).getByText("192.0.2.10")).toBeTruthy();
    expect(within(observation).getByText("nginx 1.25")).toBeTruthy();
    expect(within(observation).queryByText("run-1")).toBeNull();
    expect(within(observation).queryByText(record.artifactDigest)).toBeNull();

    const evidence = screen.getByRole("region", { name: "Linked evidence" });
    expect(within(evidence).getByText("Evidence details")).toBeTruthy();
    expect(within(evidence).getByText("run-1")).toBeTruthy();
    expect(within(evidence).getByText(record.artifactDigest)).toBeTruthy();
    expect(await screen.findByText("No findings reference this evidence yet.")).toBeTruthy();

    const download = within(evidence).getByRole("link", { name: "Raw evidence" });
    expect(download.getAttribute("href")).toBe(
      `/api/v1/engagements/${engagementId}/artifacts/artifact-1/content`,
    );
  });

  it("lists linked findings that reference the evidence artifact", async () => {
    stubFindings([
      {
        contractVersion: 1,
        id: "20000000-0000-4000-8000-000000000001",
        engagementId,
        title: "Default credentials",
        severity: "high",
        status: "open",
        body: "",
        evidenceArtifactIds: ["artifact-1"],
        revision: 1,
        createdAt: "2026-08-12T12:00:00.000Z",
        updatedAt: "2026-08-12T12:00:00.000Z",
      },
    ]);
    renderInspector(serviceInspectorRecord(webService, engagementId));
    expect(await screen.findByText(/1 linked finding: Default credentials/)).toBeTruthy();
  });

  it("hides unfinished stub actions by default", async () => {
    stubFindings([]);
    renderInspector(probeInspectorRecord(probe, engagementId));

    expect(screen.queryByRole("button", { name: "Start a lead" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Ask about this" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Probe web" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Discover paths" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Notes" })).toBeNull();
  });

  it("calls stub callbacks with the exact target when provided", async () => {
    stubFindings([]);
    const onStartLead = vi.fn();
    const onAskAbout = vi.fn();
    const onProbeOrigin = vi.fn();
    const onDiscoverOrigin = vi.fn();
    const onOpenNotes = vi.fn();
    const record = pathInspectorRecord(pathResult, engagementId);
    renderInspector(record, { onStartLead, onAskAbout, onProbeOrigin, onDiscoverOrigin, onOpenNotes });

    fireEvent.click(await screen.findByRole("button", { name: "Start a lead" }));
    expect(onStartLead).toHaveBeenCalledWith("http://192.0.2.10/admin");
    fireEvent.click(screen.getByRole("button", { name: "Ask about this" }));
    expect(onAskAbout).toHaveBeenCalledWith("http://192.0.2.10/admin");
    fireEvent.click(screen.getByRole("button", { name: "Probe web" }));
    expect(onProbeOrigin).toHaveBeenCalledWith("http://192.0.2.10");
    fireEvent.click(screen.getByRole("button", { name: "Discover paths" }));
    expect(onDiscoverOrigin).toHaveBeenCalledWith(
      "http://192.0.2.10",
      "http://192.0.2.10/admin",
    );
    const browser = screen.getByRole("link", { name: "Open in browser" });
    expect(browser.getAttribute("href")).toBe("http://192.0.2.10/admin");
    expect(browser.getAttribute("target")).toBe("_blank");
    fireEvent.click(screen.getByRole("button", { name: "Open Notes" }));
    expect(onOpenNotes).toHaveBeenCalledTimes(1);
  });

  it("copies a note reference for pasting into engagement notes", async () => {
    stubFindings([]);
    const writeText = vi.fn(async (_value: string) => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderInspector(pathInspectorRecord(pathResult, engagementId));

    fireEvent.click(await screen.findByRole("button", { name: "Copy note reference" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]?.[0]).toContain("http://192.0.2.10/admin");
    expect(writeText.mock.calls[0]?.[0]).toContain("artifact-3");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("closes on Escape and reports an unavailable selection honestly", async () => {
    stubFindings([]);
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={queryClient}>
        <SurfaceInspector
          engagementId={engagementId}
          loading={false}
          onClose={onClose}
          record={undefined}
          selectionKey="service:192.0.2.10:80"
        />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Selection unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    const record = serviceInspectorRecord(webService, engagementId);
    cleanup();
    render(
      <QueryClientProvider client={queryClient}>
        <SurfaceInspector
          engagementId={engagementId}
          loading={false}
          onClose={onClose}
          record={record}
          selectionKey={record.key}
        />
      </QueryClientProvider>,
    );
    const aside = await screen.findByRole("complementary", { name: "Selection inspector" });
    fireEvent.keyDown(aside, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
