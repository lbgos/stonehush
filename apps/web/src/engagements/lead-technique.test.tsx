// @vitest-environment jsdom

import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { EngagementLeadsSection, LeadDetail } from "./leads.js";

const ENGAGEMENT_ID = "10000000-0000-4000-8000-000000000001";
const LEAD_ID = "20000000-0000-4000-8000-000000000001";
const TS = "2026-10-01T12:00:00.000Z";

function response(payload: unknown, status = 200): Response {
  return { json: async () => payload, ok: status >= 200 && status < 300, status } as Response;
}

function lead(title = "Default creds") {
  return {
    contractVersion: 1 as const,
    id: LEAD_ID,
    engagementId: ENGAGEMENT_ID,
    title,
    target: "192.0.2.10",
    serviceRef: null,
    source: { kind: "manual" as const, ref: "probe-artifact-1" },
    nextStep: null,
    disposition: "closed" as const,
    parkReason: null,
    testedConditions: null,
    closedNote: null,
    revisitSuggestion: null,
    createdAt: TS,
    updatedAt: TS,
  };
}

function attempt(sequence: number, summary: string, extra: Record<string, unknown> = {}) {
  return {
    contractVersion: 1,
    id: `30000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    engagementId: ENGAGEMENT_ID,
    leadId: LEAD_ID,
    sequence,
    summary,
    outcome: "observed",
    conditions: null,
    evidenceArtifactIds: ["shared-capture-1"],
    linkedFindingId: null,
    linkedObjectiveId: null,
    createdAt: TS,
    ...extra,
  };
}

const ATTEMPTS = [
  attempt(1, "Opened http://admin:synthetic@192.0.2.10/login\n\n$ curl -s http://192.0.2.10/ <b>x</b>"),
  attempt(2, "Checked robots.txt"),
  attempt(3, "Vendor default rejected on 192.0.2.10", { outcome: "ruled_out", conditions: "only over plain http" }),
];

interface Server {
  title?: string;
  attempts?: unknown[];
  saveTechnique?: (body: Record<string, unknown>) => Response | Promise<Response>;
}

function savedTechnique(body: Record<string, unknown>, engagementId = ENGAGEMENT_ID) {
  return {
    contractVersion: 1,
    id: "60000000-0000-4000-8000-000000000001",
    engagementId,
    ...body,
    createdAt: TS,
    updatedAt: TS,
  };
}

function serve(server: Server) {
  const posts: Record<string, unknown>[] = [];
  const otherWrites: string[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const write = init?.method !== undefined && init.method !== "GET";
    if (url.endsWith("/techniques") && write) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      posts.push(body);
      return Promise.resolve(server.saveTechnique?.(body) ?? response(savedTechnique(body), 201));
    }
    if (write) otherWrites.push(url);
    if (url.endsWith("/techniques")) return Promise.resolve(response([]));
    if (url.endsWith("/leads")) return Promise.resolve(response([lead(server.title)]));
    if (url.endsWith("/attempts")) return Promise.resolve(response(server.attempts ?? ATTEMPTS));
    if (url.endsWith("/outline")) return Promise.resolve(response({ outline: "" }));
    return Promise.resolve(response([]));
  });
  vi.stubGlobal("fetch", fetchMock);
  return { posts, otherWrites, fetchMock };
}

const testQueryClients = new Set<QueryClient>();

function renderLeads(archived = false) {
  const queryClient = createAppQueryClient();
  testQueryClients.add(queryClient);
  return render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <EngagementLeadsSection archived={archived} engagementId={ENGAGEMENT_ID} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

async function openDraft(sequences: number[]) {
  fireEvent.click(await screen.findByRole("button", { name: "Detail" }));
  fireEvent.click(await screen.findByRole("button", { name: "Save as technique" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Use attempt 1")));
  for (const sequence of sequences) fireEvent.click(screen.getByLabelText(`Use attempt ${sequence}`));
  fireEvent.click(screen.getByRole("button", { name: `Review ${sequences.length} ${sequences.length === 1 ? "step" : "steps"}` }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Technique draft" })));
}

const instructions = () => screen.getAllByLabelText<HTMLTextAreaElement>("Instruction").map((field) => field.value);

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
  for (const client of testQueryClients) client.clear();
  testQueryClients.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("save a lead's attempts as a technique", () => {
  it("drafts nonadjacent attempts in sequence, edits a placeholder and posts only reviewed fields once", async () => {
    const { posts, otherWrites } = serve({});
    renderLeads();
    await openDraft([3, 1]);

    expect(instructions()).toEqual([
      "Opened http://192.0.2.10/login\n\n$ curl -s http://192.0.2.10/ <b>x</b>",
      "Vendor default rejected on 192.0.2.10",
    ]);
    expect(screen.getAllByLabelText<HTMLInputElement>(/^Command, optional/).map((field) => field.value)).toEqual(["", ""]);
    expect(screen.getByText("From attempt 3: ruled out under conditions under only over plain http")).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Distinguishing question").value).toBe("");
    expect(posts).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("Exact text in steps"), { target: { value: "192.0.2.10" } });
    fireEvent.change(screen.getByLabelText("Placeholder name"), { target: { value: "target" } });
    expect(screen.getByText("3 matches in steps.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(instructions()[1]).toBe("Vendor default rejected on {{target}}");
    expect(screen.getByText("{{target}}")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Distinguishing question"), { target: { value: "Does the vendor default work?" } });
    const saveButton = screen.getByRole("button", { name: "Save technique" });
    fireEvent.click(saveButton);
    fireEvent.click(saveButton);

    expect(await screen.findByText(/Saved "Default creds"/)).toBeTruthy();
    expect(posts).toEqual([
      {
        name: "Default creds",
        whenUseful: "",
        prerequisites: [],
        question: "Does the vendor default work?",
        procedure: [
          { instruction: "Opened http://{{target}}/login\n\n$ curl -s http://{{target}}/ <b>x</b>" },
          { instruction: "Vendor default rejected on {{target}}" },
        ],
        meaning: "",
      },
    ]);
    expect(JSON.stringify(posts)).not.toContain("synthetic");
    expect(JSON.stringify(posts)).not.toContain("shared-capture-1");
    expect(otherWrites).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save as technique" })));
    expect(screen.queryByLabelText("Use attempt 1")).toBe(null);
  });

  it("keeps an overlong title and summary for editing and blocks Save until they fit", async () => {
    const { posts } = serve({ title: "t".repeat(90), attempts: [attempt(1, "s".repeat(2000))] });
    renderLeads();
    await openDraft([1]);

    expect(screen.getByLabelText<HTMLInputElement>("Name").value).toBe("t".repeat(90));
    expect(instructions()).toEqual(["s".repeat(2000)]);
    expect(screen.getByText("90 of 80 characters. Shorten before saving.")).toBeTruthy();
    expect(screen.getByText("2000 of 500 characters. Shorten before saving.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save technique" }));
    expect(await screen.findByText("Fix 3 problems before saving.")).toBeTruthy();
    expect(posts).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Short name" } });
    fireEvent.change(screen.getByLabelText("Instruction"), { target: { value: "Short step" } });
    fireEvent.change(screen.getByLabelText("Distinguishing question"), { target: { value: "Which?" } });
    fireEvent.click(screen.getByRole("button", { name: "Save technique" }));
    await waitFor(() => expect(posts).toHaveLength(1));
  });

  it("keeps edits after a refused save and retries as a new save", async () => {
    let fail = true;
    const { posts } = serve({
      saveTechnique: (body) => (fail ? response({ code: "storage_busy" }, 503) : response(savedTechnique(body), 201)),
    });
    renderLeads();
    await openDraft([2]);
    fireEvent.change(screen.getByLabelText("Distinguishing question"), { target: { value: "Is robots.txt useful?" } });
    fireEvent.click(screen.getByRole("button", { name: "Save technique" }));

    expect(await screen.findByText("Storage is busy. The draft is kept. Retry when ready.")).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Distinguishing question").value).toBe("Is robots.txt useful?");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
    expect(await screen.findByText(/Saved "Default creds"/)).toBeTruthy();
    expect(posts).toHaveLength(2);
  });

  it("names an archived refusal and keeps the draft without claiming a save", async () => {
    serve({
      saveTechnique: () => response({ code: "engagement_archived" }, 409),
    });
    renderLeads();
    await openDraft([2]);
    fireEvent.change(screen.getByLabelText("Distinguishing question"), { target: { value: "Which?" } });
    fireEvent.click(screen.getByRole("button", { name: "Save technique" }));

    expect(await screen.findByText("This engagement is archived. The draft is kept but cannot be saved.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Technique draft" })).toBeTruthy();
    expect(screen.queryByText(/Saved "/)).toBe(null);
  });

  it("marks an unreadable save outcome as unknown so a retry checks Techniques first", async () => {
    const { posts } = serve({
      saveTechnique: () => Promise.reject(new Error("network down")),
    });
    renderLeads();
    await openDraft([2]);
    fireEvent.change(screen.getByLabelText("Distinguishing question"), { target: { value: "Which?" } });
    fireEvent.click(screen.getByRole("button", { name: "Save technique" }));

    expect(
      await screen.findByText(
        "The save outcome is unknown. The draft is kept. Check Advisor Techniques before saving again to avoid a duplicate.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Technique draft" })).toBeTruthy();
    expect(posts).toHaveLength(1);
  });

  it("does not acknowledge a technique answered for another engagement", async () => {
    serve({ saveTechnique: (body) => response(savedTechnique(body, "10000000-0000-4000-8000-000000000002"), 201) });
    renderLeads();
    await openDraft([2]);
    fireEvent.change(screen.getByLabelText("Distinguishing question"), { target: { value: "Which?" } });
    fireEvent.click(screen.getByRole("button", { name: "Save technique" }));

    expect(await screen.findByText(/The response named another engagement/)).toBeTruthy();
    expect(screen.queryByText(/Saved "/)).toBe(null);
    expect(screen.getByRole("heading", { name: "Technique draft" })).toBeTruthy();
  });

  it("asks before discarding edits and returns focus to the control that opened each step", async () => {
    serve({});
    renderLeads();
    await openDraft([1, 2]);

    fireEvent.change(screen.getByLabelText("Distinguishing question"), { target: { value: "Edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Discard the technique edits? The selection stays.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Review 2 steps" })));
    expect(screen.getByLabelText<HTMLInputElement>("Use attempt 1").checked).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>("Use attempt 2").checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save as technique" })));
  });

  it("offers no save path for an archived engagement", async () => {
    serve({});
    renderLeads(true);
    fireEvent.click(await screen.findByRole("button", { name: "Detail" }));
    expect(await screen.findByText(/^1\. Opened/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save as technique" })).toBe(null);
  });

  it("drops an open draft on inline Hide without leaking it to the next open", async () => {
    serve({});
    renderLeads();
    await openDraft([1]);
    expect(screen.getByRole("heading", { name: "Technique draft" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByRole("heading", { name: "Technique draft" })).toBe(null);

    fireEvent.click(screen.getByRole("button", { name: "Detail" }));
    expect(await screen.findByText(/^1\. Opened/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Technique draft" })).toBe(null);
    expect(screen.queryByLabelText("Use attempt 1")).toBe(null);
  });

  it("waits for a fresh read before Review and Save when read-only", async () => {
    serve({});
    const queryClient = createAppQueryClient();
    testQueryClients.add(queryClient);
    render(
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <LeadDetail archived={false} engagementId={ENGAGEMENT_ID} lead={lead()} readOnly />
        </QueryClientProvider>
      </ThemeProvider>,
    );
    expect(await screen.findByText(/^1\. Opened/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save as technique" }));
    fireEvent.click(await screen.findByLabelText("Use attempt 1"));
    expect(screen.getByText("Review waits until this lead reads again.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review 1 step" }));
    expect(screen.queryByRole("heading", { name: "Technique draft" })).toBe(null);
  });
});
