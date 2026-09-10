import { describe, expect, it } from "vitest";

import {
  CaptureObjectiveRequestSchema,
  CreateObjectiveRequestSchema,
  ObjectiveResponseSchema,
  SubmitObjectiveRequestSchema,
} from "./objectives.js";

const OBJECTIVE_ID = "10000000-0000-4000-8000-000000000003";
const ENGAGEMENT_ID = "10000000-0000-4000-8000-000000000002";

function objectiveRecord(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: 1,
    id: OBJECTIVE_ID,
    engagementId: ENGAGEMENT_ID,
    name: "user flag",
    kind: "user_flag",
    state: "open",
    proofHint: null,
    proofDigest: null,
    capturedAt: null,
    submittedAt: null,
    createdAt: "2026-08-12T12:00:00.000Z",
    updatedAt: "2026-08-12T12:00:00.000Z",
    ...overrides,
  };
}

describe("objective contracts", () => {
  it("supports user, root, single-proof, and custom goals", () => {
    for (const kind of ["user_flag", "root_flag", "single_proof", "custom"] as const) {
      const result = CreateObjectiveRequestSchema.safeParse({ name: "goal", kind });
      expect(result.success).toBe(true);
    }
  });

  it("keeps captured and submitted distinct with separate timestamps", () => {
    const parsed = ObjectiveResponseSchema.safeParse(
      objectiveRecord({
        state: "submitted",
        proofHint: "32 bytes",
        proofDigest: `sha256:${"0".repeat(64)}`,
        capturedAt: "2026-08-12T12:00:00.000Z",
        submittedAt: "2026-08-12T13:00:00.000Z",
      }),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.capturedAt).not.toBe(parsed.data.submittedAt);
    }
  });

  it("never returns the proof value: responses reject proofValue", () => {
    const parsed = ObjectiveResponseSchema.safeParse(
      objectiveRecord({ proofValue: "flag{synthetic-proof-0001}" }),
    );
    expect(parsed.success).toBe(false);
  });

  it("rejects scores, percentages, and other score theater", () => {
    for (const extra of ["score", "points", "percentComplete", "progress"]) {
      const result = CreateObjectiveRequestSchema.safeParse({
        name: "goal",
        kind: "custom",
        [extra]: 50,
      });
      expect(result.success).toBe(false);
      const response = ObjectiveResponseSchema.safeParse(
        objectiveRecord({ [extra]: 50 }),
      );
      expect(response.success).toBe(false);
    }
  });

  it("accepts capture and submission payloads", () => {
    expect(
      CaptureObjectiveRequestSchema.safeParse({ proofValue: "flag{synthetic-proof-0001}" })
        .success,
    ).toBe(true);
    expect(CaptureObjectiveRequestSchema.safeParse({ proofValue: "" }).success).toBe(false);
    expect(SubmitObjectiveRequestSchema.safeParse({}).success).toBe(true);
  });
});
