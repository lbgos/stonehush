import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

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
      if (message.error) operation.reject(new Error("Chrome CDP command failed."));
      else operation.resolve(message.result);
    });
    function send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Chrome timed out: ${method}`)); }, 15000);
        pending.set(requestId, { resolve, reject, timer });
        socket.send(JSON.stringify({ id: requestId, method, params }));
      });
    }
    const evidence = [];
    await send("Page.enable");
    for (const [width, height] of [[1440, 900], [1000, 900], [390, 844]]) {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await send("Page.navigate", { url });
      let state;
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await send("Runtime.evaluate", { expression: "JSON.stringify({ready:document.readyState,text:document.body?.innerText,background:getComputedStyle(document.body).backgroundColor})", returnByValue: true });
        state = JSON.parse(result.result.value);
        if (state.ready === "complete" && state.text?.includes("Compose acceptance")) break;
        await delay(100);
      }
      assert.ok(state.text?.includes("Compose acceptance"), "The packaged app did not render its synthetic engagement.");
      await send("Runtime.evaluate", { expression: "document.fonts.ready", awaitPromise: true });
      const filename = `packaged-${width}x${height}.png`;
      const result = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      await writeFile(path.join(output, filename), Buffer.from(result.data, "base64"), { flag: "wx", mode: 0o600 });
      evidence.push({ filename, width, height, background: state.background, deviceScaleFactor: 1, emulatedMobileHardware: false });
    }
    return { screenshots: evidence, ownerAppearanceReview: "pending", source: "exact image served on loopback", browser: "GitHub runner installed Chrome" };
  } finally {
    socket?.close();
    chrome.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => chrome.once("exit", resolve)), delay(5000)]);
    if (chrome.exitCode === null) chrome.kill("SIGKILL");
  }
}
