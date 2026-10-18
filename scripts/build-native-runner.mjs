import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inventory } from "./native-runner-service.mjs";

const [output] = process.argv.slice(2);
if (!path.isAbsolute(output ?? "") || process.argv.length !== 3 || !output.endsWith(".tar.gz")) throw new Error("usage: node scripts/build-native-runner.mjs <absolute-new-runner.tar.gz>");
if (process.version !== "v24.18.0" || process.platform !== "linux" || process.arch !== "x64") throw new Error("Build with Node 24.18.0 on Linux x86-64.");
if (execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim() !== "10.24.0") throw new Error("Build with pnpm 10.24.0.");
for (const filename of [output, `${output}.json`]) {
  try { await lstat(filename); throw new Error("Artifact output already exists."); } catch (error) { if (error.code !== "ENOENT") throw error; }
}
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
const tree = execFileSync("git", ["rev-parse", `${revision}^{tree}`], { cwd: source, encoding: "utf8" }).trim();
const temporary = await mkdtemp(path.join(tmpdir(), "stonehush-native-build-"));
function run(executable, argv, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { cwd, stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Native artifact build command failed.")));
  });
}
try {
  // Build a clean exact commit. Existing dist, dirty files and source symlinks
  // cannot enter the artifact or substitute a different dependency closure.
  const archive = path.join(temporary, "source.tar");
  await run("git", ["archive", "--format=tar", `--output=${archive}`, revision], source);
  const checkout = path.join(temporary, "source");
  await run("mkdir", [checkout], temporary);
  await run("tar", ["-xf", archive, "-C", checkout], temporary);
  await run("pnpm", ["install", "--frozen-lockfile"], checkout);
  await run("pnpm", ["--filter", "@stonehush/runner...", "run", "build"], checkout);
  const artifact = path.join(temporary, "stonehush-runner");
  await run(process.execPath, [path.join(checkout, "scripts/assemble-control-plane.mjs"), artifact, "native-service"], checkout);
  await writeFile(path.join(artifact, "artifact.json"), `${JSON.stringify({ kind: "native-runner", revision, tree, node: process.version, pnpm: "10.24.0", inventory: await inventory(artifact) }, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  await run("tar", ["-czf", output, "-C", temporary, "stonehush-runner"], temporary);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(output)) hash.update(chunk);
  const metadata = JSON.parse(await readFile(path.join(artifact, "artifact.json"), "utf8"));
  await writeFile(`${output}.json`, `${JSON.stringify({ revision, tree, sha256: hash.digest("hex"), node: metadata.node, pnpm: metadata.pnpm, platform: "linux/x64" }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log("Native runner archive created. Verify its adjacent source and SHA-256 metadata before extraction.");
} finally { await rm(temporary, { recursive: true, force: true }); }
