import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  canonicalTargetForHost,
  decodeSurfaceSelection,
  pathInspectorRecord,
  pathSelectionKey,
  probeInspectorRecord,
  probeSelectionKey,
  serviceInspectorRecord,
  serviceSelectionKey,
  splitOriginUrl,
  type InspectorRecord,
} from "./inspector.js";
import {
  engagementFfufResultsQueryKey,
  engagementHttpProbesQueryKey,
  engagementServicesQueryKey,
  fetchEngagementFfufResults,
  fetchEngagementHttpProbes,
  fetchEngagementServices,
} from "./query.js";
import {
  browserWorkspaceStateStore,
  loadWorkspaceState,
  saveWorkspaceState,
  type EngagementWorkspaceState,
  type WorkspaceStateStore,
} from "./workspace-state.js";

export interface SurfacePointer {
  readonly target: string;
  readonly key: string;
}

export function qualifiedSurfaceSelection(key: string | undefined) {
  const selection = decodeSurfaceSelection(key);
  if (selection?.artifactId === undefined) return undefined;
  if (selection.kind === "service") {
    if (selection.address === undefined || selection.port === undefined || selection.protocol === undefined ||
      serviceSelectionKey(selection.address, selection.port, selection.protocol, selection.artifactId) !== key) return undefined;
  } else if (selection.url === undefined || splitOriginUrl(selection.url) === undefined) return undefined;
  return selection;
}

export function savedSurfacePointer(state: EngagementWorkspaceState): SurfacePointer | null {
  if (state.selectedTarget === null || state.selectedTarget.length === 0 ||
    state.inspectorSelection === null || qualifiedSurfaceSelection(state.inspectorSelection) === undefined) return null;
  return { target: state.selectedTarget, key: state.inspectorSelection };
}

export interface OpenedSurface {
  readonly engagementId: string;
  readonly requestedKey: string;
  readonly target: string;
  readonly record: InspectorRecord;
}

// The private read always goes to the owning engagement's endpoint. Repeated
// observations must match exactly once; legacy keys never become pointers.
export function useSurfaceInspection(engagementId: string, key: string | undefined) {
  const client = useQueryClient();
  const readId = useId();
  return useQuery({
    queryKey: ["surface-inspection", engagementId, key, readId],
    enabled: qualifiedSurfaceSelection(key) !== undefined,
    gcTime: 0,
    staleTime: 0,
    refetchOnMount: "always",
    queryFn: async ({ signal }): Promise<OpenedSurface | null> => {
      const selection = qualifiedSurfaceSelection(key);
      if (selection === undefined) throw new Error("Invalid surface selection");
      const services = await fetchEngagementServices(engagementId, signal);
      let record: InspectorRecord | undefined;
      if (selection.kind === "service") {
        const matches = services.filter((entry) => serviceSelectionKey(entry.address, entry.port, entry.protocol, entry.artifactId) === key);
        if (matches.length === 1) record = serviceInspectorRecord(matches[0]!, engagementId);
      } else if (selection.kind === "probe") {
        const probes = await fetchEngagementHttpProbes(engagementId, signal);
        if (!signal.aborted) client.setQueryData(engagementHttpProbesQueryKey(engagementId), probes);
        const matches = probes.filter((entry) => probeSelectionKey(entry.url, entry.artifactId) === key);
        if (matches.length === 1) record = probeInspectorRecord(matches[0]!, engagementId);
      } else {
        const paths = await fetchEngagementFfufResults(engagementId, signal);
        if (!signal.aborted) client.setQueryData(engagementFfufResultsQueryKey(engagementId), paths);
        const matches = paths.filter((entry) => pathSelectionKey(entry.url, entry.artifactId) === key);
        if (matches.length === 1) record = pathInspectorRecord(matches[0]!, engagementId);
      }
      if (signal.aborted) throw new Error("Surface read cancelled");
      client.setQueryData(engagementServicesQueryKey(engagementId), services);
      if (record === undefined) return null;
      const host = record.kind === "service" ? record.target : splitOriginUrl(record.target)?.host;
      if (host === undefined) return null;
      return { engagementId, requestedKey: selection.key, target: canonicalTargetForHost(host, services), record };
    },
  });
}

export type SurfaceInspectionRead =
  | { readonly state: "loading" }
  | { readonly state: "failed" }
  | { readonly state: "missing" }
  | { readonly state: "ready"; readonly opened: OpenedSurface };

export function surfaceInspectionRead(query: ReturnType<typeof useSurfaceInspection>, engagementId: string, key: string): SurfaceInspectionRead {
  if (query.isFetching) return { state: "loading" };
  if (query.isError) return { state: "failed" };
  if (!query.isFetchedAfterMount) return { state: "loading" };
  if (query.data === null) return { state: "missing" };
  const opened = query.data;
  if (opened?.engagementId !== engagementId || opened.requestedKey !== key || opened.record.key !== key) return { state: "failed" };
  return { state: "ready", opened };
}

// Merge each successful write into the latest stored object so the existing
// remembered lead/run and other client state survive. A denied write stays
// best-effort, without claiming it was saved.
export function useRememberedSurface(engagementId: string, store?: WorkspaceStateStore) {
  const resolved = useMemo(() => store ?? browserWorkspaceStateStore(), [store]);
  const [pointer, setPointer] = useState(() => ({ engagementId, value: savedSurfacePointer(loadWorkspaceState(resolved, engagementId)) }));
  let current = pointer;
  if (pointer.engagementId !== engagementId) {
    current = { engagementId, value: savedSurfacePointer(loadWorkspaceState(resolved, engagementId)) };
    setPointer(current);
  }
  const engagementRef = useRef(engagementId);
  useLayoutEffect(() => { engagementRef.current = engagementId; }, [engagementId]);
  const remember = useCallback((opened: OpenedSurface) => {
    if (opened.engagementId !== engagementRef.current || opened.requestedKey !== opened.record.key ||
      opened.record.artifactId !== qualifiedSurfaceSelection(opened.requestedKey)?.artifactId || opened.target.length === 0) return;
    const saved = loadWorkspaceState(resolved, opened.engagementId);
    if ((saved.selectedTarget !== opened.target || saved.inspectorSelection !== opened.requestedKey) &&
      !saveWorkspaceState(resolved, opened.engagementId, { ...saved, selectedTarget: opened.target, inspectorSelection: opened.requestedKey, updatedAt: new Date().toISOString() })) return;
    setPointer((prev) => prev.engagementId === opened.engagementId &&
      (prev.value?.target !== opened.target || prev.value.key !== opened.requestedKey)
      ? { engagementId: opened.engagementId, value: { target: opened.target, key: opened.requestedKey } } : prev);
  }, [resolved]);
  const forget = useCallback((owner: string, key: string) => {
    if (owner !== engagementRef.current) return;
    const saved = loadWorkspaceState(resolved, owner);
    if (saved.inspectorSelection === key && !saveWorkspaceState(resolved, owner, { ...saved, selectedTarget: null, inspectorSelection: null, updatedAt: new Date().toISOString() })) return;
    setPointer((prev) => prev.engagementId === owner && prev.value?.key === key ? { engagementId: owner, value: null } : prev);
  }, [resolved]);
  return { pointer: current.value, remember, forget };
}

const INLINE_ACTION = "inline-flex min-h-11 items-center rounded-sm px-1.5 text-[12px] text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 md:pointer-fine:min-h-7";

export function ResumeSurfaceRow({ pointer, onOpen, onForget }: {
  readonly pointer: SurfacePointer;
  readonly onOpen: (pointer: SurfacePointer) => void;
  readonly onForget: (key: string) => void;
}) {
  // The inspector supplies fresh status after opening. This row names the
  // saved context only and does not claim the observation remains available.
  return (
    <section aria-label="Last observation" className="grid min-w-0 grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-x-3">
      <span className="pt-1.5 text-[12px] leading-5 font-medium text-foreground">Surface</span>
      <div className="flex min-w-0 flex-wrap items-center gap-x-1">
        <button type="button" className={`${INLINE_ACTION} min-w-0 max-w-full`} title={pointer.key} onClick={() => onOpen(pointer)}>
          <span className="truncate">{pointer.target} · {decodeSurfaceSelection(pointer.key)?.kind}</span>
        </button>
        <button type="button" className={INLINE_ACTION} onClick={(event) => {
          const band = event.currentTarget.closest<HTMLElement>("[data-resume-band]");
          onForget(pointer.key);
          band?.focus({ preventScroll: true });
        }}>Forget</button>
      </div>
    </section>
  );
}
