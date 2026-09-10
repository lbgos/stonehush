import type { StoneCommandRecipe, StoneCopyKind } from "@blackglass/contracts";

export const COPIED_NOT_RAN_NOTE = "Copied, not run.";

export interface StoneRecipeSnapshot {
  readonly address: string | null;
  readonly hostname: string | null;
  readonly origin: string | null;
  readonly accountRef: string | null;
  readonly connectionRef: string | null;
  readonly command: string | null;
}

export type ResolveRecipeCopyResult =
  | { ok: true; text: string }
  | { ok: false; missing: string[] };

function snapshotValue(snapshot: StoneRecipeSnapshot, key: string): string | null {
  switch (key) {
    case "address":
      return snapshot.address;
    case "hostname":
      return snapshot.hostname;
    case "origin":
      return snapshot.origin;
    case "account":
      return snapshot.accountRef;
    case "connection":
      return snapshot.connectionRef;
    default:
      return null;
  }
}

// Command recipes render against inspectable resolved values. Missing inputs
// are reported before anything is copied; copying never implies running.
export function resolveRecipeCopy(
  recipe: Pick<StoneCommandRecipe, "commandTemplate" | "requiredInputs">,
  snapshot: StoneRecipeSnapshot,
): ResolveRecipeCopyResult {
  const missing: string[] = [];
  for (const required of recipe.requiredInputs) {
    const value = snapshotValue(snapshot, required);
    if (value === null || value.trim().length === 0) missing.push(required);
  }
  if (missing.length > 0) return { ok: false, missing };
  let text = recipe.commandTemplate;
  for (const key of ["address", "hostname", "origin", "account", "connection"] as const) {
    const value = snapshotValue(snapshot, key);
    if (value !== null) text = text.split(`{${key}}`).join(value);
  }
  return { ok: true, text };
}

// Copy actions distinguish address, hostname, URL, and command. URL copies
// require a stored origin so no scheme is invented at copy time.
export function buildCopyText(
  kind: StoneCopyKind,
  snapshot: StoneRecipeSnapshot,
): ResolveRecipeCopyResult {
  switch (kind) {
    case "address":
      return snapshot.address === null || snapshot.address.trim().length === 0
        ? { ok: false, missing: ["address"] }
        : { ok: true, text: snapshot.address };
    case "hostname":
      return snapshot.hostname === null || snapshot.hostname.trim().length === 0
        ? { ok: false, missing: ["hostname"] }
        : { ok: true, text: snapshot.hostname };
    case "url":
      return snapshot.origin === null || snapshot.origin.trim().length === 0
        ? { ok: false, missing: ["origin"] }
        : { ok: true, text: snapshot.origin };
    case "command":
      return snapshot.command === null || snapshot.command.trim().length === 0
        ? { ok: false, missing: ["command"] }
        : { ok: true, text: snapshot.command };
  }
}

export async function copyResolvedText(
  text: string,
  write: (value: string) => Promise<void>,
): Promise<void> {
  await write(text);
}
