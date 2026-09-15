import { apiPortFromEnvironment, dataDirectoryFromEnvironment } from "./config.js";
import { buildStorageBackedApp } from "./runtime.js";
import type { FastifyInstance } from "fastify";

const HOST = "127.0.0.1";

async function main(): Promise<void> {
  let app: FastifyInstance | undefined;
  let closePromise: Promise<void> | undefined;

  function closeOnce(): Promise<void> {
    closePromise ??= app?.close() ?? Promise.resolve();
    return closePromise;
  }

  async function shutdown(): Promise<void> {
    try {
      await closeOnce();
    } catch {
      console.error("Failed to stop the API cleanly.");
      process.exitCode = 1;
    }
  }

  try {
    const port = apiPortFromEnvironment(process.env);
    const dataDirectory = dataDirectoryFromEnvironment(process.env);
    app = await buildStorageBackedApp(dataDirectory);
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
    await app.listen({ host: HOST, port });
    console.log(`Stonehush API listening at http://${HOST}:${port}`);
  } catch {
    console.error("Stonehush API failed to start. Check its configuration and development storage.");
    process.exitCode = 1;
    await closeOnce();
  }
}

await main();
