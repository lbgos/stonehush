const STOP_GRACE_MS = 10_000;
const STOP_POLL_MS = 100;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// All helpers below take a real ChildProcess. Never pass a wrapper object:
// child.pid is undefined on wrappers, which silently disables signaling.
export function groupAlive(child) {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

export function signalGroup(child, signal) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

export function trackExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

export async function stopChild(child, exited, { graceMs = STOP_GRACE_MS } = {}) {
  if (!groupAlive(child)) {
    await exited;
    return;
  }
  signalGroup(child, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (groupAlive(child) && Date.now() < deadline) await delay(STOP_POLL_MS);
  if (groupAlive(child)) signalGroup(child, "SIGKILL");
  await exited;
}

// Registry owns only processes started by the caller. Shutdown stops them in
// reverse start order and never touches anything else on disk or in memory.
// anyExit() resolves with the first exit record so long waits can fail fast
// instead of hanging on a dead child.
export function createChildRegistry() {
  const entries = [];
  let notifyFirstExit = null;
  const firstExit = new Promise((resolve) => {
    notifyFirstExit = resolve;
  });
  return {
    track(child, exited, label = null) {
      const entry = { child, exited };
      entries.push(entry);
      exited.then(
        (result) => notifyFirstExit({ label, pid: child.pid ?? null, ...result }),
        () => notifyFirstExit({ label, pid: child.pid ?? null, code: 1, signal: null }),
      );
      return entry;
    },
    size() {
      return entries.length;
    },
    anyExit() {
      return firstExit;
    },
    async shutdown() {
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        try {
          await stopChild(entries[index].child, entries[index].exited);
        } catch {
          // Shutdown is best-effort; the caller exit code tells the truth.
        }
      }
    },
  };
}

// Exit record for a stalled stage. Any unexpected child exit fails the
// stage truthfully with the owning child named. There is deliberately no
// restart path: child supervision lives in the runner itself.
export function describeChildExit(exit) {
  return `demo child ${exit.label ?? "unknown"} pid ${String(exit.pid)} exited code ${String(exit.code)}`;
}

// Shared cleanup: concurrent callers join one in-flight run instead of
// each racing ahead while cleanup is still working.
export function createSharedCleanup(cleanup) {
  let promise = null;
  return () => {
    promise ??= (async () => cleanup())();
    return promise;
  };
}

// Bind a server, settling promptly on error or on a close that wins the
// race against listen. A close during bind rejects instead of hanging.
export function listenServer(server, { host, port }) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("close", () => reject(new Error("Server closed before listening.")));
    server.listen({ host, port }, () => resolve(server));
  });
}

export function closeServer(server, { graceMs = 2_000 } = {}) {
  return new Promise((resolve) => {
    try {
      server.closeAllConnections();
    } catch {
      // Older Node: fall through to close.
    }
    server.close(() => resolve());
    setTimeout(resolve, graceMs).unref?.();
  });
}

// Ownership for a server that binds asynchronously. takePending runs
// before the listen await so a concurrent closeAll always finds the
// just-created server; releasePending runs in a finally once listen
// settles. No listener is ever left unowned.
export function createFixtureOwner(close) {
  let owned = null;
  let pending = null;
  return {
    takePending(server) {
      pending = server;
    },
    releasePending(server) {
      if (pending === server) pending = null;
    },
    takeOwned(server) {
      owned = server;
    },
    isEmpty() {
      return owned === null && pending === null;
    },
    async closeAll() {
      const servers = [];
      if (owned !== null) {
        servers.push(owned);
        owned = null;
      }
      if (pending !== null && !servers.includes(pending)) {
        servers.push(pending);
        pending = null;
      }
      for (const server of servers) await close(server);
    },
  };
}

// One wait primitive for polling loops. Races a single delay against live
// exit promises that stay genuinely pending: no immediate-null branch, so
// an idle stack waits the full interval instead of busy-polling, and no
// extra timers accumulate per iteration.
export function raceTickOrExit(exitPromises, intervalMs) {
  return Promise.race([
    delay(intervalMs).then(() => ({ kind: "tick" })),
    ...exitPromises.map((pending) => pending.then((exit) => ({ kind: "exit", exit }))),
  ]);
}

// Stop state for bounded cancellation. Signal handlers call requestStop;
// stages call throwIfStopping before spawning children or sending requests,
// and in-flight fetches observe stopSignal. Shutdown itself stays separate
// and idempotent, touching only tracked children.
export function createStopState() {
  const controller = new AbortController();
  let resolveStopped = null;
  const stopped = new Promise((resolve) => {
    resolveStopped = resolve;
  });
  const state = {
    stopping: false,
    signalName: null,
    stopSignal: controller.signal,
    stopped,
    requestStop(name) {
      if (state.stopping) return;
      state.stopping = true;
      state.signalName = name;
      resolveStopped(name);
      controller.abort();
    },
    throwIfStopping(label) {
      if (state.stopping) {
        throw new Error(`Demo stopping on ${state.signalName}; refusing to start ${label}.`);
      }
    },
  };
  return state;
}
