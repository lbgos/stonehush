import { createHash } from "node:crypto";

import {
  ActionSnapshotDigestSchema,
  canonicalizeActionSnapshot,
} from "@stonehush/contracts";

export type ActionSnapshotBindingResult =
  | { ok: true; binding: string; canonicalJson: string }
  | { ok: false; error: { code: "invalid_repository_input" } };

export function bindActionSnapshot(input: unknown): ActionSnapshotBindingResult {
  const canonical = canonicalizeActionSnapshot(input);
  if (!canonical.ok) return { ok: false, error: { code: "invalid_repository_input" } };
  const binding = `sha256:${createHash("sha256")
    .update(canonical.canonicalJson, "utf8")
    .digest("hex")}`;
  if (!ActionSnapshotDigestSchema.safeParse(binding).success) {
    return { ok: false, error: { code: "invalid_repository_input" } };
  }
  return { ok: true, binding, canonicalJson: canonical.canonicalJson };
}
