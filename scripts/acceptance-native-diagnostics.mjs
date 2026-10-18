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
