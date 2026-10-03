import { LeadSchema, RunOutputParamsSchema } from "@stonehush/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Per-engagement client state in localStorage under a versioned key. Writes
 * are best-effort. Surface Resume remembers validated lead and terminal-run
 * ids through `lastLeadId` and `selectedRunId`. The other fields are
 * parsed and written back unchanged, but no view restores them yet. Saved
 * scope is never written here.
 */

export const WORKSPACE_STATE_VERSION = 1 as const;
export const WORKSPACE_STATE_KEY_PREFIX = "stonehush.workspace-state.v1." as const;

export interface EngagementWorkspaceState {
  readonly version: typeof WORKSPACE_STATE_VERSION;
  readonly selectedTarget: string | null;
  readonly selectedRunId: string | null;
  readonly inspectorSelection: string | null;
  readonly launcherInputs: Record<string, string>;
  readonly drafts: Record<string, string>;
  readonly filters: Record<string, string>;
  readonly starredIds: readonly string[];
  readonly lastWordlistName: string | null;
  // Exact id of the last lead opened and validated in this engagement. Never
  // a title, source, or draft. Missing in payloads written before it existed.
  readonly lastLeadId: string | null;
  readonly updatedAt: string;
}

export function emptyWorkspaceState(now: () => string = () => new Date().toISOString()): EngagementWorkspaceState {
  return {
    version: WORKSPACE_STATE_VERSION,
    selectedTarget: null,
    selectedRunId: null,
    inspectorSelection: null,
    launcherInputs: {},
    drafts: {},
    filters: {},
    starredIds: [],
    lastWordlistName: null,
    lastLeadId: null,
    updatedAt: now(),
  };
}

export function workspaceStateKey(engagementId: string): string {
  return `${WORKSPACE_STATE_KEY_PREFIX}${engagementId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Array.isArray(value) === false;
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

// A stored id becomes part of a request path, so anything but a lead id is
// dropped rather than sent.
function parseLeadId(value: unknown): string | null {
  const parsed = LeadSchema.shape.id.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Parse stored state; unknown or version-mismatched payloads reset clean. */
export function parseWorkspaceState(raw: string | null): EngagementWorkspaceState {
  const fallback = emptyWorkspaceState(() => "1970-01-01T00:00:00.000Z");
  if (raw === null) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (!isRecord(parsed) || parsed["version"] !== WORKSPACE_STATE_VERSION) return fallback;
  const selectedRun = RunOutputParamsSchema.shape.runId.safeParse(parsed["selectedRunId"]);
  return {
    version: WORKSPACE_STATE_VERSION,
    selectedTarget: typeof parsed["selectedTarget"] === "string" ? (parsed["selectedTarget"] as string) : null,
    selectedRunId: selectedRun.success ? selectedRun.data : null,
    inspectorSelection: typeof parsed["inspectorSelection"] === "string" ? (parsed["inspectorSelection"] as string) : null,
    launcherInputs: asStringRecord(parsed["launcherInputs"]),
    drafts: asStringRecord(parsed["drafts"]),
    filters: asStringRecord(parsed["filters"]),
    starredIds: Array.isArray(parsed["starredIds"])
      ? (parsed["starredIds"] as unknown[]).filter((entry): entry is string => typeof entry === "string")
      : [],
    lastWordlistName: typeof parsed["lastWordlistName"] === "string" ? (parsed["lastWordlistName"] as string) : null,
    lastLeadId: parseLeadId(parsed["lastLeadId"]),
    updatedAt: typeof parsed["updatedAt"] === "string" ? (parsed["updatedAt"] as string) : fallback.updatedAt,
  };
}

// `save` throws when the write fails; saveWorkspaceState turns that into false.
export interface WorkspaceStateStore {
  readonly load: (key: string) => string | null;
  readonly save: (key: string, value: string) => void;
}

export function browserWorkspaceStateStore(): WorkspaceStateStore {
  return {
    load: (key) => {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    save: (key, value) => {
      window.localStorage.setItem(key, value);
    },
  };
}

export function loadWorkspaceState(
  store: WorkspaceStateStore,
  engagementId: string,
): EngagementWorkspaceState {
  let raw: string | null = null;
  try {
    raw = store.load(workspaceStateKey(engagementId));
  } catch {
    raw = null;
  }
  return parseWorkspaceState(raw);
}

/** Best-effort and never throws. False when the store rejected the write. */
export function saveWorkspaceState(
  store: WorkspaceStateStore,
  engagementId: string,
  state: EngagementWorkspaceState,
): boolean {
  try {
    store.save(workspaceStateKey(engagementId), JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

/** Narrowed-view restore: filters and selection survive reload verbatim. */
export function useWorkspaceState(engagementId: string, store?: WorkspaceStateStore) {
  const resolved = useMemo<WorkspaceStateStore>(
    () => store ?? browserWorkspaceStateStore(),
    [store],
  );
  const [state, setState] = useState<EngagementWorkspaceState>(() =>
    loadWorkspaceState(resolved, engagementId),
  );
  // Reload when the host switches engagements without remounting; without
  // this the prior engagement's selection, drafts, and filters leak across.
  const engagementRef = useRef(engagementId);
  useEffect(() => {
    if (engagementRef.current !== engagementId) {
      engagementRef.current = engagementId;
      setState(loadWorkspaceState(resolved, engagementId));
    }
  }, [engagementId, resolved]);
  const update = useCallback(
    (patch: Partial<Omit<EngagementWorkspaceState, "version" | "updatedAt">>) => {
      setState((current) => {
        const next: EngagementWorkspaceState = {
          ...current,
          ...patch,
          version: WORKSPACE_STATE_VERSION,
          updatedAt: new Date().toISOString(),
        };
        saveWorkspaceState(resolved, engagementRef.current, next);
        return next;
      });
    },
    [resolved],
  );
  return { state, update };
}
