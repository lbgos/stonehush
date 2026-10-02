import type {
  FfufProjected,
  HttpProbeProjected,
  NmapProjectedService,
  PersistedAction,
  RunHistorySummary,
  RunOutputResponse,
} from "@stonehush/contracts";
import type { PriorAttemptInput, RunDiffContext, RunDiffInput } from "@stonehush/domain";

import { formatCanonicalTarget, latestActionSnapshot } from "./action-targets.js";
import { splitOriginUrl } from "./inspector.js";

// Honest run-to-run comparison inputs, composed only from data the client
// already reads: engagement projections keyed by exact run id, run history
// summaries, exact per-run output, and persisted action snapshots. Nothing is
// parsed out of stdout, titles are never treated as context, and the current
// target selection is never consulted: tool and origin come from typed
// projection fields only. When those fields cannot name exactly one tool and
// one origin, resolution refuses instead of guessing.

export const RUN_COMPARE_OPTIONS_UNAVAILABLE =
  "Options unavailable: the action record failed to load.";
export const RUN_COMPARE_BINDING_UNAVAILABLE =
  "Binding unavailable: the action record failed to load.";

export type RunCompareTool = "nmap" | "http-probe" | "ffuf";

export interface ResolvedRunComparison {
  readonly runId: string;
  readonly tool: RunCompareTool;
  readonly origin: string;
  readonly observationCount: number;
}

export type ResolveRunComparisonResult =
  | { readonly ok: true; readonly value: ResolvedRunComparison }
  | { readonly ok: false; readonly reason: string };

interface RunProjections {
  readonly services: readonly NmapProjectedService[];
  readonly probes: readonly HttpProbeProjected[];
  readonly results: readonly FfufProjected[];
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

// One tool and one origin per run, or a refusal. A run with no rows in any
// projection list has nothing to compare. Rows in two tool lists mean the
// join is ambiguous, so the comparison refuses rather than picking a tool.
export function resolveRunComparison(
  runId: string,
  projections: RunProjections,
): ResolveRunComparisonResult {
  const serviceRows = projections.services.filter((row) => row.runId === runId);
  const probeRows = projections.probes.filter((row) => row.runId === runId);
  const resultRows = projections.results.filter((row) => row.runId === runId);
  const populated: { tool: RunCompareTool; count: number }[] = [];
  if (serviceRows.length > 0) populated.push({ tool: "nmap", count: serviceRows.length });
  if (probeRows.length > 0) populated.push({ tool: "http-probe", count: probeRows.length });
  if (resultRows.length > 0) populated.push({ tool: "ffuf", count: resultRows.length });
  if (populated.length === 0) {
    return {
      ok: false,
      reason: "No recorded observations for this run in the current projections.",
    };
  }
  if (populated.length > 1) {
    return {
      ok: false,
      reason: "This run produced observations from more than one tool; the comparison refuses ambiguous tool context.",
    };
  }
  const tool = populated[0]!.tool;
  if (tool === "nmap") {
    const addresses = uniqueSorted(serviceRows.map((row) => row.address));
    return {
      ok: true,
      value: { runId, tool, origin: addresses.join(", "), observationCount: serviceRows.length },
    };
  }
  const urls = tool === "http-probe" ? probeRows.map((row) => row.url) : resultRows.map((row) => row.url);
  const origins: string[] = [];
  for (const url of urls) {
    const parts = splitOriginUrl(url);
    if (parts === undefined) {
      return {
        ok: false,
        reason: "This run holds a URL the origin parser rejects; the comparison refuses unknown origin context.",
      };
    }
    origins.push(parts.origin);
  }
  const unique = uniqueSorted(origins);
  if (unique.length !== 1) {
    return {
      ok: false,
      reason: "This run spans more than one origin; the comparison refuses ambiguous origin context.",
    };
  }
  const count = tool === "http-probe" ? probeRows.length : resultRows.length;
  return { ok: true, value: { runId, tool, origin: unique[0]!, observationCount: count } };
}

// Deterministic display summary of typed action options. Object keys sort so
// equal option sets always read the same; arrays keep server order.
export function stableStringifyOptions(value: unknown): string {
  return JSON.stringify(canonicalizeJsonValue(value));
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalizeJsonValue(entry)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

export function actionOptionsSummary(action: PersistedAction | undefined): string {
  if (action === undefined) return RUN_COMPARE_OPTIONS_UNAVAILABLE;
  return stableStringifyOptions(latestActionSnapshot(action).typedOptions);
}

export function actionBindingSummary(action: PersistedAction | undefined): string {
  if (action === undefined) return RUN_COMPARE_BINDING_UNAVAILABLE;
  return latestActionSnapshot(action)
    .canonicalTargets.map((target) => formatCanonicalTarget(target))
    .sort()
    .join(", ");
}

// Factual outcome line for the prior-attempt copy. A finished run still does
// not prove the idea; this names only the recorded terminal state.
export function describeRunOutcome(run: Pick<RunHistorySummary, "state" | "terminalReason">): string {
  if (run.state === "succeeded") return "succeeded";
  if (run.state === "failed") {
    return run.terminalReason === null ? "failed" : `failed (${run.terminalReason})`;
  }
  if (run.state === "cancelled") return "cancelled (interrupted; partial evidence only)";
  return run.state;
}

// A side counts as complete only for a succeeded run whose preserved output
// is present and untruncated. Missing or foreign output never counts: absence
// disproves nothing.
export function runSideComplete(
  run: Pick<RunHistorySummary, "id" | "state">,
  output: RunOutputResponse | undefined,
): boolean {
  if (run.state !== "succeeded") return false;
  if (output === undefined || output.run.id !== run.id) return false;
  return output.stdout.truncated === false && output.stderr.truncated === false;
}

export interface RunCompareSide {
  readonly run: RunHistorySummary;
  readonly context: RunDiffContext;
  readonly complete: boolean;
}

function observationsForRun(runId: string, projections: RunProjections): RunDiffInput["after"] {
  return {
    context: {
      tool: "unknown",
      origin: "unknown",
      optionsSummary: "unknown",
      binding: "unknown",
    },
    services: projections.services
      .filter((row) => row.runId === runId)
      .map((row) => ({
        address: row.address,
        port: row.port,
        protocol: row.protocol,
        serviceName: row.serviceName,
        product: row.product,
        version: row.version,
      })),
    responses: projections.probes
      .filter((row) => row.runId === runId)
      .map((row) => ({ url: row.url, status: row.status, title: row.title })),
    paths: projections.results
      .filter((row) => row.runId === runId)
      .map((row) => ({ url: row.url, status: row.status, fuzz: row.fuzz })),
    complete: true,
  };
}

// Build the domain diff input for two resolved runs. Requested ports and auth
// context are not resolved from current read APIs, so they stay null rather
// than invented. Callers supply the honest context per side.
export function buildRunCompareInput(input: {
  before: RunCompareSide;
  after: RunCompareSide;
  projections: RunProjections;
}): RunDiffInput {
  const beforeRows = observationsForRun(input.before.run.id, input.projections);
  const afterRows = observationsForRun(input.after.run.id, input.projections);
  return {
    before: { ...beforeRows, context: input.before.context, complete: input.before.complete },
    after: { ...afterRows, context: input.after.context, complete: input.after.complete },
  };
}

export function buildPriorAttempt(input: {
  run: RunHistorySummary;
  optionsSummary: string;
  conditionsChanged: boolean;
}): PriorAttemptInput {
  return {
    runId: input.run.id,
    attemptedAt: input.run.createdAt,
    optionsSummary: input.optionsSummary,
    outcome: describeRunOutcome(input.run),
    conditionsChanged: input.conditionsChanged,
  };
}
