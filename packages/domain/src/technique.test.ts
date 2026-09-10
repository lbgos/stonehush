import { describe, expect, it } from "vitest";

import {
  extractTechniquePlaceholders,
  fillTechniquePlaceholders,
  isSupportedCheck,
  matchTechniquePrereqs,
} from "./technique.js";

describe("technique placeholders", () => {
  it("extracts unique placeholder names in order", () => {
    expect(
      extractTechniquePlaceholders("curl {{url}} then curl {{url}} as {{user}}"),
    ).toEqual(["url", "user"]);
  });

  it("ignores malformed placeholders", () => {
    expect(extractTechniquePlaceholders("{{}} {{ Name }} {{a-b}} plain")).toEqual([]);
  });

  it("replays values and reports the missing ones", () => {
    const filled = fillTechniquePlaceholders("curl -s {{url}} as {{user}}", {
      url: "http://127.0.0.1/",
    });
    expect(filled.text).toBe("curl -s http://127.0.0.1/ as {{user}}");
    expect(filled.missing).toEqual(["user"]);
  });

  it("leaves empty values verbatim", () => {
    const filled = fillTechniquePlaceholders("nmap {{target}}", { target: "" });
    expect(filled.text).toBe("nmap {{target}}");
    expect(filled.missing).toEqual(["target"]);
  });
});

describe("technique prerequisite matching", () => {
  it("matches with a stated reason", () => {
    const match = matchTechniquePrereqs(
      ["HTTP service with a login form"],
      ["Observed HTTP service with a login form on 10.0.0.5:80"],
    );
    expect(match.matched).toBe(true);
    expect(match.reason).toContain("All 1 prerequisite observed");
  });

  it("names missing prerequisites", () => {
    const match = matchTechniquePrereqs(
      ["Login form", "Valid credentials"],
      ["Observed login form"],
    );
    expect(match.matched).toBe(false);
    expect(match.missing).toEqual(["Valid credentials"]);
    expect(match.reason).toContain("Missing 1 prerequisite");
    expect(match.reason).toContain("Valid credentials");
  });

  it("treats zero prerequisites as applicable with a reason", () => {
    const match = matchTechniquePrereqs([], ["anything"]);
    expect(match.matched).toBe(true);
    expect(match.reason).toContain("No prerequisites");
  });

  it("never matches on an empty fact", () => {
    expect(matchTechniquePrereqs(["Login form"], ["", "   "]).matched).toBe(false);
  });
});

describe("supported-check classifier", () => {
  it("accepts runnable single-line checks", () => {
    expect(isSupportedCheck("nmap -sV 10.0.0.5")).toBe(true);
    expect(isSupportedCheck("curl -s http://127.0.0.1:80/")).toBe(true);
  });

  it("rejects shell chains, pipelines, and prose", () => {
    expect(isSupportedCheck("nmap 10.0.0.5 && cat /etc/passwd")).toBe(false);
    expect(isSupportedCheck("cat file | grep secret")).toBe(false);
    expect(isSupportedCheck("First scan the box. Then try harder.")).toBe(false);
    expect(isSupportedCheck("Run nmap -sV 10.0.0.5 to confirm.")).toBe(false);
    expect(isSupportedCheck("Try the login form.")).toBe(false);
    expect(isSupportedCheck("line one\nline two")).toBe(false);
    expect(isSupportedCheck("")).toBe(false);
  });

  it("rejects substitution and redirection", () => {
    expect(isSupportedCheck("echo $(whoami)")).toBe(false);
    expect(isSupportedCheck("nmap 10.0.0.5 > out.txt")).toBe(false);
  });
});
