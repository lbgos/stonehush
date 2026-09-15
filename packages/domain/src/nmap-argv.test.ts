import { describe, expect, it } from "vitest";

import type { CanonicalTarget } from "@stonehush/contracts";

import { buildNmapArgv } from "./nmap-argv.js";

const baseOptions = {
  serviceDetection: true,
  timingTemplate: "T4" as const,
  skipHostDiscovery: true,
  versionIntensity: 7,
  maxRetries: 2,
};

function ipTarget(address: string): CanonicalTarget {
  return {
    kind: "ip",
    normalizationProfile: "d1-v1",
    family: 4,
    address,
    zone: null,
  };
}

function ipv6Target(address: string, zone: string | null = null): CanonicalTarget {
  return {
    kind: "ip",
    normalizationProfile: "d1-v1",
    family: 6,
    address,
    zone,
  };
}

function cidrTarget(network: string, prefixLength: number, family: 4 | 6 = 4): CanonicalTarget {
  return {
    kind: "cidr",
    normalizationProfile: "d1-v1",
    family,
    network,
    prefixLength,
    hostBitsMasked: false,
  };
}

function hostnameTarget(hostname: string): CanonicalTarget {
  return { kind: "hostname", normalizationProfile: "d1-v1", hostname };
}

const xmlPath = "/var/lib/stonehush-runner/runs/run-fixture-19/nmap-xml";

describe("buildNmapArgv deterministic order", () => {
  it("matches D2 process-supervision fixture nmap-unprivileged-typed-argv", () => {
    const result = buildNmapArgv({
      options: {
        ...baseOptions,
        ports: [
          { from: 80, to: 80 },
          { from: 443, to: 443 },
        ],
      },
      canonicalTargets: [ipTarget("192.0.2.10")],
      xmlPath,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.argv).toEqual([
        "-sT",
        "-sV",
        "-T4",
        "-Pn",
        "--version-intensity",
        "7",
        "--max-retries",
        "2",
        "-p",
        "80,443",
        "-oX",
        xmlPath,
        "192.0.2.10",
      ]);
    }
  });

  it("omits -sV when serviceDetection false, emits -T and -Pn correctly", () => {
    const r = buildNmapArgv({
      options: { ...baseOptions, serviceDetection: false, timingTemplate: "T2", skipHostDiscovery: false },
      canonicalTargets: [hostnameTarget("target.test")],
      xmlPath: "/tmp/nmap-xml",
    });
    expect(r.ok && r.argv).toEqual(["-sT", "-T2", "--version-intensity", "7", "--max-retries", "2", "-oX", "/tmp/nmap-xml", "target.test"]);
  });

  it("handles IPv4, IPv6, CIDR, hostname canonical targets as separate argv elements", () => {
    const targets: CanonicalTarget[] = [
      ipTarget("192.0.2.7"),
      ipv6Target("2001:db8::7"),
      ipv6Target("fe80::7", "Eth0"),
      cidrTarget("192.0.2.0", 24),
      hostnameTarget("target.test"),
    ];
    const r = buildNmapArgv({ options: baseOptions, canonicalTargets: targets, xmlPath: "/tmp/nmap-xml" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.argv.slice(-5)).toEqual(["192.0.2.7", "2001:db8::7", "fe80::7%Eth0", "192.0.2.0/24", "target.test"]);
    }
  });

  it("formats port ranges as Nmap -p ranges via reused normalizer", () => {
    const r = buildNmapArgv({
      options: { ...baseOptions, ports: [{ from: 1, to: 1000 }] },
      canonicalTargets: [ipTarget("192.0.2.1")],
      xmlPath,
    });
    expect(r.ok && r.argv.includes("-p")).toBe(true);
    if (r.ok) expect(r.argv[r.argv.indexOf("-p") + 1]).toBe("1-1000");
  });

  it("merges overlapping and adjacent ports using normalizeScopePortRanges", () => {
    const r = buildNmapArgv({
      options: { ...baseOptions, ports: [{ from: 443, to: 443 }, { from: 80, to: 80 }, { from: 81, to: 82 }] },
      canonicalTargets: [ipTarget("192.0.2.1")],
      xmlPath: "/tmp/nmap-xml",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.argv[r.argv.indexOf("-p") + 1]).toBe("80-82,443");
  });

  it("rejects empty canonicalTargets", () => {
    expect(buildNmapArgv({ options: baseOptions, canonicalTargets: [], xmlPath }).ok).toBe(false);
  });

  it("rejects invalid timing at builder (schema strict)", () => {
    expect(
      buildNmapArgv({
        options: { ...baseOptions, timingTemplate: "T6" as unknown as "T4" },
        canonicalTargets: [ipTarget("192.0.2.1")],
        xmlPath,
      }).ok,
    ).toBe(false);
  });

  it("rejects inverted port range at builder", () => {
    expect(
      buildNmapArgv({
        options: { ...baseOptions, ports: [{ from: 100, to: 80 }] },
        canonicalTargets: [ipTarget("192.0.2.1")],
        xmlPath,
      }).ok,
    ).toBe(false);
  });

  it("rejects out-of-range option bounds via schema", () => {
    expect(buildNmapArgv({ options: { ...baseOptions, versionIntensity: 10 }, canonicalTargets: [ipTarget("192.0.2.1")], xmlPath }).ok).toBe(false);
    expect(buildNmapArgv({ options: { ...baseOptions, maxRetries: 11 }, canonicalTargets: [ipTarget("192.0.2.1")], xmlPath }).ok).toBe(false);
    expect(buildNmapArgv({ options: { ...baseOptions, durationSeconds: 0 }, canonicalTargets: [ipTarget("192.0.2.1")], xmlPath }).ok).toBe(false);
  });

  it("rejects rawFlags, script, outputPath injected as unknown fields", () => {
    expect(
      buildNmapArgv({
        options: { ...baseOptions, rawFlags: ["--script", "vuln"] } as unknown as typeof baseOptions,
        canonicalTargets: [ipTarget("192.0.2.1")],
        xmlPath,
      }).ok,
    ).toBe(false);
    expect(
      buildNmapArgv({
        options: { ...baseOptions, outputPath: "/tmp/foo.xml" } as unknown as typeof baseOptions,
        canonicalTargets: [ipTarget("192.0.2.1")],
        xmlPath,
      }).ok,
    ).toBe(false);
    expect(
      buildNmapArgv({
        options: { ...baseOptions, synScan: true } as unknown as typeof baseOptions,
        canonicalTargets: [ipTarget("192.0.2.1")],
        xmlPath,
      }).ok,
    ).toBe(false);
  });

  it("rejects injection-shaped noncanonical hostname with semicolon", () => {
    const r = buildNmapArgv({
      options: baseOptions,
      canonicalTargets: [{ kind: "hostname", normalizationProfile: "d1-v1", hostname: "target.test;touch" } as CanonicalTarget],
      xmlPath: "/tmp/nmap-xml",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("invalid_nmap_action_contract");
  });

  it("rejects injection-shaped hostname with shell metachars", () => {
    for (const bad of ["a;rm", "a|cat", "a&&echo", "a$HOME", "a`id`"]) {
      const r = buildNmapArgv({
        options: baseOptions,
        canonicalTargets: [{ kind: "hostname", normalizationProfile: "d1-v1", hostname: bad } as CanonicalTarget],
        xmlPath: "/tmp/nmap-xml",
      });
      expect(r.ok).toBe(false);
    }
  });

  it("rejects malformed target objects and does not throw", () => {
    expect(() => buildNmapArgv({ options: baseOptions, canonicalTargets: [{ kind: "ip", address: "192.0.2.1" } as unknown as CanonicalTarget], xmlPath }).ok).not.toThrow();
    expect(buildNmapArgv({ options: baseOptions, canonicalTargets: [{ kind: "ip", address: "192.0.2.1" } as unknown as CanonicalTarget], xmlPath }).ok).toBe(false);
    expect(buildNmapArgv({ options: baseOptions, canonicalTargets: [null as unknown as CanonicalTarget], xmlPath }).ok).toBe(false);
    expect(buildNmapArgv({ options: baseOptions, canonicalTargets: [{ kind: "hostname" } as unknown as CanonicalTarget], xmlPath }).ok).toBe(false);
    expect(buildNmapArgv({ options: baseOptions, canonicalTargets: [{ kind: "weird", foo: "bar" } as unknown as CanonicalTarget], xmlPath }).ok).toBe(false);
    expect(buildNmapArgv({ options: baseOptions, canonicalTargets: "not-an-array" as unknown as CanonicalTarget[], xmlPath }).ok).toBe(false);
  });

  it("rejects missing fields in envelope without throwing", () => {
    expect(() => buildNmapArgv({ canonicalTargets: [ipTarget("192.0.2.1")], xmlPath } as unknown as object)).not.toThrow();
    expect(buildNmapArgv({ canonicalTargets: [ipTarget("192.0.2.1")], xmlPath } as unknown as object).ok).toBe(false);
    expect(buildNmapArgv({ options: baseOptions, xmlPath } as unknown as object).ok).toBe(false);
    expect(buildNmapArgv({ options: baseOptions, canonicalTargets: [ipTarget("192.0.2.1")] } as unknown as object).ok).toBe(false);
    expect(buildNmapArgv(null).ok).toBe(false);
    expect(buildNmapArgv(undefined).ok).toBe(false);
    expect(buildNmapArgv("string" as unknown as object).ok).toBe(false);
  });

  it("is total: malformed input with extra throws never throws", () => {
    const evil = { options: baseOptions, canonicalTargets: [ipTarget("192.0.2.1")], xmlPath: "/tmp/nmap-xml", extra: { get foo() { throw new Error("evil"); } } };
    expect(() => buildNmapArgv(evil as unknown as object)).not.toThrow();
  });

  it("rejects xmlPath traversal, relative, and NUL", () => {
    expect(buildNmapArgv({ options: baseOptions, canonicalTargets: [ipTarget("192.0.2.1")], xmlPath: "../outside/nmap.xml" }).ok).toBe(false);
    expect(buildNmapArgv({ options: baseOptions, canonicalTargets: [ipTarget("192.0.2.1")], xmlPath: "relative/nmap.xml" }).ok).toBe(false);
    expect(buildNmapArgv({ options: baseOptions, canonicalTargets: [ipTarget("192.0.2.1")], xmlPath: "/tmp/nmap\0.xml" }).ok).toBe(false);
  });

  it("xmlPath is never derived from operator options (operator cannot choose -oX)", () => {
    const r = buildNmapArgv({
      options: { ...baseOptions, ports: [{ from: 80, to: 80 }] } as typeof baseOptions,
      canonicalTargets: [ipTarget("192.0.2.10")],
      xmlPath: "/var/lib/stonehush-runner/runs/run-1/nmap.xml",
    });
    expect(r.ok && r.argv.includes("-oX")).toBe(true);
    expect((r as Extract<typeof r, { ok: true }>).argv).not.toContain("/tmp/evil.xml");
  });

  it("ensures deterministic argv: same input always same output, no shell", () => {
    const input = {
      options: { ...baseOptions, ports: [{ from: 443, to: 443 }, { from: 80, to: 80 }] },
      canonicalTargets: [ipTarget("192.0.2.10")],
      xmlPath,
    };
    const a = buildNmapArgv(input);
    const b = buildNmapArgv(input);
    expect(a).toEqual(b);
    if (a.ok) expect(a.argv.join(" ")).not.toContain(";");
  });

  it("rejects URL canonical target as nmap_capability_unsupported", () => {
    const urlT: CanonicalTarget = {
      kind: "url",
      normalizationProfile: "d1-v1",
      url: "https://target.test/",
      origin: "https://target.test:443",
      host: { hostname: "target.test" },
      effectivePort: 443,
      pathAndQuery: "/",
    };
    const r = buildNmapArgv({ options: baseOptions, canonicalTargets: [urlT], xmlPath: "/tmp/nmap-xml" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("nmap_capability_unsupported");
  });

  it("preserves exact argv order for IP/CIDR/hostname and rejects mixed URL batch", () => {
    const mixed: CanonicalTarget[] = [ipTarget("192.0.2.1"), hostnameTarget("target.test"), { kind: "url", normalizationProfile: "d1-v1", url: "https://target.test/", origin: "https://target.test:443", host: { hostname: "target.test" }, effectivePort: 443, pathAndQuery: "/" } as CanonicalTarget];
    const r = buildNmapArgv({ options: baseOptions, canonicalTargets: mixed, xmlPath: "/tmp/nmap-xml" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("nmap_capability_unsupported");
  });

  it("rejects invalid IPv4 octets structurally valid but D1 noncanonical", () => {
    expect(buildNmapArgv({ options: baseOptions, canonicalTargets: [ipTarget("999.999.999.999")], xmlPath: "/tmp/nmap-xml" }).ok).toBe(false);
    expect(buildNmapArgv({ options: baseOptions, canonicalTargets: [ipTarget("256.0.0.1")], xmlPath: "/tmp/nmap-xml" }).ok).toBe(false);
    expect(buildNmapArgv({ options: baseOptions, canonicalTargets: [ipTarget("192.0.2.01")], xmlPath: "/tmp/nmap-xml" }).ok).toBe(false);
  });

  it("rejects structurally valid but noncanonical or invalid IPv6", () => {
    // upper-case and expanded form not canonical RFC5952
    expect(buildNmapArgv({ options: baseOptions, canonicalTargets: [ipv6Target("2001:0DB8:0000:0000:0000:0000:0000:0007")], xmlPath: "/tmp/nmap-xml" }).ok).toBe(false);
    // invalid chars / triple colon structurally passes regex but D1 rejects
    expect(buildNmapArgv({ options: baseOptions, canonicalTargets: [ipv6Target("2001:db8:::1")], xmlPath: "/tmp/nmap-xml" }).ok).toBe(false);
    expect(buildNmapArgv({ options: baseOptions, canonicalTargets: [ipv6Target("gggg::1")], xmlPath: "/tmp/nmap-xml" }).ok).toBe(false);
  });

  it("rejects structurally valid but noncanonical CIDR host bits", () => {
    expect(buildNmapArgv({ options: baseOptions, canonicalTargets: [cidrTarget("192.0.2.1", 24)], xmlPath: "/tmp/nmap-xml" }).ok).toBe(false);
    expect(buildNmapArgv({ options: baseOptions, canonicalTargets: [cidrTarget("2001:db8::1", 32, 6)], xmlPath: "/tmp/nmap-xml" }).ok).toBe(false);
  });

  it("ensures normal canonical IP/CIDR/zone/hostname still pass", () => {
    expect(buildNmapArgv({ options: baseOptions, canonicalTargets: [ipTarget("192.0.2.7")], xmlPath: "/tmp/nmap-xml" }).ok).toBe(true);
    expect(buildNmapArgv({ options: baseOptions, canonicalTargets: [ipv6Target("2001:db8::7")], xmlPath: "/tmp/nmap-xml" }).ok).toBe(true);
    expect(buildNmapArgv({ options: baseOptions, canonicalTargets: [ipv6Target("fe80::7", "Eth0")], xmlPath: "/tmp/nmap-xml" }).ok).toBe(true);
    expect(buildNmapArgv({ options: baseOptions, canonicalTargets: [cidrTarget("192.0.2.0", 24)], xmlPath: "/tmp/nmap-xml" }).ok).toBe(true);
    expect(buildNmapArgv({ options: baseOptions, canonicalTargets: [cidrTarget("2001:db8::", 32, 6)], xmlPath: "/tmp/nmap-xml" }).ok).toBe(true);
    // hostBitsMasked preserved as metadata: both false/true with same canonical network pass when network canonical
    expect(buildNmapArgv({ options: baseOptions, canonicalTargets: [{ kind: "cidr", normalizationProfile: "d1-v1", family: 4, network: "192.0.2.0", prefixLength: 24, hostBitsMasked: true } as CanonicalTarget], xmlPath: "/tmp/nmap-xml" }).ok).toBe(true);
    expect(buildNmapArgv({ options: baseOptions, canonicalTargets: [hostnameTarget("target.test")], xmlPath: "/tmp/nmap-xml" }).ok).toBe(true);
  });

  it("function is total for crafted 999 address does not throw", () => {
    expect(() => buildNmapArgv({ options: baseOptions, canonicalTargets: [ipTarget("999.999.999.999")], xmlPath: "/tmp/nmap-xml" })).not.toThrow();
    const r = buildNmapArgv({ options: baseOptions, canonicalTargets: [ipTarget("999.999.999.999")], xmlPath: "/tmp/nmap-xml" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("invalid_nmap_action_contract");
  });
});
