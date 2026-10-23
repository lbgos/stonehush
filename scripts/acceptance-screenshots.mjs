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

export async function waitForChromePort(chrome, profile, pause = delay) {
  let spawnFailure;
  let stderr = "";
  const categories = new Set();
  const onError = (error) => { spawnFailure = ["ENOENT", "EACCES", "EPERM"].includes(error.code) ? error.code : "other"; };
  const onData = (chunk) => {
    // Only fixed categories survive. Bound even a single oversized output chunk.
    stderr = (stderr + chunk.subarray(-4096).toString()).slice(-4096);
    if (/No usable sandbox|SUID sandbox|Running as root without --no-sandbox|Failed to move to new namespace|InitializeSandbox.*failed/i.test(stderr)) categories.add("sandbox");
    if (/error while loading shared libraries/i.test(stderr)) categories.add("missing-library");
    if (/ProcessSingleton|SingletonLock|Failed to create.*(?:user data|profile)/i.test(stderr)) categories.add("profile");
    if (/FATAL|Trace\/breakpoint trap|Segmentation fault/i.test(stderr)) categories.add("fatal");
  };
  chrome.on("error", onError);
  chrome.stderr?.on("data", onData);
  const diagnostic = () => `exit=${Number.isInteger(chrome.exitCode) ? chrome.exitCode : "none"}, signal=${["SIGABRT", "SIGBUS", "SIGILL", "SIGKILL", "SIGSEGV", "SIGTERM", "SIGTRAP"].includes(chrome.signalCode) ? chrome.signalCode : "none"}, stderr=${[...categories].sort().join(",") || (stderr ? "other" : "none")}`;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (spawnFailure) throw new Error(`Chrome CDP startup failed: spawn=${spawnFailure}.`);
      if (chrome.exitCode !== null || chrome.signalCode !== null) throw new Error(`Chrome CDP startup failed: ${diagnostic()}.`);
      let value;
      try { value = await readFile(path.join(profile, "DevToolsActivePort"), "utf8"); } catch (error) {
        if (error.code !== "ENOENT") throw new Error("Chrome CDP startup failed: port file unreadable.");
      }
      if (value !== undefined) {
        const port = Number(value.split("\n")[0]);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Chrome CDP startup failed: invalid port file.");
        return port;
      }
      await pause(100);
    }
    throw new Error(`Chrome CDP startup timed out after 100 attempts: ${diagnostic()}.`);
  } finally {
    chrome.off("error", onError);
    chrome.stderr?.off("data", onData);
    chrome.stderr?.resume();
  }
}

// Use the disposable runner's installed Chrome through CDP. No browser package
// or download is needed. Screenshots require owner inspection before acceptance.
export async function screenshots(url, output, profile) {
  const chrome = spawn("google-chrome", ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"], shell: false });
  let socket;
  try {
    const port = await waitForChromePort(chrome, profile);
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
    if (chrome.pid && chrome.exitCode === null && chrome.signalCode === null) {
      const exited = new Promise((resolve) => chrome.once("exit", resolve));
      chrome.kill("SIGTERM");
      await Promise.race([exited, delay(5000)]);
      if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill("SIGKILL");
    }
  }
}
