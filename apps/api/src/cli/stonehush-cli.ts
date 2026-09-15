import path from "node:path";

import { dataDirectoryFromEnvironment } from "../config.js";
import { runBackup, runRestore } from "../evidence/backup-restore.js";
import { runEvidenceDoctor } from "../evidence/doctor.js";

// Minimal dependency-free CLI entry for `stonehush doctor`, `backup`, and
// `restore`. The only output channel is deterministic JSON on stdout; exit
// code 0 means success, 1 means defects or an error outcome, 2 is usage or
// configuration failure. No physical path ever appears in stdout output.

export interface StonehushCliIo {
  readonly writeOut: (line: string) => void;
  readonly writeError: (line: string) => void;
}

const defaultIo: StonehushCliIo = {
  writeOut: (line) => process.stdout.write(line),
  writeError: (line) => process.stderr.write(line),
};

const USAGE =
  "usage: stonehush doctor | stonehush backup <absolute-directory> | " +
  "stonehush restore <absolute-directory> (requires STONEHUSH_DATA_DIR)";

function absoluteDirectoryArgument(
  rawArgument: string | undefined,
): string | undefined {
  if (
    rawArgument === undefined ||
    rawArgument.length === 0 ||
    rawArgument.includes("\0") ||
    !path.isAbsolute(rawArgument)
  ) {
    return undefined;
  }
  return path.resolve(rawArgument);
}

export async function runStonehushCli(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
  io: StonehushCliIo = defaultIo,
): Promise<number> {
  const command = argv[0];
  let directoryArgument: string | undefined;
  if (command === "doctor") {
    if (argv.length !== 1) {
      io.writeError(`${USAGE}\n`);
      return 2;
    }
  } else if (command === "backup" || command === "restore") {
    if (argv.length !== 2) {
      io.writeError(`${USAGE}\n`);
      return 2;
    }
    const resolved = absoluteDirectoryArgument(argv[1]);
    if (resolved === undefined) {
      io.writeError(`${USAGE}\n`);
      return 2;
    }
    directoryArgument = resolved;
  } else {
    io.writeError(`${USAGE}\n`);
    return 2;
  }

  let dataDirectory: string;
  try {
    dataDirectory = dataDirectoryFromEnvironment(environment);
  } catch (error) {
    io.writeError(`${error instanceof Error ? error.message : USAGE}\n`);
    return 2;
  }

  if (command === "doctor") {
    const outcome = await runEvidenceDoctor({ dataDirectory });
    const payload =
      outcome.status === "report"
        ? { status: "report", report: outcome.report }
        : { status: "error", code: outcome.code };
    io.writeOut(`${JSON.stringify(payload)}\n`);
    return outcome.status === "report" && outcome.report.healthy ? 0 : 1;
  }

  if (command === "backup") {
    const destinationDirectory = directoryArgument ?? "";
    const outcome = await runBackup({ dataDirectory, destinationDirectory });
    if (outcome.status === "complete") {
      io.writeOut(`${JSON.stringify(outcome)}\n`);
      return 0;
    }
    io.writeOut(`${JSON.stringify({ status: "error", code: outcome.code })}\n`);
    return 1;
  }

  // The argument gate above guarantees command is "restore" here.
  const backupDirectory = directoryArgument ?? "";
  const outcome = await runRestore({ backupDirectory, dataDirectory });
  if (outcome.status === "complete") {
    io.writeOut(`${JSON.stringify(outcome)}\n`);
    return 0;
  }
  io.writeOut(`${JSON.stringify({ status: "error", code: outcome.code })}\n`);
  return 1;
}
