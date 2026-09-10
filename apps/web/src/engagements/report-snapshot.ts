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

export interface SnapshotLiveState {
  readonly bundleGeneratedAt: string;
  readonly template: string;
  readonly itemKeys: readonly string[];
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

// A snapshot goes stale when the live bundle regenerated after the export
// (a later edit, finding, or run changed the underlying data) or when the
// outline itself drifted (reselected, reordered, or retemplated): the
// snapshot markdown would no longer match a fresh export.
export function describeSnapshotStaleness(
  snapshot: ExportSnapshot | null,
  live: SnapshotLiveState,
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
  if (live.template !== snapshot.template) {
    return {
      stale: true,
      reason: `Stale: outline template changed to ${live.template} after this export. Re-export for a current snapshot.`,
    };
  }
  if (!sameKeys(live.itemKeys, snapshot.itemKeys)) {
    return {
      stale: true,
      reason: "Stale: outline selection or order changed after this export. Re-export for a current snapshot.",
    };
  }
  return { stale: false, reason: `Current as of ${snapshot.createdAt}.` };
}
