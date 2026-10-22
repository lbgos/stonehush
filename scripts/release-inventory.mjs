import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readlink, readdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { arch, platform, release } from "node:os";

const MAX_METADATA = 16 * 1024 * 1024;
const MAX_FILES = 100000;
const MAX_NOTICES = 128 * 1024 * 1024;
const BASE = "node:24.18.0-bookworm-slim@sha256:d45d78e7929b46875bbd4e29bea672d5bc48186c6c3588306521c815e78352d6";
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const id = (key) => `SPDXRef-${sha256(key)}`;
const sorted = (values) => [...values].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en"));
function safeName(name) {
  if (typeof name !== "string" || name.length > 1024 || /[\x00-\x1f\x7f\\]/.test(name) || path.isAbsolute(name) || name.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Unsafe inventory path.");
  return name;
}
function inside(root, filename) {
  if (!filename.startsWith(`${root}${path.sep}`)) throw new Error("Inventory path escapes root.");
  return filename;
}
// No-follow open plus fstat bounds every metadata read. Only installed pnpm
// source inputs allow store hardlinks; artifact and packet files never do. Streaming hashes also
// cover large archives without loading their bytes into the model or heap.
export async function freshOutputs(filenames) {
  for (const filename of filenames) {
    await rejectLinkedAncestors(path.dirname(filename));
    try { await lstat(filename); throw new Error("Artifact output already exists."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

export async function readBounded(filename, maximum = MAX_METADATA, installedInput = false) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (!installedInput && info.nlink !== 1) || info.size > maximum) throw new Error("Unsafe or oversized inventory file.");
    const bytes = await handle.readFile();
    if (bytes.length !== info.size || bytes.length > maximum) throw new Error("Inventory file changed during read.");
    return bytes;
  } finally { await handle.close(); }
}
export async function hashFile(filename) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 16 * 1024 ** 3) throw new Error("Unsafe artifact file.");
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("Artifact changed during hash.");
    return hash.digest("hex");
  } finally { await handle.close(); }
}
async function readJson(filename) { return JSON.parse(await readBounded(filename)); }
async function put(root, name, bytes) {
  safeName(name);
  await rejectLinkedAncestors(root);
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await rejectLinkedAncestors(path.dirname(path.join(root, name)));
  await writeFile(path.join(root, name), bytes, { flag: "wx", mode: 0o644 });
}
async function rejectLinkedAncestors(directory) {
  let current = path.resolve(directory);
  while (current !== path.dirname(current)) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error("Linked inventory ancestor refused.");
    current = path.dirname(current);
  }
}
async function rootDirectory(directory) {
  await rejectLinkedAncestors(directory);
  if (!(await lstat(directory)).isDirectory()) throw new Error("Inventory root must be a real directory.");
  return realpath(directory);
}
export async function walkFiles(directory, links = false, linkRecords = []) {
  const root = await rootDirectory(directory);
  const files = [];
  let count = 0;
  async function walk(relative = "") {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      if (++count > MAX_FILES) throw new Error("Inventory file count exceeds limit.");
      const name = safeName(relative ? `${relative}/${entry.name}` : entry.name);
      const filename = path.join(root, name);
      const info = await lstat(filename);
      if (info.isDirectory()) await walk(name);
      else if (info.isSymbolicLink() && links) {
        const target = await readlink(filename);
        if (path.isAbsolute(target)) throw new Error("Absolute inventory link refused.");
        await resolveInside(root, filename);
        linkRecords.push({ path: name, link: target });
      } else if (info.isFile() && info.nlink === 1) files.push(name);
      else throw new Error("Inventory link, hardlink or special file refused.");
    }
  }
  await walk();
  return files.sort();
}
async function resolveInside(root, filename, depth = 0) {
  if (depth > 40) throw new Error("Inventory link depth exceeds limit.");
  inside(root, path.resolve(filename));
  const parts = path.relative(root, filename).split(path.sep);
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    if ((await lstat(current)).isSymbolicLink()) {
      const target = await readlink(current);
      if (path.isAbsolute(target)) throw new Error("Absolute inventory link refused.");
      const resolved = inside(root, path.resolve(path.dirname(current), target, ...parts.slice(index + 1)));
      return resolveInside(root, resolved, depth + 1);
    }
  }
  return current;
}
async function resolveDependency(directory, name, root) {
  if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name)) throw new Error("Unsafe dependency name.");
  for (const search of createRequire(path.join(directory, "package.json")).resolve.paths(`${name}/package.json`) ?? []) {
    const candidate = path.join(search, name);
    if (!candidate.startsWith(`${root}${path.sep}`)) continue;
    try { return await resolveInside(root, candidate); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
const dependencies = (manifest) => [...new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})])].sort();
const optional = (manifest, name) => name in (manifest.optionalDependencies ?? {}) || manifest.peerDependenciesMeta?.[name]?.optional === true;
async function manifestAt(directory, installedInput = false) {
  const bytes = await readBounded(path.join(directory, "package.json"), MAX_METADATA, installedInput);
  const manifest = JSON.parse(bytes);
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") throw new Error("Package identity missing.");
  return { manifest, manifestSha256: sha256(bytes) };
}
async function noticeCollector(output) {
  const notices = new Map();
  let total = 0;
  return async (filename, evidence, installedInput = false) => {
    const bytes = await readBounded(filename, 4 * 1024 * 1024, installedInput);
    const digest = sha256(bytes);
    if (!notices.has(digest)) {
      total += bytes.length;
      if (total > MAX_NOTICES) throw new Error("Notice bytes exceed limit.");
      try { await put(output, `notices/${digest}.txt`, bytes); }
      catch (error) { if (error.code !== "EEXIST") throw error; assert.equal(await hashFile(path.join(output, `notices/${digest}.txt`)), digest); }
      notices.set(digest, true);
    }
    return { evidence, path: `notices/${digest}.txt`, sha256: digest };
  };
}
async function packageNotices(directory, sourceRoot, collect, installedInput = false) {
  const notices = [];
  let count = 0;
  async function walk(relative = "") {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      if (++count > MAX_FILES) throw new Error("Package notice traversal exceeds limit.");
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const name = safeName(relative ? `${relative}/${entry.name}` : entry.name);
      const filename = path.join(directory, name);
      const info = await lstat(filename);
      if (info.isSymbolicLink()) {
        const resolved = await resolveInside(directory, filename);
        if (/^(?:licen[cs]e|copying|copyright|notice|ofl|authors)(?:[._-].*)?$/i.test(entry.name)) notices.push(await collect(resolved, path.relative(sourceRoot, filename), installedInput));
        continue;
      }
      if (!info.isDirectory() && (!info.isFile() || (!installedInput && info.nlink !== 1))) throw new Error("Unsafe package notice input.");
      if (info.isDirectory()) await walk(name);
      else if (/^(?:licen[cs]e|copying|copyright|notice|ofl|authors)(?:[._-].*)?$/i.test(entry.name)) notices.push(await collect(filename, path.relative(sourceRoot, filename), installedInput));
    }
  }
  await walk();
  return sorted(notices);
}
function licenseDeclaration(value) {
  return typeof value === "string" ? value : value?.type ?? null;
}
const LICENSE_IDS = new Set(["MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "AGPL-3.0-only", "OFL-1.1", "CC0-1.0", "CC-BY-4.0", "Unlicense", "Zlib", "BlueOak-1.0.0", "Python-2.0", "MPL-2.0", "Artistic-2.0"]);
function declaredExpression(value) {
  if (typeof value !== "string" || value.length > 1024) return "NOASSERTION";
  const tokens = value.match(/[A-Za-z0-9.+-]+|[()]/g) ?? [];
  if (tokens.join("") !== value.replace(/\s/g, "")) return "NOASSERTION";
  let index = 0;
  function expression(depth = 0) {
    if (depth > 16) return false;
    function atom() {
      const token = tokens[index++];
      if (token !== "(") return LICENSE_IDS.has(token);
      if (!expression(depth + 1) || tokens[index++] !== ")") return false;
      return true;
    }
    if (!atom()) return false;
    while (tokens[index] === "AND" || tokens[index] === "OR") { index++; if (!atom()) return false; }
    return true;
  }
  return expression() && index === tokens.length ? value : "NOASSERTION";
}
function issues(component) {
  const result = [];
  if (!component.declaredLicense) result.push("missing-declared-license");
  // This is a recording rule, never a compatibility or rights decision. Even
  // familiar declarations retain NOASSERTION as their license conclusion.
  if (component.declaredLicense && declaredExpression(component.declaredLicense) === "NOASSERTION") result.push("custom-or-ambiguous-declaration");
  if (/SEE LICENSE|LicenseRef|UNLICENSED/i.test(component.declaredLicense ?? "")) result.push("custom-or-unlicensed-declaration");
  if (!component.notices.length) result.push("missing-upstream-notice-text");
  if ((component.missingOptional ?? []).some((entry) => typeof entry === "object" && !entry.optional)) result.push("unresolved-bundled-tool-runtime-dependency");
  if (component.kind === "asset") result.push("asset-rights-not-cleared");
  if (component.kind === "deb") result.push("debian-copyright-needs-license-review");
  return result;
}

// Assembly supplies actual package locations. Frontend entries are the installed
// production closure, conservatively recorded, not a claim about tree shaking.
export async function collectInventory(sourceDirectory, artifactDirectory, kind) {
  const source = await rootDirectory(sourceDirectory);
  const artifact = await rootDirectory(artifactDirectory);
  if (!["control-plane", "native-runner"].includes(kind)) throw new Error("Unknown inventory kind.");
  const output = path.join(artifact, "supply-chain");
  await mkdir(output);
  const collect = await noticeCollector(output);
  const components = [];
  const relationships = [];
  const frontendManifests = {};
  const runtime = await readJson(path.join(artifact, "package-graph.json"));
  const byDirectory = new Map();
  const rootNotice = await collect(path.join(source, "LICENSE"), "LICENSE");
  async function addPackage(directory, scope, location) {
    const key = `${scope}:${location}`;
    const previous = byDirectory.get(key);
    if (previous) return previous;
    const installedInput = scope !== "packaged-runtime";
    const { manifest, manifestSha256 } = await manifestAt(directory, installedInput);
    const component = { id: id(key), kind: "npm", name: manifest.name, version: manifest.version, scope, location, manifestSha256,
      declaredLicense: licenseDeclaration(manifest.license), notices: await packageNotices(directory, scope === "packaged-runtime" ? artifact : source, collect, installedInput), missingOptional: [] };
    if (manifest.name.startsWith("@stonehush/")) component.notices.push(rootNotice);
    component.unresolved = issues(component);
    components.push(component);
    byDirectory.set(key, component);
    return component;
  }
  const runtimeByPath = new Map();
  for (const record of runtime) {
    safeName(record.packaged); safeName(record.source);
    const directory = await resolveInside(artifact, path.join(artifact, record.packaged));
    if (runtimeByPath.has(directory)) throw new Error("Duplicate packaged component location.");
    runtimeByPath.set(directory, await addPackage(directory, "packaged-runtime", record.packaged));
  }
  for (const [directory, component] of runtimeByPath) {
    const { manifest } = await manifestAt(directory);
    for (const name of dependencies(manifest)) {
      const target = await resolveDependency(directory, name, artifact);
      if (!target && optional(manifest, name)) { component.missingOptional.push(name); continue; }
      const dependency = runtimeByPath.get(target);
      if (!dependency) throw new Error("Runtime graph omits installed dependency.");
      relationships.push({ from: component.id, type: "DEPENDS_ON", to: dependency.id });
    }
  }
  async function closure(directory, scope) {
    const location = safeName(path.relative(source, directory));
    const existing = byDirectory.get(`${scope}:${location}`);
    if (existing) return existing;
    const component = await addPackage(directory, scope, location);
    const { manifest } = await manifestAt(directory, true);
    frontendManifests[location] = { manifest, resolved: {} };
    for (const name of dependencies(manifest)) {
      const resolved = await resolveDependency(directory, name, source);
      if (!resolved && optional(manifest, name)) { component.missingOptional.push(name); continue; }
      if (!resolved) throw new Error(`Missing installed inventory dependency: ${name}`);
      frontendManifests[location].resolved[name] = path.relative(source, resolved);
      relationships.push({ from: component.id, type: "DEPENDS_ON", to: (await closure(resolved, scope)).id });
    }
    return component;
  }
  if (kind === "control-plane") await closure(path.join(source, "apps/web"), "frontend-conservative-production-closure");
  const buildOnly = [];
  // Record installed dev roots separately. Their transitive closure is not
  // described as shipped and is outside the artifact SBOM component set.
  for (const relative of ["", "apps/api", "apps/runner", "apps/web", "packages/contracts", "packages/domain", "packages/db", "packages/evidence-native", "packages/ui"]) {
    const directory = path.join(source, relative);
    const manifest = await readJson(path.join(directory, "package.json"));
    for (const name of Object.keys(manifest.devDependencies ?? {}).sort()) {
      const resolved = await resolveDependency(directory, name, source);
      if (!resolved) throw new Error(`Missing build-only dependency: ${name}`);
      const { manifest: installed, manifestSha256 } = await manifestAt(resolved, true);
      buildOnly.push({ importer: relative || ".", name: installed.name, version: installed.version, manifestSha256, scope: "build-only-direct-root" });
    }
  }
  const assets = [];
  if (kind === "control-plane") {
    for (const name of await walkFiles(path.join(artifact, "web"))) assets.push({ path: `web/${name}`, sha256: await hashFile(path.join(artifact, "web", name)) });
    const attribution = await readJson(path.join(source, "packaging/third-party-assets.json"));
    for (const asset of attribution.assets) {
      safeName(asset.path);
      const bytes = await readBounded(path.join(source, asset.path));
      assert.equal(sha256(bytes), asset.sha256, "Asset source hash mismatch.");
      const emitted = `web/brand/${path.basename(asset.path)}`;
      assert.equal(assets.find((item) => item.path === emitted)?.sha256, asset.sha256, "Emitted brand asset mismatch.");
      const component = { id: id(asset.path), kind: "asset", scope: "emitted-brand-asset", location: emitted, name: path.basename(asset.path), version: asset.sha256, declaredLicense: null, notices: [], provenance: asset.provenance, obligations: asset.obligations };
      component.unresolved = issues(component);
      components.push(component);
    }
  }
  const nativeFiles = [];
  for (const name of await walkFiles(artifact, true)) {
    if (name.startsWith("supply-chain/")) continue;
    const info = await lstat(path.join(artifact, name));
    if (name.endsWith(".node") || name === "node" || info.mode & 0o111) nativeFiles.push({ path: name, sha256: await hashFile(path.join(artifact, name)) });
  }
  const inputs = { format: "stonehush-inventory-input-v1", kind, lockfileSha256: await hashFile(path.join(source, "pnpm-lock.yaml")), node: process.version, pnpm: "10.24.0", runtime, components: sorted(components), frontendManifests, relationships: sorted(relationships), buildOnly: sorted(buildOnly), assets, nativeFiles, externalPrerequisites: ["Nmap", "ffuf", "wordlists", "Linux kernel", "host libc/shared libraries", "systemd user services for native installation"], coverageGaps: ["Frontend closure is conservative; exact bundled symbol ownership is not inferred.", "Build-only entries cover direct installed dev roots, not the entire build toolchain.", "Runtime-linked host libraries for the native archive are operator prerequisites, not bundled components."] };
  await put(output, "components.json", json(inputs));
}

async function discoverToolRoots(prefix) {
  const modules = path.join(prefix || "/", "usr/local/lib/node_modules");
  const roots = [];
  for (const name of await readdir(modules)) {
    if (name.startsWith(".")) continue;
    if (name.startsWith("@")) {
      for (const child of await readdir(path.join(modules, name))) roots.push({ directory: path.join(modules, name, child), boundary: modules, canonical: "usr/local/lib/node_modules" });
    } else roots.push({ directory: path.join(modules, name), boundary: modules, canonical: "usr/local/lib/node_modules" });
  }
  const opt = path.join(prefix || "/", "opt");
  for (const name of await readdir(opt)) if (/^yarn-v[0-9.]+$/.test(name)) {
    const directory = path.join(opt, name);
    roots.push({ directory, boundary: directory, canonical: `opt/${name}` });
  }
  return roots;
}
export async function inspectToolPackages(roots) {
  const manifests = {};
  const relationships = [];
  async function visit(directory, boundary, canonical) {
    directory = directory === boundary ? boundary : await resolveInside(boundary, directory);
    const relative = path.relative(boundary, directory);
    const location = relative ? `${canonical}/${relative}` : canonical;
    safeName(location);
    if (manifests[location]) return;
    const { manifest, manifestSha256 } = await manifestAt(directory);
    const record = { manifest, manifestSha256, resolved: {}, missingOptional: [] };
    manifests[location] = record;
    for (const name of dependencies(manifest)) {
      const resolved = await resolveDependency(directory, name, boundary);
      if (!resolved) { record.missingOptional.push({ name, optional: optional(manifest, name) }); continue; }
      const target = `${canonical}/${path.relative(boundary, resolved)}`;
      record.resolved[name] = target;
      await visit(resolved, boundary, canonical);
      relationships.push({ from: id(`final-image-bundled-tool:${location}`), type: "DEPENDS_ON", to: id(`final-image-bundled-tool:${target}`) });
    }
    let entries;
    const modules = path.join(directory, "node_modules");
    try { entries = await readdir(modules); } catch (error) { if (error.code !== "ENOENT") throw error; return; }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      if (name.startsWith("@")) {
        for (const child of await readdir(path.join(modules, name))) await visit(path.join(modules, name, child), boundary, canonical);
      } else await visit(path.join(modules, name), boundary, canonical);
    }
  }
  for (const root of roots) await visit(root.directory, root.boundary, root.canonical);
  return { manifests, relationships: sorted(relationships) };
}

// Executed in the final image, using its dpkg database and copyright files.
// It never calls dependency scripts or installs additional tooling.
export function debianPackages(status) {
  return status.split(/\n\n+/).filter((paragraph) => /^Status: install ok installed$/m.test(paragraph)).map((paragraph) => {
    const field = (name) => paragraph.match(new RegExp(`^${name}: (.+)$`, "m"))?.[1];
    const name = field("Package"), version = field("Version"), architecture = field("Architecture");
    assert.ok(name && version && architecture, "Incomplete Debian package metadata.");
    return [`${name}${field("Multi-Arch") === "same" ? `:${architecture}` : ""}`, version];
  }).sort((a, b) => a[0].localeCompare(b[0], "en"));
}
export async function collectSystem(artifactDirectory, kind, executable = process.execPath) {
  const artifact = await rootDirectory(artifactDirectory);
  const output = path.join(artifact, "supply-chain");
  const collect = await noticeCollector(output);
  const components = [];
  const relationships = [];
  const bundledToolManifests = {};
  const commonNotices = [];
  const candidates = [path.resolve(path.dirname(executable), "../LICENSE"), path.resolve(path.dirname(executable), "../share/doc/node/LICENSE")];
  const notices = [];
  for (const candidate of candidates) {
    try { notices.push(await collect(candidate, "Node upstream distribution LICENSE")); break; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const node = { id: id("runtime-node"), kind: "runtime", scope: "bundled-runtime", name: "Node.js", version: process.version, declaredLicense: null, binarySha256: await hashFile(executable), notices };
  node.unresolved = [...issues(node), "Node upstream LICENSE includes bundled third-party terms; review required"];
  components.push(node);
  const nodeVersions = Object.fromEntries(Object.entries(process.versions).filter(([name]) => !["node", "modules", "napi"].includes(name)));
  for (const [name, version] of Object.entries(nodeVersions)) {
    const component = { id: id(`node-version:${name}`), kind: "node-version", scope: "bundled-node-version-entry", name: `Node process.versions.${name}`, version, declaredLicense: null, notices };
    component.unresolved = issues(component);
    components.push(component);
    relationships.push({ from: node.id, type: "CONTAINS", to: component.id });
  }
  let debian = null;
  let debianStatusSha256 = null;
  if (kind === "control-plane") {
    const roots = await discoverToolRoots("");
    const tools = await inspectToolPackages(roots);
    Object.assign(bundledToolManifests, tools.manifests);
    relationships.push(...tools.relationships);
    for (const [location, record] of Object.entries(tools.manifests)) {
      const component = { id: id(`final-image-bundled-tool:${location}`), kind: "npm", scope: "final-image-bundled-tool", location, name: record.manifest.name, version: record.manifest.version, manifestSha256: record.manifestSha256, declaredLicense: licenseDeclaration(record.manifest.license), notices: await packageNotices(`/${location}`, "/", collect), missingOptional: record.missingOptional };
      component.unresolved = issues(component);
      components.push(component);
    }
    debian = execFileSync("/usr/bin/dpkg-query", ["-W", "-f=${binary:Package}\t${Version}\t${db:Status-Status}\n"], { encoding: "utf8", maxBuffer: MAX_METADATA, timeout: 30000 }).trim().split("\n").filter((line) => line.endsWith("\tinstalled")).map((line) => line.split("\t").slice(0, 2));
    const status = await readBounded("/var/lib/dpkg/status");
    debianStatusSha256 = sha256(status);
    assert.deepEqual(sorted(debian), sorted(debianPackages(status.toString("utf8"))), "Final dpkg query differs from installed status.");
    for (const [name, version] of debian) {
      if (!/^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?$/.test(name)) throw new Error("Unsafe Debian package identity.");
      const notices = [];
      const copyright = `/usr/share/doc/${name.split(":")[0]}/copyright`;
      try {
        // Debian doc directories may be symlinked to another package's docs.
        const resolved = inside("/usr/share/doc", await realpath(copyright));
        notices.push(await collect(resolved, copyright));
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      const component = { id: id(`deb:${name}:${version}`), kind: "deb", scope: "final-image-installed-package", name, version, declaredLicense: null, notices };
      component.unresolved = issues(component);
      components.push(component);
    }
    for (const name of await readdir("/usr/share/common-licenses")) {
      const filename = path.join("/usr/share/common-licenses", name);
      const info = await lstat(filename);
      if (info.isFile()) commonNotices.push(await collect(filename, filename));
      else if (info.isSymbolicLink()) commonNotices.push(await collect(inside("/usr/share/common-licenses", await realpath(filename)), filename));
      else throw new Error("Unsafe Debian common-license input.");
    }
  }
  await put(output, "system.json", json({ kind, baseImage: kind === "control-plane" ? BASE : null, node: process.version, components: sorted(components), relationships: sorted(relationships), nodeVersions, bundledToolManifests, commonNotices, debianStatusSha256, debian, coverageGaps: ["Node bundled-library components and Debian multi-license paragraphs require human review; upstream full texts are retained where available."] }));
}

function checkIdentity(binding) {
  if (!/^[a-f0-9]{40}$/.test(binding.revision ?? "") || !/^[a-f0-9]{40}$/.test(binding.tree ?? "") || !/^[a-f0-9]{64}$/.test(binding.sha256 ?? "")) throw new Error("Invalid source/artifact binding.");
}
function allComponents(inputs, system) {
  const components = [...inputs.components, ...system.components];
  const seen = new Set();
  const declarations = new Map();
  for (const component of components) {
    if (seen.has(component.id)) throw new Error("Duplicate or conflicting component identity.");
    seen.add(component.id);
    const identity = `${component.kind}:${component.name}@${component.version}`;
    const declaration = JSON.stringify({ declaredLicense: component.declaredLicense, manifestSha256: component.manifestSha256 });
    if (declarations.has(identity) && declarations.get(identity) !== declaration) throw new Error("Conflicting duplicate package declaration.");
    declarations.set(identity, declaration);
    if (component.id !== id(component.kind === "runtime" ? "runtime-node" : component.kind === "node-version" ? `node-version:${component.name.slice("Node process.versions.".length)}` : component.kind === "deb" ? `deb:${component.name}:${component.version}` : component.kind === "asset" ? `apps/web/public/brand/${component.name}` : `${component.scope}:${component.location}`)) throw new Error("Component identity mismatch.");
  }
  return components;
}
export function createSpdx(inputs, system, binding, created) {
  checkIdentity(binding);
  const components = allComponents(inputs, system);
  const artifactId = "SPDXRef-artifact";
  const sourceId = "SPDXRef-source";
  const packages = [{ SPDXID: artifactId, name: inputs.kind, versionInfo: binding.revision, downloadLocation: "NOASSERTION", filesAnalyzed: false, checksums: [{ algorithm: "SHA256", checksumValue: binding.sha256 }], sourceInfo: json(binding), licenseConcluded: "NOASSERTION", licenseDeclared: "NOASSERTION", copyrightText: "NOASSERTION" },
    { SPDXID: sourceId, name: "Stonehush source", versionInfo: binding.revision, downloadLocation: `git+https://github.com/lbgos/stonehush.git@${binding.revision}`, filesAnalyzed: false, licenseConcluded: "NOASSERTION", licenseDeclared: "AGPL-3.0-only", copyrightText: "NOASSERTION", sourceInfo: `Git tree ${binding.tree}; pnpm-lock.yaml SHA256 ${inputs.lockfileSha256}` },
    ...components.map((component) => ({ SPDXID: component.id, name: component.name, versionInfo: component.version, downloadLocation: "NOASSERTION", filesAnalyzed: false, licenseConcluded: "NOASSERTION", licenseDeclared: declaredExpression(component.declaredLicense), copyrightText: "NOASSERTION", sourceInfo: json(component), comment: "Declared license is recorded verbatim in sourceInfo with evidence; no license expression or compatibility inferred." }))];
  // Unknown declarations stay NOASSERTION in the SPDX license field. Verbatim
  // declarations and their evidence are retained without inventing LicenseRefs.
  const relationships = [{ spdxElementId: "SPDXRef-DOCUMENT", relationshipType: "DESCRIBES", relatedSpdxElement: artifactId }, { spdxElementId: artifactId, relationshipType: "GENERATED_FROM", relatedSpdxElement: sourceId },
    ...components.map((component) => ({ spdxElementId: artifactId, relationshipType: "CONTAINS", relatedSpdxElement: component.id })),
    ...[...inputs.relationships, ...(system.relationships ?? [])].map((edge) => ({ spdxElementId: edge.from, relationshipType: edge.type, relatedSpdxElement: edge.to }))];
  const files = [...inputs.assets, ...inputs.nativeFiles].map((file) => ({ SPDXID: id(`file:${file.path}`), fileName: `./${file.path}`, checksums: [{ algorithm: "SHA256", checksumValue: file.sha256 }], licenseConcluded: "NOASSERTION", licenseInfoInFiles: ["NOASSERTION"], copyrightText: "NOASSERTION" }));
  for (const file of files) relationships.push({ spdxElementId: artifactId, relationshipType: "CONTAINS", relatedSpdxElement: file.SPDXID });
  const document = { spdxVersion: "SPDX-2.3", dataLicense: "CC0-1.0", SPDXID: "SPDXRef-DOCUMENT", name: `Stonehush ${inputs.kind} inventory`, documentNamespace: `https://stonehush.invalid/spdx/${inputs.kind}/${binding.sha256}`, creationInfo: { creators: ["Tool: stonehush-release-inventory"], created }, packages, files, relationships };
  validateSpdx(document);
  return document;
}
export function validateSpdx(document) {
  assert.equal(document.spdxVersion, "SPDX-2.3"); assert.equal(document.dataLicense, "CC0-1.0"); assert.equal(document.SPDXID, "SPDXRef-DOCUMENT");
  assert.ok(/^https:\/\//.test(document.documentNamespace)); assert.ok(document.name);
  assert.ok(!Number.isNaN(Date.parse(document.creationInfo.created))); assert.ok(document.creationInfo.creators.length);
  const elements = [document, ...document.packages, ...(document.files ?? [])];
  const ids = new Set(elements.map((entry) => entry.SPDXID));
  assert.equal(ids.size, elements.length, "Duplicate SPDX identity.");
  for (const item of document.packages) {
    for (const field of ["name", "versionInfo", "downloadLocation", "licenseConcluded", "licenseDeclared", "copyrightText"]) assert.ok(typeof item[field] === "string" && item[field].length, `Missing SPDX ${field}.`);
    assert.equal(item.filesAnalyzed, false);
  }
  const edges = new Set();
  for (const edge of document.relationships) {
    assert.ok(ids.has(edge.spdxElementId) && ids.has(edge.relatedSpdxElement), "Dangling SPDX relationship.");
    assert.ok(["DESCRIBES", "GENERATED_FROM", "CONTAINS", "DEPENDS_ON"].includes(edge.relationshipType));
    const key = JSON.stringify(edge); assert.ok(!edges.has(key), "Duplicate SPDX relationship."); edges.add(key);
  }
}

export async function verifyInputs(artifact) {
  const manifest = await readJson(path.join(artifact, "artifact.json"));
  const linkRecords = [];
  const names = (await walkFiles(artifact, true, linkRecords)).filter((name) => name !== "artifact.json");
  const records = [];
  for (const name of names) {
    const info = await lstat(path.join(artifact, name));
    records.push(manifest.kind === "native-runner" ? { path: name, sha256: await hashFile(path.join(artifact, name)), executable: Boolean(info.mode & 0o111) } : { path: name, sizeBytes: info.size, sha256: await hashFile(path.join(artifact, name)) });
  }
  if (manifest.kind === "native-runner") records.push(...linkRecords);
  assert.deepEqual(sorted(manifest.inventory), sorted(records), "Artifact file/member inventory mismatch.");
  const input = await readJson(path.join(artifact, "supply-chain/components.json"));
  const graph = await readJson(path.join(artifact, "package-graph.json"));
  assert.deepEqual(input.runtime, graph, "Packaged graph differs from inventory input.");
  const runtime = input.components.filter((component) => component.scope === "packaged-runtime");
  const entry = input.kind === "native-runner" ? "apps/runner" : "api";
  assert.ok(runtime.some((component) => component.location === entry), "Runtime entry component omission.");
  let slots = [];
  const slotRoot = `${entry}/node_modules/.runtime`;
  try { slots = await readdir(path.join(artifact, slotRoot)); } catch (error) { if (error.code !== "ENOENT") throw error; }
  assert.deepEqual(runtime.map((component) => component.location).sort(), [entry, ...slots.map((name) => `${slotRoot}/${safeName(name)}`)].sort(), "Packaged runtime slot omission.");
  assert.deepEqual(runtime.map((component) => component.location).sort(), graph.map((record) => record.packaged).sort(), "Runtime component omission.");
  const expectedEdges = [];
  const frontend = input.components.filter((component) => component.scope === "frontend-conservative-production-closure");
  const visited = new Set();
  function visit(location) {
    safeName(location);
    if (visited.has(location)) return;
    visited.add(location);
    const record = input.frontendManifests[location];
    assert.ok(record, "Frontend manifest omission.");
    const component = frontend.find((entry) => entry.location === location);
    assert.ok(component, "Frontend component omission.");
    assert.equal(component.name, record.manifest.name); assert.equal(component.version, record.manifest.version);
    assert.equal(component.declaredLicense, licenseDeclaration(record.manifest.license), "Declared license differs from manifest evidence.");
    for (const name of dependencies(record.manifest)) {
      const target = record.resolved[name];
      if (!target && optional(record.manifest, name)) continue;
      assert.ok(target, "Frontend dependency omission."); visit(target);
      const dependency = frontend.find((entry) => entry.location === target);
      expectedEdges.push({ from: component.id, type: "DEPENDS_ON", to: dependency.id });
    }
  }
  if (input.kind === "control-plane") visit("apps/web");
  assert.deepEqual([...visited].sort(), frontend.map((entry) => entry.location).sort());
  assert.deepEqual(Object.keys(input.frontendManifests).sort(), [...visited].sort());
  for (const component of runtime) {
    safeName(component.location);
    const directory = path.join(artifact, component.location);
    const { manifest, manifestSha256 } = await manifestAt(directory);
    assert.equal(component.name, manifest.name); assert.equal(component.version, manifest.version); assert.equal(component.manifestSha256, manifestSha256);
    assert.equal(component.declaredLicense, licenseDeclaration(manifest.license), "Declared license differs from manifest evidence.");
    for (const name of dependencies(manifest)) {
      const resolved = await resolveDependency(directory, name, artifact);
      if (!resolved && optional(manifest, name)) continue;
      const target = runtime.find((entry) => path.join(artifact, entry.location) === resolved);
      assert.ok(target, "Packaged dependency omitted."); expectedEdges.push({ from: component.id, type: "DEPENDS_ON", to: target.id });
    }
  }
  assert.deepEqual(sorted(input.relationships), sorted(expectedEdges));
  if (input.kind === "control-plane") {
    const emitted = await walkFiles(path.join(artifact, "web"));
    assert.deepEqual(input.assets.map((item) => item.path).sort(), emitted.map((name) => `web/${name}`).sort(), "Emitted asset omission.");
  }
  for (const file of [...input.assets, ...input.nativeFiles]) {
    safeName(file.path); assert.equal(await hashFile(path.join(artifact, file.path)), file.sha256, "Packaged file checksum mismatch.");
  }
  const system = await readJson(path.join(artifact, "supply-chain/system.json"));
  if (input.kind === "native-runner") assert.equal(await hashFile(path.join(artifact, "node")), system.components.find((entry) => entry.kind === "runtime")?.binarySha256, "Bundled Node checksum mismatch.");
  if (input.kind === "control-plane") {
    assert.equal(system.baseImage, BASE);
    assert.deepEqual(system.components.filter((entry) => entry.kind === "deb").map((entry) => [entry.name, entry.version]).sort(), system.debian.toSorted(), "Debian component omission.");
  }
  if (system.nodeVersions) assert.deepEqual(system.components.filter((entry) => entry.kind === "node-version").map((entry) => [entry.name.slice("Node process.versions.".length), entry.version]).sort(), Object.entries(system.nodeVersions).sort(), "Node bundled version omission.");
  const tools = system.components.filter((entry) => entry.scope === "final-image-bundled-tool");
  assert.deepEqual(tools.map((entry) => entry.location).sort(), Object.keys(system.bundledToolManifests ?? {}).sort(), "Bundled tool component omission.");
  const systemEdges = system.components.filter((entry) => entry.kind === "node-version").map((entry) => ({ from: id("runtime-node"), type: "CONTAINS", to: entry.id }));
  for (const component of tools) {
    const record = system.bundledToolManifests[component.location];
    assert.equal(component.name, record.manifest.name); assert.equal(component.version, record.manifest.version);
    assert.equal(component.declaredLicense, licenseDeclaration(record.manifest.license), "Declared license differs from manifest evidence.");
    assert.equal(component.manifestSha256, record.manifestSha256);
    for (const target of Object.values(record.resolved)) {
      const dependency = tools.find((entry) => entry.location === target);
      assert.ok(dependency, "Bundled tool dependency omission.");
      systemEdges.push({ from: component.id, type: "DEPENDS_ON", to: dependency.id });
    }
  }
  assert.deepEqual(sorted(system.relationships ?? []), sorted(systemEdges), "Bundled system relationship omission.");
  for (const notice of system.commonNotices ?? []) { safeName(notice.path); assert.equal(await hashFile(path.join(artifact, "supply-chain", notice.path)), notice.sha256); }
  for (const component of allComponents(input, system)) {
    assert.deepEqual(component.unresolved, component.kind === "runtime" ? [...issues(component), "Node upstream LICENSE includes bundled third-party terms; review required"] : issues(component));
  }
  for (const component of allComponents(input, system)) for (const notice of component.notices) {
    safeName(notice.path); assert.equal(await hashFile(path.join(artifact, "supply-chain", notice.path)), notice.sha256, "Upstream notice mismatch.");
  }
  assert.equal(input.node, "v24.18.0"); assert.equal(system.node, input.node); assert.equal(input.pnpm, "10.24.0");
  return { input, system };
}

export async function writePacket(artifactDirectory, archive, metadata, host, output) {
  const artifact = await rootDirectory(artifactDirectory);
  await walkFiles(artifact, true);
  const { input, system } = await verifyInputs(artifact);
  checkIdentity(metadata);
  if (input.kind === "control-plane" && !/^sha256:[a-f0-9]{64}$/.test(metadata.imageId ?? "")) throw new Error("Missing exact image identity.");
  const manifest = await readJson(path.join(artifact, "artifact.json"));
  for (const key of ["revision", "tree"]) { assert.equal(metadata[key], manifest[key], "Artifact/source mismatch."); assert.equal(metadata[key], host[key], "Build host/source mismatch."); }
  assert.equal(await hashFile(archive), metadata.sha256, "Archive checksum mismatch.");
  assert.equal(input.lockfileSha256, metadata.lockfileSha256, "Frozen source lockfile mismatch.");
  const binding = { ...metadata, kind: input.kind, lockfileSha256: input.lockfileSha256, node: input.node, pnpm: input.pnpm, baseImage: system.baseImage, host };
  const created = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const document = createSpdx(input, system, binding, created);
  const components = allComponents(input, system);
  const report = { status: "INVENTORY TOOLING ONLY", redistribution: "NOT CLEARED", binding, componentCount: components.length, scopes: Object.fromEntries([...new Set(components.map((item) => item.scope))].sort().map((scope) => [scope, components.filter((item) => item.scope === scope).length])), unresolved: components.filter((item) => item.unresolved.length).map((item) => ({ component: item.id, name: item.name, version: item.version, issues: item.unresolved, notices: item.notices })), coverageGaps: [...input.coverageGaps, ...system.coverageGaps], buildOnly: input.buildOnly, externalPrerequisites: input.externalPrerequisites };
  await rejectLinkedAncestors(path.dirname(output));
  await mkdir(output); // Partial packets stay diagnosable; existing output is refused.
  await put(output, "sbom.spdx.json", json(document));
  await put(output, "inventory.json", json(report));
  await put(output, "components.json", json(input));
  await put(output, "system.json", json(system));
  for (const name of await walkFiles(path.join(artifact, "supply-chain"))) if (name.startsWith("notices/")) await put(output, name, await readBounded(path.join(artifact, "supply-chain", name), 4 * 1024 * 1024));
  const sums = [`${metadata.sha256}  @artifact/${input.kind === "control-plane" ? "control-plane.tar" : "native-runner.tar.gz"}`];
  for (const name of await walkFiles(output)) sums.push(`${await hashFile(path.join(output, name))}  ${name}`);
  await put(output, "SHA256SUMS", `${sums.join("\n")}\n`);
  await verifyPacket(output, artifact, archive, metadata, host);
}

export async function verifyPacket(output, artifactDirectory, archive, metadata, host) {
  await walkFiles(output);
  const artifact = await rootDirectory(artifactDirectory);
  const { input, system } = await verifyInputs(artifact);
  const actualFiles = (await walkFiles(output)).filter((name) => name !== "SHA256SUMS");
  const sums = (await readBounded(path.join(output, "SHA256SUMS"))).toString("utf8").trimEnd().split("\n");
  const entries = new Map();
  for (const line of sums) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    assert.ok(match, "Invalid checksum line."); safeName(match[2]); assert.ok(!entries.has(match[2]), "Duplicate checksum member."); entries.set(match[2], match[1]);
  }
  const artifactName = `@artifact/${input.kind === "control-plane" ? "control-plane.tar" : "native-runner.tar.gz"}`;
  assert.deepEqual([...entries.keys()].sort(), [...actualFiles, artifactName].sort(), "Missing or unexpected checksum members.");
  const expectedFiles = ["sbom.spdx.json", "inventory.json", "components.json", "system.json", ...(await walkFiles(path.join(artifact, "supply-chain"))).filter((name) => name.startsWith("notices/"))];
  assert.deepEqual(actualFiles.sort(), expectedFiles.sort(), "Missing or unexpected packet members.");
  assert.equal(await hashFile(archive), metadata.sha256); assert.equal(entries.get(artifactName), metadata.sha256);
  for (const name of actualFiles) assert.equal(await hashFile(path.join(output, name)), entries.get(name), "Packet checksum mismatch.");
  assert.deepEqual(await readJson(path.join(output, "components.json")), input);
  assert.deepEqual(await readJson(path.join(output, "system.json")), system);
  const report = await readJson(path.join(output, "inventory.json"));
  assert.equal(input.lockfileSha256, metadata.lockfileSha256, "Frozen source lockfile mismatch.");
  assert.equal(report.redistribution, "NOT CLEARED"); assert.deepEqual(report.binding.host, host);
  for (const key of Object.keys(metadata)) assert.deepEqual(report.binding[key], metadata[key], "Packet binding mismatch.");
  const manifest = await readJson(path.join(artifact, "artifact.json"));
  assert.equal(manifest.revision, metadata.revision); assert.equal(manifest.tree, metadata.tree);
  assert.equal(report.componentCount, allComponents(input, system).length);
  assert.deepEqual(report.unresolved, allComponents(input, system).filter((item) => item.unresolved.length).map((item) => ({ component: item.id, name: item.name, version: item.version, issues: item.unresolved, notices: item.notices })));
  const document = await readJson(path.join(output, "sbom.spdx.json"));
  validateSpdx(document);
  assert.deepEqual(document, createSpdx(input, system, report.binding, document.creationInfo.created), "SPDX component or relationship mismatch.");
  return { redistribution: report.redistribution, componentCount: report.componentCount, checksumSha256: await hashFile(path.join(output, "SHA256SUMS")) };
}

export async function buildHost(revision, tree) {
  if (process.env.STONEHUSH_BUILD_HOST_RECEIPT) return readJson(process.env.STONEHUSH_BUILD_HOST_RECEIPT);
  return { revision, tree, host: { platform: platform(), arch: arch(), kernel: release(), osRelease: (await readBounded(await realpath("/etc/os-release"))).toString("utf8"), workflow: { runId: process.env.GITHUB_RUN_ID ?? null, runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null } } };
}

export async function imagePacket(imageId, archive, metadata, host, output, verifyOnly = false) {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const temporary = await mkdtemp(path.join(tmpdir(), "stonehush-image-inventory-"));
  let container;
  try {
    assert.equal(imageId, metadata.imageId, "Image metadata identity mismatch.");
    const image = JSON.parse(execFileSync("docker", ["image", "inspect", "--format={{json .}}", imageId], { encoding: "utf8", timeout: 30000, maxBuffer: MAX_METADATA }));
    assert.equal(image.Id, imageId);
    assert.equal(image.Config?.Labels?.["org.opencontainers.image.revision"], metadata.revision);
    assert.equal(image.Config?.Labels?.["dev.stonehush.source-tree"], metadata.tree);
    container = execFileSync("docker", ["create", "--network", "none", "--entrypoint", "/bin/true", imageId], { encoding: "utf8", timeout: 30000, maxBuffer: MAX_METADATA }).trim();
    if (!/^[a-f0-9]{64}$/.test(container)) throw new Error("Invalid inventory container identity.");
    const artifact = path.join(temporary, "artifact");
    await mkdir(artifact);
    execFileSync("docker", ["cp", `${container}:/opt/stonehush/.`, artifact], { timeout: 120000, maxBuffer: MAX_METADATA });
    const system = await readJson(path.join(artifact, "supply-chain/system.json"));
    const nodeBinary = path.join(temporary, "node");
    const debianStatus = path.join(temporary, "debian-status");
    execFileSync("docker", ["cp", `${container}:/usr/local/bin/node`, nodeBinary], { timeout: 30000, maxBuffer: MAX_METADATA });
    execFileSync("docker", ["cp", `${container}:/var/lib/dpkg/status`, debianStatus], { timeout: 30000, maxBuffer: MAX_METADATA });
    assert.equal(await hashFile(nodeBinary), system.components.find((item) => item.kind === "runtime")?.binarySha256, "Final image Node mismatch.");
    assert.equal(await hashFile(debianStatus), system.debianStatusSha256, "Final image Debian status mismatch.");
    assert.deepEqual(sorted(debianPackages((await readBounded(debianStatus)).toString("utf8"))), sorted(system.debian), "Final image Debian omission.");
    // Copy fixed actual roots independently of any captured component list.
    for (const root of ["usr/local/lib/node_modules", "opt"]) {
      await mkdir(path.join(temporary, root), { recursive: true });
      execFileSync("docker", ["cp", `${container}:/${root}/.`, path.join(temporary, root)], { timeout: 60000, maxBuffer: MAX_METADATA });
    }
    const actualTools = await inspectToolPackages(await discoverToolRoots(temporary));
    assert.deepEqual(actualTools.manifests, system.bundledToolManifests, "Final bundled tool component/manifest omission.");
    assert.deepEqual(actualTools.relationships, sorted(system.relationships.filter((edge) => edge.type === "DEPENDS_ON")), "Final bundled tool dependency omission.");
    if (verifyOnly) return await verifyPacket(output, artifact, archive, metadata, host);
    await writePacket(artifact, archive, metadata, host, output);
  } finally {
    if (container && /^[a-f0-9]{64}$/.test(container)) execFileSync("docker", ["rm", container], { timeout: 30000, maxBuffer: MAX_METADATA });
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "system" && args.length === 2) await collectSystem(args[0], args[1]);
  else if (["packet", "verify"].includes(command) && args.length === 5) {
    const [artifact, archive, metadata, host, output] = args;
    if (command === "packet") await writePacket(artifact, archive, await readJson(metadata), await readJson(host), output);
    else console.log(json(await verifyPacket(output, artifact, archive, await readJson(metadata), await readJson(host))));
  } else throw new Error("usage: release-inventory.mjs system <artifact> <kind> | packet/verify <artifact> <archive> <metadata.json> <host.json> <new-packet>");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
