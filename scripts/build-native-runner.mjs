import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inventory } from "./native-runner-service.mjs";
import { buildHost, freshOutputs, writePacket } from "./release-inventory.mjs";

function run(executable, argv, cwd, stdout = "inherit", env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { cwd, env, stdio: ["inherit", stdout, "inherit"], shell: false });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Native artifact build command failed.")));
  });
}

export async function archiveRuntime(parent, output) {
  const file = await open(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await run("tar", ["-cz", "-C", parent, "stonehush-runner"], parent, file.fd);
    await file.sync();
  } finally { await file.close(); }
}

async function main() {
  const [output] = process.argv.slice(2);
  if (!path.isAbsolute(output ?? "") || process.argv.length !== 3 || !output.endsWith(".tar.gz")) throw new Error("usage: node scripts/build-native-runner.mjs <absolute-new-runner.tar.gz>");
  if (process.version !== "v24.18.0" || process.platform !== "linux" || process.arch !== "x64") throw new Error("Build with Node 24.18.0 on Linux x86-64.");
  if (execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim() !== "10.24.0") throw new Error("Build with pnpm 10.24.0.");
  await freshOutputs([output, `${output}.json`, `${output}.supply-chain`]);
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["rev-parse", `${revision}^{tree}`], { cwd: source, encoding: "utf8" }).trim();
  const temporary = await mkdtemp(path.join(tmpdir(), "stonehush-native-build-"));

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
    await run(process.execPath, [path.join(checkout, "scripts/assemble-control-plane.mjs"), artifact, "native-service"], checkout, "inherit", { ...process.env, STONEHUSH_COLLECT_INVENTORY: "1" });
    await writeFile(path.join(artifact, "artifact.json"), `${JSON.stringify({ kind: "native-runner", revision, tree, node: process.version, pnpm: "10.24.0", inventory: await inventory(artifact) }, null, 2)}\n`, { flag: "wx", mode: 0o644 });
    await archiveRuntime(temporary, output);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(output)) hash.update(chunk);
    const metadata = JSON.parse(await readFile(path.join(artifact, "artifact.json"), "utf8"));
    const binding = { revision, tree, lockfileSha256: createHash("sha256").update(await readFile(path.join(checkout, "pnpm-lock.yaml"))).digest("hex"), sha256: hash.digest("hex"), node: metadata.node, pnpm: metadata.pnpm, platform: "linux/x64" };
    await writeFile(`${output}.json`, `${JSON.stringify(binding, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    const host = await buildHost(revision, tree);
    await writePacket(artifact, output, binding, host, `${output}.supply-chain`);
    console.log("Native runner archive created. Verify its adjacent source and SHA-256 metadata before extraction.");
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
