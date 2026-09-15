import {
  HTTP_PROBE_MAX_BODY_BYTES,
  HTTP_PROBE_MAX_HOPS,
  type ActionSnapshot,
  type HttpProbeErrorCode,
  type HttpProbeHop,
  type HttpProbeRaw,
} from "@stonehush/contracts";
import {
  buildProbeRawBytes,
  isHttpProbeSnapshot,
  parseProbeTitle,
  probeUrlsForSnapshot,
  selectProbeHeaders,
} from "@stonehush/domain";

export const HTTP_PROBE_TIMEOUT_MS = 15_000;

export class ProbeAbortedError extends Error {
  readonly code = "probe_aborted";
  constructor(message = "http probe aborted") {
    super(message);
    this.name = "ProbeAbortedError";
  }
}

export type ProbeResponse = {
  status: number;
  headers: Iterable<readonly [string, string]>;
  body: ReadableStream<Uint8Array> | null;
};

export type ProbeFetch = (
  url: string,
  init?: { redirect?: RequestRedirect; signal?: AbortSignal | null },
) => Promise<ProbeResponse>;

export function probeUrlsFromSnapshot(snapshot: ActionSnapshot): string[] | null {
  if (!isHttpProbeSnapshot(snapshot)) return null;
  return probeUrlsForSnapshot(snapshot);
}

function redirectLocation(status: number, location: string | null): string | null {
  if (
    (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) &&
    location !== null &&
    location.length > 0
  ) {
    return location;
  }
  return null;
}

function headerEntries(
  headers: Iterable<readonly [string, string]>,
): [string, string][] {
  const entries: [string, string][] = [];
  for (const [name, value] of headers) entries.push([name, value]);
  return entries;
}

function locationOf(entries: [string, string][]): string | null {
  for (const [name, value] of entries) {
    if (name.toLowerCase() === "location") return value;
  }
  return null;
}

async function cancelStreamBounded(
  stream: ReadableStream<Uint8Array>,
  combinedSignal: AbortSignal,
): Promise<void> {
  if (combinedSignal.aborted) {
    try {
      void stream.cancel().catch(() => {});
    } catch {}
    return;
  }
  let onAbort: (() => void) | null = null;
  const abortPromise = new Promise<void>((_resolve, reject) => {
    onAbort = () => reject(new Error("aborted"));
    combinedSignal.addEventListener("abort", onAbort, { once: true });
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timerPromise = new Promise<void>((resolve) => {
    timer = setTimeout(() => resolve(), 50);
    if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
      (timer as unknown as { unref: () => void }).unref?.();
    }
  });
  try {
    const cancelPromise = stream.cancel().catch(() => {});
    void cancelPromise.finally(() => {
      if (onAbort !== null) combinedSignal.removeEventListener("abort", onAbort);
    });
    await Promise.race([cancelPromise, abortPromise, timerPromise]).catch(() => {});
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (onAbort !== null) combinedSignal.removeEventListener("abort", onAbort);
  }
}

async function disposeResponseBody(
  response: ProbeResponse,
  combinedSignal: AbortSignal,
): Promise<void> {
  const body = response.body;
  if (body === null) return;
  await cancelStreamBounded(body, combinedSignal);
}

async function cancelReaderBounded(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  combinedSignal: AbortSignal,
): Promise<void> {
  if (combinedSignal.aborted) {
    try {
      void reader.cancel().catch(() => {});
    } catch {}
    try {
      reader.releaseLock();
    } catch {}
    return;
  }
  let onAbort: (() => void) | null = null;
  const abortPromise = new Promise<void>((_resolve, reject) => {
    onAbort = () => reject(new Error("aborted"));
    combinedSignal.addEventListener("abort", onAbort, { once: true });
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timerPromise = new Promise<void>((resolve) => {
    timer = setTimeout(() => resolve(), 50);
    if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
      (timer as unknown as { unref: () => void }).unref?.();
    }
  });
  try {
    const cancelPromise = reader.cancel().catch(() => {});
    void cancelPromise.finally(() => {
      if (onAbort !== null) combinedSignal.removeEventListener("abort", onAbort);
    });
    await Promise.race([cancelPromise, abortPromise, timerPromise]).catch(() => {});
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (onAbort !== null) combinedSignal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {}
  }
}

type BodyReadResult =
  | { kind: "ok"; text: string; tooLarge: boolean }
  | { kind: "timeout" }
  | { kind: "fetch_failed" };

async function readBoundedBodyText(
  response: ProbeResponse,
  combinedSignal: AbortSignal,
  isOuterAborted: () => boolean,
  isDeadlineExpired: () => boolean,
): Promise<BodyReadResult> {
  if (combinedSignal.aborted) {
    if (isOuterAborted()) throw new ProbeAbortedError();
    return { kind: "timeout" };
  }
  const body = response.body;
  if (body === null) return { kind: "ok", text: "", tooLarge: false };

  const reader = body.getReader();
  const retained: Buffer[] = [];
  let retainedBytes = 0;
  try {
    for (;;) {
      if (combinedSignal.aborted) {
        await cancelReaderBounded(reader, combinedSignal);
        if (isOuterAborted()) throw new ProbeAbortedError();
        return { kind: "timeout" };
      }
      let onAbort: (() => void) | null = null;
      const abortPromise = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new ProbeAbortedError());
        combinedSignal.addEventListener("abort", onAbort, { once: true });
      });
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        const readPromise = reader.read();
        void readPromise.catch(() => {});
        read = await Promise.race([readPromise, abortPromise]);
      } catch (e) {
        if (onAbort !== null) combinedSignal.removeEventListener("abort", onAbort);
        if (isOuterAborted()) {
          try {
            void reader.cancel().catch(() => {});
          } catch {}
          try {
            reader.releaseLock();
          } catch {}
          throw new ProbeAbortedError();
        }
        if (isDeadlineExpired() || e instanceof ProbeAbortedError) {
          try {
            void reader.cancel().catch(() => {});
          } catch {}
          try {
            reader.releaseLock();
          } catch {}
          return { kind: "timeout" };
        }
        try {
          reader.releaseLock();
        } catch {}
        return { kind: "fetch_failed" };
      }
      if (onAbort !== null) combinedSignal.removeEventListener("abort", onAbort);
      if (read.done) {
        try {
          reader.releaseLock();
        } catch {}
        return { kind: "ok", text: Buffer.concat(retained).toString("utf8"), tooLarge: false };
      }
      const raw = read.value;
      const rawLength = raw.byteLength ?? raw.length;
      if (retainedBytes + rawLength > HTTP_PROBE_MAX_BODY_BYTES) {
        const needed = HTTP_PROBE_MAX_BODY_BYTES - retainedBytes;
        if (needed > 0) {
          // Copy only the required slice; never duplicate the full giant
          // chunk and never retain a subarray view over its backing store.
          retained.push(Buffer.from(raw.subarray(0, needed)));
        }
        retainedBytes = HTTP_PROBE_MAX_BODY_BYTES;
        await cancelReaderBounded(reader, combinedSignal);
        if (isOuterAborted()) throw new ProbeAbortedError();
        if (isDeadlineExpired()) return { kind: "timeout" };
        return { kind: "ok", text: Buffer.concat(retained).toString("utf8"), tooLarge: true };
      }
      retained.push(Buffer.from(raw));
      retainedBytes += rawLength;
    }
  } catch (e) {
    if (e instanceof ProbeAbortedError) throw e;
    if (isOuterAborted()) throw new ProbeAbortedError();
    if (isDeadlineExpired()) return { kind: "timeout" };
    return { kind: "fetch_failed" };
  }
}

/**
 * Probe one URL with Node built-in fetch only: no rendering, no auth, no
 * crawling. Follows at most HTTP_PROBE_MAX_HOPS redirects manually.
 * Streaming body read retains at most HTTP_PROBE_MAX_BODY_BYTES; a single
 * oversized read copies only the required slice and never duplicates or
 * retains the full backing store. Redirect bodies are cancelled with a bounded
 * dispose that never hangs past the deadline. The optional signal aborts
 * in-flight fetch/body work promptly; outer abort throws ProbeAbortedError
 * so the runner can complete runner_lost instead of claiming a publication
 * failure. Deadline expiry and network/stream errors return truthful raw
 * error codes (timeout / fetch_failed) with observed hops preserved.
 */
export async function probeOneUrl(
  startUrl: string,
  options: { fetchFn?: ProbeFetch; timeoutMs?: number; now?: () => Date; signal?: AbortSignal | null } = {},
): Promise<{ ok: true; rawBytes: Buffer; raw: HttpProbeRaw }> {
  const fetchFn = (options.fetchFn ?? globalThis.fetch) as unknown as ProbeFetch;
  const timeoutMs = options.timeoutMs ?? HTTP_PROBE_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());
  const outerSignal = options.signal ?? null;
  if (outerSignal?.aborted) throw new ProbeAbortedError();
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(() => {
    try {
      deadlineController.abort();
    } catch {}
  }, timeoutMs);
  if (typeof (deadlineTimer as unknown as { unref?: () => void }).unref === "function") {
    (deadlineTimer as unknown as { unref: () => void }).unref?.();
  }
  const combinedController = new AbortController();
  const onOuterAbort = (): void => {
    try {
      combinedController.abort();
    } catch {}
  };
  const onDeadlineAbort = (): void => {
    try {
      combinedController.abort();
    } catch {}
  };
  if (outerSignal) outerSignal.addEventListener("abort", onOuterAbort, { once: true });
  deadlineController.signal.addEventListener("abort", onDeadlineAbort, { once: true });
  const combinedSignal = combinedController.signal;
  const isOuterAborted = (): boolean => outerSignal?.aborted === true;
  const isDeadlineExpired = (): boolean => deadlineController.signal.aborted;
  const cleanupSignals = (): void => {
    clearTimeout(deadlineTimer);
    if (outerSignal) outerSignal.removeEventListener("abort", onOuterAbort);
    deadlineController.signal.removeEventListener("abort", onDeadlineAbort);
  };
  const hops: HttpProbeHop[] = [];
  let current = startUrl;
  let failure: { status: null; title: null; error: HttpProbeErrorCode } | null = null;
  let final: { status: number; title: string | null; selected: HttpProbeRaw["selectedHeaders"]; error: HttpProbeErrorCode | null } | null = null;

  try {
    for (let hop = 0; hop <= HTTP_PROBE_MAX_HOPS; hop += 1) {
      if (combinedSignal.aborted) {
        if (isOuterAborted()) throw new ProbeAbortedError();
        failure = { status: null, title: null, error: "timeout" };
        break;
      }
      let response: ProbeResponse;
      try {
        response = await fetchFn(current, {
          redirect: "manual",
          signal: combinedSignal,
        });
      } catch (e) {
        if (e instanceof ProbeAbortedError) throw e;
        if (isOuterAborted()) throw new ProbeAbortedError();
        if (isDeadlineExpired()) {
          failure = { status: null, title: null, error: "timeout" };
          break;
        }
        const name = (e as { name?: string })?.name;
        failure = {
          status: null,
          title: null,
          error: name === "TimeoutError" ? "timeout" : "fetch_failed",
        };
        break;
      }

      if (combinedSignal.aborted) {
        await disposeResponseBody(response, combinedSignal);
        if (isOuterAborted()) throw new ProbeAbortedError();
        failure = { status: null, title: null, error: "timeout" };
        break;
      }

      const entries = headerEntries(response.headers);
      const location = locationOf(entries);
      const next = redirectLocation(response.status, location);
      if (next !== null) {
        await disposeResponseBody(response, combinedSignal);
        if (combinedSignal.aborted) {
          if (isOuterAborted()) throw new ProbeAbortedError();
          failure = { status: null, title: null, error: "timeout" };
          break;
        }
        let resolved: string;
        try {
          resolved = new URL(next, current).toString();
        } catch {
          failure = { status: null, title: null, error: "invalid_redirect" };
          hops.push({ url: current, status: response.status, location });
          break;
        }
        if (!resolved.startsWith("http://") && !resolved.startsWith("https://")) {
          failure = { status: null, title: null, error: "invalid_redirect" };
          hops.push({ url: current, status: response.status, location });
          break;
        }
        hops.push({ url: current, status: response.status, location });
        if (hops.length > HTTP_PROBE_MAX_HOPS) {
          failure = { status: null, title: null, error: "too_many_redirects" };
          break;
        }
        current = resolved;
        continue;
      }

      hops.push({ url: current, status: response.status, location });
      const selected = selectProbeHeaders(entries);
      let bodyResult: BodyReadResult;
      try {
        bodyResult = await readBoundedBodyText(response, combinedSignal, isOuterAborted, isDeadlineExpired);
      } catch (e) {
        if (e instanceof ProbeAbortedError) throw e;
        if (isOuterAborted()) throw new ProbeAbortedError();
        if (isDeadlineExpired()) {
          failure = { status: null, title: null, error: "timeout" };
          break;
        }
        failure = { status: null, title: null, error: "fetch_failed" };
        break;
      }
      if (bodyResult.kind === "timeout") {
        failure = { status: null, title: null, error: "timeout" };
        break;
      }
      if (bodyResult.kind === "fetch_failed") {
        failure = { status: null, title: null, error: "fetch_failed" };
        break;
      }
      final = {
        status: response.status,
        title: bodyResult.tooLarge ? null : parseProbeTitle(bodyResult.text),
        selected,
        error: bodyResult.tooLarge ? "body_too_large" : null,
      };
      break;
    }
  } finally {
    cleanupSignals();
  }

  if (final === null && failure === null) {
    failure = { status: null, title: null, error: "too_many_redirects" };
  }

  const fetchedAt = now().toISOString();
  const candidate: HttpProbeRaw =
    final !== null
      ? {
          parserVersion: "http-probe-raw-v1",
          url: startUrl,
          fetchedAt,
          finalUrl: current,
          status: final.status,
          title: final.title,
          selectedHeaders: final.selected,
          hops,
          error: final.error,
        }
      : {
          parserVersion: "http-probe-raw-v1",
          url: startUrl,
          fetchedAt,
          finalUrl: current,
          status: null,
          title: null,
          selectedHeaders: { contentType: null, server: null, poweredBy: null },
          hops,
          error: (failure as { error: HttpProbeErrorCode }).error,
        };

  const built = buildProbeRawBytes(candidate);
  if (!built.ok) throw new Error(built.error);
  return { ok: true, rawBytes: Buffer.from(built.bytes), raw: candidate };
}
