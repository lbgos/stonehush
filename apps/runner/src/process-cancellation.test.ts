import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSupervisedCommand } from "./process.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function root() {
  const directory = await mkdtemp(path.join(tmpdir(), "stonehush-group-cancel-"));
  directories.push(directory);
  return directory;
}
async function waitFor<T>(read: () => Promise<T | null>, budget = 3000): Promise<T> {
  const deadline = performance.now() + budget;
  while (performance.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("fixture readiness deadline");
}
async function isExecuting(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch { return false; }
}

describe("native cancellation admission and descendants", () => {
  it("does not spawn when cancellation arrives during directory preparation", async () => {
    const runRoot = await root();
    const handle = runSupervisedCommand({ runId: "cancel-before-spawn", leaseId: "lease-1", fence: "1", runRoot,
      executable: process.execPath, argv: ["-e", "throw new Error('must not run')"] });
    await handle.cancel();
    const result = await handle;
    expect(handle.child).toBeUndefined();
    expect(result).toMatchObject({ exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), cleanupFailed: false });
  });

  it("verifies descendants when cancellation arrives after a normal parent close", async () => {
    const runRoot = await root();
    const descendantScript = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync('late.pid', String(process.pid)); setInterval(() => {}, 1000);`;
    const parentScript = `const fs=require('node:fs'); const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendantScript)}],{stdio:'ignore'}); child.unref(); const timer=setInterval(()=>{if(fs.existsSync('late.pid')){clearInterval(timer);process.stdout.write('settled prefix\\n');process.exit(0);}},10);`;
    const handle = runSupervisedCommand({ runId: "late-descendant", leaseId: "lease-1", fence: "1", runRoot,
      executable: process.execPath, argv: ["-e", parentScript] });
    const result = await handle;
    const pid = Number(await readFile(path.join(runRoot, "run-late-descendant-f1", "late.pid"), "utf8"));
    try {
      expect(result.exitCode).toBe(0);
      expect(await isExecuting(pid)).toBe(true);
      expect(await handle.cancel()).toEqual({ cleanupFailed: false });
      expect(await isExecuting(pid)).toBe(false);
      expect(result.stdout.toString()).toBe("settled prefix\n");
    } finally {
      try { process.kill(pid, "SIGKILL"); } catch {}
      await handle.cancel();
    }
  }, 10000);

  it("escalates a TERM-resistant descendant after its parent closes with no inherited pipes", async () => {
    const runRoot = await root();
    const descendantScript = `const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync('descendant.pid', String(process.pid)); setInterval(() => {}, 1000);`;
    const parentScript = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(descendantScript)}],{stdio:'ignore'}); child.unref(); process.on('SIGTERM',()=>process.exit(0)); process.stdout.write('captured parent prefix\\n'); setInterval(()=>{},1000);`;
    const handle = runSupervisedCommand({ runId: "descendant", leaseId: "lease-1", fence: "1", runRoot,
      executable: process.execPath, argv: ["-e", parentScript] });
    const pid = await waitFor(async () => {
      try { return Number(await readFile(path.join(runRoot, "run-descendant-f1", "descendant.pid"), "utf8")); } catch { return null; }
    });
    try {
      expect(await isExecuting(pid)).toBe(true);
      const start = performance.now();
      await handle.cancel();
      const result = await handle;
      expect(performance.now() - start).toBeLessThan(7500);
      expect(await isExecuting(pid)).toBe(false);
      expect(result.cleanupFailed).toBe(false);
      expect(result.stdout.toString()).toBe("captured parent prefix\n");
    } finally {
      try { process.kill(pid, "SIGKILL"); } catch {}
      await handle.cancel();
    }
  }, 10000);
});
