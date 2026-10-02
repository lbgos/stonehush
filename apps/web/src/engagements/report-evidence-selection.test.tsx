// @vitest-environment jsdom

import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Finding, ReportBundle, ReportEvidenceArtifact } from "@stonehush/contracts";
import { createAppQueryClient } from "../query-client.js";
import {
  addFindingWithEvidence,
  evidenceCatalog,
  planFindingEvidence,
  reportIdentityIssue,
} from "./report-evidence-selection.js";
import { addOutlineItem, createOutline, removeOutlineItem } from "./report-outline.js";
import { reportQueryKey } from "./report-query.js";
import { EngagementReportSection } from "./report.js";

const engagementId = "10000000-0000-4000-8000-000000000001";
const otherEngagementId = "10000000-0000-4000-8000-000000000002";
const findingA = "20000000-0000-4000-8000-00000000000a";
const findingB = "20000000-0000-4000-8000-00000000000b";

function artifact(artifactId: string, fill: string): ReportEvidenceArtifact {
  return {
    artifactId,
    digest: `sha256:${fill.repeat(64)}`,
    sizeBytes: 10,
    kind: "tool_raw",
    completeness: "complete",
    runId: "run-1",
  };
}

function finding(overrides: Partial<Finding> & Pick<Finding, "id" | "title">): Finding {
  return {
    contractVersion: 1,
    engagementId,
    severity: "high",
    status: "open",
    body: "1. Log in with admin/admin.",
    evidenceArtifactIds: [],
    revision: 1,
    createdAt: "2026-08-12T12:00:00.000Z",
    updatedAt: "2026-08-12T12:00:00.000Z",
    ...overrides,
  };
}

// Finding A cites two catalog artifacts, a duplicate, and one ref the
// catalog does not list. Finding B shares artifact-a2 with A.
function bundleFixture(overrides: Partial<ReportBundle> = {}): ReportBundle {
  return {
    contractVersion: 1,
    engagement: {
      id: engagementId,
      name: "Target lab",
      kind: "lab",
      status: "active",
      description: null,
      authorizationContext: null,
      deadlineAt: null,
      revision: 1,
      createdAt: "2026-08-12T12:00:00.000Z",
      updatedAt: "2026-08-12T12:00:00.000Z",
    },
    findings: [
      finding({
        id: findingA,
        title: "Admin panel creds",
        body: "1. Log in. password=synthetic-evidence-001",
        evidenceArtifactIds: ["artifact-a2", "artifact-a1", "artifact-a2", "artifact-gone"],
      }),
      finding({ id: findingB, title: "Shared proof", evidenceArtifactIds: ["artifact-a2"] }),
    ],
    notesMarkdown: "",
    notesUpdatedAt: "2026-08-12T12:00:00.000Z",
    services: { total: 0, truncated: false, rows: [] },
    probes: { total: 0, truncated: false, rows: [] },
    ffufResults: { total: 0, truncated: false, rows: [] },
    evidenceArtifacts: {
      total: 3,
      truncated: false,
      rows: [artifact("artifact-a1", "1"), artifact("artifact-a2", "2"), artifact("artifact-a3", "3")],
    },
    generatedAt: "2026-08-12T13:00:00.000Z",
    ...overrides,
  };
}

describe("finding evidence plan", () => {
  it("joins distinct saved refs in saved order and counts absent refs once", () => {
    const bundle = bundleFixture();
    const plan = planFindingEvidence(
      bundle.findings[0]!,
      evidenceCatalog(bundle.evidenceArtifacts.rows),
      createOutline(),
    );
    expect(plan.refs.map((ref) => ref.artifactId)).toEqual([
      "artifact-a2",
      "artifact-a1",
      "artifact-gone",
    ]);
    expect(plan.inCatalog).toBe(2);
    expect(plan.notInCatalog).toBe(1);
    expect(plan.pending).toEqual(["artifact-a2", "artifact-a1"]);
    expect(plan.action).toBe("add");
  });

  it("adds the finding then its pending refs and keeps existing items", () => {
    const bundle = bundleFixture();
    const catalog = evidenceCatalog(bundle.evidenceArtifacts.rows);
    const before = addOutlineItem(createOutline(), {
      kind: "evidence",
      refId: "artifact-a1",
      caption: "operator caption",
    });
    const plan = planFindingEvidence(bundle.findings[0]!, catalog, before);
    expect(plan.pending).toEqual(["artifact-a2"]);
    const next = addFindingWithEvidence(before, bundle.findings[0]!, plan);
    expect(next.items.map((item) => [item.key, item.caption])).toEqual([
      ["evidence:artifact-a1", "operator caption"],
      [`finding:${findingA}`, "Admin panel creds"],
      ["evidence:artifact-a2", "artifact-a2"],
    ]);
    // Shared artifact-a2 is already selected, so B has nothing left to add.
    const sharedPlan = planFindingEvidence(bundle.findings[1]!, catalog, next);
    expect(sharedPlan.action).toBe("done");
    expect(addFindingWithEvidence(next, bundle.findings[1]!, sharedPlan)).toBe(next);
  });

  it("adds only the remaining evidence when the finding is already selected", () => {
    const bundle = bundleFixture();
    const catalog = evidenceCatalog(bundle.evidenceArtifacts.rows);
    let outline = addOutlineItem(createOutline(), {
      kind: "finding",
      refId: findingA,
      caption: "Edited caption",
    });
    outline = addOutlineItem(outline, { kind: "evidence", refId: "artifact-a2", caption: "a2" });
    const plan = planFindingEvidence(bundle.findings[0]!, catalog, outline);
    expect(plan.action).toBe("add-remaining");
    const next = addFindingWithEvidence(outline, bundle.findings[0]!, plan);
    expect(next.items.map((item) => item.key)).toEqual([
      `finding:${findingA}`,
      "evidence:artifact-a2",
      "evidence:artifact-a1",
    ]);
    expect(next.items[0]?.caption).toBe("Edited caption");
    const repeated = planFindingEvidence(bundle.findings[0]!, catalog, next);
    expect(repeated.action).toBe("done");
    expect(addFindingWithEvidence(next, bundle.findings[0]!, repeated)).toBe(next);
  });

  it("never cascades removal in either direction", () => {
    const bundle = bundleFixture();
    const catalog = evidenceCatalog(bundle.evidenceArtifacts.rows);
    const plan = planFindingEvidence(bundle.findings[0]!, catalog, createOutline());
    const added = addFindingWithEvidence(createOutline(), bundle.findings[0]!, plan);
    const withoutFinding = removeOutlineItem(added, `finding:${findingA}`);
    expect(withoutFinding.items.map((item) => item.key)).toEqual([
      "evidence:artifact-a2",
      "evidence:artifact-a1",
    ]);
    // All evidence is still selected, so the combined action is off and
    // finding-only Add is the way back.
    expect(planFindingEvidence(bundle.findings[0]!, catalog, withoutFinding).action).toBe("done");
    const withoutEvidence = removeOutlineItem(added, "evidence:artifact-a1");
    expect(withoutEvidence.items.map((item) => item.key)).toContain(`finding:${findingA}`);
    expect(planFindingEvidence(bundle.findings[0]!, catalog, withoutEvidence).pending).toEqual([
      "artifact-a1",
    ]);
  });

  it("offers no action without refs and none to run when no ref is in the catalog", () => {
    const catalog = evidenceCatalog(bundleFixture().evidenceArtifacts.rows);
    expect(
      planFindingEvidence(finding({ id: findingA, title: "x" }), catalog, createOutline()).action,
    ).toBe("none");
    const absent = planFindingEvidence(
      finding({ id: findingA, title: "x", evidenceArtifactIds: ["artifact-gone", "artifact-gone"] }),
      catalog,
      createOutline(),
    );
    expect(absent.action).toBe("unavailable");
    expect(absent.notInCatalog).toBe(1);
    expect(absent.pending).toEqual([]);
  });

  it("joins by exact ID only, never by similar title or metadata", () => {
    const bundle = bundleFixture({
      findings: [
        finding({ id: findingA, title: "Same title", evidenceArtifactIds: ["artifact-a1"] }),
        finding({ id: findingB, title: "Same title", evidenceArtifactIds: ["artifact-a3"] }),
      ],
    });
    const catalog = evidenceCatalog(bundle.evidenceArtifacts.rows);
    const plan = planFindingEvidence(bundle.findings[1]!, catalog, createOutline());
    const next = addFindingWithEvidence(createOutline(), bundle.findings[1]!, plan);
    expect(next.items.map((item) => item.key)).toEqual([
      `finding:${findingB}`,
      "evidence:artifact-a3",
    ]);
  });
});

describe("report identity guard", () => {
  it("accepts a clean response", () => {
    expect(reportIdentityIssue(bundleFixture(), engagementId)).toBeNull();
  });

  it("rejects foreign or ambiguous responses", () => {
    const base = bundleFixture();
    expect(reportIdentityIssue(base, otherEngagementId)).toMatch(/different engagement/);
    expect(
      reportIdentityIssue(
        { ...base, findings: [{ ...base.findings[0]!, engagementId: otherEngagementId }] },
        engagementId,
      ),
    ).toMatch(/finding from a different engagement/);
    expect(
      reportIdentityIssue(
        { ...base, findings: [base.findings[0]!, { ...base.findings[1]!, id: findingA }] },
        engagementId,
      ),
    ).toMatch(/duplicate finding IDs/);
    expect(
      reportIdentityIssue(
        {
          ...base,
          evidenceArtifacts: {
            total: 2,
            truncated: false,
            rows: [artifact("artifact-a1", "1"), artifact("artifact-a1", "4")],
          },
        },
        engagementId,
      ),
    ).toMatch(/duplicate artifact IDs/);
  });
});

function response(payload: unknown, status = 200): Response {
  return {
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    ok: status >= 200 && status < 300,
    status,
  } as Response;
}

const clients = new Set<QueryClient>();

function renderSection(client: QueryClient = createAppQueryClient(), id = engagementId) {
  clients.add(client);
  render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <EngagementReportSection engagementId={id} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return client;
}

function stubReportFetch(bundle: ReportBundle) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/report") && (init?.method ?? "GET") === "GET") {
      return Promise.resolve(response(bundle));
    }
    return Promise.reject(new Error(`unexpected ${String(input)}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const outlineKeys = () =>
  screen
    .queryAllByRole("button", { name: /^Remove / })
    .map((button) => button.getAttribute("aria-label"));
const sharingPreview = () =>
  document.querySelectorAll("section[aria-label='Report'] pre")[1]?.textContent ?? "";

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
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn(() => "blob:fake-report"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("report add with evidence", () => {
  it("adds a finding with its catalog evidence, previews it, and exports the same text", async () => {
    const fetchMock = stubReportFetch(bundleFixture());
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    renderSection();

    const combined = await screen.findByRole("button", {
      name: "Add with evidence (2): Admin panel creds",
    });
    // Counts and exact IDs are visible before activation.
    expect(screen.getByText("3 evidence refs · 1 not in this report catalog")).toBeTruthy();
    expect(screen.getByText("artifact-gone")).toBeTruthy();
    expect(screen.getByText("Not in this report catalog. Will not be added.")).toBeTruthy();
    // Finding-only Add stays available beside it.
    expect(screen.getAllByRole("button", { name: "Add" }).length).toBeGreaterThan(0);

    fireEvent.click(combined);
    expect(outlineKeys()).toEqual([
      "Remove Admin panel creds",
      "Remove artifact-a2",
      "Remove artifact-a1",
    ]);
    expect(
      screen.getByText(
        "Added Admin panel creds with 2 evidence items. 1 not in this report catalog, not added.",
      ),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Evidence added: Admin panel creds" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    // B's only ref is shared and already selected.
    expect(
      (screen.getByRole("button", { name: "Evidence added: Shared proof" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    // Default sharing: masked text, digest-only evidence, no asset links.
    const preview = sharingPreview();
    expect(preview).toContain(`digest-only sha256:${"2".repeat(64)}`);
    expect(preview).toContain(`digest-only sha256:${"1".repeat(64)}`);
    expect(preview).not.toContain("./assets/");
    expect(preview).not.toContain("synthetic-evidence-001");
    expect(preview).not.toContain("artifact-gone");

    const createObjectURL = URL.createObjectURL as ReturnType<typeof vi.fn>;
    fireEvent.click(screen.getByRole("button", { name: "Download outline Markdown" }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(await blob.text()).toBe(preview);
    expect(screen.getByText(/^Exports current\./)).toBeTruthy();
    const beforeRepeat = outlineKeys();
    fireEvent.click(screen.getByRole("button", { name: "Evidence added: Shared proof" }));
    expect(outlineKeys()).toEqual(beforeRepeat);
    expect(screen.getByText(/^Exports current\./)).toBeTruthy();

    // Selection issued only the report GET: no writes, no raw content fetch.
    for (const [input, init] of fetchMock.mock.calls) {
      expect(String(input)).toMatch(/\/report$/);
      expect(init?.method ?? "GET").toBe("GET");
    }
  });

  it("adds remaining evidence after removal and marks a prior export stale", async () => {
    stubReportFetch(bundleFixture());
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    renderSection();
    fireEvent.click(
      await screen.findByRole("button", { name: "Add with evidence (2): Admin panel creds" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove artifact-a2" }));
    expect(outlineKeys()).toEqual(["Remove Admin panel creds", "Remove artifact-a1"]);

    fireEvent.click(screen.getByRole("button", { name: "Download outline Markdown" }));
    expect(await screen.findByText(/^Exports current\./)).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Add remaining evidence (1): Admin panel creds" }),
    );
    // The finding is not added twice; the removed ref returns at the end.
    expect(outlineKeys()).toEqual([
      "Remove Admin panel creds",
      "Remove artifact-a1",
      "Remove artifact-a2",
    ]);
    expect(screen.getByText(/Stale: outline selection or order changed/)).toBeTruthy();
  });

  it("keeps the outline across template switches and refreshed bundles", async () => {
    stubReportFetch(bundleFixture());
    const client = renderSection();
    fireEvent.click(
      await screen.findByRole("button", { name: "Add with evidence (2): Admin panel creds" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove artifact-a1" }));
    fireEvent.click(screen.getByRole("button", { name: "Assessment report" }));
    expect(outlineKeys()).toEqual(["Remove Admin panel creds", "Remove artifact-a2"]);

    const refreshed = bundleFixture({ generatedAt: "2026-08-12T14:00:00.000Z" });
    refreshed.findings = [
      { ...refreshed.findings[0]!, evidenceArtifactIds: ["artifact-a2", "artifact-a3"] },
      refreshed.findings[1]!,
    ];
    client.setQueryData(reportQueryKey(engagementId), refreshed);
    // New candidates appear; removed artifact-a1 is not re-added.
    expect(
      await screen.findByRole("button", { name: "Add remaining evidence (1): Admin panel creds" }),
    ).toBeTruthy();
    expect(outlineKeys()).toEqual(["Remove Admin panel creds", "Remove artifact-a2"]);
  });

  it("disables the combined action while the displayed bundle refreshes", async () => {
    let finish!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    const client = createAppQueryClient();
    client.setQueryData(reportQueryKey(engagementId), bundleFixture());
    await client.invalidateQueries({ queryKey: reportQueryKey(engagementId) });
    renderSection(client);
    expect(await screen.findByText("Refreshing report…")).toBeTruthy();
    const combined = screen.getByRole("button", {
      name: "Add with evidence (2): Admin panel creds",
    }) as HTMLButtonElement;
    expect(combined.disabled).toBe(true);
    fireEvent.click(combined);
    expect(outlineKeys()).toEqual([]);
    const refreshed = bundleFixture({
      findings: [finding({ id: findingA, title: "Current proof", evidenceArtifactIds: ["artifact-a3"] })],
      generatedAt: "2026-08-12T14:00:00.000Z",
    });
    finish(response(refreshed));
    const current = await screen.findByRole("button", { name: "Add with evidence (1): Current proof" });
    await waitFor(() => expect((current as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(current);
    expect(outlineKeys()).toEqual(["Remove Current proof", "Remove artifact-a3"]);
  });

  it("keeps the combined action off for a foreign response", async () => {
    const base = bundleFixture();
    stubReportFetch({
      ...base,
      findings: [{ ...base.findings[0]!, engagementId: otherEngagementId }, base.findings[1]!],
    });
    renderSection();
    const combined = (await screen.findByRole("button", {
      name: "Add with evidence (2): Admin panel creds",
    })) as HTMLButtonElement;
    expect(combined.disabled).toBe(true);
    expect(
      screen.getByText(
        "Add with evidence is off. This report response has a finding from a different engagement.",
      ),
    ).toBeTruthy();
  });

  it("shows no combined action for a finding without refs and states a capped catalog", async () => {
    const base = bundleFixture();
    stubReportFetch({
      ...base,
      findings: [finding({ id: findingA, title: "No proof yet" })],
      evidenceArtifacts: { ...base.evidenceArtifacts, total: 1200, truncated: true },
    });
    renderSection();
    expect(await screen.findByText("No proof yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Add with evidence/ })).toBeNull();
    expect(
      screen.getByText("This report catalog lists the first 3 of 1200 artifacts."),
    ).toBeTruthy();
  });

  it("selects proof in an archived report and exports explicit asset links and matching print content", async () => {
    const base = bundleFixture();
    const fetchMock = stubReportFetch({ ...base, engagement: { ...base.engagement, status: "archived" } });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Add with evidence (2): Admin panel creds" }));
    fireEvent.click(screen.getByRole("button", { name: "Include evidence links" }));
    expect(screen.getByText("(assets/artifact-a2)")).toBeTruthy();
    expect(screen.getByText("(assets/artifact-a1)")).toBeTruthy();
    const preview = sharingPreview();
    expect(preview).toContain("[artifact-a2](./assets/artifact-a2)");
    expect(preview).not.toContain("./assets/artifact-a3");
    expect(preview).not.toContain("synthetic-evidence-001");

    const createObjectURL = vi.mocked(URL.createObjectURL);
    fireEvent.click(screen.getByRole("button", { name: "Download print HTML" }));
    const html = await (createObjectURL.mock.calls[0]![0] as Blob).text();
    const printed = new DOMParser().parseFromString(html, "text/html");
    expect(printed.querySelectorAll("script, img, a")).toHaveLength(0);
    expect(printed.querySelector("body")?.textContent).not.toContain("synthetic-evidence-001");
    for (const line of preview.split("\n").filter((entry) => entry.startsWith("- "))) {
      expect(printed.querySelector("body")?.textContent).toContain(line);
    }
    expect(Array.from(printed.querySelectorAll("h2"), (heading) => heading.textContent)).toEqual([
      "Summary", "Findings", "Reproduction", "Evidence", "Notes",
    ]);
    for (const [input, init] of fetchMock.mock.calls) {
      expect(String(input)).toMatch(/\/report$/);
      expect(init?.method ?? "GET").toBe("GET");
    }
  });

  it("resets selection on engagement switch and ignores a late old report refresh", async () => {
    const client = createAppQueryClient();
    clients.add(client);
    const base = bundleFixture();
    const other = bundleFixture({
      engagement: { ...base.engagement, id: otherEngagementId },
      findings: [finding({ id: findingA, title: "Other lab proof", engagementId: otherEngagementId, evidenceArtifactIds: ["artifact-a3"] })],
    });
    let finish!: (value: Response) => void;
    let signal: AbortSignal | undefined;
    let initial = true;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes(otherEngagementId)) return Promise.resolve(response(other));
      if (initial) { initial = false; return Promise.resolve(response(base)); }
      signal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => { finish = resolve; });
    }));
    const report = (id: string) => (
      <ThemeProvider>
        <QueryClientProvider client={client}>
          <EngagementReportSection engagementId={id} />
        </QueryClientProvider>
      </ThemeProvider>
    );
    const mounted = render(report(engagementId));
    fireEvent.click(await screen.findByRole("button", { name: "Add with evidence (2): Admin panel creds" }));
    expect(outlineKeys()).toHaveLength(3);
    const refresh = client.invalidateQueries({ queryKey: reportQueryKey(engagementId) });
    await screen.findByText("Refreshing report…");
    mounted.rerender(report(otherEngagementId));
    const current = await screen.findByRole("button", { name: "Add with evidence (1): Other lab proof" });
    expect(outlineKeys()).toEqual([]);
    expect(signal?.aborted).toBe(true);
    finish(response({ ...base, findings: [finding({ id: findingB, title: "Late old proof", evidenceArtifactIds: ["artifact-a1"] })] }));
    await refresh;
    await waitFor(() => expect(screen.queryByText("Late old proof")).toBeNull());
    fireEvent.click(current);
    expect(outlineKeys()).toEqual(["Remove Other lab proof", "Remove artifact-a3"]);
  });
});
