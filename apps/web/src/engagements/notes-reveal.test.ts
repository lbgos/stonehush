import { describe, expect, it } from "vitest";

import { passageScrollTop } from "./notes-reveal.js";

describe("measured note passage scrolling", () => {
  it("reveals a passage far down a wrapped source line", () => {
    const top = 5220;
    const bottom = 5240;
    const viewportHeight = 240;
    const scrollTop = passageScrollTop({ top, bottom, viewportHeight, scrollTop: 2700 });
    expect(scrollTop).toBe(5110);
    expect(top).toBeGreaterThanOrEqual(scrollTop);
    expect(bottom).toBeLessThanOrEqual(scrollTop + viewportHeight);
  });

  it("keeps a fully visible passage and reveals one above the viewport", () => {
    expect(passageScrollTop({ top: 450, bottom: 470, viewportHeight: 240, scrollTop: 400 })).toBe(400);
    expect(passageScrollTop({ top: 200, bottom: 240, viewportHeight: 240, scrollTop: 400 })).toBe(100);
  });

  it("keeps the first line visible when a selection is taller than the viewport", () => {
    expect(passageScrollTop({ top: 400, bottom: 800, viewportHeight: 240, scrollTop: 0 })).toBe(400);
    expect(passageScrollTop({ top: 8, bottom: 28, viewportHeight: 240, scrollTop: 500 })).toBe(0);
  });
});
