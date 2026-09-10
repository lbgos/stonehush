// @vitest-environment jsdom

import { ThemeProvider } from "@blackglass/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { CaptureView } from "./capture.js";

const ENGAGEMENT_ID = "10000000-0000-4000-8000-000000000001";
const TARGET_ID = "10000000-0000-4000-8000-000000000002";

function response(payload: unknown, status = 200): Response {
  return {
    json: async () => payload,
    ok: status >= 200 && status < 300,
    status,
  } as Response;
}

const postedBodies: unknown[] = [];
const testQueryClients = new Set<QueryClient>();

function renderCapture() {
  const queryClient = createAppQueryClient();
  testQueryClients.add(queryClient);
  return render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <CaptureView engagementId={ENGAGEMENT_ID} targetId={TARGET_ID} targetLabel="web01" />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  postedBodies.length = 0;
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
});

afterEach(() => {
  cleanup();
  for (const client of testQueryClients) client.clear();
  testQueryClients.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CaptureView", () => {
  it("captures pasted terminal output without inventing execution facts", async () => {
    const capture = {
      contractVersion: 1,
      id: "10000000-0000-4000-8000-000000000003",
      engagementId: ENGAGEMENT_ID,
      targetId: TARGET_ID,
      leadId: null,
      kind: "pasted_terminal",
      originLabel: "pasted",
      title: "nmap on web01",
      command: "nmap -sV 10.0.0.9",
      observation: "port 80 open",
      contentDigest:
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      provenanceExistingId: null,
      byteSize: 16,
      createdAt: "2026-08-12T12:00:00.000Z",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST") {
          postedBodies.push(init.body !== undefined ? JSON.parse(String(init.body)) : undefined);
          return Promise.resolve(response({ deduplicated: false, capture }, 201));
        }
        if (url.endsWith("/stone-captures")) return Promise.resolve(response([]));
        return Promise.resolve(response({ code: "invalid_request" }, 400));
      }),
    );
    renderCapture();

    expect(await screen.findByText("No captures yet.")).toBeDefined();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "nmap on web01" } });
    fireEvent.change(screen.getByLabelText("Command, optional"), {
      target: { value: "nmap -sV 10.0.0.9" },
    });
    fireEvent.change(screen.getByLabelText("Observation, one line, optional"), {
      target: { value: "port 80 open" },
    });
    fireEvent.change(screen.getByLabelText("Terminal output"), {
      target: { value: "Nmap scan report" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Capture paste" }));

    expect(await screen.findByText(/Captured as pasted/)).toBeDefined();
    expect(postedBodies).toHaveLength(1);
    const body = postedBodies[0] as Record<string, unknown>;
    expect(body["kind"]).toBe("pasted_terminal");
    for (const invented of ["startedAt", "finishedAt", "exitCode", "executedCommand", "runnerTarget"]) {
      expect(body).not.toHaveProperty(invented);
    }
  });

  it("points a repeated import at the existing capture", async () => {
    const existing = {
      contractVersion: 1,
      id: "10000000-0000-4000-8000-000000000003",
      engagementId: ENGAGEMENT_ID,
      targetId: null,
      leadId: null,
      kind: "nmap_xml",
      originLabel: "imported",
      title: "Nmap import",
      command: null,
      observation: null,
      contentDigest:
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      provenanceExistingId: null,
      byteSize: 32,
      createdAt: "2026-08-12T12:00:00.000Z",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST" && url.includes("/stone-imports/")) {
          return Promise.resolve(response({ deduplicated: true, capture: existing }, 200));
        }
        if (url.endsWith("/stone-captures")) return Promise.resolve(response([]));
        return Promise.resolve(response({ code: "invalid_request" }, 400));
      }),
    );
    renderCapture();

    expect(await screen.findByText("No captures yet.")).toBeDefined();
    fireEvent.change(screen.getByLabelText("File content"), {
      target: { value: "<nmaprun></nmaprun>" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    expect(await screen.findByText(/No duplicate facts created/)).toBeDefined();
  });
});
