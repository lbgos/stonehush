import { SavedScopeRuleSchema } from "@stonehush/contracts";
import { describe, expect, it } from "vitest";

import {
  createDraftScopeRule,
  formatScopePortRanges,
  formatScopeRuleTarget,
  SCOPE_PORT_FIELD_ERROR,
  SCOPE_TARGET_FIELD_ERROR,
} from "./scope-rules.js";

const RULE_ID = "20000000-0000-4000-8000-000000000001";

describe("createDraftScopeRule", () => {
  it("maps reserved IPs, CIDRs, hostnames, and URL origins to canonical rules", () => {
    expect(
      createDraftScopeRule(
        { rawTarget: "198.51.100.10", includeSubdomains: true, portRanges: "" },
        () => RULE_ID,
      ),
    ).toEqual({
      ok: true,
      rule: {
        id: RULE_ID,
        kind: "ip",
        target: {
          kind: "ip",
          normalizationProfile: "d1-v1",
          family: 4,
          address: "198.51.100.10",
          zone: null,
        },
      },
    });

    expect(
      createDraftScopeRule(
        { rawTarget: "192.0.2.0/24", includeSubdomains: false, portRanges: "80, 443" },
        () => RULE_ID,
      ),
    ).toEqual({
      ok: true,
      rule: {
        id: RULE_ID,
        kind: "cidr",
        target: {
          kind: "cidr",
          normalizationProfile: "d1-v1",
          family: 4,
          network: "192.0.2.0",
          prefixLength: 24,
          hostBitsMasked: false,
        },
        portRanges: [
          { from: 80, to: 80 },
          { from: 443, to: 443 },
        ],
      },
    });

    expect(
      createDraftScopeRule(
        { rawTarget: "2001:db8::1", includeSubdomains: false, portRanges: "" },
        () => RULE_ID,
      ),
    ).toEqual({
      ok: true,
      rule: {
        id: RULE_ID,
        kind: "ip",
        target: {
          kind: "ip",
          normalizationProfile: "d1-v1",
          family: 6,
          address: "2001:db8::1",
          zone: null,
        },
      },
    });

    expect(
      createDraftScopeRule(
        { rawTarget: "example.test", includeSubdomains: true, portRanges: "8000-8100" },
        () => RULE_ID,
      ),
    ).toEqual({
      ok: true,
      rule: {
        id: RULE_ID,
        kind: "domain",
        includeSubdomains: true,
        target: {
          kind: "hostname",
          normalizationProfile: "d1-v1",
          hostname: "example.test",
        },
        portRanges: [{ from: 8000, to: 8100 }],
      },
    });

    expect(
      createDraftScopeRule(
        { rawTarget: "https://app.example.test", includeSubdomains: false, portRanges: "" },
        () => RULE_ID,
      ),
    ).toEqual({
      ok: true,
      rule: {
        id: RULE_ID,
        kind: "url-origin",
        origin: {
          scheme: "https",
          host: { hostname: "app.example.test" },
          effectivePort: 443,
        },
      },
    });
  });

  it("rejects malformed targets and port ranges without producing a rule", () => {
    expect(
      createDraftScopeRule({
        rawTarget: "not a target",
        includeSubdomains: false,
        portRanges: "",
      }),
    ).toEqual({ ok: false, field: "rawTarget", message: SCOPE_TARGET_FIELD_ERROR });
    expect(
      createDraftScopeRule({
        rawTarget: "198.51.100.10",
        includeSubdomains: false,
        portRanges: "80-20",
      }),
    ).toEqual({ ok: false, field: "portRanges", message: SCOPE_PORT_FIELD_ERROR });
    expect(
      createDraftScopeRule({
        rawTarget: "",
        includeSubdomains: false,
        portRanges: "",
      }),
    ).toEqual({ ok: false, field: "rawTarget", message: SCOPE_TARGET_FIELD_ERROR });
  });

  it("produces contract-valid rules for the reserved fixtures", () => {
    const fixtures = [
      "198.51.100.10",
      "192.0.2.0/24",
      "2001:db8::1",
      "example.test",
      "https://app.example.test",
    ];
    for (const rawTarget of fixtures) {
      const result = createDraftScopeRule({
        rawTarget,
        includeSubdomains: false,
        portRanges: "",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(SavedScopeRuleSchema.safeParse(result.rule).success).toBe(true);
      }
    }
  });
});

describe("scope rule display", () => {
  it("formats technical identifiers without inventing a second grammar", () => {
    const cidr = createDraftScopeRule(
      { rawTarget: "192.0.2.0/24", includeSubdomains: false, portRanges: "80-443" },
      () => RULE_ID,
    );
    expect(cidr.ok).toBe(true);
    if (cidr.ok) {
      expect(formatScopeRuleTarget(cidr.rule)).toBe("192.0.2.0/24");
      expect(formatScopePortRanges(cidr.rule.portRanges)).toBe("80-443");
    }

    const url = createDraftScopeRule(
      { rawTarget: "https://app.example.test", includeSubdomains: false, portRanges: "" },
      () => RULE_ID,
    );
    expect(url.ok).toBe(true);
    if (url.ok) {
      expect(formatScopeRuleTarget(url.rule)).toBe("https://app.example.test:443");
    }
  });
});
