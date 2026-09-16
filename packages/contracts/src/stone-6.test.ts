import { describe, expect, it } from "vitest";

import {
  EngagementNextStepSchema,
  parseEngagementResumeQuery,
} from "./engagement-resume.js";
import {
  parseEngagementSearchQuery,
  EngagementSearchResponseSchema,
} from "./engagement-search.js";
import { describeFfufRateSupport } from "./ffuf-wordlist.js";

describe("engagement-resume contracts", () => {
  it("accepts one trimmed sentence", () => {
    expect(EngagementNextStepSchema.safeParse("Probe port 8080 next.").success).toBe(true);
  });

  it("rejects multiline, blank, and overlong steps", () => {
    expect(EngagementNextStepSchema.safeParse("  padded  ").success).toBe(false);
    expect(EngagementNextStepSchema.safeParse("line one\nline two").success).toBe(false);
    expect(EngagementNextStepSchema.safeParse("line one\rline two").success).toBe(false);
    expect(EngagementNextStepSchema.safeParse("lone\rcarriage").success).toBe(false);
    expect(EngagementNextStepSchema.safeParse("").success).toBe(false);
    expect(EngagementNextStepSchema.safeParse("x".repeat(281)).success).toBe(false);
  });

  it("parses an optional ISO since and rejects unknown keys", () => {
    expect(parseEngagementResumeQuery({})).toEqual({ ok: true, value: {} });
    const parsed = parseEngagementResumeQuery({ since: "2026-09-01T00:00:00.000Z" });
    expect(parsed.ok).toBe(true);
    expect(parseEngagementResumeQuery({ since: "2026-09-01T00:00:00+02:00" }).ok).toBe(true);
    expect(parseEngagementResumeQuery({ since: "not-a-date" }).ok).toBe(false);
    // Date-only and local-time values parse under Date.parse but are not
    // unambiguous instants, so the strict parser rejects them.
    expect(parseEngagementResumeQuery({ since: "2026-09-01" }).ok).toBe(false);
    expect(parseEngagementResumeQuery({ since: "2026-09-01T00:00:00" }).ok).toBe(false);
    expect(parseEngagementResumeQuery({ since: "2026-09-01T00:00:00.000Z", extra: "1" }).ok).toBe(false);
  });
});

describe("engagement-search contracts", () => {
  it("requires a trimmed query and rejects unknown keys", () => {
    expect(parseEngagementSearchQuery({ q: "  admin  " })).toEqual({
      ok: true,
      value: { q: "admin" },
    });
    expect(parseEngagementSearchQuery({ q: "   " }).ok).toBe(false);
    expect(parseEngagementSearchQuery({}).ok).toBe(false);
    expect(parseEngagementSearchQuery({ q: "a", limit: "5" }).ok).toBe(false);
  });

  it("accepts a 120-emoji query end to end, counting code points", () => {
    const query = "🛡".repeat(120);
    const parsed = parseEngagementSearchQuery({ q: query });
    expect(parsed).toEqual({ ok: true, value: { q: query } });
    // The response schema must use the same code-point bound: a Zod
    // UTF-16 max() would reject this query and turn search into a 500.
    const response = EngagementSearchResponseSchema.safeParse({
      engagementId: "10000000-0000-4000-8000-000000000001",
      query,
      groups: {
        target: [],
        hostname: [],
        note: [],
        lead: [],
        finding: [],
        artifact: [],
        excerpt: [],
      },
      unindexedKinds: [],
    });
    expect(response.success).toBe(true);
  });
});

describe("ffuf rate truth", () => {
  it("reports ffuf 1.1.0 as not supporting -rate with an explicit limitation", () => {
    const truth = describeFfufRateSupport("1.1.0");
    expect(truth.supportsRate).toBe(false);
    expect(truth.limitation).toContain("1.1.0");
  });

  it("never claims rate support for unknown versions", () => {
    expect(describeFfufRateSupport(null).supportsRate).toBe(false);
    expect(describeFfufRateSupport("9.9.9").supportsRate).toBe(false);
  });
});
