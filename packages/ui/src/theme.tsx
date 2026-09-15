import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export const THEME_STORAGE_KEY = "stonehush.theme";
export const THEME_FAMILY_STORAGE_KEY = "stonehush.themeFamily";
export const THEME_MEDIA_QUERY = "(prefers-color-scheme: dark)";

export const THEME_FAMILIES = [
  "smoked",
  "void",
  "instrument",
  "grove",
  "ember",
  "iris",
] as const;

export type ThemePreference = "light" | "dark" | "system";
export type ThemeFamily = (typeof THEME_FAMILIES)[number];
export type ResolvedTheme = "light" | "dark";

export const DEFAULT_THEME_FAMILY: ThemeFamily = "smoked";

interface ThemeContextValue {
  family: ThemeFamily;
  preference: ThemePreference;
  setAppearance: (next: { family?: ThemeFamily; preference?: ThemePreference }) => void;
  setFamily: (family: ThemeFamily) => void;
  setPreference: (preference: ThemePreference) => void;
}

interface ThemeStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

interface ThemeRoot {
  classList: Pick<DOMTokenList, "add" | "remove">;
  dataset: DOMStringMap;
  style: Pick<CSSStyleDeclaration, "colorScheme">;
}

interface ThemeStorageEvents {
  addEventListener: (type: "storage", listener: (event: StorageEvent) => void) => void;
  removeEventListener: (type: "storage", listener: (event: StorageEvent) => void) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function parseThemePreference(value: unknown): ThemePreference | null {
  return value === "light" || value === "dark" || value === "system" ? value : null;
}

export function parseThemeFamily(value: unknown): ThemeFamily | null {
  return typeof value === "string" && THEME_FAMILIES.includes(value as ThemeFamily)
    ? (value as ThemeFamily)
    : null;
}

export function readThemePreference(storage: ThemeStorage): ThemePreference {
  try {
    return parseThemePreference(storage.getItem(THEME_STORAGE_KEY)) ?? "system";
  } catch {
    return "system";
  }
}

export function readThemeFamily(storage: ThemeStorage): ThemeFamily {
  try {
    return parseThemeFamily(storage.getItem(THEME_FAMILY_STORAGE_KEY)) ?? DEFAULT_THEME_FAMILY;
  } catch {
    return DEFAULT_THEME_FAMILY;
  }
}

export function storeThemePreference(storage: ThemeStorage, preference: ThemePreference): void {
  try {
    storage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Theme selection remains usable when storage is blocked or full.
  }
}

export function storeThemeFamily(storage: ThemeStorage, family: ThemeFamily): void {
  try {
    storage.setItem(THEME_FAMILY_STORAGE_KEY, family);
  } catch {
    // Theme family remains usable when storage is blocked or full.
  }
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  return preference === "system" ? (systemPrefersDark ? "dark" : "light") : preference;
}

export function applyTheme(
  root: ThemeRoot,
  preference: ThemePreference,
  systemPrefersDark: boolean,
  family: ThemeFamily = DEFAULT_THEME_FAMILY,
): ResolvedTheme {
  const resolved = resolveTheme(preference, systemPrefersDark);
  root.dataset.theme = resolved;
  root.dataset.themePreference = preference;
  root.dataset.themeFamily = family;
  root.style.colorScheme = resolved;
  return resolved;
}

export function listenForSystemTheme(
  mediaQuery: MediaQueryList,
  onChange: (prefersDark: boolean) => void,
): () => void {
  const listener = (event: MediaQueryListEvent) => onChange(event.matches);
  mediaQuery.addEventListener("change", listener);
  return () => mediaQuery.removeEventListener("change", listener);
}

export function listenForThemeStorage(
  events: ThemeStorageEvents,
  onPreference: (preference: ThemePreference) => void,
): () => void {
  const listener = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
    if (event.newValue === null) {
      onPreference("system");
      return;
    }
    const preference = parseThemePreference(event.newValue);
    if (preference) onPreference(preference);
  };
  events.addEventListener("storage", listener);
  return () => events.removeEventListener("storage", listener);
}

export function listenForThemeFamilyStorage(
  events: ThemeStorageEvents,
  onFamily: (family: ThemeFamily) => void,
): () => void {
  const listener = (event: StorageEvent) => {
    if (event.key !== THEME_FAMILY_STORAGE_KEY && event.key !== null) return;
    if (event.newValue === null) {
      onFamily(DEFAULT_THEME_FAMILY);
      return;
    }
    const family = parseThemeFamily(event.newValue);
    if (family) onFamily(family);
  };
  events.addEventListener("storage", listener);
  return () => events.removeEventListener("storage", listener);
}

export function suppressThemeTransitions(root: ThemeRoot, schedule: (callback: () => void) => number) {
  root.classList.add("theme-switching");
  return schedule(() => schedule(() => root.classList.remove("theme-switching")));
}

export function initializeTheme(browserWindow: Window = window): {
  family: ThemeFamily;
  preference: ThemePreference;
} {
  const preference = readThemePreference(browserWindow.localStorage);
  const family = readThemeFamily(browserWindow.localStorage);
  applyTheme(
    browserWindow.document.documentElement,
    preference,
    browserWindow.matchMedia(THEME_MEDIA_QUERY).matches,
    family,
  );
  return { family, preference };
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() =>
    readThemePreference(window.localStorage),
  );
  const [family, setFamilyState] = useState<ThemeFamily>(() =>
    readThemeFamily(window.localStorage),
  );
  const preferenceRef = useRef(preference);
  const familyRef = useRef(family);
  preferenceRef.current = preference;
  familyRef.current = family;

  const changeAppearance = useCallback(
    (
      next: { family?: ThemeFamily; preference?: ThemePreference },
      persist: { family?: boolean; preference?: boolean },
    ) => {
      const nextPreference = next.preference ?? preferenceRef.current;
      const nextFamily = next.family ?? familyRef.current;
      preferenceRef.current = nextPreference;
      familyRef.current = nextFamily;
      const root = document.documentElement;
      suppressThemeTransitions(root, window.requestAnimationFrame.bind(window));
      applyTheme(root, nextPreference, window.matchMedia(THEME_MEDIA_QUERY).matches, nextFamily);
      if (persist.preference && next.preference) {
        storeThemePreference(window.localStorage, next.preference);
      }
      if (persist.family && next.family) {
        storeThemeFamily(window.localStorage, next.family);
      }
      setPreferenceState(nextPreference);
      setFamilyState(nextFamily);
    },
    [],
  );

  useEffect(() => {
    const stopPreference = listenForThemeStorage(window, (nextPreference) =>
      changeAppearance({ preference: nextPreference }, {}),
    );
    const stopFamily = listenForThemeFamilyStorage(window, (nextFamily) =>
      changeAppearance({ family: nextFamily }, {}),
    );
    return () => {
      stopPreference();
      stopFamily();
    };
  }, [changeAppearance]);

  useEffect(() => {
    const mediaQuery = window.matchMedia(THEME_MEDIA_QUERY);
    applyTheme(document.documentElement, preference, mediaQuery.matches, family);
    if (preference !== "system") return;

    return listenForSystemTheme(mediaQuery, (prefersDark) => {
      suppressThemeTransitions(document.documentElement, window.requestAnimationFrame.bind(window));
      applyTheme(document.documentElement, "system", prefersDark, family);
    });
  }, [family, preference]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      family,
      preference,
      setAppearance(next) {
        changeAppearance(next, {
          family: next.family !== undefined,
          preference: next.preference !== undefined,
        });
      },
      setFamily(nextFamily) {
        changeAppearance({ family: nextFamily }, { family: true });
      },
      setPreference(nextPreference) {
        changeAppearance({ preference: nextPreference }, { preference: true });
      },
    }),
    [changeAppearance, family, preference],
  );

  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside ThemeProvider.");
  return context;
}
