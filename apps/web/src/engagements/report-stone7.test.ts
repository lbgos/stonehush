import { describe, expect, it } from "vitest";

import type { Finding, ReportBundle } from "@stonehush/contracts";

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
    revision: 1,
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

  it("renders findings and leads in outline order within the Findings section", () => {
    let outline = addOutlineItem(createOutline(), {
      kind: "finding",
      refId: FINDING_ID,
      caption: "Default credentials",
    });
    outline = addOutlineItem(outline, {
      kind: "lead",
      refId: "lead-1",
      caption: "Weak login",
    });
    const material = {
      findings: [findingFixture()],
      evidence: [],
      notesMarkdown: "",
    };
    const ordered = renderOutlineMarkdown(material, outline);
    expect(ordered.indexOf("Default credentials on admin panel")).toBeLessThan(
      ordered.indexOf("Lead: Weak login"),
    );
    const moved = renderOutlineMarkdown(
      material,
      moveOutlineItem(outline, "lead:lead-1", 0),
    );
    expect(moved.indexOf("Lead: Weak login")).toBeLessThan(
      moved.indexOf("Default credentials on admin panel"),
    );
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
    const digestOnly = renderOutlineMarkdown(
      { findings: [], evidence: [{ artifactId: "nmap-xml-1", digest: "sha256:0" }], notesMarkdown: "" },
      outline,
      { assetLinks: false },
    );
    expect(digestOnly).not.toContain("./assets/");
    expect(digestOnly).toContain("digest-only");
  });

  it("renders unresolved evidence as missing without an asset link", () => {
    const outline = addOutlineItem(createOutline(), {
      kind: "evidence",
      refId: "gone-artifact",
      caption: "old scan",
    });
    const material = {
      findings: [],
      evidence: [{ artifactId: "nmap-xml-1", digest: "sha256:0" }],
      notesMarkdown: "",
    };
    const markdown = renderOutlineMarkdown(material, outline);
    expect(markdown).toContain("old scan (missing: gone-artifact)");
    expect(markdown).not.toContain("./assets/gone-artifact");
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
      reviewOutline({
        outline,
        findings: [findingFixture()],
        evidenceArtifactIds: ["nmap-xml-1"],
        notesMarkdown: "notes",
      }),
    ).toEqual([]);
  });

  it("flags an empty finding body as a reproduction gap", () => {
    const outline = addOutlineItem(createOutline(), {
      kind: "finding",
      refId: FINDING_ID,
      caption: "Default credentials",
    });
    const flags = reviewOutline({
      outline,
      findings: [findingFixture({ body: "" })],
      evidenceArtifactIds: ["nmap-xml-1"],
      notesMarkdown: "notes",
    });
    expect(flags.map((flag) => flag.code)).toContain("ambiguous-repro");
  });

  it("flags selected evidence that is no longer available", () => {
    const outline = addOutlineItem(createOutline(), {
      kind: "evidence",
      refId: "gone-artifact",
      caption: "old scan",
    });
    const flags = reviewOutline({
      outline,
      findings: [findingFixture()],
      evidenceArtifactIds: ["nmap-xml-1"],
      notesMarkdown: "notes",
    });
    expect(flags.map((flag) => flag.code)).toContain("missing-evidence");
    const fresh = reviewOutline({
      outline,
      findings: [findingFixture()],
      evidenceArtifactIds: ["nmap-xml-1", "gone-artifact"],
      notesMarkdown: "notes",
    });
    expect(fresh.map((flag) => flag.code)).not.toContain("missing-evidence");
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
      evidenceArtifactIds: [],
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
      evidenceArtifactIds: [],
      notesMarkdown: "flag{ctf-secret}",
    });
    expect(flags.map((flag) => flag.code)).toContain("unsupported-claim");
    expect(flags.map((flag) => flag.code)).toContain("possible-secret");
  });
});

describe("export snapshots", () => {
  function liveFor(
    bundleGeneratedAt: string,
    template = "ctf-writeup",
    itemKeys: readonly string[] = ["finding:x"],
    assetLinks = false,
    maskSecrets = true,
  ) {
    return { bundleGeneratedAt, template, itemKeys, assetLinks, maskSecrets };
  }

  function snapshotInput() {
    return {
      bundleGeneratedAt: "2026-08-12T13:00:00.000Z",
      template: "ctf-writeup",
      assetLinks: false,
      maskSecrets: true,
      now: () => new Date("2026-08-12T13:05:00.000Z"),
      createId: () => "snapshot-1",
    };
  }

  it("goes visibly stale after a later edit", () => {
    const snapshot = captureExportSnapshot({
      ...snapshotInput(),
      itemKeys: ["finding:x"],
      markdown: "# Report\n",
    });
    expect(
      describeSnapshotStaleness(snapshot, liveFor("2026-08-12T13:00:00.000Z")).stale,
    ).toBe(false);
    const stale = describeSnapshotStaleness(snapshot, liveFor("2026-08-12T14:00:00.000Z"));
    expect(stale.stale).toBe(true);
    expect(stale.reason).toContain("Stale");
  });

  it("goes stale when the outline is reordered or retemplated", () => {
    const snapshot = captureExportSnapshot({
      ...snapshotInput(),
      itemKeys: ["finding:x", "evidence:y"],
      markdown: "# Report\n",
    });
    const reordered = describeSnapshotStaleness(
      snapshot,
      liveFor("2026-08-12T13:00:00.000Z", "ctf-writeup", ["evidence:y", "finding:x"]),
    );
    expect(reordered.stale).toBe(true);
    expect(reordered.reason).toContain("order");
    const retemplated = describeSnapshotStaleness(
      snapshot,
      liveFor("2026-08-12T13:00:00.000Z", "assessment", ["finding:x", "evidence:y"]),
    );
    expect(retemplated.stale).toBe(true);
    expect(retemplated.reason).toContain("template");
  });

  it("goes stale when rendering options change the Markdown", () => {
    const snapshot = captureExportSnapshot({
      ...snapshotInput(),
      itemKeys: ["finding:x"],
      markdown: "# Report\n",
    });
    const relinked = describeSnapshotStaleness(
      snapshot,
      liveFor("2026-08-12T13:00:00.000Z", "ctf-writeup", ["finding:x"], true, true),
    );
    expect(relinked.stale).toBe(true);
    expect(relinked.reason).toContain("asset-link");
    const unmasked = describeSnapshotStaleness(
      snapshot,
      liveFor("2026-08-12T13:00:00.000Z", "ctf-writeup", ["finding:x"], false, false),
    );
    expect(unmasked.stale).toBe(true);
    expect(unmasked.reason).toContain("masking");
  });
});

describe("sharing preview", () => {
  it("excludes scratchpad, secrets, history, and asset links by default", () => {
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
    expect(preview.excluded.join("\n")).toContain("asset links excluded");
    expect(preview.excluded.join("\n")).toContain("never embedded");
    // The toggle changes the Markdown itself, so preview and file agree.
    expect(preview.markdown).not.toContain("./assets/");
    // Preview and export are the same string.
    expect(exportSharingMarkdown(preview)).toBe(preview.markdown);
  });

  it("links evidence assets only when explicit", () => {
    const bundle = bundleFixture();
    const outline = addOutlineItem(createOutline(), {
      kind: "evidence",
      refId: "nmap-xml-1",
      caption: "nmap xml",
    });
    const preview = buildSharingPreview({
      bundle,
      outline,
      options: { includeAssetLinks: true },
    });
    expect(preview.included[0]?.filename).toBe("assets/nmap-xml-1");
    expect(preview.markdown).toContain("(./assets/nmap-xml-1)");
    expect(preview.excluded.join("\n")).not.toContain("asset links excluded");
  });

  it("leaves original text alone when secret masking is off", () => {
    const token = "token: sk-abcdef123456";
    const bundle: ReportBundle = {
      ...bundleFixture(),
      findings: [findingFixture({ body: `Login succeeded. ${token}` })],
    };
    const outline = addOutlineItem(createOutline(), {
      kind: "finding",
      refId: FINDING_ID,
      caption: "Default credentials",
    });
    const masked = buildSharingPreview({ bundle, outline });
    const original = buildSharingPreview({
      bundle,
      outline,
      options: { maskSecrets: false },
    });
    expect(masked.maskedFields).toBeGreaterThan(0);
    expect(original.maskedFields).toBe(0);
    expect(original.markdown).toContain(token);
    expect(masked.markdown).not.toContain(token);
  });

  it("masks secret-shaped outline captions with the export", () => {
    const token = "token: sk-abcdef123456";
    const bundle = bundleFixture();
    const outline = addOutlineItem(createOutline(), {
      kind: "lead",
      refId: "lead-1",
      caption: `Weak login ${token}`,
    });
    const masked = buildSharingPreview({ bundle, outline });
    expect(masked.markdown).not.toContain(token);
    expect(masked.included.map((entry) => entry.caption).join("\n")).not.toContain(token);
    expect(masked.maskedFields).toBeGreaterThan(0);
    const original = buildSharingPreview({
      bundle,
      outline,
      options: { maskSecrets: false },
    });
    expect(original.markdown).toContain(token);
    expect(original.maskedFields).toBe(0);
  });

  it("describes a missing finding with its outline caption", () => {
    const bundle = bundleFixture();
    const outline = addOutlineItem(createOutline(), {
      kind: "finding",
      refId: "30000000-0000-4000-8000-000000000001",
      caption: "Default credentials",
    });
    const preview = buildSharingPreview({ bundle, outline });
    expect(preview.included[0]?.caption).toBe(
      "Default credentials (missing: 30000000-0000-4000-8000-000000000001)",
    );
    expect(preview.markdown).toContain(
      "### Default credentials (missing: 30000000-0000-4000-8000-000000000001)",
    );
  });

  it("labels unresolved evidence as missing without an asset filename", () => {
    const bundle = bundleFixture();
    const outline = addOutlineItem(createOutline(), {
      kind: "evidence",
      refId: "gone-artifact",
      caption: "old scan",
    });
    const preview = buildSharingPreview({
      bundle,
      outline,
      options: { includeAssetLinks: true },
    });
    expect(preview.included[0]?.caption).toBe("Evidence old scan (missing: gone-artifact)");
    expect(preview.included[0]?.filename).toBeUndefined();
    expect(preview.markdown).not.toContain("./assets/gone-artifact");
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
