import { cn } from "@stonehush/ui";
import { useEffect, useRef, type ReactNode } from "react";

import { SETTINGS_SECTIONS, searchSettings, type SettingsSectionId } from "./model.js";
import { useSettingsView } from "./settings-view.js";

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4 shrink-0" aria-hidden="true">
      <circle cx="7" cy="7" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M10.4 10.4 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
      <path d="M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4 shrink-0" aria-hidden="true">
      <path d="M9.6 3.6 5.2 8l4.4 4.4M5.2 8h6.4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SectionIcon({ id }: { id: SettingsSectionId }) {
  const paths: Record<SettingsSectionId, ReactNode> = {
    general: (
      <>
        <circle cx="8" cy="8" r="5.2" />
        <path d="M8 5.4v3.1l2 1.2" />
      </>
    ),
    appearance: (
      <>
        <circle cx="8" cy="8" r="3.1" />
        <path d="M8 2.4v1.4M8 12.2v1.4M2.4 8h1.4M12.2 8h1.4M4 4l1 1M11 11l1 1M12 4l-1 1M5 11l-1 1" />
      </>
    ),
    engagements: (
      <>
        <path d="M3.2 5.2h9.6v7.2H3.2z" />
        <path d="M5.2 5.2V3.8h5.6v1.4" />
      </>
    ),
    plugins: (
      <path d="M5 3.4v2.2H3.4v4.8H5V12.6h6v-2.2h1.6V5.6H11V3.4z" />
    ),
    runner: <path d="M4 3.6 12.4 8 4 12.4z" />,
    advisor: <path d="M3.4 4.2h9.2v6.2H7.2L4.8 12.4V10.4H3.4z" />,
    evidence: (
      <>
        <path d="M4.2 3.4h5.2L12 6.1v6.5H4.2z" />
        <path d="M9.2 3.5V6.2H12" />
      </>
    ),
    diagnostics: (
      <>
        <path d="M3.4 11.6 7.2 4.4h1.6l3.8 7.2z" />
        <path d="M8 7.2v2.2M8 11.2h.01" />
      </>
    ),
  };
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[id]}
    </svg>
  );
}

// The "/" shortcut must only reach a search input that is actually on screen,
// so a hidden desktop nav (display:none) never steals the key.
function isRenderedVisible(input: HTMLInputElement | null): boolean {
  if (!input) return false;
  if (typeof input.checkVisibility === "function") return input.checkVisibility();
  return input.getClientRects().length > 0;
}

export function SettingsNav({ onCloseMobile }: { onCloseMobile?: () => void }) {
  const { query, setQuery, activeHit, setActiveHit, activateHit, section, setSection } =
    useSettingsView();
  const inputRef = useRef<HTMLInputElement>(null);
  const searching = query.trim().length > 0;
  const results = searchSettings(query);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        !(target instanceof Element) ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      if (!isRenderedVisible(inputRef.current)) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const activeEntry = searching ? results[activeHit] : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="settings-nav">
      <div className="mx-2 mb-2.5 flex h-8 min-h-8 items-center gap-2 overflow-hidden rounded-lg px-2 focus-within:bg-accent">
        <SearchIcon />
        <input
          ref={inputRef}
          type="search"
          value={query}
          placeholder="Search settings"
          aria-label="Search settings"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={searching && results.length > 0}
          aria-controls="settings-search-results"
          aria-activedescendant={activeEntry ? `setting-hit-${activeEntry.id}` : undefined}
          className="min-h-[30px] min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/60"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (!searching || results.length === 0) return;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActiveHit((activeHit + 1) % results.length);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveHit((activeHit - 1 + results.length) % results.length);
            } else if (event.key === "Enter") {
              event.preventDefault();
              const entry = results[activeHit];
              if (entry) {
                activateHit(entry);
                onCloseMobile?.();
              }
            }
          }}
        />
        {searching ? (
          <button
            type="button"
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Clear settings search"
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
          >
            <ClearIcon />
          </button>
        ) : (
          <span className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-border px-1 font-mono text-[10px] font-semibold text-muted-foreground/70">
            /
          </span>
        )}
      </div>
      <div
        id="settings-search-results"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2"
        role={searching ? "listbox" : undefined}
        aria-label={searching ? "Settings search results" : undefined}
      >
        {searching ? (
          results.length > 0 ? (
            results.map((entry, index) => (
              <button
                key={entry.id}
                id={`setting-hit-${entry.id}`}
                type="button"
                role="option"
                aria-selected={index === activeHit}
                className={cn(
                  "flex w-full flex-col items-start gap-0.5 rounded-lg px-2 py-[7px] text-left outline-none hover:bg-sidebar-hover focus-visible:bg-sidebar-hover",
                  index === activeHit && "bg-sidebar-active",
                )}
                onClick={() => {
                  activateHit(entry);
                  onCloseMobile?.();
                }}
              >
                <b className="text-[13px] font-medium">{entry.title}</b>
                <span className="text-[11px] text-muted-foreground">
                  {SETTINGS_SECTIONS.find((item) => item.id === entry.section)?.label}
                </span>
              </button>
            ))
          ) : (
            <p className="px-2 py-5 text-center text-xs text-muted-foreground" role="status">
              No settings found
            </p>
          )
        ) : (
          SETTINGS_SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={cn(
                "flex min-h-9 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-muted-foreground outline-none hover:bg-sidebar-hover hover:text-foreground",
                section === item.id && "bg-sidebar-active text-foreground",
              )}
              aria-current={section === item.id ? "true" : undefined}
              onClick={() => {
                setSection(item.id);
                onCloseMobile?.();
              }}
            >
              <SectionIcon id={item.id} />
              {item.label}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

export function SettingsBackButton({
  onBack,
  onCloseMobile,
}: {
  onBack: () => void;
  onCloseMobile?: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="settings-back"
      className="flex min-h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-muted-foreground outline-none hover:bg-sidebar-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring md:min-h-8"
      onClick={() => {
        onCloseMobile?.();
        onBack();
      }}
    >
      <BackIcon />
      Back
    </button>
  );
}
