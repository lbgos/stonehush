// @vitest-environment jsdom

import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
      contentText: "Nmap scan report",
      fileName: null,
      contentDigest:
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      provenanceExistingId: null,
      byteSize: 16,
      createdAt: "2026-08-12T12:00:00.000Z",
    };
    let posted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST") {
          postedBodies.push(init.body !== undefined ? JSON.parse(String(init.body)) : undefined);
          posted = true;
          return Promise.resolve(response({ deduplicated: false, capture }, 201));
        }
        if (url.endsWith("/stone-captures"))
          return Promise.resolve(response(posted ? [capture] : []));
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
    expect(await screen.findByText("Nmap scan report")).toBeDefined();
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
      contentText: "<nmaprun></nmaprun>",
      fileName: null,
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

  it("imports a proxy HAR selection with a result summary", async () => {
    const harText = JSON.stringify({
      log: {
        version: "1.2",
        entries: [
          {
            request: { method: "GET", url: "https://morrow.test/login" },
            response: { status: 200 },
          },
        ],
      },
    });
    const capture = {
      contractVersion: 1,
      id: "10000000-0000-4000-8000-000000000003",
      engagementId: ENGAGEMENT_ID,
      targetId: TARGET_ID,
      leadId: null,
      kind: "har",
      originLabel: "imported",
      title: "GET https://morrow.test/login",
      command: null,
      observation: null,
      contentText: harText,
      fileName: "morrow.har",
      contentDigest:
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      provenanceExistingId: null,
      byteSize: harText.length,
      createdAt: "2026-08-12T12:00:00.000Z",
    };
    const postedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST") {
          postedUrls.push(url);
          postedBodies.push(init.body !== undefined ? JSON.parse(String(init.body)) : undefined);
          return Promise.resolve(response({ deduplicated: false, capture }, 201));
        }
        if (url.endsWith("/stone-captures")) return Promise.resolve(response([]));
        return Promise.resolve(response({ code: "invalid_request" }, 400));
      }),
    );
    renderCapture();

    expect(await screen.findByText("No captures yet.")).toBeDefined();
    fireEvent.change(screen.getByLabelText("Artifact"), { target: { value: "har" } });
    fireEvent.change(screen.getByLabelText("File content"), { target: { value: harText } });
    expect(await screen.findByText(/1 entry: GET https:\/\/morrow\.test\/login/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    expect(await screen.findByText(/Labeled imported with provenance/)).toBeDefined();
    expect(await screen.findByText(/status 200/)).toBeDefined();
    expect(postedUrls).toHaveLength(1);
    expect(postedUrls[0]).toContain("/stone-imports/har");
    const body = postedBodies[0] as Record<string, unknown>;
    expect(body["contentText"]).toBe(harText);
    for (const invented of ["startedAt", "finishedAt", "exitCode", "executedCommand", "runnerTarget"]) {
      expect(body).not.toHaveProperty(invented);
    }
  });

  it("loads a HAR file through the picker and names rejection reasons", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST") {
          return Promise.resolve(response({ code: "har_too_many_entries" }, 400));
        }
        if (url.endsWith("/stone-captures")) return Promise.resolve(response([]));
        return Promise.resolve(response({ code: "invalid_request" }, 400));
      }),
    );
    renderCapture();

    expect(await screen.findByText("No captures yet.")).toBeDefined();
    fireEvent.change(screen.getByLabelText("Artifact"), { target: { value: "har" } });
    const harText = JSON.stringify({
      log: {
        version: "1.2",
        entries: [
          {
            request: { method: "GET", url: "https://morrow.test/login" },
            response: { status: 200 },
          },
        ],
      },
    });
    const file = new File([harText], "morrow.har", { type: "application/json" });
    fireEvent.change(
      screen.getByLabelText("Drop a HAR file with one request or a small selection"),
      { target: { files: [file] } },
    );
    expect(await screen.findByText("Selected morrow.har.")).toBeDefined();
    expect(await screen.findByText(/1 entry: GET https:\/\/morrow\.test\/login/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByText(/more than 8 entries/)).toBeDefined();
  });

  it("drops the picked file name once the HAR text is edited", async () => {
    const harText = JSON.stringify({
      log: {
        version: "1.2",
        entries: [
          {
            request: { method: "GET", url: "https://morrow.test/login" },
            response: { status: 200 },
          },
        ],
      },
    });
    const capture = {
      contractVersion: 1,
      id: "10000000-0000-4000-8000-000000000003",
      engagementId: ENGAGEMENT_ID,
      targetId: TARGET_ID,
      leadId: null,
      kind: "har",
      originLabel: "imported",
      title: "GET https://morrow.test/login",
      command: null,
      observation: null,
      contentText: `${harText} `,
      fileName: null,
      contentDigest:
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      provenanceExistingId: null,
      byteSize: harText.length + 1,
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
    fireEvent.change(screen.getByLabelText("Artifact"), { target: { value: "har" } });
    const file = new File([harText], "morrow.har", { type: "application/json" });
    fireEvent.change(
      screen.getByLabelText("Drop a HAR file with one request or a small selection"),
      { target: { files: [file] } },
    );
    expect(await screen.findByText("Selected morrow.har.")).toBeDefined();

    fireEvent.change(screen.getByLabelText("File content"), {
      target: { value: `${harText} ` },
    });
    expect(screen.queryByText("Selected morrow.har.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => {
      expect(postedBodies).toHaveLength(1);
    });
    expect(postedBodies[0]).not.toHaveProperty("fileName");
  });

  it("rejects oversized files before reading them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          postedBodies.push(init.body !== undefined ? JSON.parse(String(init.body)) : undefined);
          return Promise.resolve(response({}, 201));
        }
        return Promise.resolve(response([]));
      }),
    );
    renderCapture();

    expect(await screen.findByText("No captures yet.")).toBeDefined();
    const file = new File(["x"], "big.bin", { type: "application/octet-stream" });
    Object.defineProperty(file, "size", { value: 67_108_865 });
    fireEvent.change(screen.getByLabelText("Drop a file into the current target context"), {
      target: { files: [file] },
    });

    expect(await screen.findByText(/too large/)).toBeDefined();
    expect(postedBodies).toHaveLength(0);
  });

  it("sends small binary and empty files by digest instead of decoded text", async () => {
    vi.stubGlobal("crypto", {
      subtle: {
        digest: async () =>
          new Uint8Array(32).buffer as unknown as Awaited<ReturnType<SubtleCrypto["digest"]>>,
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          postedBodies.push(init.body !== undefined ? JSON.parse(String(init.body)) : undefined);
          return Promise.resolve(response({}, 201));
        }
        return Promise.resolve(response([]));
      }),
    );
    renderCapture();

    expect(await screen.findByText("No captures yet.")).toBeDefined();
    const binary = new File([new Uint8Array([0xff, 0xd8, 0xff])], "snap.bin", { type: "" });
    fireEvent.change(screen.getByLabelText("Drop a file into the current target context"), {
      target: { files: [binary] },
    });
    await waitFor(() => {
      expect(postedBodies).toHaveLength(1);
    });
    const binaryBody = postedBodies[0] as Record<string, unknown>;
    expect(binaryBody).not.toHaveProperty("contentText");
    expect(binaryBody["contentDigest"]).toMatch(/^sha256:[0-9a-f]{64}$/);

    const empty = new File([], "empty.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("Drop a file into the current target context"), {
      target: { files: [empty] },
    });
    await waitFor(() => {
      expect(postedBodies).toHaveLength(2);
    });
    const emptyBody = postedBodies[1] as Record<string, unknown>;
    expect(emptyBody).not.toHaveProperty("contentText");
    expect(emptyBody["contentDigest"]).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
