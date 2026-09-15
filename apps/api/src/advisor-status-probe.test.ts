import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { ConnectionTestResultSchema } from "@stonehush/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifyAdvisorEndpointHost,
  probeAdvisorEndpoint,
} from "./advisor-status-probe.js";

interface LabEndpoint {
  close: () => Promise<void>;
  hits: () => number;
  seenAuthorizationHeader: () => boolean;
  url: string;
}

const labServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    labServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  vi.restoreAllMocks();
});

async function startLabEndpoint(
  status: number,
  headers: Record<string, string> = {},
): Promise<LabEndpoint> {
  let hits = 0;
  let authorizationSeen = false;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    hits += 1;
    if (request.headers.authorization !== undefined) authorizationSeen = true;
    response.writeHead(status, headers);
    response.end();
  });
  labServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    hits: () => hits,
    seenAuthorizationHeader: () => authorizationSeen,
    url: `http://127.0.0.1:${address.port}/v1`,
  };
}

async function closedLoopbackUrl(): Promise<string> {
  const server = createServer((_request, response) => response.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}/v1`;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return url;
}

function stubFetch(status: number, location?: string) {
  const headers = location === undefined ? {} : { location };
  return vi.fn(async () => new Response(null, { headers, status }));
}

describe("classifyAdvisorEndpointHost", () => {
  it.each([
    "127.0.0.1",
    "127.200.10.9",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "169.254.10.20",
    "localhost",
    "LOCALHOST",
    "localhost.",
    "app.localhost",
    "printer.local",
    "printer.LOCAL.",
    "2130706433",
    "::1",
    "[::1]",
    "fe80::1",
    "fc00::1",
    "::ffff:127.0.0.1",
  ])("treats %s as private", (host) => {
    expect(classifyAdvisorEndpointHost(host)).toBe("private");
  });

  it.each([
    "8.8.8.8",
    "11.0.0.1",
    "172.15.255.255",
    "172.32.0.1",
    "192.167.0.1",
    "192.0.2.1",
    "203.0.113.7",
    "134744072",
    "example.com",
    "2001:db8::1",
    "::ffff:8.8.8.8",
  ])("treats %s as public", (host) => {
    expect(classifyAdvisorEndpointHost(host)).toBe("public");
  });

  it("sees through hex loopback after URL normalization", () => {
    const hostname = new URL("http://0x7f.0.0.1:11434/v1").hostname;
    expect(hostname).toBe("127.0.0.1");
    expect(classifyAdvisorEndpointHost(hostname)).toBe("private");
  });
});

describe("probeAdvisorEndpoint", () => {
  it("reports a loopback lab endpoint reachable with latency", async () => {
    const lab = await startLabEndpoint(200);

    const result = await probeAdvisorEndpoint(lab.url);

    expect(ConnectionTestResultSchema.safeParse(result).success).toBe(true);
    expect(result).toEqual({ reachable: true, latencyMs: expect.any(Number) });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(lab.hits()).toBe(1);
  });

  it("treats any HTTP response, including errors and relative redirects, as reachable", async () => {
    const errorLab = await startLabEndpoint(500);
    await expect(probeAdvisorEndpoint(errorLab.url)).resolves.toMatchObject({ reachable: true });

    const redirectLab = await startLabEndpoint(302, { location: "/v1/models" });
    await expect(probeAdvisorEndpoint(redirectLab.url)).resolves.toMatchObject({
      reachable: true,
    });
  });

  it("sends no auth header and no payload", async () => {
    const lab = await startLabEndpoint(200);

    await probeAdvisorEndpoint(lab.url);

    expect(lab.hits()).toBe(1);
    expect(lab.seenAuthorizationHeader()).toBe(false);
  });

  it("fails closed on a refused loopback port", async () => {
    const url = await closedLoopbackUrl();

    await expect(probeAdvisorEndpoint(url, { timeoutMs: 2_000 })).resolves.toMatchObject({
      reachable: false,
    });
  }, 10_000);

  it("fails closed on unroutable addresses and DNS failures", async () => {
    await expect(
      probeAdvisorEndpoint("http://192.0.2.1:11434/v1", { timeoutMs: 800 }),
    ).resolves.toMatchObject({ reachable: false });

    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await expect(
      probeAdvisorEndpoint("http://stonehush-no-such-host.invalid/v1", {
        network: { fetchImpl },
        timeoutMs: 2_000,
      }),
    ).resolves.toMatchObject({ reachable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  }, 15_000);

  it("fails closed when a public name resolves only to private addresses", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));

    const result = await probeAdvisorEndpoint("http://rebind-guard.test/v1", {
      network: { fetchImpl, lookupAll: async () => ["10.1.2.3"] },
    });

    expect(result).toMatchObject({ reachable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("probes a public name that resolves to a public address", async () => {
    const fetchImpl = stubFetch(200);

    const result = await probeAdvisorEndpoint("http://probe-target.test/v1", {
      network: { fetchImpl, lookupAll: async () => ["93.184.216.34"] },
    });

    expect(result).toMatchObject({ reachable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a public endpoint redirects to a private literal", async () => {
    const fetchImpl = stubFetch(302, "http://10.9.9.9/v1/models");

    const result = await probeAdvisorEndpoint("http://203.0.113.7:11434/v1", {
      network: { fetchImpl },
    });

    expect(result).toMatchObject({ reachable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a public endpoint redirects to a name that resolves private", async () => {
    const fetchImpl = stubFetch(302, "http://internal-redirect.test/v1");

    const result = await probeAdvisorEndpoint("http://203.0.113.7:11434/v1", {
      network: { fetchImpl, lookupAll: async () => ["10.0.0.5"] },
    });

    expect(result).toMatchObject({ reachable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("treats a public redirect to a public name as reachable without following it", async () => {
    const fetchImpl = stubFetch(302, "http://elsewhere.test/v1");

    const result = await probeAdvisorEndpoint("http://203.0.113.7:11434/v1", {
      network: { fetchImpl, lookupAll: async () => ["93.184.216.34"] },
    });

    expect(result).toMatchObject({ reachable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never throws on invalid or non-http URLs", async () => {
    await expect(probeAdvisorEndpoint(":::not a url:::")).resolves.toMatchObject({
      reachable: false,
    });
    await expect(probeAdvisorEndpoint("gopher://example.com/")).resolves.toMatchObject({
      reachable: false,
    });
  });

  it("bounds hanging initial DNS within the wall-clock budget", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const startedAt = Date.now();

    await expect(
      probeAdvisorEndpoint("http://model.test/v1", {
        timeoutMs: 20,
        network: { fetchImpl, lookupAll: () => new Promise<readonly string[]>(() => {}) },
      }),
    ).resolves.toMatchObject({ reachable: false });

    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("bounds hanging redirect-target DNS within the wall-clock budget", async () => {
    const fetchImpl = stubFetch(302, "http://internal-redirect.test/v1");
    const startedAt = Date.now();

    await expect(
      probeAdvisorEndpoint("http://203.0.113.7:11434/v1", {
        timeoutMs: 30,
        network: { fetchImpl, lookupAll: () => new Promise<readonly string[]>(() => {}) },
      }),
    ).resolves.toMatchObject({ reachable: false });

    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never starts fetch after a late DNS result", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const lookupAll = vi.fn(
      () =>
        new Promise<readonly string[]>((resolve) => {
          setTimeout(() => resolve(["93.184.216.34"]), 60);
        }),
    );

    await expect(
      probeAdvisorEndpoint("http://late-dns.test/v1", {
        timeoutMs: 20,
        network: { fetchImpl, lookupAll },
      }),
    ).resolves.toMatchObject({ reachable: false });

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("bounds a hanging fetch within the wall-clock budget", async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
    const startedAt = Date.now();

    await expect(
      probeAdvisorEndpoint("http://127.0.0.1:11434/v1", {
        timeoutMs: 20,
        network: { fetchImpl },
      }),
    ).resolves.toMatchObject({ reachable: false });

    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("cancels the response body on success", async () => {
    let cancelled = false;
    const stream = new ReadableStream({ cancel() { cancelled = true; } });
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200 }));

    const result = await probeAdvisorEndpoint("http://127.0.0.1:11434/v1", {
      timeoutMs: 2_000,
      network: { fetchImpl },
    });

    expect(result).toMatchObject({ reachable: true });
    expect(cancelled).toBe(true);
  });

  it("cancels the response body on a rejected private redirect", async () => {
    let cancelled = false;
    const stream = new ReadableStream({ cancel() { cancelled = true; } });
    const fetchImpl = vi.fn(
      async () => new Response(stream, { status: 302, headers: { location: "http://10.9.9.9/v1/models" } }),
    );

    const result = await probeAdvisorEndpoint("http://203.0.113.7:11434/v1", {
      timeoutMs: 2_000,
      network: { fetchImpl },
    });

    expect(result).toMatchObject({ reachable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cancelled).toBe(true);
  });

  it("stays bounded when body cancel never settles", async () => {
    let cancelAttempted = false;
    const stream = new ReadableStream({
      cancel() {
        cancelAttempted = true;
        return new Promise<void>(() => {});
      },
    });
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200 }));
    const startedAt = Date.now();

    const result = await probeAdvisorEndpoint("http://127.0.0.1:11434/v1", {
      timeoutMs: 20,
      network: { fetchImpl },
    });

    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cancelAttempted).toBe(true);
    expect(result.reachable).toBeDefined();
  });
});
