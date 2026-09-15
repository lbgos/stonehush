import {
  SavedScopeComparisonResultSchema,
  type CanonicalCidrTarget,
  type CanonicalHostnameTarget,
  type CanonicalIpTarget,
  type CanonicalTarget,
  type CanonicalUrlOrigin,
  type CanonicalUrlTarget,
  type SavedScopeComparisonInput,
  type SavedScopeRule,
  type ScopeComparisonSubject,
  type ScopePortRangeInput,
} from "@stonehush/contracts";
import { describe, expect, it } from "vitest";

import fixtureData from "../../../docs/architecture/fixtures/d1/scope-comparison.json" with {
  type: "json",
};
import { normalizeTarget } from "./normalize-target.js";
import {
  compareSavedScope,
  estimateConcreteTargetCardinality,
  normalizeScopePortRanges,
  normalizeScopeRules,
  selectExecutionRepresentation,
} from "./saved-scope.js";

interface FixtureRule {
  id: string;
  kind: "ip" | "cidr" | "domain" | "url-origin";
  address?: string;
  zone?: string | null;
  network?: string;
  prefixLength?: number;
  hostname?: string;
  includeSubdomains?: boolean;
  scheme?: "http" | "https";
  host?: string;
  effectivePort?: number;
  portRanges?: ScopePortRangeInput[];
}

interface FixtureActionTarget {
  kind: "hostname" | "ip" | "url" | "resolved-address";
  hostname?: string;
  address?: string;
  zone?: string | null;
  url?: string;
  declaredPorts?: number[] | null;
  derivedForHostname?: string;
  actionId?: string;
}

interface FixtureTargetSet {
  representation: string;
  concreteHosts?: number;
  duplicateOfSetIndex?: number;
  addressFamily?: 4 | 6;
  expansionMode?: string;
}

interface FixtureCase {
  id: string;
  given: {
    scopeRevisionId?: string | null;
    rules?: FixtureRule[];
    actionTargets?: FixtureActionTarget[];
    ranges?: ScopePortRangeInput[];
    canonicalTargetSets?: FixtureTargetSet[];
    installedActionSupportsCompactRange?: boolean;
    installedActionSupportsStreamingExpansion?: boolean;
    redirectDestination?: {
      url: string;
      scheme: "http" | "https";
      host: string;
      effectivePort: number;
      resolvedAddress: string;
    };
    sourceResolvedAddress?: string;
  };
  expected?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

const fixture = fixtureData as { cases: FixtureCase[] };

function canonical(input: string): CanonicalTarget {
  const result = normalizeTarget(input);
  if (!result.ok) {
    throw new Error(`Test adapter could not normalize fixture target: ${result.error.code}`);
  }
  return result.target;
}

function canonicalIp(address: string, zone: string | null = null): CanonicalIpTarget {
  const result = canonical(zone === null ? address : `${address}%${zone}`);
  if (result.kind !== "ip") {
    throw new Error("Fixture adapter expected a canonical IP");
  }
  return result;
}

function canonicalHostname(hostname: string): CanonicalHostnameTarget {
  const result = canonical(hostname);
  if (result.kind !== "hostname") {
    throw new Error("Fixture adapter expected a canonical hostname");
  }
  return result;
}

function canonicalCidr(network: string, prefixLength: number): CanonicalCidrTarget {
  const result = canonical(`${network}/${prefixLength}`);
  if (result.kind !== "cidr") {
    throw new Error("Fixture adapter expected a canonical CIDR");
  }
  return result;
}

function canonicalUrl(url: string): CanonicalUrlTarget {
  const result = canonical(url);
  if (result.kind !== "url") {
    throw new Error("Fixture adapter expected a canonical URL");
  }
  return result;
}

function originFromUrl(url: CanonicalUrlTarget): CanonicalUrlOrigin {
  return {
    scheme: url.origin.startsWith("https://") ? "https" : "http",
    host: url.host,
    effectivePort: url.effectivePort,
  };
}

function fixtureRule(rule: FixtureRule): SavedScopeRule {
  const portRanges =
    rule.portRanges === undefined ? {} : { portRanges: rule.portRanges };
  if (rule.kind === "ip") {
    return {
      id: rule.id,
      kind: "ip",
      target: canonicalIp(rule.address as string, rule.zone ?? null),
      ...portRanges,
    };
  }
  if (rule.kind === "cidr") {
    return {
      id: rule.id,
      kind: "cidr",
      target: canonicalCidr(rule.network as string, rule.prefixLength as number),
      ...portRanges,
    };
  }
  if (rule.kind === "domain") {
    return {
      id: rule.id,
      kind: "domain",
      target: canonicalHostname(rule.hostname as string),
      includeSubdomains: rule.includeSubdomains as boolean,
      ...portRanges,
    };
  }

  const explicitPort =
    (rule.scheme === "https" && rule.effectivePort === 443) ||
    (rule.scheme === "http" && rule.effectivePort === 80)
      ? ""
      : `:${rule.effectivePort as number}`;
  return {
    id: rule.id,
    kind: "url-origin",
    origin: originFromUrl(
      canonicalUrl(`${rule.scheme as string}://${rule.host as string}${explicitPort}/`),
    ),
    ...portRanges,
  };
}

function fixtureSubject(target: FixtureActionTarget): ScopeComparisonSubject {
  const declaredPorts = target.declaredPorts ?? null;
  if (target.kind === "hostname") {
    return {
      target: canonicalHostname(target.hostname as string),
      declaredPorts,
      provenance: { kind: "direct" },
    };
  }
  if (target.kind === "ip") {
    return {
      target: canonicalIp(target.address as string, target.zone ?? null),
      declaredPorts,
      provenance: { kind: "direct" },
    };
  }
  if (target.kind === "url") {
    return {
      target: canonicalUrl(target.url as string),
      declaredPorts,
      provenance: { kind: "direct" },
    };
  }
  return {
    target: canonicalIp(target.address as string),
    declaredPorts,
    provenance: {
      kind: "hostname_resolution",
      actionId: target.actionId as string,
      sourceHostname: canonicalHostname(target.derivedForHostname as string),
    },
  };
}

function outsideTarget(subject: ScopeComparisonSubject): Record<string, unknown> {
  if (subject.provenance.kind === "hostname_resolution") {
    const target = subject.target as CanonicalIpTarget;
    return {
      kind: "resolved-address",
      address: target.address,
      derivedForHostname: subject.provenance.sourceHostname.hostname,
    };
  }
  if (subject.target.kind === "hostname") {
    return { kind: "hostname", hostname: subject.target.hostname };
  }
  if (subject.target.kind === "ip") {
    return {
      kind: "ip",
      address: subject.target.address,
      zone: subject.target.zone,
    };
  }
  return { kind: subject.target.kind };
}

function comparisonFixtureInput(testCase: FixtureCase): SavedScopeComparisonInput {
  const rules = (testCase.given.rules ?? []).map(fixtureRule);
  let subjects = (testCase.given.actionTargets ?? []).map(fixtureSubject);
  if (testCase.given.redirectDestination !== undefined) {
    const destination = canonicalUrl(testCase.given.redirectDestination.url);
    const originRule = rules.find((rule) => rule.kind === "url-origin");
    if (originRule === undefined || originRule.kind !== "url-origin") {
      throw new Error("Redirect fixture requires an origin rule");
    }
    subjects = [
      {
        target: destination,
        declaredPorts: null,
        provenance: {
          kind: "redirect",
          actionId: "action-current",
          sourceOrigin: originRule.origin,
          sourceResolvedAddress: canonicalIp(
            testCase.given.sourceResolvedAddress as string,
          ),
          destinationResolvedAddress: canonicalIp(
            testCase.given.redirectDestination.resolvedAddress,
          ),
        },
      },
    ];
  }
  return {
    currentActionId: "action-current",
    scopeRevisionId: testCase.given.scopeRevisionId ?? null,
    rules,
    subjects,
  };
}

function runFixture(testCase: FixtureCase): Record<string, unknown> {
  if (testCase.given.ranges !== undefined) {
    const result = normalizeScopePortRanges(testCase.given.ranges);
    return result.ok
      ? { normalizedRanges: result.ranges }
      : { error: result.error };
  }

  if (testCase.given.canonicalTargetSets !== undefined) {
    const targets = testCase.given.canonicalTargetSets.map((set) => {
      const target = canonical(set.representation);
      if (target.kind !== "ip" && target.kind !== "cidr") {
        throw new Error("Cardinality fixture requires IP or CIDR targets");
      }
      return target;
    });
    const cardinality = estimateConcreteTargetCardinality({ targets });
    const result: Record<string, unknown> = { ...cardinality };
    if (
      testCase.given.canonicalTargetSets.some(
        (set) => set.expansionMode === "compact",
      )
    ) {
      result.expandedTargets = false;
    }
    if (
      testCase.given.installedActionSupportsCompactRange !== undefined &&
      testCase.given.installedActionSupportsStreamingExpansion !== undefined
    ) {
      const capability = selectExecutionRepresentation({
        supportsCompactRange:
          testCase.given.installedActionSupportsCompactRange,
        supportsStreamingExpansion:
          testCase.given.installedActionSupportsStreamingExpansion,
      });
      if (capability.ok) {
        result.executionRepresentation = capability.executionRepresentation;
        result.policyHardCap = false;
      }
    }
    return result;
  }

  const result = compareSavedScope(comparisonFixtureInput(testCase));
  expect(result.ok).toBe(true);
  if (!result.ok) {
    return {};
  }
  const firstOutside = result.comparison.subjectFacts.find(
    (fact) => fact.outsideScope,
  );
  return {
    outsideScope: result.comparison.outsideScope,
    matchedRuleIds: result.comparison.matchedRuleIds,
    outsideTargets: result.comparison.outsideSubjects.map(outsideTarget),
    uncoveredPorts: firstOutside?.uncoveredPorts,
    reason: firstOutside?.reason,
    snapshotTarget:
      result.comparison.subjectFacts[0]?.subject.target.kind === "ip"
        ? outsideTarget(result.comparison.subjectFacts[0].subject)
        : undefined,
  };
}

describe("saved scope d1-v1 normative fixture", () => {
  it("loads every current fixture case exactly once", () => {
    expect(fixture.cases).toHaveLength(28);
    expect(new Set(fixture.cases.map(({ id }) => id))).toHaveProperty("size", 28);
  });

  it.each(fixture.cases)("$id", (testCase) => {
    const actual = runFixture(testCase);
    expect(actual).toMatchObject(
      testCase.error === undefined
        ? (testCase.expected as Record<string, unknown>)
        : { error: testCase.error },
    );
  });
});

function comparisonWith(
  rules: SavedScopeRule[],
  subjects: ScopeComparisonSubject[],
): SavedScopeComparisonInput {
  return {
    currentActionId: "action-current",
    scopeRevisionId: "scope-current",
    rules,
    subjects,
  };
}

describe("saved scope adversarial behavior", () => {
  it("does not combine partial port coverage across alternative rules", () => {
    const target = canonicalHostname("target.test");
    const rules: SavedScopeRule[] = [
      {
        id: "rule-http",
        kind: "domain",
        target,
        includeSubdomains: false,
        portRanges: [{ from: 80, to: 80 }],
      },
      {
        id: "rule-https",
        kind: "domain",
        target,
        includeSubdomains: false,
        portRanges: [{ from: 443, to: 443 }],
      },
    ];
    const result = compareSavedScope(
      comparisonWith(rules, [
        {
          target,
          declaredPorts: [80, 443],
          provenance: { kind: "direct" },
        },
      ]),
    );

    expect(result).toMatchObject({
      ok: true,
      comparison: {
        outsideScope: true,
        matchedRuleIds: [],
        subjectFacts: [{ reason: "ports_uncovered" }],
      },
    });
  });

  it("allows unspecified ports only through an unrestricted matching rule", () => {
    const target = canonicalHostname("target.test");
    const result = compareSavedScope(
      comparisonWith(
        [
          {
            id: "rule-unrestricted",
            kind: "domain",
            target,
            includeSubdomains: false,
          },
        ],
        [{ target, declaredPorts: null, provenance: { kind: "direct" } }],
      ),
    );
    expect(result).toMatchObject({
      ok: true,
      comparison: { outsideScope: false, matchedRuleIds: ["rule-unrestricted"] },
    });
  });

  it.each([
    [{ from: 443, to: 80 }, { code: "invalid_port_range", from: 443, to: 80 }],
    [{ from: 80.5, to: 81 }, { code: "invalid_port_range", port: 80.5 }],
    [{ from: -1, to: 1 }, { code: "invalid_port_range", port: -1, minimumPort: 1 }],
  ])("returns bounded typed errors for invalid ranges", (range, error) => {
    const result = normalizeScopePortRanges([range]);
    expect(result).toEqual({ ok: false, error });
    expect(JSON.stringify(result)).not.toContain("stack");
  });

  it("rejects duplicate rules, empty restrictions, and stale action provenance", () => {
    const target = canonicalHostname("target.test");
    const rule: SavedScopeRule = {
      id: "rule-domain",
      kind: "domain",
      target,
      includeSubdomains: false,
    };
    expect(normalizeScopeRules([rule, rule])).toEqual({
      ok: false,
      error: { code: "duplicate_scope_rule_id" },
    });
    expect(
      normalizeScopeRules([{ ...rule, portRanges: [] } as unknown as SavedScopeRule]),
    ).toEqual({ ok: false, error: { code: "empty_port_restriction" } });

    const stale = compareSavedScope({
      currentActionId: "action-current",
      scopeRevisionId: "scope-current",
      rules: [rule],
      subjects: [
        {
          target: canonicalIp("192.0.2.7"),
          declaredPorts: null,
          provenance: {
            kind: "hostname_resolution",
            actionId: "action-prior",
            sourceHostname: target,
          },
        },
      ],
    } as SavedScopeComparisonInput);
    expect(stale).toEqual({
      ok: false,
      error: { code: "invalid_current_action_provenance" },
    });
  });

  it("rejects unknown fields and invalid nested targets without reflecting input", () => {
    const invalid = {
      currentActionId: "action-current",
      scopeRevisionId: "scope-current",
      rules: [],
      subjects: [
        {
          target: {
            normalizationProfile: "d1-v1",
            kind: "ip",
            family: 4,
            address: "operator-secret",
            zone: null,
          },
          declaredPorts: null,
          provenance: { kind: "direct" },
          unknown: true,
        },
      ],
    } as unknown as SavedScopeComparisonInput;
    const result = compareSavedScope(invalid);
    expect(result).toEqual({ ok: false, error: { code: "invalid_scope_input" } });
    expect(JSON.stringify(result)).not.toContain("operator-secret");
    expect(SavedScopeComparisonResultSchema.safeParse(result).success).toBe(true);
  });

  it("rejects every contradictory canonical URL field before comparison", () => {
    const target = canonicalUrl("https://target.test/path?q=one");
    const rule: SavedScopeRule = {
      id: "rule-origin",
      kind: "url-origin",
      origin: originFromUrl(target),
    };
    const contradictions: CanonicalUrlTarget[] = [
      { ...target, url: "https://other.test/path?q=one" },
      { ...target, origin: "https://other.test:443" },
      { ...target, host: { hostname: "other.test" } },
      { ...target, effectivePort: 8_443 },
      { ...target, pathAndQuery: "/other?q=one" },
    ];

    for (const contradictoryTarget of contradictions) {
      const result = compareSavedScope(
        comparisonWith([rule], [
          {
            target: contradictoryTarget,
            declaredPorts: null,
            provenance: { kind: "direct" },
          },
        ]),
      );
      expect(result).toEqual({
        ok: false,
        error: { code: "invalid_scope_input" },
      });
      expect(JSON.stringify(result)).not.toContain("other.test");
    }
  });

  it("accepts a coherent canonical URL and compares its origin", () => {
    const target = canonicalUrl("https://target.test/path?q=one");
    const result = compareSavedScope(
      comparisonWith(
        [
          {
            id: "rule-origin",
            kind: "url-origin",
            origin: originFromUrl(target),
          },
        ],
        [
          {
            target,
            declaredPorts: null,
            provenance: { kind: "direct" },
          },
        ],
      ),
    );
    expect(result).toMatchObject({
      ok: true,
      comparison: {
        outsideScope: false,
        matchedRuleIds: ["rule-origin"],
      },
    });
  });

  it("retains rule/input order while normalizing ranges", () => {
    const target = canonicalHostname("target.test");
    const result = normalizeScopeRules([
      {
        id: "rule-second",
        kind: "domain",
        target,
        includeSubdomains: false,
        portRanges: [
          { from: 443, to: 445 },
          { from: 80, to: 82 },
          { from: 81, to: 90 },
        ],
      },
      {
        id: "rule-first",
        kind: "domain",
        target,
        includeSubdomains: false,
      },
    ]);
    expect(result).toMatchObject({
      ok: true,
      rules: [
        {
          id: "rule-second",
          portRanges: [
            { from: 80, to: 90 },
            { from: 443, to: 445 },
          ],
        },
        { id: "rule-first" },
      ],
    });
  });

  it("does not mutate frozen inputs and repeats deeply equally", () => {
    const input = Object.freeze({
      currentActionId: "action-current",
      scopeRevisionId: "scope-current",
      rules: Object.freeze([
        Object.freeze({
          id: "rule-ip",
          kind: "ip" as const,
          target: Object.freeze(canonicalIp("192.0.2.7")),
          portRanges: Object.freeze([
            Object.freeze({ from: 443, to: 445 }),
            Object.freeze({ from: 80, to: 82 }),
          ]),
        }),
      ]),
      subjects: Object.freeze([
        Object.freeze({
          target: Object.freeze(canonicalIp("192.0.2.7")),
          declaredPorts: Object.freeze([80, 443]),
          provenance: Object.freeze({ kind: "direct" as const }),
        }),
      ]),
    });
    const first = compareSavedScope(input as SavedScopeComparisonInput);
    const second = compareSavedScope(input as SavedScopeComparisonInput);
    expect(first).toEqual(second);
    expect(input.rules[0]?.portRanges).toEqual([
      { from: 443, to: 445 },
      { from: 80, to: 82 },
    ]);
  });
});

describe("saturated cardinality and capability", () => {
  it("counts distinct case-sensitive IPv6 zones and deduplicates exact identities", () => {
    expect(
      estimateConcreteTargetCardinality({
        targets: [
          canonicalIp("fe80::7", "Eth0"),
          canonicalIp("fe80::7", "Eth0"),
          canonicalIp("fe80::7", "eth0"),
        ],
      }),
    ).toEqual({
      estimatedConcreteTargets: 2,
      countSaturated: false,
      largeTargetWarning: false,
    });

    const distinctZones = Array.from({ length: 4_097 }, (_, index) =>
      canonicalIp("fe80::7", `z${index}`),
    );
    expect(
      estimateConcreteTargetCardinality({ targets: distinctZones }),
    ).toEqual({
      estimatedConcreteTargets: 4_097,
      countSaturated: true,
      largeTargetWarning: true,
    });
  });

  it("treats zoned exact addresses inside CIDRs as zone-insensitive members", () => {
    expect(
      estimateConcreteTargetCardinality({
        targets: [
          canonicalCidr("fe80::7", 128),
          canonicalIp("fe80::7", "Eth0"),
          canonicalIp("fe80::7", "eth0"),
          canonicalIp("fe80::8", "Eth0"),
          canonicalIp("fe80::8", "eth0"),
        ],
      }),
    ).toEqual({
      estimatedConcreteTargets: 3,
      countSaturated: false,
      largeTargetWarning: false,
    });
  });

  it.each([
    ["192.0.0.0/20", "192.0.0.0/32", 4_096, false],
    ["192.0.0.0/20", "192.0.16.0/32", 4_097, true],
    ["192.0.0.0/20", "2001:db8::1", 4_097, true],
  ])(
    "counts %s plus %s with saturation",
    (range, exact, estimatedConcreteTargets, countSaturated) => {
      const targets = [canonical(range), canonical(exact)].map((target) => {
        if (target.kind !== "ip" && target.kind !== "cidr") {
          throw new Error("Expected concrete target");
        }
        return target;
      });
      expect(estimateConcreteTargetCardinality({ targets })).toEqual({
        estimatedConcreteTargets,
        countSaturated,
        largeTargetWarning: countSaturated,
      });
    },
  );

  it("deduplicates exact, duplicate, overlapping, adjacent, and mixed-family intervals", () => {
    const rawTargets = [
      "192.0.2.0/31",
      "192.0.2.1",
      "192.0.2.2/31",
      "192.0.2.0/30",
      "2001:db8::/127",
      "2001:db8::2/127",
      "2001:db8::3",
    ];
    const targets = rawTargets.map((value) => {
      const target = canonical(value);
      if (target.kind !== "ip" && target.kind !== "cidr") {
        throw new Error("Expected concrete target");
      }
      return target;
    });
    expect(estimateConcreteTargetCardinality({ targets })).toEqual({
      estimatedConcreteTargets: 8,
      countSaturated: false,
      largeTargetWarning: false,
    });
  });

  it("tests 4095, 4096, and 4097 without expanding targets", () => {
    const result4096 = estimateConcreteTargetCardinality({
      targets: [canonicalCidr("192.0.0.0", 20)],
    });
    const result4097 = estimateConcreteTargetCardinality({
      targets: [canonicalCidr("192.0.0.0", 20), canonicalIp("192.0.16.1")],
    });
    const result4095 = estimateConcreteTargetCardinality({
      targets: [
        canonicalCidr("192.0.0.0", 21),
        canonicalCidr("192.0.8.0", 22),
        canonicalCidr("192.0.12.0", 23),
        canonicalCidr("192.0.14.0", 24),
        canonicalCidr("192.0.15.0", 25),
        canonicalCidr("192.0.15.128", 26),
        canonicalCidr("192.0.15.192", 27),
        canonicalCidr("192.0.15.224", 28),
        canonicalCidr("192.0.15.240", 29),
        canonicalCidr("192.0.15.248", 30),
        canonicalCidr("192.0.15.252", 31),
        canonicalIp("192.0.15.254"),
      ],
    });
    expect(result4095).toEqual({
      estimatedConcreteTargets: 4_095,
      countSaturated: false,
      largeTargetWarning: false,
    });
    expect(result4096).toEqual({
      estimatedConcreteTargets: 4_096,
      countSaturated: false,
      largeTargetWarning: false,
    });
    expect(result4097.estimatedConcreteTargets).toBe(4_097);
    expect(result4097.countSaturated).toBe(true);
  });

  it("prefers compact, falls back to streaming, and reports capability failure", () => {
    expect(
      selectExecutionRepresentation({
        supportsCompactRange: true,
        supportsStreamingExpansion: true,
      }),
    ).toEqual({ ok: true, executionRepresentation: "compact" });
    expect(
      selectExecutionRepresentation({
        supportsCompactRange: false,
        supportsStreamingExpansion: true,
      }),
    ).toEqual({ ok: true, executionRepresentation: "streamed_expansion" });
    expect(
      selectExecutionRepresentation({
        supportsCompactRange: false,
        supportsStreamingExpansion: false,
      }),
    ).toEqual({ ok: false, error: { code: "capability_error" } });
  });
});
