import { cp, lstat, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [destination] = process.argv.slice(2);
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!destination || !path.isAbsolute(destination)) throw new Error("An absolute new package directory is required.");
await mkdir(destination); // A preexisting destination is never overwritten.
const packages = new Map();
const workspaceFiles = {
  "@stonehush/api": ["dist", "package.json"],
  "@stonehush/contracts": ["dist", "package.json"],
  "@stonehush/domain": ["dist", "package.json"],
  "@stonehush/db": ["dist", "drizzle", "package.json"],
  "@stonehush/evidence-native": ["dist", "build", "package.json"],
};

async function resolveDependency(directory, name) {
  if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name)) throw new Error("Unsafe dependency name.");
  const require = createRequire(path.join(directory, "package.json"));
  // The suffix also searches installed modules whose names match Node
  // builtins, such as the punycode package used by tr46.
  for (const search of require.resolve.paths(`${name}/package.json`) ?? []) {
    const candidate = path.join(search, name);
    try {
      await lstat(candidate);
      const resolved = await realpath(candidate);
      return resolved;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return undefined;
}

async function copyPackage(directory, target) {
  const existing = packages.get(directory);
  if (existing !== undefined) return existing;
  const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  target ??= path.join(destination, "api/node_modules/.runtime", String(packages.size));
  packages.set(directory, target); // Establish identity before traversing cycles.
  await mkdir(target, { recursive: true });
  const files = workspaceFiles[manifest.name];
  if (files !== undefined) {
    for (const file of files) await cp(path.join(directory, file), path.join(target, file), {
      recursive: true,
      dereference: false,
      filter: (filename) => file !== "drizzle" || !filename.endsWith(".json") || path.basename(filename) === "_journal.json",
    });
  } else {
    await cp(directory, target, {
      recursive: true,
      dereference: false,
      filter: (filename) => path.basename(filename) !== "node_modules",
    });
  }
  const dependencies = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  for (const name of [...dependencies].sort()) {
    const resolved = await resolveDependency(directory, name);
    if (resolved === undefined) {
      if (name in (manifest.optionalDependencies ?? {}) || manifest.peerDependenciesMeta?.[name]?.optional === true) continue;
      throw new Error(`Missing installed runtime dependency: ${name}`);
    }
    const packaged = await copyPackage(resolved);
    const link = path.join(target, "node_modules", name);
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(path.relative(path.dirname(link), packaged), link);
  }
  return target;
}

await copyPackage(path.join(source, "apps/api"), path.join(destination, "api"));
await cp(path.join(source, "apps/web/dist"), path.join(destination, "web"), { recursive: true, dereference: false });
await cp(path.join(source, "LICENSE"), path.join(destination, "LICENSE"));
await writeFile(path.join(destination, "package-graph.json"), `${JSON.stringify([...packages].map(([from, to]) => ({ source: path.relative(source, from), packaged: path.relative(destination, to) })), null, 2)}\n`);
