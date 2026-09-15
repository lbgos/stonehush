import { describe, expect, it } from "vitest";

import { buildFfufArgv } from "./ffuf-argv.js";

const baseOptions = {
  origin: "http://127.0.0.1:3130",
  wordlistPath: "/var/lib/stonehush/wordlists/smoke.txt",
  outputJsonPath: "/var/lib/stonehush/runs/run-1/ffuf.json",
};

describe("buildFfufArgv deterministic order", () => {
  it("emits the exact fixed order with defaults applied", () => {
    const result = buildFfufArgv({ ...baseOptions });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.argv).toEqual([
        "ffuf",
        "-u",
        "http://127.0.0.1:3130/FUZZ",
        "-w",
        "/var/lib/stonehush/wordlists/smoke.txt",
        "-o",
        "/var/lib/stonehush/runs/run-1/ffuf.json",
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
    }
  });

  it("emits explicit numerics and a sorted deduped -mc csv", () => {
    const result = buildFfufArgv({
      ...baseOptions,
      rate: 500,
      threads: 10,
      timeoutSeconds: 5,
      maxTimeSeconds: 60,
      matchStatusCodes: [403, 200, 200, 301],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.argv).toContain("-t");
      expect(result.argv[result.argv.indexOf("-t") + 1]).toBe("10");
      expect(result.argv[result.argv.indexOf("-timeout") + 1]).toBe("5");
      expect(result.argv[result.argv.indexOf("-maxtime") + 1]).toBe("60");
      expect(result.argv[result.argv.indexOf("-mc") + 1]).toBe("200,301,403");
      // -rate is validated but never emitted: ffuf 1.1.0 rejects it.
      expect(result.argv).not.toContain("-rate");
    }
  });

  it("strips a trailing slash before appending /FUZZ", () => {
    const result = buildFfufArgv({ ...baseOptions, origin: "https://target.test:8443/dir/" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.argv[result.argv.indexOf("-u") + 1]).toBe("https://target.test:8443/dir/FUZZ");
    }
  });

  it("keeps an origin with spaces/semicolons as a single argv element", () => {
    const origin = "http://127.0.0.1:3130/; rm -rf /";
    const result = buildFfufArgv({ ...baseOptions, origin });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const u = result.argv[result.argv.indexOf("-u") + 1];
      expect(u).toBe("http://127.0.0.1:3130/; rm -rf /FUZZ");
      expect(result.argv.filter((a) => a.includes("rm"))).toHaveLength(1);
    }
  });

  it("is deterministic for the same input", () => {
    const input = { ...baseOptions, matchStatusCodes: [403, 200] };
    expect(buildFfufArgv(input)).toEqual(buildFfufArgv(input));
  });

  it("rejects non-http schemes", () => {
    const result = buildFfufArgv({ ...baseOptions, origin: "ftp://127.0.0.1/" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_ffuf_action_contract");
  });

  it("rejects traversal and relative managed paths", () => {
    expect(buildFfufArgv({ ...baseOptions, wordlistPath: "../etc/words" }).ok).toBe(false);
    expect(buildFfufArgv({ ...baseOptions, wordlistPath: "/lists/../etc/words" }).ok).toBe(false);
    expect(buildFfufArgv({ ...baseOptions, outputJsonPath: "relative/out.json" }).ok).toBe(false);
    expect(buildFfufArgv({ ...baseOptions, outputJsonPath: "/runs/../etc/out.json" }).ok).toBe(false);
    const bad = buildFfufArgv({ ...baseOptions, outputJsonPath: "/runs/../etc/out.json" });
    if (!bad.ok) expect(bad.error.code).toBe("invalid_ffuf_action_contract");
  });

  it("rejects bad codes and out-of-range numerics without throwing", () => {
    expect(() => buildFfufArgv({ ...baseOptions, matchStatusCodes: [99] })).not.toThrow();
    expect(buildFfufArgv({ ...baseOptions, matchStatusCodes: [] }).ok).toBe(false);
    expect(buildFfufArgv({ ...baseOptions, matchStatusCodes: [200, 600] }).ok).toBe(false);
    expect(buildFfufArgv({ ...baseOptions, threads: 201 }).ok).toBe(false);
    expect(buildFfufArgv({ ...baseOptions, rate: 0 }).ok).toBe(false);
    expect(buildFfufArgv(null).ok).toBe(false);
    expect(buildFfufArgv(undefined).ok).toBe(false);
  });
});
