// @vitest-environment jsdom

import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { EngagementAccessSection } from "./access.js";
const ENGAGEMENT_ID = "10000000-0000-4000-8000-000000000001";
const TARGET_ID = "10000000-0000-4000-8000-000000000002";
const LEAD_ID = "10000000-0000-4000-8000-000000000003";
const SECRET_ID = "10000000-0000-4000-8000-000000000004";
const ACCESS_ID = "10000000-0000-4000-8000-000000000005";
const AT = "2026-09-10T12:00:00.000Z";
const MARKER = "marker-7qvz-vault-ref";

const target = {
  contractVersion: 1,
  id: TARGET_ID,
  engagementId: ENGAGEMENT_ID,
  label: "morrow",
  revision: 1,
  createdAt: AT,
  updatedAt: AT,
};

const lead = {
  contractVersion: 1,
  id: LEAD_ID,
  engagementId: ENGAGEMENT_ID,
  title: "Odd login form",
  target: null,
  serviceRef: null,
  source: { kind: "http_probe", ref: "probe-1" },
  nextStep: null,
  disposition: "parked",
  parkReason: "No working credentials yet",
  testedConditions: "Only checked without authentication",
  closedNote: null,
  revisitSuggestion: null,
  createdAt: AT,
  updatedAt: AT,
};

const secret = {
  contractVersion: 1,
  id: SECRET_ID,
  engagementId: ENGAGEMENT_ID,
  label: "deploy key",
  username: "deploy",
  serviceRef: "ssh:10.0.0.5:22",
  secretRef: `vault/morrow/${MARKER}`,
  hint: "opaque reference",
  verifications: [],
  createdAt: AT,
  updatedAt: AT,
};

function accessRecord(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: 1,
    id: ACCESS_ID,
    engagementId: ENGAGEMENT_ID,
    targetId: TARGET_ID,
    account: "deploy",
    accessType: "ssh",
    sourceLeadId: LEAD_ID,
    secretId: SECRET_ID,
    context: "SSH from the runner network",
    lastConfirmedAt: AT,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

const testQueryClients = new Set<QueryClient>();

function renderSection() {
  const queryClient = createAppQueryClient();
  testQueryClients.add(queryClient);
  return render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <EngagementAccessSection archived={false} engagementId={ENGAGEMENT_ID} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const client of testQueryClients) client.clear();
  testQueryClients.clear();
});

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

describe("recorded access section", () => {
  it("lists recorded access with recorded wording and masked secrets", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/access")) {
          return { json: async () => [accessRecord()], ok: true, status: 200 } as Response;
        }
        if (url.endsWith("/stone-targets")) {
          return { json: async () => [target], ok: true, status: 200 } as Response;
        }
        if (url.endsWith("/leads")) {
          return { json: async () => [lead], ok: true, status: 200 } as Response;
        }
        if (url.endsWith("/secrets")) {
          return { json: async () => [secret], ok: true, status: 200 } as Response;
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    renderSection();

    await waitFor(() => expect(screen.getByTestId("access-record")).toBeDefined());
    expect(screen.getByText(/Recorded SSH access/)).toBeDefined();
    expect(screen.getByText(/Last confirmed/)).toBeDefined();
    const row = screen.getByTestId("access-record");
    await waitFor(() => expect(within(row).getByText(/deploy key/)).toBeDefined());
    expect(within(row).getByText(/\[masked\]/)).toBeDefined();
    expect(document.body.textContent).not.toContain(MARKER);
    expect(document.body.textContent).not.toContain("vault/morrow");
  });

  it("records new access through the form and refreshes last confirmed", async () => {
    const records: Record<string, unknown>[] = [];
    const seen: { method: string | undefined; url: string; body: BodyInit | null | undefined }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        seen.push({ method: init?.method, url, body: init?.body });
        if (url.endsWith("/access") && (init?.method ?? "GET") === "GET") {
          return { json: async () => records, ok: true, status: 200 } as Response;
        }
        if (url.endsWith("/access") && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          records.push(accessRecord({ account: body["account"], context: null }));
          return { json: async () => records[0], ok: true, status: 201 } as Response;
        }
        if (url.endsWith("/refresh") && init?.method === "POST") {
          records[0] = accessRecord({
            account: records[0]?.["account"] ?? "deploy",
            context: null,
            lastConfirmedAt: "2026-09-11T12:00:00.000Z",
            updatedAt: "2026-09-11T12:00:00.000Z",
          });
          return { json: async () => records[0], ok: true, status: 200 } as Response;
        }
        if (url.endsWith("/stone-targets")) {
          return { json: async () => [target], ok: true, status: 200 } as Response;
        }
        if (url.endsWith("/leads")) {
          return { json: async () => [lead], ok: true, status: 200 } as Response;
        }
        if (url.endsWith("/secrets")) {
          return { json: async () => [secret], ok: true, status: 200 } as Response;
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    renderSection();

    await waitFor(() => expect(screen.getByText("No access recorded yet")).toBeDefined());
    await waitFor(() => expect(screen.getByRole("option", { name: "morrow" })).toBeDefined());
    fireEvent.change(screen.getByLabelText("Target"), { target: { value: TARGET_ID } });
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "deploy" } });
    fireEvent.change(screen.getByLabelText("Source lead"), { target: { value: LEAD_ID } });
    fireEvent.click(screen.getByRole("button", { name: "Record access" }));

    await waitFor(() => expect(screen.getByTestId("access-record")).toBeDefined());
    expect(screen.getByText(/Recorded SSH access/)).toBeDefined();
    const posted = seen.find((entry) => entry.method === "POST" && entry.url?.endsWith("/access"));
    const postedBody = JSON.parse(String(posted?.body)) as Record<string, unknown>;
    expect(postedBody).toMatchObject({ targetId: TARGET_ID, sourceLeadId: LEAD_ID });

    fireEvent.click(screen.getByRole("button", { name: "Refresh confirmation" }));
    await waitFor(() => expect(screen.getByText(/11 Sept 2026/)).toBeDefined());
    expect(document.body.textContent).not.toContain("Connected");
  });
});
