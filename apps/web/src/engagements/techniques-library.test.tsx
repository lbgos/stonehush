// @vitest-environment jsdom

import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { EngagementTechniquesSection, filterTechniques } from "./techniques-library.js";

const ENGAGEMENT_A = "10000000-0000-4000-8000-000000000001";
const ENGAGEMENT_B = "10000000-0000-4000-8000-000000000002";
const TS = "2026-10-01T12:00:00.000Z";

function technique(overrides: Record<string, unknown> = {}, engagementId = ENGAGEMENT_A) {
  return {
    contractVersion: 1 as const,
    id: "60000000-0000-4000-8000-000000000001",
    engagementId,
    name: "Default creds check",
    whenUseful: "Login looks default",
    prerequisites: ["http service observed"],
    question: "Does the vendor default work?",
    procedure: [
      { instruction: "Open {{target}} login.", command: "nmap -sV {{target}}" },
      { instruction: "Try one documented pair." },
    ],
    meaning: "A banner means it answered.",
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

function response(payload: unknown, status = 200): Response {
  return { json: async () => payload, ok: status >= 200 && status < 300, status } as Response;
}

const testClients = new Set<QueryClient>();

function renderLibrary(engagementId: string, archived = false) {
  const client = createAppQueryClient();
  testClients.add(client);
  return render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <EngagementTechniquesSection engagementId={engagementId} archived={archived} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

interface StubOptions {
  techniquesByEngagement?: Record<string, unknown[]>;
  findingsByEngagement?: Record<string, unknown[]>;
  failTechniques?: boolean;
  failFindings?: boolean;
}

function stubFetch(options: StubOptions = {}) {
  const calls: { url: string; method: string }[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (url.includes("/techniques")) {
      if (options.failTechniques) return Promise.resolve(response({ code: "storage_busy" }, 503));
      const engagementId = url.includes(ENGAGEMENT_B) ? ENGAGEMENT_B : ENGAGEMENT_A;
      return Promise.resolve(response(options.techniquesByEngagement?.[engagementId] ?? []));
    }
    if (url.includes("/findings")) {
      if (options.failFindings) return Promise.resolve(response({ code: "storage_busy" }, 503));
      const engagementId = url.includes(ENGAGEMENT_B) ? ENGAGEMENT_B : ENGAGEMENT_A;
      return Promise.resolve(response(options.findingsByEngagement?.[engagementId] ?? []));
    }
    return Promise.resolve(response([]));
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

beforeEach(() => {
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
  for (const client of testClients) client.clear();
  testClients.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("techniques library filter", () => {
  it("matches name, question, and procedure text", () => {
    const items = [technique()];
    expect(filterTechniques(items, "default creds")).toHaveLength(1);
    expect(filterTechniques(items, "vendor default")).toHaveLength(1);
    expect(filterTechniques(items, "nmap -sV")).toHaveLength(1);
    expect(filterTechniques(items, "{{target}}")).toHaveLength(1);
    expect(filterTechniques(items, "no such text")).toHaveLength(0);
    expect(filterTechniques(items, "   ")).toHaveLength(1);
  });
});

describe("engagement techniques library", () => {
  it("shows a truthful empty state for a fresh engagement", async () => {
    stubFetch();
    renderLibrary(ENGAGEMENT_A);
    expect(await screen.findByText(/No saved techniques yet\./)).toBeTruthy();
    expect(screen.getByLabelText("Search techniques")).toBeTruthy();
  });

  it("finds a saved technique, fills a placeholder, and filters to empty then clears", async () => {
    const { calls } = stubFetch({ techniquesByEngagement: { [ENGAGEMENT_A]: [technique()] } });
    renderLibrary(ENGAGEMENT_A);

    expect(await screen.findByText("Default creds check")).toBeTruthy();
    expect(screen.getByText("Question: Does the vendor default work?")).toBeTruthy();

    const placeholder = screen.getByLabelText<HTMLInputElement>("{{target}}");
    fireEvent.change(placeholder, { target: { value: "192.0.2.10" } });
    expect(await screen.findByText(/Open 192.0.2.10 login./)).toBeTruthy();

    const search = screen.getByLabelText("Search techniques") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "vendor default" } });
    expect(screen.getByText("Default creds check")).toBeTruthy();

    fireEvent.change(search, { target: { value: "no such technique" } });
    expect(await screen.findByText(/No techniques match/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(await screen.findByText("Default creds check")).toBeTruthy();

    const writes = calls.filter((call) => call.method !== "GET");
    expect(writes).toEqual([]);
    expect(calls.some((call) => call.url.includes("/advisor/turns"))).toBe(false);
    expect(calls.some((call) => call.url.includes("/artifacts/"))).toBe(false);
    expect(calls.some((call) => call.url.includes("/runs"))).toBe(false);
  });

  it("keeps each engagement library separate without stale responses", async () => {
    const techniqueB = technique({ id: "60000000-0000-4000-8000-000000000002", name: "Other box check" }, ENGAGEMENT_B);
    stubFetch({ techniquesByEngagement: { [ENGAGEMENT_A]: [technique()], [ENGAGEMENT_B]: [techniqueB] } });

    const first = renderLibrary(ENGAGEMENT_A);
    expect(await screen.findByText("Default creds check")).toBeTruthy();
    expect(screen.queryByText("Other box check")).toBe(null);
    first.unmount();
    cleanup();

    renderLibrary(ENGAGEMENT_B);
    expect(await screen.findByText("Other box check")).toBeTruthy();
    expect(screen.queryByText("Default creds check")).toBe(null);
  });

  it("reloads the same engagement library from the server", async () => {
    stubFetch({ techniquesByEngagement: { [ENGAGEMENT_A]: [technique()] } });
    const first = renderLibrary(ENGAGEMENT_A);
    expect(await screen.findByText("Default creds check")).toBeTruthy();
    first.unmount();
    cleanup();

    renderLibrary(ENGAGEMENT_A);
    expect(await screen.findByText("Default creds check")).toBeTruthy();
  });

  it("states context unavailable when findings cannot load, and evaluates when they can", async () => {
    stubFetch({
      techniquesByEngagement: { [ENGAGEMENT_A]: [technique()] },
      failFindings: true,
    });
    renderLibrary(ENGAGEMENT_A);
    expect(await screen.findByText("Applicability: context unavailable.")).toBeTruthy();
  });

  it("shows evaluated verdicts from finding titles", async () => {
    stubFetch({
      techniquesByEngagement: { [ENGAGEMENT_A]: [technique()] },
      findingsByEngagement: {
        [ENGAGEMENT_A]: [
          {
            contractVersion: 1,
            id: "40000000-0000-4000-8000-000000000001",
            engagementId: ENGAGEMENT_A,
            title: "HTTP service observed on 192.0.2.10",
            severity: "info",
            status: "open",
            body: "observed",
            evidenceArtifactIds: [],
            revision: 0,
            createdAt: TS,
            updatedAt: TS,
          },
        ],
      },
    });
    renderLibrary(ENGAGEMENT_A);
    expect(await screen.findByText(/Applies:/)).toBeTruthy();
  });

  it("omits false engagement-wide denial for a saved preview without context", async () => {
    const noPrereq = technique({ prerequisites: [] });
    stubFetch({ techniquesByEngagement: { [ENGAGEMENT_A]: [noPrereq] }, failFindings: true });
    renderLibrary(ENGAGEMENT_A);
    expect(await screen.findByText(/Applies:/)).toBeTruthy();
    expect(screen.queryByText("Applicability: context unavailable.")).toBe(null);
  });

  it("recovers from a failed techniques read without losing focus", async () => {
    stubFetch({ failTechniques: true });
    renderLibrary(ENGAGEMENT_A);
    expect(await screen.findByText("Techniques unavailable")).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(document.activeElement).not.toBe(retry);
  });

  it("keeps an archived library readable with writes disabled", async () => {
    stubFetch({ techniquesByEngagement: { [ENGAGEMENT_A]: [technique()] } });
    renderLibrary(ENGAGEMENT_A, true);
    expect(await screen.findByText("Default creds check")).toBeTruthy();
    expect(screen.getByText("Archived engagements are read-only. Saved procedures stay readable.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy replay" })).toBe(null);
  });
});
