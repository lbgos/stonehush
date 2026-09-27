/**
 * Bounded output handling per ADR-0002.
 * Retains up to 16 MiB per collector by default.
 * This module implements the runner-side retention window with truncation metadata.
 */

export const DEFAULT_COMBINED_RETAINED_OUTPUT = 16 * 1024 * 1024;

export interface TruncationMeta {
  inputBytesSeen: number;
  redactedBytesProduced: number;
  bytesRetained: number;
  bytesDropped: number;
  firstDroppedRedactedOffset: number | null;
  truncated: boolean;
}

export class BoundedCollector {
  private retained: Buffer[] = [];
  private retainedBytes = 0;
  private inputBytesSeen = 0;
  private redactedBytesProduced = 0;
  private firstDroppedOffset: number | null = null;

  constructor(private readonly limit: number = DEFAULT_COMBINED_RETAINED_OUTPUT) {}

  push(inputBytes: number, redactedChunk: Buffer): void {
    this.inputBytesSeen += inputBytes;
    this.redactedBytesProduced += redactedChunk.length;

    if (redactedChunk.length === 0) return;

    const remaining = this.limit - this.retainedBytes;
    if (remaining <= 0) {
      if (this.firstDroppedOffset === null) this.firstDroppedOffset = this.retainedBytes;
      return;
    }
    if (redactedChunk.length <= remaining) {
      this.retained.push(redactedChunk);
      this.retainedBytes += redactedChunk.length;
    } else {
      this.retained.push(redactedChunk.subarray(0, remaining));
      this.retainedBytes += remaining;
      if (this.firstDroppedOffset === null) this.firstDroppedOffset = this.limit;
    }
  }

  combined(): Buffer {
    return Buffer.concat(this.retained);
  }

  meta(): TruncationMeta {
    const bytesDropped = this.redactedBytesProduced - this.retainedBytes;
    return {
      inputBytesSeen: this.inputBytesSeen,
      redactedBytesProduced: this.redactedBytesProduced,
      bytesRetained: this.retainedBytes,
      bytesDropped: Math.max(0, bytesDropped),
      firstDroppedRedactedOffset: this.firstDroppedOffset,
      truncated: bytesDropped > 0,
    };
  }
}
