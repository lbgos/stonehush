// @vitest-environment jsdom
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { EngagementServicesSection } from "./service-surface.js";

const engagementId = "10000000-0000-4000-8000-000000000001";

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
  artifactId: "artifact-ssh",
  artifactDigest: `sha256:${"d".repeat(64)}`,
};

const probe = {
  source: "http-probe" as const,
  parserVersion: "http-probe-raw-v1",
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

const pathAdmin = {
  source: "ffuf" as const,
  parserVersion: "ffuf-json-v1",
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

const pathLogin = {
  ...pathAdmin,
  url: "http://192.0.2.10/login",
  fuzz: "login",
  artifactId: "artifact-4",
};

const engagementDetail = {
  engagement: {
    contractVersion: 1,
    id: engagementId,
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
    updatedAt: "2026-08-12T12:00:00.000Z",
  },
  activeScopeRevision: null,
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
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }),
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

function stubSurface(options: { findings?: unknown[]; settings?: unknown } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/services")) return Promise.resolve(response([webService, sshService]));
      if (url.endsWith("/http-probes")) return Promise.resolve(response([probe]));
      if (url.endsWith("/ffuf-results")) return Promise.resolve(response([pathAdmin, pathLogin]));
      if (url.endsWith("/findings")) return Promise.resolve(response(options.findings ?? []));
      if (url.endsWith("/settings/runner")) {
        if (options.settings !== undefined) return Promise.resolve(response(options.settings));
        return Promise.resolve(response({ code: "storage_busy" }, 503));
      }
      if (url.endsWith(`/api/v1/engagements/${engagementId}`)) {
        return Promise.resolve(response(engagementDetail));
      }
      if (init?.method !== undefined && init.method !== "GET") {
        return Promise.resolve(response({ code: "invalid_request" }, 400));
      }
      return Promise.resolve(response({ code: "invalid_request" }, 400));
    }),
  );
}

function renderSection(props: Partial<Parameters<typeof EngagementServicesSection>[0]> = {}) {
  return render(
    <QueryClientProvider client={queryClient}>
      <EngagementServicesSection engagementId={engagementId} {...props} />
    </QueryClientProvider>,
  );
}

describe("surface target organization", () => {
  it("enriches the known web service and nests discoveries beneath the origin", async () => {
    stubSurface();
    renderSection();

    expect(await screen.findByRole("heading", { name: "Attack surface" })).toBeTruthy();
    expect((await screen.findAllByRole("button", { name: /192\.0\.2\.10/ })).length).toBeGreaterThan(0);
    expect(screen.getByText("80/tcp")).toBeTruthy();
    expect(screen.getByText("22/tcp")).toBeTruthy();

    // Probe enriches the already-known service: status and title inline.
    expect(screen.getByText("200 · Lab Box")).toBeTruthy();

    // Discoveries appear beneath the relevant origin, newest URL order.
    expect(screen.getByText("http://192.0.2.10/admin")).toBeTruthy();
    expect(screen.getByText("http://192.0.2.10/login")).toBeTruthy();

    // Web origin offers the full contextual action set.
    const origin = screen.getByText("http://192.0.2.10").closest("div");
    expect(origin).not.toBeNull();
    expect(screen.getByRole("button", { name: "Probe web" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open in browser" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Discover paths" }).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole("button", { name: "Start a lead" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Ask about this" })).toBeNull();
  });

  it("opens a shared inspector with observation, actions, evidence, and notes", async () => {
    stubSurface();
    renderSection();

    expect(await screen.findByText("http://192.0.2.10/admin")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "http://192.0.2.10/admin" }));

    const inspector = await screen.findByRole("complementary", { name: "Selection inspector" });
    expect(within(inspector).getAllByText("http://192.0.2.10/admin").length).toBeGreaterThanOrEqual(1);
    expect(
      within(screen.getByRole("region", { name: "Observation" })).getByText("admin"),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Observation" })).queryByText("run-3"),
    ).toBeNull();
    expect(
      within(screen.getByRole("region", { name: "Linked evidence" })).getByText("run-3"),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Notes" })).getByRole("button", {
        name: "Copy note reference",
      }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("complementary", { name: "Selection inspector" })).toBeNull();
  });

  it("renders row-level and below-origin extension slots for later slices", async () => {
    stubSurface();
    renderSection({
      extraRowActions: (context) => <span>slot:{context.kind}</span>,
      belowOrigin: (context) => <span>below:{context.origin}</span>,
    });

    expect(await screen.findAllByText("slot:service")).toHaveLength(2);
    expect(screen.getByText("slot:probe")).toBeTruthy();
    expect(screen.getAllByText("slot:path")).toHaveLength(2);
    expect(screen.getByText("below:http://192.0.2.10")).toBeTruthy();
  });

  it("launches a probe from the exact origin and returns to the row on close", async () => {
    stubSurface();
    renderSection();

    expect(await screen.findByText("http://192.0.2.10/admin")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Probe web" }));

    const dialog = await screen.findByRole("dialog", { name: "Probe web" });
    expect(await within(dialog).findByDisplayValue("http://192.0.2.10")).toBeTruthy();
    const scheme = within(dialog).getByLabelText("Scheme") as HTMLSelectElement;
    expect(scheme.value).toBe("http");
    fireEvent.change(scheme, { target: { value: "https" } });
    expect(within(dialog).getByDisplayValue("https://192.0.2.10")).toBeTruthy();

    // Restoring the initial input leaves no draft behind: Escape closes cleanly.
    fireEvent.change(scheme, { target: { value: "http" } });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Probe web" })).toBeNull();
  });

  it("asks before discarding launcher input on Escape", async () => {
    stubSurface();
    renderSection();

    expect(await screen.findByText("http://192.0.2.10/admin")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Discover paths" })[0]!);

    const dialog = await screen.findByRole("dialog", { name: "Discover paths" });
    expect(await within(dialog).findByDisplayValue("http://192.0.2.10")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Origin"), {
      target: { value: "http://192.0.2.10/edited" },
    });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(within(dialog).getByText("Discard unsaved launcher input?")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Discover paths" })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(
      within(screen.getByRole("dialog", { name: "Discover paths" })).getByDisplayValue(
        "http://192.0.2.10/edited",
      ),
    ).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Discover paths" }), { key: "Escape" });
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Discover paths" })).getByRole("button", {
        name: "Discard",
      }),
    );
    expect(screen.queryByRole("dialog", { name: "Discover paths" })).toBeNull();
  });

  it("rejects an invalid launcher origin without issuing a request", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/services")) return Promise.resolve(response([webService, sshService]));
      if (url.endsWith("/http-probes")) return Promise.resolve(response([probe]));
      if (url.endsWith("/ffuf-results")) return Promise.resolve(response([pathAdmin]));
      if (url.endsWith("/findings")) return Promise.resolve(response([]));
      if (url.endsWith(`/api/v1/engagements/${engagementId}`)) {
        return Promise.resolve(response(engagementDetail));
      }
      if (init?.method !== undefined && init.method !== "GET") {
        return Promise.resolve(response({ code: "invalid_request" }, 400));
      }
      return Promise.resolve(response({ code: "invalid_request" }, 400));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSection();

    expect(await screen.findByText("http://192.0.2.10/admin")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Probe web" }));
    const dialog = await screen.findByRole("dialog", { name: "Probe web" });
    const originInput = await within(dialog).findByLabelText("Origin");
    fireEvent.change(originInput, { target: { value: "" } });
    const form = originInput.closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);
    expect(await within(dialog).findByText("Origin must be an http or https URL.")).toBeTruthy();
    const writes = fetchMock.mock.calls.filter((call) => {
      const init = call[1] as RequestInit | undefined;
      return init?.method !== undefined && init.method !== "GET";
    });
    expect(writes).toEqual([]);
  });

  it("returns focus to the origin row when the invoking context is gone", async () => {
    stubSurface();
    renderSection();

    expect(await screen.findByText("http://192.0.2.10/admin")).toBeTruthy();
    const probeButton = screen.getByRole("button", { name: "Probe web" });
    expect(
      probeButton.closest("[data-surface-row]")?.getAttribute("data-surface-row"),
    ).toBe("origin:http:192.0.2.10:80");

    // Focus holder outside the surface; jsdom clicks do not move focus, so
    // the launcher captures this element. Removing it before close forces
    // the sourceKey fallback path instead of the live-element path.
    const holder = document.createElement("button");
    holder.textContent = "holder";
    document.body.appendChild(holder);
    holder.focus();
    fireEvent.click(probeButton);
    const dialog = await screen.findByRole("dialog", { name: "Probe web" });
    holder.remove();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Probe web" })).toBeNull();
    expect(document.activeElement).toBe(probeButton);
  });
});
