import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openEngagementDatabase } from "./database.js";
import { ExcerptRepository } from "./excerpts.js";
import { EngagementRepository } from "./repository.js";

const UNKNOWN_ID = "10000000-0000-4000-8000-000000000099";
const DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

interface Fixture {
  directory: string;
  database: ReturnType<typeof openEngagementDatabase>;
  engagements: EngagementRepository;
  excerpts: ExcerptRepository;
}

const fixtures: Fixture[] = [];

function createFixture(): Fixture {
  const directory = mkdtempSync(path.join(tmpdir(), "stonehush-excerpts-test-"));
  chmodSync(directory, 0o700);
  const database = openEngagementDatabase({ dataDirectory: directory });
  let ids = 0;
  let minute = 0;
  const engagements = new EngagementRepository(database.db, {
    createId: () => `10000000-0000-4000-8000-${String(100 + ids++).padStart(12, "0")}`,
    now: () => new Date(Date.UTC(2026, 7, 12, 12, minute++)),
  });
  const excerpts = new ExcerptRepository(database.db, {
    createId: () => `20000000-0000-4000-8000-${String(200 + ids++).padStart(12, "0")}`,
    now: () => new Date(Date.UTC(2026, 7, 12, 12, minute++)),
  });
  const fixture = { directory, database, engagements, excerpts };
  fixtures.push(fixture);
  return fixture;
}

function createEngagement(repository: EngagementRepository): string {
  const result = repository.createEngagement({
    name: "Excerpt lab",
    kind: "lab",
    description: null,
    authorizationContext: null,
    autoContinueWarnings: false,
  });
  if (!result.ok) throw new Error(`Fixture create failed: ${result.error.code}`);
  return result.value.id;
}

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (fixture === undefined) continue;
    if (fixture.database.sqlite.open) fixture.database.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

describe("excerpt persistence", () => {
  it("creates and lists masked excerpts scoped to the engagement", () => {
    const { engagements, excerpts } = createFixture();
    const engagementId = createEngagement(engagements);

    expect(excerpts.listExcerpts(engagementId)).toEqual({ ok: true, value: [] });
    const created = excerpts.createExcerpt({
      engagementId,
      runId: "run-1",
      artifactId: "artifact-stdout",
      artifactDigest: DIGEST,
      stream: "stdout",
      byteOffset: 0,
      byteLength: 128,
      content: "masked login line",
      redactions: 1,
      targetNote: "web on 10.0.0.5",
    });
    if (!created.ok) throw new Error(`Excerpt create failed: ${created.error.code}`);
    expect(created.value.contractVersion).toBe(1);
    expect(created.value.targetNote).toBe("web on 10.0.0.5");

    const listed = excerpts.listExcerpts(engagementId);
    if (!listed.ok) throw new Error(`Excerpt list failed: ${listed.error.code}`);
    expect(listed.value).toHaveLength(1);

    const fetched = excerpts.getExcerpt(engagementId, created.value.id);
    expect(fetched).toEqual(created);
  });

  it("rejects excerpts for unknown engagements and unknown excerpt ids", () => {
    const { engagements, excerpts } = createFixture();
    const engagementId = createEngagement(engagements);
    expect(
      excerpts.createExcerpt({
        engagementId: UNKNOWN_ID,
        runId: "run-1",
        artifactId: "artifact-stdout",
        artifactDigest: DIGEST,
        stream: "stdout",
        byteOffset: 0,
        byteLength: 16,
        content: "line",
        redactions: 0,
        targetNote: null,
      }),
    ).toEqual({ ok: false, error: { code: "engagement_not_found" } });
    expect(excerpts.listExcerpts(UNKNOWN_ID)).toEqual({
      ok: false,
      error: { code: "engagement_not_found" },
    });
    expect(excerpts.getExcerpt(engagementId, UNKNOWN_ID)).toEqual({
      ok: false,
      error: { code: "excerpt_not_found" },
    });
  });

  it("rejects oversized excerpt content at the storage boundary", () => {
    const { engagements, excerpts } = createFixture();
    const engagementId = createEngagement(engagements);
    const created = excerpts.createExcerpt({
      engagementId,
      runId: "run-1",
      artifactId: "artifact-stdout",
      artifactDigest: DIGEST,
      stream: "stdout",
      byteOffset: 0,
      byteLength: 16,
      content: "x".repeat(16_385),
      redactions: 0,
      targetNote: null,
    });
    expect(created.ok).toBe(false);
  });

  it("rejects contract-invalid excerpts before persisting them", () => {
    const { engagements, excerpts } = createFixture();
    const engagementId = createEngagement(engagements);
    const created = excerpts.createExcerpt({
      engagementId,
      runId: "",
      artifactId: "artifact-stdout",
      artifactDigest: DIGEST,
      stream: "stdout",
      byteOffset: 0,
      byteLength: 16,
      content: "line",
      redactions: 0,
      targetNote: null,
    });
    expect(created).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
    const listed = excerpts.listExcerpts(engagementId);
    if (!listed.ok) throw new Error(`Excerpt list failed: ${listed.error.code}`);
    expect(listed.value).toHaveLength(0);
  });
});

describe("attachment persistence", () => {
  function uploadInput(engagementId: string) {
    return {
      engagementId,
      filename: "admin-login-as-sa",
      mime: "image/png" as const,
      sizeBytes: 8,
      digest: DIGEST,
      caption: "login form",
      targetLabel: "web on 10.0.0.5",
      parentAttachmentId: null,
      cropRectJson: null,
      contentBase64: "aGVsbG8td29ybGQ=",
    };
  }

  it("creates, lists, and serves bytes for engagement-scoped attachments", () => {
    const { engagements, excerpts } = createFixture();
    const engagementId = createEngagement(engagements);

    const created = excerpts.createAttachment(uploadInput(engagementId));
    if (!created.ok) throw new Error(`Attachment create failed: ${created.error.code}`);
    expect(created.value.caption).toBe("login form");

    const updated = excerpts.updateAttachmentCaption(
      engagementId,
      created.value.id,
      "cropped login form",
    );
    if (!updated.ok) throw new Error(`Caption update failed: ${updated.error.code}`);
    expect(updated.value.caption).toBe("cropped login form");

    const listed = excerpts.listAttachments(engagementId);
    if (!listed.ok) throw new Error(`Attachment list failed: ${listed.error.code}`);
    expect(listed.value).toHaveLength(1);

    const bytes = excerpts.attachmentBytes(engagementId, created.value.id);
    if (!bytes.ok) throw new Error(`Attachment bytes failed: ${bytes.error.code}`);
    expect(bytes.value.mime).toBe("image/png");
    expect(bytes.value.contentBase64).toBe("aGVsbG8td29ybGQ=");
  });

  it("keeps the original when deriving a cropped copy", () => {
    const { engagements, excerpts } = createFixture();
    const engagementId = createEngagement(engagements);
    const original = excerpts.createAttachment(uploadInput(engagementId));
    if (!original.ok) throw new Error(`Attachment create failed: ${original.error.code}`);

    const derived = excerpts.createAttachment({
      ...uploadInput(engagementId),
      filename: "admin-login-as-sa-crop",
      caption: "crop of the username field",
      parentAttachmentId: original.value.id,
      cropRectJson: JSON.stringify({ x: 4, y: 4, width: 100, height: 60 }),
    });
    if (!derived.ok) throw new Error(`Derived create failed: ${derived.error.code}`);
    expect(derived.value.parentAttachmentId).toBe(original.value.id);
    const derivedBytes = excerpts.attachmentBytes(engagementId, derived.value.id);
    if (!derivedBytes.ok) throw new Error(`Derived bytes failed: ${derivedBytes.error.code}`);
    expect(derivedBytes.value.contentBase64).toBe("aGVsbG8td29ybGQ=");

    const reread = excerpts.getAttachment(engagementId, original.value.id);
    if (!reread.ok) throw new Error(`Original reread failed: ${reread.error.code}`);
    expect(reread.value.parentAttachmentId).toBeNull();
    expect(reread.value.caption).toBe("login form");
  });

  it("rejects foreign parents and cross-engagement reads", () => {
    const { engagements, excerpts } = createFixture();
    const first = createEngagement(engagements);
    const second = createEngagement(engagements);
    const original = excerpts.createAttachment(uploadInput(first));
    if (!original.ok) throw new Error(`Attachment create failed: ${original.error.code}`);

    expect(
      excerpts.createAttachment({
        ...uploadInput(second),
        parentAttachmentId: original.value.id,
      }),
    ).toEqual({ ok: false, error: { code: "attachment_not_found" } });
    expect(excerpts.getAttachment(second, original.value.id)).toEqual({
      ok: false,
      error: { code: "attachment_not_found" },
    });
    expect(excerpts.attachmentBytes(second, original.value.id)).toEqual({
      ok: false,
      error: { code: "attachment_not_found" },
    });
  });

  it("rejects malformed crop metadata before persisting it", () => {
    const { engagements, excerpts } = createFixture();
    const engagementId = createEngagement(engagements);
    const created = excerpts.createAttachment({
      ...uploadInput(engagementId),
      parentAttachmentId: null,
      cropRectJson: JSON.stringify({}),
    });
    expect(created).toEqual({ ok: false, error: { code: "invalid_repository_input" } });
    const listed = excerpts.listAttachments(engagementId);
    if (!listed.ok) throw new Error(`Attachment list failed: ${listed.error.code}`);
    expect(listed.value).toHaveLength(0);
  });
});
