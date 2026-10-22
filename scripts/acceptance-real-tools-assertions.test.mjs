import assert from "node:assert/strict";
import test from "node:test";
import { assertContinued, assertDownload, assertToolProcess, sha256 } from "./acceptance-real-tools-assertions.mjs";

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
