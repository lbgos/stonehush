import { describe, expect, it } from "vitest";

import type { ActionSnapshot } from "@stonehush/contracts";

import { hasVhostMarker, isVhostSnapshot, vhostOptionsForSnapshot } from "./ffuf-vhost-action.js";

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

describe("vhost snapshot marker", () => {
  it("matches a single IP target with valid vhost options", () => {
    const candidate = snapshot();
    expect(isVhostSnapshot(candidate)).toBe(true);
    expect(vhostOptionsForSnapshot(candidate)).toMatchObject({ address: "192.0.2.10", port: 80 });
    expect(hasVhostMarker(candidate)).toBe(true);
  });

  it("rejects URL targets and corrupt markers fail closed", () => {
    const url = snapshot({
      canonicalTargets: [
        {
          kind: "url",
          normalizationProfile: "d1-v1",
          url: "http://192.0.2.10:80/",
          origin: "http://192.0.2.10:80",
          host: { address: "192.0.2.10", zone: null },
          effectivePort: 80,
          pathAndQuery: "/",
        },
      ],
    } as Partial<ActionSnapshot>);
    expect(isVhostSnapshot(url)).toBe(false);
    expect(vhostOptionsForSnapshot(url)).toBe(null);

    const corrupt = snapshot({
      typedOptions: { declaredPorts: [80], ffufVhost: { address: "", port: 0 } },
    } as unknown as Partial<ActionSnapshot>);
    expect(hasVhostMarker(corrupt)).toBe(true);
    expect(isVhostSnapshot(corrupt)).toBe(false);
    expect(vhostOptionsForSnapshot(corrupt)).toBe(null);
  });

  it("ignores the ffuf content-discovery marker", () => {
    const ffuf = snapshot({
      typedOptions: {
        declaredPorts: null,
        ffuf: { origin: "http://192.0.2.10:80/", wordlistPath: "/lists/x.txt" },
      },
    } as unknown as Partial<ActionSnapshot>);
    expect(hasVhostMarker(ffuf)).toBe(false);
    expect(isVhostSnapshot(ffuf)).toBe(false);
  });
});
