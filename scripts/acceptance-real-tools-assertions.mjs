import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export function assertDownload(artifact, bytes, runId) {
  assert.equal(artifact.runId, runId);
  assert.equal(bytes.length, artifact.sizeBytes);
  assert.equal(sha256(bytes), artifact.digest);
}

export function assertToolProcess(tool, executable, argv, { port, origin, wordlist }) {
  assert.equal(executable, `/usr/bin/${tool}`);
  assert.equal(argv[0], executable);
  if (tool === "nmap") {
    assert.deepEqual(argv.slice(1, 11), ["-sT", "-sV", "-T4", "-Pn", "--version-intensity", "7", "--max-retries", "2", "-p", String(port)]);
    assert.equal(argv[11], "-oX");
    assert.ok(argv[12].startsWith("/") && argv[12].endsWith(".xml"));
    assert.deepEqual(argv.slice(13), ["127.0.0.1"]);
  } else {
    assert.equal(tool, "ffuf");
    assert.deepEqual(argv.slice(1, 6), ["-u", `${origin}/FUZZ`, "-w", wordlist, "-o"]);
    assert.ok(argv[6].startsWith("/") && argv[6].endsWith(".json"));
    assert.deepEqual(argv.slice(7), ["-of", "json", "-t", "1", "-timeout", "30", "-maxtime", "45", "-mc", "200", "-s"]);
  }
}

export function assertContinued(before, after) {
  assert.equal(before.action.state, "paused_for_warning");
  assert.equal(after.action.state, "queued");
  assert.equal(after.action.warningInteractions, 1);
  assert.equal(after.action.warningAcknowledgment.source, "operator_continue");
  assert.equal(after.action.warningAcknowledgment.snapshotBinding, before.action.snapshots[0].binding);
  assert.deepEqual(after.action.snapshots, before.action.snapshots);
}

export function assertFindingReferences(expected, created, reported) {
  assert.equal(expected.length, 3);
  assert.equal(new Set(expected).size, 3);
  assert.deepEqual([...created].sort(), [...expected].sort());
  assert.deepEqual([...reported].sort(), [...expected].sort());
}

export function assertCancelledRequest({ startedAt, closedAt, deadlineExpired, normalResponse }, cancelledAt, finishedAt) {
  assert.equal(deadlineExpired, false);
  assert.equal(normalResponse, false);
  assert.ok(cancelledAt >= startedAt && cancelledAt - startedAt < 5000, "Slow request must be fresh when cancelled.");
  assert.ok(closedAt >= cancelledAt && closedAt <= finishedAt, "Connection must close after cancellation.");
  // The process argv has a 30-second request timeout and 45-second max time.
  // Finishing within 25 seconds of request start excludes both natural exits.
  assert.ok(finishedAt - startedAt < 25000, "Cleanup must precede ffuf's own deadlines.");
}

// Published operator output from the synthetic action, never service logs or
// configuration. Redact before taking the excerpt so a boundary cannot split a secret.
export function realToolFailureDiagnostic(output, actionId, runId, secret) {
  assert.equal(output.run.actionId, actionId);
  assert.equal(output.run.id, runId);
  const { id, state, terminalKind, terminalReason } = output.run;
  const diagnostic = { run: { id, actionId, state, terminalKind, terminalReason } };
  for (const name of ["stdout", "stderr"]) {
    const stream = output[name];
    if (!stream.present) { diagnostic[name] = { present: false }; continue; }
    const content = secret ? stream.content.replaceAll(secret, "[redacted]") : stream.content;
    const { artifactId, digest, sizeBytes, completeness, truncated } = stream;
    diagnostic[name] = { present: true, artifactId, digest, sizeBytes, completeness, truncated, content: content.slice(0, 4096), excerptTruncated: content.length > 4096 };
  }
  return diagnostic;
}
