import {
  HAR_MAX_ENTRIES,
  HAR_MAX_FILE_BYTES,
  HarEntrySchema,
  isHarWebUrl,
  summarizeHarEntry,
  titleForHarEntry,
  type HarEntrySummary,
  type HarImportErrorCode,
} from "@stonehush/contracts";

export interface HarImportSummary {
  entryCount: number;
  first: HarEntrySummary;
  title: string;
}

export type ParseHarImportResult =
  | { ok: true; value: HarImportSummary }
  | { ok: false; error: { code: HarImportErrorCode } };

function failure(code: HarImportErrorCode): ParseHarImportResult {
  return { ok: false, error: { code } };
}

// Proxy HAR selection parser for import capture. Bytes are capped before
// decoding, entries are capped before per-entry validation, and every
// rejection names the exact problem so the operator can export a smaller
// selection from the proxy instead.
export function parseHarImport(bytes: Uint8Array): ParseHarImportResult {
  if (bytes.length > HAR_MAX_FILE_BYTES) return failure("har_too_large");

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return failure("har_not_json");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return failure("har_not_json");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return failure("har_not_har");
  }
  const log = (parsed as Record<string, unknown>).log;
  if (typeof log !== "object" || log === null || Array.isArray(log)) {
    return failure("har_not_har");
  }
  const entries = (log as Record<string, unknown>).entries;
  if (!Array.isArray(entries)) return failure("har_not_har");
  if (entries.length === 0) return failure("har_no_entries");
  if (entries.length > HAR_MAX_ENTRIES) return failure("har_too_many_entries");

  const summaries: HarEntrySummary[] = [];
  for (const candidate of entries) {
    const validated = HarEntrySchema.safeParse(candidate);
    if (!validated.success) return failure("har_bad_entry");
    const summary = summarizeHarEntry(validated.data);
    if (!isHarWebUrl(summary.url)) return failure("har_bad_entry");
    summaries.push(summary);
  }

  const first = summaries[0];
  if (first === undefined) return failure("har_no_entries");
  return {
    ok: true,
    value: {
      entryCount: summaries.length,
      first,
      title: titleForHarEntry(first),
    },
  };
}
