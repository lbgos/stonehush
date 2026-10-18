import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeStderrDiagnostics } from "./acceptance-native-diagnostics.mjs";

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
