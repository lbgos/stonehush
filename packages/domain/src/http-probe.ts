import {
  HTTP_PROBE_MAX_RAW_BYTES,
  HTTP_PROBE_MAX_TITLE_CHARS,
  HttpProbeRawSchema,
  type ActionSnapshot,
  type HttpProbeRaw,
} from "@stonehush/contracts";

/**
 * Pure helpers for the minimal HTTP probe variant.
 * Planning reuses the existing action machinery: a probe action is an action
 * whose canonical targets are all http/https URLs. No new planning rules.
 */

export function isHttpProbeSnapshot(snapshot: ActionSnapshot): boolean {
  if (snapshot.canonicalTargets.length === 0) return false;
  return snapshot.canonicalTargets.every(
    (target) =>
      target.kind === "url" &&
      (target.url.startsWith("http://") || target.url.startsWith("https://")),
  );
}

export function probeUrlsForSnapshot(snapshot: ActionSnapshot): string[] | null {
  if (!isHttpProbeSnapshot(snapshot)) return null;
  const urls: string[] = [];
  for (const target of snapshot.canonicalTargets) {
    if (target.kind !== "url") return null;
    if (urls.includes(target.url)) return null;
    urls.push(target.url);
  }
  return urls;
}

export function selectProbeHeaders(
  entries: Iterable<readonly [string, string]>,
): HttpProbeRaw["selectedHeaders"] {
  let contentType: string | null = null;
  let server: string | null = null;
  let poweredBy: string | null = null;
  for (const [name, value] of entries) {
    const lower = name.toLowerCase();
    const bounded = value.slice(0, 1024);
    if (lower === "content-type" && contentType === null) contentType = bounded;
    else if (lower === "server" && server === null) server = bounded;
    else if (lower === "x-powered-by" && poweredBy === null) poweredBy = bounded;
  }
  return { contentType, server, poweredBy };
}

function cleanTitleText(raw: string): string | null {
  const collapsed = raw.replace(/[\0\r\n\t ]+/g, " ").trim();
  if (collapsed.length === 0) return null;
  return collapsed.slice(0, HTTP_PROBE_MAX_TITLE_CHARS);
}

// Title is untrusted page content: first bounded title element only,
// tags inside are stripped, entities are left as-is.
export function parseProbeTitle(bodyText: string): string | null {
  const match = /<title[^>]{0,512}>([\s\S]{0,4096}?)<\/title\s*>/i.exec(bodyText);
  if (match?.[1] === undefined) return null;
  const withoutTags = match[1].replace(/<[^>]*>/g, "");
  return cleanTitleText(withoutTags);
}

export function buildProbeRawBytes(
  raw: HttpProbeRaw,
): { ok: true; bytes: Uint8Array } | { ok: false; error: string } {
  const parsed = HttpProbeRawSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid_http_probe_result" };
  const bytes = new TextEncoder().encode(JSON.stringify(parsed.data));
  if (bytes.length > HTTP_PROBE_MAX_RAW_BYTES) {
    return { ok: false, error: "http_probe_raw_too_large" };
  }
  return { ok: true, bytes };
}

export function parseProbeRawBytes(
  bytes: Uint8Array,
): { ok: true; raw: HttpProbeRaw } | { ok: false; error: string } {
  if (bytes.length > HTTP_PROBE_MAX_RAW_BYTES) {
    return { ok: false, error: "http_probe_raw_too_large" };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, error: "http_probe_raw_invalid" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "http_probe_raw_invalid" };
  }
  const validated = HttpProbeRawSchema.safeParse(parsed);
  if (!validated.success) return { ok: false, error: "http_probe_raw_invalid" };
  return { ok: true, raw: validated.data };
}
