// @vitest-environment jsdom
import type { ActionSnapshot, HttpProbeProjected, NmapProjectedService, PersistedAction, RunHistorySummary, RunOutputResponse } from "@stonehush/contracts";
import { normalizeTarget } from "@stonehush/domain";
import { ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import { RunCompareSection } from "./run-compare-panel.js";

const engagementId = "10000000-0000-4000-8000-000000000001";
const digest = `sha256:${"a".repeat(64)}`;
const date = "2026-08-10T12:00:00.000Z";
const selected: RunHistorySummary = { id: "new", actionId: "action-new", createdAt: date, updatedAt: date,
  state: "succeeded", terminalKind: "succeeded", terminalReason: null, attempt: 1 };
const prior: RunHistorySummary = { ...selected, id: "old", actionId: "action-old", createdAt: "2026-08-09T12:00:00.000Z" };
function output(run: RunHistorySummary): RunOutputResponse {
  return { run: { id: run.id, actionId: run.actionId, state: run.state, terminalKind: run.terminalKind, terminalReason: run.terminalReason, updatedAt: run.updatedAt }, stdout: { present: true, artifactId: `stdout-${run.id}`, digest, sizeBytes: 4, content: "text", completeness: "complete", truncated: false },
    stderr: { present: false, truncated: false, content: "" } };
}
function action(run: RunHistorySummary, target = "192.0.2.0/24", ip = "192.0.2.10"): PersistedAction {
  const normalized = normalizeTarget(target);
  if (!normalized.ok) throw new Error(normalized.error.code);
  const snapshot: ActionSnapshot = { normalizationProfile: "d1-v1", orchestrationProfile: "d2-v1", actionId: run.actionId,
    snapshotId: `snapshot-${run.id}`, version: 1, binding: digest, canonicalTargets: [normalized.target], concreteDestinations: [],
    typedOptions: { declaredPorts: [22, 80, 443] }, scopeRevisionId: null, warningState: { reasonCodes: [], knownAdditions: [], acknowledgment: null },
    resolutionSnapshots: [{ canonicalQueryName: "target.test", resolverMode: "system", cnameChain: [], resolvedAt: date,
      answers: [{ family: 4, address: ip, ttlSeconds: 60 }] }] };
  return { contractVersion: 1, engagementId, revision: 1, warningAcknowledgmentId: null, createdAt: run.createdAt, updatedAt: date,
    action: { actionId: run.actionId, orchestrationProfile: "d2-v1", state: "succeeded", snapshots: [snapshot], queuedSnapshotVersion: 1,
      warningAcknowledgment: null, pendingWarning: null, coveredDestinations: [], warningInteractions: 0, runState: null,
      resumeRequested: false, cleanupRequired: false, capabilityErrorCode: null } };
}
function service(runId: string, port: number): NmapProjectedService {
  return { source: "nmap", parserVersion: "nmap-xml-v1", address: "192.0.2.10", port, protocol: "tcp", hostname: null,
    serviceName: "http", product: null, version: null, runId, artifactId: `service-${runId}-${port}`, artifactDigest: digest, observedAt: date };
}
function probe(runId: string): HttpProbeProjected {
  return { source: "http-probe", parserVersion: "http-probe-raw-v1", url: "http://target.test/", finalUrl: "http://target.test/",
    status: 200, title: "lab", fetchedAt: date, selectedHeaders: { contentType: null, server: null, poweredBy: null }, hops: [], error: null,
    runId, artifactId: `probe-${runId}`, artifactDigest: digest, observedAt: date };
}
beforeEach(() => {
  Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: vi.fn(() => ({ matches: true,
    addEventListener: vi.fn(), removeEventListener: vi.fn() })) });
});
const clients = new Set<ReturnType<typeof createAppQueryClient>>();
afterEach(() => { cleanup(); for (const client of clients) client.clear(); clients.clear(); vi.unstubAllGlobals(); });
function mount(runs = [selected, prior], sourceStale = false) {
  const client = createAppQueryClient(); clients.add(client);
  const props = { engagementId, loadedRuns: runs, selectedOutput: output(selected), sourceStale };
  const view = (value: typeof props) => <ThemeProvider><QueryClientProvider client={client}><RunCompareSection key={`${value.engagementId}:${value.selectedOutput.run.id}`} {...value} /></QueryClientProvider></ThemeProvider>;
  const rendered = render(view(props));
  return { client, props, update: (value: typeof props) => rendered.rerender(view(value)) };
}
function mockReads(overrides: Record<string, unknown> = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const path = String(input);
    const data: Record<string, unknown> = {
      [`/api/v1/engagements/${engagementId}/services`]: [service("old", 22), service("old", 80), { ...service("new", 80), product: "nginx" }, service("new", 443)],
      [`/api/v1/engagements/${engagementId}/http-probes`]: [],
      [`/api/v1/engagements/${engagementId}/ffuf-results`]: [],
      [`/api/v1/engagements/${engagementId}/actions/action-new`]: action(selected, "192.0.2.0/24", "192.0.2.11"),
      [`/api/v1/engagements/${engagementId}/actions/action-old`]: action(prior),
      [`/api/v1/engagements/${engagementId}/runs/old/output`]: output(prior),
      ...overrides,
    };
    const body = data[path];
    return new Response(JSON.stringify(body ?? { code: "run_not_found" }), { status: body === undefined ? 404 : 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
function choose(id = "old") { fireEvent.change(screen.getByLabelText("Prior run"), { target: { value: id } }); }

describe("selected run comparison", () => {
  it("fetches only after an explicit choice, renders exact changes and binding/cap caveats, and writes nothing", async () => {
    const reads = mockReads(); mount();
    expect(reads).not.toHaveBeenCalled();
    choose();
    await screen.findByText(/New service observed at 192.0.2.10:443/);
    expect(screen.getByText(/Changed service at 192.0.2.10:80/)).toBeTruthy();
    expect(screen.getByText(/No longer observed at 192.0.2.10:22/)).toBeTruthy();
    expect(screen.getByText(/Binding changed:/)).toBeTruthy();
    expect(screen.getByText(/Missing or capped projections may omit results/)).toBeTruthy();
    expect(screen.getByText(/Prior run old/)).toBeTruthy();
    for (const call of reads.mock.calls) expect((call[1] as RequestInit | undefined)?.method ?? "GET").toBe("GET");
    expect(reads.mock.calls.every(([url]) => !/cancel|retry|continue|add-scope|\/content/.test(String(url)))).toBe(true);
  });
  it("adds the incomplete caveat for partial artifact output even when the preview is intact", async () => {
    const partial = output(prior); if (!partial.stdout.present) throw new Error("fixture"); partial.stdout.completeness = "partial";
    mockReads({ [`/api/v1/engagements/${engagementId}/runs/old/output`]: partial }); mount(); choose();
    await screen.findByText(/One side is incomplete/);
  });
  it("refuses different tools without change statements", async () => {
    mockReads({ [`/api/v1/engagements/${engagementId}/services`]: [service("new", 80)],
      [`/api/v1/engagements/${engagementId}/http-probes`]: [probe("old")],
      [`/api/v1/engagements/${engagementId}/actions/action-old`]: action(prior, "http://target.test/") });
    mount(); choose(); await screen.findByText(/Different tools:/);
    expect(screen.queryByText(/New service observed/)).toBeNull();
  });
  it("refuses different origins without change statements", async () => {
    mockReads({ [`/api/v1/engagements/${engagementId}/actions/action-old`]: action(prior, "192.0.2.11") });
    mount(); choose(); await screen.findByText(/Different origins:/);
    expect(screen.queryByText(/New service observed/)).toBeNull();
  });
  it("does not fabricate context for empty projections", async () => {
    mockReads({ [`/api/v1/engagements/${engagementId}/services`]: [] }); mount(); choose();
    await screen.findByText(/No recorded observations/);
    expect(screen.queryByRole("region", { name: "Run diff" })).toBeNull();
  });
  it("retries unavailable prior output and withholds the diff until recovery", async () => {
    const reads = mockReads({ [`/api/v1/engagements/${engagementId}/runs/old/output`]: undefined }); mount(); choose();
    await screen.findByText("Comparison unavailable");
    expect(screen.queryByRole("region", { name: "Run diff" })).toBeNull();
    reads.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/runs/old/output")) return new Response(JSON.stringify(output(prior)));
      if (String(input).endsWith("/actions/action-old")) return new Response(JSON.stringify(action(prior)));
      if (String(input).endsWith("/actions/action-new")) return new Response(JSON.stringify(action(selected)));
      return new Response(JSON.stringify(String(input).endsWith("/services") ? [service("old", 80), service("new", 443)] : []));
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText(/New service observed/);
  });
  it("withholds comparisons when the history or selected output refresh failed", () => {
    const reads = mockReads(); mount([selected, prior], true); choose();
    expect(screen.getByText(/Refresh the run history/)).toBeTruthy(); expect(reads).not.toHaveBeenCalled();
  });
  it("clears the pair when selected run or engagement changes, even if old responses finish late", async () => {
    let resolve: (value: Response) => void = () => { throw new Error("not requested"); };
    const reads = mockReads(); reads.mockImplementation(async () => new Promise<Response>((done) => { resolve = done; }));
    const current = mount(); choose();
    const other = { ...selected, id: "different" };
    current.update({ ...current.props, loadedRuns: [other, prior], selectedOutput: output(other) });
    expect((screen.getByLabelText("Prior run") as HTMLSelectElement).value).toBe("");
    await act(async () => resolve(new Response("[]")));
    expect(screen.queryByRole("region", { name: "Run diff" })).toBeNull();
    current.update({ ...current.props, engagementId: "20000000-0000-4000-8000-000000000001" });
    expect((screen.getByLabelText("Prior run") as HTMLSelectElement).value).toBe("");
  });
  it("keeps prior choices in admitted history order and excludes newer or pending runs", () => {
    mockReads(); const pending = { ...prior, id: "pending", state: "running" as const };
    mount([{ ...selected, id: "newer", createdAt: "2026-08-11T12:00:00.000Z" }, selected, prior, pending]);
    const options = Array.from((screen.getByLabelText("Prior run") as HTMLSelectElement).options).map((option) => option.value);
    expect(options).toEqual(["", "old"]);
  });
});
