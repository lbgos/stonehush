// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_DENSITY,
  DEFAULT_GLASS_OPACITY,
  DEFAULT_REDUCED_MOTION,
  applyGlassOpacity,
  clampGlassOpacity,
  glassSliderProgress,
  installAppearanceSync,
  parseDensity,
  parseGlassOpacity,
  parseReducedMotion,
  readGlassOpacity,
} from "./appearance.js";

describe("parseGlassOpacity bounds 5..40", () => {
  it.each([
    ["5", 5],
    ["26", 26],
    ["40", 40],
  ])("accepts %s", (input, expected) => {
    expect(parseGlassOpacity(input)).toBe(expected);
  });

  it.each(["4", "0", "-1", "41", "55", "100"])("rejects %s", (value) => {
    expect(parseGlassOpacity(value)).toBeNull();
  });

  it.each(["", "  ", "26.5", "oops"])("rejects malformed %s", (value) => {
    expect(parseGlassOpacity(value)).toBeNull();
  });

  it.each([null, undefined, 26])("rejects non-string %s", (value) => {
    expect(parseGlassOpacity(value as unknown as string)).toBeNull();
  });

  it.each([
    ["compact", "compact"],
    ["regular", "regular"],
  ] as const)("parses density %s", (input, expected) => {
    expect(parseDensity(input)).toBe(expected);
  });

  it.each(["huge", ""])("rejects density %s", (value) => {
    expect(parseDensity(value)).toBeNull();
  });

  it.each([
    ["true", true],
    ["false", false],
  ] as const)("parses reducedMotion %s", (input, expected) => {
    expect(parseReducedMotion(input)).toBe(expected);
  });

  it("rejects invalid reducedMotion", () => {
    expect(parseReducedMotion("maybe")).toBeNull();
  });

  it("falls back to default for out-of-range persisted values", () => {
    type Storage = Parameters<typeof readGlassOpacity>[0];
    const mk = (value: string): Storage => ({
      getItem: (key) => (key === "stonehush.glassOpacity" ? value : null),
      setItem: () => {},
    });
    expect(readGlassOpacity(mk("4"))).toBe(DEFAULT_GLASS_OPACITY);
    expect(readGlassOpacity(mk("41"))).toBe(DEFAULT_GLASS_OPACITY);
    expect(readGlassOpacity(mk("100"))).toBe(DEFAULT_GLASS_OPACITY);
  });
});

describe("clamp and progress", () => {
  it("clamps 5..40 and maps to 0..100", () => {
    expect(clampGlassOpacity(0)).toBe(5);
    expect(clampGlassOpacity(40)).toBe(40);
    expect(clampGlassOpacity(100)).toBe(40);
    expect(glassSliderProgress(5)).toBeCloseTo(0);
    expect(glassSliderProgress(26)).toBeCloseTo(60);
    expect(glassSliderProgress(40)).toBeCloseTo(100);
  });
});

describe("density CSS contract", () => {
  it("exposes reusable .density-row token with 44px floor", () => {
    const css = readFileSync(path.join(process.cwd(), "src/styles.css"), "utf8");
    const page = readFileSync(path.join(process.cwd(), "src/settings/page.tsx"), "utf8");
    const plugins = readFileSync(path.join(process.cwd(), "src/routes/plugins.tsx"), "utf8");
    expect(css).toContain("--density-row-min");
    expect(css).toContain(".density-row");
    expect(css).toContain("var(--density-row-min)");
    expect(css).toContain('[data-density="regular"] .density-row');
    expect(css).toContain("padding-block: 18px");
    expect(css).toContain("max(44px");
    expect(page).toContain("density-row");
    expect(plugins).toContain("density-row");
  });
});

describe("installAppearanceSync", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.dataset.glassOpacity = "";
    document.documentElement.dataset.density = "";
    document.documentElement.dataset.reducedMotion = "";
    document.documentElement.dataset.theme = "dark";
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.dataset.glassOpacity = "";
    document.documentElement.dataset.density = "";
    document.documentElement.dataset.reducedMotion = "";
    vi.restoreAllMocks();
  });

  it("syncs matching storage, theme mutation and cleanup", async () => {
    type GlassRoot = Parameters<typeof applyGlassOpacity>[0];
    const root = document.documentElement as unknown as GlassRoot;
    window.localStorage.setItem("stonehush.glassOpacity", "26");
    document.documentElement.dataset.glassOpacity = "26";
    window.localStorage.setItem("stonehush.density", "compact");
    document.documentElement.dataset.density = "compact";
    applyGlassOpacity(root, 26);
    const darkGlass = document.documentElement.style.getPropertyValue("--glass");
    const cleanup = installAppearanceSync(window);
    window.dispatchEvent(new StorageEvent("storage", { key: "stonehush.glassOpacity", newValue: "30" }));
    expect(document.documentElement.dataset.glassOpacity).toBe("30");
    window.dispatchEvent(new StorageEvent("storage", { key: "stonehush.glassOpacity", newValue: "4" }));
    expect(document.documentElement.dataset.glassOpacity).toBe("30");
    window.dispatchEvent(new StorageEvent("storage", { key: "stonehush.density", newValue: "regular" }));
    expect(document.documentElement.dataset.density).toBe("regular");
    window.dispatchEvent(new StorageEvent("storage", { key: "stonehush.reducedMotion", newValue: "true" }));
    expect(document.documentElement.dataset.reducedMotion).toBe("true");
    document.documentElement.dataset.theme = "light";
    await new Promise((r) => setTimeout(r, 0));
    expect(document.documentElement.style.getPropertyValue("--glass")).not.toBe(darkGlass);
    window.localStorage.setItem("stonehush.glassOpacity", "30");
    window.localStorage.setItem("stonehush.density", "regular");
    window.dispatchEvent(new StorageEvent("storage", { key: null, newValue: null }));
    expect(document.documentElement.dataset.glassOpacity).toBe("30");
    expect(document.documentElement.dataset.density).toBe("regular");
    cleanup();
    window.dispatchEvent(new StorageEvent("storage", { key: "stonehush.glassOpacity", newValue: "32" }));
    expect(document.documentElement.dataset.glassOpacity).toBe("30");
  });

  it("stays operable when localStorage getter throws", () => {
    const el = document.createElement("div");
    el.dataset.theme = "dark";
    const pending = new Map<string, Set<(e: Event) => void>>();
    const fakeWindow = {
      document: { documentElement: el } as unknown as Document,
      addEventListener: (type: string, listener: (e: Event) => void) => {
        const set = pending.get(type) ?? new Set<(e: Event) => void>();
        set.add(listener);
        pending.set(type, set);
      },
      removeEventListener: (type: string, listener: (e: Event) => void) => {
        pending.get(type)?.delete(listener);
      },
      dispatchEvent: (event: Event) => {
        pending.get(event.type)?.forEach((cb) => cb(event));
        return true;
      },
      get localStorage(): Storage {
        throw new DOMException("Blocked", "SecurityError");
      },
      MutationObserver: window.MutationObserver,
    } as unknown as Window;

    let cleanup: (() => void) | undefined;
    expect(() => {
      cleanup = installAppearanceSync(fakeWindow);
    }).not.toThrow();
    expect(typeof cleanup).toBe("function");
    expect(el.dataset.glassOpacity).toBe(String(DEFAULT_GLASS_OPACITY));
    expect(el.dataset.density).toBe(DEFAULT_DENSITY);
    expect(el.dataset.reducedMotion).toBe(String(DEFAULT_REDUCED_MOTION));

    const direct = new StorageEvent("storage", {
      key: "stonehush.glassOpacity",
      newValue: "30",
    });
    expect(() => {
      fakeWindow.dispatchEvent(direct);
    }).not.toThrow();
    expect(el.dataset.glassOpacity).toBe("30");

    const bulk = new StorageEvent("storage", { key: null, newValue: null });
    expect(() => {
      fakeWindow.dispatchEvent(bulk);
    }).not.toThrow();
    expect(el.dataset.glassOpacity).toBe(String(DEFAULT_GLASS_OPACITY));

    expect(() => cleanup?.()).not.toThrow();
  });
});
