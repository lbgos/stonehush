export type SettingsSectionId =
  | "general"
  | "appearance"
  | "engagements"
  | "plugins"
  | "runner"
  | "advisor"
  | "evidence"
  | "diagnostics";

export interface SettingsSection {
  id: SettingsSectionId;
  label: string;
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "engagements", label: "Engagements" },
  { id: "plugins", label: "Plugins" },
  { id: "runner", label: "Runner" },
  { id: "advisor", label: "Advisor" },
  { id: "evidence", label: "Evidence" },
  { id: "diagnostics", label: "Diagnostics" },
];

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "appearance";

export interface SettingsIndexEntry {
  id: string;
  section: SettingsSectionId;
  title: string;
  description: string;
}

export const SETTINGS_INDEX: readonly SettingsIndexEntry[] = [
  { id: "auto-continue", section: "general", title: "Auto-continue engagement warnings", description: "Skip the warning dialog for this engagement and record each continue automatically." },
  { id: "timestamp-format", section: "general", title: "Timestamp format", description: "24-hour UTC clock. Used in tables, console, and history." },
  { id: "auto-archive", section: "general", title: "Auto-archive reviewed work", description: "Reviewed-action archiving is not implemented." },
  { id: "archive-days", section: "general", title: "Days before archive", description: "No automatic archiving runs, so no threshold applies." },
  { id: "landing-view", section: "general", title: "Default landing view", description: "Where Stonehush opens after launch. Dashboard stays the operational default." },
  { id: "restore-defaults", section: "general", title: "Restore defaults", description: "Reset every setting on this page to the shipped local defaults." },
  { id: "theme", section: "appearance", title: "Theme", description: "Smoked glass on true black. Swatches are previews only." },
  { id: "glass-opacity", section: "appearance", title: "Glass opacity", description: "How solid transient menus and dialogs appear." },
  { id: "density", section: "appearance", title: "Density", description: "Row height and spacing in settings and plugin rows." },
  { id: "reduced-motion", section: "appearance", title: "Reduced motion", description: "Disable short color and opacity transitions." },
  { id: "engagement-type", section: "engagements", title: "Default engagement type", description: "Applied when creating a new engagement from the scope menu." },
  { id: "scope-behavior", section: "engagements", title: "Saved-scope context", description: "How out-of-scope targets are presented before a run." },
  { id: "history-size", section: "engagements", title: "Reviewed history size", description: "How many rows the list shows before Show more." },
  { id: "plugin-dir", section: "plugins", title: "Installed directory", description: "Local plugin store used by the unprivileged runner." },
  { id: "plugin-updates", section: "plugins", title: "Update checks", description: "No update checks run on the local machine." },
  { id: "disabled-plugins", section: "plugins", title: "Disabled plugin behavior", description: "Whether disabled plugins stay listed in the action set." },
  { id: "ffuf-binary", section: "runner", title: "ffuf binary", description: "The runner pins its ffuf executable. A stored path is kept but never used." },
  { id: "ffuf-wordlist", section: "runner", title: "Default wordlist", description: "Empty means unset: each launch must then provide a wordlist." },
  { id: "ffuf-rate", section: "runner", title: "Default rate", description: "Requests per second applied when a launch omits a rate." },
  { id: "ffuf-threads", section: "runner", title: "Default threads", description: "Worker threads applied when a launch omits threads." },
  { id: "ffuf-timeout", section: "runner", title: "Default timeout", description: "Per-request timeout in seconds applied when a launch omits it." },
  { id: "ffuf-duration", section: "runner", title: "Default duration", description: "Maximum run time in seconds applied when a launch omits it." },
  { id: "advisor-mode", section: "advisor", title: "Default mode", description: "Operator stays terse. Mentor explains evidence and expected results." },
  { id: "advisor-endpoint", section: "advisor", title: "Model endpoint", description: "OpenAI-compatible base URL. Local and private endpoints are the default path." },
  { id: "advisor-endpoint-base-url", section: "advisor", title: "Base URL", description: "OpenAI-compatible base URL. Empty means unconfigured." },
  { id: "advisor-model-id", section: "advisor", title: "Model id", description: "Model served by the configured endpoint. Empty means unconfigured." },
  { id: "advisor-api-key", section: "advisor", title: "API key variable", description: "Environment variable name holding the API key. The key itself is never stored." },
  { id: "request-budget", section: "advisor", title: "Request budget", description: "Cap model calls for a single advisor turn." },
  { id: "raw-response", section: "advisor", title: "Raw response visibility", description: "Keep the unparsed model payload visible next to structured output." },
  { id: "advisor-public-opt-in", section: "advisor", title: "Public endpoint opt-in", description: "Allow testing endpoints that look public. Prompts may leave the local network." },
  { id: "evidence-path", section: "evidence", title: "Local storage path", description: "Control-plane path for content-addressed evidence." },
  { id: "retention", section: "evidence", title: "Retention", description: "No automatic expiry runs. Removal is an explicit owner operation." },
  { id: "immutable-evidence", section: "evidence", title: "Immutable raw evidence", description: "Raw artifacts cannot be replaced. Parser updates write new observations." },
  { id: "health-control-plane", section: "diagnostics", title: "Control plane", description: "Local API and event stream." },
  { id: "health-runner", section: "diagnostics", title: "Runner", description: "Unprivileged host runner identity and heartbeat." },
  { id: "health-sqlite", section: "diagnostics", title: "SQLite", description: "WAL database used by the control plane." },
  { id: "health-evidence", section: "diagnostics", title: "Evidence storage", description: "Writable evidence volume and path policy." },
  { id: "run-checks", section: "diagnostics", title: "Run checks", description: "Re-read local health state. No network beyond the local API." },
];

export function searchSettings(query: string): SettingsIndexEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return SETTINGS_INDEX.filter((entry) =>
    `${entry.title} ${entry.description} ${entry.section}`.toLowerCase().includes(q),
  );
}
