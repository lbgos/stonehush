import { ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: vi.fn(),
}));
import { runSupervisedCommand } from "./process.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("returns failed cleanup and exact bounded bytes when signals fail and the child never closes", async () => {
  const runRoot = await mkdtemp(path.join(tmpdir(), "stonehush-denied-cleanup-"));
  const child = new ChildProcess();
  Object.defineProperty(child, "pid", { value: 424242 });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  vi.mocked(spawn).mockReturnValue(child);
  const handle = runSupervisedCommand({ runId: "denied", leaseId: "lease-1", fence: "1", runRoot,
    executable: process.execPath, argv: [] });
  try {
    while (handle.child === undefined) await new Promise<void>((resolve) => setTimeout(resolve, 5));
    child.stdout.emit("data", Buffer.from("captured before denied signals\n"));
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("synthetic signal denied"), { code: "EPERM" });
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
    const cancellation = handle.cancel();
    await vi.advanceTimersByTimeAsync(7000);
    expect(await cancellation).toEqual({ cleanupFailed: true });
    const result = await handle;
    expect(result.cleanupFailed).toBe(true);
    expect(result.stdout.toString()).toBe("captured before denied signals\n");
    expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([
      [-424242, "SIGTERM"], [-424242, "SIGKILL"],
    ]);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
  } finally {
    vi.useRealTimers();
    await rm(runRoot, { recursive: true, force: true });
  }
});
