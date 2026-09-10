import { describe, expect, it } from "vitest";

import type { Finding, ReportBundle } from "@blackglass/contracts";

import {
  addOutlineItem,
  createOutline,
  moveOutlineItem,
  outlineSections,
  removeOutlineItem,
  renderOutlineMarkdown,
  setOutlineTemplate,
  type ReportOutline,
} from "./report-outline.js";
import { buildPrintHtml, escapeHtml } from "./report-print.js";
import { reviewOutline } from "./report-review.js";
import {
  buildPortableBundleManifest,
  buildSharingPreview,
  exportSharingMarkdown,
} from "./report-sharing.js";
import {
  captureExportSnapshot,
  describeSnapshotStaleness,
} from "./report-snapshot.js";

const ENGAGEMENT_ID = "10000000-0000-4000-8000-000000000001";
const FINDING_ID = "20000000-0000-4000-8000-000000000001";

function findingFixture(overrides: Partial<Finding> = {}): Finding {
  return {
    contractVersion: 1,
    id: FINDING_ID,
    engagementId: ENGAGEMENT_ID,
    title: "Default credentials on admin panel",
    severity: "high",
    status: "open",
    body: "1. Open the login form.\n2. Try admin/admin.\n\nEvidence shows the login succeeded.",
    evidenceArtifactIds: ["nmap-xml-1"],
    createdAt: "2026-08-12T12:00:00.000Z",
    updatedAt: "2026-08-12T12:00:00.000Z",
    ...overrides,
  };
}

function bundleFixture(): ReportBundle {
  return {
    contractVersion: 1,
    engagement: {
      id: ENGAGEMENT_ID,
      name: "Target lab",
      kind: "lab",
      status: "active",
      description: null,
      authorizationContext: null,
      deadlineAt: null,
      revision: 1,
      createdAt: "2026-08-12T12:00:00.000Z",
      updatedAt: "2026-08-12T12:00:00.000Z",
    },
    findings: [findingFixture()],
    notesMarkdown: "Operator notes.",
    notesUpdatedAt: "2026-08-12T12:00:00.000Z",
    services: { total: 0, truncated: false, rows: [] },
    probes: { total: 0, truncated: false, rows: [] },
    ffufResults: { total: 0, truncated: false, rows: [] },
    evidenceArtifacts: {
      total: 1,
      truncated: false,
      rows: [
        {
          artifactId: "nmap-xml-1",
          digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          sizeBytes: 10,
          kind: "tool_raw",
          completeness: "complete",
          runId: "run-1",
        },
      ],
    },
    generatedAt: "2026-08-12T13:00:00.000Z",
  };
}

describe("report outline", () => {
  it("assembles and reorders without moving records", () => {
    const records = [findingFixture()];
    let outline = createOutline("ctf-writeup");
    outline = addOutlineItem(outline, {
      kind: "finding",
      refId: FINDING_ID,
      caption: "Default credentials",
    });
    outline = addOutlineItem(outline, {
      kind: "evidence",
      refId: "nmap-xml-1",
      caption: "nmap xml",
    });
    // Duplicates are ignored.
    expect(addOutlineItem(outline, {
      kind: "finding",
      refId: FINDING_ID,
      caption: "Default credentials",
    }).items.length).toBe(2);
    const reordered = moveOutlineItem(outline, "evidence:nmap-xml-1", 0);
    expect(reordered.items[0]?.key).toBe("evidence:nmap-xml-1");
    // Inputs untouched: same order, same records array.
    expect(outline.items[0]?.key).toBe(`finding:${FINDING_ID}`);
    expect(records.length).toBe(1);
    expect(records[0]?.id).toBe(FINDING_ID);
    expect(removeOutlineItem(reordered, "evidence:nmap-xml-1").items.length).toBe(1);
  });

  it("shares one selection across two templates", () => {
    let outline = addOutlineItem(createOutline("ctf-writeup"), {
      kind: "finding",
      refId: FINDING_ID,
      caption: "Default credentials",
    });
    expect(outlineSections("ctf-writeup")).toContain("Reproduction");
    expect(outlineSections("assessment")).toContain("Methodology");
    const switched: ReportOutline = setOutlineTemplate(outline, "assessment");
    expect(switched.items).toEqual(outline.items);
    outline = switched;
    const bundle = bundleFixture();
    const material = {
      findings: bundle.findings,
      evidence: [{ artifactId: "nmap-xml-1", digest: "sha256:0" }],
      notesMarkdown: bundle.notesMarkdown,
    };
    const writeup = renderOutlineMarkdown(material, { ...outline, template: "ctf-writeup" });
    const assessment = renderOutlineMarkdown(material, outline);
    expect(writeup).toContain("## Reproduction");
    expect(assessment).toContain("## Methodology");
    expect(assessment).toContain("Default credentials on admin panel");
  });

  it("links evidence with relative asset paths", () => {
    const outline = addOutlineItem(createOutline(), {
      kind: "evidence",
      refId: "nmap-xml-1",
      caption: "nmap xml",
    });
    const markdown = renderOutlineMarkdown(
      { findings: [], evidence: [{ artifactId: "nmap-xml-1", digest: "sha256:0" }], notesMarkdown: "" },
      outline,
    );
    expect(markdown).toContain("(./assets/nmap-xml-1)");
    expect(markdown).not.toContain("://");
  });
});

describe("report review panel", () => {
  it("passes a well-supported finding", () => {
    const outline = addOutlineItem(createOutline(), {
      kind: "finding",
      refId: FINDING_ID,
      caption: "Default credentials",
    });
    expect(
      reviewOutline({ outline, findings: [findingFixture()], notesMarkdown: "notes" }),
    ).toEqual([]);
  });

  it("flags missing proof and unknown selections", () => {
    const outline = addOutlineItem(createOutline(), {
      kind: "finding",
      refId: FINDING_ID,
      caption: "Default credentials",
    });
    const flags = reviewOutline({
      outline,
      findings: [findingFixture({ evidenceArtifactIds: [], body: "no steps here" })],
      notesMarkdown: "",
    });
    expect(flags.map((flag) => flag.code)).toContain("missing-proof");
    expect(flags.map((flag) => flag.code)).toContain("ambiguous-repro");
  });

  it("flags unsupported absolute claims and accidental secrets", () => {
    const outline = addOutlineItem(createOutline(), {
      kind: "finding",
      refId: FINDING_ID,
      caption: "Default credentials",
    });
    const flags = reviewOutline({
      outline,
      findings: [
        findingFixture({
          severity: "critical",
          evidenceArtifactIds: [],
          body: "This gives remote code execution on all hosts. token: sk-abcdef123456",
        }),
      ],
      notesMarkdown: "flag{ctf-secret}",
    });
    expect(flags.map((flag) => flag.code)).toContain("unsupported-claim");
    expect(flags.map((flag) => flag.code)).toContain("possible-secret");
  });
});

describe("export snapshots", () => {
  it("goes visibly stale after a later edit", () => {
    const snapshot = captureExportSnapshot({
      bundleGeneratedAt: "2026-08-12T13:00:00.000Z",
      template: "ctf-writeup",
      itemKeys: ["finding:x"],
      markdown: "# Report\n",
      now: () => new Date("2026-08-12T13:05:00.000Z"),
      createId: () => "snapshot-1",
    });
    expect(
      describeSnapshotStaleness(snapshot, { bundleGeneratedAt: "2026-08-12T13:00:00.000Z" }).stale,
    ).toBe(false);
    const stale = describeSnapshotStaleness(snapshot, {
      bundleGeneratedAt: "2026-08-12T14:00:00.000Z",
    });
    expect(stale.stale).toBe(true);
    expect(stale.reason).toContain("Stale");
  });
});

describe("sharing preview", () => {
  it("excludes scratchpad, secrets, history, and raw bytes by default", () => {
    const bundle = bundleFixture();
    const outline = addOutlineItem(
      addOutlineItem(createOutline(), {
        kind: "finding",
        refId: FINDING_ID,
        caption: "Default credentials",
      }),
      { kind: "evidence", refId: "nmap-xml-1", caption: "nmap xml" },
    );
    const preview = buildSharingPreview({ bundle, outline });
    expect(preview.included.map((entry) => entry.caption).join("\n")).toContain("Default credentials");
    expect(preview.included.some((entry) => entry.filename !== undefined)).toBe(false);
    expect(preview.excluded.join("\n")).toContain("Scratchpad");
    expect(preview.excluded.join("\n")).toContain("history");
    expect(preview.excluded.join("\n")).toContain("Raw artifact bytes excluded");
    // Preview and export are the same string.
    expect(exportSharingMarkdown(preview)).toBe(preview.markdown);
  });

  it("includes raw artifacts only when explicit", () => {
    const bundle = bundleFixture();
    const outline = addOutlineItem(createOutline(), {
      kind: "evidence",
      refId: "nmap-xml-1",
      caption: "nmap xml",
    });
    const preview = buildSharingPreview({
      bundle,
      outline,
      options: { includeRawArtifacts: true },
    });
    expect(preview.included[0]?.filename).toBe("assets/nmap-xml-1");
    expect(preview.excluded.join("\n")).not.toContain("Raw artifact bytes excluded");
  });

  it("builds a portable bundle distinct from the client report", () => {
    const bundle = bundleFixture();
    const outline = addOutlineItem(createOutline(), {
      kind: "finding",
      refId: FINDING_ID,
      caption: "Default credentials",
    });
    const preview = buildSharingPreview({ bundle, outline });
    const manifest = buildPortableBundleManifest({ bundle, outline });
    expect(manifest.kind).toBe("blackglass-portable-bundle-v1");
    expect(manifest.findingIds).toEqual([FINDING_ID]);
    expect(manifest.excludes.join(",")).toContain("scratchpad");
    expect(JSON.stringify(manifest)).not.toBe(preview.markdown);
  });
});

describe("print html", () => {
  it("escapes content and stays self-contained", () => {
    const html = buildPrintHtml("Report <x>", "# Title\n\n<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toMatch(/src=|href="http/);
    expect(escapeHtml(`"a" & <b>`)).toBe("&quot;a&quot; &amp; &lt;b&gt;");
  });
});
