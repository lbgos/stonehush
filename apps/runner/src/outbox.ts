import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";

import {
  COMMAND_CANONICALIZATION_PROFILE,
  canonicalizeJson,
  projectCommandJsonV1DigestInput,
  type CommandJsonV1DigestProjection,
  type JsonValue,
  JsonValueSchema,
} from "@stonehush/contracts";

export function generateIdempotencyKey(): string {
  return randomBytes(16).toString("base64url");
}

export interface OutboxEntry {
  key: string;
  route: string;
  operation: string;
  requestDigest: string;
  createdAt: string;
}

function isSafeKey(key: string): boolean {
  return /^[A-Za-z0-9_-]{22,128}$/.test(key) && /^[\x20-\x7e]+$/.test(key);
}

function outboxDir(dataDir: string): string {
  return path.join(dataDir, "outbox");
}

function outboxFilePath(dataDir: string, key: string): string {
  if (!isSafeKey(key)) throw new Error("unsafe outbox key");
  return path.join(outboxDir(dataDir), `${key}.json`);
}

async function fsyncDir(dirPath: string): Promise<void> {
  const handle = await open(dirPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function computeRunnerDigest(input: {
  actorId: string;
  route: string;
  operation: string;
  path: JsonValue;
  query: JsonValue;
  body: JsonValue;
  digestProjection: CommandJsonV1DigestProjection;
}): string | undefined {
  const projected = projectCommandJsonV1DigestInput(input.digestProjection, {
    path: input.path,
    query: input.query,
    body: input.body,
  });
  const canonical = canonicalizeJson({
    actorId: input.actorId,
    body: projected.body,
    canonicalizationProfile: COMMAND_CANONICALIZATION_PROFILE,
    operation: input.operation,
    path: projected.path,
    query: projected.query,
    route: input.route,
  });
  if (!canonical.ok) return undefined;
  return `sha256:${createHash("sha256").update(canonical.canonicalJson, "utf8").digest("hex")}`;
}

export async function writeOutboxAtomically(dataDir: string, entry: OutboxEntry): Promise<string> {
  const dir = outboxDir(dataDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Validate entry
  if (!isSafeKey(entry.key)) throw new Error("invalid outbox key");
  const file = outboxFilePath(dataDir, entry.key);
  const content = JSON.stringify(entry);
  // Validate JSON is canonicalizable
  const parsed = JsonValueSchema.safeParse(entry);
  if (!parsed.success) throw new Error("invalid outbox entry");
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDir(dir);
  return file;
}

export async function loadOutboxEntry(dataDir: string, key: string): Promise<OutboxEntry | null> {
  if (!isSafeKey(key)) return null;
  const file = outboxFilePath(dataDir, key);
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as OutboxEntry;
    if (
      typeof parsed.key !== "string" ||
      typeof parsed.route !== "string" ||
      typeof parsed.operation !== "string" ||
      typeof parsed.requestDigest !== "string" ||
      parsed.key !== key
    ) {
      return null;
    }
    if (!isSafeKey(parsed.key)) return null;
    // Validate digest format
    if (!/^sha256:[0-9a-f]{64}$/.test(parsed.requestDigest)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function findExistingOutbox(
  dataDir: string,
  route: string,
  operation: string,
  requestDigest: string,
): Promise<OutboxEntry | null> {
  const dir = outboxDir(dataDir);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const key = name.slice(0, -5);
    if (!isSafeKey(key)) continue;
    const entry = await loadOutboxEntry(dataDir, key);
    if (entry === null) continue;
    if (entry.route === route && entry.operation === operation && entry.requestDigest === requestDigest) {
      return entry;
    }
  }
  return null;
}

export async function removeOutboxAtomically(dataDir: string, key: string): Promise<void> {
  if (!isSafeKey(key)) throw new Error("unsafe key for removal");
  const file = outboxFilePath(dataDir, key);
  const dir = outboxDir(dataDir);
  await unlink(file);
  await fsyncDir(dir);
}

export async function getOrCreateOutboxEntry(input: {
  dataDir: string;
  actorId: string;
  route: string;
  operation: string;
  path: JsonValue;
  query: JsonValue;
  body: JsonValue;
  digestProjection: CommandJsonV1DigestProjection;
}): Promise<{ entry: OutboxEntry; file: string; reused: boolean }> {
  const digest = computeRunnerDigest(input);
  if (digest === undefined) throw new Error("cannot compute digest");
  const existing = await findExistingOutbox(input.dataDir, input.route, input.operation, digest);
  if (existing !== null) {
    const file = outboxFilePath(input.dataDir, existing.key);
    return { entry: existing, file, reused: true };
  }
  const key = generateIdempotencyKey();
  const entry: OutboxEntry = {
    key,
    route: input.route,
    operation: input.operation,
    requestDigest: digest,
    createdAt: new Date().toISOString(),
  };
  const file = await writeOutboxAtomically(input.dataDir, entry);
  return { entry, file, reused: false };
}
