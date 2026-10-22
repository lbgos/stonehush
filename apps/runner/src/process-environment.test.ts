import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRunDirPath, runSupervisedCommand } from "./process.js";

const { afterMkdir } = vi.hoisted(() => ({ afterMkdir: vi.fn<(directory: unknown) => Promise<void>>() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
    const result = await fs.mkdir(...args);
    await afterMkdir(args[0]);
    return result;
  } };
});

const roots: string[] = [];
afterEach(async () => {
  afterMkdir.mockReset();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-private-ffuf-config-"));
  roots.push(root);
  const runRoot = path.join(root, "runs");
  const command = { runRoot, runId: "config", leaseId: "lease", fence: "1", executable: process.execPath };
  return { root, runRoot, command };
}

// A child environment/filesystem probe, not a replacement for hosted real ffuf proof.
const probe = `
  const fs = require('node:fs');
  const path = require('node:path');
  const config = process.env.XDG_CONFIG_HOME;
  if (!config || !path.isAbsolute(config)) throw new Error('private config missing');
  if (fs.readdirSync(config).length !== 0) throw new Error('configuration bleed');
  const scraper = path.join(config, 'ffuf', 'scraper');
  fs.mkdirSync(scraper, { recursive: true });
  fs.writeFileSync(path.join(scraper, 'fixture'), 'owned run configuration');
  process.stdout.write(JSON.stringify({ env: process.env, config, scraper }));
`;

describe("supervised ffuf configuration", () => {
  it("supplies an empty writable owned private XDG directory and rejects ambient settings", async () => {
    const { root, command } = await fixture();
    const ambient = path.join(root, "ambient-config");
    await mkdir(ambient, { mode: 0o700 });
    await writeFile(path.join(ambient, "ffufrc"), "synthetic credential/config sentinel");
    for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) vi.stubEnv(key, ambient);
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "LD_PRELOAD", "LD_LIBRARY_PATH", "RUNNER_SECRET"]) {
      vi.stubEnv(key, "synthetic-untrusted-setting");
    }
    const result = await runSupervisedCommand({ ...command, configuration: "ffuf", argv: ["-e", probe] });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.length).toBe(0);
    const parsed = JSON.parse(result.stdout.toString()) as { env: Record<string, string>; config: string; scraper: string };
    const runDir = resolveRunDirPath(command.runRoot, command.runId, command.fence);
    expect(parsed.env).toEqual({ LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC", PATH: "/usr/bin:/bin",
      TMPDIR: path.join(runDir, "tmp"), XDG_CONFIG_HOME: path.join(runDir, "ffuf-config") });
    expect(parsed.scraper).toBe(path.join(runDir, "ffuf-config", "ffuf", "scraper"));
    for (const directory of [runDir, parsed.config]) {
      const st = await lstat(directory);
      expect(st.isSymbolicLink()).toBe(false);
      expect(st.uid).toBe(process.getuid?.());
      expect(st.mode & 0o777).toBe(0o700);
      expect(await realpath(directory)).toBe(directory);
    }
    expect(await readFile(path.join(ambient, "ffufrc"), "utf8")).toBe("synthetic credential/config sentinel");
    expect(await readdir(ambient)).toEqual(["ffufrc"]);
  });

  it("does not expand the environment of other commands", async () => {
    const { command } = await fixture();
    const result = await runSupervisedCommand({ ...command, argv: ["-e", "process.stdout.write(JSON.stringify(process.env))"] });
    expect(result.exitCode).toBe(0);
    expect(Object.keys(JSON.parse(result.stdout.toString()) as Record<string, string>).sort()).toEqual(
      ["LANG", "LC_ALL", "PATH", "TMPDIR", "TZ"],
    );
  });

  it("never reuses configuration across runs, fences, or a repeated run identity", async () => {
    const { command } = await fixture();
    const configs: string[] = [];
    for (const identity of [{ runId: "first", fence: "1" }, { runId: "second", fence: "1" }, { runId: "first", fence: "2" }]) {
      const result = await runSupervisedCommand({ ...command, ...identity, configuration: "ffuf", argv: ["-e", probe] });
      expect(result.exitCode).toBe(0);
      configs.push((JSON.parse(result.stdout.toString()) as { config: string }).config);
    }
    expect(new Set(configs).size).toBe(3);
    await expect(runSupervisedCommand({ ...command, runId: "first", configuration: "ffuf", argv: ["-e", probe] }))
      .rejects.toThrow("working_directory_escape");
  });

  it.each(["root", "ancestor", "run"] as const)("refuses a symlinked %s without reading or writing external configuration", async (kind) => {
    const { root, command } = await fixture();
    const outside = path.join(root, "outside");
    await mkdir(outside, { mode: 0o700 });
    await writeFile(path.join(outside, "sentinel"), "unchanged");
    if (kind === "root") await symlink(outside, command.runRoot);
    if (kind === "ancestor") {
      await symlink(outside, path.join(root, "linked"));
      command.runRoot = path.join(root, "linked", "runs");
    }
    if (kind === "run") {
      await mkdir(command.runRoot, { mode: 0o700 });
      await symlink(outside, resolveRunDirPath(command.runRoot, command.runId, command.fence));
    }
    await expect(runSupervisedCommand({ ...command, configuration: "ffuf", argv: ["-e", probe] }))
      .rejects.toThrow("working_directory_escape");
    expect(await readFile(path.join(outside, "sentinel"), "utf8")).toBe("unchanged");
    expect(await readdir(outside)).toEqual(kind === "ancestor" ? ["runs", "sentinel"] : ["sentinel"]);
  });

  it.each(["symlink", "mode"] as const)("refuses a %s substitution during configuration preparation before spawning", async (kind) => {
    const { root, command } = await fixture();
    const outside = path.join(root, "outside");
    await mkdir(outside, { mode: 0o700 });
    await writeFile(path.join(outside, "sentinel"), "unchanged");
    const configDir = path.join(resolveRunDirPath(command.runRoot, command.runId, command.fence), "ffuf-config");
    afterMkdir.mockImplementation(async (directory) => {
      if (directory !== configDir) return;
      if (kind === "mode") await chmod(configDir, 0o770);
      else {
        await rm(configDir, { recursive: true });
        await symlink(outside, configDir);
      }
    });
    const handle = runSupervisedCommand({ ...command, configuration: "ffuf", argv: ["-e", probe] });
    await expect(handle).rejects.toThrow("working_directory_escape");
    expect(handle.child).toBeUndefined();
    expect(await readdir(outside)).toEqual(["sentinel"]);
    expect(await readFile(path.join(outside, "sentinel"), "utf8")).toBe("unchanged");
  });

  it.each([0, 1, "cancel"] as const)("keeps configuration in the managed workspace through %s and removes it with workspace cleanup", async (ending) => {
    const { root, command } = await fixture();
    const handle = runSupervisedCommand({ ...command, configuration: "ffuf", argv: ["-e",
      probe + (ending === "cancel" ? ";setInterval(() => {}, 1000)" : `;process.exitCode=${ending}`)] });
    try {
      if (ending === "cancel") {
        const ready = path.join(resolveRunDirPath(command.runRoot, command.runId, command.fence), "ffuf-config", "ffuf", "scraper", "fixture");
        const deadline = performance.now() + 3000;
        while (true) {
          try { await access(ready); break; } catch {
            if (performance.now() > deadline) throw new Error("config probe readiness deadline");
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
          }
        }
        expect(await handle.cancel()).toEqual({ cleanupFailed: false });
      }
      const result = await handle;
      expect(result.cleanupFailed).toBe(false);
      if (ending !== "cancel") expect(result.exitCode).toBe(ending);
      const configDir = path.join(resolveRunDirPath(command.runRoot, command.runId, command.fence), "ffuf-config");
      expect(await readFile(path.join(configDir, "ffuf", "scraper", "fixture"), "utf8")).toBe("owned run configuration");
      await rm(root, { recursive: true });
      await expect(access(configDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await handle.cancel();
    }
  });
});
