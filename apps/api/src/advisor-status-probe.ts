import { lookup } from "node:dns/promises";

import type { ConnectionTestResult } from "@stonehush/contracts";

// API-local advisor endpoint probe (D6). Classification is fail-closed:
// loopback, RFC1918, link-local, unique-local, and .local/.localhost names
// are private; anything else is public. Public endpoints need an explicit
// opt-in before any network call happens (enforced by the status route).
// The probe itself is a minimal GET with no auth header and no payload and
// never follows redirects. Private IPs, DNS failures, and redirects from a
// public endpoint to a private address all report unreachable.

export type AdvisorEndpointVisibility = "private" | "public";

export const ADVISOR_PROBE_TIMEOUT_MS = 5_000;

function stripTrailingDots(value: string): string {
  return value.replace(/\.+$/, "");
}

function parseIpv4Octets(host: string): [number, number, number, number] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]*)$/.test(part)) return undefined;
    const octet = Number(part);
    if (!Number.isSafeInteger(octet) || octet > 255) return undefined;
    octets.push(octet);
  }
  return [octets[0] ?? 0, octets[1] ?? 0, octets[2] ?? 0, octets[3] ?? 0];
}

function singleDecimalToIpv4(host: string): [number, number, number, number] | undefined {
  if (!/^(0|[1-9][0-9]*)$/.test(host)) return undefined;
  const value = Number(host);
  if (!Number.isSafeInteger(value) || value > 0xff_ff_ff_ff) return undefined;
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function isPrivateIpv4(octets: readonly [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function expandIpv6(host: string): number[] | undefined {
  const zoneIndex = host.indexOf("%");
  const bare = (zoneIndex === -1 ? host : host.slice(0, zoneIndex)).toLowerCase();
  const mapped = bare.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const mappedHost = mapped?.[1];
  if (mappedHost) {
    const octets = parseIpv4Octets(mappedHost);
    if (!octets) return undefined;
    return [0, 0, 0, 0, 0, 0xffff, (octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
  }
  const halves = bare.split("::");
  if (halves.length > 2) return undefined;
  const parseSide = (side: string): number[] | undefined => {
    if (side === "") return [];
    const groups: number[] = [];
    for (const chunk of side.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(chunk)) return undefined;
      groups.push(Number.parseInt(chunk, 16));
    }
    return groups;
  };
  const head = parseSide(halves[0] ?? "");
  const tail = halves.length === 2 ? parseSide(halves[1] ?? "") : [];
  if (!head || !tail) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  if (head.length + tail.length > 7) return undefined;
  return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

function isPrivateIpv6(groups: readonly number[]): boolean {
  if (groups.length !== 8) return false;
  if (groups.every((group, index) => (index === 7 ? group === 1 : group === 0))) return true;
  const first = groups[0] ?? 0;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xfe00) === 0xfc00) return true;
  const mapped = groups[0] === 0 && groups[1] === 0 && groups[4] === 0 && groups[5] === 0xffff;
  if (mapped) {
    const a = (groups[6] ?? 0) >>> 8;
    const b = (groups[6] ?? 0) & 0xff;
    const c = (groups[7] ?? 0) >>> 8;
    const d = (groups[7] ?? 0) & 0xff;
    if (isPrivateIpv4([a, b, c, d])) return true;
  }
  return false;
}

function stripIpv6Brackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

// Classify one hostname or IP literal. Names under .local/.localhost and
// the bare localhost resolve to loopback. Anything not recognizably private
// is public so the opt-in gate applies.
export function classifyAdvisorEndpointHost(hostname: string): AdvisorEndpointVisibility {
  const normalized = stripTrailingDots(hostname.trim().toLowerCase());
  if (normalized === "" || normalized === "localhost" || normalized.endsWith(".localhost")) {
    return "private";
  }
  if (normalized === "local" || normalized.endsWith(".local")) {
    return "private";
  }
  const ipv4 = parseIpv4Octets(normalized) ?? singleDecimalToIpv4(normalized);
  if (ipv4) return isPrivateIpv4(ipv4) ? "private" : "public";
  const bareV6 = stripIpv6Brackets(normalized);
  if (bareV6.includes(":")) {
    const groups = expandIpv6(bareV6);
    if (!groups) return "public";
    return isPrivateIpv6(groups) ? "private" : "public";
  }
  return "public";
}

function isIpLiteral(hostname: string): boolean {
  const normalized = stripTrailingDots(hostname.trim().toLowerCase());
  if (parseIpv4Octets(normalized) || singleDecimalToIpv4(normalized)) return true;
  return stripIpv6Brackets(normalized).includes(":");
}

export interface AdvisorProbeNetwork {
  fetchImpl?: typeof fetch;
  lookupAll?: (hostname: string) => Promise<readonly string[]>;
}

export interface ProbeAdvisorEndpointOptions {
  network?: AdvisorProbeNetwork;
  timeoutMs?: number;
}

async function defaultLookupAll(hostname: string): Promise<readonly string[]> {
  const records = await lookup(hostname, { all: true });
  return records.map((record) => record.address);
}

function unreachable(latencyMs: number): ConnectionTestResult {
  return { reachable: false, latencyMs };
}

// Resolve a hostname to private-only addresses (fail-closed helper). Returns
// true when every resolved address is private, false when at least one is
// public, and undefined when resolution itself fails.
async function resolvesToPrivateOnly(
  hostname: string,
  lookupAll: (hostname: string) => Promise<readonly string[]>,
): Promise<boolean | undefined> {
  let addresses: readonly string[];
  try {
    addresses = await lookupAll(hostname);
  } catch {
    return undefined;
  }
  if (addresses.length === 0) return undefined;
  return addresses.every((address) => classifyAdvisorEndpointHost(address) === "private");
}

function redirectEscapesToPrivate(
  location: string,
  origin: URL,
  originVisibility: AdvisorEndpointVisibility,
): boolean {
  if (originVisibility !== "public") return false;
  let target: URL;
  try {
    target = new URL(location, origin);
  } catch {
    return true;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return true;
  if (target.host.toLowerCase() === origin.host.toLowerCase()) return false;
  return classifyAdvisorEndpointHost(target.hostname) === "private";
}

export async function probeAdvisorEndpoint(
  endpointBaseUrl: string,
  options: ProbeAdvisorEndpointOptions = {},
): Promise<ConnectionTestResult> {
  const startedAt = Date.now();
  // One wall-clock budget for the whole probe: initial DNS, fetch, and any
  // redirect-target DNS. Node dns.lookup promises cannot be cancelled, so a
  // late DNS result is ignored and never starts a request after the deadline.
  const budgetMs = Math.max(1, options.timeoutMs ?? ADVISOR_PROBE_TIMEOUT_MS);
  const deadlineAt = startedAt + budgetMs;
  const fetchImpl = options.network?.fetchImpl ?? fetch;
  const lookupAll = options.network?.lookupAll ?? defaultLookupAll;
  const fetchController = new AbortController();

  let activeResponse: Response | undefined;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      try {
        fetchController.abort();
      } catch {
        // Abort is best-effort; the deadline race below still reports timeout.
      }
      const body = activeResponse?.body;
      if (body !== null && body !== undefined) {
        try {
          const cancelled = body.cancel() as unknown;
          if (cancelled instanceof Promise) void cancelled.catch(() => {});
        } catch {
          // Ignored: authoritative cancel happens on the return paths.
        }
      }
      resolve();
    }, budgetMs);
    timer.unref?.();
  });
  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const elapsed = (): number => Math.max(0, Date.now() - startedAt);
  const finishUnreachable = (): ConnectionTestResult => unreachable(elapsed());

  // Race one DNS lookup against the shared deadline. Never throws: lookup
  // failures report as undefined so the caller fails closed.
  const resolveWithBudget = async (
    hostname: string,
  ): Promise<{ expired: true } | { expired: false; value: boolean | undefined }> => {
    if (expired || Date.now() >= deadlineAt) return { expired: true };
    const work = resolvesToPrivateOnly(hostname, lookupAll).then(
      (value) => ({ timedOut: false as const, value }),
      () => ({ timedOut: false as const, value: undefined as boolean | undefined }),
    );
    const raced = await Promise.race([
      work,
      timeoutPromise.then(() => ({ timedOut: true as const })),
    ]);
    if (raced.timedOut || expired) return { expired: true };
    return { expired: false, value: raced.value };
  };

  // Best-effort release of a probe response body. The probe only needs
  // headers, so every response path cancels without consuming raw bytes. The
  // cancel attempt is preserved, but the wait is bounded by the shared
  // deadline: a hanging cancel() reports via the deadline instead of
  // extending the probe, and rejections are always observed.
  const cancelProbeBody = async (response: Response | undefined): Promise<void> => {
    const body = response?.body;
    if (body === null || body === undefined) return;
    let cancelWork: Promise<unknown>;
    try {
      cancelWork = Promise.resolve(body.cancel());
    } catch {
      return;
    }
    if (expired || Date.now() >= deadlineAt) {
      cancelWork.catch(() => {});
      return;
    }
    await Promise.race([cancelWork.catch(() => {}), timeoutPromise]);
  };

  try {
    let origin: URL;
    try {
      origin = new URL(endpointBaseUrl);
    } catch {
      return finishUnreachable();
    }
    if (origin.protocol !== "http:" && origin.protocol !== "https:") {
      return finishUnreachable();
    }

    const visibility = classifyAdvisorEndpointHost(origin.hostname);
    if (!isIpLiteral(origin.hostname)) {
      const resolution = await resolveWithBudget(origin.hostname);
      if (resolution.expired) return finishUnreachable();
      if (resolution.value === undefined) {
        return finishUnreachable();
      }
      if (visibility === "public" && resolution.value) {
        return finishUnreachable();
      }
    }

    if (expired || Date.now() >= deadlineAt) return finishUnreachable();

    const fetchWork: Promise<{ ok: true; response: Response } | { ok: false }> = (async () => {
      try {
        const response = await fetchImpl(origin, {
          method: "GET",
          redirect: "manual",
          signal: fetchController.signal,
        });
        return { ok: true as const, response };
      } catch {
        return { ok: false as const };
      }
    })();
    const fetchRaced = await Promise.race([
      fetchWork.then((outcome) => ({ timedOut: false as const, outcome })),
      timeoutPromise.then(() => ({ timedOut: true as const })),
    ]);
    if (fetchRaced.timedOut || expired) {
      // A late fetch that resolves after the deadline must not leak its body.
      void fetchWork.then(async (outcome) => {
        if (outcome.ok) await cancelProbeBody(outcome.response);
      });
      return finishUnreachable();
    }
    if (!fetchRaced.outcome.ok) return finishUnreachable();
    const response = fetchRaced.outcome.response;
    activeResponse = response;

    if (response.status >= 300 && response.status <= 399) {
      const location = response.headers.get("location");
      if (location && redirectEscapesToPrivate(location, origin, visibility)) {
        await cancelProbeBody(response);
        return finishUnreachable();
      }
      if (location && visibility === "public") {
        try {
          const target = new URL(location, origin);
          if (
            (target.protocol === "http:" || target.protocol === "https:") &&
            target.host.toLowerCase() !== origin.host.toLowerCase() &&
            !isIpLiteral(target.hostname)
          ) {
            const resolution = await resolveWithBudget(target.hostname);
            if (resolution.expired) {
              await cancelProbeBody(response);
              return finishUnreachable();
            }
            if (resolution.value === undefined || resolution.value) {
              await cancelProbeBody(response);
              return finishUnreachable();
            }
          }
        } catch {
          await cancelProbeBody(response);
          return finishUnreachable();
        }
      }
    }

    await cancelProbeBody(response);
    return { reachable: true, latencyMs: elapsed() };
  } finally {
    clearTimer();
  }
}
