import { describe, expect, it } from "vitest";

import {
  anonymousConditionsMatch,
  buildLeadOutline,
  citeParkReasonForRevisit,
  isServiceTestedBySecret,
  resolveAttemptLeadLink,
  suggestLeadRevisit,
  transitionLeadDisposition,
} from "./leads.js";

const PARKED_LEAD = {
  disposition: "parked" as const,
  testedConditions: "Only checked without authentication",
  revisitSuggestion: null,
};

describe("lead transitions", () => {
  it("parks an open lead with a reason and preserves tested conditions", () => {
    const result = transitionLeadDisposition(
      { disposition: "open" },
      "park",
      {
        reason: "No working credentials yet",
        testedConditions: "Only checked without authentication",
      },
    );
    expect(result).toEqual({
      ok: true,
      value: {
        disposition: "parked",
        parkReason: "No working credentials yet",
        testedConditions: "Only checked without authentication",
        closedNote: null,
      },
    });
  });

  it("refuses to park without a reason", () => {
    expect(transitionLeadDisposition({ disposition: "open" }, "park", {}).ok).toBe(false);
    expect(transitionLeadDisposition({ disposition: "open" }, "park", { reason: "  " }).ok).toBe(
      false,
    );
  });

  it("refuses to park a lead that is not open", () => {
    expect(
      transitionLeadDisposition({ disposition: "parked" }, "park", { reason: "again" }).ok,
    ).toBe(false);
    expect(
      transitionLeadDisposition({ disposition: "closed" }, "park", { reason: "again" }).ok,
    ).toBe(false);
  });

  it("reopens parked and closed leads only through an explicit reopen", () => {
    expect(transitionLeadDisposition({ disposition: "parked" }, "reopen", {}).ok).toBe(true);
    expect(transitionLeadDisposition({ disposition: "closed" }, "reopen", {}).ok).toBe(true);
    expect(transitionLeadDisposition({ disposition: "open" }, "reopen", {}).ok).toBe(false);
  });

  it("closes open and parked leads but never parks a closed one", () => {
    expect(transitionLeadDisposition({ disposition: "open" }, "close", {}).ok).toBe(true);
    expect(transitionLeadDisposition({ disposition: "parked" }, "close", {}).ok).toBe(true);
    expect(transitionLeadDisposition({ disposition: "closed" }, "close", {}).ok).toBe(false);
  });
});

describe("revisit suggestions", () => {
  it("produces one quiet suggestion for a parked lead without reopening", () => {
    const result = suggestLeadRevisit(
      PARKED_LEAD,
      {
        trigger: "new_access",
        reason: 'Previously parked: "No working credentials yet". SSH access gained for 192.0.2.10.',
        anonymous: false,
      },
      () => new Date("2026-08-12T12:00:00.000Z"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.trigger).toBe("new_access");
    expect(result.value.reason).toContain("Previously parked:");
    expect(result.value.dismissed).toBe(false);
    // The rule never changes disposition: the lead stays parked.
    expect(PARKED_LEAD.disposition).toBe("parked");
  });

  it("never auto-reopens: suggestions carry no disposition change", () => {
    const result = suggestLeadRevisit(
      PARKED_LEAD,
      { trigger: "service_change", reason: "New service on 8080.", anonymous: false },
      () => new Date("2026-08-12T12:00:00.000Z"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("disposition" in result.value).toBe(false);
  });

  it("suppresses the same suggestion twice", () => {
    const lead = {
      ...PARKED_LEAD,
      revisitSuggestion: {
        trigger: "new_access" as const,
        reason: "Access gained.",
        createdAt: "2026-08-12T12:00:00.000Z",
        dismissed: false,
      },
    };
    const result = suggestLeadRevisit(
      lead,
      { trigger: "hostname_change", reason: "Another change.", anonymous: false },
      () => new Date("2026-08-12T13:00:00.000Z"),
    );
    expect(result).toEqual({
      ok: false,
      error: { code: "revisit_suppressed", reason: "already_suggested" },
    });
  });

  it("suppresses identical anonymous re-suggestions against tested conditions", () => {
    const result = suggestLeadRevisit(
      PARKED_LEAD,
      {
        trigger: "service_change",
        reason: "Retried anonymously.",
        anonymous: true,
        conditions: "  only CHECKED without   authentication ",
      },
      () => new Date("2026-08-12T12:00:00.000Z"),
    );
    expect(result).toEqual({
      ok: false,
      error: { code: "revisit_suppressed", reason: "identical_anonymous_conditions" },
    });
  });

  it("allows an authenticated recheck of the same conditions", () => {
    const result = suggestLeadRevisit(
      PARKED_LEAD,
      {
        trigger: "new_access",
        reason: "Recheck with credentials.",
        anonymous: false,
        conditions: "Only checked without authentication",
      },
      () => new Date("2026-08-12T12:00:00.000Z"),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a suggestion without a reason", () => {
    const result = suggestLeadRevisit(
      PARKED_LEAD,
      { trigger: "new_access", reason: "  ", anonymous: false },
      () => new Date("2026-08-12T12:00:00.000Z"),
    );
    expect(result).toEqual({
      ok: false,
      error: { code: "invalid_revisit_input" },
    });
  });

  it("stays quiet for active and closed leads", () => {
    expect(
      suggestLeadRevisit(
        { ...PARKED_LEAD, disposition: "open" },
        { trigger: "new_access", reason: "Access gained.", anonymous: false },
      ).ok,
    ).toBe(false);
    expect(
      suggestLeadRevisit(
        { ...PARKED_LEAD, disposition: "closed" },
        { trigger: "new_access", reason: "Access gained.", anonymous: false },
      ).ok,
    ).toBe(false);
  });

  it("matches anonymous conditions case- and whitespace-insensitively", () => {
    expect(anonymousConditionsMatch("Only checked without authentication", "only checked WITHOUT authentication")).toBe(true);
    expect(anonymousConditionsMatch(null, "Only checked without authentication")).toBe(false);
    expect(anonymousConditionsMatch("Only checked without authentication", undefined)).toBe(false);
    expect(anonymousConditionsMatch("Checked with auth", "Only checked without authentication")).toBe(false);
  });
});

describe("attempt attach rules", () => {
  it("auto-links launches from a lead", () => {
    expect(
      resolveAttemptLeadLink({ launchLeadId: "lead-1", attachLeadId: "lead-2" }),
    ).toEqual({ leadId: "lead-1", mode: "auto-linked" });
  });

  it("allows attach-afterward for launches elsewhere", () => {
    expect(resolveAttemptLeadLink({ launchLeadId: null, attachLeadId: "lead-2" })).toEqual({
      leadId: "lead-2",
      mode: "attached-afterward",
    });
  });

  it("never forces creation: an unlinked attempt is valid", () => {
    expect(resolveAttemptLeadLink({})).toEqual({ leadId: null, mode: "unlinked" });
    expect(resolveAttemptLeadLink({ launchLeadId: null, attachLeadId: null })).toEqual({
      leadId: null,
      mode: "unlinked",
    });
  });
});

describe("service-scoped credentials", () => {
  it("marks only the exact service tested", () => {
    expect(isServiceTestedBySecret("192.0.2.10:22/ssh", "192.0.2.10:22/ssh")).toBe(true);
    expect(isServiceTestedBySecret("192.0.2.10:22/ssh", "192.0.2.10:80/http")).toBe(false);
    expect(isServiceTestedBySecret("192.0.2.10:22/ssh", "192.0.2.11:22/ssh")).toBe(false);
    expect(isServiceTestedBySecret("192.0.2.10:22/ssh", "")).toBe(false);
  });
});

describe("park reason citation", () => {
  it("cites the full parked reason when it fits", () => {
    const cited = citeParkReasonForRevisit(
      "No working credentials yet",
      "SSH access gained for 192.0.2.10.",
    );
    expect(cited).toBe(
      'Previously parked: "No working credentials yet". SSH access gained for 192.0.2.10.',
    );
  });

  it("passes the reason through when there is no parked reason", () => {
    expect(citeParkReasonForRevisit(null, "SSH access gained.")).toBe("SSH access gained.");
  });

  it("truncates the quoted park reason so the citation never exceeds 500 chars", () => {
    const cited = citeParkReasonForRevisit("r".repeat(500), "SSH access gained.");
    expect(Array.from(cited).length).toBeLessThanOrEqual(500);
    expect(cited.startsWith('Previously parked: "')).toBe(true);
    expect(cited.endsWith("SSH access gained.")).toBe(true);
  });

  it("keeps a 500-char new reason whole even when the quote must drop", () => {
    const reason = "n".repeat(500);
    const cited = citeParkReasonForRevisit("r".repeat(500), reason);
    expect(cited).toBe(reason);
    expect(Array.from(cited).length).toBe(500);
  });

  it("truncates on code-point boundaries without splitting characters", () => {
    const cited = citeParkReasonForRevisit("🛠".repeat(500), "x".repeat(100));
    expect(Array.from(cited).length).toBeLessThanOrEqual(500);
    expect(cited.endsWith("x".repeat(100))).toBe(true);
    expect(cited).not.toContain("�");
  });
});

describe("lead outline", () => {
  it("renders a successful chain as a writeup outline", () => {
    const outline = buildLeadOutline(
      {
        title: "Odd login form on port 8080",
        target: "192.0.2.10",
        serviceRef: "192.0.2.10:8080/tcp",
        disposition: "open",
        parkReason: null,
      },
      [
        {
          sequence: 1,
          summary: "Checked default credentials",
          outcome: "observed",
          conditions: "Only checked without authentication",
          linkedFindingId: null,
          linkedObjectiveId: null,
        },
        {
          sequence: 2,
          summary: "Logged in with found password",
          outcome: "observed",
          conditions: null,
          linkedFindingId: "20000000-0000-4000-8000-000000000001",
          linkedObjectiveId: null,
        },
      ],
    );
    expect(outline).toContain("Lead: Odd login form on port 8080");
    expect(outline).toContain("1. Checked default credentials [observed]");
    expect(outline).toContain("Conditions: Only checked without authentication");
    expect(outline).toContain("Establishes finding 20000000-0000-4000-8000-000000000001");
  });
});
