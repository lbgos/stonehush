import { describe, expect, it } from "vitest";

import {
  FFUF_VHOST_DEFAULT_PORT,
  FFUF_VHOST_PARSER_VERSION,
  FfufVhostActionOptionsSchema,
  FfufVhostDiscoveryLaunchRequestSchema,
  FfufVhostDiscoveryLaunchSchema,
  FfufVhostProjectedSchema,
  isVhostArtifactSlot,
  vhostBaseUrl,
} from "./ffuf-vhost.js";

const validBase = {
  address: "192.0.2.10",
  wordlistPath: "/var/lib/stonehush/wordlists/hosts.txt",
  outputJsonPath: "/var/lib/stonehush/runs/run-1/vhost.json",
} as const;

describe("FfufVhostActionOptionsSchema", () => {
  it("applies defaults for port, tls, rate, threads, timeouts, and match codes", () => {
    const parsed = FfufVhostActionOptionsSchema.safeParse({ ...validBase });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toMatchObject({
        port: FFUF_VHOST_DEFAULT_PORT,
        tls: false,
        rate: 100,
        threads: 40,
        timeoutSeconds: 10,
        maxTimeSeconds: 120,
      });
    }
  });

  it("rejects blank addresses and bad ports", () => {
    expect(FfufVhostActionOptionsSchema.safeParse({ ...validBase, address: "" }).success).toBe(false);
    expect(FfufVhostActionOptionsSchema.safeParse({ ...validBase, address: "  " }).success).toBe(false);
    expect(FfufVhostActionOptionsSchema.safeParse({ ...validBase, port: 0 }).success).toBe(false);
    expect(FfufVhostActionOptionsSchema.safeParse({ ...validBase, port: 70_000 }).success).toBe(false);
  });

  it("rejects relative and traversal wordlist/output paths", () => {
    expect(
      FfufVhostActionOptionsSchema.safeParse({ ...validBase, wordlistPath: "relative/words.txt" }).success,
    ).toBe(false);
    expect(
      FfufVhostActionOptionsSchema.safeParse({ ...validBase, wordlistPath: "/lists/../etc/passwd" }).success,
    ).toBe(false);
  });

  it("rejects unknown fields (strict, no passthrough)", () => {
    expect(
      FfufVhostActionOptionsSchema.safeParse({ ...validBase, rawFlags: ["-ac"] } as unknown as object).success,
    ).toBe(false);
  });
});

describe("vhostBaseUrl", () => {
  it("builds http and https base URLs with explicit ports", () => {
    expect(vhostBaseUrl({ address: "192.0.2.10", port: 80, tls: false })).toBe("http://192.0.2.10:80/");
    expect(vhostBaseUrl({ address: "192.0.2.10", port: 443, tls: true })).toBe("https://192.0.2.10:443/");
  });

  it("brackets IPv6 literals", () => {
    expect(vhostBaseUrl({ address: "2001:db8::1", port: 8080, tls: false })).toBe(
      "http://[2001:db8::1]:8080/",
    );
  });
});

describe("FfufVhostDiscoveryLaunchSchema", () => {
  const launch = {
    expectedEngagementRevision: 1,
    expectedActiveScopeRevisionId: null,
    address: "192.0.2.10",
    wordlistPath: "/var/lib/stonehush/wordlists/hosts.txt",
  } as const;

  it("applies port/tls/option defaults and omits the runner-owned output path", () => {
    const parsed = FfufVhostDiscoveryLaunchSchema.safeParse({ ...launch });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toMatchObject({ port: 80, tls: false, rate: 100, threads: 40 });
      expect("outputJsonPath" in parsed.data).toBe(false);
    }
  });
});

describe("FfufVhostDiscoveryLaunchRequestSchema", () => {
  const minimal = {
    expectedEngagementRevision: 1,
    expectedActiveScopeRevisionId: null,
    address: "192.0.2.10",
  } as const;

  it("accepts a minimal launch and an empty wordlist as a stored-default marker", () => {
    expect(FfufVhostDiscoveryLaunchRequestSchema.safeParse({ ...minimal }).success).toBe(true);
    expect(
      FfufVhostDiscoveryLaunchRequestSchema.safeParse({ ...minimal, wordlistPath: "" }).success,
    ).toBe(true);
  });

  it("rejects invalid explicit values and unknown fields", () => {
    expect(
      FfufVhostDiscoveryLaunchRequestSchema.safeParse({ ...minimal, port: 0 }).success,
    ).toBe(false);
    expect(
      FfufVhostDiscoveryLaunchRequestSchema.safeParse({ ...minimal, wordlistPath: "../etc/words" }).success,
    ).toBe(false);
  });
});

describe("vhost projection contract", () => {
  it("accepts projected rows and the vhost-json slot only", () => {
    expect(isVhostArtifactSlot("vhost-json")).toBe(true);
    expect(isVhostArtifactSlot("ffuf-json")).toBe(false);
    const parsed = FfufVhostProjectedSchema.safeParse({
      source: "ffuf-vhost",
      parserVersion: FFUF_VHOST_PARSER_VERSION,
      hostname: "admin.internal",
      baseUrl: "http://192.0.2.10:80/",
      status: 200,
      length: 512,
      words: 40,
      lines: 12,
      runId: "run-1",
      artifactId: "artifact-1",
      artifactDigest: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      observedAt: "2026-09-03T00:00:00.000Z",
    });
    expect(parsed.success).toBe(true);
  });
});
