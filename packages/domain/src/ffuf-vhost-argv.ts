import { FfufVhostActionOptionsSchema, vhostBaseUrl } from "@stonehush/contracts";

/**
 * Build deterministic ffuf vhost argv. No shell strings; each argv element
 * is one literal string, so hostnames with spaces or metacharacters stay a
 * single element.
 *
 * Fixed order (verified against ffuf 1.1.0 `ffuf -h` on this host):
 * ffuf, -u <baseUrl>, -w <wordlist>, -H "Host: FUZZ", -o <jsonPath>,
 * -of json, -t <threads>, -timeout <seconds>, -maxtime <seconds>,
 * -mc <csv>, -s
 *
 * The example in `ffuf -h` documents exactly this shape:
 * `ffuf -w hosts.txt -u https://example.org/ -H "Host: FUZZ" -mc 200`.
 * Rate is validated for forward compatibility but never emitted because
 * ffuf 1.1.0 rejects -rate. Auto-calibration (-ac) is never emitted;
 * wildcard filtering happens after the run with a visible calibration note.
 */

export type BuildVhostArgvResult =
  | { ok: true; argv: string[]; baseUrl: string }
  | { ok: false; error: { code: "invalid_ffuf_vhost_contract" } };

export function buildVhostArgv(input: unknown): BuildVhostArgvResult {
  try {
    const parsed = FfufVhostActionOptionsSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: { code: "invalid_ffuf_vhost_contract" } };
    }
    const options = parsed.data;

    if (
      options.address.includes("\0") ||
      options.wordlistPath.includes("\0") ||
      options.outputJsonPath.includes("\0")
    ) {
      return { ok: false, error: { code: "invalid_ffuf_vhost_contract" } };
    }

    const codes = [...new Set(options.matchStatusCodes)].sort((a, b) => a - b);
    if (codes.length === 0) {
      return { ok: false, error: { code: "invalid_ffuf_vhost_contract" } };
    }

    const baseUrl = vhostBaseUrl({ address: options.address, port: options.port, tls: options.tls });

    const argv: string[] = [
      "ffuf",
      "-u",
      baseUrl,
      "-w",
      options.wordlistPath,
      "-H",
      "Host: FUZZ",
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
        return { ok: false, error: { code: "invalid_ffuf_vhost_contract" } };
      }
    }

    return { ok: true, argv, baseUrl };
  } catch {
    return { ok: false, error: { code: "invalid_ffuf_vhost_contract" } };
  }
}
