/**
 * Export snapshot and staleness (STONE-7).
 * Every export captures a coherent snapshot: the rendered text, the outline
 * keys it was built from, and the live bundle timestamp it reflects. When
 * the engagement changes afterwards, the snapshot is visibly stale instead
 * of silently before behind. Snapshots are local UI state, never persisted
 * records.
 */

export interface ExportSnapshot {
  readonly id: string;
  readonly createdAt: string;
  readonly bundleGeneratedAt: string;
  readonly template: string;
  readonly itemKeys: readonly string[];
  readonly markdown: string;
  readonly byteLength: number;
}

export interface SnapshotInput {
  readonly bundleGeneratedAt: string;
  readonly template: string;
  readonly itemKeys: readonly string[];
  readonly markdown: string;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function captureExportSnapshot(input: SnapshotInput): ExportSnapshot {
  const createdAt = (input.now ?? (() => new Date()))().toISOString();
  const createId = input.createId ?? (() => `snapshot-${createdAt}`);
  return {
    id: createId(),
    createdAt,
    bundleGeneratedAt: input.bundleGeneratedAt,
    template: input.template,
    itemKeys: [...input.itemKeys],
    markdown: input.markdown,
    byteLength: utf8Length(input.markdown),
  };
}

export interface Staleness {
  readonly stale: boolean;
  readonly reason: string;
}

// A snapshot goes stale when the live bundle regenerated after the export
// (a later edit, finding, or run changed the underlying data).
export function describeSnapshotStaleness(
  snapshot: ExportSnapshot | null,
  live: { bundleGeneratedAt: string },
): Staleness {
  if (snapshot === null) {
    return { stale: false, reason: "No export yet." };
  }
  if (live.bundleGeneratedAt !== snapshot.bundleGeneratedAt) {
    return {
      stale: true,
      reason: `Stale: engagement data changed after this export (export ${snapshot.createdAt}). Re-export for a current snapshot.`,
    };
  }
  return { stale: false, reason: `Current as of ${snapshot.createdAt}.` };
}
