import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { ExcerptRepository, EngagementRepository, openEngagementDatabase } from "@stonehush/db";

import type { EvidenceStore } from "./evidence/evidence-store.js";
import { registerExcerptRoutes } from "./excerpt-routes.js";

const ENGAGEMENT_ID = "10000000-0000-4000-8000-000000000001";
const RUN_ID = "run-excerpt-1";
const ARTIFACT_ID = "artifact-stdout";
const STDOUT_BYTES = Buffer.from(
  "80/tcp open http\nlogin page ok\nflag{excerpt-secret-value}\npassword=hunter2\n",
  "utf8",
);

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

interface Harness {
  directory: string;
  database: ReturnType<typeof openEngagementDatabase>;
  excerpts: ExcerptRepository;
  inject: (options: {
    method: "GET" | "POST" | "PATCH";
    url: string;
    payload?: Record<string, unknown>;
  }) => Promise<{ statusCode: number; json(): unknown }>;
  artifacts: Map<string, Buffer>;
  extraArtifacts: { artifactId: string; kind: string }[];
  archived: { current: boolean };
}

const harnesses: Harness[] = [];

async function createHarness(): Promise<Harness> {
  const directory = mkdtempSync(path.join(tmpdir(), "stonehush-excerpt-routes-"));
  chmodSync(directory, 0o700);
  const database = openEngagementDatabase({ dataDirectory: directory });
  const excerpts = new ExcerptRepository(database.db);
  const engagementRepository = new EngagementRepository(database.db, {
    createId: () => ENGAGEMENT_ID,
    now: () => new Date("2026-08-12T12:00:00.000Z"),
  });
  const createdEngagement = engagementRepository.createEngagement({
    name: "Excerpt lab",
    kind: "lab",
    description: null,
    authorizationContext: null,
    autoContinueWarnings: false,
  });
  if (!createdEngagement.ok) throw new Error("fixture engagement missing");
  const artifacts = new Map<string, Buffer>([[ARTIFACT_ID, STDOUT_BYTES]]);
  const extraArtifacts: { artifactId: string; kind: string }[] = [];
  const archived = { current: false };
  const app = Fastify({ logger: false });
  registerExcerptRoutes(app, {
    engagements: {
      getEngagement: (engagementId: string) => {
        if (engagementId !== ENGAGEMENT_ID) {
          return { ok: false as const, error: { code: "engagement_not_found" as const } };
        }
        return {
          ok: true as const,
          value: {
            engagement: { status: archived.current ? "archived" : "active" },
            activeScopeRevision: null,
          },
        } as unknown as ReturnType<
          import("@stonehush/db").EngagementRepository["getEngagement"]
        >;
      },
    },
    excerpts,
    runs: {
      runForEngagement: (engagementId: string, runId: string) => {
        if (engagementId !== ENGAGEMENT_ID) {
          return { ok: false as const, code: "engagement_not_found" as const };
        }
        if (runId !== RUN_ID) return { ok: true as const, run: undefined };
        return {
          ok: true as const,
          run: { id: RUN_ID, engagementId: ENGAGEMENT_ID },
        } as unknown as ReturnType<
          import("@stonehush/db").RunOutputRepository["runForEngagement"]
        >;
      },
      artifactsForRun: (runId: string) => {
        if (runId !== RUN_ID) return { ok: true as const, artifacts: [] };
        const rows: {
          artifactId: string;
          runId: string;
          kind: string;
          sizeBytes: number;
          digest: string;
          completeness: string;
        }[] = [
          {
            artifactId: ARTIFACT_ID,
            runId: RUN_ID,
            kind: "stdout",
            sizeBytes: STDOUT_BYTES.length,
            digest: sha256(STDOUT_BYTES),
            completeness: "complete",
          },
        ];
        for (const extra of extraArtifacts) {
          const bytes = artifacts.get(extra.artifactId);
          if (bytes === undefined) throw new Error(`fixture bytes missing: ${extra.artifactId}`);
          rows.push({
            artifactId: extra.artifactId,
            runId: RUN_ID,
            kind: extra.kind,
            sizeBytes: bytes.length,
            digest: sha256(bytes),
            completeness: "complete",
          });
        }
        return {
          ok: true as const,
          artifacts: rows,
        } as unknown as ReturnType<
          import("@stonehush/db").RunOutputRepository["artifactsForRun"]
        >;
      },
    },
    grants: {
      publishedArtifactForEngagement: (input: { engagementId: string; artifactId: string }) => {
        if (input.engagementId !== ENGAGEMENT_ID || input.artifactId !== ARTIFACT_ID) {
          return undefined;
        }
        return {
          artifactId: ARTIFACT_ID,
          runId: RUN_ID,
          kind: "stdout",
          sizeBytes: STDOUT_BYTES.length,
          digest: sha256(STDOUT_BYTES),
          completeness: "complete",
        } as unknown as ReturnType<
          import("@stonehush/db").EvidenceGrantRepository["publishedArtifactForEngagement"]
        >;
      },
    },
    store: {
      verifiedByteRange: async (input: {
        artifactId: string;
        expectedSizeBytes: number;
        expectedDigest: string;
        byteOffset: number;
        byteLength: number;
      }) => {
        const bytes = artifacts.get(input.artifactId);
        if (bytes === undefined) return { status: "missing" as const };
        if (bytes.length !== input.expectedSizeBytes || sha256(bytes) !== input.expectedDigest) {
          return { status: "corrupt" as const, code: "digest_mismatch" as const };
        }
        if (input.byteOffset + input.byteLength > bytes.length) {
          return { status: "corrupt" as const, code: "invalid_download_request" as const };
        }
        return {
          status: "ready" as const,
          totalBytes: bytes.length,
          truncated: input.byteOffset + input.byteLength < bytes.length,
          content: bytes.subarray(input.byteOffset, input.byteOffset + input.byteLength),
        };
      },
      verifiedDownload: (async (input: { artifactId: string }) => {
        const bytes = artifacts.get(input.artifactId);
        if (bytes === undefined) return { status: "missing" as const };
        const total = bytes.length;
        async function* stream(): AsyncGenerator<Buffer> {
          yield Buffer.from(bytes as Buffer);
        }
        return {
          status: "ready" as const,
          sizeBytes: total,
          digest: sha256(bytes as Buffer),
          stream: stream(),
        };
      }) as EvidenceStore["verifiedDownload"],
    },
  });
  const harness: Harness = {
    directory,
    database,
    excerpts,
    artifacts,
    extraArtifacts,
    archived,
    inject: async (options) => {
      const response = await app.inject(
        options.payload === undefined
          ? { method: options.method, url: options.url }
          : { method: options.method, url: options.url, payload: options.payload },
      );
      return { statusCode: response.statusCode, json: () => response.json() as unknown };
    },
  };
  harnesses.push(harness);
  return harness;
}

afterEach(() => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop();
    if (harness === undefined) continue;
    if (harness.database.sqlite.open) harness.database.close();
    rmSync(harness.directory, { recursive: true, force: true });
  }
});

describe("excerpt routes", () => {
  it("keeps a masked excerpt with a stable source reference", async () => {
    const harness = await createHarness();
    const created = await harness.inject({
      method: "POST",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/excerpts`,
      payload: {
        runId: RUN_ID,
        artifactId: ARTIFACT_ID,
        stream: "stdout",
        byteOffset: 0,
        byteLength: 32,
        targetNote: "web on 10.0.0.5",
      },
    });
    expect(created.statusCode).toBe(201);
    const excerpt = created.json() as {
      runId: string;
      artifactId: string;
      artifactDigest: string;
      content: string;
      redactions: number;
      targetNote: string | null;
    };
    expect(excerpt.runId).toBe(RUN_ID);
    expect(excerpt.artifactId).toBe(ARTIFACT_ID);
    expect(excerpt.artifactDigest).toBe(sha256(STDOUT_BYTES));
    expect(excerpt.targetNote).toBe("web on 10.0.0.5");

    // The second half of the output carries secrets; the stored excerpt must
    // mask them instead of persisting raw values.
    const secret = await harness.inject({
      method: "POST",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/excerpts`,
      payload: {
        runId: RUN_ID,
        artifactId: ARTIFACT_ID,
        stream: "stdout",
        byteOffset: 31,
        byteLength: 44,
      },
    });
    expect(secret.statusCode).toBe(201);
    const masked = secret.json() as { content: string; redactions: number };
    expect(masked.content).not.toContain("flag{excerpt-secret-value}");
    expect(masked.content).not.toContain("hunter2");
    expect(masked.redactions).toBeGreaterThan(0);

    const listed = await harness.inject({
      method: "GET",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/excerpts`,
    });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as unknown[]).length).toBe(2);
  });

  it("rejects invented artifacts, mismatched runs, and out-of-range offsets", async () => {
    const harness = await createHarness();
    const unknownArtifact = await harness.inject({
      method: "POST",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/excerpts`,
      payload: {
        runId: RUN_ID,
        artifactId: "artifact-invented",
        stream: "stdout",
        byteOffset: 0,
        byteLength: 16,
      },
    });
    expect(unknownArtifact.statusCode).toBe(404);
    expect(unknownArtifact.json()).toEqual({ code: "artifact_not_found" });

    const unknownRun = await harness.inject({
      method: "POST",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/excerpts`,
      payload: {
        runId: "run-invented",
        artifactId: ARTIFACT_ID,
        stream: "stdout",
        byteOffset: 0,
        byteLength: 16,
      },
    });
    expect(unknownRun.statusCode).toBe(404);

    const pastEnd = await harness.inject({
      method: "POST",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/excerpts`,
      payload: {
        runId: RUN_ID,
        artifactId: ARTIFACT_ID,
        stream: "stdout",
        byteOffset: STDOUT_BYTES.length - 4,
        byteLength: 16,
      },
    });
    expect(pastEnd.statusCode).toBe(400);
    expect(pastEnd.json()).toEqual({ code: "range_rejected" });

    const inventedField = await harness.inject({
      method: "POST",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/excerpts`,
      payload: {
        runId: RUN_ID,
        artifactId: ARTIFACT_ID,
        stream: "stdout",
        byteOffset: 0,
        byteLength: 16,
        content: "invented bytes",
      },
    });
    expect(inventedField.statusCode).toBe(400);
  });

  it("keeps the evidence reference when bytes are unavailable, with retry metadata", async () => {
    const harness = await createHarness();
    harness.artifacts.delete(ARTIFACT_ID);
    const failed = await harness.inject({
      method: "POST",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/excerpts`,
      payload: {
        runId: RUN_ID,
        artifactId: ARTIFACT_ID,
        stream: "stdout",
        byteOffset: 0,
        byteLength: 16,
      },
    });
    expect(failed.statusCode).toBe(409);
    expect(failed.json()).toEqual({ code: "missing_artifact" });

    const sources = await harness.inject({
      method: "GET",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/runs/${RUN_ID}/excerpt-sources`,
    });
    expect(sources.statusCode).toBe(200);
    const refs = sources.json() as {
      artifactId: string;
      sizeBytes: number;
      digest: string;
      completeness: string;
    }[];
    expect(refs).toHaveLength(1);
    expect(refs[0]?.artifactId).toBe(ARTIFACT_ID);
    expect(refs[0]?.digest).toBe(sha256(STDOUT_BYTES));
  });

  it("searches without rendering the file and masks snippets", async () => {
    const harness = await createHarness();
    const found = await harness.inject({
      method: "GET",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/runs/${RUN_ID}/output/search?q=login`,
    });
    expect(found.statusCode).toBe(200);
    const body = found.json() as {
      matches: { byteOffset: number; snippet: string }[];
      scanCapped: boolean;
      unavailableArtifactIds: string[];
    };
    expect(body.matches.length).toBeGreaterThan(0);
    expect(body.matches[0]?.snippet).toContain("login");
    expect(body.scanCapped).toBe(false);
    // Snippet content survives masking: every match carries a real string.
    for (const match of body.matches) {
      expect(typeof match.snippet).toBe("string");
      expect(match.snippet.length).toBeGreaterThan(0);
    }

    const secretSearch = await harness.inject({
      method: "GET",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/runs/${RUN_ID}/output/search?q=flag`,
    });
    const secretBody = secretSearch.json() as { matches: { snippet: string }[] };
    expect(secretBody.matches.length).toBeGreaterThan(0);
    for (const match of secretBody.matches) {
      expect(match.snippet).not.toContain("flag{excerpt-secret-value}");
      expect(match.snippet).toContain("[redacted]");
    }

    const empty = await harness.inject({
      method: "GET",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/runs/${RUN_ID}/output/search?q=`,
    });
    expect(empty.statusCode).toBe(400);
  });

  it("reports scanCapped when more than 8 artifacts are eligible", async () => {
    const harness = await createHarness();
    for (let index = 0; index < 9; index += 1) {
      const artifactId = `artifact-extra-${index}`;
      harness.artifacts.set(artifactId, Buffer.from(`extra output ${index}\n`, "utf8"));
      harness.extraArtifacts.push({ artifactId, kind: "stdout" });
    }
    const found = await harness.inject({
      method: "GET",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/runs/${RUN_ID}/output/search?q=extra`,
    });
    expect(found.statusCode).toBe(200);
    const body = found.json() as {
      matches: { artifactId: string }[];
      scanCapped: boolean;
      unavailableArtifactIds: string[];
    };
    // Ten eligible artifacts, eight scanned: coverage must not be claimed.
    expect(body.scanCapped).toBe(true);
    expect(body.unavailableArtifactIds).toEqual([]);
    for (const match of body.matches) {
      expect(match.artifactId.startsWith("artifact-extra-")).toBe(true);
    }
  });

  it("rejects excerpt writes on archived engagements", async () => {
    const harness = await createHarness();
    harness.archived.current = true;
    const created = await harness.inject({
      method: "POST",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/excerpts`,
      payload: {
        runId: RUN_ID,
        artifactId: ARTIFACT_ID,
        stream: "stdout",
        byteOffset: 0,
        byteLength: 16,
      },
    });
    expect(created.statusCode).toBe(409);
    expect(created.json()).toEqual({ code: "engagement_archived" });
  });

  it("never returns shifted offsets for malformed UTF-8 output", async () => {
    const harness = await createHarness();
    // 0xFF decodes to U+FFFD (three bytes on re-encode) while occupying one
    // source byte. Re-encoding the displayed text would report `login` at
    // offset 3 instead of 1; the route must not publish that shifted range.
    harness.artifacts.set(
      ARTIFACT_ID,
      Buffer.concat([Buffer.from([0xff]), Buffer.from("login", "utf8")]),
    );
    const found = await harness.inject({
      method: "GET",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/runs/${RUN_ID}/output/search?q=login`,
    });
    expect(found.statusCode).toBe(200);
    const body = found.json() as {
      matches: { byteOffset: number; byteLength: number }[];
      searchedBytes: number;
      scanCapped: boolean;
    };
    expect(body.matches).toEqual([]);
    expect(body.searchedBytes).toBeGreaterThan(0);
    expect(body.scanCapped).toBe(true);
  });
});

describe("attachment routes", () => {
  const PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  it("names uploads by what they prove and serves captioned bytes", async () => {
    const harness = await createHarness();
    const uploaded = await harness.inject({
      method: "POST",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/attachments`,
      payload: {
        filename: "Admin login as sa!",
        mime: "image/png",
        contentBase64: PNG_BASE64,
        caption: "login form",
        targetLabel: "web on 10.0.0.5",
      },
    });
    expect(uploaded.statusCode).toBe(201);
    const attachment = uploaded.json() as {
      id: string;
      filename: string;
      caption: string;
      targetLabel: string | null;
      parentAttachmentId: string | null;
    };
    expect(attachment.filename).toBe("admin-login-as-sa");
    expect(attachment.caption).toBe("login form");
    expect(attachment.targetLabel).toBe("web on 10.0.0.5");
    expect(attachment.parentAttachmentId).toBeNull();

    const listed = await harness.inject({
      method: "GET",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/attachments`,
    });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as unknown[]).length).toBe(1);

    const patched = await harness.inject({
      method: "PATCH",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/attachments/${attachment.id}`,
      payload: { caption: "login form with default creds" },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { caption: string }).caption).toBe(
      "login form with default creds",
    );
  });

  it("keeps the original when deriving a cropped copy", async () => {
    const harness = await createHarness();
    const uploaded = await harness.inject({
      method: "POST",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/attachments`,
      payload: {
        filename: "login screen",
        mime: "image/png",
        contentBase64: PNG_BASE64,
        caption: "full login screen",
      },
    });
    const original = uploaded.json() as { id: string; caption: string };
    const derived = await harness.inject({
      method: "POST",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/attachments/${original.id}/derived`,
      payload: {
        caption: "crop of the username field",
        crop: { x: 0, y: 0, width: 1, height: 1 },
      },
    });
    expect(derived.statusCode).toBe(201);
    const child = derived.json() as {
      parentAttachmentId: string | null;
      caption: string;
      crop: { width: number } | null;
    };
    expect(child.parentAttachmentId).toBe(original.id);
    expect(child.crop?.width).toBe(1);

    const reread = await harness.inject({
      method: "GET",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/attachments`,
    });
    const rows = reread.json() as { id: string; caption: string; parentAttachmentId: string | null }[];
    expect(rows.find((row) => row.id === original.id)?.caption).toBe("full login screen");
    expect(rows.find((row) => row.id === original.id)?.parentAttachmentId).toBeNull();
  });

  it("rejects foreign parents and non-image uploads", async () => {
    const harness = await createHarness();
    const foreign = await harness.inject({
      method: "POST",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/attachments/10000000-0000-4000-8000-000000000099/derived`,
      payload: { caption: "nope" },
    });
    expect(foreign.statusCode).toBe(404);

    const badMime = await harness.inject({
      method: "POST",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/attachments`,
      payload: {
        filename: "proof",
        mime: "image/svg+xml",
        contentBase64: PNG_BASE64,
      },
    });
    expect(badMime.statusCode).toBe(400);
  });
});
