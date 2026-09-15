import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerEngagementResumeRoutes } from "./engagement-resume-routes.js";
import { registerEngagementSearchRoutes } from "./engagement-search-routes.js";

const ENGAGEMENT_ID = "10000000-0000-4000-8000-000000000001";

function engagementValue() {
  return {
    engagement: {
      contractVersion: 1 as const,
      id: ENGAGEMENT_ID,
      revision: 1,
      name: "Resume lab",
      kind: "lab" as const,
      status: "active" as const,
      description: null,
      authorizationContext: null,
      autoContinueWarnings: false,
      activeScopeRevisionId: null,
      deadlineAt: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
    activeScopeRevision: null,
  };
}

function resumeDeps() {
  let stored: { nextStep: string | null; updatedAt: string; revision: number } = {
    nextStep: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
    revision: 0,
  };
  return {
    resume: {
      getNextStep: (engagementId: string) => ({
        ok: true as const,
        value: { engagementId, nextStep: stored.nextStep, updatedAt: stored.updatedAt, revision: stored.revision },
      }),
      putNextStep: (engagementId: string, input: unknown) => {
        const body = input as { nextStep: string | null; expectedRevision: number };
        if (typeof body.nextStep === "string" && body.nextStep.includes("\n")) {
          return { ok: false as const, error: { code: "invalid_repository_input" as const } };
        }
        if (body.expectedRevision !== stored.revision) {
          return { ok: false as const, error: { code: "revision_conflict" as const, currentRevision: stored.revision } };
        }
        stored = { nextStep: body.nextStep, updatedAt: "2026-09-10T00:00:00.000Z", revision: stored.revision + 1 };
        return { ok: true as const, value: { engagementId, ...stored } };
      },
    },
    engagements: {
      getEngagement: (_id: string) => ({ ok: true as const, value: engagementValue() }),
      getEngagementNotes: (engagementId: string) => ({
        ok: true as const,
        value: {
          engagementId,
          markdown: "admin page notes",
          updatedAt: "2026-09-09T00:00:00.000Z",
          revision: 1,
        },
      }),
      listFindings: (_id: string) => ({
        ok: true as const,
        value: [
          {
            contractVersion: 1 as const,
            id: "f-1",
            engagementId: ENGAGEMENT_ID,
            title: "Weak login",
            severity: "medium" as const,
            status: "open" as const,
            body: "details",
            evidenceArtifactIds: [],
            revision: 1,
            createdAt: "2020-01-01T00:00:00.000Z",
            updatedAt: "2020-01-01T00:00:00.000Z",
          },
        ],
      }),
      listScopeRevisions: (_id: string) => ({ ok: true as const, value: [] as never[] }),
    },
    runs: {
      listRunsForEngagement: (_id: string, _options: { limit: number }) => ({
        ok: true as const,
        runs: [
          {
            contractVersion: 1 as const,
            id: "run-1",
            actionId: "action-1",
            engagementId: ENGAGEMENT_ID,
            attempt: 1,
            state: "succeeded" as const,
            currentLeaseId: null,
            currentFence: "1",
            terminalKind: "succeeded" as const,
            terminalReason: null,
            createdAt: "2026-09-08T00:00:00.000Z",
            updatedAt: "2026-09-08T01:00:00.000Z",
          },
        ],
      }),
    },
    services: {
      listForEngagement: (_id: string) => ({
        ok: true as const,
        value: [
          {
            source: "nmap" as const,
            parserVersion: "nmap-xml-v1",
            address: "10.0.0.1",
            port: 80,
            protocol: "tcp" as const,
            hostname: null,
            serviceName: "http",
            product: null,
            version: null,
            observedAt: "2020-06-01T00:00:00.000Z",
            runId: "run-1",
            artifactId: "artifact-1",
            artifactDigest: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          },
        ],
      }),
    },
  };
}

describe("engagement resume routes", () => {
  it("sets one next step and returns it with a factual change list", async () => {
    const app = Fastify();
    registerEngagementResumeRoutes(app, resumeDeps());
    const saved = await app.inject({
      method: "PUT",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/next-step`,
      payload: { nextStep: "Probe port 8080 next.", expectedRevision: 0 },
    });
    expect(saved.statusCode).toBe(200);

    const resumed = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/resume`,
    });
    expect(resumed.statusCode).toBe(200);
    const body = resumed.json() as {
      nextStep: string;
      changes: { kind: string; snapshot: boolean }[];
    };
    expect(body.nextStep).toBe("Probe port 8080 next.");
    // Projection rows read as snapshot, lifecycle rows do not.
    const service = body.changes.find((change) => change.kind === "service");
    expect(service?.snapshot).toBe(true);
    const run = body.changes.find((change) => change.kind === "run");
    expect(run?.snapshot).toBe(false);
    await app.close();
  });

  it("rejects multiline next steps and conflicts on stale revisions", async () => {
    const app = Fastify();
    registerEngagementResumeRoutes(app, resumeDeps());
    const bad = await app.inject({
      method: "PUT",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/next-step`,
      payload: { nextStep: "line one\nline two", expectedRevision: 0 },
    });
    expect(bad.statusCode).toBe(400);
    const conflict = await app.inject({
      method: "PUT",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/next-step`,
      payload: { nextStep: "Something else.", expectedRevision: 99 },
    });
    expect(conflict.statusCode).toBe(409);
    await app.close();
  });

  it("filters the change list by last visit without fabricating entries", async () => {
    const app = Fastify();
    registerEngagementResumeRoutes(app, resumeDeps());
    const resumed = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/resume?since=2026-09-05T00:00:00.000Z`,
    });
    expect(resumed.statusCode).toBe(200);
    const body = resumed.json() as { changes: { id: string }[] };
    // The 2020 finding and service predate the visit; only recent rows remain.
    expect(body.changes.map((change) => change.id)).not.toContain("f-1");
    await app.close();
  });

  it("keeps the newest findings and reports truncation", async () => {
    const app = Fastify();
    const deps = resumeDeps();
    const oldestFirst = Array.from({ length: 51 }, (_, index) => ({
      contractVersion: 1 as const,
      id: `f-${String(index).padStart(2, "0")}`,
      engagementId: ENGAGEMENT_ID,
      title: `Finding ${String(index).padStart(2, "0")}`,
      severity: "low" as const,
      status: "open" as const,
      body: "details",
      evidenceArtifactIds: [] as string[],
      revision: 1,
      createdAt: `2026-08-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      updatedAt: `2026-08-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
    }));
    registerEngagementResumeRoutes(app, {
      ...deps,
      engagements: {
        ...deps.engagements,
        listFindings: (_id: string) => ({ ok: true as const, value: oldestFirst }),
      },
    });
    const resumed = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/resume`,
    });
    expect(resumed.statusCode).toBe(200);
    const body = resumed.json() as { complete: boolean; changes: { kind: string; id: string }[] };
    expect(body.complete).toBe(false);
    const findingIds = body.changes.filter((change) => change.kind === "finding").map((change) => change.id);
    // Newest kept (f-50), oldest dropped (f-00).
    expect(findingIds).toContain("f-50");
    expect(findingIds).not.toContain("f-00");
    await app.close();
  });
});

describe("engagement search routes", () => {
  const SCOPE_REVISION_ID = "20000000-0000-4000-8000-000000000001";
  const SCOPE_RULE_ID = "rule-admin-portal";
  function searchDeps() {
    return {
      engagements: {
        getEngagement: (_id: string) => ({ ok: true as const, value: engagementValue() }),
        getEngagementNotes: (engagementId: string) => ({
          ok: true as const,
          value: {
            engagementId,
            markdown: "the admin page lists users",
            updatedAt: "2026-09-09T00:00:00.000Z",
            revision: 1,
          },
        }),
        listScopeRevisions: (_id: string) => ({
          ok: true as const,
          value: [
            {
              contractVersion: 1 as const,
              id: SCOPE_REVISION_ID,
              engagementId: ENGAGEMENT_ID,
              version: 1,
              rules: [
                {
                  id: SCOPE_RULE_ID,
                  kind: "domain" as const,
                  target: {
                    kind: "hostname" as const,
                    normalizationProfile: "d1-v1" as const,
                    hostname: "admin-portal.example",
                  },
                  includeSubdomains: false,
                },
              ],
              createdAt: "2026-09-01T00:00:00.000Z",
            },
          ],
        }),
        listFindings: (_id: string) => ({
          ok: true as const,
          value: [
            {
              contractVersion: 1 as const,
              id: "f-9",
              engagementId: ENGAGEMENT_ID,
              title: "login issue",
              severity: "low" as const,
              status: "open" as const,
              body: "admin login flow",
              evidenceArtifactIds: [],
              revision: 1,
              createdAt: "2026-09-09T00:00:00.000Z",
              updatedAt: "2026-09-09T00:00:00.000Z",
            },
          ],
        }),
      },
      services: { listForEngagement: (_id: string) => ({ ok: true as const, value: [] as never[] }) },
      ffuf: {
        listForEngagement: (_id: string) => ({
          ok: true as const,
          value: [
            {
              source: "ffuf" as const,
              parserVersion: "ffuf-json-v1" as const,
              url: "http://svc.example/admin",
              status: 200,
              length: 512,
              words: 40,
              lines: 12,
              redirectlocation: null,
              fuzz: "admin",
              runId: "run-9",
              artifactId: "artifact-9",
              artifactDigest:
                "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
              observedAt: "2026-09-09T00:00:00.000Z",
            },
          ],
        }),
      },
      probes: { listForEngagement: (_id: string) => ({ ok: true as const, value: [] as never[] }) },
      artifacts: { listArtifactsForEngagement: (_id: string) => ({ ok: true as const, artifacts: [] as never[] }) },
    };
  }

  it("finds a note and a finding grouped by type with exact anchors", async () => {
    const app = Fastify();
    registerEngagementSearchRoutes(app, searchDeps());
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/search?q=admin`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      groups: Record<string, { id: string; anchor: string }[]>;
      unindexedKinds: string[];
    };
    // Exact passage: the match offset inside the notes text, not the top.
    expect(body.groups["note"]?.[0]?.anchor).toBe("note:notes@4");
    expect(body.groups["finding"]?.[0]?.anchor).toBe("finding:f-9");
    // Exact rule and exact ffuf row, not the revision or run top level.
    expect(body.groups["target"]?.[0]?.anchor).toBe(`scope:${SCOPE_REVISION_ID}:${SCOPE_RULE_ID}`);
    expect(body.groups["artifact"]?.[0]?.anchor).toBe("run:run-9:fuzz:admin");
    // Leads and excerpts have no index in this slice: labeled, not hidden.
    expect(body.unindexedKinds).toContain("lead");
    expect(body.unindexedKinds).toContain("excerpt");
    await app.close();
  });

  it("excludes secret values from results", async () => {
    const app = Fastify();
    const deps = searchDeps();
    registerEngagementSearchRoutes(app, {
      ...deps,
      engagements: {
        ...deps.engagements,
        getEngagementNotes: (engagementId: string) => ({
          ok: true as const,
          value: {
            engagementId,
            markdown: "flag{super-secret}",
            updatedAt: "2026-09-09T00:00:00.000Z",
            revision: 1,
          },
        }),
      },
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/search?q=flag`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { groups: Record<string, unknown[]> };
    expect(body.groups["note"]).toEqual([]);
    await app.close();
  });

  it("rejects empty and unknown queries", async () => {
    const app = Fastify();
    registerEngagementSearchRoutes(app, searchDeps());
    expect((await app.inject({ method: "GET", url: `/api/v1/engagements/${ENGAGEMENT_ID}/search?q=+++` })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/api/v1/engagements/${ENGAGEMENT_ID}/search?q=a&limit=5` })).statusCode).toBe(400);
    await app.close();
  });

  it("bounds overlong ffuf and probe urls instead of failing the search", async () => {
    const longPath = `admin-${"x".repeat(2000)}`;
    const longUrl = `http://svc.example/${longPath}`;
    const app = Fastify();
    const deps = searchDeps();
    registerEngagementSearchRoutes(app, {
      ...deps,
      ffuf: {
        listForEngagement: (_id: string) => ({
          ok: true as const,
          value: [
            {
              source: "ffuf" as const,
              parserVersion: "ffuf-json-v1" as const,
              url: longUrl,
              status: 200,
              length: 512,
              words: 40,
              lines: 12,
              redirectlocation: null,
              fuzz: longPath,
              runId: "run-9",
              artifactId: "artifact-9",
              artifactDigest:
                "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
              observedAt: "2026-09-09T00:00:00.000Z",
            },
          ],
        }),
      },
      probes: {
        listForEngagement: (_id: string) => ({
          ok: true as const,
          value: [
            {
              source: "http-probe" as const,
              parserVersion: "http-probe-raw-v1",
              url: longUrl,
              fetchedAt: "2026-09-09T00:00:00.000Z",
              finalUrl: longUrl,
              status: 200,
              title: "admin page",
              selectedHeaders: { contentType: null, server: null, poweredBy: null },
              hops: [],
              error: null,
              runId: "run-9",
              artifactId: "artifact-9",
              artifactDigest:
                "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
              observedAt: "2026-09-09T00:00:00.000Z",
            },
          ],
        }),
      },
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/search?q=admin`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      groups: Record<string, { id: string; anchor: string; title: string }[]>;
    };
    for (const result of [...(body.groups["artifact"] ?? []), ...(body.groups["hostname"] ?? [])]) {
      expect(result.id.length).toBeLessThanOrEqual(255);
      expect(result.anchor.length).toBeLessThanOrEqual(500);
      expect(result.title.length).toBeLessThanOrEqual(300);
    }
    await app.close();
  });
});
