// Self-contained so inline Node can inspect an entry it cannot load as a file.
export async function nativeEntryPreflight(checkout, expectedDigest) {
  const { access, lstat, open, readFile } = await import("node:fs/promises");
  const { constants } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const { default: path } = await import("node:path");
  const code = (error) => ["ENOENT", "EACCES", "EPERM", "ENOTDIR", "ELOOP"].includes(error.code) ? error.code : "other";
  async function searchable(directory) {
    try { await access(directory, constants.X_OK); return "ok"; } catch (error) { return code(error); }
  }
  let ancestors = "ok";
  let ancestorSymlink = false;
  const scripts = path.join(checkout, "scripts");
  const directories = [];
  for (let directory = scripts; ; directory = path.dirname(directory)) {
    directories.unshift(directory);
    if (directory === path.dirname(directory)) break;
  }
  // Walk from the filesystem root and stop before following any directory link.
  for (const directory of directories) {
    const higherAncestor = directory !== checkout && directory !== scripts;
    try {
      if ((await lstat(directory)).isSymbolicLink()) { ancestorSymlink = true; break; }
    } catch (error) { if (higherAncestor) ancestors = code(error); break; }
    if (higherAncestor) {
      const result = await searchable(directory);
      if (result !== "ok") { ancestors = result; break; }
    }
  }
  const status = await readFile("/proc/self/status", "utf8");
  const result = {
    runtimeMatches: process.version === "v24.18.0",
    identityMatches: process.getuid() === 10002 && process.getgid() === 10002,
    supplementaryGroupsEmpty: /^Groups:[ \t]*$/m.test(status),
    capabilitiesEmpty: ["CapEff", "CapBnd"].every((field) => new RegExp(`^${field}:\\s+0+$`, "m").test(status)),
    noNewPrivileges: /^NoNewPrivs:\s+1$/m.test(status),
    cwdMatches: process.cwd() === checkout,
    ancestors, ancestorSymlink,
    checkout: ancestorSymlink ? "skipped" : await searchable(checkout),
    scripts: ancestorSymlink ? "skipped" : await searchable(scripts),
    entry: "other", entryRead: "other", digestMatches: false,
  };
  if (ancestorSymlink) { result.entryRead = "skipped"; return result; }
  const entry = path.join(checkout, "scripts/acceptance-native-runner.mjs");
  try {
    const info = await lstat(entry);
    result.entry = info.isFile() ? "file" : info.isSymbolicLink() ? "symlink" : "other";
    if (result.entry === "file" && info.size <= 65536) {
      const handle = await open(entry, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const bytes = Buffer.alloc(65537);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        result.entryRead = bytesRead <= 65536 ? "ok" : "other";
        result.digestMatches = bytesRead <= 65536 && createHash("sha256").update(bytes.subarray(0, bytesRead)).digest("hex") === expectedDigest;
      } finally { await handle.close(); }
    }
  } catch (error) { result.entryRead = code(error); if (result.entry === "other") result.entry = code(error); }
  return result;
}

// Keep pre-entry failures useful without retaining wrapper errors or paths.
export function nativeStderrDiagnostics() {
  const result = { sources: [], codes: [] };
  let pending = "";
  function record(line) {
    if (!line.trim()) return;
    const source = /^sudo:/.test(line) ? "sudo"
      : /^setpriv:/.test(line) ? "setpriv"
      : /^(?:systemd-run:|Failed to (?:start|create|connect|find|set|add|attach|resolve|execute))/.test(line) ? "systemd"
      : /^(?:node:|Error(?: \[|:)|\s+code: ')/.test(line) ? "node" : "other";
    if (!result.sources.includes(source)) result.sources.push(source);
    const explicit = /^\s+code: '(EACCES|EPERM|ENOENT|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ERR_DLOPEN_FAILED)'[,}]?$/.exec(line)?.[1]
      ?? /^Error \[(EACCES|EPERM|ENOENT|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ERR_DLOPEN_FAILED)\]:/.exec(line)?.[1];
    const code = explicit
      ?? (/Permission denied|Access denied|Operation not permitted/.test(line) ? "permission-denied"
        : /No such file or directory|Cannot find (?:module|package)/.test(line) ? "not-found"
        : /(?:connect to|Failed to connect).*bus/i.test(line) ? "bus-unavailable"
        : "other");
    if (!result.codes.includes(code)) result.codes.push(code);
  }
  return {
    result,
    append(chunk) {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) record(line);
    },
    finish() {
      record(pending);
      pending = "";
    },
  };
}
