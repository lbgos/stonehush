import { describe, expect, it } from "vitest";

import {
  ENGAGEMENT_NOTES_MAX_BYTES,
  ReportBundleSchema,
  type ReportBundle,
} from "@stonehush/contracts";
import { ADVISOR_REDACTION_TOKEN } from "@stonehush/domain";

import { maskReportBundle } from "./report-mask.js";

const engagementId = "10000000-0000-4000-8000-000000000001";

function bundleFixture(): ReportBundle {
  return {
    contractVersion: 1,
    engagement: {
      id: engagementId,
      name: "Target lab",
      kind: "lab",
      status: "active",
      description: "auth flag{synthetic-share-0003}",
      authorizationContext: null,
      deadlineAt: null,
      revision: 1,
      createdAt: "2026-08-12T12:00:00.000Z",
      updatedAt: "2026-08-12T12:00:00.000Z",
    },
    findings: [
      {
        contractVersion: 1,
        id: "20000000-0000-4000-8000-000000000001",
        engagementId,
        title: "Creds password=synthetic-share-002",
        severity: "high",
        status: "open",
        body: "detail",
        evidenceArtifactIds: [],
        revision: 1,
        createdAt: "2026-08-12T12:00:00.000Z",
        updatedAt: "2026-08-12T12:00:00.000Z",
      },
    ],
    notesMarkdown: "see flag{synthetic-share-0001} and flag{synthetic-share-0004}",
    notesUpdatedAt: "2026-08-12T12:00:00.000Z",
    services: {
      total: 1,
      truncated: false,
      rows: [
        {
          address: "192.0.2.10",
          port: 80,
          protocol: "tcp",
          hostname: null,
          serviceName: "http",
          product: "SyntheticServer flag{synthetic-structured-0001}",
          version: "1.0",
          source: "nmap",
          parserVersion: "nmap-xml-v1",
          runId: "run-1",
          artifactId: "artifact-1",
          artifactDigest: `sha256:${"a".repeat(64)}`,
          observedAt: "2026-08-12T12:00:00.000Z",
        },
      ],
    },
    probes: { total: 0, truncated: false, rows: [] },
    ffufResults: { total: 0, truncated: false, rows: [] },
    evidenceArtifacts: { total: 0, truncated: false, rows: [] },
    generatedAt: "2026-08-12T13:00:00.000Z",
  };
}

describe("maskReportBundle", () => {
  it("masks operator free text and counts changed fields, preserving structured rows and identity", () => {
    const bundle = bundleFixture();
    const masked = maskReportBundle(bundle);

    // Three changed fields (notes, title, description), even though the notes
    // hold two secret hits. The count is changed fields, not hit totals.
    expect(masked.maskedFields).toBe(3);
    expect(masked.bundle.notesMarkdown).toBe("see [redacted] and [redacted]");
    expect(masked.bundle.findings[0]?.title).toBe("Creds password: [redacted]");
    expect(masked.bundle.findings[0]?.body).toBe("detail");
    expect(masked.bundle.engagement.name).toBe("Target lab");
    expect(masked.bundle.engagement.description).toBe("auth [redacted]");
    expect(masked.bundle.engagement.authorizationContext).toBe(null);

    // Structured discovery text is intentionally preserved verbatim.
    expect(masked.bundle.services.rows[0]?.product).toBe(
      "SyntheticServer flag{synthetic-structured-0001}",
    );
    expect(masked.bundle.services).toBe(bundle.services);
    expect(masked.bundle.probes).toBe(bundle.probes);
    expect(masked.bundle.ffufResults).toBe(bundle.ffufResults);
    expect(masked.bundle.evidenceArtifacts).toBe(bundle.evidenceArtifacts);

    // Identity metadata is byte-exact.
    expect(masked.bundle.engagement.id).toBe(bundle.engagement.id);
    expect(masked.bundle.findings[0]?.id).toBe(bundle.findings[0]?.id);
    expect(masked.bundle.generatedAt).toBe(bundle.generatedAt);

    // The stored bundle is never mutated.
    expect(bundle.notesMarkdown).toContain("flag{synthetic-share-0001}");
    expect(bundle.findings[0]?.title).toBe("Creds password=synthetic-share-002");
  });

  it("masks a secret-bearing engagement name while keeping the id", () => {
    const bundle: ReportBundle = {
      ...bundleFixture(),
      engagement: {
        ...bundleFixture().engagement,
        name: "Lab flag{synthetic-share-0005}",
      },
    };
    const masked = maskReportBundle(bundle);

    expect(masked.bundle.engagement.name).toBe("Lab [redacted]");
    expect(masked.bundle.engagement.id).toBe(bundle.engagement.id);
    expect(masked.maskedFields).toBe(4);
  });

  it("counts a url-only strip as one masked field with zero secret hits", () => {
    const bundle: ReportBundle = {
      ...bundleFixture(),
      engagement: {
        ...bundleFixture().engagement,
        description: null,
      },
      findings: [],
      notesMarkdown: "see http://admin:synthetic@192.0.2.10/login for details",
    };
    const masked = maskReportBundle(bundle);

    expect(masked.bundle.notesMarkdown).toBe("see http://192.0.2.10/login for details");
    expect(masked.maskedFields).toBe(1);
  });

  it("passes null context and secret-free text through with zero masked fields", () => {
    const bundle: ReportBundle = {
      ...bundleFixture(),
      engagement: {
        ...bundleFixture().engagement,
        description: null,
        authorizationContext: null,
      },
      findings: [],
      notesMarkdown: "Port 80 open. Title: Synthetic Router Login.",
    };
    const masked = maskReportBundle(bundle);

    expect(masked.maskedFields).toBe(0);
    expect(masked.bundle.notesMarkdown).toBe(bundle.notesMarkdown);
    expect(masked.bundle.engagement.description).toBe(null);
  });

  it("keeps an ordinarily masked bundle inside the report contract", () => {
    const masked = maskReportBundle(bundleFixture());

    expect(ReportBundleSchema.safeParse(masked.bundle).success).toBe(true);
  });

  it("masks the whole title and name when a replacement would overflow their bounds", () => {
    // Both inputs sit inside their 120-code-point limits, but the credential
    // replacement grows them past it, so each field becomes the token.
    const title = `${"t".repeat(110)} token=x`;
    const name = `${"n".repeat(110)} token=y`;
    expect(title.length).toBeLessThanOrEqual(120);
    expect(name.length).toBeLessThanOrEqual(120);
    const base = bundleFixture();
    const bundle: ReportBundle = {
      ...base,
      engagement: { ...base.engagement, name },
      findings: base.findings.map((finding) => ({ ...finding, title })),
    };
    expect(ReportBundleSchema.safeParse(bundle).success).toBe(true);
    const masked = maskReportBundle(bundle);

    expect(masked.bundle.findings[0]?.title).toBe(ADVISOR_REDACTION_TOKEN);
    expect(masked.bundle.engagement.name).toBe(ADVISOR_REDACTION_TOKEN);
    expect(masked.bundle.findings[0]?.title).not.toContain("token=x");
    expect(masked.bundle.engagement.name).not.toContain("token=y");
    // Full-field fallback still counts each changed field once.
    expect(masked.maskedFields).toBe(4);
    // Every export validates, and the stored original is exact.
    expect(ReportBundleSchema.safeParse(masked.bundle).success).toBe(true);
    expect(bundle.engagement.name).toBe(name);
    expect(bundle.findings[0]?.title).toBe(title);
  });

  it("masks whole notes when a replacement would overflow the notes byte bound", () => {
    // Input sits exactly at the exported byte limit; the credential
    // replacement grows it past the limit, so the field becomes the token.
    const secret = "token=z";
    const notes = `${"a".repeat(ENGAGEMENT_NOTES_MAX_BYTES - secret.length)}${secret}`;
    const base = bundleFixture();
    const bundle: ReportBundle = { ...base, notesMarkdown: notes };
    expect(ReportBundleSchema.safeParse(bundle).success).toBe(true);
    const masked = maskReportBundle(bundle);

    expect(masked.bundle.notesMarkdown).toBe(ADVISOR_REDACTION_TOKEN);
    expect(masked.bundle.notesMarkdown).not.toContain(secret);
    expect(masked.maskedFields).toBe(3);
    expect(ReportBundleSchema.safeParse(masked.bundle).success).toBe(true);
    expect(bundle.notesMarkdown).toBe(notes);
  });
});
