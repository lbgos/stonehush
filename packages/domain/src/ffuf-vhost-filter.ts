/**
 * Baseline/wildcard calibration for vhost candidates.
 * A wildcard vhost serves the same content for any Host header, so the most
 * common (status, length) pair is treated as the baseline and filtered.
 * No extra calibration requests are sent; the note names exactly what was
 * filtered and why so the operator can judge it.
 */

export interface VhostGroupableResult {
  readonly hostname: string;
  readonly status: number;
  readonly length: number;
  readonly words: number;
  readonly lines: number;
}

export interface VhostCalibration<T extends VhostGroupableResult = VhostGroupableResult> {
  readonly total: number;
  readonly baselineStatus: number | null;
  readonly baselineLength: number | null;
  readonly baselineCount: number;
  readonly candidates: readonly T[];
  readonly filteredCount: number;
  readonly note: string;
}

export interface VhostArtifactGroupableResult extends VhostGroupableResult {
  readonly artifactId: string;
}

export interface VhostArtifactCalibration {
  readonly total: number;
  readonly candidates: readonly VhostArtifactGroupableResult[];
  readonly filteredCount: number;
  readonly notes: readonly string[];
}

/**
 * Calibrate each artifact independently, then combine. Runs against
 * different targets have different baselines; a global majority would let
 * one artifact's wildcard hide another artifact's candidates.
 */
export function calibrateVhostResultsByArtifact(
  results: readonly VhostArtifactGroupableResult[],
): VhostArtifactCalibration {
  const groups = new Map<string, VhostArtifactGroupableResult[]>();
  for (const result of results) {
    const group = groups.get(result.artifactId);
    if (group === undefined) groups.set(result.artifactId, [result]);
    else group.push(result);
  }
  const candidates: VhostArtifactGroupableResult[] = [];
  const notes: string[] = [];
  for (const group of groups.values()) {
    const calibrated = calibrateVhostResults(group);
    candidates.push(...calibrated.candidates);
    if (notes.includes(calibrated.note) === false) notes.push(calibrated.note);
  }
  return {
    total: results.length,
    candidates,
    filteredCount: results.length - candidates.length,
    notes,
  };
}

function baselineKey(result: Pick<VhostGroupableResult, "status" | "length">): string {
  return `${result.status}|${result.length}`;
}

export function calibrateVhostResults<T extends VhostGroupableResult>(results: readonly T[]): VhostCalibration<T> {
  if (results.length === 0) {
    return {
      total: 0,
      baselineStatus: null,
      baselineLength: null,
      baselineCount: 0,
      candidates: [],
      filteredCount: 0,
      note: "No vhost responses yet. Baseline calibration appears after a run.",
    };
  }
  const counts = new Map<string, number>();
  for (const result of results) {
    const key = baselineKey(result);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let baseline = results[0] as T;
  let baselineCount = 0;
  for (const result of results) {
    const count = counts.get(baselineKey(result)) ?? 0;
    if (count > baselineCount) {
      baseline = result;
      baselineCount = count;
    }
  }
  // A lone response cannot prove a wildcard; keep it visible and say so.
  if (results.length === 1) {
    return {
      total: 1,
      baselineStatus: null,
      baselineLength: null,
      baselineCount: 0,
      candidates: results,
      filteredCount: 0,
      note: "One response observed, no baseline to filter. Single responses stay visible.",
    };
  }
  // Without a majority there is no clear wildcard; keep everything visible.
  if (baselineCount * 2 <= results.length) {
    return {
      total: results.length,
      baselineStatus: null,
      baselineLength: null,
      baselineCount: 0,
      candidates: results,
      filteredCount: 0,
      note: `No majority response across ${results.length} responses. Nothing filtered; every hostname stays visible as a candidate.`,
    };
  }
  const key = baselineKey(baseline);
  const candidates = results.filter((result) => baselineKey(result) !== key);
  const filteredCount = results.length - candidates.length;
  return {
    total: results.length,
    baselineStatus: baseline.status,
    baselineLength: baseline.length,
    baselineCount,
    candidates,
    filteredCount,
    note:
      candidates.length === 0
        ? `Baseline status ${baseline.status}, length ${baseline.length} bytes seen in ${baselineCount} of ${results.length} responses. All responses matched the baseline, so no candidates remain. The baseline is the most common response; a wildcard serves the same content for any Host.`
        : `Baseline status ${baseline.status}, length ${baseline.length} bytes seen in ${baselineCount} of ${results.length} responses. Filtered ${filteredCount}, showing ${candidates.length} candidates. The baseline is the most common response; a wildcard serves the same content for any Host.`,
  };
}
