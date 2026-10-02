import type {
  FfufProjected,
  HttpProbeProjected,
  NmapProjectedService,
  PersistedAction,
  RunHistorySummary,
  RunOutputResponse,
} from "@stonehush/contracts";
import { diffRuns } from "@stonehush/domain";
import { describe, expect, it } from "vitest";

import {
  actionBindingSummary,
  actionOptionsSummary,
  buildPriorAttempt,
  buildRunCompareInput,
  describeRunOutcome,
  resolveRunComparison,
  runSideComplete,
  stableStringifyOptions,
  RUN_COMPARE_BINDING_UNAVAILABLE,
  RUN_COMPARE_OPTIONS_UNAVAILABLE,
} from "./run-compare.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;

function nmapService(
  runId: string,
  overrides: Partial<NmapProjectedService> = {},
): NmapProjectedService {
  return {
    address: "192.0.2.10",
    port: 80,
    protocol: "tcp",
    hostname: null,
    serviceName: "http",
    product: null,
    version: null,
    source: "nmap",
    parserVersion: "nmap-xml-v1",
    runId,
    artifactId: "artifact-1",
    artifactDigest: DIGEST_A,
    observedAt: "2026-08-13T12:00:00.000Z",
    ...overrides,
  };
}

function ffufResult(runId: string, url: string, overrides: Partial<FfufProjected> = {}): FfufProjected {
  return {
    source: "ffuf",
    parserVersion: "ffuf-json-v1",
    url,
    status: 200,
    length: 100,
    words: 10,
    lines: 5,
    redirectlocation: null,
    fuzz: "admin",
    runId,
    artifactId: "artifact-9",
    artifactDigest: DIGEST_A,
    observedAt: "2026-08-13T12:00:00.000Z",
    ...overrides,
  };
}

function httpProbe(runId: string, url: string, overrides: Partial<HttpProbeProjected> = {}): HttpProbeProjected {
  return {
    parserVersion: "http-probe-raw-v1",
    url,
    fetchedAt: "2026-08-13T12:00:00.000Z",
    finalUrl: url,
    status: 200,
    title: "lab",
    selectedHeaders: { contentType: "text/html", server: null, poweredBy: null },
    hops: [],
    error: null,
    source: "http-probe",
    runId,
    artifactId: "artifact-7",
    artifactDigest: DIGEST_A,
    observedAt: "2026-08-13T12:00:00.000Z",
    ...overrides,
  };
}

const EMPTY = { services: [], probes: [], results: [] } as const;

function historyRun(id: string, overrides: Partial<RunHistorySummary> = {}): RunHistorySummary {
  return {
    id,
    actionId: "action-1",
    state: "succeeded",
    terminalKind: "succeeded",
    terminalReason: null,
    updatedAt: "2026-08-10T12:00:00.000Z",
    createdAt: "2026-08-10T11:00:00.000Z",
    attempt: 1,
    ...overrides,
  };
}

function runOutput(runId: string, truncated: boolean): RunOutputResponse {
  return {
    run: {
      id: runId,
      actionId: "action-1",
      state: "succeeded",
      terminalKind: "succeeded",
      terminalReason: null,
      updatedAt: "2026-08-10T12:00:00.000Z",
    },
    stdout: {
      present: true,
      artifactId: "artifact-out",
      sizeBytes: 4,
      digest: DIGEST_A,
      completeness: "complete",
      truncated,
      content: "bytes",
    },
    stderr: { present: false, truncated: false, content: "" },
  } as RunOutputResponse;
}

describe("resolveRunComparison", () => {
  it("resolves an nmap run to its observed addresses", () => {
    const resolved = resolveRunComparison("run-1", {
      ...EMPTY,
      services: [nmapService("run-1"), nmapService("run-1", { address: "192.0.2.11", port: 22, artifactId: "artifact-2" })],
    });
    expect(resolved).toEqual({
      ok: true,
      value: { runId: "run-1", tool: "nmap", origin: "192.0.2.10, 192.0.2.11", observationCount: 2 },
    });
  });

  it("resolves ffuf and probe runs to the URL origin", () => {
    const ffuf = resolveRunComparison("run-f", {
      ...EMPTY,
      results: [
        ffufResult("run-f", "http://target.test:8080/admin"),
        ffufResult("run-f", "http://target.test:8080/login", { fuzz: "login", artifactId: "artifact-10" }),
      ],
    });
    expect(ffuf).toEqual({
      ok: true,
      value: { runId: "run-f", tool: "ffuf", origin: "http://target.test:8080", observationCount: 2 },
    });
    const probe = resolveRunComparison("run-p", {
      ...EMPTY,
      probes: [httpProbe("run-p", "https://target.test/")],
    });
    expect(probe).toEqual({
      ok: true,
      value: { runId: "run-p", tool: "http-probe", origin: "https://target.test", observationCount: 1 },
    });
  });

  it("refuses runs with no observations instead of guessing", () => {
    expect(resolveRunComparison("run-9", EMPTY)).toEqual({
      ok: false,
      reason: "No recorded observations for this run in the current projections.",
    });
    // Rows for other runs never leak into this run.
    expect(
      resolveRunComparison("run-9", { ...EMPTY, services: [nmapService("run-1")] }),
    ).toEqual({
      ok: false,
      reason: "No recorded observations for this run in the current projections.",
    });
  });

  it("refuses multi-tool and multi-origin runs as ambiguous", () => {
    expect(
      resolveRunComparison("run-1", {
        ...EMPTY,
        services: [nmapService("run-1")],
        results: [ffufResult("run-1", "http://target.test/x")],
      }),
    ).toMatchObject({ ok: false });
    expect(
      resolveRunComparison("run-f", {
        ...EMPTY,
        results: [
          ffufResult("run-f", "http://one.test/a"),
          ffufResult("run-f", "http://two.test/b", { fuzz: "b" }),
        ],
      }),
    ).toMatchObject({ ok: false });
    expect(
      resolveRunComparison("run-f", { ...EMPTY, results: [ffufResult("run-f", "not a url")] }),
    ).toMatchObject({ ok: false });
  });
});

describe("action summaries", () => {
  function persistedAction(typedOptions: Record<string, unknown>, targets: string): PersistedAction {
    return {
      action: {
        snapshots: [
          {
            version: 2,
            canonicalTargets: [{ kind: "ip", address: targets, zone: null, normalizationProfile: "d1-v1" }],
            typedOptions,
          },
        ],
      },
    } as unknown as PersistedAction;
  }

  it("summarizes options deterministically regardless of key order", () => {
    const first = persistedAction({ rate: 100, threads: 40 }, "192.0.2.10");
    const second = persistedAction({ threads: 40, rate: 100 }, "192.0.2.10");
    expect(actionOptionsSummary(first)).toBe(actionOptionsSummary(second));
    expect(actionOptionsSummary(first)).toBe('{"rate":100,"threads":40}');
    expect(actionBindingSummary(first)).toBe("192.0.2.10");
  });

  it("names unavailable action records instead of inventing context", () => {
    expect(actionOptionsSummary(undefined)).toBe(RUN_COMPARE_OPTIONS_UNAVAILABLE);
    expect(actionBindingSummary(undefined)).toBe(RUN_COMPARE_BINDING_UNAVAILABLE);
  });
});

describe("outcome and completeness", () => {
  it("names terminal states factually", () => {
    expect(describeRunOutcome(historyRun("r"))).toBe("succeeded");
    expect(describeRunOutcome(historyRun("r", { state: "failed", terminalKind: "failed", terminalReason: "timeout" }))).toBe(
      "failed (timeout)",
    );
    expect(describeRunOutcome(historyRun("r", { state: "failed", terminalKind: "failed" }))).toBe("failed");
    expect(describeRunOutcome(historyRun("r", { state: "cancelled", terminalKind: "cancelled" }))).toBe(
      "cancelled (interrupted; partial evidence only)",
    );
  });

  it("counts only succeeded runs with intact output as complete", () => {
    expect(runSideComplete(historyRun("r"), runOutput("r", false))).toBe(true);
    expect(runSideComplete(historyRun("r"), runOutput("r", true))).toBe(false);
    expect(runSideComplete(historyRun("r", { state: "failed", terminalKind: "failed" }), runOutput("r", false))).toBe(false);
    expect(runSideComplete(historyRun("r"), undefined)).toBe(false);
    // Foreign output never counts for this run.
    expect(runSideComplete(historyRun("r"), runOutput("other", false))).toBe(false);
  });
});

describe("buildRunCompareInput", () => {
  it("maps exact run observations and keeps domain honesty rules", () => {
    const before = historyRun("run-old");
    const after = historyRun("run-new");
    const projections = {
      services: [
        nmapService("run-old"),
        nmapService("run-new", { product: "nginx", version: "1.25", artifactId: "artifact-2" }),
        nmapService("run-new", { port: 443, serviceName: "https", artifactId: "artifact-3" }),
      ],
      probes: [],
      results: [],
    };
    const input = buildRunCompareInput({
      before: {
        run: before,
        context: { tool: "nmap", origin: "192.0.2.10", ports: null, optionsSummary: "{}", authSummary: null, binding: "192.0.2.10" },
        complete: true,
      },
      after: {
        run: after,
        context: { tool: "nmap", origin: "192.0.2.10", ports: null, optionsSummary: "{}", authSummary: null, binding: "192.0.2.10" },
        complete: true,
      },
      projections,
    });
    const diff = diffRuns(input);
    expect(diff.comparable).toBe(true);
    expect(diff.newServices).toHaveLength(1);
    expect(diff.changedServices).toHaveLength(1);
    // Requested ports and auth stay unknown, never invented.
    expect(input.before.context.ports).toBeNull();
    expect(input.before.context.authSummary).toBeNull();
  });

  it("preserves domain refusal for different tools", () => {
    const input = buildRunCompareInput({
      before: {
        run: historyRun("run-old"),
        context: { tool: "nmap", origin: "192.0.2.10", ports: null, optionsSummary: "{}", authSummary: null, binding: "192.0.2.10" },
        complete: true,
      },
      after: {
        run: historyRun("run-new"),
        context: { tool: "ffuf", origin: "http://target.test", ports: null, optionsSummary: "{}", authSummary: null, binding: "http://target.test" },
        complete: true,
      },
      projections: EMPTY,
    });
    const diff = diffRuns(input);
    expect(diff.comparable).toBe(false);
    expect(diff.newServices).toHaveLength(0);
  });

  it("carries untrusted strings through unchanged without interpreting them", () => {
    const hostile = '<img src=x onerror=alert(1)>"; DROP TABLE runs; --';
    const input = buildRunCompareInput({
      before: {
        run: historyRun("run-old"),
        context: { tool: "http-probe", origin: "http://target.test", ports: null, optionsSummary: "{}", authSummary: null, binding: "http://target.test" },
        complete: true,
      },
      after: {
        run: historyRun("run-new"),
        context: { tool: "http-probe", origin: "http://target.test", ports: null, optionsSummary: "{}", authSummary: null, binding: "http://target.test" },
        complete: true,
      },
      projections: {
        ...EMPTY,
        probes: [
          httpProbe("run-old", "http://target.test/", { title: hostile }),
          httpProbe("run-new", "http://target.test/", { title: hostile, status: 404, artifactId: "artifact-8" }),
        ],
      },
    });
    const diff = diffRuns(input);
    expect(diff.changedResponses).toHaveLength(1);
    expect(diff.changedResponses[0]).toContain(hostile);
  });
});

describe("buildPriorAttempt", () => {
  it("names the exact prior run, time, outcome, and options", () => {
    const attempt = buildPriorAttempt({
      run: historyRun("run-old"),
      optionsSummary: '{"rate":100}',
      conditionsChanged: false,
    });
    expect(attempt).toEqual({
      runId: "run-old",
      attemptedAt: "2026-08-10T11:00:00.000Z",
      optionsSummary: '{"rate":100}',
      outcome: "succeeded",
      conditionsChanged: false,
    });
  });

  it("keeps option summaries stable for identical option sets", () => {
    expect(stableStringifyOptions({ b: 1, a: [3, 2] })).toBe('{"a":[3,2],"b":1}');
  });
});
