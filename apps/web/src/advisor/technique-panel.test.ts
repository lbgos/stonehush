import { describe, expect, it } from "vitest";

import { parseProcedure } from "./technique-panel.js";

describe("technique procedure parsing", () => {
  it("parses an instruction with its command", () => {
    expect(parseProcedure("Open the login form.\n$ curl -s {{url}}")).toEqual([
      { instruction: "Open the login form.", command: "curl -s {{url}}" },
    ]);
  });

  it("keeps instruction-only steps", () => {
    expect(parseProcedure("Try one documented default pair only.")).toEqual([
      { instruction: "Try one documented default pair only." },
    ]);
  });

  it("rejects a block with more than one command instead of dropping input", () => {
    expect(
      parseProcedure("Describe checks\n$ curl -s {{url}}\n$ nmap -sV {{target}}"),
    ).toBeUndefined();
  });

  it("rejects instruction text after the command instead of reordering it", () => {
    expect(
      parseProcedure("Open connection\n$ curl -s {{url}}\nVerify the response"),
    ).toBeUndefined();
  });

  it("keeps a command-only step with a generic instruction", () => {
    expect(parseProcedure("$ nmap -sV {{target}}")).toEqual([
      { instruction: "Run the command.", command: "nmap -sV {{target}}" },
    ]);
  });

  it("rejects blocks with neither instruction nor command", () => {
    expect(parseProcedure("$  \n")).toBeUndefined();
    expect(parseProcedure("   \n\n  ")).toEqual([]);
  });
});
