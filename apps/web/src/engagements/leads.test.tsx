// @vitest-environment jsdom

import { ThemeProvider } from "@blackglass/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import {
  EngagementLeadsSection,
  EngagementObjectivesSection,
  EngagementSecretsSection,
} from "./leads.js";

const ENGAGEMENT_ID = "10000000-0000-4000-8000-000000000001";
const TS = "2026-08-12T12:00:00.000Z";

function response(payload: unknown, status = 200): Response {
  return {
    json: async () => payload,
    ok: status >= 200 && status < 300,
    status,
  } as Response;
}

const testQueryClients = new Set<QueryClient>();

function renderSections() {
  const queryClient = createAppQueryClient();
  testQueryClients.add(queryClient);
  return render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <EngagementLeadsSection archived={false} engagementId={ENGAGEMENT_ID} />
        <EngagementObjectivesSection archived={false} engagementId={ENGAGEMENT_ID} />
        <EngagementSecretsSection archived={false} engagementId={ENGAGEMENT_ID} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  for (const client of testQueryClients) client.clear();
  testQueryClients.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("stone leads workspace sections", () => {
  it("creates a lead without severity and parks it with a reason", async () => {
    let leads: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/objectives")) return Promise.resolve(response([]));
        if (url.endsWith("/secrets")) return Promise.resolve(response([]));
        if (url.endsWith("/leads") && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          expect("severity" in body).toBe(false);
          leads = [
            {
              contractVersion: 1,
              id: "20000000-0000-4000-8000-000000000001",
              engagementId: ENGAGEMENT_ID,
              title: body["title"],
              target: null,
              serviceRef: null,
              source: body["source"],
              nextStep: null,
              disposition: "open",
              parkReason: null,
              testedConditions: null,
              closedNote: null,
              revisitSuggestion: null,
              createdAt: TS,
              updatedAt: TS,
            },
          ];
          return Promise.resolve(response(leads[0], 201));
        }
        if (url.endsWith("/leads")) return Promise.resolve(response(leads));
        if (url.endsWith("/park")) {
          leads = [
            {
              ...(leads[0] as Record<string, unknown>),
              disposition: "parked",
              parkReason: "No working credentials yet",
              testedConditions: "Only checked without authentication",
            },
          ];
          return Promise.resolve(response(leads[0], 200));
        }
        if (url.includes("/attempts")) return Promise.resolve(response([]));
        if (url.includes("/outline")) return Promise.resolve(response({ outline: "" }));
        return Promise.resolve(response([]));
      }),
    );

    renderSections();
    expect(await screen.findByText("No leads yet")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Odd login form on port 8080" },
    });
    fireEvent.change(screen.getByLabelText("Source evidence reference"), {
      target: { value: "probe-artifact-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create lead" }));

    await waitFor(() => expect(screen.getByText("1 open of 1 leads")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Detail" }));

    fireEvent.change(screen.getByLabelText("Park reason"), {
      target: { value: "No working credentials yet" },
    });
    fireEvent.change(screen.getByLabelText("Tested conditions, optional"), {
      target: { value: "Only checked without authentication" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Park with reason" }));

    await waitFor(() =>
      expect(screen.getByText(/Parked: No working credentials yet/)).toBeTruthy(),
    );
  });

  it("captures an objective as masked and submits as a distinct step", async () => {
    let objectives: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/leads")) return Promise.resolve(response([]));
        if (url.endsWith("/secrets")) return Promise.resolve(response([]));
        if (url.endsWith("/objectives") && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          objectives = [
            {
              contractVersion: 1,
              id: "30000000-0000-4000-8000-000000000001",
              engagementId: ENGAGEMENT_ID,
              name: body["name"],
              kind: body["kind"],
              state: "open",
              proofHint: null,
              proofDigest: null,
              capturedAt: null,
              submittedAt: null,
              createdAt: TS,
              updatedAt: TS,
            },
          ];
          return Promise.resolve(response(objectives[0], 201));
        }
        if (url.endsWith("/objectives")) return Promise.resolve(response(objectives));
        if (url.endsWith("/capture")) {
          objectives = [
            {
              ...(objectives[0] as Record<string, unknown>),
              state: "captured",
              proofHint: "24 bytes, ends 01",
              proofDigest: `sha256:${"0".repeat(64)}`,
              capturedAt: TS,
            },
          ];
          return Promise.resolve(response(objectives[0], 200));
        }
        if (url.endsWith("/submit")) {
          objectives = [
            {
              ...(objectives[0] as Record<string, unknown>),
              state: "submitted",
              submittedAt: TS,
            },
          ];
          return Promise.resolve(response(objectives[0], 200));
        }
        return Promise.resolve(response([]));
      }),
    );

    renderSections();
    expect(await screen.findByText("No objectives yet")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "user flag" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create objective" }));
    expect(await screen.findByText("user flag")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Proof value, hashed on capture and never stored"), {
      target: { value: "flag{synthetic-proof-0001}" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Capture" }));
    await waitFor(() => expect(screen.getByText("Submit")).toBeTruthy());
    expect(screen.queryByText(/flag\{synthetic-proof-0001\}/)).toBe(null);

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(screen.getByText("Reopen")).toBeTruthy());
  });

  it("records a service-scoped secret with per-item reveal and masked display", async () => {
    let secrets: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/leads")) return Promise.resolve(response([]));
        if (url.endsWith("/objectives")) return Promise.resolve(response([]));
        if (url.endsWith("/secrets") && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          secrets = [
            {
              contractVersion: 1,
              id: "40000000-0000-4000-8000-000000000001",
              engagementId: ENGAGEMENT_ID,
              label: body["label"],
              username: body["username"] ?? null,
              serviceRef: body["serviceRef"],
              secretRef: body["secretRef"],
              hint: body["hint"] ?? null,
              verifications: [],
              createdAt: TS,
              updatedAt: TS,
            },
          ];
          return Promise.resolve(response(secrets[0], 201));
        }
        if (url.endsWith("/secrets")) return Promise.resolve(response(secrets));
        return Promise.resolve(response([]));
      }),
    );

    renderSections();
    expect(await screen.findByText("No secrets yet")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Label"), {
      target: { value: "SSH password for app host" },
    });
    fireEvent.change(screen.getByLabelText("Service, exactly one"), {
      target: { value: "192.0.2.10:22/ssh" },
    });
    fireEvent.change(screen.getByLabelText("Secret reference, never a value"), {
      target: { value: "vault:stone/lab-app-ssh" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create secret" }));

    expect(await screen.findByText("SSH password for app host")).toBeTruthy();
    expect(screen.getByText("[masked]")).toBeTruthy();
    expect(screen.queryByText("vault:stone/lab-app-ssh")).toBe(null);

    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    expect(await screen.findByText("ref vault:stone/lab-app-ssh")).toBeTruthy();
  });
});
