import { describe, expect, it } from "vitest";

import type { EngagementWithActiveScope, Finding } from "@stonehush/contracts";
import type { EngagementArtifactRecord } from "@stonehush/db";

import {
  assembleAdvisorContext,
  type AdvisorContextDeps,
} from "./advisor-context.js";
import type { VerifiedExcerptResult } from "../evidence/evidence-store.js";

// Assembly tests use hand fakes typed against the production Picks, with
// real record shapes throughout: full findings, full artifact rows, and
// Buffer excerpt content. No store bytes leave fakes except through the
// counted verifiedExcerpt seam.

const ENGAGEMENT = "10000000-0000-4000-8000-000000000001";
const FINDING = "20000000-0000-4000-8000-000000000001";
const DIGEST = `sha256:${"ab".repeat(32)}`;
const SECRET = "flag{synthetic-fixture-0003}";
const STAMP = "2026-08-12T12:00:00.000Z";

interface FakeExcerpt {
  readonly content: Buffer;
  readonly totalBytes: number;
  readonly truncated: boolean;
}

interface FakeState {
  artifacts: Map<string, EngagementArtifactRecord>;
  findings: Map<string, Finding>;
  excerpts: Map<string, FakeExcerpt>;
  missing: Set<string>;
  corrupt: Set<string>;
  excerptCalls: string[];
  excerptArgs: Array<{
    artifactId: string;
    expectedSizeBytes: number;
    expectedDigest: string;
    maxBytes: number;
  }>;
  engagementCalls: number;
  engagementArchived: boolean;
}

function engagementDetail(status: "active" | "archived"): EngagementWithActiveScope {
  return {
    engagement: {
      contractVersion: 1,
      id: ENGAGEMENT,
      revision: 1,
      name: "Synthetic lab",
      kind: "lab",
      status,
      description: null,
      authorizationContext: null,
      autoContinueWarnings: false,
      activeScopeRevisionId: null,
      deadlineAt: null,
      createdAt: STAMP,
      updatedAt: STAMP,
    },
    activeScopeRevision: null,
  };
}

function artifactRecord(artifactId: string, sizeBytes: number): EngagementArtifactRecord {
  return {
    artifactId,
    contractVersion: 1,
    profile: "d3-v1",
    runId: "synthetic-run-1",
    fence: "1",
    eventSequence: 1,
    artifactSlot: "synthetic-slot",
    kind: "tool_raw",
    sizeBytes,
    digest: DIGEST,
    relativePath: `published/${artifactId}`,
    completeness: "complete",
    redactionApplied: false,
    redactionBoundary: "none",
    rawBytesPreserved: true,
    createdAt: STAMP,
    originalFileName: null,
    declaredContentType: null,
  };
}

function makeDeps(state: FakeState): AdvisorContextDeps {
  return {
    engagements: {
      getEngagement: (engagementId: string) => {
        state.engagementCalls += 1;
        if (engagementId !== ENGAGEMENT) {
          return { ok: false as const, error: { code: "engagement_not_found" as const } };
        }
        return {
          ok: true as const,
          value: engagementDetail(state.engagementArchived ? "archived" : "active"),
        };
      },
      getFindingForEngagement: (engagementId: string, findingId: string) => {
        if (engagementId !== ENGAGEMENT) {
          return { ok: false as const, error: { code: "engagement_not_found" as const } };
        }
        const finding = state.findings.get(findingId);
        if (finding === undefined) {
          return { ok: false as const, error: { code: "finding_not_found" as const } };
        }
        return { ok: true as const, value: finding };
      },
    },
    artifacts: {
      publishedArtifactForEngagement: ({ engagementId, artifactId }) => {
        if (engagementId !== ENGAGEMENT) return undefined;
        return state.artifacts.get(artifactId);
      },
    },
    excerpts: {
      verifiedExcerpt: async (args): Promise<VerifiedExcerptResult> => {
        state.excerptCalls.push(args.artifactId);
        state.excerptArgs.push({ ...args });
        if (state.missing.has(args.artifactId)) return { status: "missing" };
        if (state.corrupt.has(args.artifactId)) {
          return { status: "corrupt", code: "artifact_symlink_rejected" };
        }
        const entry = state.excerpts.get(args.artifactId);
        if (entry === undefined) return { status: "missing" };
        return {
          status: "ready",
          totalBytes: entry.totalBytes,
          truncated: entry.truncated,
          content: entry.content,
        };
      },
    },
  };
}

function emptyState(): FakeState {
  return {
    artifacts: new Map(),
    findings: new Map(),
    excerpts: new Map(),
    missing: new Set(),
    corrupt: new Set(),
    excerptCalls: [],
    excerptArgs: [],
    engagementCalls: 0,
    engagementArchived: false,
  };
}

function storeExcerpt(
  state: FakeState,
  id: string,
  content: Buffer,
  totalBytes = content.length,
  truncated = false,
): void {
  state.excerpts.set(id, { content, totalBytes, truncated });
}

function ownedArtifact(_id: string, text: string): { sizeBytes: number; content: Buffer } {
  const content = Buffer.from(text, "utf8");
  return { sizeBytes: content.length, content };
}

function ownedFinding(id: string, body: string): Finding {
  return {
    contractVersion: 1,
    id,
    engagementId: ENGAGEMENT,
    title: "Banner",
    severity: "medium",
    status: "open",
    body,
    evidenceArtifactIds: [],
    revision: 1,
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

function validRequest(overrides: Record<string, unknown> = {}) {
  return {
    engagementId: ENGAGEMENT,
    question: "What does this evidence show?",
    excerptArtifactIds: ["nmap-xml-1"],
    findingIds: [] as string[],
    ...overrides,
  };
}

describe("advisor context assembly", () => {
  it("assembles redacted output with no raw leakage", async () => {
    const state = emptyState();
    const owned = ownedArtifact("nmap-xml-1", `banner with ${SECRET} inside`);
    state.artifacts.set("nmap-xml-1", artifactRecord("nmap-xml-1", owned.sizeBytes));
    storeExcerpt(state, "nmap-xml-1", owned.content);
    state.findings.set(FINDING, ownedFinding(FINDING, "Port 80 open."));
    const result = await assembleAdvisorContext(
      {
        request: validRequest({ findingIds: [FINDING], question: `What does this evidence show? ${SECRET}` }),
        history: [{ question: "Earlier?", answer: "Earlier answer." }],
      },
      makeDeps(state),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.suppliedIds).toEqual([
      { kind: "artifact", id: "nmap-xml-1" },
      { kind: "finding", id: FINDING },
    ]);
    expect(result.value.redactions).toBeGreaterThan(0);
    expect(result.value.prompt.user).not.toContain(SECRET);
    expect(result.value.prompt.user).toContain("[redacted]");
    expect(result.value.excerpts).toEqual([
      { id: "nmap-xml-1", truncated: false, totalBytes: owned.sizeBytes },
    ]);
    expect(state.excerptArgs).toEqual([
      {
        artifactId: "nmap-xml-1",
        expectedSizeBytes: owned.sizeBytes,
        expectedDigest: DIGEST,
        maxBytes: 4096,
      },
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET);
    expect(result.value.prompt.user).toContain("What does this evidence show?");
    expect("question" in result.value).toBe(false);
    expect("history" in result.value).toBe(false);
    expect("blocks" in result.value).toBe(false);
  });

  it("reads archived engagements", async () => {
    const state = emptyState();
    state.engagementArchived = true;
    const owned = ownedArtifact("nmap-xml-1", "banner");
    state.artifacts.set("nmap-xml-1", artifactRecord("nmap-xml-1", owned.sizeBytes));
    storeExcerpt(state, "nmap-xml-1", owned.content);
    const result = await assembleAdvisorContext(
      { request: validRequest(), history: [] },
      makeDeps(state),
    );
    expect(result.ok).toBe(true);
  });

  it("touches no store bytes for unknown or foreign ids in any order", async () => {
    for (const excerptArtifactIds of [["nmap-xml-1", "foreign-1"], ["foreign-1", "nmap-xml-1"]]) {
      const state = emptyState();
      const owned = ownedArtifact("nmap-xml-1", "banner");
      state.artifacts.set("nmap-xml-1", artifactRecord("nmap-xml-1", owned.sizeBytes));
      storeExcerpt(state, "nmap-xml-1", owned.content);
      const result = await assembleAdvisorContext(
        { request: validRequest({ excerptArtifactIds }), history: [] },
        makeDeps(state),
      );
      expect(result).toEqual({ ok: false, error: { code: "unknown_artifact" } });
      expect(state.excerptCalls).toEqual([]);
    }
  });

  it("rejects unknown findings without store reads", async () => {
    const state = emptyState();
    const owned = ownedArtifact("nmap-xml-1", "banner");
    state.artifacts.set("nmap-xml-1", artifactRecord("nmap-xml-1", owned.sizeBytes));
    storeExcerpt(state, "nmap-xml-1", owned.content);
    const result = await assembleAdvisorContext(
      { request: validRequest({ findingIds: [FINDING] }), history: [] },
      makeDeps(state),
    );
    expect(result).toEqual({ ok: false, error: { code: "unknown_finding" } });
    expect(state.excerptCalls).toEqual([]);
  });

  it("maps store missing and corrupt outcomes", async () => {
    for (const [setup, code] of [
      [(state: FakeState) => state.missing.add("nmap-xml-1"), "missing_artifact"],
      [(state: FakeState) => state.corrupt.add("nmap-xml-1"), "corrupt_artifact"],
    ] as const) {
      const state = emptyState();
      const owned = ownedArtifact("nmap-xml-1", "banner");
      state.artifacts.set("nmap-xml-1", artifactRecord("nmap-xml-1", owned.sizeBytes));
      storeExcerpt(state, "nmap-xml-1", owned.content);
      setup(state);
      const result = await assembleAdvisorContext(
        { request: validRequest(), history: [] },
        makeDeps(state),
      );
      expect(result).toEqual({ ok: false, error: { code } });
    }
  });

  it("rejects invalid requests and history before any dependency", async () => {
    const cases: Array<{ request: unknown; history: readonly unknown[] }> = [
      { request: { ...validRequest(), question: "  padded  " }, history: [] },
      { request: { ...validRequest(), excerptArtifactIds: [] }, history: [] },
      { request: { ...validRequest(), excerptArtifactIds: ["a-1", "a-1"] }, history: [] },
      {
        request: validRequest(),
        history: Array.from({ length: 11 }, () => ({ question: "q", answer: "a" })),
      },
      { request: validRequest(), history: [{ question: "q", answer: "x".repeat(2001) }] },
      { request: validRequest(), history: ["not-an-object"] },
    ];
    for (const input of cases) {
      const state = emptyState();
      const result = await assembleAdvisorContext(input, makeDeps(state));
      expect(result).toEqual({ ok: false, error: { code: "invalid_input" } });
      expect(state.engagementCalls).toBe(0);
      expect(state.excerptCalls).toEqual([]);
    }
  });

  it("marks truncation truthfully and enforces the prompt budget", async () => {
    const state = emptyState();
    const big = Buffer.alloc(6_000, 120);
    state.artifacts.set("nmap-xml-1", artifactRecord("nmap-xml-1", 6_000));
    storeExcerpt(state, "nmap-xml-1", big.subarray(0, 4_096), 6_000, true);
    const truncated = await assembleAdvisorContext(
      { request: validRequest(), history: [] },
      makeDeps(state),
    );
    expect(truncated.ok).toBe(true);
    if (!truncated.ok) return;
    expect(truncated.value.excerpts).toEqual([
      { id: "nmap-xml-1", truncated: true, totalBytes: 6_000 },
    ]);
    expect(truncated.value.prompt.user).toContain(
      "[excerpt truncated: first 4096 of 6000 bytes]",
    );
    const oversized = emptyState();
    for (let index = 0; index < 4; index += 1) {
      const id = `artifact-${index}`;
      oversized.artifacts.set(id, artifactRecord(id, 4_096));
      storeExcerpt(oversized, id, Buffer.alloc(4_096, 120));
    }
    for (let index = 0; index < 8; index += 1) {
      const id = `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      oversized.findings.set(id, ownedFinding(id, "x".repeat(2_000)));
    }
    const overBudget = await assembleAdvisorContext(
      {
        request: validRequest({
          excerptArtifactIds: ["artifact-0", "artifact-1", "artifact-2", "artifact-3"],
          findingIds: [...oversized.findings.keys()],
        }),
        history: [],
      },
      makeDeps(oversized),
    );
    expect(overBudget).toEqual({ ok: false, error: { code: "context_too_large" } });
  });

  it("clips long finding bodies with a codepoint-safe marker", async () => {
    const state = emptyState();
    const owned = ownedArtifact("nmap-xml-1", "banner");
    state.artifacts.set("nmap-xml-1", artifactRecord("nmap-xml-1", owned.sizeBytes));
    storeExcerpt(state, "nmap-xml-1", owned.content);
    state.findings.set(FINDING, ownedFinding(FINDING, `é${"x".repeat(3_000)}`));
    const result = await assembleAdvisorContext(
      { request: validRequest({ findingIds: [FINDING] }), history: [] },
      makeDeps(state),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.prompt.user).toContain("[truncated]");
    expect(result.value.prompt.user).toContain("é");
  });
});
