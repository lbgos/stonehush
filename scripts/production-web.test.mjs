import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { registerProductionWeb } from "../apps/api/src/production-web.ts";

const Fastify = createRequire(new URL("../apps/api/package.json", import.meta.url))("fastify");
const resources = [];
afterEach(async () => {
  for (const { app, directory } of resources.splice(0)) {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "stonehush-production-web-"));
  const app = Fastify();
  resources.push({ app, directory });
  await mkdir(path.join(directory, "assets"));
  await writeFile(path.join(directory, "index.html"), "<!doctype html><title>Stonehush</title>");
  await writeFile(path.join(directory, "assets/app.js"), "export const synthetic = true;");
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/api/v1/synthetic", async (_request, reply) => reply.code(503).send({ code: "storage_busy" }));
  return { app, directory };
}
const headers = { host: "127.0.0.1:8787", accept: "text/html" };

test("serves snapshotted same-origin assets and deep links, preserving real routes", async () => {
  const { app, directory } = await fixture();
  await registerProductionWeb(app, directory, 8787);
  for (const url of ["/", "/engagements/synthetic/notes", "/index.html"]) {
    const response = await app.inject({ url, headers });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"], /^text\/html/);
    assert.equal(response.headers["x-content-type-options"], "nosniff");
  }
  await writeFile(path.join(directory, "assets/app.js"), "changed after startup");
  const asset = await app.inject({ url: "/assets/app.js", headers });
  assert.equal(asset.statusCode, 200);
  assert.equal(asset.body, "export const synthetic = true;");
  assert.match(asset.headers["content-type"], /^text\/javascript/);
  const head = await app.inject({ method: "HEAD", url: "/assets/app.js", headers });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, "");
  const health = await app.inject({ url: "/health", headers });
  assert.deepEqual(health.json(), { status: "ok" });
  const failed = await app.inject({ url: "/api/v1/synthetic", headers });
  assert.equal(failed.statusCode, 503);
  assert.deepEqual(failed.json(), { code: "storage_busy" });
});

test("rejects foreign authorities, origins, peers and spoofed forwarding headers", async () => {
  const { app, directory } = await fixture();
  await registerProductionWeb(app, directory, 8787);
  for (const input of [
    { headers: { host: "attacker.test:8787" } },
    { headers: { host: "127.0.0.1:9999" } },
    { headers: { ...headers, origin: "http://attacker.test" } },
    { headers: { ...headers, origin: "null" } },
    { headers: { ...headers, origin: "http://localhost:8787" } },
    { headers: { ...headers, "sec-fetch-site": "cross-site" } },
    { headers: { ...headers, "x-forwarded-for": "127.0.0.1", "x-forwarded-host": headers.host }, remoteAddress: "192.0.2.1" },
  ]) {
    for (const url of ["/", "/health", "/api/v1/synthetic"]) {
      const response = await app.inject({ url, ...input });
      assert.equal(response.statusCode, 403);
      assert.deepEqual(response.json(), { code: "local_origin_required" });
    }
  }
  for (const host of ["127.0.0.1:8787", "localhost:8787"]) {
    assert.equal((await app.inject({ url: "/", headers: { ...headers, host, origin: `http://${host}` } })).statusCode, 200);
  }
});

test("never serves SPA success for API, missing assets, traversal or unsupported methods", async () => {
  const { app, directory } = await fixture();
  await registerProductionWeb(app, directory, 8787);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  for (const url of [
    "/api", "/api/v1/missing", "/API/v1/missing", "/health/missing",
    "/assets/missing", "/assets/missing.js", "/brand/missing", "/missing.js",
    "/%2e%2e/package.json", "/assets/%2e%2e/index.html", "/assets/%252e%252e/index.html",
    "/assets%5capp.js", "/.env", "/%00", "/assets//app.js", "/%ZZ",
  ]) {
    // The injection client normalizes dot segments. Send raw request targets
    // over a loopback socket to exercise the server's traversal boundary.
    const response = await new Promise((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port: address.port, path: url, headers }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ statusCode: res.statusCode, body }));
      });
      req.on("error", reject);
      req.end();
    });
    assert.ok(response.statusCode >= 400, `${url}: ${response.statusCode}`);
    assert.doesNotMatch(response.body, /<!doctype/);
  }
  assert.equal((await app.inject({ method: "POST", url: "/engagements/synthetic", headers })).statusCode, 404);
  assert.equal((await app.inject({ url: "/missing", headers: { host: headers.host, accept: "application/json" } })).statusCode, 404);
});

test("startup refuses linked, missing, or oversized web assets", async () => {
  for (const kind of ["symlink", "directory-link", "hardlink", "missing-index", "oversized"]) {
    const { app, directory } = await fixture();
    if (kind === "symlink") await symlink("app.js", path.join(directory, "assets/linked.js"));
    if (kind === "directory-link") await symlink("assets", path.join(directory, "linked"));
    if (kind === "hardlink") await link(path.join(directory, "assets/app.js"), path.join(directory, "assets/linked.js"));
    if (kind === "missing-index") await rm(path.join(directory, "index.html"));
    if (kind === "oversized") {
      const filename = path.join(directory, "assets/large.js");
      await writeFile(filename, "");
      await truncate(filename, 16 * 1024 * 1024 + 1);
    }
    await assert.rejects(registerProductionWeb(app, directory, 8787));
  }
});
