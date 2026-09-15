import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { openEngagementDatabase } from "../dist/database.js";

const dataDirectory = mkdtempSync(
  path.join(tmpdir(), "stonehush-db-dist-migration-"),
);
chmodSync(dataDirectory, 0o700);

try {
  const database = openEngagementDatabase({ dataDirectory });
  try {
    const tables = database.sqlite
      .prepare(
        "select name from sqlite_master where type = 'table' order by name",
      )
      .pluck()
      .all();
    if (
      !tables.includes("engagements") ||
      !tables.includes("scope_revisions") ||
      !tables.includes("actions") ||
      !tables.includes("action_snapshots") ||
      !tables.includes("action_warning_acknowledgments") ||
      !tables.includes("action_covered_destinations") ||
      !tables.includes("runs") ||
      !tables.includes("run_leases") ||
      !tables.includes("run_events") ||
      !tables.includes("runner_identities") ||
      !tables.includes("runner_enrollment_challenges") ||
      !tables.includes("runner_sessions") ||
      !tables.includes("evidence_grants") ||
      !tables.includes("evidence_artifacts")
    ) {
      throw new Error("Built package did not resolve or apply its migrations.");
    }
  } finally {
    database.close();
  }
} finally {
  rmSync(dataDirectory, { recursive: true, force: true });
}
