import { Switch, cn } from "@stonehush/ui";
import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { PLUGIN_CATALOG, catalogForTab, type PluginCatalogEntry } from "../plugins/catalog.js";

export const Route = createFileRoute("/plugins")({
  component: PluginsPage,
});

type MarketTab = "installed" | "available";

const D5_NOTE =
  "Install, enable, and disable stay disabled until decision gate D5 defines the plugin protocol.";

function GatedSwitch({ entry }: { entry: PluginCatalogEntry }) {
  return (
    <span title={D5_NOTE} aria-disabled="true" className="inline-flex cursor-default">
      <Switch
        checked={entry.enabled}
        label={`${entry.enabled ? "Disable" : "Enable"} ${entry.name}`}
        disabled
        className="cursor-default disabled:cursor-default"
      />
    </span>
  );
}

function GatedInstallButton({ entry }: { entry: PluginCatalogEntry }) {
  return (
    <button
      type="button"
      aria-disabled="true"
      className="inline-flex min-h-8 items-center justify-center rounded-lg border border-border px-3 text-[13px] text-muted-foreground opacity-60"
      title={`Installing ${entry.name} stays unavailable until D5 resolves.`}
    >
      Install
    </button>
  );
}

function PluginCard({ entry }: { entry: PluginCatalogEntry }) {
  return (
    <article className="density-row grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2.5 rounded-[10px] border border-border bg-card p-3.5 text-left">
      <div>
        <h3 className="m-0 text-[13px] font-semibold">{entry.name}</h3>
        <p className="mt-1 mb-0 text-xs leading-[1.45] text-muted-foreground">{entry.description}</p>
        <div className="mt-2.5 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
          <span className="font-semibold text-primary">{entry.tier}</span>
          <span className="font-mono">{entry.executable}</span>
          <span>{entry.origin}</span>
        </div>
      </div>
      {entry.installed ? <GatedSwitch entry={entry} /> : <GatedInstallButton entry={entry} />}
    </article>
  );
}

function PluginsPage() {
  const [tab, setTab] = useState<MarketTab>("installed");
  const entries = catalogForTab(PLUGIN_CATALOG, tab);
  const tabRefs = useRef<Record<MarketTab, HTMLButtonElement | null>>({
    available: null,
    installed: null,
  });

  return (
    <main className="min-h-full bg-background px-4 py-5 sm:px-[22px] sm:pt-[22px] sm:pb-[18px]" data-testid="plugins-page">
      <header className="mb-4">
          <h1 className="mt-0 mb-0 text-[26px] leading-none font-semibold tracking-[-0.04em]">
            Plugins
          </h1>
        </header>

        <div className="mb-4 flex items-center justify-between gap-3">
          <div
            aria-label="Plugin inventory"
            className="flex gap-1 rounded-[9px] bg-accent p-[3px]"
            role="tablist"
            onKeyDown={(event) => {
              const order: MarketTab[] = ["installed", "available"];
              const at = order.indexOf(tab);
              let next: MarketTab | undefined;
              if (event.key === "ArrowRight") next = order[(at + 1) % order.length];
              else if (event.key === "ArrowLeft") next = order[(at - 1 + order.length) % order.length];
              else if (event.key === "Home") next = order[0];
              else if (event.key === "End") next = order[order.length - 1];
              if (!next) return;
              event.preventDefault();
              setTab(next);
              // Roving focus follows selection, per the tabs pattern.
              tabRefs.current[next]?.focus();
            }}
          >
            {(["installed", "available"] as const).map((value) => (
              <button
                key={value}
                ref={(node) => {
                  tabRefs.current[value] = node;
                }}
                type="button"
                role="tab"
                id={`plugins-tab-${value}`}
                aria-selected={tab === value}
                aria-controls="plugins-panel"
                tabIndex={tab === value ? 0 : -1}
                className={cn(
                  "min-h-7 rounded-[7px] px-2.5 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                  tab === value && "bg-sidebar-active text-foreground",
                )}
                onClick={() => setTab(value)}
              >
                {value === "installed" ? "Installed" : "Available"}
              </button>
            ))}
          </div>
          {tab === "installed" ? (
            <span className="text-xs text-muted-foreground">
              {`${entries.length} bundled contract${entries.length === 1 ? "" : "s"}`}
            </span>
          ) : null}
        </div>

        {tab === "installed" ? (
          <p className="mt-0 mb-4 text-xs text-muted-foreground">{D5_NOTE}</p>
        ) : null}

        <div
          id="plugins-panel"
          role="tabpanel"
          aria-labelledby={`plugins-tab-${tab}`}
        >
          {entries.length > 0 ? (
            <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
              {entries.map((entry) => (
                <PluginCard key={entry.id} entry={entry} />
              ))}
            </div>
          ) : (
            <p className="max-w-[420px] pt-6 text-[13px] leading-5 text-muted-foreground">
              There are no available plugins because install, enable, and disable stay disabled
              until decision gate D5 defines the plugin protocol.
            </p>
          )}
        </div>
    </main>
  );
}
