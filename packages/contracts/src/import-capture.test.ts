import { describe, expect, it } from "vitest";

import {
  CreateStoneCaptureRequestSchema,
  findInventedExecutionFacts,
  INVENTED_EXECUTION_FACT_FIELDS,
  originLabelForKind,
  proposeCaptureTitle,
  StoneCaptureSchema,
} from "./import-capture.js";

const ENGAGEMENT_ID = "10000000-0000-4000-8000-000000000002";
const TARGET_ID = "10000000-0000-4000-8000-000000000001";
const CAPTURE_ID = "10000000-0000-4000-8000-000000000003";
const DIGEST =
  "sha256:0000000000000000000000000000000000000000000000000000000000000000";

describe("stone import capture contracts", () => {
  it("accepts a pasted terminal capture with command and observation", () => {
    const parsed = CreateStoneCaptureRequestSchema.safeParse({
      engagementId: ENGAGEMENT_ID,
      targetId: TARGET_ID,
      leadId: null,
      kind: "pasted_terminal",
      title: "nmap on web01",
      command: "nmap -sV 10.0.0.5",
      observation: "port 80 open",
      contentText: "Nmap scan report",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects invented execution facts at the boundary", () => {
    const body = {
      engagementId: ENGAGEMENT_ID,
      targetId: null,
      leadId: null,
      kind: "pasted_terminal",
      title: "pasted output",
      contentText: "output",
      startedAt: "2026-08-12T12:00:00.000Z",
      exitCode: 0,
      executedCommand: "nmap 10.0.0.5",
    };
    expect(findInventedExecutionFacts(body).sort()).toEqual(
      ["executedCommand", "exitCode", "startedAt"].sort(),
    );
    expect(INVENTED_EXECUTION_FACT_FIELDS.length).toBeGreaterThan(0);
    const parsed = CreateStoneCaptureRequestSchema.safeParse(body);
    expect(parsed.success).toBe(false);
  });

  it("rejects multiline observations", () => {
    const parsed = CreateStoneCaptureRequestSchema.safeParse({
      engagementId: ENGAGEMENT_ID,
      targetId: null,
      leadId: null,
      kind: "pasted_terminal",
      title: "pasted output",
      observation: "line one\nline two",
      contentText: "output",
    });
    expect(parsed.success).toBe(false);
  });

  it("labels pasted and imported origins distinctly from runner facts", () => {
    expect(originLabelForKind("pasted_terminal")).toBe("pasted");
    expect(originLabelForKind("screenshot")).toBe("pasted");
    expect(originLabelForKind("nmap_xml")).toBe("imported");
    expect(originLabelForKind("ffuf_json")).toBe("imported");
    const capture = StoneCaptureSchema.parse({
      contractVersion: 1,
      id: CAPTURE_ID,
      engagementId: ENGAGEMENT_ID,
      targetId: TARGET_ID,
      leadId: null,
      kind: "nmap_xml",
      originLabel: "imported",
      title: "Nmap import for web01",
      command: null,
      observation: null,
      contentDigest: DIGEST,
      provenanceExistingId: null,
      byteSize: 128,
      createdAt: "2026-08-12T12:00:00.000Z",
    });
    expect(capture.originLabel).toBe("imported");
  });

  it("proposes a readable title without inventing metadata", () => {
    expect(
      proposeCaptureTitle({ kind: "pasted_terminal", command: "nmap -sV 10.0.0.5" }),
    ).toContain("nmap");
    expect(
      proposeCaptureTitle({ kind: "screenshot", targetLabel: "web01" }),
    ).toContain("web01");
  });
});
