import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { nativeEntryPreflight, nativeStderrDiagnostics } from "./acceptance-native-diagnostics.mjs";

test("inline native preflight distinguishes exact entry bytes, missing input and denied traversal without exposing paths or content", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "stonehush-entry-test-"));
  const scripts = path.join(temporary, "scripts");
  const entry = path.join(scripts, "acceptance-native-runner.mjs");
  const bytes = "private synthetic content";
  const digest = createHash("sha256").update(bytes).digest("hex");
  const source = `console.log(JSON.stringify(await (${nativeEntryPreflight.toString()})(process.argv[1], process.argv[2])));`;
  const probe = (expected = digest, checkout = temporary) => {
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", source, checkout, expected], {
      cwd: temporary, encoding: "utf8", timeout: 5000,
      ...(process.getuid() === 0 ? { uid: 10002, gid: 10002 } : {}),
    });
    assert.equal(child.status, 0);
    assert.equal(child.stderr, "");
    assert.equal(child.stdout.includes(temporary), false);
    assert.equal(child.stdout.includes(bytes), false);
    assert.equal(child.stdout.includes(digest), false);
    return JSON.parse(child.stdout);
  };
  try {
    await chmod(temporary, 0o755);
    await mkdir(scripts, { mode: 0o755 });
    assert.equal(probe().entry, "ENOENT");
    await writeFile(entry, bytes, { mode: 0o644 });
    const present = probe();
    assert.equal(present.cwdMatches, true);
    assert.equal(present.entry, "file");
    assert.equal(present.entryRead, "ok");
    assert.equal(present.digestMatches, true);
    assert.equal(probe("mismatch").digestMatches, false);
    await chmod(scripts, 0o700);
    // A nonroot test owns its fixture, so remove all search bits for that case.
    if (process.getuid() !== 0) await chmod(scripts, 0o600);
    const denied = probe();
    assert.equal(denied.scripts, "EACCES");
    assert.equal(denied.entryRead, "EACCES");
    assert.equal(denied.digestMatches, false);
    await chmod(scripts, 0o755);
    await chmod(entry, 0o000);
    const unreadable = probe();
    assert.equal(unreadable.entry, "file");
    assert.equal(unreadable.entryRead, "EACCES");
    assert.equal(unreadable.digestMatches, false);
    await rm(entry);
    await symlink("/synthetic-private-target", entry);
    const linked = probe();
    assert.equal(linked.entry, "symlink");
    assert.equal(linked.digestMatches, false);
    await rm(scripts, { recursive: true });
    const actualScripts = path.join(temporary, "actual-scripts");
    await mkdir(actualScripts, { mode: 0o755 });
    await writeFile(path.join(actualScripts, "acceptance-native-runner.mjs"), bytes, { mode: 0o644 });
    await symlink(actualScripts, scripts);
    const linkedDirectory = probe();
    assert.equal(linkedDirectory.ancestorSymlink, true);
    assert.equal(linkedDirectory.entryRead, "skipped");
    assert.equal(linkedDirectory.digestMatches, false);
    const checkoutLink = path.join(temporary, "checkout-link");
    await symlink(temporary, checkoutLink);
    const linkedCheckout = probe(digest, checkoutLink);
    assert.equal(linkedCheckout.ancestorSymlink, true);
    assert.equal(linkedCheckout.entryRead, "skipped");
    assert.equal(linkedCheckout.digestMatches, false);
  } finally {
    // Remove the directory link itself, without following it during cleanup.
    if ((await lstat(scripts).catch(() => undefined))?.isDirectory()) await chmod(scripts, 0o755);
    await rm(scripts, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
});

test("native pre-entry diagnostics classify chunked wrapper failures without retaining private text", () => {
  for (const [line, source, code] of [
    ["sudo: private-secret: Permission denied", "sudo", "permission-denied"],
    ["setpriv: failed to execute /private/entry: No such file or directory", "setpriv", "not-found"],
    ["Failed to start transient scope unit: Access denied", "systemd", "permission-denied"],
    ["Failed to connect to bus: private-error", "systemd", "bus-unavailable"],
  ]) {
    const diagnostic = nativeStderrDiagnostics();
    // Every boundary, including a split prefix and missing final newline.
    for (const character of line) diagnostic.append(character);
    diagnostic.finish();
    diagnostic.finish();
    assert.deepEqual(diagnostic.result, { sources: [source], codes: [code] });
    assert.equal(JSON.stringify(diagnostic.result).includes("private"), false);
  }
});

test("native pre-entry diagnostics retain allowlisted Node codes and reject diagnostic text as protocol", () => {
  const diagnostic = nativeStderrDiagnostics();
  diagnostic.append("node:internal/modules/cjs/loader:123\nError: Cannot find module '/private/entry'\n");
  diagnostic.append("  code: 'MODULE_NOT_");
  diagnostic.append("FOUND',\n  code: 'PRIVATE_SECRET',\nnative stage uid\nhandshake accepted\nprivate-secret");
  diagnostic.finish();
  assert.deepEqual(diagnostic.result, { sources: ["node", "other"], codes: ["other", "not-found", "MODULE_NOT_FOUND"] });
  assert.equal(JSON.stringify(diagnostic.result).includes("private"), false);
  assert.equal(JSON.stringify(diagnostic.result).includes("handshake"), false);
  assert.equal(JSON.stringify(diagnostic.result).includes("uid"), false);
});
