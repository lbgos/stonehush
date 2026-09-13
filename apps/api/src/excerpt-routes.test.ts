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
  engagements: EngagementRepository;
  inject: (options: {
    method: "GET" | "POST" | "PATCH";
    url: string;
    payload?: Record<string, unknown>;
  }) => Promise<{ statusCode: number; json(): unknown }>;
  artifacts: Map<string, Buffer>;
  extraArtifacts: { artifactId: string; kind: string }[];
  archived: { current: boolean };
  hooks: { onVerifiedByteRange: (() => void) | undefined };
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
  const hooks: { onVerifiedByteRange: (() => void) | undefined } = {
    onVerifiedByteRange: undefined,
  };
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
        if (input.engagementId !== ENGAGEMENT_ID) {
          return undefined;
        }
        if (input.artifactId === ARTIFACT_ID) {
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
        }
        const extra = extraArtifacts.find((row) => row.artifactId === input.artifactId);
        const bytes = extra === undefined ? undefined : artifacts.get(extra.artifactId);
        if (extra === undefined || bytes === undefined) {
          return undefined;
        }
        return {
          artifactId: extra.artifactId,
          runId: RUN_ID,
          kind: extra.kind,
          sizeBytes: bytes.length,
          digest: sha256(bytes),
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
        hooks.onVerifiedByteRange?.();
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
    engagements: engagementRepository,
    artifacts,
    extraArtifacts,
    archived,
    hooks,
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

  it("masks inner secret bytes using expanded context instead of persisting them raw", async () => {
    const harness = await createHarness();
    const artifactId = "artifact-secret-inner";
    const content = "login ok\nflag{syntheticsecret42}\npassword=hunter2\n";
    harness.artifacts.set(artifactId, Buffer.from(content, "utf8"));
    harness.extraArtifacts.push({ artifactId, kind: "stdout" });
    const keep = (byteOffset: number, byteLength: number) =>
      harness.inject({
        method: "POST",
        url: `/api/v1/engagements/${ENGAGEMENT_ID}/excerpts`,
        payload: { runId: RUN_ID, artifactId, stream: "stdout", byteOffset, byteLength },
      });

    // Inner flag value without its wrapper. Narrow masking alone would keep
    // it verbatim; the expanded context must mask it.
    const innerStart = content.indexOf("syntheticsecret42");
    const inner = await keep(innerStart, "syntheticsecret42".length);
    expect(inner.statusCode).toBe(201);
    const innerBody = inner.json() as {
      content: string;
      redactions: number;
      byteOffset: number;
      byteLength: number;
    };
    expect(innerBody.content).not.toContain("syntheticsecret42");
    expect(innerBody.content).toBe("[redacted]");
    expect(innerBody.redactions).toBe(1);
    // Provenance still records exactly the requested bytes.
    expect(innerBody.byteOffset).toBe(innerStart);
    expect(innerBody.byteLength).toBe("syntheticsecret42".length);

    // Inner credential value without its `password=` prefix.
    const valueStart = content.indexOf("hunter2");
    const value = await keep(valueStart, "hunter2".length);
    expect(value.statusCode).toBe(201);
    const valueBody = value.json() as { content: string; redactions: number };
    expect(valueBody.content).not.toContain("hunter2");
    expect(valueBody.redactions).toBeGreaterThan(0);

    // Cutoff boundary starting inside the wrapper.
    const cutStart = content.indexOf("lag{syntheticsecret42}");
    const cut = await keep(cutStart, "lag{syntheticsecret42}".length);
    expect(cut.statusCode).toBe(201);
    expect((cut.json() as { content: string }).content).not.toContain("syntheticsecret42");

    // Ordinary text beside secrets stays verbatim.
    const ordinary = await keep(0, "login ok\n".length);
    expect(ordinary.statusCode).toBe(201);
    expect((ordinary.json() as { content: string }).content).toBe("login ok\n");
  });

  it("masks inner key block material spanning multiple lines", async () => {
    const harness = await createHarness();
    const artifactId = "artifact-key-inner";
    const keyBody = "MIIBOgIBAAJBAKcGx7VnZQIDAQAB";
    const content = `note\n-----BEGIN RSA PRIVATE KEY-----\n${keyBody}\n-----END RSA PRIVATE KEY-----\nafter\n`;
    harness.artifacts.set(artifactId, Buffer.from(content, "utf8"));
    harness.extraArtifacts.push({ artifactId, kind: "stdout" });
    const kept = await harness.inject({
      method: "POST",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/excerpts`,
      payload: {
        runId: RUN_ID,
        artifactId,
        stream: "stdout",
        byteOffset: content.indexOf(keyBody),
        byteLength: keyBody.length,
      },
    });
    expect(kept.statusCode).toBe(201);
    const body = kept.json() as { content: string; redactions: number };
    expect(body.content).not.toContain(keyBody);
    expect(body.redactions).toBeGreaterThan(0);
  });

  it("rejects mid-token selections whose lookback is cut instead of guessing", async () => {
    const harness = await createHarness();
    const artifactId = "artifact-long-token";
    const content = `${"x".repeat(9_000)}\nlogin ok\n`;
    harness.artifacts.set(artifactId, Buffer.from(content, "utf8"));
    harness.extraArtifacts.push({ artifactId, kind: "stdout" });
    // 8500 sits inside a token run with the 8192-byte lookback cut short of
    // the artifact start: no safe boundary is visible.
    const rejected = await harness.inject({
      method: "POST",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/excerpts`,
      payload: { runId: RUN_ID, artifactId, stream: "stdout", byteOffset: 8500, byteLength: 10 },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toEqual({ code: "range_rejected" });

    // The same artifact stays excerptable from a real boundary.
    const boundaryStart = content.indexOf("login ok");
    const allowed = await harness.inject({
      method: "POST",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/excerpts`,
      payload: {
        runId: RUN_ID,
        artifactId,
        stream: "stdout",
        byteOffset: boundaryStart,
        byteLength: "login ok".length,
      },
    });
    expect(allowed.statusCode).toBe(201);
    expect((allowed.json() as { content: string }).content).toBe("login ok");
  });

  it("rejects value-side selections whose assignment key may sit beyond a cut lookback", async () => {
    const harness = await createHarness();
    const artifactId = "artifact-wide-gap";
    // The credential pattern spans arbitrary whitespace, so full-file
    // policy would mask this value; the excerpt window cannot see the key
    // past the 8192-byte lookback.
    const content = `password${" ".repeat(9000)}=hunter2\nlogin page ok\n`;
    harness.artifacts.set(artifactId, Buffer.from(content, "utf8"));
    harness.extraArtifacts.push({ artifactId, kind: "stdout" });
    const keep = (byteOffset: number, byteLength: number) =>
      harness.inject({
        method: "POST",
        url: `/api/v1/engagements/${ENGAGEMENT_ID}/excerpts`,
        payload: { runId: RUN_ID, artifactId, stream: "stdout", byteOffset, byteLength },
      });

    const valueSide = content.indexOf("=hunter2");
    // Narrow masking alone would persist `=hunter2` verbatim with the key
    // beyond the lookback: reject instead.
    const led = await keep(valueSide, "=hunter2".length);
    expect(led.statusCode).toBe(400);
    expect(led.json()).toEqual({ code: "range_rejected" });

    // One char over, starting right after the visible `=`, leaks the same
    // way without the fix.
    const bare = await keep(valueSide + 1, "hunter2".length);
    expect(bare.statusCode).toBe(400);
    expect(bare.json()).toEqual({ code: "range_rejected" });

    // Ordinary text past the same cut still keeps verbatim.
    const loginStart = content.indexOf("login page ok");
    const login = await keep(loginStart, "login page ok".length);
    expect(login.statusCode).toBe(201);
    expect((login.json() as { content: string }).content).toBe("login page ok");
  });

  it("rejects JSON colon value sides whose key may sit beyond a cut lookback", async () => {
    const harness = await createHarness();
    const artifactId = "artifact-json-gap";
    // Wide whitespace including newlines between key and value. Note the
    // quoted `"api_key"` shape is fail-closed defense beyond policy: the
    // credential pattern only recognizes bare keys, so full-file redaction
    // misses quoted keys with or without a gap. The unquoted twin below
    // (`password :` plus gap) is the policy-relative case.
    const gap = `${" ".repeat(4500)}\n${" ".repeat(100)}\n${" ".repeat(4395)}`;
    const content = `{"api_key"${gap}: "hunter2-value"}\ncount = 42\n"a", "b"\n`;
    harness.artifacts.set(artifactId, Buffer.from(content, "utf8"));
    harness.extraArtifacts.push({ artifactId, kind: "stdout" });
    const keep = (byteOffset: number, byteLength: number) =>
      harness.inject({
        method: "POST",
        url: `/api/v1/engagements/${ENGAGEMENT_ID}/excerpts`,
        payload: { runId: RUN_ID, artifactId, stream: "stdout", byteOffset, byteLength },
      });

    // Separator-led selection covering the colon and quoted value.
    const colonSide = content.indexOf(': "hunter2-value"');
    expect(colonSide).toBeGreaterThan(8192);
    const led = await keep(colonSide, ': "hunter2-value"'.length);
    expect(led.statusCode).toBe(400);
    expect(led.json()).toEqual({ code: "range_rejected" });

    // Quoted value right after the visible colon and space.
    const quotedStart = content.indexOf('"hunter2-value"');
    const quoted = await keep(quotedStart, '"hunter2-value"'.length);
    expect(quoted.statusCode).toBe(400);
    expect(quoted.json()).toEqual({ code: "range_rejected" });

    // Ordinary evidence past the same cut stays keepable: a bare value
    // after a spaced separator and a quoted string after a comma carry no
    // assignment shape of their own.
    const countStart = content.indexOf("42");
    const count = await keep(countStart, "42".length);
    expect(count.statusCode).toBe(201);
    expect((count.json() as { content: string }).content).toBe("42");
    const bStart = content.indexOf('"b"');
    const bKeep = await keep(bStart, '"b"'.length);
    expect(bKeep.statusCode).toBe(201);
    expect((bKeep.json() as { content: string }).content).toBe('"b"');
  });

  it("masks key-block bodies when the END marker falls beyond the window", async () => {
    const harness = await createHarness();
    const artifactId = "artifact-key-cut";
    // The END marker sits past the 8192-byte window, so no block span can
    // cover a body-line selection. Narrow masking alone would persist the
    // body verbatim.
    const content =
      `-----BEGIN RSA PRIVATE KEY-----\n${"B".repeat(9000)}\n-----END RSA PRIVATE KEY-----\n`;
    harness.artifacts.set(artifactId, Buffer.from(content, "utf8"));
    harness.extraArtifacts.push({ artifactId, kind: "stdout" });
    const body = await harness.inject({
      method: "POST",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/excerpts`,
      payload: { runId: RUN_ID, artifactId, stream: "stdout", byteOffset: 100, byteLength: 100 },
    });
    expect(body.statusCode).toBe(201);
    const bodyJson = body.json() as { content: string; redactions: number };
    expect(bodyJson.content).not.toContain("B".repeat(10));
    expect(bodyJson.redactions).toBeGreaterThan(0);
  });

  it("rejects key-block tails holding an END marker without its BEGIN", async () => {
    const harness = await createHarness();
    const artifactId = "artifact-key-tail";
    // The block head sits beyond the cut lookback: no span covers the body.
    const content = `${"M".repeat(9000)}\n-----END RSA PRIVATE KEY-----\ntail\n`;
    harness.artifacts.set(artifactId, Buffer.from(content, "utf8"));
    harness.extraArtifacts.push({ artifactId, kind: "stdout" });
    const tailStart = content.indexOf("-----END");
    const tail = await harness.inject({
      method: "POST",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/excerpts`,
      payload: {
        runId: RUN_ID,
        artifactId,
        stream: "stdout",
        byteOffset: tailStart,
        byteLength: "-----END RSA PRIVATE KEY-----\n".length,
      },
    });
    expect(tail.statusCode).toBe(400);
    expect(tail.json()).toEqual({ code: "range_rejected" });

    // A complete block in one selection still masks instead of rejecting.
    const wholeId = "artifact-key-whole";
    const whole =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n";
    harness.artifacts.set(wholeId, Buffer.from(whole, "utf8"));
    harness.extraArtifacts.push({ artifactId: wholeId, kind: "stdout" });
    const kept = await harness.inject({
      method: "POST",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/excerpts`,
      payload: { runId: RUN_ID, artifactId: wholeId, stream: "stdout", byteOffset: 0, byteLength: whole.length },
    });
    expect(kept.statusCode).toBe(201);
    expect((kept.json() as { content: string }).content).not.toContain("MIIB");
  });

  it("rejects userinfo value sides split from their scheme by a cut", async () => {
    const harness = await createHarness();
    const artifactId = "artifact-userinfo-gap";
    const content = `${"A".repeat(9000)}https://user:SUPERSECRET9@host.example/path`;
    harness.artifacts.set(artifactId, Buffer.from(content, "utf8"));
    harness.extraArtifacts.push({ artifactId, kind: "stdout" });
    const keep = (byteOffset: number, byteLength: number) =>
      harness.inject({
        method: "POST",
        url: `/api/v1/engagements/${ENGAGEMENT_ID}/excerpts`,
        payload: { runId: RUN_ID, artifactId, stream: "stdout", byteOffset, byteLength },
      });
    // Immediately after the visible `:` the value side cannot be told from
    // a port keep, so fail closed on the cut.
    const valueSide = content.indexOf("SUPERSECRET9");
    const led = await keep(valueSide, "SUPERSECRET9@host.example/path".length);
    expect(led.statusCode).toBe(400);
    expect(led.json()).toEqual({ code: "range_rejected" });

    // Percent-encoded split: the password continues past a `%` the
    // lookback ends with.
    const encodedId = "artifact-userinfo-encoded";
    const encoded = `https://user:${"A".repeat(9000)}%20SECRETVALUE@host/x`;
    harness.artifacts.set(encodedId, Buffer.from(encoded, "utf8"));
    harness.extraArtifacts.push({ artifactId: encodedId, kind: "stdout" });
    const splitAt = encoded.indexOf("%20SECRETVALUE");
    const split = await harness.inject({
      method: "POST",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/excerpts`,
      payload: {
        runId: RUN_ID,
        artifactId: encodedId,
        stream: "stdout",
        byteOffset: splitAt + 1,
        byteLength: "20SECRETVALUE".length,
      },
    });
    expect(split.statusCode).toBe(400);
    expect(split.json()).toEqual({ code: "range_rejected" });
  });

  it("rejects bare values with a whitespace-only window behind them", async () => {
    const harness = await createHarness();
    const keepOn = async (artifactId: string, content: string) => {
      harness.artifacts.set(artifactId, Buffer.from(content, "utf8"));
      harness.extraArtifacts.push({ artifactId, kind: "stdout" });
      return (byteOffset: number, byteLength: number) =>
        harness.inject({
          method: "POST",
          url: `/api/v1/engagements/${ENGAGEMENT_ID}/excerpts`,
          payload: { runId: RUN_ID, artifactId, stream: "stdout", byteOffset, byteLength },
        });
    };
    // Case 1: `password` plus 9000 spaces plus `= hunter2`, keep [9010, 7).
    const content1 = `password${" ".repeat(9000)}= hunter2\ncount = 42\n`;
    const keep1 = await keepOn("artifact-gap-1", content1);
    const refused1 = await keep1(9010, 7);
    expect(refused1.statusCode).toBe(400);
    expect(refused1.json()).toEqual({ code: "range_rejected" });
    // Case 2: same shape with a colon separator.
    const keep2 = await keepOn("artifact-gap-2", `password${" ".repeat(9000)}: hunter2\n`);
    const refused2 = await keep2(9010, 7);
    expect(refused2.statusCode).toBe(400);
    expect(refused2.json()).toEqual({ code: "range_rejected" });
    // Case 3: key and separator both beyond the window.
    const keep3 = await keepOn("artifact-gap-3", `password =${" ".repeat(9000)}hunter2\n`);
    const refused3 = await keep3(9010, 7);
    expect(refused3.statusCode).toBe(400);
    expect(refused3.json()).toEqual({ code: "range_rejected" });
    // Case 4: quoted value with a hidden colon.
    const keep4 = await keepOn("artifact-gap-4", `password :${" ".repeat(9000)}"hunter2-value"\n`);
    const refused4 = await keep4(9010, '"hunter2-value"'.length);
    expect(refused4.statusCode).toBe(400);
    expect(refused4.json()).toEqual({ code: "range_rejected" });

    // Ordinary twins in the same cut region stay keepable: the `count`
    // key is visible inside the window, so no hidden-key doubt exists.
    const twinStart = content1.indexOf("42", 9018);
    const twin = await keep1(twinStart, 2);
    expect(twin.statusCode).toBe(201);
    expect((twin.json() as { content: string }).content).toBe("42");
  });

  it("masks search snippets for inner secret matches", async () => {
    const harness = await createHarness();
    const artifactId = "artifact-secret-search";
    const content = "login ok\nflag{syntheticsecret42}\n";
    harness.artifacts.set(artifactId, Buffer.from(content, "utf8"));
    harness.extraArtifacts.push({ artifactId, kind: "stdout" });
    const found = await harness.inject({
      method: "GET",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/runs/${RUN_ID}/output/search?q=syntheticsecret42`,
    });
    expect(found.statusCode).toBe(200);
    const body = found.json() as { matches: { snippet: string; artifactId: string }[] };
    expect(body.matches.length).toBeGreaterThan(0);
    for (const match of body.matches) {
      expect(match.snippet).not.toContain("syntheticsecret42");
    }
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

  it("refuses the insert when archiving lands mid-read", async () => {
    const harness = await createHarness();
    // The request gate sees an active engagement; the archive lands in the
    // real table while the verified byte read is in flight. The atomic
    // insert check must still refuse instead of annotating the newly
    // archived engagement.
    harness.hooks.onVerifiedByteRange = () => {
      const current = harness.engagements.getEngagement(ENGAGEMENT_ID);
      if (!current.ok) throw new Error("fixture engagement missing");
      const archived = harness.engagements.archive(ENGAGEMENT_ID, current.value.engagement.revision);
      if (!archived.ok) throw new Error("fixture archive failed");
    };
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
    // No bytes were safely searchable, and the cap flag says coverage is
    // incomplete rather than claiming absence.
    expect(body.searchedBytes).toBe(0);
    expect(body.scanCapped).toBe(true);
  });

  it("keeps searching the complete prefix when the budget cuts a code point", async () => {
    const harness = await createHarness();
    // `login` up front stays findable even though the 262144-byte scan
    // budget ends mid-way through a trailing multibyte character.
    const head = Buffer.from("login\n", "utf8");
    const padLength = 262_144 - head.length - 1;
    const bytes = Buffer.concat([
      head,
      Buffer.alloc(padLength, 0x41),
      Buffer.from([0xc3, 0xa9]),
      Buffer.from("tail", "utf8"),
    ]);
    harness.artifacts.set(ARTIFACT_ID, bytes);
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
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0]).toMatchObject({ byteOffset: 0, byteLength: 5 });
    expect(body.searchedBytes).toBe(262_143);
    expect(body.scanCapped).toBe(true);
  });

  it("masks the whole snippet when the scan cap cuts inside a token at the edge", async () => {
    const harness = await createHarness();
    // `flag{supersecret` ends exactly at the 262144-byte budget with more
    // bytes beyond it, and the closing brace stays unread. The context
    // window reaches the scanned end, so the character past the edge is
    // unknown; a token run there must mask instead of leaking `supersecret`.
    // Geometry: the 17-char tail ends at the cut, so `supersecret` starts at
    // 262133; minus the 160-char radius and 8192-char context the context
    // window starts at 253781. The planted newline there keeps the left
    // edge clean, so only the right edge is under test.
    const tail = " flag{supersecret";
    const head = Buffer.from("login\n", "utf8");
    const contextStart = 253_781;
    const padFirst = contextStart - head.length;
    const padSecond = 262_144 - head.length - padFirst - 1 - tail.length;
    const bytes = Buffer.concat([
      head,
      Buffer.alloc(padFirst, 0x41),
      Buffer.from("\n", "utf8"),
      Buffer.alloc(padSecond, 0x41),
      Buffer.from(tail, "utf8"),
      Buffer.from("} plus trailing bytes past the budget", "utf8"),
    ]);
    expect(bytes.length).toBeGreaterThan(262_144);
    harness.artifacts.set(ARTIFACT_ID, bytes);
    const found = await harness.inject({
      method: "GET",
      url: `/api/v1/engagements/${ENGAGEMENT_ID}/runs/${RUN_ID}/output/search?q=supersecret`,
    });
    expect(found.statusCode).toBe(200);
    const body = found.json() as {
      matches: { snippet: string; redactions: number }[];
      scanCapped: boolean;
    };
    expect(body.scanCapped).toBe(true);
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0]?.snippet).toContain("[redacted]");
    expect(body.matches[0]?.snippet).not.toContain("supersecret");
    expect(body.matches[0]?.redactions).toBe(1);
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
