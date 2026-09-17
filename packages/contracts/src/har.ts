import { z } from "zod";

// Proxy HAR import bounds (STONE-11). A HAR export from an external proxy
// (Caido, Burp) carries one interesting request/response pair or a small
// selection. Full-history ingest is out of scope, so both bytes and entries
// are capped before anything is parsed or stored.
export const HAR_MAX_FILE_BYTES = 1_048_576 as const;
export const HAR_MAX_ENTRIES = 8 as const;
export const HAR_MAX_METHOD_LENGTH = 32 as const;
export const HAR_MAX_URL_LENGTH = 8192 as const;

export const HAR_IMPORT_ERROR_CODES = [
  "har_too_large",
  "har_not_json",
  "har_not_har",
  "har_no_entries",
  "har_too_many_entries",
  "har_bad_entry",
] as const;

export const HarImportErrorCodeSchema = z.enum(HAR_IMPORT_ERROR_CODES);

export type HarImportErrorCode = z.infer<typeof HarImportErrorCodeSchema>;

// One proxied request/response pair. Unknown keys are stripped rather than
// rejected: real proxy exports always carry extra members (headers, cookies,
// timings, cache), while the required method, URL, and status are checked
// strictly below.
export const HarRequestSchema = z.object({
  method: z.string().min(1).max(HAR_MAX_METHOD_LENGTH),
  url: z.string().min(1).max(HAR_MAX_URL_LENGTH),
});

export const HarResponseSchema = z.object({
  status: z.number().int().min(100).max(599),
});

export const HarEntrySchema = z.object({
  request: HarRequestSchema,
  response: HarResponseSchema,
});

export type HarEntry = z.infer<typeof HarEntrySchema>;

export interface HarEntrySummary {
  method: string;
  url: string;
  status: number;
}

export function summarizeHarEntry(entry: HarEntry): HarEntrySummary {
  return {
    method: entry.request.method,
    url: entry.request.url,
    status: entry.response.status,
  };
}

// Absolute web URL required: HAR 1.2 carries absolute request URLs and a
// proxy selection belongs to http(s) traffic.
export function isHarWebUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

function truncateCodePoints(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join("");
}

// Readable capture title derived from the proxied pair itself, never from
// invented execution facts.
export function titleForHarEntry(summary: HarEntrySummary): string {
  return truncateCodePoints(`${summary.method} ${summary.url}`, 120);
}
