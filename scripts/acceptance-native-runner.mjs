import assert from "node:assert/strict";

// CI-only launcher. Credentials arrive through stdin, never argv or files.
console.log(`native pid ${process.pid}`);
let stage = "uid";
try {
  assert.equal(process.getuid(), 10002);
  console.log("native stage uid");
  stage = "modules";
  const { createRunnerLoop, handshake } = await import("../apps/runner/dist/runner.js");
  const { resolveRunnerConfig } = await import("../apps/runner/dist/config.js");
  console.log("native stage modules");
  stage = "stdin";
  const input = [];
  for await (const chunk of process.stdin) input.push(chunk);
  const config = JSON.parse(Buffer.concat(input).toString("utf8"));
  console.log("native stage stdin");
  stage = "handshake";
  // The loop retries silently. Diagnose its first handshake before starting it.
  await handshake(resolveRunnerConfig(config), AbortSignal.timeout(5000));
  console.log("native stage preflight");
  const loop = createRunnerLoop(config, { onHandshake() { console.log("handshake accepted"); } });
  process.on("SIGTERM", () => { void loop.stop(); });
  loop.start();
} catch (error) {
  // Never print raw errors, response bodies, credentials or filesystem paths.
  const status = /^handshake failed (\d{3}):/.exec(String(error.message))?.[1];
  const code = ["EACCES", "ENOENT", "ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_DLOPEN_FAILED", "TimeoutError"].find((value) => value === error.code || value === error.name) ?? "other";
  console.log(`native failure stage=${stage} code=${status ?? code}`);
  process.exitCode = 1;
}
