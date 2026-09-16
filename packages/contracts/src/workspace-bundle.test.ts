import { describe, expect, it } from "vitest";

import {
  WORKSPACE_BUNDLE_KIND,
  WORKSPACE_BUNDLE_VERSION,
  WorkspaceBundleSchema,
  WorkspaceBundleVersionProbeSchema,
  workspaceBundleRawBytes,
} from "./workspace-bundle.js";

const DIGEST = `sha256:${"ab".repeat(32)}`;
const ENGAGEMENT_ID = "10000000-0000-4000-8000-000000000001";

function minimalBundle() {
  return {
    kind: WORKSPACE_BUNDLE_KIND,
    bundleVersion: WORKSPACE_BUNDLE_VERSION,
    exportedAt: "2026-09-01T12:00:00.000Z",
    sourceEngagementId: ENGAGEMENT_ID,
    sourceEngagementName: "Source lab",
    privateCopy: false,
    engagement: {
      name: "Source lab",
      kind: "lab",
      deadlineAt: null,
      description: null,
      authorizationContext: null,
    },
    notes: { markdown: "", updatedAt: "2026-09-01T12:00:00.000Z" },
    leads: [],
    attempts: [],
    excerpts: [],
    attachments: [],
    findings: [],
    evidence: [],
    secrets: [],
    objectives: [],
  };
}

describe("workspace bundle contract", () => {
  it("accepts a minimal default bundle", () => {
    expect(WorkspaceBundleSchema.safeParse(minimalBundle()).success).toBe(true);
  });

  it("rejects secret records in a default bundle", () => {
    const bundle = minimalBundle();
    const parsed = WorkspaceBundleSchema.safeParse({
      ...bundle,
      secrets: [
        {
          contractVersion: 1,
          id: ENGAGEMENT_ID,
          engagementId: ENGAGEMENT_ID,
          label: "db",
          username: null,
          serviceRef: "svc",
          secretRef: "vault",
          hint: null,
          verifications: [],
          createdAt: "2026-09-01T12:00:00.000Z",
          updatedAt: "2026-09-01T12:00:00.000Z",
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects client identifiers in a default bundle", () => {
    const bundle = minimalBundle();
    const parsed = WorkspaceBundleSchema.safeParse({
      ...bundle,
      engagement: {
        ...bundle.engagement,
        description: "client network",
      },
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts private data only under the private-copy opt-in", () => {
    const bundle = minimalBundle();
    const parsed = WorkspaceBundleSchema.safeParse({
      ...bundle,
      privateCopy: true,
      engagement: {
        ...bundle.engagement,
        description: "client network",
        authorizationContext: "ROE-7",
      },
      evidence: [
        {
          artifactId: "artifact-1",
          kind: "tool_raw",
          sizeBytes: 2,
          digest: DIGEST,
          completeness: "complete",
          artifactSlot: "nmap-xml",
          originalRunId: "run-1",
          contentBase64: "aGk=",
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("probes kind and version before full validation", () => {
    expect(
      WorkspaceBundleVersionProbeSchema.safeParse({
        kind: "something-else-v9",
        bundleVersion: 9,
      }).success,
    ).toBe(true);
    const probed = WorkspaceBundleVersionProbeSchema.parse({
      kind: "something-else-v9",
      bundleVersion: 9,
    });
    expect(probed.kind).not.toBe(WORKSPACE_BUNDLE_KIND);
    expect(probed.bundleVersion).not.toBe(WORKSPACE_BUNDLE_VERSION);
  });

  it("sums raw evidence bytes from metadata", () => {
    expect(
      workspaceBundleRawBytes([{ sizeBytes: 3 }, { sizeBytes: 4 }]),
    ).toBe(7);
    expect(workspaceBundleRawBytes([])).toBe(0);
  });
});
