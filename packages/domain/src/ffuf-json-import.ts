import { parseFfufArtifactJson } from "./ffuf-json.js";
import { describeComparability } from "./normalize-target-bindings.js";
import { planStoneImport, type StoneImportPlan } from "./nmap-xml-import.js";

export type { StoneImportPlan };

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

export function planFfufJsonImport(input: {
  contentDigest: string;
  existingCaptureId: string | null;
}): StoneImportPlan {
  return planStoneImport(input);
}

export function describeFfufImportComparability(input: {
  importedUrl: string;
  currentOrigin: string | null;
}): { comparable: boolean; reason: "same_binding" | "binding_changed" } {
  if (input.currentOrigin !== null && input.importedUrl.startsWith(input.currentOrigin)) {
    return describeComparability(
      { addressText: input.currentOrigin, bindingKind: "hostname" },
      { addressText: input.currentOrigin, bindingKind: "hostname" },
    );
  }
  return { comparable: false, reason: "binding_changed" };
}
