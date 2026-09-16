/**
 * STONE-6 ffuf wordlist-by-name domain helper. Resolves a catalog name to a
 * configured absolute path, remembers the last choice through an injected
 * store, and reports missing-file recovery. Rate truthfulness delegates to
 * the contract descriptor so UI copy never invents binary support.
 */

import { FFUF_WORDLIST_CATALOG, type FfufWordlistOption } from "@stonehush/contracts";

export type WordlistChoiceStore = {
  readonly load: () => string | null;
  readonly save: (name: string) => void;
};

export function listWordlistOptions(): readonly FfufWordlistOption[] {
  return FFUF_WORDLIST_CATALOG.options;
}

export type ResolveWordlistResult =
  | { readonly ok: true; value: { name: string; path: string; isDemo: boolean } }
  | { readonly ok: false; error: { code: "unknown_wordlist" | "wordlist_unconfigured" | "wordlist_missing" } };

/**
 * Resolve by name. `configuredPaths` overrides catalog paths by name and is
 * the operator configuration surface (e.g. runner settings): an override
 * wins over the catalog entry, and an empty override clears it back to
 * unconfigured. `exists` is injected so tests and the UI can report a
 * missing file without touching the filesystem here. Unconfigured named
 * presets (null path) report `wordlist_unconfigured`, never a guessed path.
 */
export function resolveWordlistByName(
  name: string,
  exists: (absolutePath: string) => boolean,
  configuredPaths: Readonly<Record<string, string>> = {},
): ResolveWordlistResult {
  const option = FFUF_WORDLIST_CATALOG.options.find((entry) => entry.name === name);
  if (option === undefined) return { ok: false, error: { code: "unknown_wordlist" } };
  const override = configuredPaths[name];
  const path = override !== undefined ? (override.trim().length === 0 ? null : override) : option.path;
  if (path === null) {
    return { ok: false, error: { code: "wordlist_unconfigured" } };
  }
  if (exists(path) === false) return { ok: false, error: { code: "wordlist_missing" } };
  return { ok: true, value: { name: option.name, path, isDemo: option.isDemo } };
}

export function missingWordlistRecovery(code: "unknown_wordlist" | "wordlist_unconfigured" | "wordlist_missing"): string {
  switch (code) {
    case "unknown_wordlist":
      return "Unknown wordlist name. Pick one from the catalog list.";
    case "wordlist_unconfigured":
      return "That wordlist has no configured file yet. Set its absolute path in runner settings, then retry.";
    case "wordlist_missing":
      return "The configured wordlist file is missing. Re-check the path or pick another list; the last working choice is kept.";
  }
}

export function loadLastWordlistChoice(store: WordlistChoiceStore): string | null {
  try {
    const value = store.load();
    if (typeof value !== "string" || value.trim().length === 0) return null;
    return value;
  } catch {
    return null;
  }
}

export function saveLastWordlistChoice(store: WordlistChoiceStore, name: string): void {
  try {
    store.save(name);
  } catch {
    // Last-choice memory is best-effort; a failing store never blocks a run.
  }
}
