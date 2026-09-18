// @vitest-environment jsdom
import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { EngagementGitleaksSection } from "./gitleaks.js";

const engagementId = "10000000-0000-4000-8000-000000000001";
const LIVE_KEY = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh12";

function response(payload: unknown, status = 200): Response {
  return { json: async () => payload, ok: status >= 200 && status < 300, status } as Response;
}

const match = {
  ruleId: "github-pat",
  file: "artifact-01",
  line: 7,
  fingerprint: "0123456789abcdef",
};

let queryClient: ReturnType<typeof createAppQueryClient>;
let fetchMock: ReturnType<typeof vi.fn>;

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

function renderSection(archived = false) {
  return render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <EngagementGitleaksSection archived={archived} engagementId={engagementId} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe("EngagementGitleaksSection", () => {
  it("lists rule, file, and line without ever showing secret values", async () => {
    fetchMock = vi.fn((url: string) => {
      if (url.endsWith("/gitleaks-matches")) return Promise.resolve(response([match]));
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderSection();

    expect(await screen.findByText("github-pat")).toBeTruthy();
    expect(screen.getByText("artifact-01")).toBeTruthy();
    expect(screen.getByText("line 7")).toBeTruthy();
    expect(container.textContent).not.toContain(LIVE_KEY);
    expect(container.textContent).not.toContain("ghp_");
  });

  it("shows the missing-tool state when gitleaks is not installed", async () => {
    fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith("/gitleaks-matches")) return Promise.resolve(response([]));
      if (url.endsWith("/gitleaks-scans") && init?.method === "POST") {
        return Promise.resolve(response({ code: "gitleaks_missing" }, 503));
      }
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Scan evidence" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("/usr/bin/gitleaks");
  });

  it("rescans and shows the new matches", async () => {
    let round = 0;
    let listed: unknown[] = [];
    fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith("/gitleaks-matches")) return Promise.resolve(response(listed));
      if (url.endsWith("/gitleaks-scans") && init?.method === "POST") {
        round += 1;
        listed = round === 1 ? [match] : [match, { ...match, ruleId: "aws-access-key", file: "artifact-02", line: 3, fingerprint: "fedcba9876543210" }];
        return Promise.resolve(
          response({
            scanId: "20000000-0000-4000-8000-000000000001",
            engagementId,
            scannedAt: "2026-09-18T12:00:00.000Z",
            matchCount: listed.length,
            truncated: false,
            matches: listed,
          }, 201),
        );
      }
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Scan evidence" }));
    expect(await screen.findByText("github-pat")).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: "Rescan" }));
    await waitFor(() => expect(screen.getByText("aws-access-key")).toBeTruthy());
    expect(fetchMock.mock.calls.filter(([url, init]) => url.endsWith("/gitleaks-scans") && (init as RequestInit)?.method === "POST")).toHaveLength(2);
  });

  it("disables scanning for archived engagements", async () => {
    fetchMock = vi.fn((url: string) => {
      if (url.endsWith("/gitleaks-matches")) return Promise.resolve(response([]));
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSection(true);

    expect(await screen.findByText("No secret matches")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Scan evidence" })).toHaveProperty("disabled", true);
  });
});
