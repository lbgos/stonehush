import { afterEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "./query-client.js";
import {
  ADVISOR_STATUS_QUERY_ERROR_MESSAGE,
  ADVISOR_STATUS_QUERY_KEY,
  advisorStatusQueryOptions,
  AdvisorStatusQueryError,
} from "./advisor-status-query.js";

const okStatus = {
  configured: true,
  endpointReachable: true,
  modelId: "qwen3:8b",
  endpointHost: "127.0.0.1",
  publicEndpoint: false,
  optIn: false,
  keyEnvVar: "STONEHUSH_ADVISOR_API_KEY",
  keyPresent: true,
  latencyMs: 12,
  reason: "ok",
};

function response(payload: unknown, status = 200): Response {
  return {
    json: async () => payload,
    ok: status >= 200 && status < 300,
    status,
  } as Response;
}

async function captureQueryError(): Promise<Error> {
  const client = createAppQueryClient();
  try {
    await client.fetchQuery(advisorStatusQueryOptions);
    throw new Error("Expected the advisor status query to fail.");
  } catch (error) {
    return error as Error;
  } finally {
    client.clear();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("advisorStatusQueryOptions", () => {
  it("uses a stable key, an abort signal, and the shared status contract", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve(response(okStatus));
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = createAppQueryClient();

    await expect(client.fetchQuery(advisorStatusQueryOptions)).resolves.toEqual(okStatus);
    expect(advisorStatusQueryOptions.queryKey).toBe(ADVISOR_STATUS_QUERY_KEY);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/advisor/status",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    client.clear();
  });

  it.each([500, 503])("rejects status %d without reading the body", async (status) => {
    const readBody = vi.fn(() => Promise.resolve({ token: "body-secret" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({ json: readBody, ok: false, status } as unknown as Response),
      ),
    );

    const error = await captureQueryError();

    expect(readBody).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(AdvisorStatusQueryError);
    expect(error.message).toBe(ADVISOR_STATUS_QUERY_ERROR_MESSAGE);
  });

  it("rejects a malformed body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(response({ ...okStatus, reason: "connected" }))),
    );

    const error = await captureQueryError();

    expect(error).toBeInstanceOf(AdvisorStatusQueryError);
  });

  it("replaces network details with one safe error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("GET /api?token=secret failed"))),
    );

    const error = await captureQueryError();

    expect(error).toBeInstanceOf(AdvisorStatusQueryError);
    expect(error.message).toBe(ADVISOR_STATUS_QUERY_ERROR_MESSAGE);
    expect(error.message).not.toContain("secret");
    expect(error.cause).toBeUndefined();
  });
});
