import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * STONE-6 reload-safe working state. Per-engagement UI state (selected
 * target/run, inspector selection, launcher inputs, drafts, filters,
 * starred ids) persists to localStorage under a versioned key so closing
 * the browser with work active restores target, draft, next step affordance,
 * and run state on return. Saved scope itself is never written here.
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
  return {
    version: WORKSPACE_STATE_VERSION,
    selectedTarget: typeof parsed["selectedTarget"] === "string" ? (parsed["selectedTarget"] as string) : null,
    selectedRunId: typeof parsed["selectedRunId"] === "string" ? (parsed["selectedRunId"] as string) : null,
    inspectorSelection: typeof parsed["inspectorSelection"] === "string" ? (parsed["inspectorSelection"] as string) : null,
    launcherInputs: asStringRecord(parsed["launcherInputs"]),
    drafts: asStringRecord(parsed["drafts"]),
    filters: asStringRecord(parsed["filters"]),
    starredIds: Array.isArray(parsed["starredIds"])
      ? (parsed["starredIds"] as unknown[]).filter((entry): entry is string => typeof entry === "string")
      : [],
    lastWordlistName: typeof parsed["lastWordlistName"] === "string" ? (parsed["lastWordlistName"] as string) : null,
    updatedAt: typeof parsed["updatedAt"] === "string" ? (parsed["updatedAt"] as string) : fallback.updatedAt,
  };
}

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
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // Persistence is best-effort; a full store never blocks the UI.
      }
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

export function saveWorkspaceState(
  store: WorkspaceStateStore,
  engagementId: string,
  state: EngagementWorkspaceState,
): void {
  try {
    store.save(workspaceStateKey(engagementId), JSON.stringify(state));
  } catch {
    // Best-effort, never blocking.
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
