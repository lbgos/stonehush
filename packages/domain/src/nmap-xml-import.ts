import { parseNmapXml } from "./nmap-xml.js";
import { describeComparability } from "./normalize-target-bindings.js";

export interface StoneImportPlan {
  readonly deduplicated: boolean;
  readonly provenanceExistingId: string | null;
}

// Re-importing identical content must not double facts. The second import
// resolves to a provenance pointer at the existing capture.
export function planStoneImport(input: {
  contentDigest: string;
  existingCaptureId: string | null;
}): StoneImportPlan {
  if (input.existingCaptureId !== null) {
    return { deduplicated: true, provenanceExistingId: input.existingCaptureId };
  }
  return { deduplicated: false, provenanceExistingId: null };
}

export type CountNmapXmlServicesResult =
  | { ok: true; serviceCount: number }
  | { ok: false; error: { code: "nmap_xml_invalid" } };

// Extension over the Nmap XML parser for import capture: bounded count plus
// binding comparability against the target context that receives the import.
export function countNmapXmlServices(bytes: Uint8Array): CountNmapXmlServicesResult {
  const parsed = parseNmapXml(bytes);
  if (!parsed.ok) return { ok: false, error: { code: "nmap_xml_invalid" } };
  return { ok: true, serviceCount: parsed.services.length };
}

export function describeNmapImportComparability(input: {
  importedAddress: string;
  importedKind: "ip" | "hostname";
  currentAddress: string;
  currentKind: "ip" | "hostname";
}): { comparable: boolean; reason: "same_binding" | "binding_changed" } {
  return describeComparability(
    { addressText: input.importedAddress, bindingKind: input.importedKind },
    { addressText: input.currentAddress, bindingKind: input.currentKind },
  );
}
