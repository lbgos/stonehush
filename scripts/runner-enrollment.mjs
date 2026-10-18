import { randomUUID } from "node:crypto";

const REQUEST_TIMEOUT_MS = 10_000;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

async function apiJson(base, method, urlPath, { body, idempotencyKey, signal } = {}) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
  let response;
  try {
    response = await fetch(`${base}${urlPath}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(idempotencyKey !== undefined ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: combined,
    });
  } catch (error) {
    if (signal?.aborted === true) {
      throw new Error(`${method} ${urlPath} aborted: runner-dev stopping on signal.`);
    }
    throw error;
  }
  const text = await response.text();
  let payload;
  try {
    payload = text.length === 0 ? null : JSON.parse(text);
  } catch {
    throw new Error(`${method} ${urlPath} returned non-JSON status ${response.status}.`);
  }
  if (response.status >= 400) {
    const code = payload !== null && typeof payload === "object" ? payload.code : undefined;
    throw new Error(
      `${method} ${urlPath} failed status ${response.status}${code ? ` code ${code}` : ""}.`,
    );
  }
  return payload;
}

export async function enrollRunner({ apiBaseUrl, fingerprint, runnerName, stop, fetchJson = apiJson }) {
  const challenge = await fetchJson(apiBaseUrl, "POST", "/api/v1/runners/enrollment-challenges", {
    body: { installationFingerprint: fingerprint, name: runnerName },
    idempotencyKey: randomUUID(),
    signal: stop.stopSignal,
  });
  if (typeof challenge?.challengeId !== "string" || challenge.challengeId.length === 0) {
    throw new Error("Enrollment challenge returned no id.");
  }
  try {
    const confirmed = await fetchJson(
      apiBaseUrl,
      "POST",
      `/api/v1/runners/enrollment-challenges/${encodeURIComponent(challenge.challengeId)}/confirm`,
      {
        body: { ownerConfirmed: true },
        idempotencyKey: randomUUID(),
        signal: stop.stopSignal,
      },
    );
    const runnerId = confirmed?.runner?.id;
    const runnerRevision = confirmed?.runner?.revision;
    const runnerSecret = confirmed?.secret;
    if (typeof runnerId !== "string" || runnerId.length === 0 || runnerId.length > 255 || runnerId.includes("\0")) {
      throw new Error("Enrollment confirm returned no runner id.");
    }
    if (
      runnerRevision !== 1 ||
      confirmed.runner.status !== "enabled" ||
      confirmed.runner.installationFingerprint !== fingerprint ||
      confirmed.runner.name !== runnerName
    ) {
      throw new Error("Enrollment confirm returned no matching newly created runner identity.");
    }
    if (typeof runnerSecret !== "string" || !SECRET_PATTERN.test(runnerSecret)) {
      throw new Error("Enrollment confirm returned no usable runner secret.");
    }
    return { runnerId, runnerRevision, runnerSecret };
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} Confirmation may have enabled a runner. Inspect the API enrollment state and explicitly revoke only that identity before retrying; no identity was guessed or revoked.`,
    );
  }
}

// Call only for a successful enrollment owned by this launch, after stopping
// its child. Reused or uncertain identities must never enter this cleanup.
export async function revokeEnrolledRunner({ apiBaseUrl, runnerId, runnerRevision, fetchJson = apiJson }) {
  const revoked = await fetchJson(apiBaseUrl, "POST", `/api/v1/runners/${encodeURIComponent(runnerId)}/revoke`, {
    body: { expectedRevision: runnerRevision },
    idempotencyKey: randomUUID(),
  });
  if (
    revoked?.runner?.id !== runnerId ||
    revoked.runner.status !== "revoked" ||
    revoked.runner.revision !== runnerRevision + 1
  ) {
    throw new Error("Runner revocation returned no matching revoked identity.");
  }
  return revoked;
}

