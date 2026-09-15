export const DESKTOP_BREAKPOINT = 768;

export const SIDEBAR_WIDTH_STORAGE_KEY = "stonehush.layout.sidebar.width";
export const SIDEBAR_OPEN_STORAGE_KEY = "stonehush.layout.sidebar.open";
export const CONSOLE_HEIGHT_STORAGE_KEY = "stonehush.layout.console.height";

export const DEFAULT_SIDEBAR_WIDTH = 256;
export const MIN_SIDEBAR_WIDTH = 208;
export const DEFAULT_CONSOLE_HEIGHT = 320;
export const MIN_CONSOLE_HEIGHT = 220;

export interface LayoutStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export interface LayoutStorageSource {
  readonly localStorage: LayoutStorage;
}

export function getLayoutStorage(source: LayoutStorageSource): LayoutStorage | null {
  try {
    return source.localStorage;
  } catch {
    return null;
  }
}

export function clampSidebarWidth(value: number, viewportWidth: number): number {
  const maximum = Math.max(MIN_SIDEBAR_WIDTH, finiteOr(viewportWidth, 0) - 640);
  return clamp(finiteOr(value, DEFAULT_SIDEBAR_WIDTH), MIN_SIDEBAR_WIDTH, maximum);
}

export function clampConsoleHeight(value: number, viewportHeight: number): number {
  const maximum = Math.max(MIN_CONSOLE_HEIGHT, finiteOr(viewportHeight, 0) * 0.6);
  return clamp(finiteOr(value, DEFAULT_CONSOLE_HEIGHT), MIN_CONSOLE_HEIGHT, maximum);
}

export function parseStoredNumber(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseStoredBoolean(value: unknown): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

export function readStoredNumber(
  storage: Pick<LayoutStorage, "getItem"> | null,
  key: string,
  fallback: number,
): number {
  if (!storage) return fallback;
  try {
    return parseStoredNumber(storage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function readStoredBoolean(
  storage: Pick<LayoutStorage, "getItem"> | null,
  key: string,
  fallback: boolean,
): boolean {
  if (!storage) return fallback;
  try {
    return parseStoredBoolean(storage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeStoredValue(
  storage: Pick<LayoutStorage, "setItem"> | null,
  key: string,
  value: number | boolean,
): void {
  if (!storage) return;
  try {
    storage.setItem(key, String(value));
  } catch {
    // Layout remains usable when storage is unavailable or full.
  }
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
