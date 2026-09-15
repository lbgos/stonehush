import { FfufActionOptionsSchema } from "@stonehush/contracts";

/**
 * Build deterministic ffuf discovery argv. No shell strings; each argv
 * element is one literal string, so origins with spaces or metacharacters
 * stay a single element.
 *
 * Fixed order (verified against ffuf 1.1.0 on this host):
 * ffuf, -u <origin>/FUZZ, -w <wordlist>, -o <jsonPath>, -of json,
 * -t <threads>, -timeout <seconds>, -maxtime <seconds>, -mc <csv>, -s
 *
 * Two deliberate omissions, both verified against `ffuf -h`:
 * - `-rate` is rejected by ffuf 1.1.0
 *   ("flag provided but not defined: -rate"). The rate option is still
 *   validated for forward compatibility, but never emitted.
 * - `-noninteractive` does not exist in ffuf 1.1.0. `-s` (silent mode)
 *   exists and runs fine without a TTY, so only `-s` is emitted.
 */

export type BuildFfufArgvResult =
  | { ok: true; argv: string[] }
  | { ok: false; error: { code: "invalid_ffuf_action_contract" } };

function appendFuzzKeyword(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/FUZZ`;
}

export function buildFfufArgv(input: unknown): BuildFfufArgvResult {
  try {
    const parsed = FfufActionOptionsSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: { code: "invalid_ffuf_action_contract" } };
    }
    const options = parsed.data;

    if (options.origin.includes("\0") || options.wordlistPath.includes("\0") || options.outputJsonPath.includes("\0")) {
      return { ok: false, error: { code: "invalid_ffuf_action_contract" } };
    }

    const codes = [...new Set(options.matchStatusCodes)].sort((a, b) => a - b);
    if (codes.length === 0) {
      return { ok: false, error: { code: "invalid_ffuf_action_contract" } };
    }

    const argv: string[] = [
      "ffuf",
      "-u",
      appendFuzzKeyword(options.origin),
      "-w",
      options.wordlistPath,
      "-o",
      options.outputJsonPath,
      "-of",
      "json",
      "-t",
      String(options.threads),
      "-timeout",
      String(options.timeoutSeconds),
      "-maxtime",
      String(options.maxTimeSeconds),
      "-mc",
      codes.join(","),
      "-s",
    ];

    for (const arg of argv) {
      if (arg.includes("\0")) {
        return { ok: false, error: { code: "invalid_ffuf_action_contract" } };
      }
    }

    return { ok: true, argv };
  } catch {
    return { ok: false, error: { code: "invalid_ffuf_action_contract" } };
  }
}
