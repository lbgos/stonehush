import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { buildStorageBackedApp } from "./runtime.js";

it("boots production serving through the storage-backed async factory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "stonehush-packaged-startup-"));
  const headers = { host: "127.0.0.1:8787", accept: "text/html" };
  try {
    const directory = path.join(root, "web");
    await mkdir(directory);
    await writeFile(path.join(directory, "index.html"), "<!doctype html><title>Stonehush</title>");
    const app = await buildStorageBackedApp(path.join(root, "data"), {
      productionWeb: { directory, port: 8787 },
    });
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      expect((await app.inject({ url: "/engagements/synthetic/notes", headers })).statusCode).toBe(200);
      expect((await app.inject({ url: "/health", headers })).json()).toEqual({ status: "ok" });
      const engagements = await app.inject({ url: "/api/v1/engagements", headers });
      expect(engagements.statusCode).toBe(200);
      expect(engagements.headers["content-type"]).toMatch(/^application\/json/);
      expect((await app.inject({ url: "/api/v1/missing", headers })).statusCode).toBe(404);
      expect((await app.inject({ url: "/", headers: { host: "attacker.test" } })).statusCode).toBe(403);
    } finally {
      await app.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
