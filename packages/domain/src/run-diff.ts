/**
 * STONE-6 run-diff helper. Nmap Ndiff is the scan-comparison precedent;
 * explicit comparability rules are the product requirement. Compares two
 * runs of the same tool and origin, highlighting new/changed services,
 * responses, and paths plus ports/options/auth/binding context.
 * Unscanned is never reported as closed; incomplete never disproves.
 */

export interface RunDiffService {
  readonly address: string;
  readonly port: number;
  readonly protocol: string;
  readonly serviceName?: string | null;
  readonly product?: string | null;
  readonly version?: string | null;
}

export interface RunDiffResponse {
  readonly url: string;
  readonly status: number | null;
  readonly title?: string | null;
}

export interface RunDiffPath {
  readonly url: string;
  readonly status: number;
  readonly fuzz: string;
}

export interface RunDiffContext {
  readonly tool: string;
  readonly origin: string;
  readonly ports?: string | null;
  readonly optionsSummary: string;
  readonly authSummary?: string | null;
  readonly binding: string;
}

export interface RunDiffInput {
  readonly before: Readonly<{ context: RunDiffContext; services: readonly RunDiffService[]; responses: readonly RunDiffResponse[]; paths: readonly RunDiffPath[]; complete: boolean }>;
  readonly after: Readonly<{ context: RunDiffContext; services: readonly RunDiffService[]; responses: readonly RunDiffResponse[]; paths: readonly RunDiffPath[]; complete: boolean }>;
}

export type RunDiffComparability =
  | { readonly comparable: true }
  | { readonly comparable: false; readonly reason: string };

/**
 * Runs are comparable only for the same tool and origin. Different bindings
 * or option sets are shown as context, not as a refusal: the diff still
 * runs but carries the context warning.
 */
export function checkRunDiffComparable(before: RunDiffContext, after: RunDiffContext): RunDiffComparability {
  if (before.tool !== after.tool) {
    return { comparable: false, reason: `Different tools: ${before.tool} vs ${after.tool}.` };
  }
  if (before.origin !== after.origin) {
    return { comparable: false, reason: `Different origins: ${before.origin} vs ${after.origin}.` };
  }
  return { comparable: true };
}

export function contextDifferences(before: RunDiffContext, after: RunDiffContext): string[] {
  const notes: string[] = [];
  if (before.binding !== after.binding) {
    notes.push(`Binding changed: ${before.binding} vs ${after.binding}.`);
  }
  if (before.optionsSummary !== after.optionsSummary) {
    notes.push(`Options changed: ${before.optionsSummary} vs ${after.optionsSummary}.`);
  }
  if ((before.ports ?? null) !== (after.ports ?? null)) {
    notes.push(`Ports changed: ${before.ports ?? "unspecified"} vs ${after.ports ?? "unspecified"}.`);
  }
  if ((before.authSummary ?? null) !== (after.authSummary ?? null)) {
    notes.push("Authentication context changed.");
  }
  return notes;
}

function serviceKey(service: RunDiffService): string {
  return `${service.address}:${service.port}/${service.protocol}`;
}

function serviceDescription(service: RunDiffService): string {
  const name = service.serviceName ?? "unknown service";
  const product = [service.product, service.version].filter((part) => part !== null && part !== undefined && part !== "").join(" ");
  return product.length > 0 ? `${name} (${product})` : name;
}

export interface RunDiff {
  readonly comparable: boolean;
  readonly comparabilityReason: string | null;
  readonly contextNotes: string[];
  readonly newServices: string[];
  readonly changedServices: string[];
  readonly removedFromView: string[];
  readonly newResponses: string[];
  readonly changedResponses: string[];
  readonly newPaths: string[];
  readonly changedPaths: string[];
  readonly caveats: string[];
}

/**
 * Build the What-changed diff. Ports seen in only one run are reported as
 * "not observed", never "closed". Any incomplete side adds an explicit
 * caveat that absence disproves nothing.
 */
export function diffRuns(input: RunDiffInput): RunDiff {
  const comparability = checkRunDiffComparable(input.before.context, input.after.context);
  const contextNotes = contextDifferences(input.before.context, input.after.context);
  if (comparability.comparable === false) {
    // Different tool or origin: per-run observations are still factual on
    // their own, but presenting them as change statements would mislead,
    // so the diff carries only identity, context, and the refusal reason.
    // Same-tool runs with different bindings or options still diff, with
    // the context notes as the warning.
    return {
      comparable: false,
      comparabilityReason: (comparability as { reason: string }).reason,
      contextNotes,
      newServices: [],
      changedServices: [],
      removedFromView: [],
      newResponses: [],
      changedResponses: [],
      newPaths: [],
      changedPaths: [],
      caveats: [comparability.reason],
    };
  }
  const beforeServices = new Map(input.before.services.map((service) => [serviceKey(service), service]));
  const afterServices = new Map(input.after.services.map((service) => [serviceKey(service), service]));
  const newServices: string[] = [];
  const changedServices: string[] = [];
  const removedFromView: string[] = [];
  for (const [key, service] of afterServices) {
    const prior = beforeServices.get(key);
    if (prior === undefined) {
      newServices.push(`New service observed at ${key}: ${serviceDescription(service)}.`);
    } else if (
      (prior.serviceName ?? null) !== (service.serviceName ?? null) ||
      (prior.product ?? null) !== (service.product ?? null) ||
      (prior.version ?? null) !== (service.version ?? null)
    ) {
      changedServices.push(
        `Changed service at ${key}: was ${serviceDescription(prior)}, now ${serviceDescription(service)}.`,
      );
    }
  }
  for (const [key, service] of beforeServices) {
    if (afterServices.has(key) === false) {
      // Coverage is unknown here: the after run may not have scanned this
      // port at all, so absence is reported neutrally, never as closed.
      removedFromView.push(
        `No longer observed at ${key} (was ${serviceDescription(service)}). Not observed is not closed.`,
      );
    }
  }

  const beforeResponses = new Map(input.before.responses.map((response) => [response.url, response]));
  const newResponses: string[] = [];
  const changedResponses: string[] = [];
  for (const response of input.after.responses) {
    const prior = beforeResponses.get(response.url);
    if (prior === undefined) {
      newResponses.push(`New response observed at ${response.url}: status ${response.status ?? "unknown"}.`);
    } else if (prior.status !== response.status || (prior.title ?? null) !== (response.title ?? null)) {
      changedResponses.push(
        `Changed response at ${response.url}: was status ${prior.status ?? "unknown"} (${prior.title ?? "no title"}), now status ${response.status ?? "unknown"} (${response.title ?? "no title"}).`,
      );
    }
  }

  const beforePaths = new Map(input.before.paths.map((path) => [`${path.url}|${path.fuzz}`, path]));
  const newPaths: string[] = [];
  const changedPaths: string[] = [];
  for (const path of input.after.paths) {
    const prior = beforePaths.get(`${path.url}|${path.fuzz}`);
    if (prior === undefined) {
      newPaths.push(`New path ${path.fuzz} at ${path.url}: status ${path.status}.`);
    } else if (prior.status !== path.status) {
      changedPaths.push(
        `Changed path ${path.fuzz} at ${path.url}: was status ${prior.status}, now status ${path.status}.`,
      );
    }
  }

  const caveats: string[] = [];
  if (input.before.complete === false || input.after.complete === false) {
    caveats.push("One side is incomplete (cancelled, failed, or truncated). Absence here disproves nothing.");
  }
  if (contextNotes.length > 0) {
    caveats.push("Binding, option, port, or auth context differs; compare with that context in mind.");
  }

  return {
    comparable: true,
    comparabilityReason: null,
    contextNotes,
    newServices,
    changedServices,
    removedFromView,
    newResponses,
    changedResponses,
    newPaths,
    changedPaths,
    caveats,
  };
}
