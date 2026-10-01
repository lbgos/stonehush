import type { Finding } from "@stonehush/contracts";
import { searchCorpus } from "@stonehush/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createResumeFindingDestination,
  readFindingDestination,
  resolveFindingDestination,
  type FindingDestination,
  type ResumeFindingDestination,
} from "./finding-arrival.js";

const ENGAGEMENT = "10000000-0000-4000-8000-000000000001";
const OTHER = "10000000-0000-4000-8000-000000000002";
const FIRST = "50000000-0000-4000-8000-000000000001";
const SECOND = "50000000-0000-4000-8000-000000000002";
const TS = "2026-10-01T12:00:00.000Z";

const saved: Finding = {
  contractVersion: 1,
  id: SECOND,
  engagementId: ENGAGEMENT,
  title: "Admin access",
  severity: "high",
  status: "open",
  body: "The saved admin proof.",
  evidenceArtifactIds: [],
  revision: 1,
  createdAt: TS,
  updatedAt: TS,
};
const resume: ResumeFindingDestination = {
  source: "resume", kind: "finding", engagementId: ENGAGEMENT, findingId: SECOND, nonce: 1,
};
const searchResult = searchCorpus([{
  kind: "finding", id: saved.id, title: saved.title, text: saved.body, anchor: `finding:${saved.id}`,
}], "admin").results[0];
if (searchResult === undefined) throw new Error("Search fixture must match");
const search: FindingDestination = {
  ...resume, source: "search", query: "admin", result: searchResult,
};

afterEach(() => vi.unstubAllGlobals());

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

describe("finding destinations", () => {
  it("accepts exact Resume identity without a fabricated search query", () => {
    expect(createResumeFindingDestination({ engagementId: ENGAGEMENT, findingId: SECOND, nonce: 1 })).toEqual(resume);
    for (const findingId of ["", "../findings", "same title", null, 1]) {
      expect(createResumeFindingDestination({ engagementId: ENGAGEMENT, findingId, nonce: 1 })).toBeNull();
    }
    expect(createResumeFindingDestination({ engagementId: "bad-owner", findingId: SECOND, nonce: 1 })).toBeNull();
    for (const nonce of [0, -1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(createResumeFindingDestination({ engagementId: ENGAGEMENT, findingId: SECOND, nonce })).toBeNull();
    }
  });

  it("opens the exact same-title record and never falls back when its id is missing", () => {
    const sameTitle = { ...saved, id: FIRST };
    const read = resolveFindingDestination([sameTitle, saved], resume, ENGAGEMENT);
    expect(read.status).toBe("found");
    if (read.status === "found") expect(read.finding).toBe(saved);
    expect(resolveFindingDestination([sameTitle], resume, ENGAGEMENT)).toEqual({ status: "missing", records: [sameTitle] });
  });

  it("opens current renamed/resolved Resume records while preserving search changed-match behavior", () => {
    expect(resolveFindingDestination([saved], search, ENGAGEMENT).status).toBe("found");
    const current = { ...saved, title: "Reused vendor password", status: "resolved" as const, revision: 2 };
    const read = resolveFindingDestination([current], resume, ENGAGEMENT);
    expect(read.status).toBe("found");
    if (read.status === "found") expect(read.finding).toBe(current);
    expect(resolveFindingDestination([current], search, ENGAGEMENT).status).toBe("changed");
    expect(resolveFindingDestination([{ ...saved, body: "Proof changed" }], search, ENGAGEMENT).status).toBe("changed");
    expect(resolveFindingDestination([{ ...saved, status: "resolved" }], search, ENGAGEMENT).status).toBe("found");
  });

  it("rejects foreign owners and ambiguous response identities without exposing records", () => {
    expect(resolveFindingDestination([saved], resume, OTHER)).toEqual({ status: "error" });
    expect(resolveFindingDestination([{ ...saved, engagementId: OTHER }], resume, ENGAGEMENT)).toEqual({ status: "error" });
    expect(resolveFindingDestination([saved, { ...saved, id: FIRST, engagementId: OTHER }], resume, ENGAGEMENT)).toEqual({ status: "error" });
    expect(resolveFindingDestination([saved, { ...saved, title: "Duplicate identity" }], resume, ENGAGEMENT)).toEqual({ status: "error" });
  });
});

describe("fresh finding arrival reads", () => {
  it("reads fresh on each arrival/retry and distinguishes failure from successful absence", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ code: "storage_busy" }, 503))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([{ ...saved, title: "Renamed after retry", status: "resolved" }]));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    expect(await readFindingDestination(ENGAGEMENT, resume, controller.signal)).toEqual({ status: "error" });
    expect(await readFindingDestination(ENGAGEMENT, resume, controller.signal)).toEqual({ status: "missing", records: [] });
    const read = await readFindingDestination(ENGAGEMENT, resume, controller.signal);
    expect(read?.status).toBe("found");
    if (read?.status === "found") expect(read.finding.title).toBe("Renamed after retry");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const args of fetchMock.mock.calls) {
      expect(args).toEqual([`/api/v1/engagements/${ENGAGEMENT}/findings`, { signal: controller.signal }]);
    }
  });

  it.each([
    ["foreign owner", [{ ...saved, engagementId: OTHER }]],
    ["mixed owners", [saved, { ...saved, id: FIRST, engagementId: OTHER }]],
    ["malformed record", [{ ...saved, status: "unknown" }]],
    ["duplicate identity", [saved, { ...saved, title: "Other title" }]],
  ])("returns read error for %s rather than claiming the destination is missing", async (_label, payload) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(payload)));
    expect(await readFindingDestination(ENGAGEMENT, resume, new AbortController().signal)).toEqual({ status: "error" });
  });

  it("keeps network and malformed JSON failures distinct from absence", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Offline")));
    expect(await readFindingDestination(ENGAGEMENT, resume, new AbortController().signal)).toEqual({ status: "error" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{broken", { status: 200 })));
    expect(await readFindingDestination(ENGAGEMENT, resume, new AbortController().signal)).toEqual({ status: "error" });
  });

  it("never requests an invalid id, another engagement's destination, or an already cancelled arrival", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    expect(await readFindingDestination(ENGAGEMENT, { ...resume, findingId: "../unsafe" }, controller.signal)).toEqual({ status: "error" });
    expect(await readFindingDestination(OTHER, resume, controller.signal)).toBeNull();
    controller.abort();
    expect(await readFindingDestination(ENGAGEMENT, resume, controller.signal)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)("ignores a late %s from a superseded arrival even when fetch ignores abort", async (completion) => {
    let complete: (() => void) | undefined;
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve, reject) => {
      complete = () => completion === "resolve" ? resolve(response([saved])) : reject(new Error("Late failure"));
    })).mockResolvedValueOnce(response([{ ...saved, engagementId: OTHER, title: "Other lab current claim" }]));
    vi.stubGlobal("fetch", fetchMock);
    const first = new AbortController();
    const oldRead = readFindingDestination(ENGAGEMENT, resume, first.signal);
    first.abort();
    const next = await readFindingDestination(OTHER, { ...resume, engagementId: OTHER, nonce: 2 }, new AbortController().signal);
    expect(next?.status).toBe("found");
    if (next?.status === "found") expect(next.finding.engagementId).toBe(OTHER);
    complete?.();
    expect(await oldRead).toBeNull();
  });
});
