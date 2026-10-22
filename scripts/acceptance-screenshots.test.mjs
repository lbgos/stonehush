import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import vm from "node:vm";
import { waitForChromePort, waitForScreenshotState } from "./acceptance-screenshots.mjs";

const ready = { ready: "complete", text: "Compose acceptance", background: "rgb(0, 0, 0)", theme: "dark", family: "smoked" };
const reply = (state) => ({ result: { type: "string", value: JSON.stringify(state) } });
const privateText = "secret /private/fixture <html>private</html> https://synthetic.invalid/token";
const noWait = async (milliseconds) => assert.equal(milliseconds, 100);

async function startupFixture(t) {
  const profile = await mkdtemp(path.join(tmpdir(), "stonehush-chrome-startup-"));
  const chrome = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, stderr: new PassThrough() });
  t.after(async () => { chrome.stderr.destroy(); await rm(profile, { recursive: true, force: true }); });
  return { chrome, profile };
}

test("Chrome startup waits for a valid port without changing the polling deadline", async (t) => {
  const { chrome, profile } = await startupFixture(t);
  let pauses = 0;
  assert.equal(await waitForChromePort(chrome, profile, async (milliseconds) => {
    await noWait(milliseconds);
    pauses++;
    await writeFile(path.join(profile, "DevToolsActivePort"), "43210\n/devtools/browser/private");
  }), 43210);
  assert.equal(pauses, 1);
  assert.equal(chrome.stderr.listenerCount("data"), 0);
});

test("Chrome startup distinguishes spawn failure and early process exit without private output", async (t) => {
  for (const code of ["ENOENT", "EACCES", "EPERM", privateText]) {
    const { chrome, profile } = await startupFixture(t);
    await assert.rejects(waitForChromePort(chrome, profile, async () => {
      chrome.emit("error", Object.assign(new Error(privateText), { code }));
    }), new RegExp(`startup failed: spawn=${code === privateText ? "other" : code}\\.`));
  }
  for (const [message, category] of [
    ["No usable sandbox!", "sandbox"],
    ["error while loading shared libraries: private.so", "missing-library"],
    ["ProcessSingleton failed", "profile"],
    ["FATAL private location", "fatal"],
    [privateText, "other"],
  ]) {
    const { chrome, profile } = await startupFixture(t);
    await assert.rejects(waitForChromePort(chrome, profile, async () => {
      chrome.stderr.write(Buffer.alloc(100_000, 120));
      chrome.stderr.write(`${privateText}\n${message.slice(0, 8)}`);
      chrome.stderr.write(message.slice(8));
      chrome.exitCode = 1;
      chrome.signalCode = "SIGTRAP";
    }), (error) => {
      assert.equal(error.message, `Chrome CDP startup failed: exit=1, signal=SIGTRAP, stderr=${category}.`);
      assert.equal(error.message.includes(privateText), false);
      return true;
    });
  }
});

test("Chrome startup rejects invalid port files and preserves timeout failure", async (t) => {
  for (const value of ["", "0", "65536", "NaN", "1.5", privateText]) {
    const { chrome, profile } = await startupFixture(t);
    await writeFile(path.join(profile, "DevToolsActivePort"), value);
    await assert.rejects(waitForChromePort(chrome, profile, async () => assert.fail("Invalid ports must fail")), /startup failed: invalid port file/);
  }
  const { chrome, profile } = await startupFixture(t);
  let pauses = 0;
  await assert.rejects(waitForChromePort(chrome, profile, async (milliseconds) => { await noWait(milliseconds); pauses++; }), /startup timed out after 100 attempts: exit=none, signal=none, stderr=none/);
  assert.equal(pauses, 100);
});

test("startup diagnostics observe an actual failed child and keep its stderr private", async (t) => {
  const { profile } = await startupFixture(t);
  const chrome = spawn(process.execPath, ["-e", "process.stderr.write('No usable sandbox! private fixture path\\n', () => process.exit(7))"], { stdio: ["ignore", "ignore", "pipe"], shell: false });
  t.after(() => { if (chrome.exitCode === null) chrome.kill("SIGKILL"); });
  await assert.rejects(waitForChromePort(chrome, profile), { message: "Chrome CDP startup failed: exit=7, signal=none, stderr=sandbox." });
});

test("readiness evaluates a loading document without a root, then requires the rendered engagement and exact theme", async () => {
  let attempts = 0;
  let pauses = 0;
  const result = await waitForScreenshotState(async (method, params) => {
    assert.equal(method, "Runtime.evaluate");
    assert.equal(params.returnByValue, true);
    const document = attempts++ === 0
      ? { readyState: "loading", documentElement: null, body: null }
      : { readyState: "complete", documentElement: { dataset: { theme: "dark", themeFamily: "smoked" } }, body: { innerText: "Compose acceptance" } };
    const value = vm.runInNewContext(params.expression, { document, getComputedStyle: () => ({ backgroundColor: "rgb(0, 0, 0)" }) });
    return { result: { type: "string", value } };
  }, async (milliseconds) => { await noWait(milliseconds); pauses++; });
  assert.deepEqual(result, ready);
  assert.equal(attempts, 2);
  assert.equal(pauses, 1);
});

test("CDP failures stop immediately with distinct redacted diagnostics", async () => {
  for (const [response, diagnostic] of [
    [undefined, "missing response"],
    [null, "missing response"],
    [{}, "missing result"],
    [{ result: null }, "missing result"],
    [{ result: { type: "undefined" } }, "missing string value"],
    [{ result: { value: 42 } }, "missing string value"],
    [{ result: { value: privateText } }, "malformed JSON"],
    [{ result: { value: "null" } }, "invalid state"],
    [reply({ ...ready, text: {} }), "invalid state"],
    [reply({ ...ready, ready: privateText }), "invalid state"],
    [{ exceptionDetails: { text: privateText, exception: { description: privateText } }, result: { type: "undefined" } }, "exception details"],
    [{ error: { message: privateText }, result: reply(ready).result }, "protocol error"],
  ]) {
    let calls = 0;
    await assert.rejects(waitForScreenshotState(async () => { calls++; return response; }, async () => assert.fail("Errors must not be retried")), (error) => {
      assert.ok(error.message.includes(diagnostic));
      assert.equal(error.message.includes(privateText), false);
      assert.ok(error.message.length < 200);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("readiness retains its bounded wait and refuses each unmet screenshot requirement", async () => {
  for (const state of [
    { ready: "loading" },
    { ...ready, ready: "interactive" },
    { ...ready, text: privateText },
    { ...ready, theme: "light" },
    { ...ready, family: "other" },
    { ...ready, background: "rgb(1, 1, 1)" },
  ]) {
    let attempts = 0;
    let pauses = 0;
    await assert.rejects(waitForScreenshotState(async () => { attempts++; return reply(state); }, async (milliseconds) => { await noWait(milliseconds); pauses++; }), (error) => {
      assert.match(error.message, /readiness timed out after 100 attempts/);
      assert.equal(error.message.includes(privateText), false);
      return true;
    });
    assert.equal(attempts, 100);
    assert.equal(pauses, 100);
  }
});

test("a valid ready response passes immediately and transport timeouts remain failures", async () => {
  assert.deepEqual(await waitForScreenshotState(async () => reply(ready), async () => assert.fail("Ready must not wait")), ready);
  await assert.rejects(waitForScreenshotState(async () => { throw new Error("Chrome timed out: Runtime.evaluate"); }, noWait), /Chrome timed out: Runtime.evaluate/);
});
