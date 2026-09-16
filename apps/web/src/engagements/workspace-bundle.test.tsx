// @vitest-environment jsdom

import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { WorkspaceBundleSection } from "./workspace-bundle.js";

const engagementId = "10000000-0000-4000-8000-000000000001";
const newEngagementId = "20000000-0000-4000-8000-000000000002";

function bundleFile(): Record<string, unknown> {
  return {
    kind: "stonehush-workspace-bundle-v1",
    bundleVersion: 1,
    exportedAt: "2026-09-01T12:00:00.000Z",
    sourceEngagementId: engagementId,
    sourceEngagementName: "Source lab",
    privateCopy: false,
    engagement: {
      name: "Source lab",
      kind: "lab",
      deadlineAt: null,
      description: null,
      authorizationContext: null,
    },
    notes: { markdown: "", updatedAt: "2026-09-01T12:00:00.000Z" },
    leads: [],
    attempts: [],
    excerpts: [],
    attachments: [],
    findings: [],
    evidence: [],
    secrets: [],
    objectives: [],
  };
}

function importSuccess() {
  return {
    engagementId: newEngagementId,
    summary: {
      leads: 2,
      attempts: 1,
      excerpts: 1,
      attachments: 0,
      findings: 1,
      evidence: 1,
      secrets: 0,
      objectives: 0,
      privateCopy: false,
    },
  };
}

const testQueryClients = new Set<QueryClient>();

async function renderSection() {
  const queryClient = createAppQueryClient();
  testQueryClients.add(queryClient);
  const rootRoute = createRootRoute({
    component: () => <WorkspaceBundleSection engagementId={engagementId} />,
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute,
  });
  await router.load();
  const rendered = render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { queryClient, router, ...rendered };
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
    value: vi.fn(() => "blob:fake-bundle"),
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

describe("workspace bundle section", () => {
  it("keeps the bundle copy distinct from the client report", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("unexpected fetch"))),
    );
    await renderSection();
    expect(screen.getByRole("heading", { name: "Workspace bundle" })).toBeTruthy();
    expect(screen.getByText(/Not a client report/)).toBeTruthy();
    expect(screen.getByText(/Private copy:/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Export workspace bundle" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Import bundle file" }),
    ).toBeTruthy();
  });

  it("exports the default bundle without the private-copy flag", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        seen.push(String(input));
        return Promise.resolve({
          ok: true,
          status: 200,
          blob: async () => new Blob(["{}"], { type: "application/json" }),
        } as Response);
      }),
    );
    const clicked: string[] = [];
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicked.push(`${this.download}:${this.href}`);
      });
    await renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Export workspace bundle" }));
    await waitFor(() =>
      expect(
        clicked.some((entry) =>
          entry.startsWith(`engagement-${engagementId}-workspace-bundle.json:`),
        ),
      ).toBe(true),
    );
    expect(seen).toEqual([`/api/v1/engagements/${engagementId}/workspace-bundle`]);
    expect(
      await screen.findByText(/No secrets, flags, or client identifiers/),
    ).toBeTruthy();
    clickSpy.mockRestore();
  });

  it("sends the explicit opt-in only when the private-copy box is checked", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        seen.push(String(input));
        return Promise.resolve({
          ok: true,
          status: 200,
          blob: async () => new Blob(["{}"], { type: "application/json" }),
        } as Response);
      }),
    );
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    await renderSection();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Export workspace bundle" }));
    await waitFor(() =>
      expect(seen).toEqual([
        `/api/v1/engagements/${engagementId}/workspace-bundle?privateCopy=true`,
      ]),
    );
    expect(await screen.findByText(/Handle it as sensitive/)).toBeTruthy();
    clickSpy.mockRestore();
  });

  it("imports a bundle file and summarizes the new engagement", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "/api/v1/workspace-bundles/import") {
          expect(init?.method).toBe("POST");
          return Promise.resolve({
            ok: true,
            status: 201,
            json: async () => importSuccess(),
          } as Response);
        }
        return Promise.reject(new Error(`unexpected fetch ${String(input)}`));
      }),
    );
    await renderSection();
    const picker = screen.getByLabelText("Choose a workspace bundle file");
    const file = new File([JSON.stringify(bundleFile())], "bundle.json", {
      type: "application/json",
    });
    fireEvent.change(picker, { target: { files: [file] } });
    expect(await screen.findByText(/Imported as a new engagement/)).toBeTruthy();
    expect(screen.getByText(newEngagementId)).toBeTruthy();
    expect(screen.getByText(/with 2 leads, 1 findings/)).toBeTruthy();
  });

  it("reports a clear error when the bundle fails its integrity check", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 422,
          json: async () => ({ code: "bundle_digest_mismatch" }),
        } as Response),
      ),
    );
    await renderSection();
    const picker = screen.getByLabelText("Choose a workspace bundle file");
    const file = new File([JSON.stringify(bundleFile())], "bundle.json", {
      type: "application/json",
    });
    fireEvent.change(picker, { target: { files: [file] } });
    expect(await screen.findByText(/integrity check/)).toBeTruthy();
  });

  it("rejects an oversized file before reading it", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("must not fetch")));
    vi.stubGlobal("fetch", fetchMock);
    await renderSection();
    const picker = screen.getByLabelText("Choose a workspace bundle file");
    const oversized = new File(
      [new ArrayBuffer(32 * 1024 * 1024 + 1)],
      "bundle.json",
      { type: "application/json" },
    );
    fireEvent.change(picker, { target: { files: [oversized] } });
    expect(await screen.findByText(/larger than the import limit/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
