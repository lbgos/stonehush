import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// CDP error messages and evaluated page content are untrusted. Retain only a
// fixed failure category, never exception descriptions, URLs or document text.
async function evaluate(send, params) {
  const response = await send("Runtime.evaluate", params);
  if (!response || typeof response !== "object") throw new Error("Chrome CDP evaluation failed: missing response.");
  if (response.error) throw new Error("Chrome CDP evaluation failed: protocol error.");
  if (response.exceptionDetails) throw new Error("Chrome CDP evaluation failed: exception details.");
  if (!response.result || typeof response.result !== "object") throw new Error("Chrome CDP evaluation failed: missing result.");
  return response.result;
}

export async function waitForScreenshotState(send, pause = delay) {
  for (let attempt = 0; attempt < 100; attempt++) {
    // A newly navigated document can exist before its root element does.
    const result = await evaluate(send, { expression: "JSON.stringify(document.documentElement ? {ready:document.readyState,text:document.body?.innerText,background:getComputedStyle(document.documentElement).backgroundColor,theme:document.documentElement.dataset.theme,family:document.documentElement.dataset.themeFamily} : {ready:document.readyState})", returnByValue: true });
    if (typeof result.value !== "string") throw new Error("Chrome CDP readiness failed: missing string value.");
    let state;
    try { state = JSON.parse(result.value); } catch { throw new Error("Chrome CDP readiness failed: malformed JSON."); }
    if (!state || typeof state !== "object" || !["loading", "interactive", "complete"].includes(state.ready) || ["text", "background", "theme", "family"].some((key) => state[key] !== undefined && typeof state[key] !== "string")) throw new Error("Chrome CDP readiness failed: invalid state.");
    if (state.ready === "complete" && state.text?.includes("Compose acceptance") && state.background === "rgb(0, 0, 0)" && state.theme === "dark" && state.family === "smoked") return state;
    await pause(100);
  }
  throw new Error("Chrome CDP readiness timed out after 100 attempts: render, document completion or theme requirements unmet.");
}

// Use the disposable runner's installed Chrome through CDP. No browser package
// or download is needed. Screenshots require owner inspection before acceptance.
export async function screenshots(url, output, profile) {
  const chrome = spawn("google-chrome", ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", shell: false });
  let socket;
  try {
    let port;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { port = Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); break; } catch { await delay(100); }
    }
    assert.ok(port, "Installed Chrome did not expose CDP.");
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    socket = new WebSocket(tabs.find((tab) => tab.type === "page").webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    let id = 0;
    const pending = new Map();
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      const operation = pending.get(message.id);
      if (!operation) return;
      pending.delete(message.id);
      clearTimeout(operation.timer);
      if (message.error) operation.reject(new Error(`Chrome CDP command failed: ${operation.method}.`));
      else operation.resolve(message.result);
    });
    function send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Chrome timed out: ${method}`)); }, 15000);
        pending.set(requestId, { resolve, reject, timer, method });
        socket.send(JSON.stringify({ id: requestId, method, params }));
      });
    }
    const evidence = [];
    await send("Page.enable");
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    for (const [width, height] of [[1440, 900], [1000, 900], [390, 844]]) {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await send("Page.navigate", { url });
      const state = await waitForScreenshotState(send);
      assert.ok(state.text?.includes("Compose acceptance"), "The packaged app did not render its synthetic engagement.");
      assert.equal(state.theme, "dark");
      assert.equal(state.family, "smoked");
      assert.equal(state.background, "rgb(0, 0, 0)");
      await evaluate(send, { expression: "document.fonts.ready", awaitPromise: true });
      const filename = `packaged-${width}x${height}.png`;
      const result = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      await writeFile(path.join(output, filename), Buffer.from(result.data, "base64"), { flag: "wx", mode: 0o600 });
      evidence.push({ filename, width, height, theme: state.theme, family: state.family, background: state.background, deviceScaleFactor: 1, emulatedMobileHardware: false });
    }
    return { screenshots: evidence, ownerAppearanceReview: "pending", source: "exact image served on loopback", browser: "GitHub runner installed Chrome" };
  } finally {
    socket?.close();
    chrome.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => chrome.once("exit", resolve)), delay(5000)]);
    if (chrome.exitCode === null) chrome.kill("SIGKILL");
  }
}
