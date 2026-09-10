import { describe, expect, it } from "vitest";

import {
  countNmapXmlServices,
  describeNmapImportComparability,
  planStoneImport,
} from "./nmap-xml-import.js";
import { countFfufJsonResults, planFfufJsonImport } from "./ffuf-json-import.js";

const NMAP_XML = `<?xml version="1.0"?>
<nmaprun>
<host><status state="up"/><address addr="10.0.0.5" addrtype="ipv4"/>
<ports><port protocol="tcp" portid="80"><state state="open"/><service name="http"/></port></ports>
</host>
</nmaprun>`;

const FFUF_JSON = JSON.stringify({
  results: [
    {
      url: "http://10.0.0.5/admin",
      status: 200,
      length: 10,
      words: 2,
      lines: 1,
      input: { FUZZ: "admin" },
    },
  ],
});

describe("stone import extensions", () => {
  it("counts nmap services for import capture", () => {
    const counted = countNmapXmlServices(new TextEncoder().encode(NMAP_XML));
    expect(counted).toEqual({ ok: true, serviceCount: 1 });
  });

  it("counts ffuf results for import capture", () => {
    const counted = countFfufJsonResults(new TextEncoder().encode(FFUF_JSON));
    expect(counted).toEqual({ ok: true, resultCount: 1, truncated: false });
  });

  it("points re-imports at the existing capture without doubling facts", () => {
    const first = planStoneImport({ contentDigest: "sha256:abc", existingCaptureId: null });
    expect(first).toEqual({ deduplicated: false, provenanceExistingId: null });
    const second = planStoneImport({
      contentDigest: "sha256:abc",
      existingCaptureId: "capture-1",
    });
    expect(second).toEqual({ deduplicated: true, provenanceExistingId: "capture-1" });
    expect(
      planFfufJsonImport({ contentDigest: "sha256:abc", existingCaptureId: "capture-1" })
        .deduplicated,
    ).toBe(true);
  });

  it("marks import comparability against the current binding", () => {
    expect(
      describeNmapImportComparability({
        importedAddress: "10.0.0.5",
        importedKind: "ip",
        currentAddress: "10.0.0.9",
        currentKind: "ip",
      }).comparable,
    ).toBe(false);
  });
});
