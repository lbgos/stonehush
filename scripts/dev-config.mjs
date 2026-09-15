import path from "node:path";

const DEFAULT_API_PORT = 3001;
const DEFAULT_WEB_PORT = 5173;

function readPort(environment, name, defaultPort) {
  const rawPort = environment[name];
  if (rawPort === undefined) return defaultPort;
  if (!/^[0-9]+$/.test(rawPort)) {
    throw new Error(`${name} must be a decimal integer from 1 through 65535.`);
  }

  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be a decimal integer from 1 through 65535.`);
  }
  return port;
}

function readDataDirectory(environment, repositoryRoot) {
  const rawDataDirectory = environment.STONEHUSH_DATA_DIR;
  if (rawDataDirectory === undefined) return path.join(repositoryRoot, ".stonehush", "dev");
  if (
    rawDataDirectory.length === 0 ||
    rawDataDirectory.includes("\0") ||
    !path.isAbsolute(rawDataDirectory)
  ) {
    throw new Error("STONEHUSH_DATA_DIR must be a non-empty absolute path without NUL bytes.");
  }
  return path.resolve(rawDataDirectory);
}

export function readDevConfig(environment, repositoryRoot) {
  if (!path.isAbsolute(repositoryRoot)) {
    throw new Error("The development repository root must be absolute.");
  }
  const apiPort = readPort(environment, "STONEHUSH_API_PORT", DEFAULT_API_PORT);
  const webPort = readPort(environment, "STONEHUSH_WEB_PORT", DEFAULT_WEB_PORT);
  if (apiPort === webPort) {
    throw new Error("STONEHUSH_API_PORT and STONEHUSH_WEB_PORT must use different ports.");
  }
  return {
    apiPort,
    dataDirectory: readDataDirectory(environment, repositoryRoot),
    webPort,
  };
}
