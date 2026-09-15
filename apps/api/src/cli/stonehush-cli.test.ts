import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runStonehushCli } from "./stonehush-cli.js";

const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory === undefined) continue;
    await rm(directory, { recursive: true, force: true });
  }
});

interface CliRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCli(
  argv: string[],
  environment: NodeJS.ProcessEnv,
): Promise<CliRun> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runStonehushCli(argv, environment, {
    writeOut: (line) => stdout.push(line),
    writeError: (line) => stderr.push(line),
  });
  return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
}

describe("stonehush doctor CLI", () => {
  it("prints deterministic JSON and exits 0 for a healthy tree", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "doctor-cli-"));
    directories.push(directory);

    const native = await import("@stonehush/evidence-native");
    const loaded = native.loadEvidenceNative();
    if (!loaded.ok) throw new Error(`native binding unavailable: ${loaded.reason}`);
    const { EvidenceStore } = await import("../evidence/evidence-store.js");
    const storeResult = EvidenceStore.open(directory, loaded.binding);
    if (!storeResult.ok) throw new Error(`store open failed: ${storeResult.code}`);
    storeResult.store.close();
    // A migrated database with no rows keeps the report healthy.
    const { openEngagementDatabase } = await import("@stonehush/db");
    const database = openEngagementDatabase({ dataDirectory: directory });
    database.close();

    const first = await runCli(["doctor"], { STONEHUSH_DATA_DIR: directory });
    expect(first.exitCode).toBe(0);
    expect(first.stderr).toBe("");
    const parsed = JSON.parse(first.stdout) as {
      status: string;
      report: { profile: string; healthy: boolean; fatal: boolean; findings: { code: string }[] };
    };
    expect(parsed).toEqual({
      status: "report",
      report: {
        profile: "d3-v1",
        healthy: true,
        fatal: false,
        findings: [{ code: "healthy" }],
      },
    });

    const second = await runCli(["doctor"], { STONEHUSH_DATA_DIR: directory });
    expect(second.stdout).toBe(first.stdout);
  });

  it("exits 1 with defect JSON when the tree is unhealthy", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "doctor-cli-"));
    directories.push(directory);

    const native = await import("@stonehush/evidence-native");
    const loaded = native.loadEvidenceNative();
    if (!loaded.ok) throw new Error(`native binding unavailable: ${loaded.reason}`);
    const { EvidenceStore } = await import("../evidence/evidence-store.js");
    const storeResult = EvidenceStore.open(directory, loaded.binding);
    if (!storeResult.ok) throw new Error(`store open failed: ${storeResult.code}`);
    storeResult.store.close();
    // Untracked published entry: extra_artifact without any database row.
    const { openEngagementDatabase } = await import("@stonehush/db");
    const database = openEngagementDatabase({ dataDirectory: directory });
    database.close();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(directory, "evidence/published/extra-artifact"), "extra");

    const result = await runCli(["doctor"], { STONEHUSH_DATA_DIR: directory });
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      status: string;
      report: { healthy: boolean; findings: { code: string; artifactId?: string }[] };
    };
    expect(parsed.report.healthy).toBe(false);
    expect(parsed.report.findings).toContainEqual({
      code: "extra_artifact",
      artifactId: "extra-artifact",
    });
    expect(result.stdout).not.toContain(directory);
  });

  it("exits 2 on usage and configuration errors without touching stdout", async () => {
    const noArgs = await runCli([], {});
    expect(noArgs.exitCode).toBe(2);
    expect(noArgs.stdout).toBe("");

    const unknownCommand = await runCli(["repair"], {});
    expect(unknownCommand.exitCode).toBe(2);
    expect(unknownCommand.stderr).toContain("usage: stonehush");

    const missingDataDir = await runCli(["doctor"], {});
    expect(missingDataDir.exitCode).toBe(2);
    expect(missingDataDir.stdout).toBe("");

    const relativeDataDir = await runCli(["doctor"], { STONEHUSH_DATA_DIR: "relative/dir" });
    expect(relativeDataDir.exitCode).toBe(2);
    expect(relativeDataDir.stdout).toBe("");
  });
});

describe("stonehush backup and restore CLI", () => {
  it("rejects usage and configuration errors for backup and restore", async () => {
    const noArg = await runCli(["backup"], {});
    expect(noArg.exitCode).toBe(2);
    expect(noArg.stdout).toBe("");

    const relativeDestination = await runCli(["backup", "relative/dest"], {});
    expect(relativeDestination.exitCode).toBe(2);

    const restoreNoArg = await runCli(["restore"], {});
    expect(restoreNoArg.exitCode).toBe(2);
    expect(restoreNoArg.stdout).toBe("");

    const restoreRelative = await runCli(["restore", "relative/backup"], {});
    expect(restoreRelative.exitCode).toBe(2);
  });

  it("reports typed backup failures as JSON with exit code 1 and no paths", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "backup-cli-missing-"));
    directories.push(directory);
    const destination = await mkdtemp(path.join(tmpdir(), "backup-cli-dest-"));
    directories.push(destination);
    // The configured data directory does not exist, so the source is
    // unavailable; the refusal is typed JSON without any filesystem path.
    const result = await runCli(["backup", destination], {
      STONEHUSH_DATA_DIR: path.join(directory, "missing-data"),
    });
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout) as { status: string; code: string };
    expect(parsed).toEqual({ status: "error", code: "backup_source_unavailable" });
    expect(result.stdout).not.toContain(directory);
  });

  it("reports typed restore refusals as JSON with exit code 1 and no paths", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "restore-cli-missing-"));
    directories.push(directory);
    const result = await runCli(["restore", directory], {
      STONEHUSH_DATA_DIR: path.join(directory, "missing-data"),
    });
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout) as { status: string; code: string };
    expect(parsed.code).toBe("restore_destination_invalid");
    expect(result.stdout).not.toContain(directory);
  });
});
