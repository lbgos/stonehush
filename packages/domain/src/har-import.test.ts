import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseHarImport } from "./har-import.js";

const SINGLE_ENTRY = readFileSync(
  new URL("./fixtures/har-single-entry.har", import.meta.url),
);

function harText(entries: unknown): string {
  return JSON.stringify({ log: { version: "1.2", entries } });
}

function proxyEntry(overrides: { method?: string; url?: string; status?: number } = {}) {
  return {
    startedDateTime: "2026-09-10T12:00:00.000Z",
    time: 12,
    pageref: "page_1",
    request: {
      method: overrides.method ?? "POST",
      url: overrides.url ?? "https://morrow.test/api/login",
      headers: [{ name: "content-type", value: "application/json" }],
      cookies: [],
    },
    response: {
      status: overrides.status ?? 302,
      statusText: "Found",
      headers: [],
      content: { size: 0, mimeType: "text/html" },
    },
    cache: {},
    timings: { send: 1, wait: 10, receive: 1 },
  };
}

describe("proxy HAR import", () => {
  it("parses one Caido entry with its request and response intact", () => {
    const parsed = parseHarImport(SINGLE_ENTRY);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.entryCount).toBe(1);
    expect(parsed.value.first).toEqual({
      method: "GET",
      url: "https://morrow.test/login",
      status: 200,
    });
    expect(parsed.value.title).toContain("GET");
    expect(parsed.value.title).toContain("https://morrow.test/login");
  });

  it("accepts a small multi-entry selection", () => {
    const parsed = parseHarImport(
      new TextEncoder().encode(harText([proxyEntry(), proxyEntry(), proxyEntry()])),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.entryCount).toBe(3);
  });

  it("refuses too many entries before per-entry validation", () => {
    const entries = Array.from({ length: 9 }, () => proxyEntry());
    const parsed = parseHarImport(new TextEncoder().encode(harText(entries)));
    expect(parsed).toEqual({ ok: false, error: { code: "har_too_many_entries" } });
  });

  it("refuses oversized files before decoding them", () => {
    const oversized = new Uint8Array(1_048_577);
    expect(parseHarImport(oversized)).toEqual({
      ok: false,
      error: { code: "har_too_large" },
    });
  });

  it("names malformed uploads precisely", () => {
    const encode = (value: string) => new TextEncoder().encode(value);
    expect(parseHarImport(encode("not json"))).toEqual({
      ok: false,
      error: { code: "har_not_json" },
    });
    expect(parseHarImport(new Uint8Array([0xff, 0xfe]))).toEqual({
      ok: false,
      error: { code: "har_not_json" },
    });
    expect(parseHarImport(encode("[1,2]"))).toEqual({
      ok: false,
      error: { code: "har_not_har" },
    });
    expect(parseHarImport(encode(JSON.stringify({ version: "1.2" })))).toEqual({
      ok: false,
      error: { code: "har_not_har" },
    });
    expect(parseHarImport(encode(harText([])))).toEqual({
      ok: false,
      error: { code: "har_no_entries" },
    });
    const missingUrl = proxyEntry() as Record<string, unknown>;
    delete (missingUrl.request as Record<string, unknown>).url;
    expect(parseHarImport(encode(harText([missingUrl])))).toEqual({
      ok: false,
      error: { code: "har_bad_entry" },
    });
    expect(parseHarImport(encode(harText([proxyEntry({ status: 99 })])))).toEqual({
      ok: false,
      error: { code: "har_bad_entry" },
    });
    expect(
      parseHarImport(encode(harText([proxyEntry({ url: "ftp://morrow.test/x" })]))),
    ).toEqual({ ok: false, error: { code: "har_bad_entry" } });
  });
});
