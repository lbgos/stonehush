import { describe, expect, it } from "vitest";

import {
  buildFindingPrefillBody,
  byteOffsetOfCharOffset,
  deriveAttachmentName,
  findTextMatches,
  formatExcerptSourceLabel,
  isCropRectValid,
  isSecretContinuationChar,
  maskExcerptText,
  projectMaskedSelection,
  selectionBytesFromText,
  selectionHasDanglingKeyEnd,
  selectionLooksLikeHiddenAssignmentValue,
  selectionMayHideUrlValue,
  selectionStartsMidToken,
  validateExcerptRange,
  windowSnippetFromChars,
} from "./excerpts.js";
import {
  containsPrivateKeyBeginMarker,
  containsPrivateKeyEndMarker,
  findAdvisorSecretSpans,
  findUnterminatedPrivateKeyStarts,
} from "./advisor-redact.js";

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

  it("locates secret spans for context projection", () => {
    const text = "login ok\nflag{syntheticsecret}\npassword=hunter2\n";
    const spans = findAdvisorSecretSpans(text);
    expect(spans.length).toBeGreaterThanOrEqual(2);
    for (const span of spans) {
      expect(span.end).toBeGreaterThan(span.start);
    }
    expect(findAdvisorSecretSpans("80/tcp open http")).toEqual([]);
  });

  it("masks inner flag selections using surrounding context", () => {
    const expanded = "login ok\nflag{syntheticsecret}\n";
    const start = expanded.indexOf("syntheticsecret");
    const charStart = Array.from(expanded.slice(0, start)).length;
    const projected = projectMaskedSelection(expanded, charStart, Array.from("syntheticsecret").length);
    expect(projected.overlapped).toBe(true);
    expect(projected.text).toBe("[redacted]");
    expect(projected.redactions).toBe(1);
    // Narrow masking alone would leak the inner value.
    expect(maskExcerptText("syntheticsecret").text).toBe("syntheticsecret");
  });

  it("keeps ordinary text around a partial secret overlap", () => {
    const expanded = "prefix flag{abc} suffix";
    const start = expanded.indexOf("prefix");
    const projected = projectMaskedSelection(
      expanded,
      Array.from(expanded.slice(0, start)).length,
      Array.from("prefix flag{a").length,
    );
    expect(projected.overlapped).toBe(true);
    expect(projected.text).toBe("prefix [redacted]");
    expect(projected.text).not.toContain("flag{a");
  });

  it("leaves non-overlapping selections byte-identical to narrow masking", () => {
    const expanded = "flag{abc}\nordinary line here\npassword=hunter2\n";
    const start = expanded.indexOf("ordinary");
    const len = Array.from("ordinary line here").length;
    const charStart = Array.from(expanded.slice(0, start)).length;
    const projected = projectMaskedSelection(expanded, charStart, len);
    expect(projected.overlapped).toBe(false);
    expect(projected.text).toBe(maskExcerptText("ordinary line here").text);
  });

  it.each([
    ["Bearer abcdefgh", "ijklmnop", true],
    ["login ok\n", "flag{abc}", false],
    ["", "abc", false],
    ["abc", "", false],
    ["target: ", "10.0.0.5", false],
  ])("detects mid-token continuation across a cut context: %j %j", (prefix, requested, expected) => {
    expect(selectionStartsMidToken(prefix, requested)).toBe(expected);
  });

  it.each([
    // Value side with the `=` inside the selection.
    ["   ", "=hunter2"],
    ["password", "=hunter2"],
    // Value starting immediately after a visible `=`.
    ["key=", "hunter2"],
    // JSON colon assignments: separator-led, adjacent, and quoted.
    ['"key"', ': "value"'],
    ['"key":', '"value"'],
    ['"key": ', '"value"'],
    ['"key":\n  ', "'value'"],
    ["key = ", '"v"'],
  ])("spots assignment values whose key may sit beyond a cut lookback: %j %j", (prefix, requested) => {
    expect(selectionLooksLikeHiddenAssignmentValue(prefix, requested)).toBe(true);
  });

  it.each([
    // Ordinary shapes still pass: bare values after a spaced separator,
    // quoted strings after commas, plain words, timestamps by shape.
    ["key = ", "hunter2"],
    ["count = ", "42"],
    ['", "', '"b"'],
    ["login ok\n", "flag{abc}"],
    ["target: ", "10.0.0.5"],
  ])("passes ordinary shapes without hidden assignment keys: %j %j", (prefix, requested) => {
    expect(selectionLooksLikeHiddenAssignmentValue(prefix, requested)).toBe(false);
  });

  it.each([
    // An `@` inside the selection, or a URL-structural delimiter right
    // before it: a hidden `https://user:` prefix leaves these traces.
    ["", "a@b"],
    ["x", "a@b"],
    ["foo;", "bar"],
    ["a,", "b"],
    ["100%", "20"],
    ["a?", "b"],
    ["a#", "b"],
    ["a@", "b"],
    // Delimiter-leading selections: the trigger sits before the span, so
    // the prefix check alone would miss them.
    ["AAA", ";SECRET"],
    ["AAA", ",SECRET"],
    ["AAA", ";S"],
  ])("spots URL-shaped edges whose scheme may sit beyond a cut lookback: %j %j", (prefix, requested) => {
    expect(selectionMayHideUrlValue(prefix, requested)).toBe(true);
  });

  it.each([
    ["abc", "def"],
    ["key = ", "v"],
    ["", "plain"],
    ["a: ", "b"],
  ])("leaves ordinary shapes without URL structure quiet: %j %j", (prefix, requested) => {
    expect(selectionMayHideUrlValue(prefix, requested)).toBe(false);
  });

  it("treats percent as a token continuation but keeps colons as boundaries", () => {
    // Percent-encoded secret bytes stay one token across a cut lookback.
    expect(selectionStartsMidToken("abc%", "20def")).toBe(true);
    expect(isSecretContinuationChar("%")).toBe(true);
    // Colons stay boundaries so host:port and timestamp keeps keep working.
    expect(selectionStartsMidToken("host:", "8080")).toBe(false);
    expect(selectionStartsMidToken("12:", "30")).toBe(false);
    expect(isSecretContinuationChar(":")).toBe(false);
  });

  it("rejects value shapes with a whitespace-only window behind them", () => {
    // Full bounded lookback with no key candidate: the key may sit beyond
    // the cut no matter which side the separator fell on.
    expect(selectionLooksLikeHiddenAssignmentValue(" ".repeat(8192), "hunter2")).toBe(true);
    expect(selectionLooksLikeHiddenAssignmentValue(" ".repeat(8191) + "= ", "hunter2")).toBe(true);
    expect(selectionLooksLikeHiddenAssignmentValue(" ".repeat(8192), '"v"')).toBe(true);
    expect(selectionLooksLikeHiddenAssignmentValue("\uFFFD".repeat(8192), "hunter2")).toBe(true);
    // Any visible key candidate disables the rule.
    expect(selectionLooksLikeHiddenAssignmentValue(`${" ".repeat(8180)}count = `, "42")).toBe(false);
    expect(selectionLooksLikeHiddenAssignmentValue(`${" ".repeat(8180)}"a", `, '"b"')).toBe(false);
    expect(selectionLooksLikeHiddenAssignmentValue("x".repeat(8192), "y")).toBe(false);
  });

  it("locates unterminated private-key blocks", () => {
    const complete =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n";
    expect(findUnterminatedPrivateKeyStarts(complete)).toEqual([]);
    const dangling = "-----BEGIN RSA PRIVATE KEY-----\nMIIB\ntrailing\n";
    expect(findUnterminatedPrivateKeyStarts(dangling)).toEqual([0]);
    expect(findUnterminatedPrivateKeyStarts("ordinary output\n")).toEqual([]);
    const endOnly = "MIIB\n-----END RSA PRIVATE KEY-----\n";
    expect(findUnterminatedPrivateKeyStarts(endOnly)).toEqual([]);
    expect(containsPrivateKeyBeginMarker(dangling)).toBe(true);
    expect(containsPrivateKeyEndMarker(dangling)).toBe(false);
    expect(containsPrivateKeyEndMarker(endOnly)).toBe(true);
    expect(containsPrivateKeyBeginMarker(endOnly)).toBe(false);
  });

  it.each([
    ["MIIB\n-----END RSA PRIVATE KEY-----\n", true],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n", false],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIB\n", false],
    ["ordinary output\n", false],
  ])("spots key-block tails holding an END marker without its BEGIN: %j", (requested, expected) => {
    expect(selectionHasDanglingKeyEnd(requested)).toBe(expected);
  });

  it("masks key-block bodies past an unterminated BEGIN only when truncated", () => {
    const expanded = "-----BEGIN RSA PRIVATE KEY-----\nMIIBAA==\nmore\n";
    const bodyStart = Array.from("-----BEGIN RSA PRIVATE KEY-----\n").length;
    const bodyLength = Array.from("MIIBAA==\n").length;
    // Window cut on the right: the block may continue past it.
    const masked = projectMaskedSelection(expanded, bodyStart, bodyLength, true);
    expect(masked.overlapped).toBe(true);
    expect(masked.text).not.toContain("MIIBAA");
    // Fully visible dangling marker: the policy misses it too, so the
    // projection must not mask ordinary trailing text.
    const plain = projectMaskedSelection(expanded, bodyStart, bodyLength, false);
    expect(plain.overlapped).toBe(false);
    expect(plain.text).toBe("MIIBAA==\n");
  });

  it("masks inner credential and bearer values from context", () => {
    const credential = "auth password=hunter2 done";
    const valueStart = Array.from(credential.slice(0, credential.indexOf("hunter2"))).length;
    const projected = projectMaskedSelection(
      credential,
      valueStart,
      Array.from("hunter2").length,
    );
    expect(projected.overlapped).toBe(true);
    expect(projected.text).not.toContain("hunter2");

    const bearer = "Authorization: Bearer abcdefghijklmnop end";
    const tokenStart = Array.from(bearer.slice(0, bearer.indexOf("abcdefgh"))).length;
    const tokenProjected = projectMaskedSelection(
      bearer,
      tokenStart,
      Array.from("abcdefghijklmnop").length,
    );
    expect(tokenProjected.overlapped).toBe(true);
    expect(tokenProjected.text).not.toContain("abcdefghijklmnop");
  });

  it("masks a selection past a capped credential value instead of persisting it raw", () => {
    // The credential pattern caps bare values at 256 chars. A slice of a
    // 500-char value sits past the span, so without span extension the
    // projection would see no overlap and narrow masking alone would leak
    // the slice verbatim.
    const value = "x".repeat(500);
    const expanded = `password=${value}\n`;
    const start = Array.from("password=").length + 300;
    const projected = projectMaskedSelection(expanded, start, 100);
    expect(projected.overlapped).toBe(true);
    expect(projected.text).toBe("[redacted]");
    expect(projected.text).not.toContain("xxxxxxxxxx");
    expect(maskExcerptText("x".repeat(100)).text).toBe("x".repeat(100));
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

  it("counts code points across astral matches and gaps", () => {
    const text = "\u{1f9ed}a\u{1f600}\u{1f9ed}a\u{1f600}\u{1f9ed}a";
    expect(findTextMatches(text, "\u{1f9ed}a", 10)).toEqual([
      { charOffset: 0, charLength: 2 },
      { charOffset: 3, charLength: 2 },
      { charOffset: 6, charLength: 2 },
    ]);
    expect(findTextMatches("\u{1f600}\u{1f600}\u{1f600}", "\u{1f600}", 2)).toEqual([
      { charOffset: 0, charLength: 1 },
      { charOffset: 1, charLength: 1 },
    ]);
    expect(selectionBytesFromText(text, 3, 5)).toEqual({
      ok: true, byteOffset: 9, byteLength: 5,
    });
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

  it.each([
    [{ x: 4, y: 4, width: 100, height: 60 }, true],
    [{ x: 0, y: 0, width: 0, height: 60 }, false],
    [{ x: -1, y: 0, width: 10, height: 10 }, false],
  ])("validates crop rects while keeping the original intact: %j", (rect, expected) => {
    expect(isCropRectValid(rect)).toBe(expected);
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
