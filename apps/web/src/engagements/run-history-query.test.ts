import {
  encodeRunHistoryCursor,
  type RunHistoryResponse,
  type RunHistorySummary,
} from "@stonehush/contracts";
import { skipToken } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import {
  RUN_HISTORY_QUERY_ERROR_MESSAGE,
  RunHistoryQueryError,
  fetchRunHistoryPage,
  runHistoryInfiniteQueryOptions,
  runHistoryListUrl,
  runHistoryQueryKey,
} from "./run-history-query.js";

const summary: RunHistorySummary = {
  id: "run-1",
  actionId: "action-1",
  state: "succeeded",
  terminalKind: "succeeded",
  terminalReason: null,
  updatedAt: "2026-08-09T12:00:00.000Z",
  createdAt: "2026-08-09T12:00:00.000Z",
  attempt: 1,
};

function page(nextCursor: string | null = null): RunHistoryResponse {
  return { runs: [summary], nextCursor };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("run history query", () => {
  it("requests the initial page with the bounded default limit", async () => {
    expect(runHistoryListUrl("eng-1")).toBe("/api/v1/engagements/eng-1/runs?limit=25");
    const fetchMock = vi.fn(async () => ({ status: 200, json: async () => page() }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    const client = createAppQueryClient();

    await expect(client.fetchInfiniteQuery(runHistoryInfiniteQueryOptions("eng-1"))).resolves.toMatchObject({
      pages: [page()],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/engagements/eng-1/runs?limit=25",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    client.clear();
  });

  it("forwards the opaque cursor verbatim on the next page", async () => {
    const cursor = encodeRunHistoryCursor({
      engagementId: "eng-1",
      createdAt: "2026-08-09T12:00:00.000Z",
      id: "run-2",
    });
    const fetchMock = vi.fn(async () => ({ status: 200, json: async () => page(null) }) as Response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchRunHistoryPage("eng-1", { before: cursor }, new AbortController().signal),
    ).resolves.toEqual(page(null));
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/engagements/eng-1/runs?limit=25&before=${encodeURIComponent(cursor)}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    const options = runHistoryInfiniteQueryOptions("eng-1");
    expect(options.initialPageParam).toBeUndefined();
    expect(options.getNextPageParam(page(cursor), [page(cursor)], undefined, [undefined])).toBe(cursor);
    expect(options.getNextPageParam(page(null), [page(null)], undefined, [undefined])).toBeUndefined();
  });

  it("isolates cache entries per engagement and page size", () => {
    expect(runHistoryQueryKey("eng-1")).toEqual(["engagements", "eng-1", "runs"]);
    expect(runHistoryQueryKey("eng-1")).not.toEqual(runHistoryQueryKey("eng-2"));
    expect(runHistoryInfiniteQueryOptions("eng-1").queryKey).toEqual([
      "engagements",
      "eng-1",
      "runs",
      25,
    ]);
    expect(runHistoryInfiniteQueryOptions("eng-1").queryKey).not.toEqual(
      runHistoryInfiniteQueryOptions("eng-2").queryKey,
    );
    expect(runHistoryInfiniteQueryOptions("eng-1", 25).queryKey).not.toEqual(
      runHistoryInfiniteQueryOptions("eng-1", 50).queryKey,
    );
  });

  it("disables the infinite query without fetching when no engagement is selected", async () => {
    const fetchMock = vi.fn(async () => ({ status: 200, json: async () => page() }) as Response);
    vi.stubGlobal("fetch", fetchMock);

    const options = runHistoryInfiniteQueryOptions(undefined);
    expect(options.queryFn).toBe(skipToken);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps invalid responses to one safe error without leaking details", async () => {
    const readBody = vi.fn(async () => ({ token: "body-secret" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ json: readBody, status: 500 }) as unknown as Response),
    );
    await expect(fetchRunHistoryPage("eng-1")).rejects.toBeInstanceOf(RunHistoryQueryError);
    expect(readBody).not.toHaveBeenCalled();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 200, json: async () => ({ runs: [{ ...summary, id: 7 }] }) }) as Response),
    );
    await expect(fetchRunHistoryPage("eng-1")).rejects.toMatchObject({
      name: "RunHistoryQueryError",
      message: RUN_HISTORY_QUERY_ERROR_MESSAGE,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("GET /api?token=secret failed at /private/path");
      }),
    );
    const error: unknown = await fetchRunHistoryPage("eng-1").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(RunHistoryQueryError);
    if (!(error instanceof Error)) throw new Error("Expected an error instance.");
    expect(error.message).toBe(RUN_HISTORY_QUERY_ERROR_MESSAGE);
    expect(error.message).not.toContain("secret");
    expect(error.cause).toBeUndefined();
  });

  it("rethrows cancellation instead of a safe error when the query is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw abortError;
      }),
    );

    await expect(fetchRunHistoryPage("eng-1", {}, controller.signal)).rejects.toBe(
      abortError,
    );
  });
});
