import { describe, expect, it, vi } from "vitest";
import { EvidencePublicationService } from "./evidence-publication.js";
import type { EvidenceStore } from "./evidence-store.js";
import type { EvidenceGrantRepository } from "@stonehush/db";

function stubStore(overrides: Partial<EvidenceStore> = {}): EvidenceStore {
  return { publish: () => ({ status: "published", identity: { dev: 1, ino: 1 } }), inspectPublishedDestination: async () => ({ status: "match", sizeBytes: 4, digest: "sha256:" + "a".repeat(64) }), fsyncPublishedDirectory: () => {}, ...overrides } as unknown as EvidenceStore;
}
function stubRepo(grant: unknown, authority: unknown = { ok: true }): EvidenceGrantRepository {
  return {
    findGrantByUploadId: () => grant as unknown as ReturnType<EvidenceGrantRepository["findGrantByUploadId"]>,
    checkUploadLeaseAuthority: () => authority as unknown as ReturnType<EvidenceGrantRepository["checkUploadLeaseAuthority"]>,
    publishedArtifactForIdentity: () => undefined,
    recordPublication: () => ({ ok: true, outcome: { status: "inserted" } }) as unknown as ReturnType<EvidenceGrantRepository["recordPublication"]>,
    markGrantInterrupted: () => ({ ok: true }) as unknown as ReturnType<EvidenceGrantRepository["markGrantInterrupted"]>,
  } as unknown as EvidenceGrantRepository;
}
describe("publication hook", () => {
  it("invokes hook for fresh, replay and recovery but not stale", async () => {
    const hook = vi.fn(async () => ({ ok: true as const }));
    // fresh
    const grantFresh = { artifactId: "a1", uploadId: "u1", runId: "r1", fence: "1", eventSequence: 1, artifactSlot: "nmap-xml", kind: "tool_raw", state: "in_progress", putFinalized: true, acceptedBytes: 4, streamedDigest: "sha256:" + "a".repeat(64), runnerId: "runner-1" };
    const svcFresh = new EvidencePublicationService({ repository: stubRepo(grantFresh), store: stubStore(), onPublicationCommitted: hook });
    const resFresh = await svcFresh.handleComplete("u1", "runner-1", { uploadId: "u1", sizeBytes: 4, digest: "sha256:" + "a".repeat(64) });
    expect(resFresh.ok).toBe(true); expect(hook).toHaveBeenCalledTimes(1); expect(hook).toHaveBeenCalledWith("a1");
    hook.mockClear();
    // replay (already published)
    const grantPub = { ...grantFresh, state: "published" };
    const svcReplay = new EvidencePublicationService({ repository: stubRepo(grantPub), store: stubStore(), onPublicationCommitted: hook });
    const resReplay = await svcReplay.handleComplete("u1", "runner-1", { uploadId: "u1", sizeBytes: 4, digest: "sha256:" + "a".repeat(64) });
    expect(resReplay.ok).toBe(true); expect(hook).toHaveBeenCalledTimes(1);
    hook.mockClear();
    // recovery via destination_exists
    const storeRec = stubStore({ publish: () => ({ status: "destination_exists" }) });
    const repoRec = { ...stubRepo(grantFresh), recordPublication: () => ({ ok: true, outcome: { status: "inserted" } }) } as unknown as EvidenceGrantRepository;
    const svcRec = new EvidencePublicationService({ repository: repoRec, store: storeRec, onPublicationCommitted: hook });
    const resRec = await svcRec.handleComplete("u1", "runner-1", { uploadId: "u1", sizeBytes: 4, digest: "sha256:" + "a".repeat(64) });
    expect(resRec.ok).toBe(true); expect(hook).toHaveBeenCalledTimes(1);
    hook.mockClear();
    // stale authority should not invoke
    const staleAuth = { ok: false, code: "stale_fence" };
    const svcStale = new EvidencePublicationService({ repository: stubRepo(grantFresh, staleAuth), store: stubStore(), onPublicationCommitted: hook });
    const resStale = await svcStale.handleComplete("u1", "runner-1", { uploadId: "u1", sizeBytes: 4, digest: "sha256:" + "a".repeat(64) });
    expect(resStale.ok).toBe(false); expect(hook).not.toHaveBeenCalled();
    // hook rejection maps to invalid_persisted_data
    const hookFail = vi.fn(async () => ({ ok: false as const, code: "storage_busy" as const }));
    const svcFail = new EvidencePublicationService({ repository: stubRepo(grantFresh), store: stubStore(), onPublicationCommitted: hookFail });
    const resFail = await svcFail.handleComplete("u1", "runner-1", { uploadId: "u1", sizeBytes: 4, digest: "sha256:" + "a".repeat(64) });
    expect(resFail.ok).toBe(false);
    const hookThrow = vi.fn(async () => { throw new Error("boom"); });
    const svcThrow = new EvidencePublicationService({ repository: stubRepo(grantFresh), store: stubStore(), onPublicationCommitted: hookThrow });
    const resThrow = await svcThrow.handleComplete("u1", "runner-1", { uploadId: "u1", sizeBytes: 4, digest: "sha256:" + "a".repeat(64) });
    expect(resThrow.ok).toBe(false);
  });
});
