import type { EngagementSearchResult } from "@stonehush/contracts";
import { findMatchOffset, searchCorpus } from "@stonehush/domain";
import { describe, expect, it } from "vitest";

import {
  codePointToUtf16Offset,
  highlightMatch,
  resolveFindingMatch,
  parseSearchInput,
  parseSearchTarget,
  passageLine,
  resolveNotePassage,
  type NotePassage,
} from "./search-destination.js";

const TITLE = "Engagement notes";

// Builds the note result exactly as the API does for the saved text at
// search time: first match over `${title}\n${markdown}`, code-point anchor.
function noteResult(markdown: string, query: string): EngagementSearchResult {
  const match = findMatchOffset(`${TITLE}\n${markdown}`, query);
  const titlePoints = Array.from(TITLE).length;
  const offset = match === null || match.index <= titlePoints ? 0 : match.index - titlePoints - 1;
  const { results } = searchCorpus(
    [{ kind: "note", id: "notes", title: TITLE, text: markdown, anchor: `note:notes@${offset}` }],
    query,
  );
  const result = results[0];
  if (result === undefined) throw new Error("fixture does not match");
  return result;
}

function resolveAgainst(searched: string, saved: string, query: string): NotePassage {
  const result = noteResult(searched, query);
  const target = parseSearchTarget(result);
  if (target?.kind !== "note") throw new Error("expected a note target");
  return resolveNotePassage({
    saved,
    result,
    query,
    codePointOffset: target.codePointOffset,
  });
}

describe("parseSearchInput", () => {
  it("bounds the trimmed query by code points", () => {
    expect(parseSearchInput(" a ")).toEqual({ status: "short" });
    expect(parseSearchInput("𝔸")).toEqual({ status: "short" });
    expect(parseSearchInput(" 𝔸a ")).toEqual({ status: "ready", query: "𝔸a" });
    const max = "𝔸".repeat(120);
    expect(parseSearchInput(max)).toEqual({ status: "ready", query: max });
    expect(parseSearchInput(`${max}a`)).toEqual({ status: "long" });
  });
});

describe("parseSearchTarget", () => {
  const base = { title: "t", snippet: "s", unindexed: false } as const;

  it("accepts only exact note and finding anchors", () => {
    expect(parseSearchTarget({ ...base, kind: "note", id: "notes", anchor: "note:notes@12" })).toEqual({
      kind: "note",
      codePointOffset: 12,
    });
    expect(parseSearchTarget({ ...base, kind: "finding", id: "f-1", anchor: "finding:f-1" })).toEqual({
      kind: "finding",
      findingId: "f-1",
    });
  });

  it("rejects malformed, mismatched, and inexact anchors", () => {
    expect(parseSearchTarget({ ...base, kind: "note", id: "notes", anchor: "note:notes@-1" })).toBeNull();
    expect(parseSearchTarget({ ...base, kind: "note", id: "notes", anchor: "note:other@1" })).toBeNull();
    expect(parseSearchTarget({ ...base, kind: "finding", id: "f-1", anchor: "finding:f-2" })).toBeNull();
    expect(parseSearchTarget({ ...base, kind: "target", id: "x", anchor: "service:10.0.0.1:80" })).toBeNull();
    expect(parseSearchTarget({ ...base, kind: "lead", id: "x", anchor: "finding:x" })).toBeNull();
  });
});

describe("codePointToUtf16Offset", () => {
  it("converts across surrogate pairs and rejects offsets past the end", () => {
    expect(codePointToUtf16Offset("𝔸𝔹ab", 2)).toBe(4);
    expect(codePointToUtf16Offset("𝔸𝔹ab", 4)).toBe(6);
    expect(codePointToUtf16Offset("𝔸𝔹ab", 5)).toBeNull();
  });
});

describe("resolveNotePassage", () => {
  const saved = "# 𝔸 creds\n𝔹 root\nadmin panel at /𝔸admin\n";

  it("locates the anchored passage in UTF-16 units on non-BMP text", () => {
    const passage = resolveAgainst(saved, saved, "Admin Panel");
    expect(passage.status).toBe("exact");
    if (passage.status !== "exact") return;
    expect(saved.slice(passage.start, passage.end)).toBe("admin panel");
    expect(passage.line).toBe(3);
  });

  it("reports a changed match when the passage moved or was edited", () => {
    expect(resolveAgainst(saved, `new line\n${saved}`, "admin panel")).toEqual({ status: "changed" });
    expect(resolveAgainst(saved, saved.replace("admin panel", "admin login"), "admin panel")).toEqual({
      status: "changed",
    });
    expect(resolveAgainst(saved, "", "admin panel")).toEqual({ status: "changed" });
  });

  it("reports a changed match when nearby saved text changed", () => {
    expect(resolveAgainst(saved, saved.replace("root", "toor"), "admin panel")).toEqual({
      status: "changed",
    });
  });

  it("names a title-only match instead of inventing a passage", () => {
    expect(resolveAgainst(saved, saved, "notes")).toEqual({ status: "title" });
  });
});

describe("passageLine", () => {
  it("returns the saved line around the match", () => {
    const text = "first\nsecond 𝔸 admin here\nthird";
    const start = text.indexOf("admin");
    expect(passageLine(text, start, start + 5)).toEqual({
      before: "second 𝔸 ",
      match: "admin",
      after: " here",
    });
  });
});


describe("saved search signature revalidation", () => {
  it("uses source character lengths for lowercase expansion and sigma", () => {
    for (const [saved, query, matched] of [["İx", "i\u0307", "İ"], ["ΟΣ here", "οσ", "ΟΣ"], ["İx", "\u0307x", "İx"]]) {
      const passage = resolveAgainst(saved!, saved!, query!);
      expect(passage.status).toBe("exact");
      if (passage.status === "exact") expect(saved!.slice(passage.start, passage.end)).toBe(matched);
      expect(highlightMatch(saved!, query!).match).toBe(matched);
    }
  });

  it("revalidates title matches and excludes newly secret-bearing notes", () => {
    expect(resolveAgainst("original", "edited", "notes")).toEqual({ status: "changed" });
    expect(resolveAgainst("admin panel", "admin panel flag{test-only}", "admin")).toEqual({ status: "changed" });
  });

  it("requires the current finding title and body signature and engagement", () => {
    const record = { contractVersion: 1 as const, id: "f-1", engagementId: "e-1", title: "Admin access", body: "original", revision: 1, severity: "high" as const, status: "open" as const, evidenceArtifactIds: [], createdAt: "", updatedAt: "" };
    const result = searchCorpus([{ kind: "finding", id: record.id, title: record.title, text: record.body, anchor: `finding:${record.id}` }], "admin").results[0]!;
    const destination = { nonce: 1, kind: "finding" as const, engagementId: record.engagementId, query: "admin", findingId: record.id, result };
    expect(resolveFindingMatch(record, destination)).toBe(true);
    expect(resolveFindingMatch({ ...record, title: "Renamed" }, destination)).toBe(false);
    expect(resolveFindingMatch({ ...record, body: "changed" }, destination)).toBe(false);
    expect(resolveFindingMatch({ ...record, body: "flag{test-only}" }, destination)).toBe(false);
    expect(resolveFindingMatch({ ...record, engagementId: "e-2" }, destination)).toBe(false);
  });
});
