import assert from "node:assert/strict";
import test from "node:test";
import { assertCancelledRequest, assertContinued, assertDownload, assertFindingReferences, assertToolProcess, realToolFailureDiagnostic, sha256 } from "./acceptance-real-tools-assertions.mjs";

test("published bytes require exact run association, length and digest", () => {
  const bytes = Buffer.from("synthetic partial bytes {");
  const artifact = { runId: "run-1", sizeBytes: bytes.length, digest: sha256(bytes) };
  assertDownload(artifact, bytes, "run-1");
  for (const changed of [{ runId: "other" }, { sizeBytes: 1 }, { digest: sha256(Buffer.from("other")) }]) {
    assert.throws(() => assertDownload({ ...artifact, ...changed }, bytes, "run-1"));
  }
  assert.throws(() => assertDownload(artifact, Buffer.concat([bytes, bytes]), "run-1"));
});

test("real process proof rejects shims, extra targets, wider scans and unbounded ffuf options", () => {
  const nmap = ["/usr/bin/nmap", "-sT", "-sV", "-T4", "-Pn", "--version-intensity", "7", "--max-retries", "2", "-p", "12345", "-oX", "/private/run/nmap.xml", "127.0.0.1"];
  const options = { port: 12345, origin: "http://127.0.0.1:12345", wordlist: "/private/tiny.txt" };
  assertToolProcess("nmap", nmap[0], nmap, options);
  assert.throws(() => assertToolProcess("nmap", "/tmp/nmap", nmap, options));
  assert.throws(() => assertToolProcess("nmap", nmap[0], [...nmap, "192.0.2.1"], options));
  assert.throws(() => assertToolProcess("nmap", nmap[0], nmap.map((s) => s === "12345" ? "1-65535" : s), options));
  const ffuf = ["/usr/bin/ffuf", "-u", `${options.origin}/FUZZ`, "-w", options.wordlist, "-o", "/private/run/ffuf.json", "-of", "json", "-t", "1", "-timeout", "30", "-maxtime", "45", "-mc", "200", "-s"];
  assertToolProcess("ffuf", ffuf[0], ffuf, options);
  assert.throws(() => assertToolProcess("ffuf", ffuf[0], [...ffuf, "-rate", "100"], options));
  assert.throws(() => assertToolProcess("ffuf", ffuf[0], ffuf.map((s) => s === "1" ? "200" : s), options));
});

test("Continue proof requires one acknowledgment and unchanged exact snapshot", () => {
  const snapshot = { binding: "sha256:fixture", canonicalTargets: ["127.0.0.1"], scopeRevisionId: null };
  const before = { action: { state: "paused_for_warning", snapshots: [snapshot] } };
  const after = { action: { state: "queued", warningInteractions: 1, snapshots: [snapshot], warningAcknowledgment: { source: "operator_continue", snapshotBinding: snapshot.binding } } };
  assertContinued(before, after);
  assert.throws(() => assertContinued(before, { action: { ...after.action, warningInteractions: 2 } }));
  assert.throws(() => assertContinued(before, { action: { ...after.action, snapshots: [{ ...snapshot, scopeRevisionId: "changed" }] } }));
});

test("real-tool entrypoint refuses local execution before account or service work", async () => {
  const { spawnSync } = await import("node:child_process");
  const entry = new URL("./accept-real-tools.mjs", import.meta.url);
  const result = spawnSync(process.execPath, [entry.pathname], { env: { PATH: "/usr/bin:/bin", GITHUB_ACTIONS: "false", RUNNER_ENVIRONMENT: "github-hosted" }, encoding: "utf8", timeout: 5000 });
  assert.notEqual(result.status, 0);
  assert.equal(result.error, undefined);
  assert.match(result.stderr, /AssertionError/);
});


test("finding and report must retain all three requested artifact references", () => {
  const expected = ["nmap", "probe", "ffuf"];
  assertFindingReferences(expected, [...expected].reverse(), expected);
  for (const links of [[], ["nmap"], ["nmap", "probe", "other"], ["nmap", "probe", "ffuf", "ffuf"]]) {
    assert.throws(() => assertFindingReferences(expected, links, links));
    assert.throws(() => assertFindingReferences(expected, expected, links));
  }
});

test("cancellation cannot pass on a normal response, stale request or tool timeout", () => {
  const request = { startedAt: 1000, closedAt: 12000, deadlineExpired: false, normalResponse: false };
  assertCancelledRequest(request, 2000, 12500);
  for (const change of [{ normalResponse: true }, { deadlineExpired: true }, { startedAt: -21000 }, { closedAt: 1500 }]) {
    assert.throws(() => assertCancelledRequest({ ...request, ...change }, 2000, 12500));
  }
  assert.throws(() => assertCancelledRequest(request, 2000, 31000));
});

test("failure diagnostics retain bounded tool output only for the exact failed action and run", () => {
  const secret = "synthetic-private-credential";
  const stream = { present: true, artifactId: "stderr", digest: sha256(Buffer.from("output")), sizeBytes: 10000, completeness: "complete", truncated: false, content: `${"x".repeat(4080)}${secret}${"y".repeat(10000)}`, unexpected: secret };
  const output = { run: { id: "run-1", actionId: "action-1", state: "failed", terminalKind: "failed", terminalReason: "ffuf_parse_error", unexpected: secret }, stdout: { present: false, content: "" }, stderr: stream, unexpected: secret };
  const diagnostic = realToolFailureDiagnostic(output, "action-1", "run-1", secret);
  assert.equal(diagnostic.run.terminalReason, "ffuf_parse_error");
  assert.equal(diagnostic.stderr.content.length, 4096);
  assert.equal(diagnostic.stderr.excerptTruncated, true);
  assert.equal(diagnostic.stderr.content.includes("[redacted]"), true);
  assert.equal(JSON.stringify(diagnostic).includes(secret), false);
  assert.equal(diagnostic.run.unexpected, undefined);
  assert.equal(diagnostic.stderr.unexpected, undefined);
  assert.throws(() => realToolFailureDiagnostic(output, "other-action", "run-1", secret));
  assert.throws(() => realToolFailureDiagnostic(output, "action-1", "other-run", secret));
});
