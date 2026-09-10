/**
 * Advisor hint progression (STONE-7, CTF-friendly).
 * Depth 0 asks a focused question first. Depth 1 adds one specific next
 * check on request. Depth 2 explains the approach in detail only when
 * asked. Depth advances solely through explicit operator action, is kept
 * per engagement, and never produces walkthroughs or box answers
 * unprompted: depth 0 returns the question byte-identical.
 */

export const HINT_DEPTH_MIN = 0 as const;
export const HINT_DEPTH_MAX = 2 as const;

export type HintDepth = 0 | 1 | 2;

const HINT_DEPTH_STORAGE_PREFIX = "blackglass.advisor.hint-depth.";

export const HINT_DEPTH_LABELS: Record<HintDepth, string> = {
  0: "Focused question",
  1: "Next check",
  2: "Detailed approach",
};

export interface HintDepthStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function storageKey(engagementId: string): string {
  return `${HINT_DEPTH_STORAGE_PREFIX}${engagementId}`;
}

function parseDepth(raw: string | null): HintDepth {
  if (raw === "1") return 1;
  if (raw === "2") return 2;
  return 0;
}

export function loadHintDepth(
  storage: HintDepthStorage | undefined,
  engagementId: string,
): HintDepth {
  if (storage === undefined) return 0;
  try {
    return parseDepth(storage.getItem(storageKey(engagementId)));
  } catch {
    return 0;
  }
}

export function saveHintDepth(
  storage: HintDepthStorage | undefined,
  engagementId: string,
  depth: HintDepth,
): void {
  if (storage === undefined) return;
  try {
    storage.setItem(storageKey(engagementId), String(depth));
  } catch {
    // Depth persistence is a convenience; a failing store never blocks asking.
  }
}

export function advanceHintDepth(depth: HintDepth): HintDepth {
  if (depth >= HINT_DEPTH_MAX) return HINT_DEPTH_MAX;
  return (depth + 1) as HintDepth;
}

// Shape the outgoing question for the requested depth. Depth 0 is the
// identity: no walkthrough language is ever added unprompted.
export function applyHintDepth(question: string, depth: HintDepth): string {
  if (depth === 1) {
    return `${question}\n\nIf a next check would help, suggest exactly one specific check and what it would distinguish.`;
  }
  if (depth === 2) {
    return `${question}\n\nExplain the approach in detail: what each step would distinguish and how to read the result.`;
  }
  return question;
}
