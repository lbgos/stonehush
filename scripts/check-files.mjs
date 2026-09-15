import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ignoredDirectories = new Set([
  ".stonehush",
  ".git",
  ".vite",
  "coverage",
  "data",
  "dist",
  "evidence",
  "node_modules",
]);
const textExtensions = new Set([
  ".css",
  ".html",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const textNames = new Set([".editorconfig", ".gitignore", ".node-version"]);

async function repositoryFiles(directory) {
  const files = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;

    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await repositoryFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

export function formatErrors(content) {
  const errors = [];
  if (content.includes("\r")) errors.push("contains carriage returns");
  if (!content.endsWith("\n")) errors.push("does not end with a newline");

  const lines = content.split("\n");
  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index].endsWith("\r") ? lines[index].slice(0, -1) : lines[index];
    if (/[\t ]+$/.test(line)) errors.push(`line ${index + 1} has trailing whitespace`);
  }

  return errors;
}

export async function checkFormatting(repositoryRoot) {
  const errors = [];

  for (const file of await repositoryFiles(repositoryRoot)) {
    const extension = path.extname(file);
    if (!textExtensions.has(extension) && !textNames.has(path.basename(file))) continue;

    const relativeFile = path.relative(repositoryRoot, file);
    const content = await readFile(file, "utf8");
    for (const error of formatErrors(content)) errors.push(`${relativeFile}: ${error}`);
  }

  return errors;
}

export async function checkSyntax(repositoryRoot) {
  const errors = [];

  for (const file of await repositoryFiles(repositoryRoot)) {
    if (path.extname(file) !== ".mjs") continue;

    const result = spawnSync(process.execPath, ["--check", file], {
      encoding: "utf8",
      shell: false,
    });
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      errors.push(`${path.relative(repositoryRoot, file)}: ${detail}`);
    }
  }

  return errors;
}

async function main() {
  const mode = process.argv[2];
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  let errors;
  if (mode === "format") errors = await checkFormatting(repositoryRoot);
  else if (mode === "syntax") errors = await checkSyntax(repositoryRoot);
  else throw new Error(`Unknown check mode: ${mode ?? "<missing>"}`);

  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
    return;
  }

  console.log(`${mode} check passed.`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
