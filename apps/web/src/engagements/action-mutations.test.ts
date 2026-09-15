// @vitest-environment jsdom

import { PersistedActionSchema, type PersistedAction } from "@stonehush/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../query-client.js";
import {
  addScopeAndRunActionRequest,
  cancelActionRequest,
  continueActionRequest,
  createActionRequest,
  useCreateActionMutation,
} from "./action-mutations.js";
import { ENGAGEMENT_MUTATION_ERROR_COPY } from "./errors.js";
import { sendEngagementMutation } from "./mutations.js";

const ACTION_ID = "40000000-0000-4000-8000-000000000001";
const ENGAGEMENT_ID = "10000000-0000-4000-8000-000000000001";
const BINDING = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const ipv4Target = {
  kind: "ip" as const,
  normalizationProfile: "d1-v1" as const,
  family: 4 as const,
  address: "192.0.2.10",
  zone: null,
};

const queuedAction: PersistedAction = PersistedActionSchema.parse({
  contractVersion: 1,
  engagementId: ENGAGEMENT_ID,
  revision: 1,
  warningAcknowledgmentId: null,
  createdAt: "2026-08-12T12:10:00.000Z",
  updatedAt: "2026-08-12T12:10:00.000Z",
  action: {
    orchestrationProfile: "d2-v1",
    actionId: ACTION_ID,
    state: "queued",
    snapshots: [
      {
        normalizationProfile: "d1-v1",
        orchestrationProfile: "d2-v1",
        snapshotId: "40000000-0000-4000-8000-000000000002",
        version: 1,
        binding: BINDING,
        actionId: ACTION_ID,
        canonicalTargets: [ipv4Target],
        concreteDestinations: [ipv4Target],
        typedOptions: { declaredPorts: null },
        resolutionSnapshots: [],
        scopeRevisionId: null,
        warningState: {
          reasonCodes: [],
          knownAdditions: [],
          acknowledgment: null,
        },
      },
    ],
    queuedSnapshotVersion: 1,
    warningAcknowledgment: null,
    pendingWarning: null,
    coveredDestinations: [],
    warningInteractions: 0,
    runState: null,
    resumeRequested: false,
    cleanupRequired: false,
    capabilityErrorCode: null,
  },
});

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

describe("action mutations", () => {
  it("posts create-action with an Idempotency-Key and does not parse it as an engagement", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(response(queuedAction, 201)));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createActionRequest(
        ENGAGEMENT_ID,
        {
          expectedEngagementRevision: 1,
          expectedActiveScopeRevisionId: null,
          targets: ["192.0.2.10"],
          declaredPorts: [22, 80, 443],
        },
        "action-key-000000000001",
      ),
    ).resolves.toEqual(queuedAction);

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/engagements/${ENGAGEMENT_ID}/actions`,
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "action-key-000000000001",
        },
        body: JSON.stringify({
          expectedEngagementRevision: 1,
          expectedActiveScopeRevisionId: null,
          targets: ["192.0.2.10"],
          declaredPorts: [22, 80, 443],
        }),
      }),
    );

    await expect(
      sendEngagementMutation(`/api/v1/engagements/${ENGAGEMENT_ID}/actions`, {
        body: {
          expectedEngagementRevision: 1,
          expectedActiveScopeRevisionId: null,
          targets: ["192.0.2.10"],
        },
        idempotencyKey: "wrong-parser-0000000003",
      }),
    ).rejects.toMatchObject({
      code: "invalid_persisted_data",
    });
  });

  it("continues, adds to scope, and cancels with the persisted action binding", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(response(queuedAction)));
    vi.stubGlobal("fetch", fetchMock);

    await continueActionRequest(
      ENGAGEMENT_ID,
      ACTION_ID,
      {
        expectedRevision: 1,
        snapshotVersion: 1,
        snapshotBinding: BINDING,
      },
      "continue-key-0000000001",
    );
    await addScopeAndRunActionRequest(
      ENGAGEMENT_ID,
      ACTION_ID,
      {
        expectedEngagementRevision: 2,
        expectedActionRevision: 1,
        rules: [],
      },
      "add-key-00000000000002",
    );
    await cancelActionRequest(
      ENGAGEMENT_ID,
      ACTION_ID,
      { expectedRevision: 1 },
      "cancel-key-000000000003",
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `/api/v1/engagements/${ENGAGEMENT_ID}/actions/${ACTION_ID}/continue`,
      expect.objectContaining({
        body: JSON.stringify({
          expectedRevision: 1,
          snapshotVersion: 1,
          snapshotBinding: BINDING,
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/v1/engagements/${ENGAGEMENT_ID}/actions/${ACTION_ID}/add-scope-and-run`,
      expect.objectContaining({
        body: JSON.stringify({
          expectedEngagementRevision: 2,
          expectedActionRevision: 1,
          rules: [],
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      `/api/v1/engagements/${ENGAGEMENT_ID}/actions/${ACTION_ID}/cancel`,
      expect.objectContaining({
        body: JSON.stringify({ expectedRevision: 1 }),
      }),
    );
  });

  it("maps action-specific errors without reflecting extra fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          response(
            {
              code: "capability_error_not_overridable",
              path: "/private/data",
            },
            409,
          ),
        ),
      ),
    );

    await expect(
      continueActionRequest(
        ENGAGEMENT_ID,
        ACTION_ID,
        {
          expectedRevision: 1,
          snapshotVersion: 1,
          snapshotBinding: BINDING,
        },
        "cap-key-00000000000004",
      ),
    ).rejects.toMatchObject({
      code: "request_failed",
      message: ENGAGEMENT_MUTATION_ERROR_COPY.request_failed,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(response({ code: "capability_error_not_overridable" }, 409)),
      ),
    );
    await expect(
      continueActionRequest(
        ENGAGEMENT_ID,
        ACTION_ID,
        {
          expectedRevision: 1,
          snapshotVersion: 1,
          snapshotBinding: BINDING,
        },
        "cap-key-00000000000005",
      ),
    ).rejects.toMatchObject({
      code: "capability_error_not_overridable",
    });
  });

  it("reuses one create idempotency key across an ordinary retry", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(response(queuedAction, 201));
    vi.stubGlobal("fetch", fetchMock);
    const client = createAppQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => useCreateActionMutation(), { wrapper });

    result.current.mutate({
      engagementId: ENGAGEMENT_ID,
      expectedEngagementRevision: 1,
      expectedActiveScopeRevisionId: null,
      targets: ["192.0.2.10"],
      declaredPorts: null,
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    result.current.mutate({
      engagementId: ENGAGEMENT_ID,
      expectedEngagementRevision: 1,
      expectedActiveScopeRevisionId: null,
      targets: ["192.0.2.10"],
      declaredPorts: null,
    });
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
