import { describe, expect, it } from "vitest";

import {
  checkTechniqueInput,
  countStepLiteral,
  isTechniquePlaceholderName,
  replaceStepLiteral,
  techniqueInputFromForm,
  type TechniqueFormDraft,
} from "./technique-editor.js";

const form: TechniqueFormDraft = {
  name: "  Default creds  ",
  whenUseful: "",
  prerequisites: "http on 80\n\n  admin form \n",
  question: " Does the vendor default work? ",
  meaning: "",
  steps: [
    { key: "a", instruction: " Open the login form.\n\n$ not a command ", command: "", note: "From attempt 1: observed" },
    { key: "b", instruction: "Try the pair.", command: " curl -s {{url}} " },
  ],
};

describe("techniqueInputFromForm", () => {
  it("trims edges, keeps inner text, splits prerequisites and drops empty commands and notes", () => {
    expect(techniqueInputFromForm(form)).toEqual({
      name: "Default creds",
      whenUseful: "",
      prerequisites: ["http on 80", "admin form"],
      question: "Does the vendor default work?",
      procedure: [
        { instruction: "Open the login form.\n\n$ not a command" },
        { instruction: "Try the pair.", command: "curl -s {{url}}" },
      ],
      meaning: "",
    });
  });
});

describe("checkTechniqueInput", () => {
  const valid = techniqueInputFromForm(form);

  it("accepts a valid draft", () => {
    expect(checkTechniqueInput(valid).ok).toBe(true);
  });

  it("names the field when the name passes 80 code points", () => {
    const result = checkTechniqueInput({ ...valid, name: "n".repeat(81) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.fields.name).toBe("Name has 81 characters. Shorten it to 80.");
  });

  it("asks for the operator question", () => {
    const result = checkTechniqueInput({ ...valid, question: "" });
    expect(!result.ok && result.problems.fields.question).toBe("Distinguishing question is required.");
  });

  it("reports an overlong step by position instead of clipping it", () => {
    const result = checkTechniqueInput({
      ...valid,
      procedure: [{ instruction: "ok" }, { instruction: "x".repeat(2000) }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.steps.get(1)?.instruction).toBe("Step 2 instruction has 2000 characters. Shorten it to 500.");
      expect(result.problems.steps.has(0)).toBe(false);
    }
  });

  it("rejects an empty procedure and more than 16 steps", () => {
    const empty = checkTechniqueInput({ ...valid, procedure: [] });
    expect(!empty.ok && empty.problems.fields.procedure).toBe("Add at least one step.");
    const many = checkTechniqueInput({
      ...valid,
      procedure: Array.from({ length: 17 }, (_, index) => ({ instruction: `Step ${index + 1}` })),
    });
    expect(!many.ok && many.problems.fields.procedure).toBe("A technique holds at most 16 steps. Remove 1.");
  });

  it("rejects a multi-line command", () => {
    const result = checkTechniqueInput({ ...valid, procedure: [{ instruction: "Run", command: "id\nwhoami" }] });
    expect(!result.ok && result.problems.steps.get(0)?.command).toBe("Step 1 command must be one line.");
  });

  it("reports too many prerequisites", () => {
    const result = checkTechniqueInput({ ...valid, prerequisites: Array.from({ length: 9 }, (_, index) => `p${index}`) });
    expect(!result.ok && result.problems.fields.prerequisites).toBe("Use at most 8 prerequisites, one per line.");
  });
});

describe("placeholder replacement", () => {
  const steps = [
    { key: "a", instruction: "Scan 192.0.2.10 then 192.0.2.10:8080", command: "nmap -sV 192.0.2.10" },
    { key: "b", instruction: "Nothing here", command: "" },
  ];

  it("counts and replaces every exact occurrence in instructions and commands", () => {
    expect(countStepLiteral(steps, "192.0.2.10")).toBe(3);
    const result = replaceStepLiteral(steps, "192.0.2.10", "target");
    expect(result.count).toBe(3);
    expect(result.steps).toEqual([
      { key: "a", instruction: "Scan {{target}} then {{target}}:8080", command: "nmap -sV {{target}}" },
      { key: "b", instruction: "Nothing here", command: "" },
    ]);
  });

  it("refuses invalid placeholder names and blank text", () => {
    expect(isTechniquePlaceholderName("target")).toBe(true);
    expect(isTechniquePlaceholderName("Target")).toBe(false);
    expect(isTechniquePlaceholderName("1host")).toBe(false);
    expect(isTechniquePlaceholderName("a}}b{{c")).toBe(false);
    expect(replaceStepLiteral(steps, "192.0.2.10", "Bad").count).toBe(0);
    expect(replaceStepLiteral(steps, "  ", "target").count).toBe(0);
  });
});
