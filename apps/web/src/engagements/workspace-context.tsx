import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

export interface AdvisorDraft {
  readonly nonce: number;
  readonly open: boolean;
  readonly excerpts: readonly string[];
  readonly findingIds: readonly string[];
}

export type AdvisorReplacementGuard = (replace: () => void) => void;

interface EngagementWorkspaceContextValue {
  registerAdvisorGuard: (guard: AdvisorReplacementGuard) => () => void;
  advisorDraft: AdvisorDraft;
  announce: (message: string) => void;
  clearNotice: () => void;
  closeAdvisor: () => void;
  engagementFilter: string;
  focusRunsToken: number;
  notice: string | null;
  openAdvisor: (excerpts: readonly string[], findingIds: readonly string[]) => void;
  openCreate: () => void;
  requestFocusRuns: () => void;
  setAdvisorExcerpts: (ids: readonly string[]) => void;
  setAdvisorFindingIds: (ids: readonly string[]) => void;
  setEngagementFilter: (value: string) => void;
}

const EngagementWorkspaceContext = createContext<EngagementWorkspaceContextValue | null>(null);

export function EngagementWorkspaceProvider({
  children,
  openCreate,
}: {
  children: ReactNode;
  openCreate: () => void;
}) {
  const [engagementFilter, setEngagementFilter] = useState("");
  const [focusRunsToken, setFocusRunsToken] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [advisorDraft, setAdvisorDraft] = useState<AdvisorDraft>({
    nonce: 0,
    open: false,
    excerpts: [],
    findingIds: [],
  });
  const announce = useCallback((message: string) => {
    setNotice(message);
  }, []);
  const clearNotice = useCallback(() => {
    setNotice(null);
  }, []);
  const requestFocusRuns = useCallback(() => {
    setFocusRunsToken((current) => current + 1);
  }, []);
  const advisorGuard = useRef<AdvisorReplacementGuard | undefined>(undefined);
  const registerAdvisorGuard = useCallback((guard: AdvisorReplacementGuard) => {
    advisorGuard.current = guard;
    return () => { if (advisorGuard.current === guard) advisorGuard.current = undefined; };
  }, []);
  const openAdvisor = useCallback((excerpts: readonly string[], findingIds: readonly string[]) => {
    const replace = () => setAdvisorDraft((current) => ({
      nonce: current.nonce + 1,
      open: true,
      excerpts: [...excerpts],
      findingIds: [...findingIds],
    }));
    if (advisorGuard.current !== undefined) advisorGuard.current(replace);
    else replace();
  }, []);
  const closeAdvisor = useCallback(() => {
    setAdvisorDraft((current) => (current.open ? { ...current, open: false } : current));
  }, []);
  const setAdvisorExcerpts = useCallback((ids: readonly string[]) => {
    setAdvisorDraft((current) => ({ ...current, excerpts: [...ids] }));
  }, []);
  const setAdvisorFindingIds = useCallback((ids: readonly string[]) => {
    setAdvisorDraft((current) => ({ ...current, findingIds: [...ids] }));
  }, []);
  const value = useMemo(
    () => ({
      registerAdvisorGuard,
      advisorDraft,
      announce,
      clearNotice,
      closeAdvisor,
      engagementFilter,
      focusRunsToken,
      notice,
      openAdvisor,
      openCreate,
      requestFocusRuns,
      setAdvisorExcerpts,
      setAdvisorFindingIds,
      setEngagementFilter,
    }),
    [
      registerAdvisorGuard,
      advisorDraft,
      announce,
      clearNotice,
      closeAdvisor,
      engagementFilter,
      focusRunsToken,
      notice,
      openCreate,
      requestFocusRuns,
    ],
  );

  return (
    <EngagementWorkspaceContext.Provider value={value}>
      {children}
    </EngagementWorkspaceContext.Provider>
  );
}

export function useEngagementWorkspace() {
  const value = useContext(EngagementWorkspaceContext);
  if (value === null) {
    throw new Error("Engagement workspace context is unavailable.");
  }
  return value;
}

export function engagementMatchesFilter(name: string, kindLabel: string, filter: string): boolean {
  const query = filter.trim().toLowerCase();
  if (query.length === 0) return true;
  return name.toLowerCase().includes(query) || kindLabel.toLowerCase().includes(query);
}
