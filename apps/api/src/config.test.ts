import { describe, expect, it } from "vitest";

import { apiPortFromEnvironment, dataDirectoryFromEnvironment } from "./config.js";

describe("apiPortFromEnvironment", () => {
  it("uses the default only when the value is missing", () => {
    expect(apiPortFromEnvironment({})).toBe(3001);
  });

  it("accepts the complete port range", () => {
    expect(apiPortFromEnvironment({ STONEHUSH_API_PORT: "1" })).toBe(1);
    expect(apiPortFromEnvironment({ STONEHUSH_API_PORT: "65535" })).toBe(65_535);
  });

  it.each(["", "0", "65536", "1.5", "+1", " 3001", "3001 ", "1e3", "abc"])(
    "rejects invalid value %j",
    (value) => {
      expect(() => apiPortFromEnvironment({ STONEHUSH_API_PORT: value })).toThrow(
        "STONEHUSH_API_PORT must be a decimal integer from 1 through 65535.",
      );
    },
  );
});

describe("dataDirectoryFromEnvironment", () => {
  it("accepts and resolves an explicit absolute path", () => {
    expect(
      dataDirectoryFromEnvironment({
        STONEHUSH_DATA_DIR: "/tmp/stonehush-api-config/data/../runtime",
      }),
    ).toBe("/tmp/stonehush-api-config/runtime");
  });

  it.each([undefined, "", "relative/path", "data\0directory"])(
    "rejects missing or unsafe value %j",
    (value) => {
      expect(() =>
        dataDirectoryFromEnvironment({ STONEHUSH_DATA_DIR: value }),
      ).toThrow("STONEHUSH_DATA_DIR must be an explicit absolute path without NUL bytes.");
    },
  );
});
