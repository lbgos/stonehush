// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { serviceInspectorRecord } from "./inspector.js";
import { qualifiedSurfaceSelection, savedSurfacePointer, surfaceInspectionRead, useRememberedSurface, useSurfaceInspection } from "./resume-surface.js";
import { emptyWorkspaceState, loadWorkspaceState, saveWorkspaceState, type WorkspaceStateStore } from "./workspace-state.js";

const A = "10000000-0000-4000-8000-000000000001";
const B = "10000000-0000-4000-8000-000000000002";
const service = { address: "192.0.2.20", port: 80, protocol: "tcp" as const, hostname: "morrow.test", serviceName: "http", product: null, version: null, source: "nmap" as const, parserVersion: "nmap-xml-v1", runId: "run-old", artifactId: "artifact-old", artifactDigest: `sha256:${"a".repeat(64)}`, observedAt: "2026-10-12T12:00:00.000Z" };
const record = serviceInspectorRecord(service, A);
const probe = { source: "http-probe", parserVersion: "http-probe-raw-v1", url: "http://morrow.test/", fetchedAt: service.observedAt, finalUrl: "http://morrow.test/", status: 403, title: "Restricted", selectedHeaders: { contentType: "text/html", server: null, poweredBy: null }, hops: [{ url: "http://morrow.test/", status: 403, location: null }], error: null, runId: "run-probe", artifactId: "artifact-probe", artifactDigest: service.artifactDigest, observedAt: service.observedAt };
const path = { source: "ffuf", parserVersion: "ffuf-json-v1", url: "http://morrow.test/admin", status: 403, length: 42, words: 2, lines: 1, redirectlocation: null, fuzz: "admin", runId: "run-path", artifactId: "artifact-path", artifactDigest: service.artifactDigest, observedAt: service.observedAt };
const clients: QueryClient[] = [];
function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(client);
  return ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
function response(body: unknown, status = 200) { return { status, json: async () => body } as Response; }
function store() {
  const values = new Map<string, string>();
  return { load: (key: string) => values.get(key) ?? null, save: (key: string, value: string) => { values.set(key, value); } } satisfies WorkspaceStateStore;
}
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); });

const opened = { engagementId: A, requestedKey: record.key, target: service.address, record };
describe("remembered Surface context", () => {
  it("merges a validated selection while preserving remembered lead/run and unrelated fields", () => {
    const memory = store();
    const initial = { ...emptyWorkspaceState(), selectedRunId: "run-kept", lastLeadId: "20000000-0000-4000-8000-000000000001", drafts: { notes: "keep" }, launcherInputs: { ports: "80" }, filters: { state: "failed" }, starredIds: ["keep"] };
    saveWorkspaceState(memory, A, initial);
    const { result } = renderHook(() => useRememberedSurface(A, memory));
    act(() => result.current.remember(opened));
    expect(result.current.pointer).toEqual({ target: service.address, key: record.key });
    expect(loadWorkspaceState(memory, A)).toMatchObject({ ...initial, selectedTarget: service.address, inspectorSelection: record.key, updatedAt: expect.any(String) });
    act(() => result.current.forget(A, record.key));
    expect(result.current.pointer).toBeNull();
    expect(loadWorkspaceState(memory, A)).toMatchObject({ selectedRunId: "run-kept", lastLeadId: initial.lastLeadId, drafts: initial.drafts });
  });

  it("rejects mismatched, unqualified, foreign and late ownership", () => {
    const memory = store();
    const { result, rerender } = renderHook(({ id }) => useRememberedSurface(id, memory), { initialProps: { id: A } });
    const oldRemember = result.current.remember;
    for (const invalid of [ { ...opened, requestedKey: "service:192.0.2.20:80" }, { ...opened, requestedKey: "service:192.0.2.20:80:tcp:other" }, { ...opened, record: { ...record, artifactId: "other" } }, { ...opened, engagementId: B } ]) act(() => result.current.remember(invalid));
    expect(result.current.pointer).toBeNull();
    act(() => result.current.remember(opened));
    rerender({ id: B });
    act(() => oldRemember({ ...opened, target: "late" }));
    expect(result.current.pointer).toBeNull();
    expect(loadWorkspaceState(memory, A).selectedTarget).toBe(service.address);
    act(() => result.current.remember({ ...opened, engagementId: B }));
    rerender({ id: A });
    expect(result.current.pointer?.key).toBe(record.key);
  });

  it("keeps the prior pointer when writes or Forget fail", () => {
    const memory = store();
    saveWorkspaceState(memory, A, { ...emptyWorkspaceState(), selectedTarget: service.address, inspectorSelection: record.key });
    const denied: WorkspaceStateStore = { load: memory.load, save: () => { throw new Error("quota"); } };
    const { result } = renderHook(() => useRememberedSurface(A, denied));
    act(() => result.current.remember({ ...opened, target: "other" }));
    act(() => result.current.forget(A, record.key));
    expect(result.current.pointer).toEqual({ target: service.address, key: record.key });
  });

  it("never blocks a read-denied store or deletes a newer selection with an older Forget", () => {
    const memory = store();
    const { result } = renderHook(() => useRememberedSurface(A, memory));
    act(() => result.current.remember(opened));
    act(() => result.current.forget(A, "other-key"));
    expect(result.current.pointer?.key).toBe(record.key);
    const denied: WorkspaceStateStore = { load: () => { throw new Error("denied"); }, save: () => { throw new Error("denied"); } };
    const deniedHook = renderHook(() => useRememberedSurface(A, denied));
    act(() => deniedHook.result.current.remember(opened));
    expect(deniedHook.result.current.pointer).toBeNull();
  });

  it.each(["service:192.0.2.20:80", "probe:http://morrow.test/", "path:http://morrow.test/admin", "service-1", "path:../bad:http://morrow.test/", "path:artifact-old:invalid"])('does not restore legacy or malformed key %s', key => {
    expect(qualifiedSurfaceSelection(key)).toBeUndefined();
    expect(savedSurfacePointer({ ...emptyWorkspaceState(), selectedTarget: service.address, inspectorSelection: key })).toBeNull();
  });
});

describe("fresh scoped Surface inspection", () => {
  it.each([record.key, "probe:artifact-probe:http://morrow.test/", "path:artifact-path:http://morrow.test/admin"])('resolves exact %s and canonical target from fresh sources', async key => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => response(String(input).endsWith("/services") ? [service] : String(input).endsWith("/http-probes") ? [probe] : [path]));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSurfaceInspection(A, key), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const read = surfaceInspectionRead(result.current, A, key);
    expect(read.state).toBe("ready");
    expect(result.current.data).toMatchObject({ engagementId: A, requestedKey: key, target: service.address, record: { key } });
    expect(fetchMock.mock.calls.every(([input]) => String(input).startsWith(`/api/v1/engagements/${A}/`))).toBe(true);
    expect(surfaceInspectionRead(result.current, B, key)).toEqual({ state: "failed" });
    expect(surfaceInspectionRead(result.current, A, "other")).toEqual({ state: "failed" });
  });

  it("does not replace missing evidence with the same URL from a newer artifact", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => response(String(input).endsWith("/services") ? [service] : [{ ...path, artifactId: "artifact-new" }])));
    const key = "path:artifact-path:http://morrow.test/admin";
    const { result } = renderHook(() => useSurfaceInspection(A, key), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(surfaceInspectionRead(result.current, A, key)).toEqual({ state: "missing" });
  });

  it("rejects duplicate exact source identities instead of picking the first", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response([service, service])));
    const { result } = renderHook(() => useSurfaceInspection(A, record.key), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(surfaceInspectionRead(result.current, A, record.key)).toEqual({ state: "missing" });
  });

  it("retains failure, Retry and no cached-current claim after a refresh error", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response([service])).mockResolvedValueOnce(response({}, 503)).mockResolvedValueOnce(response([service]));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSurfaceInspection(A, record.key), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await act(async () => { await result.current.refetch(); });
    await waitFor(() => expect(surfaceInspectionRead(result.current, A, record.key)).toEqual({ state: "failed" }));
    await act(async () => { await result.current.refetch(); });
    await waitFor(() => expect(surfaceInspectionRead(result.current, A, record.key).state).toBe("ready"));
  });

  it("does not use the prior selection when a new read is pending or a late A read completes", async () => {
    let complete: (value: Response) => void = () => undefined;
    const pending = new Promise<Response>(resolve => { complete = resolve; });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => String(input).includes(`/${A}/`) ? pending : Promise.resolve(response([service]))));
    const { result, rerender } = renderHook(({ id }) => useSurfaceInspection(id, record.key), { wrapper: wrapper(), initialProps: { id: A } });
    expect(surfaceInspectionRead(result.current, A, record.key)).toEqual({ state: "loading" });
    rerender({ id: B });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await act(async () => { complete(response([service])); await pending; });
    expect(result.current.data?.engagementId).toBe(B);
  });

  it("does not read an unqualified selection", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    renderHook(() => useSurfaceInspection(A, "path:http://morrow.test/admin"), { wrapper: wrapper() });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
