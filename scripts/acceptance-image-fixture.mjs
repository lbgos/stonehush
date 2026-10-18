import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmod, cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";

// Executed through stdin inside the image. It imports only packaged modules.
const require = createRequire("/opt/stonehush/api/package.json");
const dbRequire = createRequire(require.resolve("@stonehush/db"));
const [mode, ...args] = process.argv.slice(2);
assert.equal(process.getuid(), 10001);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function inventory(root) {
  const files = [];
  async function walk(relative = "") {
    for (const entry of await readdir(`${root}/${relative}`, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const filename = `${root}/${name}`;
      const info = await stat(filename);
      assert.equal(info.uid, 10001);
      assert.equal(info.mode & 0o777, entry.isDirectory() ? 0o700 : 0o600, name);
      if (entry.isDirectory()) await walk(name);
      else {
        assert.ok(entry.isFile());
        files.push({ path: name, sha256: digest(await readFile(filename)) });
      }
    }
  }
  await walk();
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
if (mode === "package") {
  assert.equal(process.version, "v24.18.0");
  const artifact = JSON.parse(await readFile("/opt/stonehush/artifact.json", "utf8"));
  assert.equal(artifact.revision, args[0]);
  assert.equal(artifact.tree, args[1]);
  assert.equal(artifact.schemaVersion, 27);
  assert.equal(artifact.migrations.length, 28);
  for (const file of artifact.inventory) {
    assert.equal(digest(await readFile(`/opt/stonehush/${file.path}`)), file.sha256, file.path);
  }
  assert.equal(require("@stonehush/evidence-native").loadEvidenceNative().ok, true);
  let refused = false;
  try { await writeFile("/opt/stonehush/forbidden", "fixture"); } catch (error) { refused = ["EROFS", "EACCES"].includes(error.code); }
  assert.ok(refused);
  assert.equal((await stat("/data")).mode & 0o777, 0o700);
  console.log(JSON.stringify({ node: process.version, schema: 27, files: artifact.inventory.length, migrations: artifact.migrations }));
} else if (mode === "mkdir") {
  for (const directory of args) await mkdir(directory, { mode: 0o700 });
} else if (mode === "snapshot") {
  const root = args[0];
  const files = await inventory(root);
  const Database = dbRequire("better-sqlite3");
  const filename = root === "/data/snapshot" ? `${root}/sqlite/stonehush.sqlite3` : `${root}/stonehush.sqlite3`;
  const database = new Database(filename, { readonly: true });
  assert.equal(database.pragma("integrity_check", { simple: true }), "ok");
  assert.deepEqual(database.pragma("foreign_key_check"), []);
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const records = Object.fromEntries(tables.map(({ name }) => [name, database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()]));
  database.close();
  console.log(JSON.stringify({ files: files.filter((file) => file.path.startsWith("evidence/published/")), records }));
} else if (mode === "refusal-fixtures") {
  const root = "/data/snapshot";
  for (const name of ["incomplete", "corrupt", "newer"]) await cp(root, `/data/${name}`, { recursive: true });
  await writeFile("/data/incomplete/INCOMPLETE", "fixture", { mode: 0o600 });
  const manifest = JSON.parse(await readFile("/data/newer/backup-manifest", "utf8"));
  manifest.schemaVersion = 28;
  await writeFile("/data/newer/backup-manifest", JSON.stringify(manifest));
  await writeFile("/data/corrupt/sqlite/stonehush.sqlite3", "corrupt synthetic snapshot");
  await mkdir("/data/nonempty", { mode: 0o700 });
  await writeFile("/data/nonempty/sentinel", "preserve", { mode: 0o600 });
  for (const name of ["destination-incomplete", "destination-corrupt", "destination-newer", "restored"]) await mkdir(`/data/${name}`, { mode: 0o700 });
} else if (mode === "no-clobber") {
  assert.equal(await readFile("/data/nonempty/sentinel", "utf8"), "preserve");
  assert.deepEqual(await readdir("/data/nonempty"), ["sentinel"]);
  for (const name of ["incomplete", "corrupt", "newer"]) assert.deepEqual(await readdir(`/data/destination-${name}`), []);
  console.log(JSON.stringify({ refusedWithoutWrites: true }));
} else if (mode === "newer-live") {
  await mkdir("/data/newer-live", { mode: 0o700 });
  await cp("/data/snapshot/sqlite/stonehush.sqlite3", "/data/newer-live/stonehush.sqlite3");
  const Database = dbRequire("better-sqlite3");
  const database = new Database("/data/newer-live/stonehush.sqlite3");
  database.exec("insert into __drizzle_migrations (hash, created_at) select 'synthetic-future', max(created_at) + 1 from __drizzle_migrations");
  database.close();
  await chmod("/data/newer-live/stonehush.sqlite3", 0o600);
  const before = await readFile("/data/newer-live/stonehush.sqlite3");
  assert.throws(() => require("@stonehush/db").openEngagementDatabase({ dataDirectory: "/data/newer-live" }), /Database schema is newer/);
  assert.deepEqual(await readFile("/data/newer-live/stonehush.sqlite3"), before);
} else throw new Error("Unknown image acceptance mode.");
