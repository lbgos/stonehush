import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

test("image export uses the build ID and checks its source labels even when the tag moves", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-image-identity-"));
  const id = `sha256:${"c".repeat(64)}`;
  try {
    await writeFile(path.join(root, "git"), `#!/usr/bin/node
const args = process.argv.slice(2);
process.stdout.write(args[0] === 'archive' ? 'synthetic context' : (args[1] === 'HEAD' ? 'a'.repeat(40) : 'b'.repeat(40)) + '\\n');
`, { mode: 0o700 });
    await writeFile(path.join(root, "docker"), `#!/usr/bin/node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const id = ${JSON.stringify(id)};
fs.appendFileSync(path.join(${JSON.stringify(root)},'calls'), JSON.stringify(args)+'\\n');
if (args[0] === 'build') {
  process.stdin.resume();
  process.stdin.on('end', () => fs.writeFileSync(args[args.indexOf('--iidfile')+1],id));
} else if (args[1] === 'inspect') {
  // The supplied tag now names another image. Only ID-based lookup is valid.
  if (args.at(-1) !== id) process.exit(9);
  process.stdout.write(JSON.stringify({Id:id,Config:{Labels:{'org.opencontainers.image.revision':process.env.BAD_LABEL ? 'wrong' : 'a'.repeat(40),'dev.stonehush.source-tree':'b'.repeat(40)}}}));
} else if (args[1] === 'save') {
  if (args.at(-1) !== id) process.exit(10);
  process.stdout.write('synthetic image archive');
} else process.exit(11);
`, { mode: 0o700 });
    const helper = fileURLToPath(new URL("./build-control-plane.mjs", import.meta.url));
    const output = path.join(root, "image.tar");
    const env = { ...process.env, PATH: `${root}:/usr/bin:/bin` };
    const result = spawnSync(process.execPath, [helper, "synthetic:moved", output], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(await readFile(`${output}.json`, "utf8")).imageId, id);
    assert.equal(await readFile(output, "utf8"), "synthetic image archive");
    const mismatch = spawnSync(process.execPath, [helper, "synthetic:moved", path.join(root, "mismatch.tar")], { env: { ...env, BAD_LABEL: "1" }, encoding: "utf8" });
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /source identity does not match/);
    const clobber = spawnSync(process.execPath, [helper, "synthetic:moved", output], { env, encoding: "utf8" });
    assert.notEqual(clobber.status, 0);
    assert.match(clobber.stderr, /output already exists/);
    assert.equal(await readFile(output, "utf8"), "synthetic image archive");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
