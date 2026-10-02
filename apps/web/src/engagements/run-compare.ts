import type {
  ActionSnapshot,
  FfufProjected,
  HttpProbeProjected,
  NmapProjectedService,
  PersistedAction,
  RunHistorySummary,
  RunOutputResponse,
} from "@stonehush/contracts";
import { hasFfufMarker, hasVhostMarker, isFfufSnapshot, isHttpProbeSnapshot, type PriorAttemptInput, type RunDiffContext, type RunDiffInput } from "@stonehush/domain";

import { formatCanonicalTarget } from "./action-targets.js";
import { splitOriginUrl } from "./inspector.js";

// Comparison uses exact run-owned projections and the action's queued snapshot.
// Queued snapshots stay fixed across retries. Current selection and output text
// never supply execution context.

export type RunCompareTool = "nmap" | "http-probe" | "ffuf";

export interface ResolvedRunComparison {
  readonly runId: string;
  readonly tool: RunCompareTool;
  readonly origin: string;
  readonly observationCount: number;
  readonly snapshot: ActionSnapshot;
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
  run: RunHistorySummary,
  projections: RunProjections,
  action: PersistedAction,
  engagementId: string,
): ResolveRunComparisonResult {
  const snapshot = action.action.snapshots.find(
    (candidate) => candidate.version === action.action.queuedSnapshotVersion,
  );
  if (
    action.engagementId !== engagementId || action.action.actionId !== run.actionId ||
    snapshot === undefined || snapshot.actionId !== run.actionId
  ) {
    return { ok: false, reason: "Recorded execution context is unavailable for this run." };
  }
  const runId = run.id;
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
  if (hasVhostMarker(snapshot) || (hasFfufMarker(snapshot) ? tool !== "ffuf" || !isFfufSnapshot(snapshot) :
    tool === "ffuf" || (tool === "http-probe" && !isHttpProbeSnapshot(snapshot)))) {
    return { ok: false, reason: "Observations do not match the recorded tool context." };
  }
  if (tool === "nmap") {
    if (snapshot.canonicalTargets.some((target) => target.kind === "url")) {
      return { ok: false, reason: "Nmap observations do not match the recorded target context." };
    }
    const addresses = uniqueSorted(snapshot.canonicalTargets.map(formatCanonicalTarget));
    return {
      ok: true,
      value: { runId, tool, origin: addresses.join(", "), observationCount: serviceRows.length, snapshot },
    };
  }
  const urls = snapshot.canonicalTargets.flatMap((target) => target.kind === "url" ? [target.url] : []);
  if (urls.length !== snapshot.canonicalTargets.length) {
    return { ok: false, reason: "Web observations do not match the recorded target context." };
  }
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
  const observationUrls = tool === "http-probe" ? probeRows.map((row) => row.url) : resultRows.map((row) => row.url);
  if (observationUrls.some((url) => splitOriginUrl(url)?.origin !== unique[0])) {
    return { ok: false, reason: "Observations do not match the recorded origin." };
  }
  const count = tool === "http-probe" ? probeRows.length : resultRows.length;
  return { ok: true, value: { runId, tool, origin: unique[0]!, observationCount: count, snapshot } };
}

// Deterministic option identity. Object keys sort; arrays keep server order.
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

export function actionOptionsSummary(snapshot: ActionSnapshot): string {
  return describeOptions(snapshot.typedOptions);
}

const optionLabels: Readonly<Record<string, string>> = {
  declaredPorts: "Ports",
  ffuf: "Content discovery",
  wordlistPath: "Wordlist",
  origin: "Origin",
  rate: "Configured rate",
  threads: "Threads",
  timeoutSeconds: "Timeout in seconds",
  maxTimeSeconds: "Time limit in seconds",
  matchStatusCodes: "Matching status codes",
};

function describeOptions(value: unknown): string {
  if (value === null || value === undefined) return "unspecified";
  if (Array.isArray(value)) return value.length === 0 ? "none" : value.map(describeOptions).join(", ");
  if (typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) return "No recorded options";
    return entries.map(([key, entry]) => {
      const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
      const label = Object.hasOwn(optionLabels, key) ? optionLabels[key]!
        : words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
      return `${label} ${describeOptions(entry)}`;
    }).join("; ");
  }
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

// Ignore action IDs, digest IDs, resolution timestamps and TTLs. Compare the
// recorded targets, concrete destinations and DNS answers instead.
export function actionBindingSummary(snapshot: ActionSnapshot): string {
  const targets = uniqueSorted(snapshot.canonicalTargets.map(formatCanonicalTarget)).join(", ");
  const destinations = uniqueSorted(snapshot.concreteDestinations.map(formatCanonicalTarget));
  const resolutions = snapshot.resolutionSnapshots.map((resolution) => {
    const answers = uniqueSorted(resolution.answers.map((answer) => answer.address));
    return `${resolution.canonicalQueryName}: ${answers.join(", ")}${resolution.cnameChain.length > 0 ? ` via ${resolution.cnameChain.join(" -> ")}` : ""}`;
  }).sort();
  return [targets, destinations.length > 0 ? `destinations ${destinations.join(", ")}` : null,
    resolutions.length > 0 ? `DNS ${resolutions.join("; ")}` : null].filter((part) => part !== null).join("; ");
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
  const streams = [output.stdout, output.stderr];
  return output.run.state === "succeeded" && streams.some((stream) => stream.present) &&
    streams.every((stream) => !stream.present || (stream.completeness === "complete" && !stream.truncated));
}

export interface RunCompareSide {
  readonly run: RunHistorySummary;
  readonly context: RunDiffContext;
  readonly complete: boolean;
}

function observationsForRun(runId: string, projections: RunProjections): Pick<RunDiffInput["after"], "services" | "responses" | "paths"> {
  return {
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
