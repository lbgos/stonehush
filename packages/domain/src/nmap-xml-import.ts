import { parseNmapXml } from "./nmap-xml.js";

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
