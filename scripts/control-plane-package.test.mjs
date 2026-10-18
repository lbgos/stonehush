import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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

test("assembly preserves installed dependency versions and produces local links without installation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-locked-assembly-"));
  try {
    for (const name of ["scripts", "apps/api/dist", "apps/web/dist", "node_modules/fixture-package"]) await mkdir(path.join(root, name), { recursive: true });
    await copyFile(fileURLToPath(new URL("./assemble-control-plane.mjs", import.meta.url)), path.join(root, "scripts/assemble-control-plane.mjs"));
    await writeFile(path.join(root, "apps/api/package.json"), JSON.stringify({ name: "@stonehush/api", dependencies: { "fixture-package": "^1.0.0" } }));
    await writeFile(path.join(root, "apps/api/dist/server.js"), "// synthetic compiled API\n");
    await writeFile(path.join(root, "apps/web/dist/index.html"), "<!doctype html>");
    await writeFile(path.join(root, "LICENSE"), "synthetic test license");
    await writeFile(path.join(root, "node_modules/fixture-package/package.json"), JSON.stringify({ name: "fixture-package", version: "1.2.3", main: "index.js", optionalDependencies: { "missing-optional": "1.0.0" } }));
    await writeFile(path.join(root, "node_modules/fixture-package/index.js"), "module.exports = 123;\n");
    const output = path.join(root, "package");
    const run = () => spawnSync(process.execPath, [path.join(root, "scripts/assemble-control-plane.mjs"), output], { encoding: "utf8" });
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const dependency = path.join(output, "api/node_modules/fixture-package");
    assert.ok((await realpath(dependency)).startsWith(`${output}/`));
    assert.equal(JSON.parse(await readFile(path.join(dependency, "package.json"), "utf8")).version, "1.2.3");
    assert.equal(await readFile(path.join(dependency, "index.js"), "utf8"), "module.exports = 123;\n");
    const clobber = run();
    assert.notEqual(clobber.status, 0);
    assert.equal(await readFile(path.join(dependency, "index.js"), "utf8"), "module.exports = 123;\n");
    await writeFile(path.join(root, "apps/api/package.json"), JSON.stringify({ name: "@stonehush/api", dependencies: { "missing-required": "1.0.0" } }));
    const missing = spawnSync(process.execPath, [path.join(root, "scripts/assemble-control-plane.mjs"), path.join(root, "missing")], { encoding: "utf8" });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Missing installed runtime dependency/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("image export binds source metadata and image bytes despite HEAD and tag movement", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-image-identity-"));
  const id = `sha256:${"c".repeat(64)}`;
  try {
    await writeFile(path.join(root, "git"), `#!/usr/bin/node
const args = process.argv.slice(2);
if (args[0] === 'archive' && args[2] === 'a'.repeat(40)) process.stdout.write('synthetic context');
else if (args[0] === 'rev-parse' && args[1] === 'HEAD') process.stdout.write('a'.repeat(40) + '\\n');
// HEAD moves after the commit lookup; only the captured commit identifies its tree.
else if (args[0] === 'rev-parse' && args[1] === 'HEAD^{tree}') process.stdout.write('d'.repeat(40) + '\\n');
else if (args[0] === 'rev-parse' && args[1] === 'a'.repeat(40) + '^{tree}') process.stdout.write('b'.repeat(40) + '\\n');
else process.exit(12);
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
    const metadata = JSON.parse(await readFile(`${output}.json`, "utf8"));
    assert.equal(metadata.imageId, id);
    assert.equal(metadata.revision, "a".repeat(40));
    assert.equal(metadata.tree, "b".repeat(40));
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
