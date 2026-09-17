import path from "node:path";
import { describe, expect, it } from "vitest";

import { prepareVhostExecution } from "./runner.js";
import type { ActionSnapshot } from "@stonehush/contracts";

function snapshot(overrides: Partial<ActionSnapshot> = {}): ActionSnapshot {
  return {
    normalizationProfile: "d1-v1",
    orchestrationProfile: "d2-v1",
    snapshotId: "00000000-0000-4000-8000-000000000001",
    version: 1,
    binding: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    actionId: "00000000-0000-4000-8000-000000000002",
    canonicalTargets: [
      {
        kind: "ip",
        normalizationProfile: "d1-v1",
        family: 4,
        address: "192.0.2.10",
        zone: null,
      },
    ],
    concreteDestinations: [],
    typedOptions: {
      declaredPorts: [80],
      ffufVhost: {
        address: "192.0.2.10",
        port: 80,
        tls: false,
        wordlistPath: "/lists/hosts.txt",
        rate: 100,
        threads: 40,
        timeoutSeconds: 10,
        maxTimeSeconds: 120,
        matchStatusCodes: [200],
      },
    },
    resolutionSnapshots: [],
    scopeRevisionId: null,
    warningState: { reasonCodes: [], knownAdditions: [], acknowledgment: null },
    ...overrides,
  } as ActionSnapshot;
}

describe("prepareVhostExecution", () => {
  it("derives runner-owned output path and Host header argv", () => {
    const runRoot = path.join("/tmp", "vhost-test-root");
    const prepared = prepareVhostExecution({
      snapshot: snapshot(),
      runRoot,
      runId: "run-1",
      fence: "1",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.options.outputJsonPath).toBe(path.join(runRoot, "run-run-1-f1", "vhost.json"));
    expect(prepared.argv.slice(0, 7)).toEqual([
      "ffuf",
      "-u",
      "http://192.0.2.10:80/",
      "-w",
      "/lists/hosts.txt",
      "-H",
      "Host: FUZZ",
    ]);
  });

  it("fails closed on corrupt markers and ignores non-vhost snapshots", () => {
    const corrupt = prepareVhostExecution({
      snapshot: snapshot({
        typedOptions: { declaredPorts: [80], ffufVhost: { address: "" } },
      } as unknown as Partial<ActionSnapshot>),
      runRoot: "/runs",
      runId: "run-1",
      fence: "1",
    });
    expect(corrupt).toEqual({ ok: false, reason: "invalid_action_snapshot" });

    const plain = prepareVhostExecution({
      snapshot: snapshot({ typedOptions: { declaredPorts: null } } as unknown as Partial<ActionSnapshot>),
      runRoot: "/runs",
      runId: "run-1",
      fence: "1",
    });
    expect(plain).toEqual({ ok: false, reason: "not_vhost_snapshot" });
  });
});
