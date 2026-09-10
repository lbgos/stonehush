import { describe, expect, it } from "vitest";

import {
  ADVISOR_ENTRY_POINT_LABELS,
  buildDistinguishQuestion,
  buildExplainQuestion,
  buildOverlookQuestion,
} from "./advisor-entry-points.js";
import { applyHintDepth, loadHintDepth, saveHintDepth } from "./hint-depth.js";
import {
  buildContextPreview,
  pickPreviewContext,
  storedTurnBasis,
} from "./context-preview.js";
import { filterRuledOutSuggestions } from "./ruled-out.js";
import {
  pinParagraphToLead,
  pinParagraphToNote,
  splitAnswerParagraphs,
  toPrefilledAction,
} from "./pin-citation.js";
import { citationPassageHref } from "./citations.js";
import { leadToFindingPrefill } from "./lead-prefill.js";

describe("advisor entry points", () => {
  it("labels the three entry points", () => {
    expect(ADVISOR_ENTRY_POINT_LABELS.explain).toBe("Explain this");
    expect(ADVISOR_ENTRY_POINT_LABELS.distinguish).toBe(
      "Distinguish possibilities",
    );
    expect(ADVISOR_ENTRY_POINT_LABELS.overlook).toBe("What am I overlooking");
  });

  it("builds an explain question from an observation", () => {
    const question = buildExplainQuestion("port 80 shows a login form");
    expect(question).toContain("port 80 shows a login form");
    expect(question).toContain("uncertain");
  });

  it("clips distinguish to few relevant possibilities", () => {
    const question = buildDistinguishQuestion({
      possibilities: ["a", "b", "c", "d"],
    });
    expect(question).toContain("a vs b vs c");
    expect(question).not.toContain(" vs d");
  });

  it("falls back gracefully on empty input", () => {
    expect(buildExplainQuestion("   ")).toContain("selected evidence");
    expect(buildDistinguishQuestion({ possibilities: ["only"] })).toContain(
      "distinguish",
    );
    expect(buildOverlookQuestion({ investigation: "" })).toContain("overlooking");
  });
});

describe("hint depth", () => {
  it("leaves depth 0 byte-identical: no unprompted walkthrough", () => {
    const question = "What does this banner show?";
    const shaped = applyHintDepth(question, 0);
    expect(shaped).toBe(question);
    expect(shaped).not.toMatch(/step-by-step|walkthrough|detailed approach/i);
  });

  it("adds one check at depth 1 and detail only at depth 2", () => {
    expect(applyHintDepth("Q?", 1)).toContain("exactly one specific check");
    expect(applyHintDepth("Q?", 1)).not.toMatch(/in detail/i);
    expect(applyHintDepth("Q?", 2)).toContain("in detail");
  });

  it("keeps depth per engagement with safe defaults", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    expect(loadHintDepth(storage, "eng-1")).toBe(0);
    saveHintDepth(storage, "eng-1", 2);
    expect(loadHintDepth(storage, "eng-1")).toBe(2);
    expect(loadHintDepth(storage, "eng-2")).toBe(0);
    expect(loadHintDepth(undefined, "eng-1")).toBe(0);
    expect(loadHintDepth({ getItem: () => "9", setItem: () => {} }, "eng-1")).toBe(0);
  });
});

describe("ruled-out suggestions", () => {
  it("drops suggestions ruled out under the same conditions", () => {
    const verdicts = filterRuledOutSuggestions(
      [{ id: "s1", summary: "Try default creds", conditions: "login form on 80" }],
      [{ summary: "try DEFAULT creds ", conditions: "login  form on 80", outcome: "ruled-out" }],
    );
    expect(verdicts[0]?.verdict).toBe("drop");
  });

  it("annotates when a new reason arrives, keeps the rest", () => {
    const verdicts = filterRuledOutSuggestions(
      [
        { id: "s1", summary: "Try default creds", conditions: "login form", newReason: "vendor list updated" },
        { id: "s2", summary: "Scan UDP", conditions: "no UDP seen" },
      ],
      [{ summary: "Try default creds", conditions: "login form", outcome: "ruled-out" }],
    );
    expect(verdicts[0]?.verdict).toBe("annotate");
    expect(verdicts[1]?.verdict).toBe("keep");
  });

  it("treats different access context as a different check", () => {
    const verdicts = filterRuledOutSuggestions(
      [{ id: "s1", summary: "Read file", conditions: "low-priv shell" }],
      [{ summary: "Read file", conditions: "root shell", outcome: "ruled-out" }],
    );
    expect(verdicts[0]?.verdict).toBe("keep");
  });
});

describe("context preview", () => {
  it("lists chosen excerpts and findings only", () => {
    const preview = buildContextPreview({
      question: "What shows?",
      excerpts: [{ id: "nmap-xml-1" }],
      findings: [{ id: "f-1", title: "Weak login" }],
    });
    expect(preview.lines.join("\n")).toContain("artifact nmap-xml-1");
    expect(preview.lines.join("\n")).toContain("Weak login (f-1)");
    expect(preview.excerptCount).toBe(1);
    expect(preview.findingCount).toBe(1);
  });

  it("drops scratchpad, credentials, history, and raw bytes", () => {
    const picked = pickPreviewContext({
      question: "Q?",
      excerpts: [{ id: "a-1" }],
      findings: [],
      scratchpad: "flag{secret} plan",
      credentials: "admin:hunter2",
      secretValues: ["sk-abc"],
      noteHistory: ["v1", "v2"],
      rawArtifacts: ["bytes"],
      history: [{ question: "old", answer: "old" }],
    });
    const preview = buildContextPreview(picked);
    const text = preview.lines.join("\n");
    expect(text).not.toContain("flag{secret}");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("sk-abc");
    expect(text).not.toContain("bytes");
  });
});

describe("stored turn basis", () => {
  it("summarizes the turn's own citations", () => {
    expect(
      storedTurnBasis([
        { raw: "a-1", valid: true, kind: "artifact" },
        { raw: "f-1", valid: true, kind: "finding" },
        { raw: "bogus", valid: false, kind: "unknown" },
      ]),
    ).toBe("Basis: 1 artifact, 1 finding.");
  });

  it("handles empty and unverified bases", () => {
    expect(storedTurnBasis([])).toBe("Basis: no cited evidence.");
    expect(
      storedTurnBasis([{ raw: "bogus", valid: false, kind: "unknown" }]),
    ).toBe("Basis: no verified citations.");
  });
});

describe("pin with citations", () => {
  const paragraph = {
    text: "The banner shows nginx 1.18.",
    citations: [
      { raw: "nmap-xml-1", valid: true, kind: "artifact" as const },
      { raw: "made-up", valid: false, kind: "unknown" as const },
    ],
  };

  it("splits answers into bounded paragraphs", () => {
    expect(splitAnswerParagraphs("One.\n\nTwo.\n\n\nThree.")).toEqual([
      "One.",
      "Two.",
      "Three.",
    ]);
  });

  it("pins a paragraph into a note with citations", () => {
    const draft = pinParagraphToNote(paragraph, "What shows?");
    expect(draft.body).toContain("The banner shows nginx 1.18.");
    expect(draft.body).toContain("artifact nmap-xml-1");
    expect(draft.body).toContain("unverified made-up");
  });

  it("pins a paragraph into a lead draft with evidence refs", () => {
    const draft = pinParagraphToLead(paragraph, "What shows?");
    expect(draft.title).toContain("nginx");
    expect(draft.artifactIds).toEqual(["nmap-xml-1"]);
    expect(draft.findingIds).toEqual([]);
  });

  it("prefills supported checks and refuses prose", () => {
    const runnable = toPrefilledAction("nmap -sV 10.0.0.5");
    expect(runnable.ok).toBe(true);
    if (runnable.ok) expect(runnable.argv).toEqual(["nmap", "-sV", "10.0.0.5"]);
    const prose = toPrefilledAction("First scan the box, then try harder.");
    expect(prose.ok).toBe(false);
  });
});

describe("citation passage links", () => {
  it("opens valid artifact citations at the saved passage", () => {
    expect(
      citationPassageHref("eng-1", { raw: "a-1", valid: true, kind: "artifact" }),
    ).toBe("/api/v1/engagements/eng-1/artifacts/a-1/content");
  });

  it("never links findings or unverified citations", () => {
    expect(
      citationPassageHref("eng-1", { raw: "f-1", valid: true, kind: "finding" }),
    ).toBeNull();
    expect(
      citationPassageHref("eng-1", { raw: "bogus", valid: false, kind: "unknown" }),
    ).toBeNull();
  });
});

describe("lead to finding prefill", () => {
  it("carries title and narrative with confidence separate from severity", () => {
    const prefill = leadToFindingPrefill({
      id: "lead-1",
      title: "Weak login",
      narrative: "The form accepts admin/admin.",
      confidence: "high",
      source: "operator",
      evidenceArtifactIds: ["nmap-xml-1"],
    });
    expect(prefill.title).toBe("Weak login");
    expect(prefill.body).toContain("The form accepts admin/admin.");
    expect(prefill.body).toContain("Confidence: high");
    expect(prefill.body).toContain("independent of severity");
    expect(prefill.severity).toBe("medium");
    expect(prefill.needsInterpretation).toBe(false);
  });

  it("keeps scanner results as uninterpreted observations", () => {
    const prefill = leadToFindingPrefill({
      id: "lead-2",
      title: "Scanner hit",
      narrative: "Nikto reports an outdated header.",
      confidence: null,
      source: "scanner",
      evidenceArtifactIds: [],
    });
    expect(prefill.body).toContain("uninterpreted scanner result");
    expect(prefill.severity).toBe("info");
    expect(prefill.needsInterpretation).toBe(true);
  });
});
