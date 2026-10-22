import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { waitForScreenshotState } from "./acceptance-screenshots.mjs";

const ready = { ready: "complete", text: "Compose acceptance", background: "rgb(0, 0, 0)", theme: "dark", family: "smoked" };
const reply = (state) => ({ result: { type: "string", value: JSON.stringify(state) } });
const privateText = "secret /private/fixture <html>private</html> https://synthetic.invalid/token";
const noWait = async (milliseconds) => assert.equal(milliseconds, 100);

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
