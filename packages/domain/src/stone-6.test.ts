import { describe, expect, it } from "vitest";

import {
  applyStarredFocus,
  buildResumeChanges,
  changesSinceLastVisit,
  describePriorAttempt,
  toggleStarred,
} from "./engagement-resume.js";
import { redactSecretsForSnippet, searchCorpus, findMatchOffset } from "./engagement-search.js";
import {
  groupFfufResults,
  hideFfufGroups,
  labelUnusualFfufResponse,
  undoHideFfufGroups,
  visibleFfufGroups,
} from "./ffuf-group.js";
import { loadLastWordlistChoice, missingWordlistRecovery, resolveWordlistByName } from "./ffuf-wordlist.js";
import { diffRuns } from "./run-diff.js";

describe("resume changes never fabricate timelines", () => {
  it("labels pre-event records as snapshot and sorts newest first", () => {
    const changes = buildResumeChanges([
      { kind: "run", id: "run-old", at: "2024-01-01T00:00:00.000Z", summary: "old run", preEventRecord: true },
      { kind: "finding", id: "f-1", at: "2026-09-01T00:00:00.000Z", summary: "new finding", preEventRecord: false },
    ]);
    expect(changes[0]?.id).toBe("f-1");
    expect(changes[0]?.snapshot).toBe(false);
    expect(changes[1]?.snapshot).toBe(true);
  });

  it("filters by last visit without dropping snapshot labels", () => {
    const changes = buildResumeChanges([
      { kind: "note", id: "n-1", at: "2026-09-09T00:00:00.000Z", summary: "note", preEventRecord: false },
      { kind: "note", id: "n-0", at: "2026-09-01T00:00:00.000Z", summary: "older", preEventRecord: true },
    ]);
    const recent = changesSinceLastVisit(changes, "2026-09-05T00:00:00.000Z");
    expect(recent.map((change) => change.id)).toEqual(["n-1"]);
  });
});

describe("starred focus never hides active jobs", () => {
  it("keeps active unstarred items while narrowing", () => {
    const items = [
      { id: "a", starred: true, hasActiveJob: false },
      { id: "b", starred: false, hasActiveJob: true },
      { id: "c", starred: false, hasActiveJob: false },
    ];
    expect(applyStarredFocus(items, true).map((item) => item.id)).toEqual(["a", "b"]);
    expect(applyStarredFocus(items, false)).toHaveLength(3);
  });

  it("toggles stars without touching other ids", () => {
    expect(toggleStarred([], "a")).toEqual(["a"]);
    expect(toggleStarred(["a", "b"], "a")).toEqual(["b"]);
  });
});

describe("repeat runner shows the prior attempt", () => {
  it("shows last attempt and flags changed conditions", () => {
    const copy = describePriorAttempt({
      runId: "run-7",
      attemptedAt: "2026-09-09T12:00:00.000Z",
      optionsSummary: "threads 40, timeout 10s",
      outcome: "failed",
      conditionsChanged: true,
    });
    expect(copy).toContain("run-7");
    expect(copy).toContain("Conditions changed");
  });
});

describe("search excludes secrets", () => {
  it("skips entries holding secret values and redacts snippets", () => {
    const { results } = searchCorpus(
      [
        { kind: "note", id: "n-1", title: "creds", text: "flag{secret-value}", anchor: "note:n-1@0" },
        { kind: "note", id: "n-2", title: "admin page", text: "the admin page lists users", anchor: "note:n-2@4" },
      ],
      "admin",
    );
    expect(results.map((result) => result.id)).toEqual(["n-2"]);
    expect(redactSecretsForSnippet("key flag{abc} here")).toContain("[redacted]");
    const leaked = searchCorpus(
      [{ kind: "finding", id: "f-1", title: "login", text: "admin login with flag{abc} embedded", anchor: "finding:f-1" }],
      "login",
    );
    expect(leaked.results).toHaveLength(0);
  });

  it("reports match offsets in code points on non-BMP text", () => {
    // "🛡" is one code point but two UTF-16 units; a UTF-16 offset would
    // point one past the match and drift the snippet and note anchor.
    const offset = findMatchOffset("🛡 admin", "admin");
    expect(offset).toEqual({ index: 2, length: 5 });
    expect(findMatchOffset("nothing here", "admin")).toBe(null);
    expect(findMatchOffset("admin", "  ")).toBe(null);
  });

  it("maps offsets back when lowercasing expands characters", () => {
    // U+0130 lowercases to two UTF-16 units; the raw lowered offset would
    // land one past the real match start.
    expect(findMatchOffset("İ admin", "admin")).toEqual({ index: 2, length: 5 });
  });

  it("matches across final and medial sigma", () => {
    expect(findMatchOffset("ΟΣ", "σ")).toEqual({ index: 1, length: 1 });
    expect(findMatchOffset("οσ", "Σ")).toEqual({ index: 1, length: 1 });
  });
});

describe("ffuf grouping with hide and undo", () => {
  const rows = [
    { url: "http://x/a", status: 200, length: 10, words: 2, lines: 1, fuzz: "a" },
    { url: "http://x/b", status: 200, length: 10, words: 2, lines: 1, fuzz: "b" },
    { url: "http://x/c", status: 403, length: 5, words: 1, lines: 1, fuzz: "c" },
  ];

  it("groups by exact metadata with a basis label", () => {
    const groups = groupFfufResults(rows);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.members).toHaveLength(2);
    expect(groups[0]?.basis).toContain("status 200");
  });

  it("hide then undo restores the group", () => {
    const groups = groupFfufResults(rows);
    const basis = groups[0]?.basis ?? "";
    const hidden = hideFfufGroups({ hiddenBases: [] }, [basis]);
    const afterHide = visibleFfufGroups(groups, hidden);
    expect(afterHide.hiddenCount).toBe(1);
    expect(afterHide.hiddenMembers).toBe(2);
    const restored = visibleFfufGroups(groups, undoHideFfufGroups(hidden, [basis]));
    expect(restored.hiddenCount).toBe(0);
    expect(restored.visible).toHaveLength(2);
  });

  it("labels unusual responses without vulnerability claims", () => {
    const label = labelUnusualFfufResponse(rows[2]!);
    expect(label).toContain("Observed behavior only");
    expect(label).toContain("not a vulnerability claim");
    expect(label).not.toMatch(/vulnerability (found|detected|confirmed|present)/i);
  });
});

describe("run diff truthfulness", () => {
  it("never reports an unscanned port as closed", () => {
    const diff = diffRuns({
      before: {
        context: { tool: "nmap", origin: "10.0.0.1", optionsSummary: "default", binding: "b1" },
        services: [{ address: "10.0.0.1", port: 80, protocol: "tcp", serviceName: "http" }],
        responses: [],
        paths: [],
        complete: true,
      },
      after: {
        context: { tool: "nmap", origin: "10.0.0.1", optionsSummary: "default", binding: "b1" },
        services: [],
        responses: [],
        paths: [],
        complete: true,
      },
    });
    expect(diff.removedFromView.join(" ")).toContain("Not observed is not closed");
    // Tightened negative: the disclaimer itself contains "closed", so only a
    // positive closure claim ("is closed" / "was closed") may fail the suite.
    expect(diff.removedFromView.join(" ")).not.toMatch(/\b(is|was)\s+closed\b/i);
  });

  it("reports a path status change as changed, not new", () => {    const diff = diffRuns({
      before: {
        context: { tool: "ffuf", origin: "http://10.0.0.1", optionsSummary: "default", binding: "b1" },
        services: [],
        responses: [],
        paths: [{ url: "http://10.0.0.1/", status: 403, fuzz: "admin" }],
        complete: true,
      },
      after: {
        context: { tool: "ffuf", origin: "http://10.0.0.1", optionsSummary: "default", binding: "b1" },
        services: [],
        responses: [],
        paths: [{ url: "http://10.0.0.1/", status: 200, fuzz: "admin" }],
        complete: true,
      },
    });
    expect(diff.newPaths).toHaveLength(0);
    expect(diff.changedPaths).toHaveLength(1);
    expect(diff.changedPaths[0]).toContain("was status 403, now status 200");
  });

  it("names titles when only the response title changes", () => {
    const diff = diffRuns({
      before: {
        context: { tool: "http-probe", origin: "http://10.0.0.1", optionsSummary: "default", binding: "b1" },
        services: [],
        responses: [{ url: "http://10.0.0.1/", status: 200, title: "Old title" }],
        paths: [],
        complete: true,
      },
      after: {
        context: { tool: "http-probe", origin: "http://10.0.0.1", optionsSummary: "default", binding: "b1" },
        services: [],
        responses: [{ url: "http://10.0.0.1/", status: 200, title: "New title" }],
        paths: [],
        complete: true,
      },
    });
    expect(diff.changedResponses).toHaveLength(1);
    expect(diff.changedResponses[0]).toContain("Old title");
    expect(diff.changedResponses[0]).toContain("New title");
  });

  it("marks incomplete sides as disproving nothing and refuses cross-tool compare", () => {    const diff = diffRuns({
      before: {
        context: { tool: "nmap", origin: "10.0.0.1", optionsSummary: "a", binding: "b1" },
        services: [],
        responses: [],
        paths: [],
        complete: false,
      },
      after: {
        context: { tool: "ffuf", origin: "http://10.0.0.1", optionsSummary: "a", binding: "b1" },
        services: [],
        responses: [],
        paths: [],
        complete: true,
      },
    });
    expect(diff.comparable).toBe(false);
    expect(diff.caveats.join(" ")).toContain("disproves nothing");
  });
});

describe("wordlist by name", () => {
  it("reports unconfigured presets without guessing paths", () => {
    const result = resolveWordlistByName("common", () => true);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(missingWordlistRecovery(result.error.code)).toContain("no configured file");
    }
  });

  it("resolves an operator-configured path and fires the run input", () => {
    const resolved = resolveWordlistByName("common", () => true, { common: "/wl/common.txt" });
    expect(resolved).toEqual({
      ok: true,
      value: { name: "common", path: "/wl/common.txt", isDemo: false },
    });
    // An empty override clears back to unconfigured; a missing file reports.
    expect(resolveWordlistByName("common", () => true, { common: "  " }).ok).toBe(false);
    const missing = resolveWordlistByName("common", () => false, { common: "/wl/gone.txt" });
    expect(missing.ok).toBe(false);
    if (missing.ok === false) {
      expect(missingWordlistRecovery(missing.error.code)).toContain("missing");
    }
  });

  it("rejects unknown names and tolerates a failing choice store", () => {
    expect(resolveWordlistByName("nope", () => true).ok).toBe(false);
    expect(loadLastWordlistChoice({ load: () => { throw new Error("x"); }, save: () => {} })).toBe(null);
  });
});
