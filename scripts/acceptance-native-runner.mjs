import assert from "node:assert/strict";
import { createRunnerLoop } from "../apps/runner/dist/runner.js";

// CI-only launcher. Credentials arrive through stdin, never argv or files.
assert.equal(process.getuid(), 10002);
console.log(`native pid ${process.pid}`);
const input = [];
for await (const chunk of process.stdin) input.push(chunk);
const config = JSON.parse(Buffer.concat(input).toString("utf8"));
const loop = createRunnerLoop(config, { onHandshake() { console.log("handshake accepted"); } });
process.on("SIGTERM", () => { void loop.stop(); });
loop.start();
