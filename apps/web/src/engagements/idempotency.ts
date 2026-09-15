import { IdempotencyKeySchema } from "@stonehush/contracts";

import { createBrowserUuid } from "../lib/browser-uuid.js";

export function createIdempotencyKey(
  generate: () => string = createBrowserUuid,
): string {
  const parsed = IdempotencyKeySchema.safeParse(generate());
  if (!parsed.success) {
    throw new Error("Generated idempotency key failed the shared contract.");
  }
  return parsed.data;
}

export function requestFingerprint(value: unknown): string {
  return JSON.stringify(value);
}

export function createIntentKeyHolder(generate: () => string = createIdempotencyKey) {
  const keys = new Map<string, string>();
  return {
    keyFor(intent: string): string {
      const existing = keys.get(intent);
      if (existing !== undefined) return existing;
      const next = generate();
      keys.set(intent, next);
      return next;
    },
    reset(intent?: string) {
      if (intent === undefined) {
        keys.clear();
        return;
      }
      keys.delete(intent);
    },
  };
}
