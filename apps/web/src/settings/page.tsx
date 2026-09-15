import {
  THEME_MEDIA_QUERY,
  THEME_FAMILIES,
  LoadingRegion,
  RecoverableError,
  Skeleton,
  Switch,
  cn,
  listenForSystemTheme,
  resolveTheme,
  useTheme,
  type ResolvedTheme,
  type ThemeFamily,
} from "@stonehush/ui";
import {
  ADVISOR_SETTINGS_DEFAULTS,
  FFUF_BINARY_PATH_DEFAULT,
  UpdateAdvisorSettingsRequestSchema,
  type AdvisorStatus,
} from "@stonehush/contracts";
import { useEffect, useState, type ReactNode } from "react";

import {
  GLASS_OPACITY_MAX,
  GLASS_OPACITY_MIN,
  glassSliderProgress,
  useAppearancePrefs,
} from "./appearance.js";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "./model.js";
import { useUpdateRunnerSettingsMutation, useRunnerSettingsQuery } from "./runner-settings.js";
import {
  useAdvisorSettingsQuery,
  useUpdateAdvisorSettingsMutation,
} from "./advisor-settings.js";
import { useSettingsView } from "./settings-view.js";
import { useAdvisorStatusQuery } from "../advisor-status-query.js";
import { useSystemStatusQuery } from "../system-status-query.js";

const LOCKED_NOTE =
  "Saving preferences arrives with the v0.1 settings store. Values shown are shipped local defaults.";

// Runner and advisor persist through the local control plane, so the locked
// notice would mislead there. All other sections keep the accurate placeholder.
const STORED_SECTION_NOTES: Partial<Record<SettingsSectionId, string>> = {
  runner: "Stored in the local control plane. Explicit per-run values always win.",
  advisor: "Stored in the local control plane. API keys stay in the environment.",
};

function SetRow({
  children,
  description,
  settingId,
  title,
}: {
  children?: ReactNode;
  description?: string;
  settingId?: string;
  title: string;
}) {
  const { highlightId } = useSettingsView();
  const highlighted = settingId !== undefined && highlightId === settingId;
  return (
    <div
      className={cn(
        "density-row grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-7 border-b border-border last:border-b-0",
        highlighted && "-mx-2 rounded-lg bg-sidebar-active px-2",
      )}
      id={settingId === undefined ? undefined : `setting-${settingId}`}
      tabIndex={settingId === undefined ? undefined : -1}
    >
      <div>
        <h3 className="m-0 text-[13px] font-medium">{title}</h3>
        {description && (
          <p className="mt-1 mb-0 max-w-[440px] text-xs leading-[1.45] text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      <div className="flex items-center justify-end gap-2">{children}</div>
    </div>
  );
}

interface FieldOption {
  label: string;
  value: string;
}

function SelectField({
  disabled = true,
  label,
  onValueChange,
  options,
  value,
}: {
  disabled?: boolean;
  label: string;
  onValueChange?: (value: string) => void;
  options: readonly FieldOption[];
  value: string;
}) {
  return (
    <select
      aria-label={label}
      disabled={disabled}
      className={cn(
        "min-h-8 min-w-[148px] rounded-lg border border-border bg-accent px-2.5 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring",
        disabled && "opacity-80",
      )}
      value={value}
      onChange={onValueChange ? (event) => onValueChange(event.target.value) : undefined}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function PathField({ label, placeholder }: { label: string; placeholder: string }) {
  return (
    <input
      aria-label={label}
      className="min-h-8 w-60 rounded-lg border border-border bg-accent px-2.5 font-mono text-xs text-muted-foreground"
      placeholder={placeholder}
      readOnly
      type="text"
    />
  );
}

function LockedButton({ label, reason }: { label: string; reason: string }) {
  return (
    <button
      type="button"
      aria-disabled="true"
      disabled
      className="inline-flex min-h-8 items-center justify-center rounded-lg border border-border px-3 text-[13px] text-muted-foreground opacity-60"
      title={reason}
    >
      {label}
    </button>
  );
}

function HealthStatus({
  detail,
  label,
  tone,
}: {
  detail: string;
  label: string;
  tone: "ok" | "warn" | "fail" | "neutral";
}) {
  const toneText = {
    ok: "text-success",
    warn: "text-warning",
    fail: "text-destructive",
    neutral: "text-muted-foreground",
  }[tone];
  const toneBg = {
    ok: "bg-success",
    warn: "bg-warning",
    fail: "bg-destructive",
    neutral: "bg-muted-foreground/50",
  }[tone];
  return (
    <span className="flex items-center justify-between gap-4">
      <span aria-label={`${label}: ${detail}`} className={cn("text-xs font-semibold", toneText)}>
        {detail}
      </span>
      <span aria-hidden="true" className={cn("size-[7px] shrink-0 rounded-full", toneBg)} />
    </span>
  );
}

type SystemTone = "ok" | "warn" | "fail" | "neutral";

function systemTone(status: ReturnType<typeof useSystemStatusQuery>): SystemTone {
  if (!status.data) return status.isError || !status.isFetching ? "fail" : "neutral";
  return status.data.overall === "ready" ? "ok" : "warn";
}

function GeneralSection() {
  return (
    <>
      <SetRow
        description="Skip the warning dialog for this engagement and record each continue automatically."
        settingId="auto-continue"
        title="Auto-continue engagement warnings"
      >
        <Switch checked={false} label="Auto-continue engagement warnings" disabled />
      </SetRow>
      <SetRow
        description="24-hour UTC clock. Used in tables, console, and history."
        settingId="timestamp-format"
        title="Timestamp format"
      >
        <SelectField
          label="Timestamp format"
          options={[
            { label: "System default", value: "locale" },
            { label: "12-hour", value: "12-hour" },
            { label: "24-hour", value: "24-hour" },
          ]}
          value="24-hour"
        />
      </SetRow>
      <SetRow
        description="Reviewed-action archiving is not implemented."
        settingId="auto-archive"
        title="Auto-archive reviewed work"
      >
        <span className="text-[13px] text-muted-foreground">Not available in this version</span>
      </SetRow>
      <SetRow
        description="No automatic archiving runs, so no threshold applies."
        settingId="archive-days"
        title="Days before archive"
      >
        <span className="text-[13px] text-muted-foreground">Not available in this version</span>
      </SetRow>
      <SetRow
        description="Where Stonehush opens after launch. Dashboard stays the operational default."
        settingId="landing-view"
        title="Default landing view"
      >
        <SelectField
          label="Default landing view"
          options={[
            { label: "Dashboard", value: "dashboard" },
            { label: "Engagements", value: "engagements" },
          ]}
          value="dashboard"
        />
      </SetRow>
      <SetRow
        description="Reset every setting on this page to the shipped local defaults."
        settingId="restore-defaults"
        title="Restore defaults"
      >
        <LockedButton
          label="Restore defaults"
          reason="Restore defaults is not available in this version."
        />
      </SetRow>
    </>
  );
}

function useSystemResolvedTheme(): ResolvedTheme {
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    resolveTheme("system", window.matchMedia(THEME_MEDIA_QUERY).matches),
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia(THEME_MEDIA_QUERY);
    setResolved(resolveTheme("system", mediaQuery.matches));
    return listenForSystemTheme(mediaQuery, (prefersDark) =>
      setResolved(resolveTheme("system", prefersDark)),
    );
  }, []);

  return resolved;
}

const FAMILY_LABELS: Record<ThemeFamily, string> = {
  smoked: "Smoked lime",
  void: "Void",
  instrument: "Instrument",
  grove: "Grove",
  ember: "Ember",
  iris: "Iris",
};

const themeFamilies = THEME_FAMILIES.map((value) => ({
  value,
  label: FAMILY_LABELS[value],
  darkLabel: `${FAMILY_LABELS[value]} dark`,
  lightLabel: `${FAMILY_LABELS[value]} light`,
}));

function ThemeOrbs() {
  const { family, preference, setAppearance } = useTheme();
  const systemResolved = useSystemResolvedTheme();
  const resolvedScheme = preference === "system" ? systemResolved : preference;

  return (
    <div className="appearance-theme-grid">
      {themeFamilies.map((option) => {
        const selected = family === option.value;
        return (
          <div
            key={option.value}
            className={cn(
              "rounded-xl bg-accent px-3.5 pt-4 pb-3 text-left text-accent-foreground",
              selected && "shadow-[inset_0_0_0_1px_var(--primary)]",
            )}
            data-selected={selected ? "true" : "false"}
            data-theme-family={option.value}
          >
            <div className="mb-4 flex gap-3.5">
              <button
                type="button"
                aria-label={`${option.label} dark`}
                aria-pressed={selected && resolvedScheme === "dark"}
                className="theme-orb shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                data-orb={`${option.value}-dark`}
                data-on={selected && resolvedScheme === "dark" ? "true" : "false"}
                onClick={() => setAppearance({ family: option.value, preference: "dark" })}
              />
              <button
                type="button"
                aria-label={`${option.label} light`}
                aria-pressed={selected && resolvedScheme === "light"}
                className="theme-orb shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                data-orb={`${option.value}-light`}
                data-on={selected && resolvedScheme === "light" ? "true" : "false"}
                onClick={() => setAppearance({ family: option.value, preference: "light" })}
              />
            </div>
            <span className="text-[13px]">{option.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function AppearanceSection() {
  const { density, glassOpacity, reducedMotion, setDensity, setGlassOpacity, setReducedMotion } =
    useAppearancePrefs();

  return (
    <>
      <div className="appearance-settings mb-[22px]" id="setting-theme" tabIndex={-1}>
        <div className="mb-2.5 flex items-center justify-between gap-3">
          <h2 className="m-0 text-[13px] font-semibold">Themes</h2>
          <div className="flex gap-2">
            <LockedButton
              label="Create theme"
              reason="Custom themes arrive after the built-in theme families ship."
            />
            <LockedButton
              label="Import theme"
              reason="Custom themes arrive after the built-in theme families ship."
            />
          </div>
        </div>
        <p className="mt-0 mb-3 text-[13px] text-muted-foreground">
          Left bubble is dark. Right bubble is light.
        </p>
        <ThemeOrbs />
      </div>
      <SetRow
        description="How solid transient menus and dialogs appear."
        settingId="glass-opacity"
        title="Glass opacity"
      >
        <span className="flex items-center gap-3">
          <input
            id="glass-opacity"
            aria-label="Glass opacity"
            className="glass-slider h-1 w-[120px] shrink-0"
            max={GLASS_OPACITY_MAX}
            min={GLASS_OPACITY_MIN}
            step={1}
            style={{ ["--glass-slider-progress" as string]: `${glassSliderProgress(glassOpacity)}%` }}
            type="range"
            value={glassOpacity}
            onChange={(event) => setGlassOpacity(Number(event.target.value))}
          />
          <output className="min-w-[42px] text-right font-mono text-xs tabular-nums" htmlFor="glass-opacity">
            {glassOpacity}%
          </output>
        </span>
      </SetRow>
      <SetRow
        description="Row height and spacing in settings and plugin rows."
        settingId="density"
        title="Density"
      >
        <SelectField
          disabled={false}
          label="Density"
          onValueChange={(value) => setDensity(value as "compact" | "regular")}
          options={[
            { label: "Compact", value: "compact" },
            { label: "Regular", value: "regular" },
          ]}
          value={density}
        />
      </SetRow>
      <SetRow
        description="Disable short color and opacity transitions."
        settingId="reduced-motion"
        title="Reduced motion"
      >
        <Switch
          checked={reducedMotion}
          label="Reduced motion"
          onCheckedChange={setReducedMotion}
        />
      </SetRow>
    </>
  );
}

function EngagementsSection() {
  return (
    <>
      <SetRow
        description="Applied when creating a new engagement from the scope menu."
        settingId="engagement-type"
        title="Default engagement type"
      >
        <SelectField
          label="Default engagement type"
          options={[
            { label: "CTF", value: "ctf" },
            { label: "Lab", value: "lab" },
            { label: "Assessment", value: "assessment" },
          ]}
          value="ctf"
        />
      </SetRow>
      <SetRow
        description="How out-of-scope targets are presented before a run."
        settingId="scope-behavior"
        title="Saved-scope context"
      >
        <SelectField
          label="Saved-scope context"
          options={[
            { label: "Warn, then continue", value: "warn" },
            { label: "Record only", value: "note" },
          ]}
          value="warn"
        />
      </SetRow>
      <SetRow
        description="How many rows the list shows before Show more."
        settingId="history-size"
        title="Reviewed history size"
      >
        <SelectField
          label="Reviewed history size"
          options={[
            { label: "4", value: "4" },
            { label: "10", value: "10" },
            { label: "25", value: "25" },
          ]}
          value="10"
        />
      </SetRow>
    </>
  );
}

function PluginsSettingsSection() {
  return (
    <>
      <SetRow
        description="Local plugin store used by the unprivileged runner."
        settingId="plugin-dir"
        title="Installed directory"
      >
        <PathField label="Installed directory" placeholder="Managed by the control plane" />
      </SetRow>
      <SetRow
        description="No update checks run on the local machine."
        settingId="plugin-updates"
        title="Update checks"
      >
        <span className="text-[13px] text-muted-foreground">Not available in this version</span>
      </SetRow>
      <SetRow
        description="Whether disabled plugins stay listed in the action set."
        settingId="disabled-plugins"
        title="Disabled plugin behavior"
      >
        <SelectField
          label="Disabled plugin behavior"
          options={[
            { label: "Keep listed", value: "keep-listed" },
            { label: "Hide", value: "hide" },
          ]}
          value="keep-listed"
        />
      </SetRow>
    </>
  );
}

function parseRunnerInt(raw: string, min: number, max: number): number | undefined {
  if (!/^\d+$/.test(raw.trim())) return undefined;
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(value) || value < min || value > max) return undefined;
  return value;
}

function isAbsoluteRunnerPath(value: string): boolean {
  return value.startsWith("/") && !value.includes("\0") && !value.split("/").includes("..");
}

function RunnerSection() {
  const settingsQuery = useRunnerSettingsQuery();
  const updateMutation = useUpdateRunnerSettingsMutation();
  const [wordlist, setWordlist] = useState("");
  const [rate, setRate] = useState("");
  const [threads, setThreads] = useState("");
  const [timeout, setTimeout] = useState("");
  const [duration, setDuration] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState(false);

  const stored = settingsQuery.data;
  useEffect(() => {
    if (stored === undefined || hydrated) return;
    setWordlist(stored.ffufWordlistPath);
    setRate(String(stored.ffufRate));
    setThreads(String(stored.ffufThreads));
    setTimeout(String(stored.ffufTimeoutSeconds));
    setDuration(String(stored.ffufMaxTimeSeconds));
    setHydrated(true);
  }, [stored, hydrated]);

  if (settingsQuery.isPending) {
    return (
      <LoadingRegion label="Loading runner settings" className="space-y-3">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </LoadingRegion>
    );
  }

  if (settingsQuery.isError || stored === undefined) {
    return (
      <RecoverableError
        title="Runner settings unavailable"
        description="Stored ffuf defaults could not be loaded from the local control plane."
        onRetry={() => void settingsQuery.refetch()}
      />
    );
  }

  const parsedRate = parseRunnerInt(rate, 1, 10_000);
  const parsedThreads = parseRunnerInt(threads, 1, 200);
  const parsedTimeout = parseRunnerInt(timeout, 1, 120);
  const parsedDuration = parseRunnerInt(duration, 5, 1800);
  const wordlistValid = wordlist.trim() === "" || isAbsoluteRunnerPath(wordlist.trim());

  const save = () => {
    updateMutation.reset();
    setSaved(false);
    if (!wordlistValid) {
      setFieldError("Default wordlist must be empty (unset) or an absolute path without .. segments.");
      return;
    }
    if (parsedRate === undefined) {
      setFieldError("Default rate must be an integer in 1-10000.");
      return;
    }
    if (parsedThreads === undefined) {
      setFieldError("Default threads must be an integer in 1-200.");
      return;
    }
    if (parsedTimeout === undefined) {
      setFieldError("Default timeout must be an integer in 1-120 seconds.");
      return;
    }
    if (parsedDuration === undefined) {
      setFieldError("Default duration must be an integer in 5-1800 seconds.");
      return;
    }
    setFieldError(undefined);
    // The fixed runner executable is not a preference: it is never sent, so
    // any stored legacy path survives the partial update untouched.
    updateMutation.mutate(
      {
        ffufWordlistPath: wordlist.trim(),
        ffufRate: parsedRate,
        ffufThreads: parsedThreads,
        ffufTimeoutSeconds: parsedTimeout,
        ffufMaxTimeSeconds: parsedDuration,
      },
      { onSuccess: () => setSaved(true) },
    );
  };

  const textInputClass =
    "min-h-8 w-60 rounded-lg border border-border bg-accent px-2.5 font-mono text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";
  const numberInputClass =
    "min-h-8 w-[88px] rounded-lg border border-border bg-accent px-2.5 font-mono text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <>
      <p className="mt-0 mb-3 text-[13px] text-muted-foreground">
        Defaults applied to ffuf launches. Explicit per-run values always win.
      </p>
      <SetRow
        description="The runner pins its ffuf executable. A stored path is kept but never used."
        settingId="ffuf-binary"
        title="ffuf binary"
      >
        <span className="font-mono text-xs text-muted-foreground">
          Fixed runner executable ({FFUF_BINARY_PATH_DEFAULT})
        </span>
      </SetRow>
      <SetRow
        description="Empty means unset: each launch must then provide a wordlist."
        settingId="ffuf-wordlist"
        title="Default wordlist"
      >
        <input
          aria-label="Default wordlist"
          className={textInputClass}
          value={wordlist}
          autoComplete="off"
          spellCheck={false}
          placeholder="Not set"
          type="text"
          onChange={(event) => {
            setWordlist(event.target.value);
            setSaved(false);
          }}
        />
      </SetRow>
      <SetRow description="Requests per second applied when a launch omits a rate." settingId="ffuf-rate" title="Default rate">
        <input
          aria-label="Default rate"
          className={numberInputClass}
          value={rate}
          inputMode="numeric"
          autoComplete="off"
          type="text"
          onChange={(event) => {
            setRate(event.target.value);
            setSaved(false);
          }}
        />
      </SetRow>
      <SetRow description="Worker threads applied when a launch omits threads." settingId="ffuf-threads" title="Default threads">
        <input
          aria-label="Default threads"
          className={numberInputClass}
          value={threads}
          inputMode="numeric"
          autoComplete="off"
          type="text"
          onChange={(event) => {
            setThreads(event.target.value);
            setSaved(false);
          }}
        />
      </SetRow>
      <SetRow description="Per-request timeout in seconds applied when a launch omits it." settingId="ffuf-timeout" title="Default timeout">
        <input
          aria-label="Default timeout"
          className={numberInputClass}
          value={timeout}
          inputMode="numeric"
          autoComplete="off"
          type="text"
          onChange={(event) => {
            setTimeout(event.target.value);
            setSaved(false);
          }}
        />
      </SetRow>
      <SetRow description="Maximum run time in seconds applied when a launch omits it." settingId="ffuf-duration" title="Default duration">
        <input
          aria-label="Default duration"
          className={numberInputClass}
          value={duration}
          inputMode="numeric"
          autoComplete="off"
          type="text"
          onChange={(event) => {
            setDuration(event.target.value);
            setSaved(false);
          }}
        />
      </SetRow>
      {fieldError && (
        <p className="m-0 mt-2 text-[13px] text-destructive" role="alert">
          {fieldError}
        </p>
      )}
      {updateMutation.isError && (
        <p className="m-0 mt-2 text-[13px] text-destructive" role="alert">
          The runner settings update failed. Check the values and try again.
        </p>
      )}
      {saved && !updateMutation.isPending && (
        <p className="m-0 mt-2 text-[13px] text-success" role="status">
          Runner defaults saved.
        </p>
      )}
      <div className="mt-3 flex">
        <button
          type="button"
          className="inline-flex min-h-8 items-center justify-center rounded-lg border border-border px-3 text-[13px] text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          disabled={updateMutation.isPending}
          onClick={save}
        >
          {updateMutation.isPending ? "Saving" : "Save runner defaults"}
        </button>
      </div>
    </>
  );
}

const ADVISOR_ENV_VAR_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
// Key material must never be stored: any value carrying a secret prefix is
// rejected before it can reach the backend. The message names no value.
const ADVISOR_KEY_MATERIAL_PATTERN = /sk-|bearer /i;

function isAdvisorEndpointValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return true;
  if (trimmed.length > 2048) return false;
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// Truthful connection copy: the probe only receives HTTP headers and never
// performs inference, so a success reports the endpoint reachable, never the
// model verified.
function advisorTestCopy(status: AdvisorStatus): string {
  switch (status.reason) {
    case "ok":
      return status.latencyMs === null
        ? `Endpoint reachable at ${status.endpointHost}. Headers-only probe; model output not verified.`
        : `Endpoint reachable at ${status.endpointHost} in ${status.latencyMs} ms. Headers-only probe; model output not verified.`;
    case "unconfigured":
      return "Not configured. Set an endpoint and a model, then save.";
    case "missing_key_env":
      return "Name the environment variable holding the API key, then save.";
    case "key_unset":
      return status.keyEnvVar === ""
        ? "Set the configured key variable in the control-plane environment, then test again."
        : `Set ${status.keyEnvVar} in the control-plane environment, then test again.`;
    case "public_not_opted_in":
      return `${status.endpointHost} looks public. Opt in to public endpoints to test it.`;
    case "unreachable":
      return `${status.modelId} at ${status.endpointHost} did not answer. Start the endpoint or fix the base URL.`;
    case "probe_failed":
      return "The control plane could not test the endpoint. Check the base URL.";
  }
}

function AdvisorSection() {
  const { advisorOpen, toggleAdvisor } = useSettingsView();
  const settingsQuery = useAdvisorSettingsQuery();
  const updateMutation = useUpdateAdvisorSettingsMutation();
  const statusQuery = useAdvisorStatusQuery();
  // Effective connection fields only: request budget, raw response visibility,
  // and advisor mode have no turn consumer yet and render as unavailable facts.
  const [endpoint, setEndpoint] = useState(ADVISOR_SETTINGS_DEFAULTS.endpointBaseUrl);
  const [model, setModel] = useState(ADVISOR_SETTINGS_DEFAULTS.modelId);
  const [keyVar, setKeyVar] = useState(ADVISOR_SETTINGS_DEFAULTS.apiKeyEnvVar);
  const [publicOptIn, setPublicOptIn] = useState(ADVISOR_SETTINGS_DEFAULTS.publicEndpointOptIn);
  const [hydrated, setHydrated] = useState(false);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  const [tested, setTested] = useState(false);
  const [dirty, setDirty] = useState(false);

  const stored = settingsQuery.data;
  useEffect(() => {
    if (stored === undefined || hydrated) return;
    setEndpoint(stored.endpointBaseUrl);
    setModel(stored.modelId);
    setKeyVar(stored.apiKeyEnvVar);
    setPublicOptIn(stored.publicEndpointOptIn);
    setHydrated(true);
  }, [stored, hydrated]);

  // Editing unlocks only after the first successful load, so a delayed or
  // failed GET can never trick the operator into saving defaults over real
  // stored configuration. Editing also locks during a save, so a slow save
  // response can never bless newer unsaved typing as saved.
  const editable = hydrated && !updateMutation.isPending;

  const markEdited = () => {
    setDirty(true);
    setTested(false);
    setSaved(false);
  };

  const save = () => {
    if (!hydrated) return;
    updateMutation.reset();
    setSaved(false);
    const trimmedEndpoint = endpoint.trim();
    const trimmedModel = model.trim();
    const trimmedKeyVar = keyVar.trim();
    if (!isAdvisorEndpointValue(endpoint)) {
      setFieldError("Endpoint must be an http(s) URL or empty (unconfigured).");
      return;
    }
    if (
      ADVISOR_KEY_MATERIAL_PATTERN.test(endpoint) ||
      ADVISOR_KEY_MATERIAL_PATTERN.test(model) ||
      ADVISOR_KEY_MATERIAL_PATTERN.test(keyVar)
    ) {
      setFieldError("Key names must not contain key material. Enter the variable name only.");
      return;
    }
    if (trimmedModel.length > 128) {
      setFieldError("Model id must be at most 128 characters.");
      return;
    }
    if (
      trimmedKeyVar !== "" &&
      (trimmedKeyVar.length > 128 || !ADVISOR_ENV_VAR_PATTERN.test(trimmedKeyVar))
    ) {
      setFieldError("Key reference must match [A-Z_][A-Z0-9_]* or be empty.");
      return;
    }
    // Shared-contract gate: nothing reaches the backend unless it validates.
    // Only effective fields are sent, so unavailable fields keep their stored
    // values through the backend partial update.
    const checked = UpdateAdvisorSettingsRequestSchema.safeParse({
      endpointBaseUrl: trimmedEndpoint,
      modelId: trimmedModel,
      apiKeyEnvVar: trimmedKeyVar,
      publicEndpointOptIn: publicOptIn,
    });
    if (!checked.success) {
      setFieldError("Stored advisor values are invalid. Check the values and try again.");
      return;
    }
    setFieldError(undefined);
    updateMutation.mutate(checked.data, {
      onSuccess: () => {
        setSaved(true);
        setDirty(false);
        setTested(false);
      },
    });
  };

  const testConnection = () => {
    if (dirty || !hydrated) return;
    setTested(true);
    void statusQuery.refetch();
  };

  const textInputClass =
    "min-h-8 w-60 rounded-lg border border-border bg-accent px-2.5 font-mono text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-55";

  return (
    <>
      <p className="mt-0 mb-3 text-[13px] text-muted-foreground">
        OpenAI-compatible endpoint. The API key itself stays in the control-plane
        environment.
      </p>
      {!hydrated && settingsQuery.isPending && (
        <p className="m-0 mb-3 text-[13px] text-muted-foreground" role="status">
          Loading stored advisor values. Editing unlocks after they load.
        </p>
      )}
      {!hydrated && settingsQuery.isError && (
        <RecoverableError
          title="Advisor settings unavailable"
          description="Stored advisor values could not be loaded. Editing stays disabled until they load."
          onRetry={() => void settingsQuery.refetch()}
        />
      )}
      <SetRow
        description="Operator stays terse. Mentor explains evidence and expected results."
        settingId="advisor-mode"
        title="Default mode"
      >
        <span className="text-[13px] text-muted-foreground">Not available in this version</span>
      </SetRow>
      <SetRow
        description="OpenAI-compatible base URL. Local and private endpoints are the default path."
        settingId="advisor-endpoint"
        title="Model endpoint"
      >
        <button
          type="button"
          aria-expanded={advisorOpen}
          className="inline-flex min-h-8 items-center rounded-lg px-3 text-[13px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={toggleAdvisor}
        >
          {advisorOpen ? "Hide details" : "Show details"}
        </button>
      </SetRow>
      {advisorOpen && (
        <div className="mb-2 grid gap-2 pb-2">
          <SetRow
            description="OpenAI-compatible base URL. Empty means unconfigured."
            settingId="advisor-endpoint-base-url"
            title="Base URL"
          >
            <input
              aria-label="Model endpoint"
              className={textInputClass}
              value={endpoint}
              autoComplete="off"
              spellCheck={false}
              placeholder="http://127.0.0.1:11434/v1"
              type="text"
              disabled={!editable}
              onChange={(event) => {
                setEndpoint(event.target.value);
                markEdited();
              }}
            />
          </SetRow>
          <SetRow
            description="Model served by the configured endpoint. Empty means unconfigured."
            settingId="advisor-model-id"
            title="Model id"
          >
            <input
              aria-label="Model id"
              className={textInputClass}
              value={model}
              autoComplete="off"
              spellCheck={false}
              placeholder="Not configured yet"
              type="text"
              disabled={!editable}
              onChange={(event) => {
                setModel(event.target.value);
                markEdited();
              }}
            />
          </SetRow>
          <SetRow
            description="Variable name only. The key value is never stored or shown."
            settingId="advisor-api-key"
            title="API key variable"
          >
            <input
              aria-label="API key variable"
              className={textInputClass}
              value={keyVar}
              autoComplete="off"
              spellCheck={false}
              placeholder="STONEHUSH_ADVISOR_API_KEY"
              type="text"
              disabled={!editable}
              onChange={(event) => {
                setKeyVar(event.target.value);
                markEdited();
              }}
            />
          </SetRow>
        </div>
      )}
      <SetRow
        description="Cap model calls for a single advisor turn."
        settingId="request-budget"
        title="Request budget"
      >
        <span className="text-[13px] text-muted-foreground">Not available in this version</span>
      </SetRow>
      <SetRow
        description="Keep the unparsed model payload visible next to structured output."
        settingId="raw-response"
        title="Raw response visibility"
      >
        <span className="text-[13px] text-muted-foreground">Not available in this version</span>
      </SetRow>
      <SetRow
        description="Public endpoints may send prompts beyond the local network. Opt in to test one."
        settingId="advisor-public-opt-in"
        title="Public endpoint opt-in"
      >
        <Switch
          checked={publicOptIn}
          label="Public endpoint opt-in"
          disabled={!editable}
          onCheckedChange={(next) => {
            setPublicOptIn(next);
            markEdited();
          }}
        />
      </SetRow>
      {fieldError && (
        <p className="m-0 mt-2 text-[13px] text-destructive" role="alert">
          {fieldError}
        </p>
      )}
      {updateMutation.isError && (
        <p className="m-0 mt-2 text-[13px] text-destructive" role="alert">
          The advisor settings update failed. Values kept. Check the values and try again.
        </p>
      )}
      {saved && !updateMutation.isPending && (
        <p className="m-0 mt-2 text-[13px] text-success" role="status">
          Advisor settings saved.
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="inline-flex min-h-8 items-center justify-center rounded-lg border border-border px-3 text-[13px] text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          disabled={!editable}
          onClick={save}
        >
          {updateMutation.isPending ? "Saving" : "Save advisor settings"}
        </button>
        <button
          type="button"
          className="inline-flex min-h-8 items-center justify-center rounded-lg border border-border px-3 text-[13px] text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          disabled={!hydrated || dirty || statusQuery.isFetching}
          onClick={testConnection}
        >
          {statusQuery.isFetching ? "Testing" : "Test connection"}
        </button>
      </div>
      {dirty && (
        <p className="m-0 mt-2 text-[13px] text-muted-foreground" role="status">
          Unsaved changes. Save first, then test the connection.
        </p>
      )}
      {tested && statusQuery.isFetching && !statusQuery.data && (
        <p className="m-0 mt-2 text-[13px] text-muted-foreground" role="status">
          Testing endpoint.
        </p>
      )}
      {tested && statusQuery.isError && (
        <p className="m-0 mt-2 text-[13px] text-destructive" role="alert">
          Connection test unavailable. The control plane did not return advisor status.
        </p>
      )}
      {tested && statusQuery.data && (
        <p className="m-0 mt-2 text-[13px] text-muted-foreground" role="status">
          {advisorTestCopy(statusQuery.data)}
        </p>
      )}
    </>
  );
}

function EvidenceSection() {
  return (
    <>
      <SetRow
        description="Control-plane path for content-addressed evidence."
        settingId="evidence-path"
        title="Local storage path"
      >
        <PathField label="Local storage path" placeholder="Managed by the control plane" />
      </SetRow>
      <SetRow
        description="No automatic expiry runs. Removal is an explicit owner operation."
        settingId="retention"
        title="Retention"
      >
        <span className="text-[13px] text-muted-foreground">Not available in this version</span>
      </SetRow>
      <SetRow
        description="Raw artifacts cannot be replaced. Parser updates write new observations."
        settingId="immutable-evidence"
        title="Immutable raw evidence"
      >
        <Switch checked label="Immutable raw evidence" disabled />
      </SetRow>
    </>
  );
}

function DiagnosticsSection() {
  const systemStatus = useSystemStatusQuery();
  const tone = systemTone(systemStatus);
  const controlPlaneDetail = !systemStatus.data
    ? systemStatus.isError
      ? "Unavailable"
      : "Checking"
    : systemStatus.data.overall === "ready"
      ? "Ready"
      : "Not ready";
  const storageTone: SystemTone = !systemStatus.data
    ? systemStatus.isError
      ? "fail"
      : "neutral"
    : systemStatus.data.developmentStorage === "ready"
      ? "ok"
      : "warn";
  const storageDetail = !systemStatus.data
    ? systemStatus.isError
      ? "Unavailable"
      : "Checking"
    : systemStatus.data.developmentStorage === "ready"
      ? "WAL ready"
      : "Not ready";
  const lastChecked = systemStatus.dataUpdatedAt
    ? new Date(systemStatus.dataUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";

  return (
    <>
      <SetRow description="Local API and event stream." settingId="health-control-plane" title="Control plane">
        <HealthStatus detail={controlPlaneDetail} label="Control plane" tone={tone} />
      </SetRow>
      <SetRow
        description="Unprivileged host runner identity and heartbeat."
        settingId="health-runner"
        title="Runner"
      >
        <HealthStatus detail="Not reported yet" label="Runner" tone="neutral" />
      </SetRow>
      <SetRow description="WAL database used by the control plane." settingId="health-sqlite" title="SQLite">
        <HealthStatus detail={storageDetail} label="SQLite" tone={storageTone} />
      </SetRow>
      <SetRow
        description="Writable evidence volume and path policy."
        settingId="health-evidence"
        title="Evidence storage"
      >
        <HealthStatus detail={storageDetail} label="Evidence storage" tone={storageTone} />
      </SetRow>
      <SetRow description="Re-read local health state. No network beyond the local API." settingId="run-checks" title="Run checks">
        <span className="flex items-center gap-2">
          <button
            type="button"
            className="inline-flex min-h-8 items-center justify-center rounded-lg border border-border px-3 text-[13px] text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => void systemStatus.refetch()}
          >
            Run checks
          </button>
          {lastChecked ? (
            <span className="text-xs text-muted-foreground">Checked {lastChecked}</span>
          ) : null}
        </span>
      </SetRow>
    </>
  );
}

const SECTION_BODIES: Record<SettingsSectionId, () => ReactNode> = {
  general: GeneralSection,
  appearance: AppearanceSection,
  engagements: EngagementsSection,
  plugins: PluginsSettingsSection,
  runner: RunnerSection,
  advisor: AdvisorSection,
  evidence: EvidenceSection,
  diagnostics: DiagnosticsSection,
};

export function SettingsPage() {
  const { section, highlightId } = useSettingsView();
  const current = SETTINGS_SECTIONS.find((item) => item.id === section);
  const Body = SECTION_BODIES[section];

  useEffect(() => {
    if (!highlightId) return;
    const node = document.getElementById(`setting-${highlightId}`);
    if (!node) return;
    node.focus({ preventScroll: true });
    if (typeof node.scrollIntoView === "function") {
      node.scrollIntoView({ block: "center" });
    }
  }, [highlightId]);

  return (
    <main className="min-h-full bg-background" data-testid="settings-page">
      <div className="mx-auto w-full max-w-[860px] px-4 pt-7 pb-18 sm:px-7">
        <p className="mt-0 mb-7 text-[13px] text-muted-foreground">Settings</p>
        <h1 className="mt-0 mb-2 text-[26px] leading-none font-semibold tracking-[-0.04em]">
          {current?.label ?? "General"}
        </h1>
        {section === "appearance" ? (
          <p className="mt-0 mb-5.5 text-[13px] text-muted-foreground">
            Choose how Stonehush looks. Use a built-in theme or make your own.
          </p>
        ) : STORED_SECTION_NOTES[section] ? (
          <p className="mt-0 mb-5.5 text-[13px] text-muted-foreground">
            {STORED_SECTION_NOTES[section]}
          </p>
        ) : (
          <p className="mt-0 mb-5.5 text-[13px] text-muted-foreground">{LOCKED_NOTE}</p>
        )}
        <div>
          <Body />
        </div>
      </div>
    </main>
  );
}
