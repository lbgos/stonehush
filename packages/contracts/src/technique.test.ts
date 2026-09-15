import { describe, expect, it } from "vitest";

import {
  CreateTechniqueRequestSchema,
  TECHNIQUE_CONTRACT_VERSION,
  TechniqueIdParamsSchema,
  TechniqueSchema,
} from "./technique.js";

const ENGAGEMENT_ID = "10000000-0000-4000-8000-000000000001";
const TECHNIQUE_ID = "10000000-0000-4000-8000-000000000002";

function validTechnique(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: TECHNIQUE_CONTRACT_VERSION,
    id: TECHNIQUE_ID,
    engagementId: ENGAGEMENT_ID,
    name: "Check for default credentials",
    whenUseful: "A login form appears on a discovered HTTP service.",
    prerequisites: ["HTTP service with a login form"],
    question: "Does the login accept default credentials?",
    procedure: [
      { instruction: "Open the login form.", command: "curl -s {{url}}" },
      { instruction: "Try one documented default pair only." },
    ],
    meaning: "A successful login proves weak credentials; a rejection rules them out.",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("technique contracts", () => {
  it("accepts a valid technique", () => {
    expect(TechniqueSchema.safeParse(validTechnique()).success).toBe(true);
  });

  it("rejects blank names and multiline commands", () => {
    expect(
      TechniqueSchema.safeParse(validTechnique({ name: "  " })).success,
    ).toBe(false);
    expect(
      TechniqueSchema.safeParse(
        validTechnique({ procedure: [{ instruction: "Do it.", command: "a\nb" }] }),
      ).success,
    ).toBe(false);
  });

  it("rejects empty procedures and oversized prerequisite lists", () => {
    expect(
      TechniqueSchema.safeParse(validTechnique({ procedure: [] })).success,
    ).toBe(false);
    expect(
      TechniqueSchema.safeParse(
        validTechnique({ prerequisites: Array.from({ length: 9 }, (_, i) => `need ${i}`) }),
      ).success,
    ).toBe(false);
  });

  it("applies create-request defaults", () => {
    const parsed = CreateTechniqueRequestSchema.safeParse({
      name: "Probe titles",
      question: "Which pages expose titles?",
      procedure: [{ instruction: "Fetch the page." }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.whenUseful).toBe("");
      expect(parsed.data.prerequisites).toEqual([]);
      expect(parsed.data.meaning).toBe("");
    }
  });

  it("validates technique id params", () => {
    expect(
      TechniqueIdParamsSchema.safeParse({
        engagementId: ENGAGEMENT_ID,
        techniqueId: TECHNIQUE_ID,
      }).success,
    ).toBe(true);
    expect(
      TechniqueIdParamsSchema.safeParse({ engagementId: ENGAGEMENT_ID }).success,
    ).toBe(false);
  });
});
