import { close, constants, fsync, write, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { promisify } from "node:util";

import { O_CLOEXEC, loadEvidenceNative } from "@stonehush/evidence-native";
import { afterEach, describe, expect, it } from "vitest";

import { EvidenceStore, DOWNLOAD_CHUNK_BYTES, VERIFIED_EXCERPT_MAX_BYTES } from "./evidence-store.js";

const writeFileAt = promisify(write);
const fsyncFd = promisify(fsync);
const closeFd = promisify(close);

const directories: string[] = [];
const stores: EvidenceStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await chmod(directory, 0o700).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

async function openStore(): Promise<{ store: EvidenceStore; directory: string }> {
  const native = loadEvidenceNative();
  if (!native.ok) throw new Error(`native binding unavailable: ${native.reason}`);
  const directory = await mkdtemp(path.join(tmpdir(), "evidence-store-"));
  await chmod(directory, 0o700);
  const result = EvidenceStore.open(directory, native.binding);
  if (!result.ok) throw new Error(`store open failed: ${result.code}`);
  stores.push(result.store);
  directories.push(directory);
  return { store: result.store, directory };
}

// Creates a staged file with the given bytes and returns its size.
async function stageBytes(
  store: EvidenceStore,
  uploadId: string,
  bytes: string | Buffer,
): Promise<number> {
  const created = store.openStagingFile(uploadId);
  if (!created.ok) throw new Error(`stage create failed: ${created.code}`);
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8");
  if (buffer.length > 0) await writeFileAt(created.fd, buffer, 0, buffer.length, null);
  await fsyncFd(created.fd).catch(() => undefined);
  await closeFd(created.fd);
  return buffer.length;
}

function sha256(bytes: string | Buffer): string {
  return `sha256:${createHash("sha256").update(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)).digest("hex")}`;
}

async function publishReady(
  store: EvidenceStore,
  uploadId: string,
  artifactId: string,
  bytes: string,
): Promise<void> {
  const size = await stageBytes(store, uploadId, bytes);
  const outcome = store.publish({
    uploadId,
    artifactId,
    expectedSizeBytes: size,
  });
  if (outcome.status !== "published") throw new Error(`publish failed: ${outcome.status}`);
}

async function collect(stream: AsyncGenerator<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(chunk);
  return Buffer.concat(parts);
}

describe("EvidenceStore", () => {
  it("creates the managed evidence layout mode 0700 on first open", async () => {
    const { directory } = await openStore();
    for (const part of ["evidence", "evidence/published", "evidence/staging"]) {
      const stats = await stat(path.join(directory, part));
      expect(stats.isDirectory()).toBe(true);
      expect(stats.mode & 0o777).toBe(0o700);
    }
  });

  it("rejects traversal and separator segments before touching the kernel", async () => {
    const { store } = await openStore();
    for (const name of ["..", ".", "a/b", "/absolute", "", "a\\b"]) {
      expect(store.openStagingFile(name)).toEqual({
        ok: false,
        code: "artifact_path_rejected",
      });
    }
  });

  it("refuses a symlink planted at the staging name without following it", async () => {
    const { store, directory } = await openStore();
    const outside = path.join(directory, "outside-target");
    await writeFile(outside, "secret");
    await symlink(
      outside,
      path.join(directory, "evidence", "staging", "upload-sym"),
    );
    expect(store.openStagingFile("upload-sym")).toEqual({
      ok: false,
      code: "artifact_symlink_rejected",
    });
    // The symlink target must be untouched.
    await expect(readFile(outside)).resolves.toEqual(Buffer.from("secret"));
  });

  it("publishes an empty artifact through the no-replace boundary", async () => {
    const { store, directory } = await openStore();
    expect(await stageBytes(store, "upload-empty", "")).toBe(0);
    const outcome = store.publish({
      uploadId: "upload-empty",
      artifactId: "artifact-empty",
      expectedSizeBytes: 0,
    });
    expect(outcome).toMatchObject({ status: "published" });
    const stats = await stat(path.join(directory, "evidence/published/artifact-empty"));
    expect(stats.isFile()).toBe(true);
    expect(stats.mode & 0o777).toBe(0o600);
    expect(stats.size).toBe(0);
    await expect(stat(path.join(directory, "evidence/staging/upload-empty"))).rejects.toThrow();
  });

  it("leaves an existing destination untouched and reports the collision", async () => {
    const { store, directory } = await openStore();
    const destination = path.join(directory, "evidence/published/artifact-collide");
    await writeFile(destination, "original-evidence-bytes");
    await chmod(destination, 0o600);
    expect(await stageBytes(store, "upload-b", "incoming-bytes")).toBe(14);
    expect(
      store.publish({
        uploadId: "upload-b",
        artifactId: "artifact-collide",
        expectedSizeBytes: 14,
      }),
    ).toEqual({ status: "destination_exists" });
    // The destination still holds exactly the original bytes.
    const inspect = await store.inspectPublishedDestination("artifact-collide");
    expect(inspect).toMatchObject({
      status: "match",
      sizeBytes: 23,
      digest: sha256("original-evidence-bytes"),
    });
  });

  it("detects hardlinked staging files at publish time", async () => {
    const { store, directory } = await openStore();
    expect(await stageBytes(store, "upload-hl", "hardlink-me")).toBe(11);
    await link(
      path.join(directory, "evidence/staging/upload-hl"),
      path.join(directory, "hardlink-alias"),
    );
    const outcome = store.publish({
      uploadId: "upload-hl",
      artifactId: "artifact-hl",
      expectedSizeBytes: 11,
    });
    expect(outcome).toEqual({ status: "failed", code: "artifact_hardlink_rejected" });
  });

  it("refuses to retarget a replaced published directory after startup", async () => {
    const { store, directory } = await openStore();
    expect(await stageBytes(store, "upload-swap", "swap")).toBe(4);
    await rename(
      path.join(directory, "evidence/published"),
      path.join(directory, "published-old"),
    );
    await mkdir(path.join(directory, "evidence/published"), { mode: 0o700 });
    const outcome = store.publish({
      uploadId: "upload-swap",
      artifactId: "artifact-swap",
      expectedSizeBytes: 4,
    });
    expect(outcome).toEqual({ status: "failed", code: "artifact_published_root_changed" });
  });

  it("resolves the crash window where staging is gone but bytes landed", async () => {
    const { store, directory } = await openStore();
    const bytes = "crash-window-evidence";
    expect(await stageBytes(store, "upload-crash", bytes)).toBe(bytes.length);
    // Simulate a crash after rename but before metadata commit.
    await rename(
      path.join(directory, "evidence/staging/upload-crash"),
      path.join(directory, "evidence/published/artifact-crash"),
    );
    const outcome = store.publish({
      uploadId: "upload-crash",
      artifactId: "artifact-crash",
      expectedSizeBytes: bytes.length,
    });
    expect(outcome).toEqual({ status: "source_missing" });
    const inspect = await store.inspectPublishedDestination("artifact-crash");
    expect(inspect).toMatchObject({ status: "match", sizeBytes: bytes.length });
    if (inspect.status !== "match") return;
    expect(inspect.digest).toBe(sha256(bytes));
  });

  it("keeps an existing destination byte-for-byte when a rename collides", async () => {
    const { store, directory } = await openStore();
    const destination = path.join(directory, "evidence/published/artifact-x");
    await writeFile(destination, "already-here");
    await chmod(destination, 0o600);
    expect(await stageBytes(store, "upload-x", "real-bytes")).toBe(10);
    expect(
      store.publish({
        uploadId: "upload-x",
        artifactId: "artifact-x",
        expectedSizeBytes: 10,
      }),
    ).toEqual({ status: "destination_exists" });
    await expect(readFile(destination)).resolves.toEqual(Buffer.from("already-here"));
  });

  it.runIf(process.platform === "linux")("maps EXDEV instead of copying across devices", async () => {
    const native = loadEvidenceNative();
    if (!native.ok) throw new Error("native binding unavailable");
    const shm = "/dev/shm";
    const local = tmpdir();
    const [shmStats, localStats] = await Promise.all([stat(shm), stat(local)]);
    if (shmStats.dev === localStats.dev) return;
    const dirA = path.join(shm, `evidence-exdev-a-${process.pid}`);
    const dirB = path.join(local, `evidence-exdev-b-${process.pid}`);
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    try {
      const handleA = await open(dirA, constants.O_RDONLY | constants.O_DIRECTORY | O_CLOEXEC);
      const handleB = await open(dirB, constants.O_RDONLY | constants.O_DIRECTORY | O_CLOEXEC);
      try {
        await writeFile(path.join(dirA, "src"), "x");
        const outcome = native.binding.renameNoReplace(handleA.fd, "src", handleB.fd, "dst");
        expect(outcome).toEqual({ ok: false, errno: /* EXDEV */ 18 });
        // Neither side changed.
        await expect(stat(path.join(dirA, "src"))).resolves.toBeTruthy();
        await expect(stat(path.join(dirB, "dst"))).rejects.toThrow();
      } finally {
        await handleA.close();
        await handleB.close();
      }
    } finally {
      await rm(dirA, { recursive: true, force: true });
      await rm(dirB, { recursive: true, force: true });
    }
  });

  it("refuses to serve when RENAME_NOREPLACE is unsupported", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "evidence-unsupported-"));
    directories.push(directory);
    const native = loadEvidenceNative();
    if (!native.ok) throw new Error("native binding unavailable");
    const failingBinding = {
      openAt: native.binding.openAt,
      renameNoReplace: () => ({ ok: false as const, errno: /* EINVAL */ 22 }),
      readDirNames: native.binding.readDirNames,
      flockNonblock: native.binding.flockNonblock,
    };
    const result = EvidenceStore.open(directory, failingBinding);
    expect(result).toEqual({ ok: false, code: "evidence_storage_unsupported" });
  });

  it("unlinks nothing during refused operations", async () => {
    const { store, directory } = await openStore();
    await writeFile(path.join(directory, "evidence/staging/orphan"), "keep");
    expect(store.openStagingFile("orphan")).toMatchObject({
      ok: false,
      code: "evidence_staging_name_taken",
    });
    await expect(readFile(path.join(directory, "evidence/staging/orphan"))).resolves.toEqual(
      Buffer.from("keep"),
    );
    await unlink(path.join(directory, "evidence/staging/orphan"));
  });

  describe("verifiedDownload", () => {
    it("streams a good artifact from the verified descriptor", async () => {
      const { store } = await openStore();
      const bytes = "verified-download-payload";
      await publishReady(store, "up-good", "artifact-good", bytes);
      const result = await store.verifiedDownload({
        artifactId: "artifact-good",
        expectedSizeBytes: bytes.length,
        expectedDigest: sha256(bytes),
      });
      if (result.status !== "ready") throw new Error(`expected ready: ${result.status}`);
      expect(result.sizeBytes).toBe(bytes.length);
      expect(result.digest).toBe(sha256(bytes));
      await expect(collect(result.stream)).resolves.toEqual(Buffer.from(bytes));
    });

    it("accepts an empty artifact and yields no chunks", async () => {
      const { store } = await openStore();
      await publishReady(store, "up-zero", "artifact-zero", "");
      const result = await store.verifiedDownload({
        artifactId: "artifact-zero",
        expectedSizeBytes: 0,
        expectedDigest: sha256(""),
      });
      if (result.status !== "ready") throw new Error(`expected ready: ${result.status}`);
      expect(result.sizeBytes).toBe(0);
      const parts: Buffer[] = [];
      for await (const chunk of result.stream) parts.push(chunk);
      expect(parts).toEqual([]);
    });

    it("reports missing for an unknown artifact id without leaking paths", async () => {
      const { store } = await openStore();
      await expect(
        store.verifiedDownload({
          artifactId: "artifact-absent",
          expectedSizeBytes: 0,
          expectedDigest: sha256(""),
        }),
      ).resolves.toEqual({ status: "missing" });
    });

    it("rejects a wrong declared size before exposing any bytes", async () => {
      const { store } = await openStore();
      const bytes = "size-guard";
      await publishReady(store, "up-size", "artifact-size", bytes);
      await expect(
        store.verifiedDownload({
          artifactId: "artifact-size",
          expectedSizeBytes: bytes.length + 1,
          expectedDigest: sha256(bytes),
        }),
      ).resolves.toEqual({ status: "corrupt", code: "size_mismatch" });
    });

    it("rejects a wrong digest before exposing any bytes", async () => {
      const { store } = await openStore();
      const bytes = "digest-guard";
      await publishReady(store, "up-digest", "artifact-digest", bytes);
      await expect(
        store.verifiedDownload({
          artifactId: "artifact-digest",
          expectedSizeBytes: bytes.length,
          expectedDigest: sha256("tampered"),
        }),
      ).resolves.toEqual({ status: "corrupt", code: "digest_mismatch" });
    });

    it("refuses a symlink planted at the published name without following it", async () => {
      const { store, directory } = await openStore();
      const bytes = "real-bytes";
      await publishReady(store, "up-sym", "artifact-sym", bytes);
      const outside = path.join(directory, "outside-secret");
      await writeFile(outside, "secret");
      await unlink(path.join(directory, "evidence/published/artifact-sym"));
      await symlink(
        outside,
        path.join(directory, "evidence/published/artifact-sym"),
      );
      await expect(
        store.verifiedDownload({
          artifactId: "artifact-sym",
          expectedSizeBytes: 6,
          expectedDigest: sha256("secret"),
        }),
      ).resolves.toEqual({ status: "corrupt", code: "artifact_symlink_rejected" });
      // The symlink target must be untouched.
      await expect(readFile(outside)).resolves.toEqual(Buffer.from("secret"));
    });

    it("refuses a hardlinked published file", async () => {
      const { store, directory } = await openStore();
      const bytes = "hardlink-me";
      await publishReady(store, "up-hl", "artifact-hl", bytes);
      await link(
        path.join(directory, "evidence/published/artifact-hl"),
        path.join(directory, "hardlink-alias"),
      );
      await expect(
        store.verifiedDownload({
          artifactId: "artifact-hl",
          expectedSizeBytes: bytes.length,
          expectedDigest: sha256(bytes),
        }),
      ).resolves.toEqual({ status: "corrupt", code: "artifact_hardlink_rejected" });
    });

    it("fails closed as missing when the published directory was replaced after startup", async () => {
      const { store, directory } = await openStore();
      const bytes = "swapped";
      await publishReady(store, "up-swap", "artifact-swap", bytes);
      await rename(
        path.join(directory, "evidence/published"),
        path.join(directory, "published-old"),
      );
      await mkdir(path.join(directory, "evidence/published"), { mode: 0o700 });
      await expect(
        store.verifiedDownload({
          artifactId: "artifact-swap",
          expectedSizeBytes: bytes.length,
          expectedDigest: sha256(bytes),
        }),
      ).resolves.toEqual({ status: "missing" });
    });

    it.runIf(process.platform === "linux")("closes the verified fd on completion and on consumer abort", async () => {
      const { store } = await openStore();
      const openFdCount = () => readdirSync("/proc/self/fd").length;
      const bytes = "x".repeat(DOWNLOAD_CHUNK_BYTES * 2);
      await publishReady(store, "up-close", "artifact-close", bytes);

      const first = await store.verifiedDownload({
        artifactId: "artifact-close",
        expectedSizeBytes: bytes.length,
        expectedDigest: sha256(bytes),
      });
      if (first.status !== "ready") throw new Error(`expected ready: ${first.status}`);
      const baseline = openFdCount();
      let received = 0;
      for await (const chunk of first.stream) received += chunk.length;
      expect(received).toBe(bytes.length);
      // The verified fd was open at baseline and must be closed now.
      expect(openFdCount()).toBe(baseline - 1);

      // Breaking out mid-stream aborts iteration and must still close the fd.
      const second = await store.verifiedDownload({
        artifactId: "artifact-close",
        expectedSizeBytes: bytes.length,
        expectedDigest: sha256(bytes),
      });
      if (second.status !== "ready") throw new Error(`expected ready: ${second.status}`);
      const beforeAbort = openFdCount();
      for await (const chunk of second.stream) {
        expect(chunk.length).toBeGreaterThan(0);
        break;
      }
      expect(openFdCount()).toBe(beforeAbort - 1);
    });
  });

  describe("verifiedExcerpt", () => {
    it("returns exact bytes with truncated false when under the cap", async () => {
      const { store } = await openStore();
      const bytes = "hello-excerpt-bytes";
      await publishReady(store, "up-excerpt", "artifact-excerpt", bytes);
      const excerpt = await store.verifiedExcerpt({
        artifactId: "artifact-excerpt",
        expectedSizeBytes: bytes.length,
        expectedDigest: sha256(bytes),
        maxBytes: VERIFIED_EXCERPT_MAX_BYTES,
      });
      expect(excerpt).toEqual({
        status: "ready",
        totalBytes: bytes.length,
        truncated: false,
        content: Buffer.from(bytes),
      });
    });

    it("truncates to maxBytes with a truthful flag and never returns more", async () => {
      const { store } = await openStore();
      const bytes = "x".repeat(VERIFIED_EXCERPT_MAX_BYTES + 100);
      await publishReady(store, "up-excerpt-big", "artifact-excerpt-big", bytes);
      const excerpt = await store.verifiedExcerpt({
        artifactId: "artifact-excerpt-big",
        expectedSizeBytes: bytes.length,
        expectedDigest: sha256(bytes),
        maxBytes: VERIFIED_EXCERPT_MAX_BYTES,
      });
      if (excerpt.status !== "ready") throw new Error(`expected ready: ${excerpt.status}`);
      expect(excerpt.totalBytes).toBe(bytes.length);
      expect(excerpt.truncated).toBe(true);
      expect(excerpt.content.length).toBe(VERIFIED_EXCERPT_MAX_BYTES);
      expect(excerpt.content.equals(Buffer.from(bytes.slice(0, VERIFIED_EXCERPT_MAX_BYTES)))).toBe(
        true,
      );
    });

    it("rejects oversized maxBytes without touching the filesystem", async () => {
      const { store } = await openStore();
      await expect(
        store.verifiedExcerpt({
          artifactId: "artifact-excerpt",
          expectedSizeBytes: 0,
          expectedDigest: sha256(""),
          maxBytes: VERIFIED_EXCERPT_MAX_BYTES + 1,
        }),
      ).resolves.toEqual({ status: "corrupt", code: "invalid_download_request" });
    });
  });
});
