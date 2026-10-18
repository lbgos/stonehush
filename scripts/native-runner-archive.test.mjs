import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { archiveRuntime } from "./build-native-runner.mjs";

test("archive export exclusively creates a private file and refuses intervening files or symlinks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-native-export-"));
  try {
    await mkdir(path.join(root, "stonehush-runner"));
    await writeFile(path.join(root, "stonehush-runner", "synthetic"), "synthetic artifact bytes");
    const output = path.join(root, "runner.tar.gz");
    await archiveRuntime(root, output);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.ok(gunzipSync(await readFile(output)).includes(Buffer.from("synthetic artifact bytes")));
    const original = await readFile(output);
    await assert.rejects(archiveRuntime(root, output), { code: "EEXIST" });
    assert.deepEqual(await readFile(output), original);
    // Model another writer arriving after the build's initial existence check.
    const intervening = path.join(root, "intervening");
    await writeFile(intervening, "operator sentinel");
    await assert.rejects(archiveRuntime(root, intervening), { code: "EEXIST" });
    assert.equal(await readFile(intervening, "utf8"), "operator sentinel");
    const linked = path.join(root, "linked-output");
    await symlink(intervening, linked);
    await assert.rejects(archiveRuntime(root, linked), { code: "EEXIST" });
    assert.equal(await readFile(intervening, "utf8"), "operator sentinel");
  } finally { await rm(root, { recursive: true, force: true }); }
});
