import type { Lead, LeadAttempt } from "@stonehush/contracts";
import { describe, expect, it } from "vitest";

import { LEAD_TECHNIQUE_SOURCES_MAX, maskCopiedText, resolveSourceAttempts, seedLeadTechnique } from "./lead-technique-draft.js";

const ENGAGEMENT_ID = "10000000-0000-4000-8000-000000000001";
const LEAD_ID = "20000000-0000-4000-8000-000000000001";
const TS = "2026-10-01T12:00:00.000Z";

function attemptId(sequence: number): string {
  return `30000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function attempt(sequence: number, extra: Partial<LeadAttempt> = {}): LeadAttempt {
  return {
    contractVersion: 1,
    id: attemptId(sequence),
    engagementId: ENGAGEMENT_ID,
    leadId: LEAD_ID,
    sequence,
    summary: `Attempt ${sequence} summary`,
    outcome: "inconclusive",
    conditions: null,
    evidenceArtifactIds: [],
    linkedFindingId: null,
    linkedObjectiveId: null,
    createdAt: TS,
    ...extra,
  };
}

const lead: Lead = {
  contractVersion: 1,
  id: LEAD_ID,
  engagementId: ENGAGEMENT_ID,
  title: "Default creds on the admin form",
  target: "192.0.2.10",
  serviceRef: null,
  source: { kind: "manual", ref: "probe-artifact-1" },
  nextStep: null,
  disposition: "open",
  parkReason: null,
  testedConditions: null,
  closedNote: null,
  revisitSuggestion: null,
  createdAt: TS,
  updatedAt: TS,
};

function keys() {
  let next = 0;
  return () => {
    next += 1;
    return `k${next}`;
  };
}

describe("resolveSourceAttempts", () => {
  const listed = [attempt(1), attempt(2, { outcome: "ruled_out" }), attempt(3), attempt(4, { outcome: "interrupted" })];

  it("returns nonadjacent picks of any outcome in ascending sequence", () => {
    const result = resolveSourceAttempts(ENGAGEMENT_ID, LEAD_ID, listed, [attemptId(4), attemptId(2)]);
    expect(result).toEqual({ ok: true, attempts: [listed[1], listed[3]] });
  });

  it("rejects an empty selection", () => {
    expect(resolveSourceAttempts(ENGAGEMENT_ID, LEAD_ID, listed, []).ok).toBe(false);
  });

  it("rejects more attempts than a technique has steps", () => {
    const many = Array.from({ length: LEAD_TECHNIQUE_SOURCES_MAX + 1 }, (_, index) => attempt(index + 1));
    const result = resolveSourceAttempts(ENGAGEMENT_ID, LEAD_ID, many, many.map((entry) => entry.id));
    expect(result.ok).toBe(false);
  });

  it("accepts exactly the step limit", () => {
    const many = Array.from({ length: LEAD_TECHNIQUE_SOURCES_MAX }, (_, index) => attempt(index + 1));
    const result = resolveSourceAttempts(ENGAGEMENT_ID, LEAD_ID, many, many.map((entry) => entry.id));
    expect(result.ok && result.attempts.length).toBe(LEAD_TECHNIQUE_SOURCES_MAX);
  });

  it("rejects a repeated id", () => {
    expect(resolveSourceAttempts(ENGAGEMENT_ID, LEAD_ID, listed, [attemptId(1), attemptId(1)]).ok).toBe(false);
  });

  it("rejects an id that is not listed, or listed twice", () => {
    expect(resolveSourceAttempts(ENGAGEMENT_ID, LEAD_ID, listed, [attemptId(9)]).ok).toBe(false);
    expect(resolveSourceAttempts(ENGAGEMENT_ID, LEAD_ID, [...listed, attempt(1)], [attemptId(1)]).ok).toBe(false);
  });

  it("rejects attempts owned by another engagement or lead", () => {
    const otherLead = [attempt(1, { leadId: "20000000-0000-4000-8000-000000000002" })];
    const otherEngagement = [attempt(1, { engagementId: "10000000-0000-4000-8000-000000000002" })];
    expect(resolveSourceAttempts(ENGAGEMENT_ID, LEAD_ID, otherLead, [attemptId(1)]).ok).toBe(false);
    expect(resolveSourceAttempts(ENGAGEMENT_ID, LEAD_ID, otherEngagement, [attemptId(1)]).ok).toBe(false);
  });

  it("rejects a selected sequence that names more than one listed attempt", () => {
    const clash = [attempt(1), { ...attempt(2), sequence: 1 }];
    expect(resolveSourceAttempts(ENGAGEMENT_ID, LEAD_ID, clash, [attemptId(1)]).ok).toBe(false);
  });
});

describe("seedLeadTechnique", () => {
  const label = (outcome: LeadAttempt["outcome"]) => outcome.replace("_", " ");

  it("copies one prose step per summary and leaves operator fields empty", () => {
    const seed = seedLeadTechnique(
      lead,
      [attempt(2, { outcome: "ruled_out", conditions: "only without TLS" }), attempt(5)],
      label,
      keys(),
    );
    expect(seed.form).toEqual({
      name: "Default creds on the admin form",
      whenUseful: "",
      prerequisites: "",
      question: "",
      meaning: "",
      steps: [
        { key: "k1", instruction: "Attempt 2 summary", command: "", note: "From attempt 2: ruled out under only without TLS" },
        { key: "k2", instruction: "Attempt 5 summary", command: "", note: "From attempt 5: inconclusive" },
      ],
    });
    expect(seed.maskedCount).toBe(0);
  });

  it("keeps blank lines, $ lines, shell syntax and markup inside one instruction", () => {
    const summary = "Checked the form\n\n$ curl -s http://192.0.2.10/ | grep admin; rm -rf /tmp/x\n<img src=x onerror=alert(1)>";
    const seed = seedLeadTechnique(lead, [attempt(1, { summary })], label, keys());
    expect(seed.form.steps).toHaveLength(1);
    expect(seed.form.steps[0]?.instruction).toBe(summary);
    expect(seed.form.steps[0]?.command).toBe("");
  });

  it("masks known secret shapes and URL userinfo, including conditions shown as context", () => {
    const seed = seedLeadTechnique(
      { ...lead, title: "Login with password=hunter2" },
      [
        attempt(1, {
          summary: "Opened http://admin:synthetic@192.0.2.10/login and found flag{synthetic-proof}",
          conditions: "token=synthetic-token-value",
        }),
      ],
      label,
      keys(),
    );
    expect(seed.form.name).toBe("Login with password: [redacted]");
    expect(seed.form.steps[0]?.instruction).toBe("Opened http://192.0.2.10/login and found [redacted]");
    expect(seed.form.steps[0]?.note).toBe("From attempt 1: inconclusive under token: [redacted]");
    expect(seed.maskedCount).toBe(2);
  });

  it("never clips an overlong summary or title", () => {
    const summary = "a".repeat(2000);
    const title = "t".repeat(120);
    const seed = seedLeadTechnique({ ...lead, title }, [attempt(1, { summary })], label, keys());
    expect(seed.form.steps[0]?.instruction).toBe(summary);
    expect(seed.form.name).toBe(title);
  });

  it("does not replace the lead target on its own", () => {
    const seed = seedLeadTechnique(lead, [attempt(1, { summary: "nmap -sV 192.0.2.10" })], label, keys());
    expect(seed.form.steps[0]?.instruction).toBe("nmap -sV 192.0.2.10");
  });
});

describe("maskCopiedText", () => {
  it("passes plain text through unchanged", () => {
    expect(maskCopiedText("80/tcp open http")).toBe("80/tcp open http");
  });
});
