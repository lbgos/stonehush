import { describe, expect, it } from "vitest";

import { buildVhostArgv } from "./ffuf-vhost-argv.js";

const validBase = {
  address: "192.0.2.10",
  port: 80,
  tls: false,
  wordlistPath: "/lists/hosts.txt",
  outputJsonPath: "/runs/run-1/vhost.json",
} as const;

describe("buildVhostArgv", () => {
  it("builds deterministic Host header fuzzing argv", () => {
    const built = buildVhostArgv({ ...validBase });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.baseUrl).toBe("http://192.0.2.10:80/");
    expect(built.argv).toEqual([
      "ffuf",
      "-u",
      "http://192.0.2.10:80/",
      "-w",
      "/lists/hosts.txt",
      "-H",
      "Host: FUZZ",
      "-o",
      "/runs/run-1/vhost.json",
      "-of",
      "json",
      "-t",
      "40",
      "-timeout",
      "10",
      "-maxtime",
      "120",
      "-mc",
      "200,204,301,302,307,308,401,403",
      "-s",
    ]);
  });

  it("uses https and brackets IPv6 targets", () => {
    const built = buildVhostArgv({ ...validBase, address: "2001:db8::1", port: 443, tls: true });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.baseUrl).toBe("https://[2001:db8::1]:443/");
    expect(built.argv).toContain("https://[2001:db8::1]:443/");
    expect(built.argv).toContain("Host: FUZZ");
  });

  it("dedupes and sorts match codes, rejects bad contracts and NUL bytes", () => {
    const sorted = buildVhostArgv({ ...validBase, matchStatusCodes: [403, 200, 200] });
    expect(sorted.ok).toBe(true);
    if (sorted.ok) expect(sorted.argv).toContain("200,403");
    expect(buildVhostArgv({ ...validBase, address: "" }).ok).toBe(false);
    expect(buildVhostArgv({ ...validBase, wordlistPath: "relative.txt" }).ok).toBe(false);
    expect(buildVhostArgv({ ...validBase, outputJsonPath: "/x\0.json" }).ok).toBe(false);
    expect(buildVhostArgv({ ...validBase, extra: true } as unknown as object).ok).toBe(false);
  });

  it("never emits rate or auto-calibration flags", () => {
    const built = buildVhostArgv({ ...validBase, rate: 500 });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.argv.join(" ")).not.toContain("-rate");
    expect(built.argv.join(" ")).not.toContain("-ac");
  });
});
