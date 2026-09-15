import { useCallback, useEffect, useState } from "react";

export const GLASS_OPACITY_STORAGE_KEY = "stonehush.glassOpacity";
export const DENSITY_STORAGE_KEY = "stonehush.density";
export const REDUCED_MOTION_STORAGE_KEY = "stonehush.reducedMotion";

export const GLASS_OPACITY_MIN = 5;
export const GLASS_OPACITY_MAX = 40;
export const DEFAULT_GLASS_OPACITY = 26;
export const DEFAULT_DENSITY = "compact" as const;
export const DEFAULT_REDUCED_MOTION = false as const;

export type Density = "compact" | "regular";

const DENSITY_VALUES: readonly Density[] = ["compact", "regular"];

interface AppearanceStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

interface AppearanceRoot {
  dataset: DOMStringMap;
  style: CSSStyleDeclaration;
  classList: Pick<DOMTokenList, "add" | "remove" | "toggle" | "contains">;
}

interface AppearanceStorageEvents {
  addEventListener: (type: "storage", listener: (event: StorageEvent) => void) => void;
  removeEventListener: (type: "storage", listener: (event: StorageEvent) => void) => void;
}

export function parseGlassOpacity(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!/^-?\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n < GLASS_OPACITY_MIN || n > GLASS_OPACITY_MAX) return null;
  return n;
}

export function parseDensity(value: unknown): Density | null {
  return typeof value === "string" && (DENSITY_VALUES as readonly string[]).includes(value)
    ? (value as Density)
    : null;
}

export function parseReducedMotion(value: unknown): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

export function readGlassOpacity(storage: AppearanceStorage): number {
  try {
    return parseGlassOpacity(storage.getItem(GLASS_OPACITY_STORAGE_KEY)) ?? DEFAULT_GLASS_OPACITY;
  } catch {
    return DEFAULT_GLASS_OPACITY;
  }
}

export function readDensity(storage: AppearanceStorage): Density {
  try {
    return parseDensity(storage.getItem(DENSITY_STORAGE_KEY)) ?? DEFAULT_DENSITY;
  } catch {
    return DEFAULT_DENSITY;
  }
}

export function readReducedMotion(storage: AppearanceStorage): boolean {
  try {
    return parseReducedMotion(storage.getItem(REDUCED_MOTION_STORAGE_KEY)) ?? DEFAULT_REDUCED_MOTION;
  } catch {
    return DEFAULT_REDUCED_MOTION;
  }
}

export function storeGlassOpacity(storage: AppearanceStorage, value: number): void {
  try {
    storage.setItem(GLASS_OPACITY_STORAGE_KEY, String(value));
  } catch {
    // Usable when storage blocked
  }
}

export function storeDensity(storage: AppearanceStorage, value: Density): void {
  try {
    storage.setItem(DENSITY_STORAGE_KEY, value);
  } catch {
    // Usable when storage blocked
  }
}

export function storeReducedMotion(storage: AppearanceStorage, value: boolean): void {
  try {
    storage.setItem(REDUCED_MOTION_STORAGE_KEY, String(value));
  } catch {
    // Usable when storage blocked
  }
}

export function applyGlassOpacity(root: AppearanceRoot, opacity: number): void {
  root.dataset.glassOpacity = String(opacity);
  // Keep true-black workspace: only transient glass tokens change.
  // Solidity matches the mock prototype: 0.72 + opacity/140 clamped 0.82-0.96
  const solidity = Math.max(0.82, Math.min(0.96, 0.72 + opacity / 140));
  // Respect the resolved theme for glass color; default to dark true-black.
  const resolved = (root.dataset.theme as string | undefined) ?? "dark";
  const isLight = resolved === "light";
  const glass = isLight ? `rgba(255, 255, 255, ${solidity})` : `rgba(10, 10, 11, ${solidity})`;
  try {
    root.style.setProperty("--glass", glass);
    root.style.setProperty("--popover", glass);
  } catch {
    // Style may be unavailable in some test harnesses
  }
  try {
    root.style.setProperty("--glass-opacity", `${opacity}%`);
  } catch {
    // ignore
  }
}

export function applyDensity(root: AppearanceRoot, density: Density): void {
  root.dataset.density = density;
}

export function applyReducedMotion(root: AppearanceRoot, reduced: boolean): void {
  root.dataset.reducedMotion = String(reduced);
  if (reduced) {
    root.classList.add("reduce-motion");
    root.classList.add("reduced-motion");
  } else {
    root.classList.remove("reduce-motion");
    root.classList.remove("reduced-motion");
  }
}

export function applyAppearance(
  root: AppearanceRoot,
  prefs: { glassOpacity: number; density: Density; reducedMotion: boolean },
): void {
  applyGlassOpacity(root, prefs.glassOpacity);
  applyDensity(root, prefs.density);
  applyReducedMotion(root, prefs.reducedMotion);
}

export function initializeAppearance(browserWindow: Window = window): {
  glassOpacity: number;
  density: Density;
  reducedMotion: boolean;
} {
  let glassOpacity: number;
  let density: Density;
  let reducedMotion: boolean;
  try {
    glassOpacity = readGlassOpacity(browserWindow.localStorage);
  } catch {
    glassOpacity = DEFAULT_GLASS_OPACITY;
  }
  try {
    density = readDensity(browserWindow.localStorage);
  } catch {
    density = DEFAULT_DENSITY;
  }
  try {
    reducedMotion = readReducedMotion(browserWindow.localStorage);
  } catch {
    reducedMotion = DEFAULT_REDUCED_MOTION;
  }
  try {
    applyAppearance(browserWindow.document.documentElement as unknown as AppearanceRoot, {
      density,
      glassOpacity,
      reducedMotion,
    });
  } catch {
    // document may be unavailable
  }
  return { density, glassOpacity, reducedMotion };
}

export function listenForGlassOpacityStorage(
  events: AppearanceStorageEvents,
  onChange: (value: number) => void,
): () => void {
  const listener = (event: StorageEvent) => {
    if (event.key !== GLASS_OPACITY_STORAGE_KEY && event.key !== null) return;
    if (event.newValue === null) {
      onChange(DEFAULT_GLASS_OPACITY);
      return;
    }
    const parsed = parseGlassOpacity(event.newValue);
    if (parsed !== null) onChange(parsed);
  };
  events.addEventListener("storage", listener);
  return () => events.removeEventListener("storage", listener);
}

export function listenForDensityStorage(
  events: AppearanceStorageEvents,
  onChange: (value: Density) => void,
): () => void {
  const listener = (event: StorageEvent) => {
    if (event.key !== DENSITY_STORAGE_KEY && event.key !== null) return;
    if (event.newValue === null) {
      onChange(DEFAULT_DENSITY);
      return;
    }
    const parsed = parseDensity(event.newValue);
    if (parsed !== null) onChange(parsed);
  };
  events.addEventListener("storage", listener);
  return () => events.removeEventListener("storage", listener);
}

export function listenForReducedMotionStorage(
  events: AppearanceStorageEvents,
  onChange: (value: boolean) => void,
): () => void {
  const listener = (event: StorageEvent) => {
    if (event.key !== REDUCED_MOTION_STORAGE_KEY && event.key !== null) return;
    if (event.newValue === null) {
      onChange(DEFAULT_REDUCED_MOTION);
      return;
    }
    const parsed = parseReducedMotion(event.newValue);
    if (parsed !== null) onChange(parsed);
  };
  events.addEventListener("storage", listener);
  return () => events.removeEventListener("storage", listener);
}

export function clampGlassOpacity(value: number): number {
  return Math.min(GLASS_OPACITY_MAX, Math.max(GLASS_OPACITY_MIN, Math.round(value)));
}

export function glassSliderProgress(opacity: number): number {
  const clamped = clampGlassOpacity(opacity);
  return ((clamped - GLASS_OPACITY_MIN) / (GLASS_OPACITY_MAX - GLASS_OPACITY_MIN)) * 100;
}

export function installAppearanceSync(browserWindow: Window = window): () => void {
  const root = browserWindow.document.documentElement as unknown as AppearanceRoot;

  const getPrefs = (): { glassOpacity: number; density: Density; reducedMotion: boolean } => {
    try {
      const storage = browserWindow.localStorage;
      return {
        glassOpacity: readGlassOpacity(storage),
        density: readDensity(storage),
        reducedMotion: readReducedMotion(storage),
      };
    } catch {
      return {
        glassOpacity: DEFAULT_GLASS_OPACITY,
        density: DEFAULT_DENSITY,
        reducedMotion: DEFAULT_REDUCED_MOTION,
      };
    }
  };

  applyAppearance(root, getPrefs());

  const onStorage = (event: StorageEvent) => {
    if (event.key === null) {
      applyAppearance(root, getPrefs());
      return;
    }
    if (event.key === GLASS_OPACITY_STORAGE_KEY) {
      if (event.newValue === null) applyGlassOpacity(root, DEFAULT_GLASS_OPACITY);
      else {
        const parsed = parseGlassOpacity(event.newValue);
        if (parsed !== null) applyGlassOpacity(root, parsed);
      }
      return;
    }
    if (event.key === DENSITY_STORAGE_KEY) {
      if (event.newValue === null) applyDensity(root, DEFAULT_DENSITY);
      else {
        const parsed = parseDensity(event.newValue);
        if (parsed !== null) applyDensity(root, parsed);
      }
      return;
    }
    if (event.key === REDUCED_MOTION_STORAGE_KEY) {
      if (event.newValue === null) applyReducedMotion(root, DEFAULT_REDUCED_MOTION);
      else {
        const parsed = parseReducedMotion(event.newValue);
        if (parsed !== null) applyReducedMotion(root, parsed);
      }
    }
  };

  browserWindow.addEventListener("storage", onStorage);

  const ObserverCtor: typeof MutationObserver =
    (browserWindow as unknown as { MutationObserver?: typeof MutationObserver }).MutationObserver ??
    MutationObserver;
  const observer = new ObserverCtor(() => {
    const current = parseGlassOpacity(root.dataset.glassOpacity) ?? getPrefs().glassOpacity;
    applyGlassOpacity(root, current);
  });

  try {
    observer.observe(browserWindow.document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-theme-family"],
    });
  } catch {
    // observe may fail in some harnesses; observer still disconnect-safe
  }

  return () => {
    browserWindow.removeEventListener("storage", onStorage);
    observer.disconnect();
  };
}

// Hook for page components
export function useAppearancePrefs() {
  const [glassOpacity, setGlassOpacityState] = useState<number>(() => {
    try {
      return readGlassOpacity(window.localStorage);
    } catch {
      return DEFAULT_GLASS_OPACITY;
    }
  });
  const [density, setDensityState] = useState<Density>(() => {
    try {
      return readDensity(window.localStorage);
    } catch {
      return DEFAULT_DENSITY;
    }
  });
  const [reducedMotion, setReducedMotionState] = useState<boolean>(() => {
    try {
      return readReducedMotion(window.localStorage);
    } catch {
      return DEFAULT_REDUCED_MOTION;
    }
  });

  useEffect(() => {
    applyAppearance(document.documentElement as unknown as AppearanceRoot, {
      density,
      glassOpacity,
      reducedMotion,
    });
  }, [density, glassOpacity, reducedMotion]);

  useEffect(() => {
    const offGlass = listenForGlassOpacityStorage(window, setGlassOpacityState);
    const offDensity = listenForDensityStorage(window, setDensityState);
    const offMotion = listenForReducedMotionStorage(window, setReducedMotionState);
    return () => {
      offGlass();
      offDensity();
      offMotion();
    };
  }, []);

  // Also re-apply glass when theme changes, so light/dark glass color stays correct
  useEffect(() => {
    const root = document.documentElement as unknown as AppearanceRoot;
    const observer = new MutationObserver(() => {
      applyGlassOpacity(root, glassOpacity);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, [glassOpacity]);

  const setGlassOpacity = useCallback((value: number) => {
    const clamped = Math.min(
      GLASS_OPACITY_MAX,
      Math.max(GLASS_OPACITY_MIN, Math.round(value)),
    );
    storeGlassOpacity(window.localStorage, clamped);
    setGlassOpacityState(clamped);
    applyGlassOpacity(document.documentElement as unknown as AppearanceRoot, clamped);
  }, []);

  const setDensity = useCallback((value: Density) => {
    const parsed = parseDensity(value) ?? DEFAULT_DENSITY;
    storeDensity(window.localStorage, parsed);
    setDensityState(parsed);
    applyDensity(document.documentElement as unknown as AppearanceRoot, parsed);
  }, []);

  const setReducedMotion = useCallback((value: boolean) => {
    storeReducedMotion(window.localStorage, value);
    setReducedMotionState(value);
    applyReducedMotion(document.documentElement as unknown as AppearanceRoot, value);
  }, []);

  return {
    density,
    glassOpacity,
    reducedMotion,
    setDensity,
    setGlassOpacity,
    setReducedMotion,
  };
}
