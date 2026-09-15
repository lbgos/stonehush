// @vitest-environment jsdom

import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReportBundle } from "@stonehush/contracts";
import { engagementReportMarkdown } from "@stonehush/contracts";
import { createAppQueryClient } from "../query-client.js";
import { maskReportBundle } from "./report-mask.js";
import { reportQueryKey } from "./report-query.js";
import { EngagementReportSection } from "./report.js";

const engagementId = "10000000-0000-4000-8000-000000000001";

function bundleFixture(): ReportBundle {
  return {
    contractVersion: 1,
    engagement: {
      id: engagementId,
      name: "Target lab",
      kind: "lab",
      status: "active",
      description: null,
      authorizationContext: null,
      deadlineAt: null,
      revision: 1,
      createdAt: "2026-08-12T12:00:00.000Z",
      updatedAt: "2026-08-12T12:00:00.000Z",
    },
    findings: [
      {
        contractVersion: 1,
        id: "20000000-0000-4000-8000-000000000001",
        engagementId,
        title: "Default credentials on admin panel",
        severity: "high",
        status: "open",
        body: "# impact\nAdmin access.",
        evidenceArtifactIds: [],
        revision: 1,
        createdAt: "2026-08-12T12:00:00.000Z",
        updatedAt: "2026-08-12T12:00:00.000Z",
      },
    ],
    notesMarkdown: "# creds\nadmin:admin",
    notesUpdatedAt: "2026-08-12T12:00:00.000Z",
    services: { total: 0, truncated: false, rows: [] },
    probes: { total: 0, truncated: false, rows: [] },
    ffufResults: { total: 0, truncated: false, rows: [] },
    evidenceArtifacts: { total: 0, truncated: false, rows: [] },
    generatedAt: "2026-08-12T13:00:00.000Z",
  };
}

function response(payload: unknown, status = 200): Response {
  return {
    json: async () => payload,
    text: async () =>
      typeof payload === "string" ? payload : JSON.stringify(payload),
    ok: status >= 200 && status < 300,
    status,
  } as Response;
}

const testQueryClients = new Set<QueryClient>();

function renderSection() {
  const queryClient = createAppQueryClient();
  testQueryClients.add(queryClient);
  const rendered = render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <EngagementReportSection engagementId={engagementId} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { queryClient, ...rendered };
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
  Element.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn(() => "blob:fake-report"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  for (const client of testQueryClients) client.clear();
  testQueryClients.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("engagement report", () => {
  it("renders the preview and copies markdown with confirmation", async () => {
    const bundle = bundleFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        if (String(input).endsWith("/report")) {
          return Promise.resolve(response(bundle));
        }
        return Promise.reject(new Error("unexpected fetch"));
      }),
    );
    const clicked: string[] = [];
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicked.push(`${this.download}:${this.href}`);
      });

    renderSection();

    expect(await screen.findByText(/1 findings/)).toBeTruthy();
    expect(screen.getByText(/Default credentials on admin panel/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Copy Markdown" }));
    await waitFor(() =>
      expect(window.navigator.clipboard.writeText).toHaveBeenCalled(),
    );
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    const copied = String(
      (window.navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? "",
    );
    expect(copied).toContain("Default credentials on admin panel");

    fireEvent.click(screen.getByRole("button", { name: "Download JSON" }));
    expect(clicked.some((entry) => entry.startsWith(`engagement-${engagementId}-report.json:`))).toBe(
      true,
    );
    clickSpy.mockRestore();
  });

  it("downloads markdown from the cached bundle without hitting the markdown endpoint", async () => {
    const bundle = bundleFixture();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/report?format=markdown")) {
        return Promise.reject(new Error("markdown endpoint must not be used for export"));
      }
      if (url.endsWith("/report")) return Promise.resolve(response(bundle));
      return Promise.reject(new Error("unexpected fetch"));
    });
    vi.stubGlobal("fetch", fetchMock);
    const clicked: string[] = [];
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicked.push(`${this.download}:${this.href}`);
      });

    renderSection();
    expect(await screen.findByRole("button", { name: "Download Markdown" })).toBeTruthy();
    // Preview and export share one bundle-derived snapshot.
    expect(screen.getByText(/Default credentials on admin panel/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download Markdown" }));
    await waitFor(() =>
      expect(
        clicked.some((entry) =>
          entry.startsWith(`engagement-${engagementId}-report.md:`),
        ),
      ).toBe(true),
    );
    expect(
      fetchMock.mock.calls.some(([called]) => String(called).endsWith("/report?format=markdown")),
    ).toBe(false);
    clickSpy.mockRestore();
  });

  it("shows the empty state and the error state", async () => {
    const empty: ReportBundle = {
      ...bundleFixture(),
      findings: [],
      notesMarkdown: "",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(response(empty))),
    );
    renderSection();
    expect(await screen.findByText("Nothing to report yet")).toBeTruthy();
    cleanup();

    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(response({ code: "oops" }, 500))),
    );
    const queryClient = createAppQueryClient();
    testQueryClients.add(queryClient);
    render(
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <EngagementReportSection engagementId={engagementId} />
        </QueryClientProvider>
      </ThemeProvider>,
    );
    expect(await screen.findByText("Report unavailable")).toBeTruthy();
  });

  it("masks operator text by default and shares the projection across preview, copy, and download", async () => {
    const secretNote = "flag{synthetic-share-0001}";
    const secretBody = "password=synthetic-share-002";
    const structuredProduct = "SyntheticServer flag{synthetic-structured-0001}";
    const bundle: ReportBundle = {
      ...bundleFixture(),
      findings: [
        {
          contractVersion: 1,
          id: "20000000-0000-4000-8000-000000000001",
          engagementId,
          title: "Shared projection finding",
          severity: "high",
          status: "open",
          body: `impact ${secretBody}`,
          evidenceArtifactIds: [],
          revision: 1,
          createdAt: "2026-08-12T12:00:00.000Z",
          updatedAt: "2026-08-12T12:00:00.000Z",
        },
      ],
      notesMarkdown: `see ${secretNote}`,
      services: {
        total: 1,
        truncated: false,
        rows: [
          {
            address: "192.0.2.10",
            port: 80,
            protocol: "tcp",
            hostname: null,
            serviceName: "http",
            product: structuredProduct,
            version: "1.0",
            source: "nmap",
            parserVersion: "nmap-xml-v1",
            runId: "run-1",
            artifactId: "artifact-1",
            artifactDigest: `sha256:${"a".repeat(64)}`,
            observedAt: "2026-08-12T12:00:00.000Z",
          },
        ],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(response(bundle))),
    );
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {});

    const { queryClient } = renderSection();

    // Masked by default with a visible field count; structured text is preserved.
    expect(await screen.findByText(/Fields masked: 2/)).toBeTruthy();
    const preview = document.querySelector("section[aria-label='Report'] pre")?.textContent ?? "";
    expect(preview).toContain("[redacted]");
    expect(preview).not.toContain(secretNote);
    expect(preview).not.toContain(secretBody);
    expect(preview).toContain(structuredProduct);

    // JSON download carries the same masked copy, not the stored bundle.
    const masked = maskReportBundle(bundle);
    const storedJson = `${JSON.stringify(bundle, null, 2)}\n`;
    const createObjectURL = URL.createObjectURL as ReturnType<typeof vi.fn>;
    fireEvent.click(screen.getByRole("button", { name: "Download JSON" }));
    await waitFor(() => expect(createObjectURL.mock.calls.length).toBe(1));
    const downloadedJson = createObjectURL.mock.calls[0]?.[0] as Blob | undefined;
    expect(downloadedJson).toBeInstanceOf(Blob);
    const downloadedJsonText = await downloadedJson?.text();
    expect(downloadedJsonText).not.toBe(storedJson);
    expect(JSON.parse(downloadedJsonText ?? "")).toEqual(masked.bundle);

    // Markdown download carries the same masked Markdown as the preview.
    fireEvent.click(screen.getByRole("button", { name: "Download Markdown" }));
    await waitFor(() => expect(createObjectURL.mock.calls.length).toBe(2));
    const downloadedMarkdown = createObjectURL.mock.calls[1]?.[0] as Blob | undefined;
    expect(downloadedMarkdown).toBeInstanceOf(Blob);
    expect(await downloadedMarkdown?.text()).toBe(preview);

    // Copy carries the same masked Markdown as the preview.
    fireEvent.click(screen.getByRole("button", { name: "Copy Markdown" }));
    await waitFor(() =>
      expect(window.navigator.clipboard.writeText).toHaveBeenCalled(),
    );
    const clipboard = window.navigator.clipboard.writeText as ReturnType<typeof vi.fn>;
    const copiedMasked = String(clipboard.mock.calls[0]?.[0] ?? "");
    expect(copiedMasked).toBe(engagementReportMarkdown(maskReportBundle(bundle).bundle));
    expect(copiedMasked).not.toContain(secretNote);

    // Opting out reveals the original stored text for every surface.
    fireEvent.click(screen.getByRole("button", { name: "Show original" }));
    expect(await screen.findByRole("button", { name: "Mask secrets" })).toBeTruthy();
    const originalPreview =
      document.querySelector("section[aria-label='Report'] pre")?.textContent ?? "";
    expect(originalPreview).toContain(secretNote);
    // The copy button briefly confirms as "Copied" after the first copy.
    fireEvent.click(screen.getByRole("button", { name: /Copy Markdown|Copied/ }));
    await waitFor(() => expect(clipboard.mock.calls.length).toBe(2));
    expect(String(clipboard.mock.calls[1]?.[0] ?? "")).toContain(secretNote);

    // Toggling and exporting never rewrite the cached stored bundle.
    expect(queryClient.getQueryData(reportQueryKey(engagementId))).toEqual(bundle);
    clickSpy.mockRestore();
  });

  it("resets the mask toggle when switching engagements", async () => {
    const engagementB = "10000000-0000-4000-8000-000000000002";
    const bundleA: ReportBundle = {
      ...bundleFixture(),
      notesMarkdown: "see flag{synthetic-reset-0001}",
    };
    const baseB = bundleFixture();
    const bundleB: ReportBundle = {
      ...baseB,
      engagement: { ...baseB.engagement, id: engagementB, name: "Second lab" },
      findings: [],
      notesMarkdown: "plain second notes",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes(`/engagements/${engagementB}/report`)) {
          return Promise.resolve(response(bundleB));
        }
        if (url.includes(`/engagements/${engagementId}/report`)) {
          return Promise.resolve(response(bundleA));
        }
        return Promise.reject(new Error("unexpected fetch"));
      }),
    );
    const queryClient = createAppQueryClient();
    testQueryClients.add(queryClient);
    const rendered = render(
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <EngagementReportSection engagementId={engagementId} />
        </QueryClientProvider>
      </ThemeProvider>,
    );
    const previewText = () =>
      document.querySelector("section[aria-label='Report'] pre")?.textContent ?? "";

    expect(await screen.findByText(/Fields masked: 1/)).toBeTruthy();
    expect(previewText()).not.toContain("flag{synthetic-reset-0001}");

    // Opt out on A, then switch to B: the fresh engagement starts masked.
    fireEvent.click(screen.getByRole("button", { name: "Show original" }));
    expect(await screen.findByRole("button", { name: "Mask secrets" })).toBeTruthy();
    expect(previewText()).toContain("flag{synthetic-reset-0001}");

    rendered.rerender(
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <EngagementReportSection engagementId={engagementB} />
        </QueryClientProvider>
      </ThemeProvider>,
    );
    expect(await screen.findByText(/Fields masked: 0/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show original" })).toBeTruthy();

    // Switching back to A restores the masked default instead of the opt-out.
    rendered.rerender(
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <EngagementReportSection engagementId={engagementId} />
        </QueryClientProvider>
      </ThemeProvider>,
    );
    expect(await screen.findByText(/Default credentials on admin panel/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show original" })).toBeTruthy();
    expect(previewText()).not.toContain("flag{synthetic-reset-0001}");
    expect(queryClient.getQueryData(reportQueryKey(engagementId))).toEqual(bundleA);
    expect(queryClient.getQueryData(reportQueryKey(engagementB))).toEqual(bundleB);
  });
});
