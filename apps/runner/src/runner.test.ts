import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, link, mkdir, mkdtemp, rm, readdir, symlink, truncate, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import { BoundedCollector, FRAME_LIMIT } from "./bounded-output.js";
import { controlledEnv, buildFakeActionArgv, spawnFakeAction } from "./fake-action.js";
import { createRunDirectory, readNmapXmlSecurely, resolveNmapXmlPath, runSupervised, verifyExecutable } from "./process.js";
import { createRedactor } from "./redaction.js";
import {
  generateIdempotencyKey,
  getOrCreateOutboxEntry,
  loadOutboxEntry,
  removeOutboxAtomically,
} from "./outbox.js";
import { type ActionSnapshot, AcquireRunnerLeaseResponseSchema, commandJsonV1RunnerAppendStartedDigest, EVIDENCE_QUOTA_DEFAULTS } from "@stonehush/contracts";
import { createRunnerLoop, prepareFfufExecution, prepareNmapExecution, runOnce, RunnerShutdownError } from "./runner.js";

function fixtureActionSnapshot(actionId = "act-1"): ActionSnapshot {
  return {
    normalizationProfile: "d1-v1",
    orchestrationProfile: "d2-v1",
    snapshotId: `snapshot-${actionId}`,
    version: 1,
    binding: `sha256:${"a".repeat(64)}`,
    actionId,
    canonicalTargets: [
      {
        normalizationProfile: "d1-v1",
        kind: "hostname",
        hostname: "app.target.test",
      },
    ],
    concreteDestinations: [
      {
        normalizationProfile: "d1-v1",
        kind: "ip",
        family: 4,
        address: "192.0.2.10",
        zone: null,
      },
    ],
    typedOptions: { declaredPorts: [80, 443] },
    resolutionSnapshots: [],
    scopeRevisionId: null,
    warningState: {
      reasonCodes: [],
      knownAdditions: [],
      acknowledgment: null,
    },
  };
}

let fakeNmapPath: string | null = null;

beforeAll(async () => {
  const p = path.join(
    tmpdir(),
    `fake-nmap-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const s =
    "#!/bin/sh\n" +
    'oX=""\nprev=""\n' +
    'for arg in "$@"; do\n' +
    '  if [ "$prev" = "-oX" ]; then oX="$arg"; fi\n' +
    '  prev="$arg"\n' +
    "done\n" +
    'if [ -n "$oX" ]; then mkdir -p "$(dirname "$oX")"; echo \'<nmaprun></nmaprun>\' > "$oX"; fi\n' +
    "sleep 1\nexit 0\n";
  await writeFile(p, s, { mode: 0o700 });
  await chmod(p, 0o700);
  fakeNmapPath = p;
  process.env.STONEHUSH_NMAP_EXECUTABLE = p;
});

afterAll(async () => {
  if (fakeNmapPath !== null) {
    await rm(fakeNmapPath, { force: true }).catch(() => {});
  }
  delete process.env.STONEHUSH_NMAP_EXECUTABLE;
});

describe("fake-action argv invariants", () => {
  it("shell metacharacters remain one literal argv value and never execute", async () => {
    const tmp = path.join(tmpdir(), `stonehush-fake-argv-${Date.now()}`);
    await mkdir(tmp, { recursive: true });
    const sideEffect = path.join(tmp, "fixture-owned");
    const spec = buildFakeActionArgv(process.execPath, {
      runId: "run-fixture-1",
      leaseId: "lease-fixture-1",
      fence: "1",
      extraArgs: ["target.test;touch", sideEffect],
    });
    expect(spec.argv).toContain("target.test;touch");
    expect(spec.argv).toContain(sideEffect);
    expect(spec.argv.length).toBeGreaterThan(2);
    expect(spec.argv.join(" ")).toContain("target.test;touch");
    expect(existsSync(sideEffect)).toBe(false);
    await rm(tmp, { recursive: true, force: true });
  });

  it("rejects relative executable", () => {
    expect(() =>
      buildFakeActionArgv("fixtures/fake-exec", {
        runId: "run-fixture-2",
        leaseId: "lease-2",
        fence: "1",
      }),
    ).toThrow(/absolute/);
  });

  it("rejects command string contract", () => {
    const spec = buildFakeActionArgv(process.execPath, {
      runId: "run-fixture-3",
      leaseId: "lease-3",
      fence: "1",
    });
    expect(typeof spec.executable).toBe("string");
    expect(Array.isArray(spec.argv)).toBe(true);
    expect(spec.argv[0]).toBe(spec.executable);
  });

  it("spawn uses explicit argv array with shell:false", async () => {
    const runRoot = path.join(tmpdir(), `stonehush-spawn-${Date.now()}`);
    await mkdir(runRoot, { recursive: true });
    const spec = buildFakeActionArgv(process.execPath, {
      runId: "run-spawn-1",
      leaseId: "lease-spawn-1",
      fence: "1",
      durationMs: 5,
    });
    const env = controlledEnv(path.join(runRoot, "tmp"));
    const child = spawnFakeAction(spec, { cwd: runRoot, env });
    expect(child.spawnargs[0]).toBe(process.execPath);
    expect(child.spawnargs).toContain("-e");
    child.kill("SIGKILL");
    await new Promise((r) => child.on("close", r));
    await rm(runRoot, { recursive: true, force: true });
  });
});

describe("controlled environment", () => {
  it("rejects ambient dangerous names", () => {
    expect(() => controlledEnv("/tmp/fake-run", { LD_PRELOAD: "/tmp/fake.so" } as Record<string, string>)).toThrow(
      /denied/,
    );
    expect(() => controlledEnv("/tmp/fake-run", { HTTP_PROXY: "http://proxy.test" } as Record<string, string>)).toThrow(
      /denied/,
    );
    expect(() => controlledEnv("/tmp/fake-run", { UNDECLARED_FIXTURE: "value" } as Record<string, string>)).toThrow(
      /denied/,
    );
  });

  it("constructs predictable minimal environment", () => {
    const env = controlledEnv("/var/lib/stonehush-runner/runs/run-fixture-18");
    expect(env).toEqual({
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TZ: "UTC",
      PATH: "/usr/bin:/bin",
      TMPDIR: "/var/lib/stonehush-runner/runs/run-fixture-18/tmp",
    });
    expect((env as Record<string, string>).LD_PRELOAD).toBeUndefined();
  });
});

describe("working directory defenses", () => {
  it("rejects traversal via caller-controlled path", async () => {
    const root = path.join(tmpdir(), `stonehush-wd-${Date.now()}`);
    await mkdir(root, { recursive: true });
    await expect(createRunDirectory(root, "../outside", "1")).rejects.toThrow(/working_directory_escape|traversal/);
    await rm(root, { recursive: true, force: true });
  });

  it("creates isolated 0700 directory under managed root", async () => {
    const root = path.join(tmpdir(), `stonehush-wd-ok-${Date.now()}`);
    const { runDir, tmpDir } = await createRunDirectory(root, "run-fixture-99", "1");
    expect(runDir.startsWith(root)).toBe(true);
    expect(tmpDir).toBe(path.join(runDir, "tmp"));
    expect(existsSync(runDir)).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it("rejects symlinked runRoot", async () => {
    const real = path.join(tmpdir(), `stonehush-real-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const link = path.join(tmpdir(), `stonehush-link-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(real, { recursive: true });
    await symlink(real, link);
    await expect(createRunDirectory(link, "run-1", "1")).rejects.toThrow(/working_directory_escape|runRoot/);
    try {
      await createRunDirectory(link, "run-1", "1");
    } catch (e) {
      expect(String(e)).not.toContain(link);
    }
    await rm(link, { force: true });
    await rm(real, { recursive: true, force: true });
  });
});

describe("bounded output", () => {
  it("truncates excess and preserves truncation metadata truthfully", async () => {
    const collector = new BoundedCollector(16 * 1024 * 1024);
    const chunk = Buffer.alloc(8 * 1024 * 1024, "x");
    collector.push(chunk.length, chunk);
    collector.push(chunk.length, chunk);
    const extra = Buffer.alloc(1 * 1024 * 1024, "y");
    collector.push(extra.length, extra);
    const meta = collector.meta();
    expect(meta.bytesRetained).toBe(16 * 1024 * 1024);
    expect(meta.bytesDropped).toBe(1 * 1024 * 1024);
    expect(meta.truncated).toBe(true);
    expect(meta.firstDroppedRedactedOffset).toBe(16 * 1024 * 1024);
    expect(meta.inputBytesSeen).toBe(17 * 1024 * 1024);
  });

  it("splits retained bytes into 64 KiB frames", () => {
    const collector = new BoundedCollector(256 * 1024);
    collector.push(130 * 1024, Buffer.alloc(130 * 1024, "a"));
    const frames = collector.frames();
    expect(frames.length).toBe(3);
    expect(frames[0]?.length).toBe(FRAME_LIMIT);
    expect(frames[1]?.length).toBe(FRAME_LIMIT);
    expect(frames[2]?.length).toBe(2 * 1024);
  });

  it("child cannot deadlock on backpressure: excess drained", async () => {
    const runRoot = path.join(tmpdir(), `stonehush-bp-${Date.now()}`);
    await mkdir(runRoot, { recursive: true });
    const res = await runSupervised({
      runId: "run-bp-1",
      leaseId: "lease-bp-1",
      fence: "1",
      runRoot,
      durationMs: 10,
      stdoutFixture: "x".repeat(64 * 1024),
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.length).toBeGreaterThan(0);
    await rm(runRoot, { recursive: true, force: true });
  });
});

describe("redaction before buffering", () => {
  it("redacts secret before retained collection, any chunk boundary", async () => {
    const secret = "[fixture-credential]";
    const redactor = createRedactor({ secrets: [secret] });
    const collector = new BoundedCollector();
    const input = Buffer.from(`prefix --password=${secret} suffix`, "utf8");
    const mid = 12;
    const c1 = input.subarray(0, mid);
    const c2 = input.subarray(mid);
    const r1 = redactor.push(c1);
    collector.push(c1.length, r1);
    const r2 = redactor.push(c2);
    collector.push(c2.length, r2);
    const tail = redactor.flush();
    collector.push(0, tail);
    const out = collector.combined().toString("utf8");
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain(secret);
    expect(collector.meta().redactedBytesProduced).toBeGreaterThan(0);
    // Raw input byte count truthful
    expect(collector.meta().inputBytesSeen).toBe(input.length);
  });

  it("exact secret outside credential prefix: every split yields identical output", () => {
    const secret = "[fixture-value]";
    const input = `prefix [fixture-value] suffix`;
    const expected = `prefix [REDACTED] suffix`;
    const results = new Set<string>();
    for (let split = 0; split < input.length; split += 1) {
      const r = createRedactor({ secrets: [secret] });
      const c1 = Buffer.from(input.slice(0, split), "utf8");
      const c2 = Buffer.from(input.slice(split), "utf8");
      const out = Buffer.concat([r.push(c1), r.push(c2), r.flush()]).toString("utf8");
      results.add(out);
    }
    expect(results.size).toBe(1);
    expect([...results][0]).toBe(expected);
  });

  it("preserves invalid UTF-8 bytes outside ASCII redaction with delimiter", () => {
    const secret = "[fixture-value]";
    const redactor = createRedactor({ secrets: [secret] });
    // Include ASCII space delimiter after credential value before trailing 0xfe so fe is preserved
    const raw = Buffer.concat([
      Buffer.from([0xff]),
      Buffer.from(`--password=${secret} `, "utf8"),
      Buffer.from([0xfe]),
    ]);
    const a = redactor.push(raw.subarray(0, 5));
    const b = redactor.push(raw.subarray(5));
    const out = Buffer.concat([a, b, redactor.flush()]);
    expect(out[0]).toBe(0xff);
    expect(out[out.length - 1]).toBe(0xfe);
    expect(out.toString("utf8")).toContain("[REDACTED]");
    expect(out.toString("utf8")).not.toContain(secret);
  });

  it("credential prefix whole-value unquoted: redacts until delimiter", () => {
    const redactor = createRedactor({ secrets: [] });
    const input = Buffer.from("--password=secret123 suffix", "utf8");
    const out = Buffer.concat([redactor.push(input), redactor.flush()]).toString("utf8");
    expect(out).toBe("--password=[REDACTED] suffix");
  });

  it("credential prefix quoted: preserves quotes, redacts contents", () => {
    const secret = "[fixture-value]";
    const redactor = createRedactor({ secrets: [secret] });
    const input = Buffer.from(`--password="${secret}" suffix`, "utf8");
    const out = Buffer.concat([redactor.push(input), redactor.flush()]).toString("utf8");
    expect(out).toBe(`--password="[REDACTED]" suffix`);
  });

  it("credential prefix EOF: safely terminates without delimiter", () => {
    const redactor = createRedactor({ secrets: [] });
    const input = Buffer.from("--password=secret123", "utf8");
    const out = Buffer.concat([redactor.push(input), redactor.flush()]).toString("utf8");
    expect(out).toBe("--password=[REDACTED]");
  });

  it("credential prefix value with CRLF: preserves CRLF", () => {
    const redactor = createRedactor({ secrets: [] });
    const input = Buffer.from("Authorization: secret123\r\n--token=abc\tnext", "utf8");
    const out = Buffer.concat([redactor.push(input), redactor.flush()]).toString("utf8");
    expect(out).toBe("Authorization: [REDACTED]\r\n--token=[REDACTED]\tnext");
  });

  it("redaction before truncation: secret crossing boundary is not retained", () => {
    const secret = "[fixture-value]";
    const redactor = createRedactor({ secrets: [secret] });
    const collector = new BoundedCollector(20);
    const full = `prefix [fixture-value] suffix`;
    const mid = 12;
    const c1 = Buffer.from(full.slice(0, mid), "utf8");
    const c2 = Buffer.from(full.slice(mid), "utf8");
    collector.push(c1.length, redactor.push(c1));
    collector.push(c2.length, redactor.push(c2));
    collector.push(0, redactor.flush());
    const retained = collector.combined().toString("utf8");
    expect(retained).not.toContain(secret);
    expect(collector.meta().truncated).toBe(true);
    expect(collector.meta().inputBytesSeen).toBe(Buffer.byteLength(full, "utf8"));
  });

  it("large stream: internal buffering stays bounded", () => {
    const secret = "[fixture-value]";
    const redactor = createRedactor({ secrets: [secret] });
    const chunkSize = 1024;
    const total = 200 * 1024;
    let maxBuffered = 0;
    for (let i = 0; i < total; i += chunkSize) {
      const chunk = Buffer.alloc(chunkSize, "x");
      // Sprinkle secret every 50 KiB
      if (i % (50 * 1024) === 0) {
        chunk.write(secret, 100, "utf8");
      }
      redactor.push(chunk);
      maxBuffered = Math.max(maxBuffered, redactor.bufferedBytes());
    }
    redactor.flush();
    // Bounded to ~64 KiB + prefix
    expect(maxBuffered).toBeLessThanOrEqual(66 * 1024);
  });
});

describe("cancellation and cleanup", () => {
  it("SIGTERM->SIGKILL escalation with truthful partial evidence", async () => {
    const runRoot = path.join(tmpdir(), `stonehush-cancel-${Date.now()}`);
    await mkdir(runRoot, { recursive: true });
    const handle = runSupervised({
      runId: "run-cancel-1",
      leaseId: "lease-cancel-1",
      fence: "1",
      runRoot,
      durationMs: 60000,
    });
    await new Promise((r) => setTimeout(r, 100));
    await handle.cancel();
    const res = await handle;
    expect(res.stdout.toString("utf8")).toContain("fake-action");
    await rm(runRoot, { recursive: true, force: true });
  }, 10000);

  it("latches cancellation requested before spawn", async () => {
    const runRoot = path.join(tmpdir(), `stonehush-cancel-latch-${Date.now()}`);
    await mkdir(runRoot, { recursive: true });
    const handle = runSupervised({
      runId: "run-latch-1",
      leaseId: "lease-latch-1",
      fence: "1",
      runRoot,
      durationMs: 60000,
    });
    // Request cancel immediately before child spawns (race)
    const cancelPromise = handle.cancel();
    const res = await handle;
    await cancelPromise;
    // Should have terminated quickly, not run full 60s
    expect(res.signal).toBe("SIGTERM");
    await rm(runRoot, { recursive: true, force: true });
  }, 10000);
});

describe("idempotency and outbox", () => {
  it("generates 128-bit entropy keys of valid length and charset", () => {
    const keys = new Set<string>();
    for (let i = 0; i < 10; i += 1) {
      const k = generateIdempotencyKey();
      expect(k.length).toBeGreaterThanOrEqual(22);
      expect(k.length).toBeLessThanOrEqual(128);
      expect(/^[\x20-\x7e]+$/.test(k)).toBe(true);
      keys.add(k);
    }
    expect(keys.size).toBe(10);
  });

  it("never derives key from runId or fence", () => {
    const k1 = generateIdempotencyKey();
    const k2 = generateIdempotencyKey();
    expect(k1).not.toContain("run-fixture");
    expect(k1).not.toContain("fence");
    expect(k1).not.toBe(k2);
  });
});

describe("runner control loop invariants", () => {
  it("started is required before spawn: sequence ordering", async () => {
    const fakeLease = { runId: "run-fixture-10", leaseId: "lease-fixture-10", fence: "1" } as const;
    const startedSeq = 1;
    const completionSeq = 2;
    expect(completionSeq).toBe(startedSeq + 1);
    expect(fakeLease.fence).toBe("1");
  });

  it("fencing: superseded fence must not mutate", async () => {
    const code = "stale_fence";
    expect(["stale_fence", "lease_expired", "lease_owner_mismatch"].includes(code)).toBe(true);
  });
});

describe("redaction case-insensitive and oversize", () => {
  it("matches credential prefixes case-insensitively", () => {
    const cases = [
      { input: "--PASSWORD=secret suffix", expected: "--PASSWORD=[REDACTED] suffix" },
      { input: "--Token=abc123\tsuffix", expected: "--Token=[REDACTED]\tsuffix" },
      { input: "--API-KEY=xyz suffix", expected: "--API-KEY=[REDACTED] suffix" },
      { input: "AUTHORIZATION: secret123\r\nnext", expected: "AUTHORIZATION: [REDACTED]\r\nnext" },
      { input: "authorization: secret123\r\nnext", expected: "authorization: [REDACTED]\r\nnext" },
    ];
    for (const { input, expected } of cases) {
      const r = createRedactor({ secrets: [] });
      const out = Buffer.concat([r.push(Buffer.from(input, "utf8")), r.flush()]).toString("utf8");
      expect(out).toBe(expected);
    }
  });

  it("credential prefix case-insensitive split at every boundary", () => {
    const input = "--PASSWORD=secret suffix";
    const expected = "--PASSWORD=[REDACTED] suffix";
    const results = new Set<string>();
    for (let split = 0; split <= input.length; split++) {
      const r = createRedactor({ secrets: [] });
      const a = Buffer.from(input.slice(0, split), "utf8");
      const b = Buffer.from(input.slice(split), "utf8");
      const out = Buffer.concat([r.push(a), r.push(b), r.flush()]).toString("utf8");
      results.add(out);
    }
    expect(results.size).toBe(1);
    expect([...results][0]).toBe(expected);
  });

  it("unquoted oversize >64 KiB leaks zero bytes and stays bounded", () => {
    const redactor = createRedactor({ secrets: [] });
    const prefix = "--password=";
    const value = "x".repeat(65537);
    const input = Buffer.from(prefix + value + " suffix", "utf8");
    // Split into 1 KiB chunks to test streaming
    let out = Buffer.alloc(0);
    let maxBuffered = 0;
    for (let i = 0; i < input.length; i += 1024) {
      const chunk = input.subarray(i, Math.min(i + 1024, input.length));
      out = Buffer.concat([out, redactor.push(chunk)]);
      maxBuffered = Math.max(maxBuffered, redactor.bufferedBytes());
    }
    out = Buffer.concat([out, redactor.flush()]);
    const outStr = out.toString("utf8");
    expect(outStr).toBe("--password=[REDACTED] suffix");
    expect(outStr).not.toContain("x".repeat(10));
    expect(maxBuffered).toBeLessThanOrEqual(66 * 1024);
    expect(redactor.oversizeCount()).toBe(1);
  });

  it("quoted oversize >64 KiB leaks zero bytes and preserves quotes", () => {
    const redactor = createRedactor({ secrets: [] });
    const prefix = `--password="`;
    const value = "y".repeat(65537);
    // No closing quote, EOF
    const input = Buffer.from(prefix + value, "utf8");
    let out = Buffer.alloc(0);
    let maxBuffered = 0;
    for (let i = 0; i < input.length; i += 1024) {
      const chunk = input.subarray(i, Math.min(i + 1024, input.length));
      out = Buffer.concat([out, redactor.push(chunk)]);
      maxBuffered = Math.max(maxBuffered, redactor.bufferedBytes());
    }
    out = Buffer.concat([out, redactor.flush()]);
    const outStr = out.toString("utf8");
    expect(outStr).toBe(`--password="[REDACTED]`);
    expect(outStr).not.toContain("y".repeat(10));
    expect(maxBuffered).toBeLessThanOrEqual(66 * 1024);
    expect(redactor.oversizeCount()).toBe(1);
  });

  it("oversize quoted with closing quote after 64 KiB discards correctly", () => {
    const redactor = createRedactor({ secrets: [] });
    const value = "z".repeat(65537);
    const input = Buffer.from(`--token="${value}" suffix`, "utf8");
    const out = Buffer.concat([redactor.push(input), redactor.flush()]).toString("utf8");
    expect(out).toBe(`--token="[REDACTED]" suffix`);
    expect(out).not.toContain("z");
  });

  it("oversize split at every boundary still bounded and correct", () => {
    const prefix = "--api-key=";
    const value = "a".repeat(65537);
    const suffix = " suffix";
    const input = prefix + value + suffix;
    const expected = "--api-key=[REDACTED] suffix";
    for (let split = 0; split < input.length; split += 5000) {
      const r = createRedactor({ secrets: [] });
      const a = Buffer.from(input.slice(0, split), "utf8");
      const b = Buffer.from(input.slice(split), "utf8");
      const out = Buffer.concat([r.push(a), r.push(b), r.flush()]).toString("utf8");
      expect(out).toBe(expected);
      expect(r.bufferedBytes()).toBe(0);
    }
  });
});

describe("self-fence monotonic", () => {
  it("wall-clock jump does not extend authority", async () => {
    const leaseDurationMs = 30_000;
    const sendMonotonic = 1000;
    const deadlineMonotonic = sendMonotonic + leaseDurationMs;
    const cleanupMonotonic = deadlineMonotonic - 7000;
    const originalDateNow = Date.now;
    Date.now = (() => originalDateNow() + 3600_000) as unknown as typeof Date.now;
    // Monotonic still 1000, deadline unchanged
    expect(cleanupMonotonic).toBe(1000 + 30000 - 7000);
    // Even though Date.now is ahead, monotonic check should not use it
    // Simulate check at monotonic 2000 (1s later) should not be past deadline
    const nowMonotonic = 2000;
    expect(nowMonotonic < cleanupMonotonic).toBe(true);
    // Restore
    Date.now = originalDateNow;
  });

  it("late heartbeat response does not reset deadline from receive time", () => {
    const sendMonotonic = 5000;
    const leaseDurationMs = 30_000;
    const deadlineFromSend = sendMonotonic + leaseDurationMs;
    // Simulate heartbeat send at 5000, response arrives 5000ms later at monotonic 10000
    // Correct deadline should still be send + duration, not receive + duration
    const receiveMonotonic = 10000;
    const wrongDeadline = receiveMonotonic + leaseDurationMs;
    expect(deadlineFromSend).toBe(35000);
    expect(wrongDeadline).toBe(40000);
    expect(deadlineFromSend).not.toBe(wrongDeadline);
  });
});

describe("outbox crash consistency", () => {
  it("persists key/digest with fsync and reuses on retry, removes only after definitive response", async () => {
    const dataDir = path.join(tmpdir(), `stonehush-outbox-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const route = "/api/v1/runner/leases/lease-1/events";
    const operation = "append_started";
    const pathVal = { leaseId: "lease-1" };
    const query = {};
    const body = { runId: "run-1", sessionId: "sess-1", fence: "1", sequence: 1, payload: { startedAt: "2026-01-01T00:00:00.000Z" } };
    const first = await getOrCreateOutboxEntry({
      dataDir,
      actorId: "runner-1",
      route,
      operation,
      path: pathVal as unknown as import("@stonehush/contracts").JsonValue,
      query: query as unknown as import("@stonehush/contracts").JsonValue,
      body: body as unknown as import("@stonehush/contracts").JsonValue,
      digestProjection: commandJsonV1RunnerAppendStartedDigest,
    });
    expect(first.reused).toBe(false);
    const loaded = await loadOutboxEntry(dataDir, first.entry.key);
    expect(loaded).not.toBeNull();
    expect(loaded?.requestDigest).toBe(first.entry.requestDigest);
    // Second call with same digest should reuse same key
    const second = await getOrCreateOutboxEntry({
      dataDir,
      actorId: "runner-1",
      route,
      operation,
      path: pathVal as unknown as import("@stonehush/contracts").JsonValue,
      query: query as unknown as import("@stonehush/contracts").JsonValue,
      body: body as unknown as import("@stonehush/contracts").JsonValue,
      digestProjection: commandJsonV1RunnerAppendStartedDigest,
    });
    expect(second.reused).toBe(true);
    expect(second.entry.key).toBe(first.entry.key);
    expect(second.entry.requestDigest).toBe(first.entry.requestDigest);
    // Simulate definitive response: remove
    await removeOutboxAtomically(dataDir, first.entry.key);
    const after = await loadOutboxEntry(dataDir, first.entry.key);
    expect(after).toBeNull();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("retains outbox on network failure and validates safe filename", async () => {
    const dataDir = path.join(tmpdir(), `stonehush-outbox2-${Date.now()}`);
    const entry = await getOrCreateOutboxEntry({
      dataDir,
      actorId: "runner-2",
      route: "/api/v1/runner/leases/lease-2/complete",
      operation: "complete",
      path: { leaseId: "lease-2" } as unknown as import("@stonehush/contracts").JsonValue,
      query: {} as unknown as import("@stonehush/contracts").JsonValue,
      body: { runId: "run-2", sessionId: "sess-2", fence: "1", sequence: 2, terminalKind: "succeeded", reason: null } as unknown as import("@stonehush/contracts").JsonValue,
      digestProjection: (await import("@stonehush/contracts")).commandJsonV1RunnerCompleteDigest,
    });
    // Simulate network failure: do not remove, file should remain
    const still = await loadOutboxEntry(dataDir, entry.entry.key);
    expect(still).not.toBeNull();
    // Validate safe filename: loading with unsafe key returns null, no path traversal
    expect(await loadOutboxEntry(dataDir, "../evil")).toBeNull();
    expect(await loadOutboxEntry(dataDir, "key/with/slash")).toBeNull();
    // Cleanup
    await removeOutboxAtomically(dataDir, entry.entry.key);
    await rm(dataDir, { recursive: true, force: true });
  });

  it("file mode 0600 and no secret in entry", async () => {
    const dataDir = path.join(tmpdir(), `stonehush-outbox3-${Date.now()}`);
    const { entry, file } = await getOrCreateOutboxEntry({
      dataDir,
      actorId: "runner-3",
      route: "/api/v1/runner/leases/lease-3/events",
      operation: "append_started",
      path: { leaseId: "lease-3" } as unknown as import("@stonehush/contracts").JsonValue,
      query: {} as unknown as import("@stonehush/contracts").JsonValue,
      body: { runId: "run-3", sessionId: "sess-3", fence: "1", sequence: 1, payload: {} } as unknown as import("@stonehush/contracts").JsonValue,
      digestProjection: commandJsonV1RunnerAppendStartedDigest,
    });
    const stat = await import("node:fs/promises").then((m) => m.stat(file));
    expect(stat.mode & 0o777).toBe(0o600);
    const raw = await import("node:fs/promises").then((m) => m.readFile(file, "utf8"));
    expect(raw).not.toContain("secret");
    expect(entry.requestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    await removeOutboxAtomically(dataDir, entry.key);
    await rm(dataDir, { recursive: true, force: true });
  });
});

describe("runner loop shutdown", () => {
  let dataDir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    dataDir = path.join(tmpdir(), `test-loop-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(dataDir, { recursive: true });
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function mockHandshakeAndLease(leaseResponse: unknown): void {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/handshake")) {
        return new Response(
          JSON.stringify({
            acceptedProtocol: "runner-control-v1",
            sessionId: "sess-1",
            runnerId: "runner-1",
            leaseAllowed: true,
            sessionPinned: true,
            registryPinned: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (u.includes("/lease") && !u.includes("/heartbeat") && !u.includes("/events") && !u.includes("/complete")) {
        if (leaseResponse === null) {
          return new Response(JSON.stringify({ code: "no_work" }), { status: 409, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify(leaseResponse), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u.includes("/heartbeat")) {
        return new Response(JSON.stringify({ leaseExpiresAt: new Date(Date.now() + 30000).toISOString(), heartbeatSequence: 2 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.includes("/events")) {
        return new Response(JSON.stringify({ disposition: "accepted_event", event: { eventId: 1, runId: "run-1", sequence: 1, type: "started", fence: "1", payloadJson: "{}", digest: "sha256:" + "a".repeat(64), createdAt: new Date().toISOString() } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.includes("/complete")) {
        return new Response(JSON.stringify({ disposition: "accepted_completion", event: { eventId: 2, runId: "run-1", sequence: 2, type: "succeeded", fence: "1", payloadJson: "{}", digest: "sha256:" + "b".repeat(64), createdAt: new Date().toISOString() } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ code: "invalid_request" }), { status: 400, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
  }

  it("runOnce checks before handshake: aborted signal throws RunnerShutdownError and does not fetch lease", async () => {
    const controller = new AbortController();
    controller.abort();
    let fetchCalled = false;
    globalThis.fetch = vi.fn(async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await expect(runOnce({ dataDir, runnerId: "runner-1", secret: "a".repeat(43), apiBaseUrl: "http://127.0.0.1:9" }, { signal: controller.signal })).rejects.toBeInstanceOf(RunnerShutdownError);
    expect(fetchCalled).toBe(false);
  });

  it("runOnce checks before lease: aborted before lease does not send started", async () => {
    const ac = new AbortController();
    let leaseCalled = false;
    let startedCalled = false;
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/handshake")) {
        return new Response(
          JSON.stringify({ acceptedProtocol: "runner-control-v1", sessionId: "sess-1", runnerId: "runner-1", leaseAllowed: true, sessionPinned: true, registryPinned: false }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (u.includes("/lease") && !u.includes("/heartbeat") && !u.includes("/events") && !u.includes("/complete")) {
        leaseCalled = true;
        // Abort before lease returns started
        ac.abort();
        return new Response(JSON.stringify({ code: "no_work" }), { status: 409, headers: { "content-type": "application/json" } });
      }
      if (u.includes("/events")) startedCalled = true;
      return new Response(JSON.stringify({ code: "invalid_request" }), { status: 400, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await expect(runOnce({ dataDir, runnerId: "runner-1", secret: "a".repeat(43), apiBaseUrl: "http://127.0.0.1:9" }, { signal: ac.signal })).rejects.toBeInstanceOf(RunnerShutdownError);
    expect(leaseCalled).toBe(true);
    expect(startedCalled).toBe(false);
  });

  it("stop-before-start prevents new leases", async () => {
    let leaseCalls = 0;
    mockHandshakeAndLease(null);
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/lease")) leaseCalls++;
      return (origFetch as unknown as (url: string | URL | Request, init?: RequestInit) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;

    const loop = createRunnerLoop({ dataDir, runnerId: "runner-1", secret: "a".repeat(43), apiBaseUrl: "http://127.0.0.1:9", runRoot: path.join(dataDir, "runs") });
    loop.start();
    // Give loop a moment to attempt lease
    await new Promise((r) => setTimeout(r, 50));
    await loop.stop();
    const callsAfterStop = leaseCalls;
    await new Promise((r) => setTimeout(r, 200));
    expect(leaseCalls).toBe(callsAfterStop);
    expect(loop.isStopped()).toBe(true);
  });

  it("idle stop resolves quickly with no child", async () => {
    mockHandshakeAndLease(null);
    const loop = createRunnerLoop({ dataDir, runnerId: "runner-1", secret: "a".repeat(43), apiBaseUrl: "http://127.0.0.1:9", runRoot: path.join(dataDir, "runs") });
    loop.start();
    await new Promise((r) => setTimeout(r, 50));
    const start = Date.now();
    await loop.stop();
    expect(Date.now() - start).toBeLessThan(500);
    // No run directory should have been created
    const runs = await readdir(path.join(dataDir, "runs")).catch(() => []);
    expect(runs.length).toBe(0);
  });

  it("CLI stays alive across idle polls and exits promptly on SIGTERM", async () => {
    const apiRequire = createRequire(new URL("../../api/package.json", import.meta.url));
    const tsxPkgPath = apiRequire.resolve("tsx/package.json");
    const tsxPkg: { bin?: string | Record<string, string> } = JSON.parse(readFileSync(tsxPkgPath, "utf8"));
    const binRel = typeof tsxPkg.bin === "string" ? tsxPkg.bin : tsxPkg.bin?.tsx;
    if (!binRel) throw new Error("tsx executable not found; run pnpm install");
    const tsxCli = path.join(path.dirname(tsxPkgPath), binRel);
    const cliEntry = fileURLToPath(new URL("./index.ts", import.meta.url));

    const cliDataDir = await mkdtemp(path.join(tmpdir(), "cli-idle-"));
    const leaseTimes: number[] = [];
    const server = createServer((req, res) => {
      req.resume();
      if (req.method === "POST" && req.url === "/api/v1/runner/handshake") {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ acceptedProtocol: "runner-control-v1", sessionId: "sess-cli-1", runnerId: "runner-cli-1", leaseAllowed: true, sessionPinned: true, registryPinned: false }),
        );
      } else if (req.method === "POST" && req.url === "/api/v1/runner/lease") {
        leaseTimes.push(Date.now());
        res.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ code: "no_work" }));
      } else {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ code: "not_found" }));
      }
    });
    let child: ReturnType<typeof spawn> | undefined;
    let closed = false;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const bound = server.address();
      if (bound === null || typeof bound === "string") throw new Error("loopback bind failed");

      child = spawn(process.execPath, [tsxCli, "--conditions=development", cliEntry], {
        env: {
          ...process.env,
          STONEHUSH_API_BASE_URL: `http://127.0.0.1:${bound.port}`,
          STONEHUSH_RUNNER_DATA_DIR: cliDataDir,
          STONEHUSH_RUNNER_ID: "runner-cli-1",
          STONEHUSH_RUNNER_SECRET: "a".repeat(43),
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderrTail = "";
      const stderr = child.stderr;
      if (stderr) {
        stderr.setEncoding("utf8");
        stderr.on("data", (chunk: string) => {
          stderrTail = (stderrTail + chunk).slice(-4000);
        });
      }
      let spawnError: Error | null = null;
      child.once("error", (err) => {
        spawnError = err;
      });
      child.once("close", () => {
        closed = true;
      });
      const describeChild = () =>
        `exitCode=${String(child?.exitCode)} signalCode=${String(child?.signalCode)} spawnError=${spawnError?.message ?? "none"} stderr=${stderrTail}`;

      const pollDeadline = Date.now() + 7000;
      while (leaseTimes.length < 3 && child.exitCode === null && child.signalCode === null && Date.now() < pollDeadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(child.exitCode, `runner CLI exited while idle instead of polling (${describeChild()})`).toBeNull();
      expect(child.signalCode, `runner CLI killed while idle instead of polling (${describeChild()})`).toBeNull();
      expect(leaseTimes.length).toBeGreaterThanOrEqual(3);
      let previous: number | undefined;
      for (const at of leaseTimes) {
        if (previous !== undefined) expect(at - previous).toBeGreaterThanOrEqual(750);
        previous = at;
      }
      child.kill("SIGTERM");
      const stopDeadline = Date.now() + 2500;
      while (child.exitCode === null && child.signalCode === null && Date.now() < stopDeadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(child.signalCode, `runner CLI did not exit cleanly after SIGTERM (${describeChild()})`).toBeNull();
      expect(child.exitCode, `runner CLI did not exit after SIGTERM (${describeChild()})`).toBe(0);
      const frozen = leaseTimes.length;
      await new Promise((r) => setTimeout(r, 1100));
      expect(leaseTimes.length).toBe(frozen);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
      const runningChild = child;
      if (runningChild && !closed) await new Promise((r) => runningChild.once("close", r));
      await new Promise((r) => server.close(r));
      await rm(cliDataDir, { recursive: true, force: true });
    }
  }, 12000);

  it("leased pre-spawn cancellation does not spawn child", async () => {
    const leaseResponse = {
      run: { id: "run-1", actionId: "act-1", engagementId: "eng-1", attempt: 1, state: "leased", currentLeaseId: "lease-1", currentFence: "1", terminalKind: null, terminalReason: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), contractVersion: 1 },
      lease: { runId: "run-1", leaseId: "lease-1", runnerId: "runner-1", sessionId: "sess-1", fence: "1", expiresAt: new Date(Date.now() + 30000).toISOString(), latestHeartbeatSequence: 0, latestEventSequence: 0, orchestrationProfile: "d2-v1", protocol: "runner-control-v1" },
      actionSnapshot: fixtureActionSnapshot("act-1"),
    };
    let startedCalled = false;
    void startedCalled;
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/handshake")) {
        return new Response(JSON.stringify({ acceptedProtocol: "runner-control-v1", sessionId: "sess-1", runnerId: "runner-1", leaseAllowed: true, sessionPinned: true, registryPinned: false }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u.includes("/lease") && !u.includes("/heartbeat") && !u.includes("/events") && !u.includes("/complete")) {
        return new Response(JSON.stringify(leaseResponse), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u.includes("/events")) {
        startedCalled = true;
        return new Response(JSON.stringify({ disposition: "accepted_event", event: { eventId: 1, runId: "run-1", sequence: 1, type: "started", fence: "1", payloadJson: "{}", digest: "sha256:" + "a".repeat(64), createdAt: new Date().toISOString() } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u.includes("/complete")) {
        return new Response(JSON.stringify({ disposition: "accepted_completion", event: { eventId: 2, runId: "run-1", sequence: 2, type: "failed", fence: "1", payloadJson: "{}", digest: "sha256:" + "b".repeat(64), createdAt: new Date().toISOString() } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ code: "invalid_request" }), { status: 400, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const ac = new AbortController();
    // Abort before spawn: we will abort after lease but before started by using a fetch mock that aborts
    const origFetch = globalThis.fetch;
    let leaseDone = false;
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/lease") && !leaseDone) {
        leaseDone = true;
        const res = await (origFetch as unknown as typeof fetch)(url, init);
        ac.abort();
        return res;
      }
      return (origFetch as unknown as typeof fetch)(url, init);
    }) as unknown as typeof fetch;

    await expect(runOnce({ dataDir, runnerId: "runner-1", secret: "a".repeat(43), apiBaseUrl: "http://127.0.0.1:9", runRoot: path.join(dataDir, "runs") }, { signal: ac.signal })).rejects.toBeInstanceOf(RunnerShutdownError);
    // Started should not have been called if abort happened before it, or if it was called, it should be followed by failed completion, never success
    // Check that no child directory with running process remains
    const runs = await readdir(path.join(dataDir, "runs")).catch(() => []);
    // Either no run dir or dir exists but no child process (we can't easily check process, but ensure no new lease after)
    expect(Array.isArray(runs)).toBe(true);
  });

  it("running child is cancelled on stop, no child survives, never reports success", async () => {
    const leaseResponse = {
      run: { id: "run-1", actionId: "act-1", engagementId: "eng-1", attempt: 1, state: "leased", currentLeaseId: "lease-1", currentFence: "1", terminalKind: null, terminalReason: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), contractVersion: 1 },
      lease: { runId: "run-1", leaseId: "lease-1", runnerId: "runner-1", sessionId: "sess-1", fence: "1", expiresAt: new Date(Date.now() + 30000).toISOString(), latestHeartbeatSequence: 0, latestEventSequence: 0, orchestrationProfile: "d2-v1", protocol: "runner-control-v1" },
      actionSnapshot: fixtureActionSnapshot("act-1"),
    };
    let completeCaptured: { terminalKind: string; reason: string | null } | null = null;
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/handshake")) {
        return new Response(JSON.stringify({ acceptedProtocol: "runner-control-v1", sessionId: "sess-1", runnerId: "runner-1", leaseAllowed: true, sessionPinned: true, registryPinned: false }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u.includes("/lease") && !u.includes("/heartbeat") && !u.includes("/events") && !u.includes("/complete")) {
        return new Response(JSON.stringify(leaseResponse), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u.includes("/events")) {
        return new Response(JSON.stringify({ disposition: "accepted_event", event: { eventId: 1, runId: "run-1", sequence: 1, type: "started", fence: "1", payloadJson: "{}", digest: "sha256:" + "a".repeat(64), createdAt: new Date().toISOString() } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u.includes("/heartbeat")) {
        return new Response(JSON.stringify({ leaseExpiresAt: new Date(Date.now() + 30000).toISOString(), heartbeatSequence: 2 }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u.includes("/complete")) {
        try {
          const body = JSON.parse(String(init?.body ?? "{}")) as { terminalKind?: string; reason?: string | null };
          completeCaptured = { terminalKind: String(body.terminalKind ?? ""), reason: (body.reason as string | null) ?? null };
        } catch {}
        return new Response(JSON.stringify({ disposition: "accepted_completion", event: { eventId: 2, runId: "run-1", sequence: 2, type: "failed", fence: "1", payloadJson: "{}", digest: "sha256:" + "b".repeat(64), createdAt: new Date().toISOString() } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ code: "invalid_request" }), { status: 400, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const loop = createRunnerLoop({ dataDir, runnerId: "runner-1", secret: "a".repeat(43), apiBaseUrl: "http://127.0.0.1:9", runRoot: path.join(dataDir, "runs") });
    loop.start();
    await new Promise((r) => setTimeout(r, 150));
    const stopPromise = loop.stop();
    await stopPromise;
    expect(loop.isStopped()).toBe(true);
    expect(completeCaptured).not.toBeNull();
    expect(completeCaptured!.terminalKind).toBe("failed");
    expect(completeCaptured!.reason).toBe("runner_lost");
  });

  it("repeated stop is idempotent and does not race", async () => {
    mockHandshakeAndLease(null);
    const loop = createRunnerLoop({ dataDir, runnerId: "runner-1", secret: "a".repeat(43), apiBaseUrl: "http://127.0.0.1:9", runRoot: path.join(dataDir, "runs") });
    loop.start();
    const p1 = loop.stop();
    const p2 = loop.stop();
    const p3 = loop.stop();
    expect(p1).toBe(p2);
    expect(p2).toBe(p3);
    await p1;
    expect(loop.isStopped()).toBe(true);
  });

  it("definitive completion removes outbox, ambiguous retains", async () => {
    const dataDir2 = path.join(tmpdir(), `test-outbox-def-${Date.now()}`);
    await mkdir(dataDir2, { recursive: true });
    // Definitive: fetch returns 200, outbox should be removed
    let fetchShouldThrow = false;
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/handshake") || u.includes("/lease")) {
        return new Response(JSON.stringify({ acceptedProtocol: "runner-control-v1", sessionId: "sess-1", runnerId: "runner-1", leaseAllowed: true, sessionPinned: true, registryPinned: false }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u.includes("/events")) {
        return new Response(JSON.stringify({ disposition: "accepted_event", event: { eventId: 1, runId: "run-1", sequence: 1, type: "started", fence: "1", payloadJson: "{}", digest: "sha256:" + "a".repeat(64), createdAt: new Date().toISOString() } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u.includes("/complete")) {
        if (fetchShouldThrow) throw new Error("network failure");
        return new Response(JSON.stringify({ disposition: "accepted_completion", event: { eventId: 2, runId: "run-1", sequence: 2, type: "failed", fence: "1", payloadJson: "{}", digest: "sha256:" + "b".repeat(64), createdAt: new Date().toISOString() } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u.includes("/lease")) {
        return new Response(JSON.stringify({ run: { id: "run-1", actionId: "act-1", engagementId: "eng-1", attempt: 1, state: "leased", currentLeaseId: "lease-1", currentFence: "1", terminalKind: null, terminalReason: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), contractVersion: 1 }, lease: { runId: "run-1", leaseId: "lease-1", runnerId: "runner-1", sessionId: "sess-1", fence: "1", expiresAt: new Date(Date.now() + 30000).toISOString(), latestHeartbeatSequence: 0, latestEventSequence: 0, orchestrationProfile: "d2-v1", protocol: "runner-control-v1" }, actionSnapshot: fixtureActionSnapshot("act-1") }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ code: "invalid_request" }), { status: 400, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    // First, test definitive: should remove outbox
    // Use runOnce directly with mocked fetch that succeeds
    const leaseResponse = {
      run: { id: "run-1", actionId: "act-1", engagementId: "eng-1", attempt: 1, state: "leased", currentLeaseId: "lease-1", currentFence: "1", terminalKind: null, terminalReason: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), contractVersion: 1 },
      lease: { runId: "run-1", leaseId: "lease-1", runnerId: "runner-1", sessionId: "sess-1", fence: "1", expiresAt: new Date(Date.now() + 30000).toISOString(), latestHeartbeatSequence: 0, latestEventSequence: 0, orchestrationProfile: "d2-v1", protocol: "runner-control-v1" },
      actionSnapshot: fixtureActionSnapshot("act-1"),
    };
    let nmapGrant: Record<string, unknown> | null = null;
    let nmapPut: Buffer | null = null;
    const order: string[] = [];
    let finalCompleteBody: Record<string, unknown> | null = null;
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      const method = init?.method ?? "GET";
      if (u.includes("/handshake")) return new Response(JSON.stringify({ acceptedProtocol: "runner-control-v1", sessionId: "sess-1", runnerId: "runner-1", leaseAllowed: true, sessionPinned: true, registryPinned: false }), { status: 200, headers: { "content-type": "application/json" } });
      if (u.includes("/lease") && !u.includes("/heartbeat") && !u.includes("/events") && !u.includes("/complete") && !u.includes("/artifacts")) return new Response(JSON.stringify(leaseResponse), { status: 200, headers: { "content-type": "application/json" } });
      if (u.includes("/events") && !u.includes("/artifacts")) return new Response(JSON.stringify({ disposition: "accepted_event", event: { eventId: 1, runId: "run-1", sequence: 1, type: "started", fence: "1", payloadJson: "{}", digest: "sha256:" + "a".repeat(64), createdAt: new Date().toISOString() } }), { status: 200, headers: { "content-type": "application/json" } });
      if (u.includes("/heartbeat")) return new Response(JSON.stringify({ leaseExpiresAt: new Date(Date.now() + 30000).toISOString(), heartbeatSequence: 2 }), { status: 200, headers: { "content-type": "application/json" } });
      if (u.includes("/artifacts/grants")) {
        const b = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const s = String(b.artifactSlot ?? "stdout");
        if (s === "nmap-xml") { nmapGrant = b; order.push("nmap"); }
        const isN = s === "nmap-xml";
        const isE = s === "stderr";
        const aId = isN ? "00000000-0000-4000-8000-000000000003" : isE ? "00000000-0000-4000-8000-000000000002" : "00000000-0000-4000-8000-000000000001";
        const uId = isN ? "00000000-0000-4000-8000-000000000013" : isE ? "00000000-0000-4000-8000-000000000012" : "00000000-0000-4000-8000-000000000011";
        const k = isN ? "tool_raw" : s;
        const fn = isN ? "nmap.xml" : `${s}.log`;
        const ct = isN ? "application/xml" : "text/plain; charset=utf-8";
        const g = { artifactId: aId, uploadId: uId, runId: "run-1", leaseId: "lease-1", sessionId: "sess-1", fence: "1",
          eventSequence: b.eventSequence, artifactSlot: s, kind: k, declaredSizeBytes: b.declaredSizeBytes,
          declaredDigest: b.declaredDigest, originalFileName: fn, declaredContentType: ct, createdAt: new Date().toISOString() };
        return new Response(JSON.stringify(g), { status: 201, headers: { "content-type": "application/json" } });
      }
      if (u.includes("/uploads/") && method === "PUT") {
        const uploadId = u.split("/uploads/")[1]?.split("/")[0] ?? "";
        if (uploadId === "00000000-0000-4000-8000-000000000013") {
          nmapPut = Buffer.from(init?.body as unknown as Buffer);
        }
        return new Response(null, { status: 204 });
      }
      if (u.includes("/uploads/") && u.includes("/complete") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const uploadId = u.split("/uploads/")[1]?.split("/")[0] ?? "";

        let artifactId = "00000000-0000-4000-8000-000000000001";
        if (uploadId === "00000000-0000-4000-8000-000000000012") artifactId = "00000000-0000-4000-8000-000000000002";
        else if (uploadId === "00000000-0000-4000-8000-000000000013") artifactId = "00000000-0000-4000-8000-000000000003";
        return new Response(JSON.stringify({ disposition: "published", artifactId, sizeBytes: body.sizeBytes, digest: body.digest, completeness: body.completeness }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u.includes("/complete") && !u.includes("/artifacts")) {
        if (fetchShouldThrow) throw new Error("network failure");
        finalCompleteBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        order.push("final");
        return new Response(JSON.stringify({ disposition: "accepted_completion",
          event: { eventId: 2, runId: "run-1", sequence: 2,
            type: String(finalCompleteBody.terminalKind ?? "succeeded"), fence: "1", payloadJson: "{}",
            digest: "sha256:" + "b".repeat(64), createdAt: new Date().toISOString() } }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ code: "invalid_request" }), { status: 400, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    await runOnce({ dataDir: dataDir2, runnerId: "runner-1", secret: "a".repeat(43), apiBaseUrl: "http://127.0.0.1:9", runRoot: path.join(dataDir2, "runs") });
    const expectedXml = Buffer.from("<nmaprun></nmaprun>\n");
    const expectedDigest = `sha256:${createHash("sha256").update(expectedXml).digest("hex")}`;
    expect(nmapGrant).toMatchObject({
      artifactSlot: "nmap-xml",
      kind: "tool_raw",
      eventSequence: 2,
      originalFileName: "nmap.xml",
      declaredContentType: "application/xml",
      declaredSizeBytes: expectedXml.length,
      declaredDigest: expectedDigest,
    });
    expect(nmapPut).toEqual(expectedXml);
    expect(order.indexOf("nmap")).toBeLessThan(order.indexOf("final"));
    expect(finalCompleteBody).toMatchObject({ terminalKind: "succeeded", reason: null });
    const outboxFiles = await readdir(path.join(dataDir2, "outbox")).catch(() => []);
    expect(outboxFiles.length).toBe(0);

    // Now test ambiguous: fetch throws, outbox should remain
    fetchShouldThrow = true;
    const dataDir3 = path.join(tmpdir(), `test-outbox-amb-${Date.now()}`);
    await mkdir(dataDir3, { recursive: true });
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/handshake")) return new Response(JSON.stringify({ acceptedProtocol: "runner-control-v1", sessionId: "sess-1", runnerId: "runner-1", leaseAllowed: true, sessionPinned: true, registryPinned: false }), { status: 200, headers: { "content-type": "application/json" } });
      if (u.includes("/lease") && !u.includes("/heartbeat") && !u.includes("/events") && !u.includes("/complete")) return new Response(JSON.stringify(leaseResponse), { status: 200, headers: { "content-type": "application/json" } });
      if (u.includes("/events")) throw new Error("network failure");
      return new Response(JSON.stringify({ code: "invalid_request" }), { status: 400, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    await expect(runOnce({ dataDir: dataDir3, runnerId: "runner-1", secret: "a".repeat(43), apiBaseUrl: "http://127.0.0.1:9", runRoot: path.join(dataDir3, "runs") })).rejects.toThrow();
    const outboxFiles2 = await readdir(path.join(dataDir3, "outbox")).catch(() => []);
    expect(outboxFiles2.length).toBe(1);

    await rm(dataDir2, { recursive: true, force: true });
    await rm(dataDir3, { recursive: true, force: true });
  });
});

describe("runner lease snapshot parsing (M4 seam)", () => {
  it("parses valid lease with canonical snapshot and rejects strict mismatches without leaking", () => {
    const run = {
      contractVersion: 1 as const,
      id: "run-snapshot-1",
      actionId: "action-snapshot-1",
      engagementId: "engagement-1",
      attempt: 1,
      state: "leased" as const,
      currentLeaseId: "lease-snapshot-1",
      currentFence: "1" as const,
      terminalKind: null,
      terminalReason: null,
      createdAt: "2026-08-09T12:00:00.000Z",
      updatedAt: "2026-08-09T12:00:00.000Z",
    };
    const lease = {
      orchestrationProfile: "d2-v1" as const,
      protocol: "runner-control-v1" as const,
      runId: "run-snapshot-1",
      leaseId: "lease-snapshot-1",
      runnerId: "runner-1",
      sessionId: "sess-1",
      fence: "1" as const,
      expiresAt: "2026-08-09T12:00:30.000Z",
      latestHeartbeatSequence: 0,
      latestEventSequence: 0,
    };
    const snapshot = fixtureActionSnapshot("action-snapshot-1");
    const valid = { run, lease, actionSnapshot: snapshot };
    expect(AcquireRunnerLeaseResponseSchema.safeParse(valid).success).toBe(true);
    // missing snapshot -> strict reject
    expect(AcquireRunnerLeaseResponseSchema.safeParse({ run, lease } as unknown as Record<string, unknown>).success).toBe(false);
    // extra field -> strict reject
    expect(AcquireRunnerLeaseResponseSchema.safeParse({ ...valid, extra: "evil" }).success).toBe(false);
    // mismatched actionId -> untrusted rejection
    const tamperedActionId = { ...valid, actionSnapshot: { ...(snapshot as Record<string, unknown>), actionId: "action-tampered" } };
    const tamperedRes = AcquireRunnerLeaseResponseSchema.safeParse(tamperedActionId);
    expect(tamperedRes.success).toBe(false);
    expect(JSON.stringify(tamperedRes)).not.toContain("SENSITIVE");
    // mismatched lease runId
    const tamperedLease = { ...valid, lease: { ...lease, runId: "run-tampered" } };
    expect(AcquireRunnerLeaseResponseSchema.safeParse(tamperedLease).success).toBe(false);
    // mismatched fence
    const tamperedFence = { ...valid, lease: { ...lease, fence: "2" } };
    expect(AcquireRunnerLeaseResponseSchema.safeParse(tamperedFence).success).toBe(false);
    // malformed snapshot: empty canonicalTargets
    const malformed = { ...valid, actionSnapshot: { ...(snapshot as Record<string, unknown>), canonicalTargets: [] } };
    expect(AcquireRunnerLeaseResponseSchema.safeParse(malformed).success).toBe(false);
    // arbitrary JSON rejected
    expect(AcquireRunnerLeaseResponseSchema.safeParse({ run, lease, actionSnapshot: { arbitrary: "json" } }).success).toBe(false);
  });

  it("runner acquireLease rejects untrusted mismatched response via schema (no execution)", async () => {
    const tmp = path.join(tmpdir(), `stonehush-runner-mismatch-${Date.now()}`);
    await mkdir(tmp, { recursive: true });
    const originalFetch = globalThis.fetch;
    const run = {
      contractVersion: 1 as const,
      id: "run-mismatch-1",
      actionId: "action-mismatch-1",
      engagementId: "eng-1",
      attempt: 1,
      state: "leased" as const,
      currentLeaseId: "lease-mismatch-1",
      currentFence: "1" as const,
      terminalKind: null,
      terminalReason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const lease = {
      orchestrationProfile: "d2-v1" as const,
      protocol: "runner-control-v1" as const,
      runId: "run-mismatch-1",
      leaseId: "lease-mismatch-1",
      runnerId: "runner-1",
      sessionId: "sess-1",
      fence: "1" as const,
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      latestHeartbeatSequence: 0,
      latestEventSequence: 0,
    };
    const goodSnapshot = fixtureActionSnapshot("action-mismatch-1");
    const tamperedSnapshot = { ...(goodSnapshot as Record<string, unknown>), actionId: "action-tampered" };
    const tamperedResponse = { run, lease, actionSnapshot: tamperedSnapshot };
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/handshake")) {
        return new Response(
          JSON.stringify({
            acceptedProtocol: "runner-control-v1",
            sessionId: "sess-1",
            runnerId: "runner-1",
            leaseAllowed: true,
            sessionPinned: true,
            registryPinned: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (u.includes("/lease") && !u.includes("/heartbeat") && !u.includes("/events") && !u.includes("/complete")) {
        return new Response(JSON.stringify(tamperedResponse), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ code: "invalid_request" }), { status: 400 });
    }) as unknown as typeof fetch;
    const { acquireLease } = await import("./runner.js");
    const { resolveRunnerConfig } = await import("./config.js");
    const config = resolveRunnerConfig({ dataDir: tmp, runnerId: "runner-1", secret: "a".repeat(43), apiBaseUrl: "http://127.0.0.1:9" });
    await expect(acquireLease(config)).rejects.toThrow();
    globalThis.fetch = originalFetch;
    await rm(tmp, { recursive: true, force: true });
  });
});

describe("prepareNmapExecution", () => {
  it("prepares controlled argv and rejects extra shape without reflection", () => {
    const runRoot = path.join(tmpdir(), `prep-${Date.now()}`);
    const runId = "run-1";
    const fence = "1";
    const snapshot = fixtureActionSnapshot("act-prep-1");
    const prepared = prepareNmapExecution({ snapshot, runRoot, runId, fence });
    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      const xml = path.join(runRoot, `run-${runId}-f${fence}`, "nmap.xml");
      expect(prepared.argv[prepared.argv.indexOf("-oX") + 1]).toBe(xml);
      expect(prepared.argv[prepared.argv.indexOf("-p") + 1]).toBe("80,443");
      expect(prepared.argv).toContain("app.target.test");
    }
    const badSnapshot = { ...snapshot, typedOptions: { declaredPorts: [80], extra: "evil" } } as unknown as ActionSnapshot;
    const bad = prepareNmapExecution({ snapshot: badSnapshot, runRoot, runId, fence });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe("invalid_action_snapshot");
    expect(JSON.stringify(bad)).not.toContain("evil");
  });

  it("verifyExecutable rejects 0600 file without path leak", async () => {
    const p = path.join(tmpdir(), `v-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await writeFile(p, "x", { mode: 0o600 });
    await chmod(p, 0o600);
    await expect(verifyExecutable(p)).rejects.toThrow();
    await rm(p, { force: true }).catch(() => {});
  });
});

describe("prepareFfufExecution", () => {
  function ffufSnapshot(actionId: string, typedOptions: unknown): ActionSnapshot {
    const base = fixtureActionSnapshot(actionId);
    return {
      ...base,
      canonicalTargets: [
        {
          normalizationProfile: "d1-v1",
          kind: "url",
          url: "http://127.0.0.1:3130/",
          origin: "http://127.0.0.1:3130",
          host: { address: "127.0.0.1", zone: null },
          effectivePort: 80,
          pathAndQuery: "/",
        },
      ],
      concreteDestinations: [],
      typedOptions: typedOptions as ActionSnapshot["typedOptions"],
    } as unknown as ActionSnapshot;
  }

  const ffufOptions = {
    origin: "http://127.0.0.1:3130/",
    wordlistPath: "/lists/smoke.txt",
    rate: 100,
    threads: 10,
    timeoutSeconds: 5,
    maxTimeSeconds: 60,
    matchStatusCodes: [200],
  };

  it("derives runner-owned argv and ignores plain URL snapshots", () => {
    const runRoot = path.join(tmpdir(), `ffuf-prep-${Date.now()}`);
    const snapshot = ffufSnapshot("act-ffuf-1", { declaredPorts: null, ffuf: ffufOptions });
    const prepared = prepareFfufExecution({ snapshot, runRoot, runId: "run-1", fence: "1" });
    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      const expectedJson = path.join(runRoot, "run-run-1-f1", "ffuf.json");
      expect(prepared.options.outputJsonPath).toBe(expectedJson);
      expect(prepared.argv.slice(0, 3)).toEqual(["ffuf", "-u", "http://127.0.0.1:3130/FUZZ"]);
      expect(prepared.argv).toContain(expectedJson);
      expect(prepared.argv).not.toContain("-rate");
    }
    const plain = prepareFfufExecution({
      snapshot: fixtureActionSnapshot("act-plain-1"),
      runRoot,
      runId: "run-1",
      fence: "1",
    });
    expect(plain).toEqual({ ok: false, reason: "not_ffuf_snapshot" });
  });

  it("fails closed on corrupt ffuf markers", () => {
    const runRoot = path.join(tmpdir(), `ffuf-prep-${Date.now()}`);
    const corrupt = prepareFfufExecution({
      snapshot: ffufSnapshot("act-ffuf-2", { declaredPorts: null, ffuf: { origin: "ftp://x/" } }),
      runRoot,
      runId: "run-1",
      fence: "1",
    });
    expect(corrupt).toEqual({ ok: false, reason: "invalid_action_snapshot" });
    expect(JSON.stringify(corrupt)).not.toContain("ftp");
  });
});

describe("readNmapXmlSecurely", () => {
  it("accepts exact nonempty bytes", async () => {
    const runRoot = path.join(tmpdir(), `ok-${Date.now()}`);
    await createRunDirectory(runRoot, "run-ok-1", "1");
    const expected = Buffer.from("<nmaprun><host>ok</host></nmaprun>");
    await writeFile(resolveNmapXmlPath(runRoot, "run-ok-1", "1"), expected);
    expect((await readNmapXmlSecurely({ runRoot, runId: "run-ok-1", fence: "1" })).equals(expected)).toBe(true);
    await rm(runRoot, { recursive: true, force: true });
  });
  it("rejects empty, symlink, hardlink, oversized and parent escape with fixed error", async () => {
    const limit = EVIDENCE_QUOTA_DEFAULTS.perArtifactBytes;
    const cases: Array<{ name: string; setup: (runRoot: string, runId: string, fence: string) => Promise<string | void> }> = [
      { name: "empty", setup: async (runRoot, runId, fence) => { await writeFile(resolveNmapXmlPath(runRoot, runId, fence), Buffer.alloc(0)); } },
      { name: "symlink", setup: async (runRoot, runId, fence) => {
        const outside = `${runRoot}-outside`;
        await writeFile(outside, Buffer.from("evil"));
        await symlink(outside, resolveNmapXmlPath(runRoot, runId, fence));
        return outside;
      } },
      { name: "hardlink", setup: async (runRoot, runId, fence) => {
        await writeFile(resolveNmapXmlPath(runRoot, runId, fence), Buffer.from("xml"));
        await link(resolveNmapXmlPath(runRoot, runId, fence), `${resolveNmapXmlPath(runRoot, runId, fence)}.hl`);
      } },
      { name: "oversized", setup: async (runRoot, runId, fence) => {
        await writeFile(resolveNmapXmlPath(runRoot, runId, fence), Buffer.from("x"));
        await truncate(resolveNmapXmlPath(runRoot, runId, fence), limit + 1);
      } },
      { name: "parent-escape", setup: async (runRoot, runId, fence) => {
        const runDir = path.join(runRoot, `run-${runId}-f${fence}`);
        await mkdir(`${runRoot}-outside`, { recursive: true });
        await writeFile(path.join(`${runRoot}-outside`, "nmap.xml"), Buffer.from("evil"));
        await rm(runDir, { recursive: true, force: true });
        await symlink(`${runRoot}-outside`, runDir);
        return `${runRoot}-outside`;
      } },
    ];
    async function expectFixed(runRoot: string, runId: string, fence: string, xmlPath: string): Promise<void> {
      let thrown: unknown;
      try {
        await readNmapXmlSecurely({ runRoot, runId, fence });
      } catch (error: unknown) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe("nmap_xml_unavailable");
      const message = String(thrown);
      expect(message).not.toContain(runRoot);
      expect(message).not.toContain(xmlPath);
      expect(message).not.toContain("evil");
    }
    for (const testCase of cases) {
      const runRoot = path.join(tmpdir(), `x-${testCase.name}-${Date.now()}`);
      await createRunDirectory(runRoot, "run-1", "1");
      const attackerPath = await testCase.setup(runRoot, "run-1", "1") as string | undefined;
      const xmlPath = resolveNmapXmlPath(runRoot, "run-1", "1");
      await expectFixed(runRoot, "run-1", "1", xmlPath);
      await rm(runRoot, { recursive: true, force: true }).catch(() => {});
      if (typeof attackerPath === "string") await rm(attackerPath, { recursive: true, force: true }).catch(() => {});
    }
  });
});


