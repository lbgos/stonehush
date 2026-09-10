import { describe, expect, it } from "vitest";

import {
  AttachLeadAttemptRequestSchema,
  CloseLeadRequestSchema,
  CreateLeadAttemptRequestSchema,
  CreateLeadRequestSchema,
  LeadResponseSchema,
  ParkLeadRequestSchema,
  SuggestLeadRevisitRequestSchema,
} from "./leads.js";

const LEAD_ID = "10000000-0000-4000-8000-000000000001";
const ENGAGEMENT_ID = "10000000-0000-4000-8000-000000000002";

function leadRecord(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: 1,
    id: LEAD_ID,
    engagementId: ENGAGEMENT_ID,
    title: "Odd login form on port 8080",
    target: "192.0.2.10",
    serviceRef: "192.0.2.10:8080/tcp",
    source: { kind: "http_probe", ref: "probe-artifact-1", label: "8080 login" },
    nextStep: "Try default credentials over TLS",
    disposition: "open",
    parkReason: null,
    testedConditions: null,
    closedNote: null,
    revisitSuggestion: null,
    createdAt: "2026-08-12T12:00:00.000Z",
    updatedAt: "2026-08-12T12:00:00.000Z",
    ...overrides,
  };
}

describe("lead contracts", () => {
  it("creates a bookmark-effort lead from a result with source attached", () => {
    const result = CreateLeadRequestSchema.safeParse({
      title: "Odd login form on port 8080",
      target: "192.0.2.10",
      source: { kind: "http_probe", ref: "probe-artifact-1" },
    });
    expect(result.success).toBe(true);
    expect(LeadResponseSchema.safeParse(leadRecord()).success).toBe(true);
  });

  it("never asks for severity: severity is rejected on lead creation", () => {
    const result = CreateLeadRequestSchema.safeParse({
      title: "Odd login form on port 8080",
      source: { kind: "manual", ref: "operator note" },
      severity: "high",
    });
    expect(result.success).toBe(false);
  });

  it("rejects assignees, estimates, and other task-management ceremony", () => {
    for (const extra of ["assignee", "estimate", "priority", "dueDate", "status"]) {
      const result = CreateLeadRequestSchema.safeParse({
        title: "Odd login form on port 8080",
        source: { kind: "manual", ref: "operator note" },
        [extra]: "ceremony",
      });
      expect(result.success).toBe(false);
    }
  });

  it("requires a park reason and optional tested conditions", () => {
    expect(ParkLeadRequestSchema.safeParse({ reason: "" }).success).toBe(false);
    expect(
      ParkLeadRequestSchema.safeParse({
        reason: "No working credentials yet",
        testedConditions: "Only checked without authentication",
      }).success,
    ).toBe(true);
  });

  it("accepts all four attempt outcomes with optional shared evidence", () => {
    for (const outcome of ["observed", "ruled_out", "inconclusive", "interrupted"] as const) {
      const result = CreateLeadAttemptRequestSchema.safeParse({
        summary: "Checked default credentials",
        outcome,
        conditions: "Only checked without authentication",
        evidenceArtifactIds: ["shared-capture-1"],
      });
      expect(result.success).toBe(true);
    }
  });

  it("allows one capture to support two leads: evidence is a plain shared list", () => {
    const first = CreateLeadAttemptRequestSchema.safeParse({
      summary: "First lead attempt",
      outcome: "observed",
      evidenceArtifactIds: ["shared-capture-1"],
    });
    const second = CreateLeadAttemptRequestSchema.safeParse({
      summary: "Second lead attempt",
      outcome: "inconclusive",
      evidenceArtifactIds: ["shared-capture-1"],
    });
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
  });

  it("requires a reason for revisit suggestions and closes", () => {
    expect(
      SuggestLeadRevisitRequestSchema.safeParse({
        trigger: "new_access",
        reason: "Access gained elsewhere cites the parked check",
        anonymous: false,
      }).success,
    ).toBe(true);
    expect(
      SuggestLeadRevisitRequestSchema.safeParse({
        trigger: "new_access",
        anonymous: false,
      }).success,
    ).toBe(false);
    expect(CloseLeadRequestSchema.safeParse({}).success).toBe(true);
  });

  it("attaches an attempt to a lead afterward with only the lead id", () => {
    expect(
      AttachLeadAttemptRequestSchema.safeParse({ leadId: LEAD_ID }).success,
    ).toBe(true);
    expect(AttachLeadAttemptRequestSchema.safeParse({}).success).toBe(false);
  });
});
