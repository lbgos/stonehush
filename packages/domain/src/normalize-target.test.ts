import { TargetNormalizationResultSchema } from "@stonehush/contracts";
import { describe, expect, it } from "vitest";

import fixtureData from "../../../docs/architecture/fixtures/d1/normalization.json" with {
  type: "json",
};
import { normalizeTarget } from "./normalize-target.js";

interface TemplateFragment {
  repeat: string;
  count: number;
}

interface InputTemplate extends Partial<TemplateFragment> {
  prefix?: string;
  suffix?: string;
  labels?: Array<TemplateFragment | string>;
  separator?: string;
  totalUtf8Bytes?: number;
}

interface FixtureCase {
  id: string;
  given: {
    input?: string;
    inputTemplate?: InputTemplate;
  };
  expected?: {
    accepted?: boolean;
    normalizationProfile?: string;
    kind?: string;
    canonicalTarget?: unknown;
    labelByteLengths?: number[];
    hostnameUtf8Bytes?: number;
    inputUtf8Bytes?: number;
  };
  error?: {
    code: string;
    inputUtf8Bytes?: number;
    maximumUtf8Bytes?: number;
  };
}

interface NormalizationFixture {
  normalizationProfile: string;
  cases: FixtureCase[];
}

const fixture = fixtureData as NormalizationFixture;

const runtimeProcess = (
  globalThis as typeof globalThis & {
    process: { env: Record<string, string | undefined> };
  }
).process;

function materializeTemplate(template: InputTemplate): string {
  if (template.labels !== undefined) {
    return template.labels
      .map((label) =>
        typeof label === "string" ? label : label.repeat.repeat(label.count),
      )
      .join(template.separator ?? "");
  }

  return `${template.prefix ?? ""}${(template.repeat ?? "").repeat(template.count ?? 0)}${template.suffix ?? ""}`;
}

function materializeInput(testCase: FixtureCase): string {
  if (testCase.given.input !== undefined) {
    return testCase.given.input;
  }
  if (testCase.given.inputTemplate !== undefined) {
    return materializeTemplate(testCase.given.inputTemplate);
  }
  throw new Error(`Fixture ${testCase.id} has no input`);
}

describe("normalizeTarget d1-v1 normative fixture", () => {
  it("loads every current normative case", () => {
    expect(fixture.normalizationProfile).toBe("d1-v1");
    expect(fixture.cases).toHaveLength(47);
  });

  it.each(fixture.cases)("$id", (testCase) => {
    const input = materializeInput(testCase);
    const result = normalizeTarget(input);

    expect(TargetNormalizationResultSchema.safeParse(result).success).toBe(
      true,
    );

    if (testCase.error !== undefined) {
      expect(result).toEqual({
        ok: false,
        error: { code: testCase.error.code },
      });
      if (testCase.error.inputUtf8Bytes !== undefined) {
        expect(new TextEncoder().encode(input)).toHaveLength(
          testCase.error.inputUtf8Bytes,
        );
      }
      return;
    }

    expect(result.ok).toBe(true);
    if (!result.ok || testCase.expected === undefined) {
      return;
    }

    if (testCase.expected.canonicalTarget !== undefined) {
      expect(result.target).toEqual(testCase.expected.canonicalTarget);
      return;
    }

    expect(testCase.expected.accepted).toBe(true);
    expect(result.target.normalizationProfile).toBe(
      testCase.expected.normalizationProfile,
    );
    expect(result.target.kind).toBe(testCase.expected.kind);

    if (
      result.target.kind === "hostname" &&
      testCase.expected.labelByteLengths !== undefined
    ) {
      expect(
        result.target.hostname
          .split(".")
          .map((label) => new TextEncoder().encode(label).byteLength),
      ).toEqual(testCase.expected.labelByteLengths);
      expect(new TextEncoder().encode(result.target.hostname)).toHaveLength(
        testCase.expected.hostnameUtf8Bytes as number,
      );
    }
    if (testCase.expected.inputUtf8Bytes !== undefined) {
      expect(new TextEncoder().encode(input)).toHaveLength(
        testCase.expected.inputUtf8Bytes,
      );
    }
  });
});

describe("normalizeTarget classification is terminal", () => {
  it.each([
    ["https:target.test", "invalid_url"],
    ["https://[2001:db8:::1]/", "invalid_url"],
    ["192.0.2.7/not-a-prefix", "invalid_cidr"],
    ["2001:db8:::1.target", "invalid_ipv6"],
    ["SSH://target.test/", "unsupported_url_scheme"],
  ])("does not reinterpret %s after selection", (input, code) => {
    expect(normalizeTarget(input)).toEqual({ ok: false, error: { code } });
  });

  it.each([
    "0x7f000001",
    "http://0x7f000001/",
    "１９２.０.２.７",
    "http://１９２.０.２.７/",
  ])("does not admit alternate numeric identity %s as a hostname", (input) => {
    expect(normalizeTarget(input)).toEqual({
      ok: false,
      error: { code: "ambiguous_numeric_host" },
    });
  });
});

describe("normalizeTarget URL authority handling", () => {
  it.each([
    ["https://user:password@target.test/", "url_userinfo_unsupported"],
    ["https://user%3Apassword@target.test/", "url_userinfo_unsupported"],
    ["https://192.0.2.007/", "invalid_ipv4"],
    ["https://0xc0.0x00.0x02.0x07/", "invalid_ipv4"],
    ["https://192.0.2/", "ambiguous_numeric_host"],
    ["https://[fe80::7%Eth0]/", "invalid_zone_encoding"],
    ["https://[fe80::7%25Eth0%2f]/", "invalid_zone_encoding"],
    ["https://[2001:db8::7%25Eth0]/", "zone_requires_link_local"],
    ["https://[fe80::7%25bad!]/", "invalid_zone"],
  ])("rejects adversarial authority %s", (input, code) => {
    expect(normalizeTarget(input)).toEqual({ ok: false, error: { code } });
  });

  it("uses pinned IDNA and collapses mapped IPv6 URL identity", () => {
    expect(normalizeTarget("HTTPS://BÜCHER.Example:443/a/../b?q=1")).toEqual({
      ok: true,
      target: {
        normalizationProfile: "d1-v1",
        kind: "url",
        url: "https://xn--bcher-kva.example/b?q=1",
        origin: "https://xn--bcher-kva.example:443",
        host: { hostname: "xn--bcher-kva.example" },
        effectivePort: 443,
        pathAndQuery: "/b?q=1",
      },
    });

    expect(normalizeTarget("https://[::ffff:192.0.2.7]/status")).toEqual({
      ok: true,
      target: {
        normalizationProfile: "d1-v1",
        kind: "url",
        url: "https://192.0.2.7/status",
        origin: "https://192.0.2.7:443",
        host: { address: "192.0.2.7", zone: null },
        effectivePort: 443,
        pathAndQuery: "/status",
      },
    });
  });

  it("preserves a zone beginning with 25 across bare and URL identities", () => {
    const bare = normalizeTarget("fe80::7%25Eth0");
    const url = normalizeTarget("https://[fe80::7%2525Eth0]/");

    expect(bare).toEqual({
      ok: true,
      target: {
        normalizationProfile: "d1-v1",
        kind: "ip",
        family: 6,
        address: "fe80::7",
        zone: "25Eth0",
      },
    });
    expect(url).toEqual({
      ok: true,
      target: {
        normalizationProfile: "d1-v1",
        kind: "url",
        url: "https://[fe80::7%2525Eth0]/",
        origin: "https://[fe80::7%2525Eth0]:443",
        host: { address: "fe80::7", zone: "25Eth0" },
        effectivePort: 443,
        pathAndQuery: "/",
      },
    });

    if (
      !bare.ok ||
      bare.target.kind !== "ip" ||
      !url.ok ||
      url.target.kind !== "url"
    ) {
      throw new Error("Expected equivalent normalized bare and URL identities");
    }
    expect(url.target.host).toEqual({
      address: bare.target.address,
      zone: bare.target.zone,
    });
  });

  it.each([
    ["https://target.test/?", "/?"],
    ["https://target.test/path?", "/path?"],
  ])("preserves the empty query delimiter in %s", (input, pathAndQuery) => {
    const result = normalizeTarget(input);

    expect(result).toEqual({
      ok: true,
      target: {
        normalizationProfile: "d1-v1",
        kind: "url",
        url: input,
        origin: "https://target.test:443",
        host: { hostname: "target.test" },
        effectivePort: 443,
        pathAndQuery,
      },
    });
    expect(TargetNormalizationResultSchema.safeParse(result).success).toBe(true);
  });
});

describe("normalizeTarget IPv6 canonicalization", () => {
  it("preserves every accepted zone character and case", () => {
    expect(normalizeTarget("fe80::7%Eth0._~-9")).toEqual({
      ok: true,
      target: {
        normalizationProfile: "d1-v1",
        kind: "ip",
        family: 6,
        address: "fe80::7",
        zone: "Eth0._~-9",
      },
    });
  });

  it.each([
    ["::", "::"],
    ["2001:0:0:1:0:0:1:1", "2001::1:0:0:1:1"],
    ["2001:db8:0:1:1:1:1:1", "2001:db8:0:1:1:1:1:1"],
    ["2001:db8::192.0.2.7", "2001:db8::c000:207"],
  ])("serializes %s as %s", (input, address) => {
    expect(normalizeTarget(input)).toEqual({
      ok: true,
      target: {
        normalizationProfile: "d1-v1",
        kind: "ip",
        family: 6,
        address,
        zone: null,
      },
    });
  });

  it.each([
    "1:2:3:4:5:6:7:8:9",
    "1:2:3:4:5:6:7",
    "1::2::3",
    ":::1",
    "1:",
    ":1",
  ])("rejects malformed IPv6 %s", (input) => {
    expect(normalizeTarget(input)).toEqual({
      ok: false,
      error: { code: "invalid_ipv6" },
    });
  });
});

describe("normalizeTarget safety and determinism", () => {
  it("does not expose operator input, stack traces, or parser details", () => {
    const sensitiveInput = "https://operator-secret@target.test/";
    const result = normalizeTarget(sensitiveInput);
    const serialized = JSON.stringify(result);

    expect(result).toEqual({
      ok: false,
      error: { code: "url_userinfo_unsupported" },
    });
    expect(serialized).not.toContain("operator-secret");
    expect(serialized).not.toContain("stack");
  });

  it("is independent of locale, time zone, and unrelated process environment", () => {
    const input = "HTTPS://BÜCHER.Example:443/a/../status?q=yes";
    const expected = normalizeTarget(input);
    const previous = {
      LANG: runtimeProcess.env.LANG,
      LC_ALL: runtimeProcess.env.LC_ALL,
      TZ: runtimeProcess.env.TZ,
      STONEHUSH_TEST_NOISE: runtimeProcess.env.STONEHUSH_TEST_NOISE,
    };

    try {
      runtimeProcess.env.LANG = "tr_TR.UTF-8";
      runtimeProcess.env.LC_ALL = "C";
      runtimeProcess.env.TZ = "Pacific/Kiritimati";
      runtimeProcess.env.STONEHUSH_TEST_NOISE = "untrusted";
      expect(normalizeTarget(input)).toEqual(expected);

      runtimeProcess.env.LANG = "de_DE.UTF-8";
      runtimeProcess.env.LC_ALL = "en_US.UTF-8";
      runtimeProcess.env.TZ = "America/Los_Angeles";
      runtimeProcess.env.STONEHUSH_TEST_NOISE = "different";
      expect(normalizeTarget(input)).toEqual(expected);
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete runtimeProcess.env[name];
        } else {
          runtimeProcess.env[name] = value;
        }
      }
    }
  });

  it("never throws for arbitrary operator strings", () => {
    const adversarialInputs = [
      "",
      "\u0000",
      "\ud800",
      "%".repeat(4_096),
      ":".repeat(4_096),
      "a".repeat(4_097),
    ];

    for (const input of adversarialInputs) {
      expect(() => normalizeTarget(input)).not.toThrow();
      expect(TargetNormalizationResultSchema.safeParse(normalizeTarget(input)).success).toBe(
        true,
      );
    }
  });
});
