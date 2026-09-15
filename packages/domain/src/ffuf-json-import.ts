import { parseFfufArtifactJson } from "./ffuf-json.js";

export type CountFfufJsonResultsResult =
  | { ok: true; resultCount: number; truncated: boolean }
  | { ok: false; error: { code: "ffuf_parse_error" } };

// Extension over the ffuf JSON parser for import capture: bounded count plus
// a shared dedupe plan so Nmap and ffuf re-imports behave identically.
export function countFfufJsonResults(bytes: Uint8Array): CountFfufJsonResultsResult {
  const parsed = parseFfufArtifactJson(bytes);
  if (!parsed.ok) return { ok: false, error: { code: "ffuf_parse_error" } };
  return {
    ok: true,
    resultCount: parsed.output.results.length,
    truncated: parsed.output.truncated,
  };
}
