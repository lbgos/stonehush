import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";

import { HTTP_PROBE_MAX_BODY_BYTES } from "@stonehush/contracts";
import { probeOneUrl } from "./http-probe.js";

const MAX = HTTP_PROBE_MAX_BODY_BYTES;

function chunksStream(
  chunks: Uint8Array[],
  onCancel?: () => void,
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++] as Uint8Array);
      } else {
        controller.close();
      }
    },
    cancel() {
      onCancel?.();
    },
  });
}

function endlessStream(chunkSize = 8192, onPull?: () => void): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(chunkSize).fill(97);
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull?.();
      controller.enqueue(chunk);
    },
    cancel() {},
  });
}

function streamingResponse(
  status: number,
  headers: [string, string][],
  body: ReadableStream<Uint8Array> | null,
) {
  return { status, headers, body };
}

describe("http probe streaming bounds", () => {
  it("exact cap keeps body with null error", async () => {
    const bodyText = `a`.repeat(MAX - 30) + `<title>Exact</title>`;
    const bytes = Buffer.from(bodyText, "utf8");
    expect(bytes.length).toBeLessThanOrEqual(MAX);
    const padded = Buffer.concat([bytes, Buffer.alloc(MAX - bytes.length, "b")]);
    expect(padded.length).toBe(MAX);
    const fetchFn = vi.fn(async () =>
      streamingResponse(200, [["content-type", "text/html"]], chunksStream([padded])),
    );
    const { raw } = await probeOneUrl("http://127.0.0.1:8080/", {
      fetchFn: fetchFn as never,
      now: () => new Date("2026-09-03T00:00:00.000Z"),
    });
    expect(raw.error).toBe(null);
    expect(raw.status).toBe(200);
    expect(raw.hops).toEqual([{ url: "http://127.0.0.1:8080/", status: 200, location: null }]);
  });

  it("cap+1 reports body_too_large with truncated text and truthful hops", async () => {
    const over = Buffer.alloc(MAX + 1, "a");
    const fetchFn = vi.fn(async () =>
      streamingResponse(200, [["content-type", "text/html"]], chunksStream([over])),
    );
    const { raw } = await probeOneUrl("http://127.0.0.1:8080/", {
      fetchFn: fetchFn as never,
      now: () => new Date("2026-09-03T00:00:00.000Z"),
    });
    expect(raw.error).toBe("body_too_large");
    expect(raw.status).toBe(200);
    expect(raw.title).toBe(null);
    expect(raw.hops).toEqual([{ url: "http://127.0.0.1:8080/", status: 200, location: null }]);
  });

  it("over cap across many small reads retains at most cap and cancels reader", async () => {
    let pulls = 0;
    const chunk = new Uint8Array(8192).fill(120);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchFn = vi.fn(async () => streamingResponse(200, [], body));
    const { raw } = await probeOneUrl("http://127.0.0.1:8080/", {
      fetchFn: fetchFn as never,
      now: () => new Date("2026-09-03T00:00:00.000Z"),
    });
    expect(raw.error).toBe("body_too_large");
    expect(raw.status).toBe(200);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(10);
  });

  it("one giant chunk copies only the required slice", async () => {
    const giant = new Uint8Array(1_000_000).fill(97);
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(giant);
      },
      cancel() {},
    });
    const fetchFn = vi.fn(async () => streamingResponse(200, [], body));
    const originalFrom = Buffer.from;
    const copiedLengths: number[] = [];
    // @ts-expect-error - test observes Buffer.from copy sizes for bounded-copy proof
    Buffer.from = (...args: unknown[]) => {
      const first = args[0] as { byteLength?: number } | undefined;
      if (first instanceof Uint8Array) copiedLengths.push(first.byteLength);
      return (originalFrom as (...a: never[]) => Buffer)(...(args as never[]));
    };
    try {
      const { raw } = await probeOneUrl("http://127.0.0.1:8080/", {
        fetchFn: fetchFn as never,
        now: () => new Date("2026-09-03T00:00:00.000Z"),
      });
      expect(raw.error).toBe("body_too_large");
      expect(raw.status).toBe(200);
      expect(pulls).toBeLessThanOrEqual(2);
      expect(copiedLengths.length).toBeGreaterThan(0);
      expect(Math.max(...copiedLengths)).toBeLessThanOrEqual(MAX);
    } finally {
      Buffer.from = originalFrom;
    }
  });

  it("endless body returns body_too_large promptly", async () => {
    let pulls = 0;
    const fetchFn = vi.fn(async () =>
      streamingResponse(200, [], endlessStream(8192, () => { pulls += 1; })),
    );
    const start = Date.now();
    const { raw } = await probeOneUrl("http://127.0.0.1:8080/", {
      fetchFn: fetchFn as never,
      timeoutMs: 5000,
      now: () => new Date("2026-09-03T00:00:00.000Z"),
    });
    expect(Date.now() - start).toBeLessThan(2000);
    expect(raw.error).toBe("body_too_large");
    expect(pulls).toBeLessThanOrEqual(12);
  });

  it("midstream rejection maps to fetch_failed without throwing publication error", async () => {
    let n = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        n += 1;
        if (n === 1) {
          controller.enqueue(new Uint8Array([65, 66, 67]));
          return;
        }
        controller.error(new Error("midstream boom"));
      },
      cancel() {},
    });
    const fetchFn = vi.fn(async () => streamingResponse(200, [], body));
    const { raw } = await probeOneUrl("http://127.0.0.1:8080/", {
      fetchFn: fetchFn as never,
      now: () => new Date("2026-09-03T00:00:00.000Z"),
    });
    expect(raw.error).toBe("fetch_failed");
    expect(raw.status).toBe(null);
    expect(raw.hops).toEqual([{ url: "http://127.0.0.1:8080/", status: 200, location: null }]);
  });

  it("distinguishes timeout from network failure", async () => {
    const timeoutFn = vi.fn(async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    });
    const networkFn = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const t = await probeOneUrl("http://127.0.0.1:8080/", {
      fetchFn: timeoutFn as never,
      timeoutMs: 200,
      now: () => new Date("2026-09-03T00:00:00.000Z"),
    });
    const n = await probeOneUrl("http://127.0.0.1:8080/", {
      fetchFn: networkFn as never,
      timeoutMs: 200,
      now: () => new Date("2026-09-03T00:00:00.000Z"),
    });
    expect(t.raw.error).toBe("timeout");
    expect(t.raw.status).toBe(null);
    expect(n.raw.error).toBe("fetch_failed");
    expect(n.raw.status).toBe(null);
  });
});

describe("http probe abort and disposal", () => {
  it("abort before request issues no fetch and throws abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchFn = vi.fn(async () => ({ status: 200, headers: [], body: null }));
    await expect(
      probeOneUrl("http://127.0.0.1:8080/", {
        fetchFn: fetchFn as never,
        signal: controller.signal,
        now: () => new Date("2026-09-03T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ name: expect.stringMatching(/Abort|probe_aborted/i) });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("abort during headers aborts promptly without waiting full timeout", async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn(
      async (_url: string, init?: { signal?: AbortSignal | null }) =>
        new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const pending = probeOneUrl("http://127.0.0.1:8080/", {
      fetchFn: fetchFn as never,
      timeoutMs: 2000,
      signal: controller.signal,
      now: () => new Date("2026-09-03T00:00:00.000Z"),
    });
    setTimeout(() => controller.abort(), 20);
    const start = Date.now();
    await expect(pending).rejects.toMatchObject({
      name: expect.stringMatching(/Abort|probe_aborted/i),
    });
    expect(Date.now() - start).toBeLessThan(800);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("abort during body cancels reader and throws abort", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (!cancelled && (c as unknown as { __sent?: boolean }).__sent !== true) {
          (c as unknown as { __sent?: boolean }).__sent = true;
          c.enqueue(new Uint8Array(1024).fill(98));
          return;
        }
        await new Promise<never>(() => {});
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchFn = vi.fn(async () => streamingResponse(200, [], body));
    const pending = probeOneUrl("http://127.0.0.1:8080/", {
      fetchFn: fetchFn as never,
      timeoutMs: 2000,
      signal: controller.signal,
      now: () => new Date("2026-09-03T00:00:00.000Z"),
    });
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toMatchObject({
      name: expect.stringMatching(/Abort|probe_aborted/i),
    });
    expect(cancelled).toBe(true);
  });

  it("no new request after cancellation across redirect", async () => {
    const controller = new AbortController();
    let secondCalled = false;
    const fetchFn = vi.fn(async (url: string) => {
      if (url === "http://127.0.0.1:8080/") {
        controller.abort();
        return streamingResponse(302, [["location", "/next"]], chunksStream([]));
      }
      secondCalled = true;
      return streamingResponse(200, [], chunksStream([new Uint8Array([65])]));
    });
    await expect(
      probeOneUrl("http://127.0.0.1:8080/", {
        fetchFn: fetchFn as never,
        signal: controller.signal,
        now: () => new Date("2026-09-03T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ name: expect.stringMatching(/Abort|probe_aborted/i) });
    expect(secondCalled).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("redirect responses are disposed via body cancel", async () => {
    let redirectCancelled = false;
    const redirectBody = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([65]));
      },
      cancel() {
        redirectCancelled = true;
      },
    });
    const fetchFn = vi.fn(async (url: string) => {
      if (url === "http://127.0.0.1:8080/") {
        return streamingResponse(302, [["location", "/next"]], redirectBody);
      }
      return streamingResponse(200, [], chunksStream([Buffer.from("<title>Final</title>")]));
    });
    const { raw } = await probeOneUrl("http://127.0.0.1:8080/", {
      fetchFn: fetchFn as never,
      now: () => new Date("2026-09-03T00:00:00.000Z"),
    });
    expect(raw.finalUrl).toBe("http://127.0.0.1:8080/next");
    expect(redirectCancelled).toBe(true);
  });

  it("hanging redirect disposal cannot hang past deadline", async () => {
    const hangingBody = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([65]));
      },
      cancel() {
        return new Promise<void>(() => {});
      },
    });
    const fetchFn = vi.fn(async (url: string) => {
      if (url === "http://127.0.0.1:8080/") {
        return streamingResponse(302, [["location", "/next"]], hangingBody);
      }
      return streamingResponse(200, [], chunksStream([Buffer.from("<title>Final</title>")]));
    });
    const start = Date.now();
    const { raw } = await probeOneUrl("http://127.0.0.1:8080/", {
      fetchFn: fetchFn as never,
      timeoutMs: 150,
      now: () => new Date("2026-09-03T00:00:00.000Z"),
    });
    expect(Date.now() - start).toBeLessThan(1500);
    expect(raw.finalUrl).toBe("http://127.0.0.1:8080/next");
  });
});

describe("http probe loopback server", () => {
  async function startServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Promise<{ server: Server; sockets: Set<Socket>; baseUrl: string }> {
    const sockets = new Set<Socket>();
    const server = createServer(handler);
    server.on("connection", (socket: Socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("loopback listen failed");
    return { server, sockets, baseUrl: `http://127.0.0.1:${String(address.port)}` };
  }

  async function stopServer(server: Server, sockets: Set<Socket>): Promise<void> {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  it("oversized loopback body streams bounded as body_too_large", async () => {
    const { server, sockets, baseUrl } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-length": "200000" });
      res.end(Buffer.alloc(200_000, "a"));
    });
    try {
      const start = Date.now();
      const { raw } = await probeOneUrl(`${baseUrl}/oversized`, { timeoutMs: 5000 });
      expect(Date.now() - start).toBeLessThan(3000);
      expect(raw.status).toBe(200);
      expect(raw.error).toBe("body_too_large");
      expect(raw.title).toBe(null);
      expect(raw.hops).toEqual([{ url: `${baseUrl}/oversized`, status: 200, location: null }]);
    } finally {
      await stopServer(server, sockets);
    }
  });

  it("stalled loopback body aborts promptly and issues no later redirect request", async () => {
    let finalHits = 0;
    const { server, sockets, baseUrl } = await startServer((req, res) => {
      if (req.url === "/final") {
        finalHits += 1;
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<title>Final</title>");
        return;
      }
      if (req.url === "/redir") {
        // Delay redirect headers so the outer abort lands during the first
        // fetch; the second fetch must never start.
        setTimeout(() => {
          if (!res.writableEnded) {
            res.writeHead(302, { location: "/final" });
            res.end();
          }
        }, 100);
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.flushHeaders();
    });
    try {
      const controller = new AbortController();
      const pending = probeOneUrl(`${baseUrl}/redir`, {
        timeoutMs: 5000,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 20);
      const start = Date.now();
      await expect(pending).rejects.toMatchObject({
        name: expect.stringMatching(/Abort|probe_aborted/i),
      });
      expect(Date.now() - start).toBeLessThan(1500);
      await new Promise((r) => setTimeout(r, 200));
      expect(finalHits).toBe(0);

      const stalledController = new AbortController();
      const stalledPending = probeOneUrl(`${baseUrl}/stalled`, {
        timeoutMs: 5000,
        signal: stalledController.signal,
      });
      setTimeout(() => stalledController.abort(), 50);
      const stalledStart = Date.now();
      await expect(stalledPending).rejects.toMatchObject({
        name: expect.stringMatching(/Abort|probe_aborted/i),
      });
      expect(Date.now() - stalledStart).toBeLessThan(1500);
    } finally {
      await stopServer(server, sockets);
    }
  });
});
