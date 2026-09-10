import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { Lead, LeadAttempt } from "@blackglass/contracts";

import { registerLeadRoutes } from "./lead-routes.js";

const ENGAGEMENT_ID = "10000000-0000-4000-8000-000000000001";
const LEAD_ID = "10000000-0000-4000-8000-000000000002";
const ATTEMPT_ID = "10000000-0000-4000-8000-000000000003";
const TS = "2026-08-12T12:00:00.000Z";

function leadRecord(overrides: Partial<Lead> = {}): Lead {
  return {
    contractVersion: 1,
    id: LEAD_ID,
    engagementId: ENGAGEMENT_ID,
    title: "Odd login form on port 8080",
    target: "192.0.2.10",
    serviceRef: null,
    source: { kind: "http_probe", ref: "probe-artifact-1" },
    nextStep: null,
    disposition: "open",
    parkReason: null,
    testedConditions: null,
    closedNote: null,
    revisitSuggestion: null,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

function attemptRecord(overrides: Partial<LeadAttempt> = {}): LeadAttempt {
  return {
    contractVersion: 1,
    id: ATTEMPT_ID,
    engagementId: ENGAGEMENT_ID,
    leadId: LEAD_ID,
    sequence: 1,
    summary: "Checked default credentials",
    outcome: "ruled_out",
    conditions: "Only checked without authentication",
    evidenceArtifactIds: ["shared-capture-1"],
    linkedFindingId: null,
    linkedObjectiveId: null,
    createdAt: TS,
    ...overrides,
  };
}

function buildStubApp() {
  const app = Fastify();
  const state = {
    lead: leadRecord(),
    attempts: [attemptRecord()],
  };
  registerLeadRoutes(app, {
    createLead: (engagementId: string) => ({
      ok: true as const,
      value: { ...leadRecord(), engagementId },
    }),
    listLeads: () => ({ ok: true as const, value: [state.lead] }),
    getLead: () => ({ ok: true as const, value: state.lead }),
    parkLead: (_engagementId: string, _leadId: string, input: unknown) => {
      const body = input as { reason: string; testedConditions?: string };
      state.lead = {
        ...state.lead,
        disposition: "parked",
        parkReason: body.reason,
        testedConditions: body.testedConditions ?? null,
      };
      return { ok: true as const, value: state.lead };
    },
    reopenLead: () => {
      state.lead = { ...state.lead, disposition: "open", parkReason: null };
      return { ok: true as const, value: state.lead };
    },
    closeLead: () => {
      state.lead = { ...state.lead, disposition: "closed" };
      return { ok: true as const, value: state.lead };
    },
    suggestRevisit: (_engagementId: string, _leadId: string, input: unknown) => {
      const body = input as { anonymous: boolean; reason: string };
      if (body.anonymous) {
        return {
          ok: false as const,
          error: {
            code: "revisit_suppressed" as const,
            reason: "identical_anonymous_conditions" as const,
          },
        };
      }
      state.lead = {
        ...state.lead,
        revisitSuggestion: {
          trigger: "new_access",
          reason: body.reason,
          createdAt: TS,
          dismissed: false,
        },
      };
      return { ok: true as const, value: state.lead };
    },
    dismissRevisit: () => {
      if (state.lead.revisitSuggestion === null) {
        return { ok: false as const, error: { code: "invalid_lead_transition" as const } };
      }
      state.lead = {
        ...state.lead,
        revisitSuggestion: { ...state.lead.revisitSuggestion, dismissed: true },
      };
      return { ok: true as const, value: state.lead };
    },
    recordAttempt: () => ({ ok: true as const, value: attemptRecord() }),
    getAttempt: () => ({ ok: true as const, value: attemptRecord() }),
    listAttempts: () => ({ ok: true as const, value: state.attempts }),
    attachAttempt: (_engagementId: string, _attemptId: string, input: unknown) => ({
      ok: true as const,
      value: attemptRecord({ leadId: (input as { leadId: string }).leadId }),
    }),
    leadOutline: () => ({
      ok: true as const,
      value: { outline: `Lead: ${state.lead.title}\nAttempts:\n  1. Checked default credentials` },
    }),
  });
  return app;
}

describe("lead routes", () => {
  it("creates a lead without severity and lists it", async () => {
    const app = buildStubApp();
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/leads`,
      payload: {
        title: "Odd login form on port 8080",
        source: { kind: "http_probe", ref: "probe-artifact-1" },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ title: "Odd login form on port 8080" });
    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/leads`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toHaveLength(1);
    await app.close();
  });

  it("rejects severity on creation and requires a park reason", async () => {
    const app = buildStubApp();
    const bad = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/leads`,
      payload: {
        title: "Odd login form",
        source: { kind: "manual", ref: "note" },
        severity: "high",
      },
    });
    expect(bad.statusCode).toBe(400);
    const noReason = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/leads/${LEAD_ID}/park`,
      payload: {},
    });
    expect(noReason.statusCode).toBe(400);
    await app.close();
  });

  it("parks, suggests once with a reason, and suppresses identical anonymous checks", async () => {
    const app = buildStubApp();
    const parked = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/leads/${LEAD_ID}/park`,
      payload: {
        reason: "No working credentials yet",
        testedConditions: "Only checked without authentication",
      },
    });
    expect(parked.statusCode).toBe(200);
    expect(parked.json()).toMatchObject({ disposition: "parked" });
    const suppressed = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/leads/${LEAD_ID}/revisit`,
      payload: {
        trigger: "service_change",
        reason: "Retried anonymously.",
        anonymous: true,
        conditions: "Only checked without authentication",
      },
    });
    expect(suppressed.statusCode).toBe(409);
    expect(suppressed.json()).toEqual({ code: "revisit_suppressed" });
    const suggested = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/leads/${LEAD_ID}/revisit`,
      payload: {
        trigger: "new_access",
        reason: "SSH access gained for 192.0.2.10.",
        anonymous: false,
      },
    });
    expect(suggested.statusCode).toBe(200);
    expect(suggested.json().revisitSuggestion).toMatchObject({ trigger: "new_access" });
    await app.close();
  });

  it("records attempts with shared evidence and renders the outline", async () => {
    const app = buildStubApp();
    const recorded = await app.inject({
      method: "POST",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/leads/${LEAD_ID}/attempts`,
      payload: {
        summary: "Checked default credentials",
        outcome: "ruled_out",
        evidenceArtifactIds: ["shared-capture-1"],
      },
    });
    expect(recorded.statusCode).toBe(201);
    const outline = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/leads/${LEAD_ID}/outline`,
    });
    expect(outline.statusCode).toBe(200);
    expect(outline.json().outline).toContain("Lead:");
    await app.close();
  });
});
