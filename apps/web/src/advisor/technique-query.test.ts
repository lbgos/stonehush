import { describe, expect, it, vi, afterEach } from "vitest";

import {
  isTechniqueSaveRefused,
  parseTechniqueMutationError,
  saveTechniqueRequest,
  type SaveTechniqueInput,
} from "./technique-query.js";

const ENGAGEMENT_ID = "10000000-0000-4000-8000-000000000001";
const TS = "2026-10-01T12:00:00.000Z";

const input: SaveTechniqueInput = {
  name: "Default creds",
  whenUseful: "",
  prerequisites: [],
  question: "Does the vendor default work?",
  procedure: [{ instruction: "Open the login form." }],
  meaning: "",
};

function saved(body: Record<string, unknown>) {
  return {
    contractVersion: 1,
    id: "60000000-0000-4000-8000-000000000001",
    engagementId: ENGAGEMENT_ID,
    ...body,
    createdAt: TS,
    updatedAt: TS,
  };
}

function response(payload: unknown, status = 200): Response {
  return { json: async () => payload, ok: status >= 200 && status < 300, status } as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("parseTechniqueMutationError", () => {
  it("keeps the server code for refusals", () => {
    expect(parseTechniqueMutationError({ code: "engagement_archived" }).code).toBe("engagement_archived");
    expect(parseTechniqueMutationError({ code: "invalid_request" }).code).toBe("invalid_request");
  });

  it("falls back to request_failed for unreadable bodies", () => {
    expect(parseTechniqueMutationError({}).code).toBe("request_failed");
    expect(parseTechniqueMutationError(null).code).toBe("request_failed");
  });
});

describe("isTechniqueSaveRefused", () => {
  it("treats explicit refusals as safely retryable", () => {
    for (const code of ["invalid_request", "engagement_not_found", "engagement_archived", "storage_busy"]) {
      expect(isTechniqueSaveRefused(code)).toBe(true);
    }
  });

  it("treats network and unreadable outcomes as unknown", () => {
    for (const code of ["request_failed", "invalid_persisted_data", "owner_mismatch", "bogus"]) {
      expect(isTechniqueSaveRefused(code)).toBe(false);
    }
  });
});

describe("saveTechniqueRequest", () => {
  it("posts the contract body and returns the technique for its own engagement", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(response(saved({ ...input }), 201)));
    vi.stubGlobal("fetch", fetchMock);
    const technique = await saveTechniqueRequest(ENGAGEMENT_ID, input);
    expect(technique.engagementId).toBe(ENGAGEMENT_ID);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const init = call[1];
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(input);
  });

  it("keeps the archived code instead of a generic failure", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response({ code: "engagement_archived" }, 409))));
    const error = await saveTechniqueRequest(ENGAGEMENT_ID, input).catch((value: unknown) => value);
    expect(error).toMatchObject({ name: "TechniqueRequestError", code: "engagement_archived" });
  });

  it("reports a network failure as request_failed for the unknown-outcome path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down"))),
    );
    const error = await saveTechniqueRequest(ENGAGEMENT_ID, input).catch((value: unknown) => value);
    expect(error).toMatchObject({ name: "TechniqueRequestError", code: "request_failed" });
  });
});
