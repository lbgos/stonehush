import { describe, expect, it } from "vitest";

import { calibrateVhostResults, calibrateVhostResultsByArtifact } from "./ffuf-vhost-filter.js";

function entry(hostname: string, status = 200, length = 100) {
  return { hostname, status, length, words: 10, lines: 2 };
}

describe("calibrateVhostResults", () => {
  it("reports empty input with no baseline", () => {
    const calibrated = calibrateVhostResults([]);
    expect(calibrated.candidates).toEqual([]);
    expect(calibrated.filteredCount).toBe(0);
    expect(calibrated.note).toContain("No vhost responses yet");
  });

  it("keeps a lone response visible with no baseline", () => {
    const calibrated = calibrateVhostResults([entry("only.internal")]);
    expect(calibrated.candidates).toHaveLength(1);
    expect(calibrated.filteredCount).toBe(0);
    expect(calibrated.note).toContain("no baseline");
  });

  it("filters the majority baseline and keeps distinct candidates", () => {
    const calibrated = calibrateVhostResults([
      entry("a.internal", 200, 512),
      entry("b.internal", 200, 512),
      entry("c.internal", 200, 512),
      entry("admin.internal", 200, 1024),
    ]);
    expect(calibrated.baselineStatus).toBe(200);
    expect(calibrated.baselineLength).toBe(512);
    expect(calibrated.filteredCount).toBe(3);
    expect(calibrated.candidates.map((item) => item.hostname)).toEqual(["admin.internal"]);
    expect(calibrated.note).toContain("Baseline status 200, length 512 bytes seen in 3 of 4 responses");
    expect(calibrated.note).toContain("Filtered 3, showing 1 candidates");
  });

  it("reports when every response matches the baseline", () => {
    const calibrated = calibrateVhostResults([
      entry("a.internal", 200, 512),
      entry("b.internal", 200, 512),
      entry("c.internal", 200, 512),
    ]);
    expect(calibrated.candidates).toEqual([]);
    expect(calibrated.note).toContain("no candidates remain");
  });

  it("keeps everything visible without a majority", () => {
    const calibrated = calibrateVhostResults([entry("a.internal", 200, 100), entry("b.internal", 200, 200)]);
    expect(calibrated.candidates).toHaveLength(2);
    expect(calibrated.filteredCount).toBe(0);
    expect(calibrated.note).toContain("No majority response");
  });
});

describe("calibrateVhostResultsByArtifact", () => {
  it("keeps candidates whose size matches another artifact's baseline", () => {
    const calibrated = calibrateVhostResultsByArtifact([
      { ...entry("a.internal", 200, 512), artifactId: "artifact-1" },
      { ...entry("b.internal", 200, 512), artifactId: "artifact-1" },
      { ...entry("c.internal", 200, 512), artifactId: "artifact-1" },
      { ...entry("d.internal", 200, 512), artifactId: "artifact-2" },
    ]);
    expect(calibrated.total).toBe(4);
    expect(calibrated.filteredCount).toBe(3);
    expect(calibrated.candidates.map((item) => item.hostname)).toEqual(["d.internal"]);
    expect(calibrated.notes).toHaveLength(2);
  });

  it("matches single-artifact calibration for one artifact", () => {
    const calibrated = calibrateVhostResultsByArtifact([
      { ...entry("a.internal", 200, 512), artifactId: "artifact-1" },
      { ...entry("b.internal", 200, 512), artifactId: "artifact-1" },
      { ...entry("admin.internal", 200, 1024), artifactId: "artifact-1" },
    ]);
    expect(calibrated.candidates.map((item) => item.hostname)).toEqual(["admin.internal"]);
    expect(calibrated.notes).toHaveLength(1);
    expect(calibrated.notes[0]).toContain("Baseline status 200, length 512 bytes seen in 2 of 3 responses");
  });
});
