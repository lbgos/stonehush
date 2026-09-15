import { describe, expect, it } from "vitest";

import {
  capReportRows,
  engagementReportMarkdown,
  REPORT_MAX_ROWS,
  ReportBundleSchema,
  ReportFormatQuerySchema,
  type ReportBundle,
} from "./report.js";

const engagementId = "10000000-0000-4000-8000-000000000001";

function emptyBundle(): ReportBundle {
  return {
    contractVersion: 1,
    engagement: {
      id: engagementId,
      name: "Empty box",
      kind: "ctf",
      status: "active",
      description: null,
      authorizationContext: null,
      deadlineAt: null,
      revision: 1,
      createdAt: "2026-08-12T12:00:00.000Z",
      updatedAt: "2026-08-12T12:00:00.000Z",
    },
    findings: [],
    notesMarkdown: "",
    notesUpdatedAt: "2026-08-12T12:00:00.000Z",
    services: { total: 0, truncated: false, rows: [] },
    probes: { total: 0, truncated: false, rows: [] },
    ffufResults: { total: 0, truncated: false, rows: [] },
    evidenceArtifacts: { total: 0, truncated: false, rows: [] },
    generatedAt: "2026-08-12T13:00:00.000Z",
  };
}

function serviceRow(index: number) {
  return {
    source: "nmap",
    parserVersion: "nmap-xml-v1",
    address: "10.0.0.1",
    port: 80,
    protocol: "tcp",
    hostname: null,
    serviceName: "http",
    product: null,
    version: null,
    runId: `run-${index}`,
    artifactId: `artifact-${index}`,
    artifactDigest:
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    observedAt: "2026-08-12T12:00:00.000Z",
  };
}

describe("report contracts", () => {
  it("accepts an empty engagement bundle", () => {
    expect(ReportBundleSchema.parse(emptyBundle())).toEqual(emptyBundle());
  });

  it("rejects unknown keys and inconsistent caps", () => {
    expect(() =>
      ReportBundleSchema.parse({ ...emptyBundle(), extra: true }),
    ).toThrow();
    expect(() =>
      ReportBundleSchema.parse({
        ...emptyBundle(),
        services: { total: 0, truncated: false, rows: [serviceRow(1)] },
      }),
    ).toThrow();
    expect(() =>
      ReportBundleSchema.parse({
        ...emptyBundle(),
        services: { total: 1, truncated: true, rows: [serviceRow(1)] },
      }),
    ).toThrow();
  });

  it("caps rows at REPORT_MAX_ROWS with truncated true", () => {
    const rows = Array.from({ length: REPORT_MAX_ROWS + 1 }, (_, index) =>
      serviceRow(index),
    );
    const capped = capReportRows(rows);
    expect(capped.total).toBe(REPORT_MAX_ROWS + 1);
    expect(capped.truncated).toBe(true);
    expect(capped.rows).toHaveLength(REPORT_MAX_ROWS);
    expect(capped.rows[0]).toBe(rows[0]);
    expect(
      ReportBundleSchema.parse({
        ...emptyBundle(),
        services: capped,
      }).services.truncated,
    ).toBe(true);
  });

  it("leaves small row sets untruncated", () => {
    const capped = capReportRows([serviceRow(0)]);
    expect(capped).toEqual({ total: 1, truncated: false, rows: [serviceRow(0)] });
  });

  it("defaults the format query to json", () => {
    expect(ReportFormatQuerySchema.parse({})).toEqual({ format: "json" });
    expect(ReportFormatQuerySchema.parse({ format: "markdown" })).toEqual({
      format: "markdown",
    });
    expect(() => ReportFormatQuerySchema.parse({ format: "pdf" })).toThrow();
  });

  it("renders empty sections deterministically", () => {
    const first = engagementReportMarkdown(emptyBundle());
    const second = engagementReportMarkdown(emptyBundle());
    expect(second).toBe(first);
    expect(first.endsWith("\n")).toBe(true);
    expect(first).toContain("# Engagement report: Empty box");
    expect(first).toContain("## Findings (0)");
    expect(first).toContain("_No findings recorded._");
    expect(first).toContain("## Notes");
    expect(first).toContain("_No notes._");
    expect(first).toContain("## Services (0)");
    expect(first).toContain("## HTTP probes (0)");
    expect(first).toContain("## ffuf results (0)");
    expect(first).toContain("## Evidence artifacts (0)");
    const order = [
      "# Engagement report",
      "## Findings",
      "## Notes",
      "## Services",
      "## HTTP probes",
      "## ffuf results",
      "## Evidence artifacts",
    ].map((heading) => first.indexOf(heading));
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(order.every((index) => index >= 0)).toBe(true);
  });

  it("renders findings, notes, and deadline content", () => {
    const bundle: ReportBundle = {
      ...emptyBundle(),
      engagement: {
        ...emptyBundle().engagement,
        deadlineAt: "2026-08-20T12:00:00.000Z",
      },
      findings: [
        {
          contractVersion: 1,
          id: "20000000-0000-4000-8000-000000000001",
          engagementId,
          title: "Default credentials on admin panel",
          severity: "high",
          status: "open",
          body: "# impact\nAdmin access.",
          evidenceArtifactIds: [],
          revision: 1,
          createdAt: "2026-08-12T12:00:00.000Z",
          updatedAt: "2026-08-12T12:00:00.000Z",
        },
      ],
      notesMarkdown: "# creds\nadmin:admin",
    };
    const markdown = engagementReportMarkdown(bundle);
    expect(markdown).toContain("Default credentials on admin panel");
    expect(markdown).toContain("# creds\nadmin:admin");
    expect(markdown).toContain("- Deadline: 2026-08-20T12:00:00.000Z");
  });
});
