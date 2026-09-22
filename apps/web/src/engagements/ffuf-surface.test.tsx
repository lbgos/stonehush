// @vitest-environment jsdom
import { PersistedActionSchema } from "@stonehush/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { ENGAGEMENT_FFUF_RESULTS_QUERY_ERROR_MESSAGE } from "./errors.js";
import { engagementFfufResultsQueryKey } from "./query.js";
import { pathSelectionKey } from "./inspector.js";
import { EngagementFfufSection } from "./ffuf-surface.js";

const engagementId = "10000000-0000-4000-8000-000000000001";

const detail = {
  engagement: {
    contractVersion: 1,
    id: engagementId,
    revision: 1,
    name: "Ffuf lab",
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

const ffufResult = {
  source: "ffuf" as const,
  parserVersion: "ffuf-json-v1",
  url: "http://127.0.0.1:3130/planted.txt",
  status: 200,
  length: 10,
  words: 1,
  lines: 2,
  redirectlocation: null,
  fuzz: "planted.txt",
  runId: "run-1",
  artifactId: "artifact-1",
  artifactDigest: `sha256:${"a".repeat(64)}`,
  observedAt: "2026-09-03T00:00:00.000Z",
};

function response(payload: unknown, status = 200): Response {
  return { json: async () => payload, ok: status >= 200 && status < 300, status } as Response;
}

const LAUNCH_ACTION_ID = "40000000-0000-4000-8000-000000000031";
const LAUNCH_SNAPSHOT_ID = "40000000-0000-4000-8000-000000000032";
const LAUNCH_BINDING = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

const launchedAction = PersistedActionSchema.parse({
  contractVersion: 1,
  engagementId,
  revision: 1,
  warningAcknowledgmentId: null,
  createdAt: "2026-08-12T12:10:00.000Z",
  updatedAt: "2026-08-12T12:10:00.000Z",
  action: {
    orchestrationProfile: "d2-v1",
    actionId: LAUNCH_ACTION_ID,
    state: "queued",
    snapshots: [
      {
        normalizationProfile: "d1-v1",
        orchestrationProfile: "d2-v1",
        snapshotId: LAUNCH_SNAPSHOT_ID,
        version: 1,
        binding: LAUNCH_BINDING,
        actionId: LAUNCH_ACTION_ID,
        canonicalTargets: [
          {
            kind: "ip",
            normalizationProfile: "d1-v1",
            family: 4,
            address: "192.0.2.10",
            zone: null,
          },
        ],
        concreteDestinations: [
          {
            kind: "ip",
            normalizationProfile: "d1-v1",
            family: 4,
            address: "192.0.2.10",
            zone: null,
          },
        ],
        typedOptions: {},
        resolutionSnapshots: [],
        scopeRevisionId: null,
        warningState: { reasonCodes: [], knownAdditions: [], acknowledgment: null },
      },
    ],
    queuedSnapshotVersion: 1,
    warningAcknowledgment: null,
    pendingWarning: null,
    coveredDestinations: [],
    warningInteractions: 0,
    runState: null,
    resumeRequested: false,
    cleanupRequired: false,
    capabilityErrorCode: null,
  },
});

const storedRunnerSettings = {
  ffufBinaryPath: "/usr/bin/ffuf",
  ffufWordlistPath: "/wordlists/stored.txt",
  ffufRate: 100,
  ffufThreads: 10,
  ffufTimeoutSeconds: 10,
  ffufMaxTimeSeconds: 600,
};

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

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => Promise.resolve(handler(url))),
  );
}

function renderSurface() {
  return render(
    <QueryClientProvider client={queryClient}>
      <EngagementFfufSection archived={false} engagementId={engagementId} />
    </QueryClientProvider>,
  );
}

describe("EngagementFfufSection", () => {
  it("reuses sorted results when selection changes and sorts new query data", async () => {
    const alpha = { ...ffufResult, url: "http://127.0.0.1:3130/alpha", fuzz: "alpha" };
    const zeta = { ...ffufResult, url: "http://127.0.0.1:3130/zeta", fuzz: "zeta" };
    stubFetch((url) => url.endsWith("/ffuf-results") ? response([zeta, alpha]) : response(detail));
    const compare = vi.spyOn(String.prototype, "localeCompare");
    const onSelectKey = vi.fn();
    const view = render(
      <QueryClientProvider client={queryClient}>
        <EngagementFfufSection archived={false} engagementId={engagementId} onSelectKey={onSelectKey} />
      </QueryClientProvider>,
    );
    await screen.findByRole("button", { name: alpha.url });
    expect(compare).toHaveBeenCalled();
    compare.mockClear();
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <EngagementFfufSection
          archived={false}
          engagementId={engagementId}
          onSelectKey={onSelectKey}
          selectedKey={pathSelectionKey(alpha.url, alpha.artifactId)}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("button", { name: alpha.url }).getAttribute("aria-current")).toBe("true");
    expect(compare).not.toHaveBeenCalled();

    const beta = { ...ffufResult, url: "http://127.0.0.1:3130/beta", fuzz: "beta" };
    act(() => queryClient.setQueryData(engagementFfufResultsQueryKey(engagementId), [zeta, beta, alpha]));
    await screen.findByRole("button", { name: beta.url });
    expect(compare).toHaveBeenCalled();
    const urls = [...view.container.querySelectorAll("[data-surface-row] button[title]")]
      .map((button) => button.getAttribute("title"));
    expect(urls).toEqual([alpha.url, beta.url, zeta.url]);
  });

  it("shows loading state", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    renderSurface();
    expect(screen.getByRole("status", { name: "Loading ffuf discovery" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "ffuf discovery" })).toBeTruthy();
  });

  it("renders the launch form with an empty state", async () => {
    stubFetch((url) =>
      url.endsWith("/ffuf-results") ? response([]) : response(detail),
    );
    renderSurface();
    expect(await screen.findByRole("button", { name: "Launch discovery" })).toBeTruthy();
    expect(await screen.findByText(/No ffuf results yet/i)).toBeTruthy();
  });

  it("lists matched paths with status and a raw evidence link", async () => {
    stubFetch((url) =>
      url.endsWith("/ffuf-results") ? response([ffufResult]) : response(detail),
    );
    renderSurface();
    expect(await screen.findByText("http://127.0.0.1:3130/planted.txt")).toBeTruthy();
    expect(await screen.findByText("planted.txt")).toBeTruthy();
    const link = await screen.findByRole("link", { name: "Raw evidence" });
    expect(link.getAttribute("href")).toBe(
      `/api/v1/engagements/${engagementId}/artifacts/artifact-1/content`,
    );
  });

  it("shows a recoverable error when results fail", async () => {
    stubFetch((url) =>
      url.endsWith("/ffuf-results")
        ? response({ code: "invalid_persisted_data" }, 500)
        : response(detail),
    );
    renderSurface();
    expect(await screen.findByText("ffuf results unavailable")).toBeTruthy();
    expect(ENGAGEMENT_FFUF_RESULTS_QUERY_ERROR_MESSAGE).toContain("ffuf results");
  });

  it("prefills stored runner defaults into the launch form", async () => {
    stubFetch((url) => {
      if (url.endsWith("/ffuf-results")) return response([]);
      if (url.endsWith("/settings/runner")) {
        return response({
          ffufBinaryPath: "/usr/bin/ffuf",
          ffufWordlistPath: "/lists/default.txt",
          ffufRate: 50,
          ffufThreads: 10,
          ffufTimeoutSeconds: 5,
          ffufMaxTimeSeconds: 60,
        });
      }
      return response(detail);
    });
    renderSurface();
    expect(await screen.findByRole("button", { name: "Launch discovery" })).toBeTruthy();
    expect(await screen.findByDisplayValue("/lists/default.txt")).toBeTruthy();
    expect((screen.getByLabelText("Rate") as HTMLInputElement).value).toBe("50");
    expect((screen.getByLabelText("Threads") as HTMLInputElement).value).toBe("10");
    expect((screen.getByLabelText("Timeout s") as HTMLInputElement).value).toBe("5");
    expect((screen.getByLabelText("Duration s") as HTMLInputElement).value).toBe("60");
  });

  it("falls back to shipped defaults when stored settings fail", async () => {
    stubFetch((url) => {
      if (url.endsWith("/ffuf-results")) return response([]);
      if (url.endsWith("/settings/runner")) {
        return response({ code: "invalid_persisted_data" }, 500);
      }
      return response(detail);
    });
    renderSurface();
    expect(await screen.findByRole("button", { name: "Launch discovery" })).toBeTruthy();
    expect((screen.getByLabelText("Rate") as HTMLInputElement).value).toBe("100");
    expect((screen.getByLabelText("Threads") as HTMLInputElement).value).toBe("40");
    expect(await screen.findByText(/Using shipped defaults/)).toBeTruthy();
  });

  it("keeps tracking the running discovery when a resubmit fails validation", async () => {
    let launches = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === `/api/v1/engagements/${engagementId}`) {
          return response(detail);
        }
        if (url === "/api/v1/settings/runner") return response(storedRunnerSettings);
        if (url.endsWith("/ffuf-results") && (init?.method === undefined || init?.method === "GET")) {
          return response([]);
        }
        if (url.endsWith("/ffuf-discoveries") && init?.method === "POST") {
          launches += 1;
          return response(launchedAction, 201);
        }
        return response({ code: "invalid_request" }, 400);
      }),
    );
    renderSurface();
    await waitFor(() => {
      expect((screen.getByLabelText("Wordlist path") as HTMLInputElement).value).toBe(
        "/wordlists/stored.txt",
      );
    });
    fireEvent.change(screen.getByLabelText("Origin"), {
      target: { value: "http://192.0.2.10:8080" },
    });
    const form = screen.getByLabelText("Origin").closest("form")!;
    fireEvent.submit(form);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    });
    expect(launches).toBe(1);

    // A relative wordlist fails field validation: the running discovery
    // stays tracked instead of losing its status and Stop control.
    fireEvent.change(screen.getByLabelText("Wordlist path"), {
      target: { value: "wordlists/relative.txt" },
    });
    fireEvent.submit(form);
    expect(
      await screen.findByText(
        "Wordlist path must be absolute and must not contain path traversal.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(launches).toBe(1);
    expect(
      within(screen.getByRole("region", { name: "ffuf discovery" })).queryByText(/No ffuf results yet/),
    ).toBeTruthy();
  });
});
