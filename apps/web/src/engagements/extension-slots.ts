/**
 * STONE-6 extension slots. STONE-2 owns the workspace layout and merges
 * first; these views mount through its extension slots after that merge.
 * Until then this registry is the integration contract: slot names,
 * mount signatures, and a no-op fallback when the host slot is absent.
 * This slice delivers helpers, API, standalone views, and tests without
 * editing workspace.tsx or any surface file.
 */

export const STONE_6_SLOT_NAMES = [
  "engagement.resume",
  "engagement.search",
  "discovery.groups",
  "discovery.diff",
  "discovery.wordlist",
] as const;

export type Stone6SlotName = (typeof STONE_6_SLOT_NAMES)[number];

export interface Stone6SlotContext {
  readonly engagementId: string;
  readonly archived: boolean;
}

export type Stone6SlotMount = (context: Stone6SlotContext, host: HTMLElement) => () => void;

const mounts = new Map<Stone6SlotName, Stone6SlotMount>();
// Array, not a set: two mounts may legitimately return the same cleanup
// identity, and every registration must run on unmount.
const activeCleanups = new Map<Stone6SlotName, (() => void)[]>();

export function registerStone6Slot(name: Stone6SlotName, mount: Stone6SlotMount): void {
  mounts.set(name, mount);
}

/** Mount into a STONE-2 host slot; false when the host slot is absent. */
export function mountStone6Slot(name: Stone6SlotName, context: Stone6SlotContext, host: HTMLElement): boolean {
  const mount = mounts.get(name);
  if (mount === undefined) return false;
  const cleanup = mount(context, host);
  let cleanups = activeCleanups.get(name);
  if (cleanups === undefined) {
    cleanups = [];
    activeCleanups.set(name, cleanups);
  }
  cleanups.push(cleanup);
  return true;
}

/** Run all cleanups for a slot and forget them; safe to call when idle. */
export function unmountStone6Slot(name: Stone6SlotName): void {
  const cleanups = activeCleanups.get(name);
  if (cleanups === undefined) return;
  activeCleanups.delete(name);
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch {
      // One failing cleanup never blocks the rest.
    }
  }
}

export function registeredStone6Slots(): readonly Stone6SlotName[] {
  return [...mounts.keys()];
}
