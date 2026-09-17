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

export interface VhostCalibration {
  readonly total: number;
  readonly baselineStatus: number | null;
  readonly baselineLength: number | null;
  readonly baselineCount: number;
  readonly candidates: readonly VhostGroupableResult[];
  readonly filteredCount: number;
  readonly note: string;
}

function baselineKey(result: Pick<VhostGroupableResult, "status" | "length">): string {
  return `${result.status}|${result.length}`;
}

export function calibrateVhostResults(results: readonly VhostGroupableResult[]): VhostCalibration {
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
  let baseline = results[0] as VhostGroupableResult;
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
