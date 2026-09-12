// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { parseFfufPositiveInt, validateFfufWordlistPath } from "./ffuf-mutations.js";

describe("ffuf field validation", () => {
  it("enforces the authoritative contract bounds per field", () => {
    expect(parseFfufPositiveInt("100", "rate", "Rate")).toEqual({ ok: true, value: 100 });
    expect(parseFfufPositiveInt("10000", "rate", "Rate").ok).toBe(true);
    expect(parseFfufPositiveInt("10001", "rate", "Rate")).toEqual({
      ok: false,
      message: "Rate must be an integer in 1-10000.",
    });
    expect(parseFfufPositiveInt("200", "threads", "Threads").ok).toBe(true);
    expect(parseFfufPositiveInt("201", "threads", "Threads")).toEqual({
      ok: false,
      message: "Threads must be an integer in 1-200.",
    });
    expect(parseFfufPositiveInt("120", "timeoutSeconds", "Timeout").ok).toBe(true);
    expect(parseFfufPositiveInt("121", "timeoutSeconds", "Timeout")).toEqual({
      ok: false,
      message: "Timeout must be an integer in 1-120.",
    });
    expect(parseFfufPositiveInt("5", "maxTimeSeconds", "Duration").ok).toBe(true);
    expect(parseFfufPositiveInt("4", "maxTimeSeconds", "Duration")).toEqual({
      ok: false,
      message: "Duration must be an integer in 5-1800.",
    });
    expect(parseFfufPositiveInt("1800", "maxTimeSeconds", "Duration").ok).toBe(true);
    expect(parseFfufPositiveInt("1801", "maxTimeSeconds", "Duration").ok).toBe(false);
    expect(parseFfufPositiveInt("abc", "rate", "Rate")).toEqual({
      ok: false,
      message: "Rate must be a positive integer.",
    });
  });

  it("requires an absolute managed wordlist path", () => {
    expect(validateFfufWordlistPath("").ok).toBe(false);
    expect(validateFfufWordlistPath("wordlists/x.txt")).toEqual({
      ok: false,
      message: "Wordlist path must be absolute and must not contain path traversal.",
    });
    expect(validateFfufWordlistPath("../etc/words")).toEqual({
      ok: false,
      message: "Wordlist path must be absolute and must not contain path traversal.",
    });
    expect(validateFfufWordlistPath("/wordlists/x.txt")).toEqual({
      ok: true,
      value: "/wordlists/x.txt",
    });
  });
});
