// @vitest-environment jsdom

import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { EngagementLeadsSection } from "./leads.js";
import { leadAttemptsQueryKey, leadOutlineQueryKey } from "./leads-query.js";
import { RunHistoryPanel } from "./run-history-panel.js";
import { runLeadEvidence } from "./run-lead-attempt.js";
import { EngagementWorkspaceProvider } from "./workspace-context.js";

const ENGAGEMENT_A = "10000000-0000-4000-8000-00000000000a";
const ENGAGEMENT_B = "10000000-0000-4000-8000-00000000000b";
const LEAD_OPEN = "20000000-0000-4000-8000-000000000001";
const LEAD_PARKED = "20000000-0000-4000-8000-000000000002";
const LEAD_CLOSED = "20000000-0000-4000-8000-000000000003";
const LEAD_B = "20000000-0000-4000-8000-0000000000b1";
const TS = "2026-08-12T12:00:00.000Z";
const DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function response(payload: unknown, status = 200): Response {
  return {
    json: async () => payload,
    ok: status >= 200 && status < 300,
    status,
  } as Response;
}

function lead(id: string, title: string, disposition: "open" | "parked" | "closed", engagementId = ENGAGEMENT_A) {
  return {
    contractVersion: 1,
    id,
    engagementId,
    title,
    target: null,
    serviceRef: null,
    source: { kind: "manual", ref: "operator" },
    nextStep: null,
    disposition,
    parkReason: disposition === "parked" ? "Needs credentials" : null,
    testedConditions: null,
    closedNote: null,
    revisitSuggestion: null,
    createdAt: TS,
    updatedAt: TS,
  };
}

type Stream =
  | { present: false; truncated: false; content: "" }
  | {
      present: true;
      artifactId: string;
      sizeBytes: number;
      digest: string;
      completeness: "complete" | "partial" | "truncated";
      truncated: boolean;
      content: string;
    };

function present(artifactId: string, content = "bytes", completeness: "complete" | "partial" = "complete"): Stream {
  return {
    present: true,
    artifactId,
    sizeBytes: content.length,
    digest: DIGEST,
    completeness,
    truncated: false,
    content,
  };
}

const absent: Stream = { present: false, truncated: false, content: "" };

function runOutput(
  runId: string,
  state: "succeeded" | "failed" | "cancelled",
  stdout: Stream,
  stderr: Stream,
  terminalReason: string | null = null,
) {
  return {
    run: {
      id: runId,
      actionId: "action-1",
      state,
      terminalKind: state,
      terminalReason,
      updatedAt: TS,
    },
    stdout,
    stderr,
  };
}

function runSummary(id: string, state: string) {
  return {
    id,
    actionId: "action-1",
    state,
    terminalKind: state === "running" ? null : state,
    terminalReason: null,
    updatedAt: TS,
    createdAt: TS,
    attempt: 1,
  };
}

interface Lab {
  runs: Record<string, ReturnType<typeof runSummary>[]>;
  outputs: Record<string, ReturnType<typeof runOutput>>;
  leads: Record<string, ReturnType<typeof lead>[]>;
  attempt?: (url: string, body: Record<string, unknown>) => Promise<Response>;
}

function stubLab(lab: Lab) {
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const engagement = /\/engagements\/([^/]+)\//.exec(url)?.[1] ?? "";
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ url, body });
      if (lab.attempt !== undefined) return lab.attempt(url, body);
      return response(
        {
          contractVersion: 1,
          id: "30000000-0000-4000-8000-000000000001",
          engagementId: engagement,
          leadId: /\/leads\/([^/]+)\/attempts$/.exec(url)?.[1],
          sequence: 2,
          summary: body["summary"],
          outcome: body["outcome"],
          conditions: body["conditions"] ?? null,
          evidenceArtifactIds: body["evidenceArtifactIds"],
          linkedFindingId: null,
          linkedObjectiveId: null,
          createdAt: TS,
        },
        201,
      );
    }
    if (/\/runs\?/.test(url)) return response({ runs: lab.runs[engagement] ?? [], nextCursor: null });
    const outputMatch = /\/runs\/([^/]+)\/output$/.exec(url);
    if (outputMatch?.[1] !== undefined) {
      const output = lab.outputs[`${engagement}:${outputMatch[1]}`];
      return output === undefined ? response({ code: "run_not_found" }, 404) : response(output);
    }
    if (url.endsWith("/leads")) return response(lab.leads[engagement] ?? []);
    if (url.includes("/attempts")) return response([]);
    if (url.includes("/outline")) return response({ outline: "" });
    return response({ code: "invalid_request" }, 400);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, posts };
}

const testQueryClients = new Set<QueryClient>();

function renderRuns(props: { engagementId: string; selectedRunId: string; archived?: boolean }) {
  const queryClient = createAppQueryClient();
  testQueryClients.add(queryClient);
  const wrap = (next: typeof props): ReactNode => (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <EngagementWorkspaceProvider openCreate={() => undefined}>
          <RunHistoryPanel
            archived={next.archived ?? false}
            engagementId={next.engagementId}
            selectedRunId={next.selectedRunId}
            onSelect={vi.fn()}
          />
        </EngagementWorkspaceProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
  const view = render(wrap(props));
  return {
    queryClient,
    rerender: (next: typeof props) => view.rerender(wrap(next)),
  };
}

function leadForm() {
  return screen.getByRole("region", { name: "Add run to lead" });
}

async function openForm() {
  fireEvent.click(await screen.findByRole("button", { name: "Add to lead" }));
  const form = leadForm();
  await within(form).findByRole("combobox", { name: "Lead" });
  return form;
}

function chooseLead(form: HTMLElement, leadId: string) {
  fireEvent.change(within(form).getByRole("combobox", { name: "Lead" }), {
    target: { value: leadId },
  });
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
  Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  for (const client of testQueryClients) client.clear();
  testQueryClients.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const LEADS_A = [
  lead(LEAD_OPEN, "Admin panel on 8080", "open"),
  lead(LEAD_PARKED, "Anonymous FTP", "parked"),
  lead(LEAD_CLOSED, "Old guess", "closed"),
];

describe("add a finished run to a lead", () => {
  it("records a succeeded run with both streams as an inconclusive attempt", async () => {
    const { posts } = stubLab({
      runs: { [ENGAGEMENT_A]: [runSummary("run-ok", "succeeded")] },
      outputs: {
        [`${ENGAGEMENT_A}:run-ok`]: runOutput("run-ok", "succeeded", present("art-out"), present("art-err")),
      },
      leads: { [ENGAGEMENT_A]: LEADS_A },
    });
    const { queryClient } = renderRuns({ engagementId: ENGAGEMENT_A, selectedRunId: "run-ok" });
    queryClient.setQueryData(leadAttemptsQueryKey(ENGAGEMENT_A, LEAD_PARKED), []);
    queryClient.setQueryData(leadOutlineQueryKey(ENGAGEMENT_A, LEAD_PARKED), "");
    const form = await openForm();

    const options = within(within(form).getByRole("combobox", { name: "Lead" }))
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(options).toEqual(["Choose a lead", "Admin panel on 8080", "Anonymous FTP (parked)"]);
    expect(within(form).getByText("stdout · 5 bytes")).toBeTruthy();
    expect(within(form).getByText("stderr · 5 bytes")).toBeTruthy();
    expect(within(form).queryByText(/art-out/)).toBeNull();
    const outcome = within(form).getByRole("combobox", { name: "Outcome" }) as HTMLSelectElement;
    expect(outcome.value).toBe("inconclusive");

    chooseLead(form, LEAD_PARKED);
    fireEvent.change(within(form).getByRole("textbox", { name: "Conditions, optional" }), {
      target: { value: "Only checked without authentication" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Record attempt" }));

    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(
      'Recorded as attempt 2 on "Anonymous FTP". Open the Leads tab to see it.',
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe(`/api/v1/engagements/${ENGAGEMENT_A}/leads/${LEAD_PARKED}/attempts`);
    expect(posts[0]?.body).toEqual({
      summary: "Run run-ok succeeded at 12 Aug 2026, 12:00 UTC, preserved stdout and stderr attached",
      outcome: "inconclusive",
      conditions: "Only checked without authentication",
      evidenceArtifactIds: ["art-out", "art-err"],
    });
    expect(screen.queryByRole("region", { name: "Add run to lead" })).toBeNull();
    await waitFor(() => {
      expect(queryClient.getQueryState(leadAttemptsQueryKey(ENGAGEMENT_A, LEAD_PARKED))?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(leadOutlineQueryKey(ENGAGEMENT_A, LEAD_PARKED))?.isInvalidated).toBe(true);
    });
  });

  it("defaults a failed run to inconclusive and attaches only the preserved stream", async () => {
    const { posts } = stubLab({
      runs: { [ENGAGEMENT_A]: [runSummary("run-bad", "failed")] },
      outputs: {
        [`${ENGAGEMENT_A}:run-bad`]: runOutput("run-bad", "failed", present("art-out"), absent, "exit_nonzero"),
      },
      leads: { [ENGAGEMENT_A]: LEADS_A },
    });
    renderRuns({ engagementId: ENGAGEMENT_A, selectedRunId: "run-bad" });
    const form = await openForm();
    expect((within(form).getByRole("combobox", { name: "Outcome" }) as HTMLSelectElement).value).toBe(
      "inconclusive",
    );
    expect(within(form).queryByText(/^stderr/)).toBeNull();
    chooseLead(form, LEAD_OPEN);
    fireEvent.click(within(form).getByRole("button", { name: "Record attempt" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.body).toEqual({
      summary: "Run run-bad failed (exit_nonzero) at 12 Aug 2026, 12:00 UTC, preserved stdout attached",
      outcome: "inconclusive",
      evidenceArtifactIds: ["art-out"],
    });
  });

  it("defaults a cancelled run to interrupted and labels partial output", async () => {
    const { posts } = stubLab({
      runs: { [ENGAGEMENT_A]: [runSummary("run-stop", "cancelled")] },
      outputs: {
        [`${ENGAGEMENT_A}:run-stop`]: runOutput(
          "run-stop",
          "cancelled",
          absent,
          present("art-err", "partial-bytes", "partial"),
        ),
      },
      leads: { [ENGAGEMENT_A]: LEADS_A },
    });
    renderRuns({ engagementId: ENGAGEMENT_A, selectedRunId: "run-stop" });
    const form = await openForm();
    expect((within(form).getByRole("combobox", { name: "Outcome" }) as HTMLSelectElement).value).toBe(
      "interrupted",
    );
    expect(within(form).getByText("stderr · 13 bytes, partial")).toBeTruthy();
    chooseLead(form, LEAD_OPEN);
    fireEvent.change(within(form).getByRole("combobox", { name: "Outcome" }), {
      target: { value: "ruled_out" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Record attempt" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.body).toMatchObject({ outcome: "ruled_out", evidenceArtifactIds: ["art-err"] });
  });

  it("lists a shared stream artifact once and never invents missing streams", () => {
    const shared = runOutput("run-x", "succeeded", present("art-same"), present("art-same"));
    expect(runLeadEvidence(shared).map((entry) => entry.artifactId)).toEqual(["art-same"]);
    expect(runLeadEvidence(runOutput("run-y", "succeeded", absent, absent))).toEqual([]);
    const running = { ...shared, run: { ...shared.run, state: "running" as const } };
    expect(runLeadEvidence(running as unknown as Parameters<typeof runLeadEvidence>[0])).toEqual([]);
  });

  it("offers no Add to lead without preserved output, for a pending run, or when archived", async () => {
    stubLab({
      runs: { [ENGAGEMENT_A]: [runSummary("run-empty", "succeeded"), runSummary("run-live", "running")] },
      outputs: {
        [`${ENGAGEMENT_A}:run-empty`]: runOutput("run-empty", "succeeded", absent, absent),
        [`${ENGAGEMENT_A}:run-ok`]: runOutput("run-ok", "succeeded", present("art-out"), absent),
      },
      leads: { [ENGAGEMENT_A]: LEADS_A },
    });
    const view = renderRuns({ engagementId: ENGAGEMENT_A, selectedRunId: "run-empty" });
    await screen.findByText(/No preserved stdout for this run/);
    expect(screen.queryByRole("button", { name: "Add to lead" })).toBeNull();

    view.rerender({ engagementId: ENGAGEMENT_A, selectedRunId: "run-live" });
    await screen.findByText(/is still running/);
    expect(screen.queryByRole("button", { name: "Add to lead" })).toBeNull();

    cleanup();
    stubLab({
      runs: { [ENGAGEMENT_A]: [runSummary("run-ok", "succeeded")] },
      outputs: { [`${ENGAGEMENT_A}:run-ok`]: runOutput("run-ok", "succeeded", present("art-out"), absent) },
      leads: { [ENGAGEMENT_A]: LEADS_A },
    });
    renderRuns({ engagementId: ENGAGEMENT_A, selectedRunId: "run-ok", archived: true });
    await screen.findByRole("button", { name: "Ask about this run" });
    expect(screen.queryByRole("button", { name: "Add to lead" })).toBeNull();
  });

  it("shows an empty state when only closed leads exist and sends nothing", async () => {
    const { posts } = stubLab({
      runs: { [ENGAGEMENT_A]: [runSummary("run-ok", "succeeded")] },
      outputs: { [`${ENGAGEMENT_A}:run-ok`]: runOutput("run-ok", "succeeded", present("art-out"), absent) },
      leads: { [ENGAGEMENT_A]: [lead(LEAD_CLOSED, "Old guess", "closed")] },
    });
    renderRuns({ engagementId: ENGAGEMENT_A, selectedRunId: "run-ok" });
    fireEvent.click(await screen.findByRole("button", { name: "Add to lead" }));
    expect(
      await within(leadForm()).findByText(
        "No open or parked leads. Start one from a Surface result or the Leads tab.",
      ),
    ).toBeTruthy();
    const record = within(leadForm()).getByRole("button", { name: "Record attempt" }) as HTMLButtonElement;
    expect(record.disabled).toBe(true);
    expect(posts).toHaveLength(0);
  });

  it("requires a lead choice before sending", async () => {
    const { posts } = stubLab({
      runs: { [ENGAGEMENT_A]: [runSummary("run-ok", "succeeded")] },
      outputs: { [`${ENGAGEMENT_A}:run-ok`]: runOutput("run-ok", "succeeded", present("art-out"), absent) },
      leads: { [ENGAGEMENT_A]: LEADS_A },
    });
    renderRuns({ engagementId: ENGAGEMENT_A, selectedRunId: "run-ok" });
    const form = await openForm();
    fireEvent.click(within(form).getByRole("button", { name: "Record attempt" }));
    expect(within(form).getByRole("alert").textContent).toBe("Choose an open or parked lead.");
    expect(posts).toHaveLength(0);
  });

  it("disables duplicate saves while pending and keeps typed input after a failure", async () => {
    let fail: ((value: Response) => void) | undefined;
    const { posts } = stubLab({
      runs: { [ENGAGEMENT_A]: [runSummary("run-ok", "succeeded")] },
      outputs: { [`${ENGAGEMENT_A}:run-ok`]: runOutput("run-ok", "succeeded", present("art-out"), absent) },
      leads: { [ENGAGEMENT_A]: LEADS_A },
      attempt: () =>
        new Promise<Response>((resolve) => {
          fail = resolve;
        }),
    });
    renderRuns({ engagementId: ENGAGEMENT_A, selectedRunId: "run-ok" });
    const form = await openForm();
    chooseLead(form, LEAD_OPEN);
    const summary = within(form).getByRole("textbox", { name: "Attempt summary" }) as HTMLInputElement;
    fireEvent.change(summary, { target: { value: "Tried the admin path with default creds" } });
    fireEvent.click(within(form).getByRole("button", { name: "Record attempt" }));
    const saving = (await within(form).findByRole("button", { name: "Saving" })) as HTMLButtonElement;
    expect(saving.disabled).toBe(true);
    fireEvent.submit(saving.closest("form") as HTMLFormElement);
    expect(posts).toHaveLength(1);

    await act(async () => {
      fail?.(response({ code: "storage_busy" }, 503));
    });
    expect(await within(form).findByText("Storage is busy. Try again.")).toBeTruthy();
    expect(summary.value).toBe("Tried the admin path with default creds");
    expect((within(form).getByRole("combobox", { name: "Lead" }) as HTMLSelectElement).value).toBe(LEAD_OPEN);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("asks before discarding a typed draft and closes a clean form directly", async () => {
    const { posts } = stubLab({
      runs: { [ENGAGEMENT_A]: [runSummary("run-ok", "succeeded")] },
      outputs: { [`${ENGAGEMENT_A}:run-ok`]: runOutput("run-ok", "succeeded", present("art-out"), absent) },
      leads: { [ENGAGEMENT_A]: LEADS_A },
    });
    renderRuns({ engagementId: ENGAGEMENT_A, selectedRunId: "run-ok" });
    let form = await openForm();
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("region", { name: "Add run to lead" })).toBeNull();

    form = await openForm();
    fireEvent.change(within(form).getByRole("textbox", { name: "Conditions, optional" }), {
      target: { value: "Guest account only" },
    });
    fireEvent.keyDown(within(form).getByRole("textbox", { name: "Conditions, optional" }), { key: "Escape" });
    expect(within(form).getByText("Discard this attempt draft?")).toBeTruthy();
    fireEvent.click(within(form).getByRole("button", { name: "Keep editing" }));
    expect(
      (within(form).getByRole("textbox", { name: "Conditions, optional" }) as HTMLInputElement).value,
    ).toBe("Guest account only");
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(form).getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("region", { name: "Add run to lead" })).toBeNull();
    expect(posts).toHaveLength(0);
  });

  it("drops the draft when the run or engagement changes and sends only the new selection", async () => {
    const { posts } = stubLab({
      runs: {
        [ENGAGEMENT_A]: [runSummary("run-one", "succeeded"), runSummary("run-two", "succeeded")],
        [ENGAGEMENT_B]: [runSummary("run-b", "succeeded")],
      },
      outputs: {
        [`${ENGAGEMENT_A}:run-one`]: runOutput("run-one", "succeeded", present("art-one"), absent),
        [`${ENGAGEMENT_A}:run-two`]: runOutput("run-two", "succeeded", present("art-two"), absent),
        [`${ENGAGEMENT_B}:run-b`]: runOutput("run-b", "succeeded", present("art-b"), absent),
      },
      leads: {
        [ENGAGEMENT_A]: LEADS_A,
        [ENGAGEMENT_B]: [lead(LEAD_B, "Other box lead", "open", ENGAGEMENT_B)],
      },
    });
    const view = renderRuns({ engagementId: ENGAGEMENT_A, selectedRunId: "run-one" });
    let form = await openForm();
    chooseLead(form, LEAD_OPEN);
    fireEvent.change(within(form).getByRole("textbox", { name: "Conditions, optional" }), {
      target: { value: "draft for run one" },
    });

    view.rerender({ engagementId: ENGAGEMENT_A, selectedRunId: "run-two" });
    await screen.findByText("run-two · succeeded");
    expect(screen.queryByRole("region", { name: "Add run to lead" })).toBeNull();
    form = await openForm();
    expect(
      (within(form).getByRole("textbox", { name: "Conditions, optional" }) as HTMLInputElement).value,
    ).toBe("");
    expect((within(form).getByRole("combobox", { name: "Lead" }) as HTMLSelectElement).value).toBe("");

    view.rerender({ engagementId: ENGAGEMENT_B, selectedRunId: "run-b" });
    await screen.findByText("run-b · succeeded");
    expect(screen.queryByRole("region", { name: "Add run to lead" })).toBeNull();
    form = await openForm();
    const options = within(within(form).getByRole("combobox", { name: "Lead" }))
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(options).toEqual(["Choose a lead", "Other box lead"]);
    chooseLead(form, LEAD_B);
    fireEvent.click(within(form).getByRole("button", { name: "Record attempt" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.url).toBe(`/api/v1/engagements/${ENGAGEMENT_B}/leads/${LEAD_B}/attempts`);
    expect(posts[0]?.body["evidenceArtifactIds"]).toEqual(["art-b"]);
    expect(posts[0]?.body["conditions"]).toBeUndefined();
  });
});

describe("attempt evidence in the Leads tab", () => {
  it("links each evidence reference to the encoded content route", async () => {
    const attempts = [
      {
        contractVersion: 1,
        id: "30000000-0000-4000-8000-000000000001",
        engagementId: ENGAGEMENT_A,
        leadId: LEAD_OPEN,
        sequence: 1,
        summary: "Run run-ok succeeded, preserved stdout and stderr attached",
        outcome: "inconclusive",
        conditions: null,
        evidenceArtifactIds: ["art-out", "manual-typed-id"],
        linkedFindingId: null,
        linkedObjectiveId: null,
        createdAt: TS,
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/leads")) return response([lead(LEAD_OPEN, "Admin panel on 8080", "open")]);
        if (url.endsWith("/attempts")) return response(attempts);
        if (url.endsWith("/outline")) return response({ outline: "" });
        return response([]);
      }),
    );
    const queryClient = createAppQueryClient();
    testQueryClients.add(queryClient);
    render(
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <EngagementLeadsSection archived={false} engagementId={ENGAGEMENT_A} />
        </QueryClientProvider>
      </ThemeProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Detail" }));
    const first = (await screen.findByRole("link", { name: "Download evidence 1 (art-out)" })) as HTMLAnchorElement;
    expect(first.getAttribute("href")).toBe(
      `/api/v1/engagements/${encodeURIComponent(ENGAGEMENT_A)}/artifacts/art-out/content`,
    );
    const second = screen.getByRole("link", { name: "Download evidence 2 (manual-typed-id)" });
    expect(second.getAttribute("href")).toBe(
      `/api/v1/engagements/${ENGAGEMENT_A}/artifacts/manual-typed-id/content`,
    );
    expect(screen.getByRole("textbox", { name: "Evidence artifact ids, comma separated" })).toBeTruthy();
  });
});
