import { describe, expect, it } from "vitest";

import {
  SECRET_DISPLAY_MASK,
  SECRET_STORAGE_COPY,
  proofHintForValue,
} from "./secret-redact.js";

describe("secret redaction util", () => {
  it("builds length-only masked hints with no value characters", () => {
    const hint = proofHintForValue("flag{synthetic-proof-0001}");
    expect(hint).toBe("26 bytes");
    expect(hint).not.toContain("flag");
    expect(hint).not.toContain("01");
    expect(hint.length).toBeLessThanOrEqual(64);
  });

  it("keeps the display mask constant and documents that masking is not encryption", () => {
    expect(SECRET_DISPLAY_MASK).toBe("[masked]");
    expect(SECRET_STORAGE_COPY).toContain("never plaintext");
    expect(SECRET_STORAGE_COPY).toMatch(/not encryption/i);
  });
});
