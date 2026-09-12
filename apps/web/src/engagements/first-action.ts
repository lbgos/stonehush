import type { Engagement } from "@stonehush/contracts";

// Shared helpers for the first useful action: opening-screen Resume,
// engagement Start with a pasted target, and the planner first-scan profile.
// Targets are never persisted here. Only the small personal defaults
// (scan profile plus ports text) and the last engagement id use storage,
// and every read is strict with safe fallbacks.

export const LAST_ENGAGEMENT_STORAGE_KEY = "stonehush.lastEngagementId";

export const FIRST_ACTION_DEFAULTS_STORAGE_KEY = "stonehush.firstActionDefaults";

export type FirstActionProfile = "quick" | "fuller" | "web";

export interface FirstActionDefaults {
  profile: FirstActionProfile;
  declaredPorts: string;
}

const DEFAULT_DEFAULTS: FirstActionDefaults = { profile: "quick", declaredPorts: "" };

// Default TCP ports offered for the fuller port pass. This is UI text only;
// the planner sends exactly what the operator leaves in the ports field.
export const FULLER_PORTS_PRESET = "22,80,443";

const DESCRIPTION_MAX_CODE_POINTS = 4096;
const CHALLENGE_NOTES_MAX_BYTES = 60_000;

type MinimalStorage = Pick<Storage, "getItem" | "setItem">;

// Inert fallback when the browser storage object itself is unreachable
// (denied cookies, SecurityError on access). Reads miss, writes drop.
const inertStorage: MinimalStorage = {
  getItem: () => null,
  setItem: () => undefined,
};

// Guard the storage object access itself. The read/write helpers below catch
// per-call failures, but evaluating window.localStorage can throw before any
// helper runs, which would break render. Every browser call site uses this.
export function browserStorage(): MinimalStorage {
  try {
    return window.localStorage;
  } catch {
    return inertStorage;
  }
}

function readStorage(storage: MinimalStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(storage: MinimalStorage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    // Storage may be unavailable or full. Defaults are a convenience,
    // so a failed write never blocks the action.
  }
}

// Split a pasted target box into candidate entries. Newlines and commas both
// separate entries. Validation stays with parsePlannedTargets; this only
// tokenizes for name suggestion and emptiness checks.
export function splitStartTargets(raw: string): string[] {
  const targets: string[] = [];
  for (const part of raw.split(/[\n,]+/)) {
    const token = part.trim();
    if (token.length > 0) targets.push(token);
  }
  return targets;
}

// Suggest an engagement name from the first pasted target so the operator
// does not have to invent one. Always returns a contract-valid name.
export function suggestEngagementName(targets: readonly string[]): string {
  const first = targets.find((target) => target.trim().length > 0)?.trim() ?? "";
  if (first === "") return "Untitled lab";
  let host = first;
  const withScheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/.exec(first);
  const schemeHost = withScheme?.[2];
  if (schemeHost !== undefined) host = schemeHost;
  host = host.split(/[/?#]/)[0] ?? "";
  const atIndex = host.lastIndexOf("@");
  if (atIndex >= 0) host = host.slice(atIndex + 1);
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    host = end >= 0 ? host.slice(0, end + 1) : host;
  } else if (/:\d+$/.test(host)) {
    host = host.slice(0, host.lastIndexOf(":"));
  }
  const slug = host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const base = slug === "" ? "target" : slug;
  return `Lab ${base}`.slice(0, 120);
}

function truncateCodePoints(value: string, max: number): string {
  const points = Array.from(value);
  if (points.length <= max) return value;
  return points.slice(0, max).join("");
}

function truncateUtf8Bytes(value: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(value);
  if (encoded.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (encoded[end] ?? 0) >= 0x80 && (encoded[end] ?? 0) < 0xc0) {
    end -= 1;
  }
  return new TextDecoder().decode(encoded.slice(0, end));
}

// Merge the optional platform URL, challenge-file note, and free description
// into the single contract description field. The backend stores no separate
// platform URL, so the URL is kept as readable context, never dropped.
export function mergeStartDescription(input: {
  challengeNote?: string | undefined;
  description: string;
  platformUrl: string;
}): string | null {
  const lines: string[] = [];
  const platform = input.platformUrl.trim();
  if (platform !== "") lines.push(`Platform: ${platform}`);
  const challenge = input.challengeNote?.trim() ?? "";
  if (challenge !== "") lines.push(challenge);
  const body = input.description.trim();
  if (body !== "") {
    if (lines.length > 0) lines.push("");
    lines.push(body);
  }
  if (lines.length === 0) return null;
  return truncateCodePoints(lines.join("\n"), DESCRIPTION_MAX_CODE_POINTS);
}

// Build the initial notes body for a challenge-file start. The operator's
// own file text is content, not a target, so it never enters the action.
export function buildChallengeNotes(
  fileName: string,
  text: string,
  truncated: boolean,
): string {
  const safeName = fileName.replace(/[\r\n]+/g, " ").trim().slice(0, 120) || "challenge.txt";
  const body = truncateUtf8Bytes(text, CHALLENGE_NOTES_MAX_BYTES);
  const cut = truncated || body.length !== text.length ? "\n\n[file truncated to fit notes]" : "";
  return `# ${safeName}\n\n${body}${cut}\n`;
}

export type DeadlineDraft =
  | { kind: "absent" }
  | { kind: "error"; message: string }
  | { kind: "iso"; iso: string };

// Parse an optional datetime-local draft. Empty means absent. Invalid means
// an error message, never a guessed time.
export function parseDeadlineDraft(value: string): DeadlineDraft {
  if (value.trim() === "") return { kind: "absent" };
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    return { kind: "error", message: "That date and time was not understood. Use the picker." };
  }
  return { kind: "iso", iso: new Date(time).toISOString() };
}

function isFirstActionProfile(value: unknown): value is FirstActionProfile {
  return value === "quick" || value === "fuller" || value === "web";
}

// Personal scan defaults. Only the profile and the ports text are stored.
// Targets, credentials, and machine exceptions are never stored here.
export function readFirstActionDefaults(storage: MinimalStorage): FirstActionDefaults {
  const raw = readStorage(storage, FIRST_ACTION_DEFAULTS_STORAGE_KEY);
  if (raw === null) return { ...DEFAULT_DEFAULTS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ...DEFAULT_DEFAULTS };
  }
  if (typeof parsed !== "object" || parsed === null) return { ...DEFAULT_DEFAULTS };
  const record = parsed as Record<string, unknown>;
  const profile = isFirstActionProfile(record.profile) ? record.profile : "quick";
  const declaredPorts =
    typeof record.declaredPorts === "string" &&
    record.declaredPorts.length <= 128 &&
    /^[\d\s,-]*$/.test(record.declaredPorts)
      ? record.declaredPorts
      : "";
  return { profile, declaredPorts };
}

export function storeFirstActionDefaults(
  storage: MinimalStorage,
  defaults: FirstActionDefaults,
): void {
  writeStorage(
    storage,
    FIRST_ACTION_DEFAULTS_STORAGE_KEY,
    JSON.stringify({ profile: defaults.profile, declaredPorts: defaults.declaredPorts }),
  );
}

export function readLastEngagementId(storage: MinimalStorage): string | null {
  const raw = readStorage(storage, LAST_ENGAGEMENT_STORAGE_KEY);
  if (raw === null) return null;
  const id = raw.trim();
  return /^[0-9a-fA-F-]{1,64}$/.test(id) ? id : null;
}

export function storeLastEngagementId(storage: MinimalStorage, engagementId: string): void {
  writeStorage(storage, LAST_ENGAGEMENT_STORAGE_KEY, engagementId);
}

function mostRecentlyUpdated<T extends { id: string; updatedAt: string }>(
  engagements: readonly T[],
): T | undefined {
  return engagements.reduce<T | undefined>((current, engagement) => {
    if (!current) return engagement;
    if (engagement.updatedAt > current.updatedAt) return engagement;
    if (engagement.updatedAt === current.updatedAt && engagement.id > current.id) {
      return engagement;
    }
    return current;
  }, undefined);
}

// Resume picks the last opened engagement when it still exists, otherwise
// the most recently updated active engagement, otherwise the most recent of
// any status. Restart-safe: the server list is the source of truth.
export function selectResumeEngagement(
  engagements: readonly Engagement[],
  lastEngagementId: string | null,
): Engagement | undefined {
  if (lastEngagementId !== null) {
    const stored = engagements.find((engagement) => engagement.id === lastEngagementId);
    if (stored !== undefined) return stored;
  }
  const active = engagements.filter((engagement) => engagement.status === "active");
  return mostRecentlyUpdated(active) ?? mostRecentlyUpdated(engagements);
}
