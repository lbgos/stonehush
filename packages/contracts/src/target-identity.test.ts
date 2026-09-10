import { describe, expect, it } from "vitest";

import {
  ChangeTargetAddressRequestSchema,
  formatRecordedSessionLabel,
  HOSTS_FILE_EDIT_POLICY,
  RUNNER_HOST_MAPPING_NOTE,
  RUNNER_MAPPING_NEXT_STEP,
  STONE_COPY_ACTION_LABELS,
  StoneAddressBindingSchema,
  StoneHostnameAssociationSchema,
  StoneTargetContextSchema,
} from "./target-identity.js";

const TARGET_ID = "10000000-0000-4000-8000-000000000001";
const ENGAGEMENT_ID = "10000000-0000-4000-8000-000000000002";
const BINDING_ID = "10000000-0000-4000-8000-000000000003";

describe("stone target identity contracts", () => {
  it("accepts a current binding and a recorded target context", () => {
    const binding = StoneAddressBindingSchema.parse({
      contractVersion: 1,
      id: BINDING_ID,
      engagementId: ENGAGEMENT_ID,
      targetId: TARGET_ID,
      bindingKind: "ip",
      addressText: "10.0.0.5",
      status: "current",
      createdAt: "2026-08-12T12:00:00.000Z",
      supersededAt: null,
    });
    expect(binding.status).toBe("current");
    const context = StoneTargetContextSchema.parse({
      target: {
        contractVersion: 1,
        id: TARGET_ID,
        engagementId: ENGAGEMENT_ID,
        label: "web01",
        revision: 1,
        createdAt: "2026-08-12T12:00:00.000Z",
        updatedAt: "2026-08-12T12:00:00.000Z",
      },
      currentBinding: binding,
      historicalBindings: [],
      origins: [],
      accountRef: null,
      connectionRef: null,
      lastConfirmedAt: "2026-08-12T12:05:00.000Z",
      sessionLabel: "Recorded",
    });
    expect(context.sessionLabel).toBe("Recorded");
  });

  it("requires the runner-only mapping note and forbids hosts file edits", () => {
    const association = StoneHostnameAssociationSchema.parse({
      contractVersion: 1,
      id: BINDING_ID,
      engagementId: ENGAGEMENT_ID,
      targetId: TARGET_ID,
      connectionAddress: "10.0.0.5",
      requestedHostname: "app.internal",
      status: "proposed",
      runnerOnlyNote: RUNNER_HOST_MAPPING_NOTE,
      nextStep: RUNNER_MAPPING_NEXT_STEP,
      hostsFileEdited: false,
      createdAt: "2026-08-12T12:00:00.000Z",
      decidedAt: null,
    });
    expect(association.hostsFileEdited).toBe(false);
    expect(HOSTS_FILE_EDIT_POLICY).toBe("never_silent");
    const edited = StoneHostnameAssociationSchema.safeParse({
      ...association,
      hostsFileEdited: true,
    });
    expect(edited.success).toBe(false);
  });

  it("rejects live-connection wording in favor of Recorded plus Last confirmed", () => {
    expect(formatRecordedSessionLabel("2026-08-12T12:05:00.000Z")).toBe(
      "Recorded, Last confirmed 2026-08-12T12:05:00.000Z",
    );
    expect(formatRecordedSessionLabel(null)).toBe("Recorded");
    const label = formatRecordedSessionLabel("2026-08-12T12:05:00.000Z").toLowerCase();
    expect(label).not.toContain("live");
    expect(label).not.toContain("connected");
  });

  it("distinguishes copy actions for address, hostname, URL, and command", () => {
    expect(Object.keys(STONE_COPY_ACTION_LABELS).sort()).toEqual(
      ["address", "command", "hostname", "url"].sort(),
    );
    const labels = new Set(Object.values(STONE_COPY_ACTION_LABELS));
    expect(labels.size).toBe(4);
  });

  it("validates address change requests", () => {
    const parsed = ChangeTargetAddressRequestSchema.safeParse({
      targetId: TARGET_ID,
      newAddress: "10.0.0.9",
    });
    expect(parsed.success).toBe(true);
    expect(
      ChangeTargetAddressRequestSchema.safeParse({ targetId: TARGET_ID, newAddress: "" })
        .success,
    ).toBe(false);
  });
});
