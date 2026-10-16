// @vitest-environment jsdom

import type { Engagement } from "@stonehush/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import {
  EngagementMutationClientError,
  ENGAGEMENT_MUTATION_ERROR_COPY,
} from "./errors.js";
import { createIdempotencyKey, createIntentKeyHolder, requestFingerprint } from "./idempotency.js";
import {
  appendScopeRevisionRequest,
  archiveEngagementRequest,
  createEngagementRequest,
  reopenEngagementRequest,
  sendEngagementMutation,
  upsertEngagementInCache,
  useCreateEngagementMutation,
  useArchiveEngagementMutation,
  useReopenEngagementMutation,
  useUpdateDeadlineMutation,
} from "./mutations.js";
import { ENGAGEMENTS_QUERY_KEY, engagementDetailQueryKey, useEngagementsQuery } from "./query.js";

const engagement = {
  contractVersion: 1 as const,
  id: "10000000-0000-4000-8000-000000000001",
  revision: 1,
  name: "Target lab",
  kind: "lab" as const,
  status: "active" as const,
  description: null,
  authorizationContext: null,
  autoContinueWarnings: false,
  activeScopeRevisionId: null,
  deadlineAt: null,
  createdAt: "2026-08-12T12:00:00.000Z",
  updatedAt: "2026-08-12T12:00:00.000Z",
};

function response(payload: unknown, status = 200): Response {
  return {
    json: async () => payload,
    ok: status >= 200 && status < 300,
    status,
  } as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("idempotency keys", () => {
  it("accepts a generated UUID against the shared key contract", () => {
    const key = createIdempotencyKey(() => "11111111-1111-4111-8111-111111111111");
    expect(key).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("reuses one key per operator intent and rotates when the payload changes", () => {
    let sequence = 0;
    const holder = createIntentKeyHolder(() => `intent-key-${String(++sequence).padStart(16, "0")}`);
    const first = { name: "Target lab", kind: "lab", autoContinueWarnings: false };
    const second = { ...first, name: "Other lab" };

    const original = holder.keyFor(requestFingerprint(first));
    expect(holder.keyFor(requestFingerprint(first))).toBe(original);
    expect(holder.keyFor(requestFingerprint(second))).not.toBe(original);
    holder.reset(requestFingerprint(first));
    expect(holder.keyFor(requestFingerprint(first))).not.toBe(original);
  });
});

describe("engagement mutations", () => {
  it("posts a create request with one Idempotency-Key and validates the response", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(response(engagement, 201)));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createEngagementRequest(
        { name: "Target lab", kind: "lab", autoContinueWarnings: false },
        "create-key-000000000001",
      ),
    ).resolves.toEqual(engagement);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/engagements",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "create-key-000000000001",
        },
        body: JSON.stringify({
          name: "Target lab",
          kind: "lab",
          description: null,
          authorizationContext: null,
          autoContinueWarnings: false,
        }),
      }),
    );
  });

  it("archives and reopens with the displayed revision", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ ...engagement, status: "archived", revision: 2 }))
      .mockResolvedValueOnce(response({ ...engagement, status: "active", revision: 3 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      archiveEngagementRequest(engagement.id, 1, "archive-key-00000000001"),
    ).resolves.toMatchObject({ status: "archived", revision: 2 });
    await expect(
      reopenEngagementRequest(engagement.id, 2, "reopen-key-000000000002"),
    ).resolves.toMatchObject({ status: "active", revision: 3 });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/api/v1/engagements/${engagement.id}/archive`,
      expect.objectContaining({
        body: JSON.stringify({ expectedRevision: 1 }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/v1/engagements/${engagement.id}/reopen`,
      expect.objectContaining({
        body: JSON.stringify({ expectedRevision: 2 }),
      }),
    );
  });

  it("maps a revision conflict and rejects extra untrusted error fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          response(
            {
              code: "revision_conflict",
              resourceType: "engagement",
              resourceId: engagement.id,
              currentRevision: 4,
            },
            409,
          ),
        ),
      ),
    );

    await expect(
      archiveEngagementRequest(engagement.id, 1, "stale-key-0000000000003"),
    ).rejects.toMatchObject({
      code: "revision_conflict",
      currentRevision: 4,
      message: ENGAGEMENT_MUTATION_ERROR_COPY.revision_conflict,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          response(
            {
              code: "revision_conflict",
              resourceType: "engagement",
              resourceId: engagement.id,
              currentRevision: 4,
              path: "/private/data",
            },
            409,
          ),
        ),
      ),
    );
    await expect(
      archiveEngagementRequest(engagement.id, 1, "stale-key-0000000000004"),
    ).rejects.toMatchObject({
      code: "request_failed",
      message: ENGAGEMENT_MUTATION_ERROR_COPY.request_failed,
    });
  });

  it("does not read unsupported status bodies and hides network details", async () => {
    const readBody = vi.fn(() => Promise.resolve({ token: "body-secret" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ json: readBody, ok: false, status: 418 } as unknown as Response)),
    );

    await expect(
      createEngagementRequest(
        { name: "Target lab", kind: "lab", autoContinueWarnings: false },
        "teapot-key-000000000004",
      ),
    ).rejects.toBeInstanceOf(EngagementMutationClientError);
    expect(readBody).not.toHaveBeenCalled();

    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("POST /api?token=secret failed"))),
    );
    await expect(
      createEngagementRequest(
        { name: "Target lab", kind: "lab", autoContinueWarnings: false },
        "net-key-00000000000005",
      ),
    ).rejects.toMatchObject({ message: ENGAGEMENT_MUTATION_ERROR_COPY.request_failed });
  });

  it("inserts or replaces a validated record and keeps createdAt order", () => {
    const client = createAppQueryClient();
    const later = {
      ...engagement,
      id: "10000000-0000-4000-8000-000000000002",
      createdAt: "2026-08-12T13:00:00.000Z",
      name: "Later lab",
    };
    upsertEngagementInCache(client, later);
    upsertEngagementInCache(client, engagement);
    upsertEngagementInCache(client, { ...engagement, revision: 2, name: "Target lab" });
    expect(client.getQueryData(ENGAGEMENTS_QUERY_KEY)).toEqual([
      { ...engagement, revision: 2, name: "Target lab" },
      later,
    ]);
    client.clear();
  });

  it("retains the complete newer record when an older lifecycle revision arrives", () => {
    const client = createAppQueryClient();
    const newer: Engagement = {
      ...engagement,
      revision: 4,
      deadlineAt: "2026-10-20T12:00:00.000Z",
      updatedAt: "2026-10-16T05:00:00.000Z",
    };
    const other = { ...engagement, id: "10000000-0000-4000-8000-000000000002" };
    const listed = [newer, other];
    const detail = { engagement: newer, activeScopeRevision: null };
    client.setQueryData(ENGAGEMENTS_QUERY_KEY, listed);
    client.setQueryData(engagementDetailQueryKey(engagement.id), detail);

    upsertEngagementInCache(client, {
      ...engagement,
      revision: 3,
      status: "archived",
      // Clock order is not revision authority.
      updatedAt: "2026-10-16T06:00:00.000Z",
    });

    expect(client.getQueryData(ENGAGEMENTS_QUERY_KEY)).toEqual(listed);
    expect(client.getQueryData(engagementDetailQueryKey(engagement.id))).toEqual(detail);
    client.clear();
  });

  it("keeps existing replacement semantics for equal revisions and accepts a newer revision", () => {
    const client = createAppQueryClient();
    upsertEngagementInCache(client, engagement);
    const equal = { ...engagement, deadlineAt: "2026-10-20T12:00:00.000Z" };
    upsertEngagementInCache(client, equal);
    expect(client.getQueryData(ENGAGEMENTS_QUERY_KEY)).toEqual([equal]);
    const newer: Engagement = { ...engagement, revision: 2, status: "archived" };
    upsertEngagementInCache(client, newer);
    expect(client.getQueryData(ENGAGEMENTS_QUERY_KEY)).toEqual([newer]);
    client.clear();
  });

  it("inserts missing records by creation time then ID without comparing unrelated revisions", () => {
    const client = createAppQueryClient();
    const other = { ...engagement, id: "10000000-0000-4000-8000-000000000002", revision: 8 };
    client.setQueryData(ENGAGEMENTS_QUERY_KEY, [other]);
    upsertEngagementInCache(client, engagement);
    expect(client.getQueryData(ENGAGEMENTS_QUERY_KEY)).toEqual([engagement, other]);
    client.clear();
  });

  it.each(["archive", "reopen", "deadline"] as const)(
    "retains the complete newer list record after a delayed %s mutation succeeds",
    async (operation) => {
      const client = createAppQueryClient();
      const newer: Engagement = {
        ...engagement,
        revision: 5,
        status: operation === "reopen" ? "archived" : "active",
        deadlineAt: "2026-10-20T12:00:00.000Z",
        updatedAt: "2026-10-16T05:00:00.000Z",
      };
      let deliver!: (value: Response) => void;
      const delayed = new Promise<Response>((resolve) => { deliver = resolve; });
      vi.stubGlobal("fetch", vi.fn(() => delayed));
      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children);
      const { result, unmount } = renderHook(() => ({
        archive: useArchiveEngagementMutation(),
        reopen: useReopenEngagementMutation(),
        deadline: useUpdateDeadlineMutation(),
      }), { wrapper });
      result.current[operation].mutate({
        engagementId: engagement.id,
        expectedRevision: 2,
        deadlineAt: null,
      });
      await waitFor(() => expect(result.current[operation].isPending).toBe(true));
      client.setQueryData(ENGAGEMENTS_QUERY_KEY, [newer]);
      deliver(response({
        ...engagement,
        revision: 3,
        status: operation === "archive" ? "archived" : "active",
      }));
      await waitFor(() => expect(result.current[operation].isSuccess).toBe(true));
      expect(client.getQueryData(ENGAGEMENTS_QUERY_KEY)).toEqual([newer]);
      unmount();
      client.clear();
    },
  );

  it("keeps a legitimate reopen after another archive conflict refreshes a pending archive", async () => {
    const client = createAppQueryClient();
    const archived: Engagement = { ...engagement, revision: 2, status: "archived" };
    const reopened: Engagement = {
      ...archived, revision: 3, status: "active", updatedAt: "2026-10-16T05:00:00.000Z",
    };
    let stored = engagement as Engagement;
    let deliver!: (value: Response) => void;
    const delayed = new Promise<Response>((resolve) => { deliver = resolve; });
    let archives = 0;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith("/archive")) {
        expect(JSON.parse(String(init?.body))).toEqual({ expectedRevision: 1 });
        if (++archives === 1) { stored = archived; return delayed; }
        return Promise.resolve(response({
          code: "revision_conflict", resourceType: "engagement",
          resourceId: engagement.id, currentRevision: 2,
        }, 409));
      }
      if (url.endsWith("/reopen")) {
        expect(JSON.parse(String(init?.body))).toEqual({ expectedRevision: 2 });
        stored = reopened;
        return Promise.resolve(response(reopened));
      }
      expect(url).toBe("/api/v1/engagements");
      return Promise.resolve(response([stored]));
    });
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { result, unmount } = renderHook(() => ({
      list: useEngagementsQuery(),
      headerArchive: useArchiveEngagementMutation(),
      sidebarArchive: useArchiveEngagementMutation(),
      reopen: useReopenEngagementMutation(),
    }), { wrapper });
    await waitFor(() => expect(result.current.list.data).toEqual([engagement]));
    const input = { engagementId: engagement.id, expectedRevision: 1 };
    result.current.headerArchive.mutate(input);
    await waitFor(() => expect(archives).toBe(1));
    result.current.sidebarArchive.mutate(input);
    await waitFor(() => expect(result.current.list.data).toEqual([archived]));
    expect(result.current.headerArchive.isPending).toBe(true);
    result.current.reopen.mutate({ ...input, expectedRevision: 2 });
    await waitFor(() => expect(result.current.reopen.isSuccess).toBe(true));
    expect(client.getQueryData(ENGAGEMENTS_QUERY_KEY)).toEqual([reopened]);
    deliver(response(archived));
    await waitFor(() => expect(result.current.headerArchive.isSuccess).toBe(true));
    expect(client.getQueryData(ENGAGEMENTS_QUERY_KEY)).toEqual([reopened]);
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/archive"))).toHaveLength(2);
    unmount();
    client.clear();
  });

  it("reuses the same create idempotency key across an ordinary retry", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(response(engagement, 201));
    vi.stubGlobal("fetch", fetchMock);
    const client = createAppQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => useCreateEngagementMutation(), { wrapper });
    const input = { name: "Target lab", kind: "lab" as const, autoContinueWarnings: false };

    result.current.mutate(input);
    await waitFor(() => expect(result.current.isError).toBe(true));
    result.current.mutate(input);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const keys = fetchMock.mock.calls.map((call) => {
      const init = call[1] as RequestInit;
      return (init.headers as Record<string, string>)["Idempotency-Key"];
    });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    client.clear();
  });

  it("reuses the create key for reordered equivalent targets", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(() => Promise.resolve(response(engagement, 201)));
    vi.stubGlobal("fetch", fetchMock);
    const client = createAppQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => useCreateEngagementMutation(), { wrapper });
    const input = { name: "Target lab", kind: "lab" as const, autoContinueWarnings: false };

    result.current.mutate({ ...input, targets: ["198.51.100.10", "192.0.2.10"] });
    await waitFor(() => expect(result.current.isError).toBe(true));
    result.current.mutate({ ...input, targets: ["192.0.2.10", "198.51.100.10"] });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const keys = fetchMock.mock.calls.map((call) => {
      const init = call[1] as RequestInit;
      return (init.headers as Record<string, string>)["Idempotency-Key"];
    });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    client.clear();
  });
});

describe("scope revision mutations", () => {
  const scopeRevision = {
    contractVersion: 1 as const,
    id: "20000000-0000-4000-8000-000000000010",
    engagementId: engagement.id,
    version: 1,
    rules: [
      {
        id: "30000000-0000-4000-8000-000000000001",
        kind: "ip" as const,
        target: {
          kind: "ip" as const,
          normalizationProfile: "d1-v1" as const,
          family: 4 as const,
          address: "198.51.100.10",
          zone: null,
        },
      },
    ],
    createdAt: "2026-08-12T12:07:00.000Z",
  };

  it("posts canonical rules and does not parse the response as an engagement", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(response(scopeRevision, 201)));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      appendScopeRevisionRequest(
        engagement.id,
        { expectedRevision: 1, rules: scopeRevision.rules },
        "scope-key-0000000000001",
      ),
    ).resolves.toEqual(scopeRevision);

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/engagements/${engagement.id}/scope-revisions`,
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "scope-key-0000000000001",
        },
        body: JSON.stringify({
          expectedRevision: 1,
          rules: scopeRevision.rules,
        }),
      }),
    );

    await expect(
      sendEngagementMutation(
        `/api/v1/engagements/${engagement.id}/scope-revisions`,
        {
          body: { expectedRevision: 1, rules: scopeRevision.rules },
          idempotencyKey: "wrong-parser-0000000002",
        },
      ),
    ).rejects.toMatchObject({
      code: "invalid_persisted_data",
    });
  });
});
