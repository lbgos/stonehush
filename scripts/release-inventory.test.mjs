import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { collectInventory, createSpdx, hashFile, readBounded, sha256, validateSpdx, verifyInputs, verifyPacket, walkFiles, writePacket } from "./release-inventory.mjs";

const id = (key) => `SPDXRef-${sha256(key)}`;
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-inventory-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifact = path.join(root, "artifact");
  const archive = path.join(root, "native-runner.tar.gz");
  const output = path.join(root, "packet");
  for (const name of ["supply-chain/notices", "apps/runner", "apps/runner/node_modules/.runtime/1"]) await mkdir(path.join(artifact, name), { recursive: true });
  await writeFile(path.join(artifact, "node"), "synthetic Node binary");
  const definitions = [
    { location: "apps/runner", manifest: { name: "fixture", version: "1.0.0", license: "MIT", dependencies: { fixture: "2.0.0" } } },
    { location: "apps/runner/node_modules/.runtime/1", manifest: { name: "fixture", version: "2.0.0", license: "MIT" } },
  ];
  const notice = "Synthetic copyright. Synthetic license terms.\n";
  const noticeHash = sha256(notice);
  await writeFile(path.join(artifact, `supply-chain/notices/${noticeHash}.txt`), notice);
  const notices = [{ path: `notices/${noticeHash}.txt`, sha256: noticeHash, evidence: "LICENSE" }];
  const components = [];
  for (const { location, manifest } of definitions) {
    await writeFile(path.join(artifact, location, "package.json"), json(manifest));
    components.push({ id: id(`packaged-runtime:${location}`), kind: "npm", name: manifest.name, version: manifest.version, location, scope: "packaged-runtime", declaredLicense: manifest.license, manifestSha256: sha256(json(manifest)), notices, unresolved: [] });
  }
  await symlink(".runtime/1", path.join(artifact, "apps/runner/node_modules/fixture"));
  const runtime = definitions.map(({ location }) => ({ source: location, packaged: location }));
  await writeFile(path.join(artifact, "package-graph.json"), json(runtime));
  const input = { format: "stonehush-inventory-input-v1", kind: "native-runner", runtime, components, frontendManifests: {}, relationships: [{ from: components[0].id, type: "DEPENDS_ON", to: components[1].id }], node: "v24.18.0", pnpm: "10.24.0", lockfileSha256: "f".repeat(64), nativeFiles: [{ path: "node", sha256: sha256("synthetic Node binary") }], assets: [], buildOnly: [], coverageGaps: ["Synthetic fixture"], externalPrerequisites: ["Nmap", "ffuf", "wordlists"] };
  const system = { kind: "native-runner", node: "v24.18.0", baseImage: null, debian: null, components: [{ id: id("runtime-node"), kind: "runtime", scope: "bundled-runtime", name: "Node.js", version: "v24.18.0", binarySha256: sha256("synthetic Node binary"), declaredLicense: null, notices, unresolved: ["missing-declared-license", "Node upstream LICENSE includes bundled third-party terms; review required"] }], coverageGaps: ["Synthetic system fixture"] };
  const metadata = { lockfileSha256: "f".repeat(64), revision: "a".repeat(40), tree: "b".repeat(40), sha256: sha256("synthetic archive") };
  await writeFile(path.join(artifact, "artifact.json"), json({ kind: "native-runner", revision: metadata.revision, tree: metadata.tree }));
  await writeFile(archive, "synthetic archive");
  const host = { revision: metadata.revision, tree: metadata.tree, host: { workflow: { runId: "123", runAttempt: "1" }, observed: "synthetic" } };
  const save = async () => {
    await writeFile(path.join(artifact, "supply-chain/components.json"), json(input));
    await writeFile(path.join(artifact, "supply-chain/system.json"), json(system));
    const links = [];
    const inventory = [];
    for (const name of (await walkFiles(artifact, true, links)).filter((name) => name !== "artifact.json")) {
      const bytes = await readFile(path.join(artifact, name));
      inventory.push(input.kind === "native-runner" ? { path: name, sha256: sha256(bytes), executable: false } : { path: name, sha256: sha256(bytes), sizeBytes: bytes.length });
    }
    if (input.kind === "native-runner") inventory.push(...links);
    await writeFile(path.join(artifact, "artifact.json"), json({ kind: input.kind, revision: metadata.revision, tree: metadata.tree, inventory }));
  };
  await save();
  const packet = () => writePacket(artifact, archive, metadata, host, output);
  const verify = () => verifyPacket(output, artifact, archive, metadata, host);
  return { root, artifact, archive, output, input, system, metadata, host, save, packet, verify };
}

test("packet binds actual bytes, versions, dependency relationships and notices without clearance", async (t) => {
  const f = await fixture(t);
  await f.packet();
  const result = await f.verify();
  assert.equal(result.redistribution, "NOT CLEARED");
  assert.equal(result.componentCount, 3);
  const document = JSON.parse(await readFile(path.join(f.output, "sbom.spdx.json")));
  assert.deepEqual(document.packages.filter((item) => item.name === "fixture").map((item) => item.versionInfo), ["1.0.0", "2.0.0"]);
  assert.ok(document.relationships.some((item) => item.relationshipType === "DEPENDS_ON"));
  assert.ok(document.packages.every((item) => item.licenseConcluded === "NOASSERTION"));
  assert.equal(document.packages.find((item) => item.name === "fixture").licenseDeclared, "MIT");
  const sums = await readFile(path.join(f.output, "SHA256SUMS"), "utf8");
  assert.ok(sums.includes(`${await hashFile(f.archive)}  @artifact/native-runner.tar.gz`));
  assert.ok(!sums.includes("  SHA256SUMS"));
  await assert.rejects(f.packet(), { code: "EEXIST" });
  assert.deepEqual(await f.verify(), result);
});

test("unknown and custom terms remain visible and uncleared", async (t) => {
  const f = await fixture(t);
  f.system.components[0].declaredLicense = "SEE LICENSE IN custom.txt";
  f.system.components[0].notices = [];
  f.system.components[0].unresolved = ["custom-or-ambiguous-declaration", "custom-or-unlicensed-declaration", "missing-upstream-notice-text", "Node upstream LICENSE includes bundled third-party terms; review required"];
  await f.save();
  await f.packet();
  const report = JSON.parse(await readFile(path.join(f.output, "inventory.json")));
  assert.equal(report.redistribution, "NOT CLEARED");
  assert.ok(report.unresolved.some((item) => item.issues.includes("missing-upstream-notice-text")));
  const document = JSON.parse(await readFile(path.join(f.output, "sbom.spdx.json")));
  assert.equal(document.packages.find((item) => item.name === "Node.js").licenseDeclared, "NOASSERTION");
  assert.match(document.packages.find((item) => item.name === "Node.js").sourceInfo, /SEE LICENSE IN custom.txt/);
});

test("omitted runtime components, edges, source and archive mismatches fail", async (t) => {
  const f = await fixture(t);
  const original = structuredClone(f.input);
  f.input.components.pop(); await f.save();
  await assert.rejects(f.packet(), /Runtime component omission/);
  Object.assign(f.input, structuredClone(original)); f.input.relationships = []; await f.save();
  await assert.rejects(f.packet());
  Object.assign(f.input, original); await f.save();
  f.metadata.tree = "c".repeat(40);
  await assert.rejects(f.packet(), /Artifact\/source mismatch/);
  f.metadata.tree = f.host.tree;
  await writeFile(f.archive, "mutated archive");
  await assert.rejects(f.packet(), /Archive checksum mismatch/);
  await assert.rejects(readFile(f.output), { code: "ENOENT" });
});

test("duplicate identities, conflicting declarations and dangling or duplicate relationships fail", async (t) => {
  const f = await fixture(t);
  f.input.components.push(f.input.components[0]);
  assert.throws(() => createSpdx(f.input, f.system, f.metadata, new Date().toISOString()), /Duplicate or conflicting/);
  f.input.components.pop();
  f.input.components[1].version = "1.0.0";
  f.input.components[1].declaredLicense = "ISC";
  assert.throws(() => createSpdx(f.input, f.system, f.metadata, new Date().toISOString()), /Conflicting duplicate/);
  f.input.components[1].version = "2.0.0";
  const document = createSpdx(f.input, f.system, f.metadata, new Date().toISOString());
  document.relationships.push({ spdxElementId: "SPDXRef-missing", relatedSpdxElement: "SPDXRef-artifact", relationshipType: "DEPENDS_ON" });
  assert.throws(() => validateSpdx(document), /Dangling/);
  document.relationships.pop(); document.relationships.push(document.relationships[0]);
  assert.throws(() => validateSpdx(document), /Duplicate SPDX relationship/);
});

test("packet refuses checksum mutation, omitted or unexpected members and symlink outputs", async (t) => {
  const f = await fixture(t);
  await f.packet();
  const report = await readFile(path.join(f.output, "inventory.json"));
  await writeFile(path.join(f.output, "inventory.json"), "mutated");
  await assert.rejects(f.verify(), /checksum mismatch/);
  await writeFile(path.join(f.output, "inventory.json"), report);
  await writeFile(path.join(f.output, "unexpected"), "private sentinel");
  await assert.rejects(f.verify(), /Missing or unexpected/);
  await rm(path.join(f.output, "unexpected"));
  await rm(path.join(f.output, "system.json"));
  await assert.rejects(f.verify(), /Missing or unexpected/);
  const other = path.join(f.root, "linked-packet");
  await symlink(f.output, other);
  await assert.rejects(writePacket(f.artifact, f.archive, f.metadata, f.host, other), { code: "EEXIST" });
});

test("unsafe metadata, escaping links, hardlinks, special files and oversized reads fail", async (t) => {
  const f = await fixture(t);
  await symlink(f.archive, path.join(f.artifact, "escape"));
  await assert.rejects(f.packet(), /Absolute inventory link/);
  await rm(path.join(f.artifact, "escape"));
  await link(f.archive, path.join(f.artifact, "hardlink"));
  await assert.rejects(walkFiles(f.artifact, true), /hardlink/);
  await rm(path.join(f.artifact, "hardlink"));
  await assert.rejects(readBounded(f.archive, 2), /oversized/);
  const fifo = path.join(f.artifact, "fifo");
  const made = spawnSync("mkfifo", [fifo]); assert.equal(made.status, 0);
  await assert.rejects(walkFiles(f.artifact, true), /special file/);
  await assert.rejects(readBounded(fifo), /Unsafe/);
  await rm(fifo);
  f.input.nativeFiles[0].path = "../escape"; await f.save();
  await assert.rejects(verifyInputs(f.artifact), /Unsafe inventory path/);
});

test("frontend closure and emitted assets are compared independently to manifest evidence", async (t) => {
  const f = await fixture(t);
  f.input.kind = "control-plane";
  f.system.kind = "control-plane";
  f.system.baseImage = "node:24.18.0-bookworm-slim@sha256:d45d78e7929b46875bbd4e29bea672d5bc48186c6c3588306521c815e78352d6";
  f.system.debian = [];
  await mkdir(path.join(f.artifact, "web"));
  await writeFile(path.join(f.artifact, "web/index.html"), "synthetic web");
  f.input.assets = [{ path: "web/index.html", sha256: sha256("synthetic web") }];
  f.input.components.push({ id: id("frontend-conservative-production-closure:apps/web"), kind: "npm", name: "web", version: "1", scope: "frontend-conservative-production-closure", location: "apps/web", declaredLicense: "MIT", notices: f.input.components[0].notices, unresolved: [] });
  f.input.frontendManifests["apps/web"] = { manifest: { name: "web", version: "1", dependencies: { omitted: "1" } }, resolved: {} };
  await f.save(); await assert.rejects(verifyInputs(f.artifact), /Frontend dependency omission/);
  delete f.input.frontendManifests["apps/web"].manifest.dependencies;
  await f.save(); await verifyInputs(f.artifact);
  await writeFile(path.join(f.artifact, "web/omitted.woff2"), "font");
  await f.save();
  await assert.rejects(verifyInputs(f.artifact), /Emitted asset omission/);
  await rm(path.join(f.artifact, "web/omitted.woff2"));
  f.system.debian = [["omitted", "1"]]; await f.save();
  await assert.rejects(verifyInputs(f.artifact), /Debian component omission/);
});

test("collector reads installed graph and font/icon notices without invoking metadata scripts", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-inventory-collect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const artifact = path.join(root, "artifact");
  const workspaces = ["apps/api", "apps/runner", "apps/web", "packages/contracts", "packages/domain", "packages/db", "packages/evidence-native", "packages/ui"];
  for (const name of workspaces) {
    await mkdir(path.join(source, name), { recursive: true });
    await writeFile(path.join(source, name, "package.json"), json({ name, version: "1" }));
  }
  for (const name of ["api", "web", "api/node_modules/.runtime/font", "api/node_modules/.runtime/icon"]) await mkdir(path.join(artifact, name), { recursive: true });
  await writeFile(path.join(source, "package.json"), json({ name: "root", version: "1" }));
  await writeFile(path.join(source, "LICENSE"), "Synthetic root terms");
  await writeFile(path.join(source, "pnpm-lock.yaml"), "synthetic frozen lock");
  await mkdir(path.join(source, "packaging"));
  await writeFile(path.join(source, "packaging/third-party-assets.json"), json({ assets: [] }));
  const rootManifest = { name: "@stonehush/api", version: "1", license: "AGPL-3.0-only", dependencies: { font: "1", icon: "2" } };
  await writeFile(path.join(artifact, "api/package.json"), json(rootManifest));
  const graph = [{ source: "apps/api", packaged: "api" }];
  for (const [name, version, license] of [["font", "1", "OFL-1.1"], ["icon", "2", "ISC"]]) {
    const directory = path.join(artifact, "api/node_modules/.runtime", name);
    await writeFile(path.join(directory, "package.json"), json({ name, version, license, scripts: { install: "exit 99" } }));
    await writeFile(path.join(directory, "LICENSE"), `${name} upstream copyright and terms`);
    await symlink(`.runtime/${name}`, path.join(artifact, "api/node_modules", name));
    graph.push({ source: `node_modules/${name}`, packaged: `api/node_modules/.runtime/${name}` });
  }
  await writeFile(path.join(artifact, "package-graph.json"), json(graph));
  await writeFile(path.join(artifact, "web/index.html"), "Synthetic emitted asset");
  await collectInventory(source, artifact, "control-plane");
  const inputs = JSON.parse(await readFile(path.join(artifact, "supply-chain/components.json")));
  assert.equal(inputs.components.filter((item) => item.scope === "packaged-runtime").length, 3);
  assert.equal(inputs.components.filter((item) => item.scope === "frontend-conservative-production-closure").length, 1);
  assert.equal(inputs.relationships.length, 2);
  for (const name of ["font", "icon"]) {
    const component = inputs.components.find((item) => item.name === name);
    assert.equal(await readFile(path.join(artifact, "supply-chain", component.notices[0].path), "utf8"), `${name} upstream copyright and terms`);
  }
  assert.equal(inputs.lockfileSha256, sha256("synthetic frozen lock"));
  assert.ok(inputs.externalPrerequisites.includes("wordlists"));
});
