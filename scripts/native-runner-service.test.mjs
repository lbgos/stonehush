import assert from "node:assert/strict";
import { chmod, copyFile, link, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkDirectory, install, inventory, locations, privateFile, serviceUnit, verifyArtifact } from "./native-runner-service.mjs";

async function fixture(callback) {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-service-boundary-"));
  const home = path.join(root, "home");
  const artifact = path.join(root, "artifact");
  const paths = locations(home);
  try {
    await mkdir(home, { mode: 0o700 });
    for (const directory of ["apps/runner/dist", "scripts"]) await mkdir(path.join(artifact, directory), { recursive: true });
    for (const name of ["node", "apps/runner/dist/runner.js", "scripts/native-runner-service.mjs", "scripts/runner-enrollment.mjs"]) await writeFile(path.join(artifact, name), "synthetic runtime\n");
    const manifest = { kind: "native-runner", revision: "a".repeat(40), tree: "b".repeat(40), node: "v24.18.0", pnpm: "10.24.0", inventory: await inventory(artifact) };
    await writeFile(path.join(artifact, "artifact.json"), JSON.stringify(manifest));
    const config = { apiBaseUrl: "http://127.0.0.1:18789", nmapExecutable: "/usr/bin/nmap", runnerName: "Synthetic runner" };
    await callback({ root, artifact, paths, config, manifest });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("install is artifact-only, private and repeatable without replacing credentials or state", async () => fixture(async ({ artifact, paths, config }) => {
  await install(artifact, paths, config);
  for (const directory of [paths.runtime, paths.private, paths.state, path.join(paths.state, "work")]) assert.equal((await stat(directory)).mode & 0o777, 0o700);
  for (const file of [paths.unit, path.join(paths.private, "config.json")]) assert.equal((await stat(file)).mode & 0o777, 0o600);
  const credential = path.join(paths.private, "credential.json");
  await privateFile(credential, { value: "synthetic private identity\n" });
  await writeFile(path.join(paths.state, "retained"), "synthetic outbox\n");
  const before = await readFile(path.join(paths.private, "config.json"), "utf8");
  await install(artifact, paths, config);
  assert.equal(await privateFile(credential), "synthetic private identity\n");
  assert.equal(await readFile(path.join(paths.state, "retained"), "utf8"), "synthetic outbox\n");
  assert.equal(await readFile(path.join(paths.private, "config.json"), "utf8"), before);
  assert.equal(await readFile(paths.unit, "utf8"), serviceUnit);
  await rm(artifact, { recursive: true });
  assert.equal((await verifyArtifact(paths.runtime)).revision, "a".repeat(40));
}));

test("conflicting config, runtime and service unit are never clobbered", async () => fixture(async ({ artifact, paths, config }) => {
  await install(artifact, paths, config);
  await assert.rejects(install(artifact, paths, { ...config, apiBaseUrl: "http://127.0.0.1:18790" }), /differs/);
  await writeFile(paths.unit, "operator-owned unit\n");
  await assert.rejects(install(artifact, paths, config), /unit differs/);
  assert.equal(await readFile(paths.unit, "utf8"), "operator-owned unit\n");
  await writeFile(path.join(paths.runtime, "node"), "altered runtime\n");
  await assert.rejects(install(artifact, paths, config), /content differs/);
  assert.equal(await readFile(path.join(paths.runtime, "node"), "utf8"), "altered runtime\n");
}));

test("existing unknown unit and non-loopback configuration fail before runtime installation", async () => fixture(async ({ artifact, paths, config }) => {
  await assert.rejects(install(artifact, paths, { ...config, apiBaseUrl: "http://192.0.2.1:18789" }), /loopback/);
  await assert.rejects(stat(paths.runtime), { code: "ENOENT" });
  await mkdir(path.dirname(paths.unit), { recursive: true });
  await writeFile(paths.unit, "operator unit\n");
  await assert.rejects(install(artifact, paths, config), /Existing service unit/);
  assert.equal(await readFile(paths.unit, "utf8"), "operator unit\n");
  await assert.rejects(stat(paths.runtime), { code: "ENOENT" });
}));

test("credential creation and reads refuse overwrite, symlinks, hardlinks and exposed modes", async () => fixture(async ({ paths, root }) => {
  await mkdir(paths.private, { recursive: true, mode: 0o700 });
  const credential = path.join(paths.private, "credential.json");
  const original = path.join(root, "original");
  await writeFile(original, "synthetic private value", { mode: 0o600 });
  await symlink(original, credential);
  await assert.rejects(privateFile(credential));
  await assert.rejects(privateFile(credential, { value: "replacement" }));
  await unlink(credential);
  await link(original, credential);
  await assert.rejects(privateFile(credential), /links refused/);
  await unlink(credential);
  await copyFile(original, credential);
  await chmod(credential, 0o644);
  await assert.rejects(privateFile(credential), /mode or links/);
  assert.equal(await readFile(original, "utf8"), "synthetic private value");
  await chmod(credential, 0o600);
  await assert.rejects(privateFile(credential, { value: "replacement" }), { code: "EEXIST" });
  assert.equal(await privateFile(credential), "synthetic private value");
}));

test("directory links, permissive private directories and source escapes are refused without repair", async () => fixture(async ({ root, artifact, paths }) => {
  await chmod(paths.home, 0o755);
  await assert.rejects(checkDirectory(paths.home, { privateMode: true }), /0700/);
  assert.equal((await stat(paths.home)).mode & 0o777, 0o755);
  const linked = path.join(root, "linked");
  await symlink(paths.home, linked);
  await assert.rejects(checkDirectory(linked), /type/);
  await symlink(paths.home, path.join(artifact, "external"));
  await assert.rejects(verifyArtifact(artifact), /escapes/);
}));
