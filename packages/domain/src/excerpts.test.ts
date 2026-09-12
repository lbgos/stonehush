import { describe, expect, it } from "vitest";

import {
  buildFindingPrefillBody,
  byteOffsetOfCharOffset,
  deriveAttachmentName,
  findTextMatches,
  formatExcerptSourceLabel,
  isCropRectValid,
  maskExcerptText,
  selectionBytesFromText,
  validateExcerptRange,
  windowSnippetFromChars,
} from "./excerpts.js";

const DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("excerpt ranges", () => {
  it("accepts an in-bounds range and rejects invented offsets", () => {
    expect(validateExcerptRange(1024, 100, 256)).toEqual({ ok: true });
    expect(validateExcerptRange(1024, 900, 256)).toEqual({
      ok: false,
      code: "range_rejected",
    });
    expect(validateExcerptRange(1024, 0, 0)).toEqual({
      ok: false,
      code: "range_rejected",
    });
    expect(validateExcerptRange(1024, 0, 8_193)).toEqual({
      ok: false,
      code: "range_rejected",
    });
    expect(validateExcerptRange(1024, -1, 10)).toEqual({
      ok: false,
      code: "range_rejected",
    });
  });

  it("maps char selections to UTF-8 byte ranges without splitting chars", () => {
    const text = "héllo wörld";
    const mapped = selectionBytesFromText(text, 0, 5);
    expect(mapped).toEqual({
      ok: true,
      byteOffset: 0,
      byteLength: new TextEncoder().encode("héllo").length,
    });
    expect(selectionBytesFromText(text, 3, 3)).toEqual({
      ok: false,
      code: "range_rejected",
    });
    expect(selectionBytesFromText(text, 5, 2)).toEqual({
      ok: false,
      code: "range_rejected",
    });
  });

  it("reports byte offsets for scan matches", () => {
    expect(byteOffsetOfCharOffset("héllo", 1)).toBe(
      new TextEncoder().encode("h").length,
    );
  });
});

describe("secret masking for excerpts", () => {
  it("masks recognized secrets and counts redactions", () => {
    const masked = maskExcerptText("login ok\nflag{secret-value}\npassword=hunter2\n");
    expect(masked.text).not.toContain("flag{secret-value}");
    expect(masked.text).not.toContain("hunter2");
    expect(masked.redactions).toBeGreaterThan(0);
  });

  it("masks bearer and sk material in snippets", () => {
    const masked = maskExcerptText("Authorization: Bearer abcdefghijklmnop\nkey sk-abcdefgh12345678\n");
    expect(masked.text).not.toContain("abcdefghijklmnop");
    expect(masked.text).not.toContain("sk-abcdefgh12345678");
  });

  it("leaves ordinary output untouched", () => {
    expect(maskExcerptText("80/tcp open http").text).toBe("80/tcp open http");
  });
});

describe("search windowing", () => {
  it("finds case-insensitive matches with char offsets", () => {
    const matches = findTextMatches("Login LOGIN login", "login", 10);
    expect(matches).toHaveLength(3);
    expect(matches[0]).toEqual({ charOffset: 0, charLength: 5 });
    expect(findTextMatches("nothing here", "login", 10)).toEqual([]);
    expect(findTextMatches("login here", "", 10)).toEqual([]);
  });

  it("keeps original offsets when case folding expands characters", () => {
    // U+0130 lowercases to two code points; a lowered-string index would shift
    // every later match into other evidence. The engine reports original
    // coordinates, so the ASCII match after it stays exact.
    const haystack = "İ login";
    const matches = findTextMatches(haystack, "login", 10);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.charOffset).toBe(Array.from("İ ").length);
    expect(matches[0]?.charLength).toBe(5);
  });

  it("rejects selections that cannot be mapped exactly after malformed UTF-8", () => {
    expect(selectionBytesFromText("�foo", 1, 4)).toEqual({
      ok: false,
      code: "range_rejected",
    });
    expect(selectionBytesFromText("abc � def", 0, 3).ok).toBe(true);
  });

  it("windows snippets without rendering the whole file", () => {
    const text = `${"a".repeat(500)}login${"b".repeat(500)}`;
    const [match] = findTextMatches(text, "login", 1);
    if (match === undefined) throw new Error("expected a match");
    const window = windowSnippetFromChars(text, match.charOffset, match.charLength, 10);
    expect(window.snippet).toContain("login");
    expect(window.snippet.length).toBeLessThan(text.length);
    expect(window.truncatedBefore).toBe(true);
    expect(window.truncatedAfter).toBe(true);
  });
});

describe("attachment naming and crops", () => {
  it("names files by what they prove", () => {
    expect(deriveAttachmentName("Admin login as sa!", "evidence-1")).toBe("admin-login-as-sa");
    expect(deriveAttachmentName("!!!", "evidence-1")).toBe("evidence-1");
    expect(deriveAttachmentName("", "")).toBe("evidence-image");
  });

  it("validates crop rects while keeping the original intact", () => {
    expect(isCropRectValid({ x: 4, y: 4, width: 100, height: 60 })).toBe(true);
    expect(isCropRectValid({ x: 0, y: 0, width: 0, height: 60 })).toBe(false);
    expect(isCropRectValid({ x: -1, y: 0, width: 10, height: 10 })).toBe(false);
  });
});

describe("finding prefill", () => {
  it("inherits target note, stable source, and masked excerpt", () => {
    const body = buildFindingPrefillBody({
      runId: "run-abcdef123456",
      stream: "stdout",
      byteOffset: 100,
      byteLength: 256,
      artifactId: "artifact-stdout",
      artifactDigest: DIGEST,
      content: "masked login line",
      targetNote: "web on 10.0.0.5",
    });
    expect(body).toContain("Source: run run-abcd");
    expect(body).toContain("@100+256");
    expect(body).toContain("Target (operator note): web on 10.0.0.5");
    expect(body).toContain("masked login line");
    expect(formatExcerptSourceLabel({
      runId: "run-1",
      stream: "stderr",
      byteOffset: 0,
      byteLength: 16,
      artifactId: "artifact-stderr",
      artifactDigest: DIGEST,
    })).toContain("artifact-stderr");
  });

  it("labels a missing target note truthfully", () => {
    const body = buildFindingPrefillBody({
      runId: "run-1",
      stream: "stdout",
      byteOffset: 0,
      byteLength: 16,
      artifactId: "artifact-stdout",
      artifactDigest: DIGEST,
      content: "line",
      targetNote: null,
    });
    expect(body).toContain("Target: operator note unavailable");
  });
});
