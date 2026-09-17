import {
  FfufVhostDiscoveryOptionsSchema,
  type ActionSnapshot,
  type FfufVhostDiscoveryOptions,
} from "@stonehush/contracts";

/**
 * ffuf vhost action marker (T1).
 * A vhost discovery action is a planned action whose canonical targets are a
 * single IP and whose typedOptions carry validated vhost options under the
 * `ffufVhost` key. T1 carries no tier warning by default; saved-scope
 * warnings behave exactly like other discovery actions.
 */

function vhostOptionsFromTypedOptions(
  typedOptions: ActionSnapshot["typedOptions"],
): FfufVhostDiscoveryOptions | null {
  if (typeof typedOptions !== "object" || typedOptions === null || Array.isArray(typedOptions)) {
    return null;
  }
  const parsed = FfufVhostDiscoveryOptionsSchema.safeParse(
    (typedOptions as Record<string, unknown>).ffufVhost,
  );
  return parsed.success ? parsed.data : null;
}

export function isVhostSnapshot(snapshot: ActionSnapshot): boolean {
  if (snapshot.canonicalTargets.length !== 1) return false;
  const target = snapshot.canonicalTargets[0];
  if (target === undefined || target.kind !== "ip") return false;
  return vhostOptionsFromTypedOptions(snapshot.typedOptions) !== null;
}

export function vhostOptionsForSnapshot(snapshot: ActionSnapshot): FfufVhostDiscoveryOptions | null {
  if (!isVhostSnapshot(snapshot)) return null;
  return vhostOptionsFromTypedOptions(snapshot.typedOptions);
}

/**
 * Fail-closed dispatch guard: the snapshot claims to be a vhost action
 * (typedOptions carry a `ffufVhost` key) even when the options no longer
 * validate. The runner must reject those instead of running plain ffuf.
 */
export function hasVhostMarker(snapshot: ActionSnapshot): boolean {
  const typedOptions = snapshot.typedOptions;
  return (
    typeof typedOptions === "object" &&
    typedOptions !== null &&
    !Array.isArray(typedOptions) &&
    Object.hasOwn(typedOptions, "ffufVhost")
  );
}
