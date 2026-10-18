import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const verifier = fileURLToPath(new URL("./verify-control-plane.mjs", import.meta.url));
test("package verification refuses source identity omissions and external dependency links", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-package-boundary-"));
  try {
    const artifact = path.join(root, "artifact");
    await mkdir(artifact);
    const missing = spawnSync(process.execPath, [verifier, artifact], { encoding: "utf8" });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /exact source commit and tree IDs/);
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "synthetic"), "not part of the artifact");
    await symlink(outside, path.join(artifact, "dependency"));
    const escape = spawnSync(process.execPath, [verifier, artifact, "a".repeat(40), "b".repeat(40)], { encoding: "utf8" });
    assert.notEqual(escape.status, 0);
    assert.match(escape.stderr, /Package link escapes artifact/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
