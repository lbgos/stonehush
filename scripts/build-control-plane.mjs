import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const [tag, output] = process.argv.slice(2);
if (!tag || tag.startsWith("-") || !output || !path.isAbsolute(output) || process.argv.length !== 4) {
  throw new Error("usage: node scripts/build-control-plane.mjs <local-image-tag> <absolute-new-image.tar>");
}
for (const filename of [output, `${output}.json`]) {
  try {
    await lstat(filename);
    throw new Error("Artifact output already exists.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function git(...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
const revision = git("rev-parse", "HEAD");
const tree = git("rev-parse", "HEAD^{tree}");
function completion(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Artifact command failed.")));
  });
}

// git archive supplies only the exact commit. Dirty files, dependency links,
// private plans, credentials and local data cannot enter the build context.
const buildDirectory = await mkdtemp(path.join(tmpdir(), "stonehush-image-build-"));
const iidfile = path.join(buildDirectory, "image-id");
let imageId;
const archive = spawn("git", ["archive", "--format=tar", revision], { cwd, stdio: ["ignore", "pipe", "inherit"], shell: false });
const build = spawn("docker", ["build", "--platform=linux/amd64", "--iidfile", iidfile, "--build-arg", `SOURCE_REVISION=${revision}`, "--build-arg", `SOURCE_TREE=${tree}`, "--tag", tag, "-"], { cwd, stdio: ["pipe", "inherit", "inherit"], shell: false });
try {
  await Promise.all([completion(archive), completion(build), pipeline(archive.stdout, build.stdin)]);
  imageId = (await readFile(iidfile, "utf8")).trim();
} catch (error) {
  archive.kill("SIGTERM");
  build.kill("SIGTERM");
  throw error;
} finally {
  await rm(buildDirectory, { recursive: true, force: true });
}
if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error("Invalid build image identity.");
const image = JSON.parse(execFileSync("docker", ["image", "inspect", "--format={{json .}}", imageId], { encoding: "utf8" }));
if (image.Id !== imageId || image.Config?.Labels?.["org.opencontainers.image.revision"] !== revision || image.Config?.Labels?.["dev.stonehush.source-tree"] !== tree) {
  throw new Error("Built image source identity does not match the archive source.");
}
// A tag can move concurrently. Export the immutable result of this build.
const save = spawn("docker", ["image", "save", imageId], { stdio: ["ignore", "pipe", "inherit"], shell: false });
try {
  await Promise.all([completion(save), pipeline(save.stdout, createWriteStream(output, { flags: "wx", mode: 0o600 }))]);
} catch (error) {
  save.kill("SIGTERM");
  throw error;
}
const hash = createHash("sha256");
for await (const chunk of createReadStream(output)) hash.update(chunk);
await writeFile(`${output}.json`, `${JSON.stringify({ revision, tree, imageId, sha256: hash.digest("hex"), platform: "linux/amd64" }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
console.log("Local image and archive created. Source and artifact identities are in the adjacent JSON file.");
