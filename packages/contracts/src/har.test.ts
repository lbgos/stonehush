import { describe, expect, it } from "vitest";

import {
  HAR_IMPORT_ERROR_CODES,
  HAR_MAX_ENTRIES,
  HAR_MAX_FILE_BYTES,
  HarEntrySchema,
  isHarWebUrl,
  titleForHarEntry,
} from "./har.js";
import {
  originLabelForKind,
  proposeCaptureTitle,
  StoneCaptureErrorSchema,
} from "./import-capture.js";

const PROXY_ENTRY = {
  startedDateTime: "2026-09-10T12:00:00.000Z",
  time: 42,
  pageref: "page_1",
  request: {
    method: "GET",
    url: "https://morrow.test/login",
    httpVersion: "HTTP/2",
    headers: [{ name: ":method", value: "GET" }],
    queryString: [],
    cookies: [],
  },
  response: {
    status: 200,
    statusText: "OK",
    headers: [{ name: "content-type", value: "text/html" }],
    content: { size: 19, mimeType: "text/html", text: "<form>login</form>" },
  },
  cache: {},
  timings: { send: 1, wait: 40, receive: 1 },
};

describe("proxy HAR contracts", () => {
  it("keeps the selection bounds small", () => {
    expect(HAR_MAX_ENTRIES).toBe(8);
    expect(HAR_MAX_FILE_BYTES).toBe(1_048_576);
  });

  it("accepts a proxy entry with extra members stripped", () => {
    const parsed = HarEntrySchema.safeParse(PROXY_ENTRY);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual({
      request: { method: "GET", url: "https://morrow.test/login" },
      response: { status: 200 },
    });
  });

  it("rejects entries missing method, URL, or status", () => {
    for (const candidate of [
      { request: { url: "https://morrow.test/" }, response: { status: 200 } },
      { request: { method: "GET" }, response: { status: 200 } },
      { request: { method: "GET", url: "https://morrow.test/" }, response: {} },
      {
        request: { method: "GET", url: "https://morrow.test/" },
        response: { status: 99 },
      },
    ]) {
      expect(HarEntrySchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("accepts only absolute web URLs", () => {
    expect(isHarWebUrl("http://morrow.test/")).toBe(true);
    expect(isHarWebUrl("https://morrow.test/login")).toBe(true);
    expect(isHarWebUrl("/login")).toBe(false);
    expect(isHarWebUrl("ftp://morrow.test/x")).toBe(false);
    expect(isHarWebUrl("not a url")).toBe(false);
  });

  it("titles the pair from its own method and URL", () => {
    const title = titleForHarEntry({
      method: "GET",
      url: "https://morrow.test/login",
      status: 200,
    });
    expect(title).toContain("GET");
    expect(title).toContain("https://morrow.test/login");
    const long = titleForHarEntry({
      method: "GET",
      url: `https://morrow.test/${"p".repeat(8192)}`,
      status: 200,
    });
    expect(Array.from(long).length).toBeLessThanOrEqual(120);
  });

  it("labels HAR captures imported with a readable kind title", () => {
    expect(originLabelForKind("har")).toBe("imported");
    expect(proposeCaptureTitle({ kind: "har", targetLabel: "web01" })).toContain(
      "HAR import",
    );
  });

  it("accepts every HAR rejection code as a capture error", () => {
    expect(HAR_IMPORT_ERROR_CODES.length).toBeGreaterThan(0);
    for (const code of HAR_IMPORT_ERROR_CODES) {
      expect(StoneCaptureErrorSchema.safeParse({ code }).success).toBe(true);
    }
  });
});
