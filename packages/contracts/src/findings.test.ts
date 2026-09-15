import { describe, expect, it } from "vitest";

import {
  CreateFindingRequestSchema,
  FINDING_BODY_MAX_BYTES,
  FindingIdParamsSchema,
  FindingListResponseSchema,
  FindingMutationErrorSchema,
  FindingQueryErrorSchema,
  FindingResponseSchema,
  UpdateFindingRequestSchema,
} from "./findings.js";

const engagementId = "10000000-0000-4000-8000-000000000001";
const findingId = "20000000-0000-4000-8000-000000000001";

function validFinding() {
  return {
    contractVersion: 1,
    id: findingId,
    engagementId,
    title: "Default credentials on admin panel",
    severity: "high",
    status: "open",
    body: "# impact\nAdmin access allows config change.",
    evidenceArtifactIds: ["nmap-xml-1"],
    revision: 1,
    createdAt: "2026-08-12T12:00:00.000Z",
    updatedAt: "2026-08-12T12:00:00.000Z",
  };
}

describe("findings contracts", () => {
  it("accepts a minimal finding with defaults", () => {
    expect(
      CreateFindingRequestSchema.parse({
        title: "Open port with banner",
        severity: "info",
        body: "",
      }),
    ).toEqual({
      title: "Open port with banner",
      severity: "info",
      body: "",
      evidenceArtifactIds: [],
    });
    expect(FindingResponseSchema.parse(validFinding())).toMatchObject({
      id: findingId,
      status: "open",
    });
    expect(FindingListResponseSchema.parse([validFinding()])).toHaveLength(1);
    expect(
      FindingIdParamsSchema.parse({ engagementId, findingId }).findingId,
    ).toBe(findingId);
  });

  it("accepts every severity and both statuses", () => {
    for (const severity of ["info", "low", "medium", "high", "critical"]) {
      expect(
        CreateFindingRequestSchema.safeParse({
          title: "Finding",
          severity,
          body: "body",
        }).success,
      ).toBe(true);
    }
    for (const status of ["open", "resolved"]) {
      expect(
        FindingResponseSchema.safeParse({ ...validFinding(), status }).success,
      ).toBe(true);
    }
  });

  it("rejects blank titles, oversize bodies, and bad evidence refs", () => {
    expect(
      CreateFindingRequestSchema.safeParse({
        title: "  padded  ",
        severity: "low",
        body: "",
      }).success,
    ).toBe(false);
    expect(
      CreateFindingRequestSchema.safeParse({
        title: "",
        severity: "low",
        body: "",
      }).success,
    ).toBe(false);
    expect(
      CreateFindingRequestSchema.safeParse({
        title: "Finding",
        severity: "low",
        body: "a".repeat(FINDING_BODY_MAX_BYTES + 1),
      }).success,
    ).toBe(false);
    expect(
      CreateFindingRequestSchema.safeParse({
        title: "Finding",
        severity: "low",
        body: "",
        evidenceArtifactIds: ["Bad_Id"],
      }).success,
    ).toBe(false);
    expect(
      CreateFindingRequestSchema.safeParse({
        title: "Finding",
        severity: "low",
        body: "",
        evidenceArtifactIds: Array.from({ length: 33 }, (_, index) => `a-${index}`),
      }).success,
    ).toBe(false);
    expect(
      CreateFindingRequestSchema.safeParse({
        title: "Finding",
        severity: "low",
        body: "",
        extra: true,
      }).success,
    ).toBe(false);
  });

  it("requires title, severity, body, and expectedRevision for updates", () => {
    expect(
      UpdateFindingRequestSchema.parse({
        title: "Corrected title",
        severity: "high",
        body: "# impact\nConfirmed.",
        expectedRevision: 2,
      }),
    ).toEqual({
      title: "Corrected title",
      severity: "high",
      body: "# impact\nConfirmed.",
      expectedRevision: 2,
    });
    expect(
      UpdateFindingRequestSchema.safeParse({
        title: "Corrected title",
        severity: "high",
        body: "",
      }).success,
    ).toBe(false);
    expect(
      UpdateFindingRequestSchema.safeParse({
        title: "  padded  ",
        severity: "high",
        body: "",
        expectedRevision: 1,
      }).success,
    ).toBe(false);
    expect(
      UpdateFindingRequestSchema.safeParse({
        title: "Corrected title",
        severity: "high",
        body: "",
        expectedRevision: -1,
      }).success,
    ).toBe(false);
  });

  it("covers finding query and mutation error codes", () => {    expect(FindingQueryErrorSchema.parse({ code: "finding_not_found" })).toEqual({
      code: "finding_not_found",
    });
    expect(
      FindingMutationErrorSchema.parse({ code: "engagement_archived" }),
    ).toEqual({ code: "engagement_archived" });
    expect(
      FindingMutationErrorSchema.parse({ code: "invalid_finding_transition" }),
    ).toEqual({ code: "invalid_finding_transition" });
    expect(
      FindingMutationErrorSchema.parse({
        code: "revision_conflict",
        resourceType: "finding",
        resourceId: findingId,
        currentRevision: 4,
      }),
    ).toEqual({
      code: "revision_conflict",
      resourceType: "finding",
      resourceId: findingId,
      currentRevision: 4,
    });
  });
});
