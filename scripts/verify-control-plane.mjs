import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Runs against the standalone production package, before the runtime
// image is assembled. No dependency install or source checkout is used here.
const [directory, revision, tree] = process.argv.slice(2);
if (!directory || !/^[a-f0-9]{40}$/.test(revision ?? "") || !/^[a-f0-9]{40}$/.test(tree ?? "")) {
  throw new Error("Package verification needs exact source commit and tree IDs.");
}
const root = await realpath(directory);
const inventory = [];
async function inspect(relative = "") {
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    const filename = path.join(root, name);
    if (entry.isSymbolicLink()) {
      const target = await realpath(filename);
      if (!target.startsWith(`${root}${path.sep}`)) throw new Error("Package link escapes artifact.");
    } else if (entry.isDirectory()) {
      await inspect(name);
    } else {
      if (!entry.isFile() || (await lstat(filename)).nlink !== 1) throw new Error("Package contains a special file or hardlink.");
      const bytes = await readFile(filename);
      inventory.push({ path: name, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
  }
}
await inspect();
const api = path.join(root, "api");
for (const filename of ["dist/server.js", "dist/cli/stonehush.js"]) {
  if (!(await lstat(path.join(api, filename))).isFile()) throw new Error("Missing built API or CLI.");
}
const dbRoot = path.join(api, "node_modules/@stonehush/db");
const journal = JSON.parse(await readFile(path.join(dbRoot, "drizzle/meta/_journal.json"), "utf8"));
if (journal.entries.length !== 27 || journal.entries.at(-1).tag !== "0026_gitleaks_scans") {
  throw new Error("Unexpected first-RC migration baseline.");
}
const migrations = [];
for (const filename of ["meta/_journal.json", ...journal.entries.map((entry) => `${entry.tag}.sql`)]) {
  const bytes = await readFile(path.join(dbRoot, "drizzle", filename));
  migrations.push({ path: filename, sha256: createHash("sha256").update(bytes).digest("hex") });
}
const { loadEvidenceNative } = await import(pathToFileURL(path.join(api, "node_modules/@stonehush/evidence-native/dist/index.js")));
if (!loadEvidenceNative().ok) throw new Error("Packaged evidence addon is unavailable.");
const { DATABASE_SCHEMA_VERSION, openEngagementDatabase } = await import(pathToFileURL(path.join(dbRoot, "dist/index.js")));
if (DATABASE_SCHEMA_VERSION !== 27) throw new Error("Packaged database schema differs.");
const dataDirectory = await mkdtemp(path.join(tmpdir(), "stonehush-packaged-db-"));
try {
  await chmod(dataDirectory, 0o700);
  const database = openEngagementDatabase({ dataDirectory });
  try {
    if (database.sqlite.pragma("integrity_check", { simple: true }) !== "ok") {
      throw new Error("Packaged database failed integrity check.");
    }
  } finally {
    database.close();
  }
} finally {
  await rm(dataDirectory, { recursive: true, force: true });
}
await readFile(path.join(root, "web/index.html"));
inventory.sort((a, b) => a.path.localeCompare(b.path, "en"));
await writeFile(path.join(root, "artifact.json"), `${JSON.stringify({ revision, tree, node: process.version, pnpm: "10.24.0", schemaVersion: 27, migrations, inventory }, null, 2)}\n`, { flag: "wx" });
