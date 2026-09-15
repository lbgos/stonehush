export const API_READINESS_TIMEOUT_MS = 10_000;
const HEALTH_REQUEST_TIMEOUT_MS = 500;
const READINESS_RETRY_DELAY_MS = 50;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function isExactHealthResponse(response) {
  if (response.status !== 200) return false;
  let payload;
  try {
    payload = await response.json();
  } catch {
    return false;
  }
  return (
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    Object.keys(payload).length === 1 &&
    payload.status === "ok"
  );
}

export async function probeApiHealth(fetchImplementation, url) {
  try {
    const response = await fetchImplementation(url, {
      method: "GET",
      signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
    });
    return isExactHealthResponse(response);
  } catch {
    return false;
  }
}

export async function waitForApiReadiness({
  exited,
  fetchImplementation = fetch,
  now = Date.now,
  pause = delay,
  timeoutMs = API_READINESS_TIMEOUT_MS,
  url,
}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const outcome = await Promise.race([
      probeApiHealth(fetchImplementation, url).then((ready) => ({ ready })),
      exited.then((result) => ({ result })),
    ]);
    if ("result" in outcome) {
      throw new Error("Stonehush API exited before it became ready.");
    }
    if (outcome.ready) return;
    await Promise.race([
      pause(READINESS_RETRY_DELAY_MS),
      exited.then(() => {
        throw new Error("Stonehush API exited before it became ready.");
      }),
    ]);
  }
  throw new Error("Stonehush API did not become ready before the development startup deadline.");
}

export async function startApiThenWeb({ apiIsRunning, startApi, startWeb, waitUntilReady }) {
  const api = startApi();
  await waitUntilReady(api);
  if (!apiIsRunning(api)) throw new Error("Stonehush API exited before web startup.");
  const web = startWeb();
  return { api, web };
}
