import { describeFfufRateSupport } from "@stonehush/contracts";
import {
  listWordlistOptions,
  loadLastWordlistChoice,
  missingWordlistRecovery,
  resolveWordlistByName,
  saveLastWordlistChoice,
} from "@stonehush/domain";
import { useMemo, useState } from "react";

/**
 * STONE-6 standalone wordlist selector. Mounts via the STONE-2
 * `discovery.wordlist` slot after STONE-2 merges. Wordlists are chosen by
 * name with purpose and approximate size; the last choice is remembered;
 * a missing file reports recovery instead of failing silently. The demo
 * list is labeled synthetic and never poses as a serious preset. Rate
 * truthfulness: capability or an explicit limitation is always shown, and
 * the rate value is never claimed to affect binaries that reject it.
 *
 * Configuration surface: `configuredPaths` maps catalog names to
 * operator-configured absolute files (e.g. from runner settings) and wins
 * over the shipped catalog, so a visible option resolves to a real run.
 */

export function FfufWordlistView({
  ffufVersion,
  exists,
  onResolve,
  configuredPaths = {},
}: {
  /** Installed binary version when known, else null for an explicit limitation. */
  ffufVersion: string | null;
  exists: (absolutePath: string) => boolean;
  onResolve: (wordlistPath: string, wordlistName: string) => void;
  /** Operator-configured absolute paths by catalog name; overrides the catalog. */
  configuredPaths?: Readonly<Record<string, string>>;
}) {
  const store = useMemo(
    () => ({
      load: () => {
        try {
          return window.localStorage.getItem("stonehush.ffuf.last-wordlist");
        } catch {
          return null;
        }
      },
      save: (name: string) => {
        try {
          window.localStorage.setItem("stonehush.ffuf.last-wordlist", name);
        } catch {
          // Best-effort.
        }
      },
    }),
    [],
  );
  const [selected, setSelected] = useState<string | null>(() => loadLastWordlistChoice(store));
  const [notice, setNotice] = useState<string | null>(null);
  const rate = describeFfufRateSupport(ffufVersion);

  return (
    <section aria-label="Wordlist" className="overflow-hidden rounded-[10px] border border-border bg-card">
      <div className="flex min-h-10 items-center justify-between border-b border-border px-3">
        <h2 className="m-0 text-[13px] font-semibold">Wordlist</h2>
        <span className="hidden text-[11px] text-muted-foreground sm:inline">Chosen by name</span>
      </div>
      <div className="grid gap-2 p-3">
        <ul className="m-0 list-none space-y-1 p-0">
          {listWordlistOptions().map((option) => {
            const override = configuredPaths[option.name];
            const effectivePath =
              override !== undefined && override.trim().length > 0 ? override : option.path;
            return (
              <li key={option.name}>
              <button
                type="button"
                onClick={() => {
                  const resolved = resolveWordlistByName(option.name, exists, configuredPaths);
                  if (resolved.ok === false) {
                    setNotice(missingWordlistRecovery(resolved.error.code));
                    return;
                  }
                  setNotice(null);
                  setSelected(option.name);
                  saveLastWordlistChoice(store, option.name);
                  onResolve(resolved.value.path, resolved.value.name);
                }}
                aria-pressed={selected === option.name}
                className="block w-full cursor-pointer rounded-[10px] border border-border bg-background px-2 py-1.5 text-left"
              >
                <span className="block text-[12px] font-medium text-foreground">
                  {option.name}
                  {option.isDemo ? " (synthetic demo, not a serious preset)" : ""}
                </span>
                <span className="block text-[11px] text-muted-foreground">
                  {option.purpose} (about {option.approxEntries.toLocaleString("en-US")} entries)
                  {effectivePath === null ? "; no file configured" : ""}
                </span>
              </button>
              </li>
            );
          })}
        </ul>
        {notice !== null ? <p className="m-0 text-[12px] leading-5 text-muted-foreground">{notice}</p> : null}
        <p className="m-0 text-[11px] leading-5 text-muted-foreground">
          Rate: {rate.supportsRate ? "supported by the installed binary." : (rate.limitation ?? "See binary documentation.")}
        </p>
      </div>
    </section>
  );
}
