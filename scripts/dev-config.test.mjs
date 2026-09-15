import assert from "node:assert/strict";
import test from "node:test";

import { readDevConfig } from "./dev-config.mjs";

const repositoryRoot = "/tmp/stonehush-config-test";

test("uses default development ports only when values are missing", () => {
  assert.deepEqual(readDevConfig({}, repositoryRoot), {
    apiPort: 3001,
    dataDirectory: "/tmp/stonehush-config-test/.stonehush/dev",
    webPort: 5173,
  });
});

test("accepts decimal ports and a resolved absolute data directory", () => {
  assert.deepEqual(
    readDevConfig(
      {
        STONEHUSH_API_PORT: "1",
        STONEHUSH_DATA_DIR: "/tmp/stonehush-config-test/data/../runtime",
        STONEHUSH_WEB_PORT: "65535",
      },
      repositoryRoot,
    ),
    {
      apiPort: 1,
      dataDirectory: "/tmp/stonehush-config-test/runtime",
      webPort: 65_535,
    },
  );
});

for (const [name, value] of [
  ["STONEHUSH_API_PORT", ""],
  ["STONEHUSH_API_PORT", "0"],
  ["STONEHUSH_API_PORT", "65536"],
  ["STONEHUSH_API_PORT", "1.5"],
  ["STONEHUSH_API_PORT", "+1"],
  ["STONEHUSH_WEB_PORT", " 5173"],
  ["STONEHUSH_WEB_PORT", "5173 "],
  ["STONEHUSH_WEB_PORT", "1e3"],
]) {
  test(`rejects invalid ${name} value ${JSON.stringify(value)}`, () => {
    assert.throws(
      () => readDevConfig({ [name]: value }, repositoryRoot),
      new RegExp(`${name} must be a decimal integer from 1 through 65535`),
    );
  });
}

test("rejects equal API and web ports", () => {
  assert.throws(
    () =>
      readDevConfig(
        { STONEHUSH_API_PORT: "4000", STONEHUSH_WEB_PORT: "4000" },
        repositoryRoot,
      ),
    /must use different ports/,
  );
});

for (const value of ["", "relative/path", "./data", "data\0directory"]) {
  test(`rejects unsafe STONEHUSH_DATA_DIR value ${JSON.stringify(value)}`, () => {
    assert.throws(
      () => readDevConfig({ STONEHUSH_DATA_DIR: value }, repositoryRoot),
      /STONEHUSH_DATA_DIR must be a non-empty absolute path without NUL bytes/,
    );
  });
}

test("requires an absolute repository root for the default data directory", () => {
  assert.throws(() => readDevConfig({}, "relative/repository"), /repository root must be absolute/);
});
