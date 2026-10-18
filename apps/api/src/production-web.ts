import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Assets come from the read-only image, never the data volume. Snapshot them
// before listening so requests never turn URL paths into filesystem opens.
export async function registerProductionWeb(
  app: FastifyInstance,
  directory: string,
  port: number,
): Promise<void> {
  const assets = new Map<string, { bytes: Buffer; type: string }>();
  let totalBytes = 0;
  async function collect(relative = ""): Promise<void> {
    const current = path.join(directory, relative);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe web directory.");
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (!/^[A-Za-z0-9_@.-]+$/.test(entry.name) || entry.name.startsWith(".")) {
        throw new Error("Unsafe web asset name.");
      }
      const name = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await collect(name);
        continue;
      }
      if (!entry.isFile()) throw new Error("Unsafe web asset.");
      const file = await open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        totalBytes += stat.size;
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024 || totalBytes > 64 * 1024 * 1024) {
          throw new Error("Unsafe web asset.");
        }
        assets.set(`/${name}`, {
          bytes: await file.readFile(),
          type: MIME_TYPES[path.extname(name)] ?? "application/octet-stream",
        });
      } finally {
        await file.close();
      }
    }
  }
  await collect();
  const index = assets.get("/index.html");
  if (index === undefined) throw new Error("Missing production web index.");

  const authorities = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  app.addHook("onRequest", async (request, reply) => {
    const host = request.headers.host;
    const origin = request.headers.origin;
    // trustProxy stays disabled. Neither forwarding headers nor DNS names
    // supplied by a remote page establish local operator authority.
    if (
      request.ip !== "127.0.0.1" ||
      request.raw.rawHeaders.filter((value, offset) => offset % 2 === 0 && value.toLowerCase() === "host").length !== 1 ||
      host === undefined || !authorities.has(host) ||
      (origin !== undefined && origin !== `http://${host}`) ||
      request.headers["sec-fetch-site"] === "cross-site"
    ) {
      return reply.code(403).type("application/json").send({ code: "local_origin_required" });
    }
  });

  app.setNotFoundHandler(async (request, reply) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(request.raw.url?.split("?")[0] ?? "");
    } catch {
      return reply.code(400).send({ code: "invalid_request" });
    }
    if (
      !pathname.startsWith("/") || /[\\%\0]/.test(pathname) ||
      (pathname !== "/" && pathname.slice(1).split("/").some((segment) => segment.startsWith(".") || segment === ""))
    ) {
      return reply.code(404).send({ code: "not_found" });
    }
    if (
      (request.method !== "GET" && request.method !== "HEAD") ||
      /^\/(?:api|health)(?:\/|$)/i.test(pathname)
    ) {
      return reply.code(404).send({ code: "not_found" });
    }
    const asset = assets.get(pathname);
    const spa = asset === undefined &&
      !pathname.startsWith("/assets/") && !pathname.startsWith("/brand/") &&
      !pathname.includes(".") &&
      (pathname === "/" || (request.headers.accept ?? "").split(",").some((value) => value.trim() === "text/html"));
    const selected = asset ?? (spa ? index : undefined);
    if (selected === undefined) return reply.code(404).send({ code: "not_found" });
    return reply.code(200)
      .header("cache-control", "no-cache")
      .header("x-content-type-options", "nosniff")
      .header("content-length", selected.bytes.length)
      .type(selected.type).send(request.method === "HEAD" ? undefined : selected.bytes);
  });
}
