import {
  FFUF_MAX_RESULTS,
  FfufDiscoveryOutputSchema,
  type FfufDiscoveryOutput,
} from "@stonehush/contracts";

/**
 * Control-plane projection of a preserved raw ffuf -of json artifact.
 * Mirrors the runner parser contract (unknown keys dropped, empty
 * redirectlocation normalized to absent) without the process semantics:
 * truncation is a runner concern, so projection keeps at most
 * FFUF_MAX_RESULTS records and reports whether the raw file held more.
 */

export type ParseFfufArtifactResult =
  | { ok: true; output: FfufDiscoveryOutput; rawCount: number }
  | { ok: false; error: { code: "ffuf_parse_error" } };

function projectRawResult(candidate: unknown): Record<string, unknown> | null {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return null;
  const record = candidate as Record<string, unknown>;
  if (typeof record.url !== "string" || typeof record.status !== "number") return null;
  if (typeof record.length !== "number" || typeof record.words !== "number" || typeof record.lines !== "number") {
    return null;
  }
  const projected: Record<string, unknown> = {
    url: record.url,
    status: record.status,
    length: record.length,
    words: record.words,
    lines: record.lines,
    input: null,
  };
  if (typeof record.redirectlocation === "string" && record.redirectlocation.length > 0) {
    projected.redirectlocation = record.redirectlocation;
  }
  const input = record.input;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const fuzz = (input as Record<string, unknown>).FUZZ;
  if (typeof fuzz !== "string") return null;
  projected.input = { FUZZ: fuzz };
  return projected;
}

export function parseFfufArtifactJson(bytes: Uint8Array): ParseFfufArtifactResult {
  try {
    if (bytes.length === 0) return { ok: false, error: { code: "ffuf_parse_error" } };
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: { code: "ffuf_parse_error" } };
    }
    const rawResults = (parsed as Record<string, unknown>).results;
    if (!Array.isArray(rawResults)) return { ok: false, error: { code: "ffuf_parse_error" } };
    const projected: Record<string, unknown>[] = [];
    for (const candidate of rawResults) {
      const item = projectRawResult(candidate);
      if (item === null) return { ok: false, error: { code: "ffuf_parse_error" } };
      projected.push(item);
    }
    const output = FfufDiscoveryOutputSchema.safeParse({
      results: projected.slice(0, FFUF_MAX_RESULTS),
      truncated: projected.length > FFUF_MAX_RESULTS,
    });
    if (!output.success) return { ok: false, error: { code: "ffuf_parse_error" } };
    return { ok: true, output: output.data, rawCount: projected.length };
  } catch {
    return { ok: false, error: { code: "ffuf_parse_error" } };
  }
}
