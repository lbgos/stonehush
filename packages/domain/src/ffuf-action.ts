import {
  FfufDiscoveryOptionsSchema,
  type ActionSnapshot,
  type FfufDiscoveryOptions,
} from "@stonehush/contracts";

/**
 * Slice 2 ffuf action marker.
 * An ffuf discovery action is a planned action whose canonical targets are a
 * single http(s) URL origin and whose typedOptions carry validated ffuf
 * discovery options under the `ffuf` key. The marker drives the T2 warning
 * at plan time and the runner dispatch at lease time. It deliberately sits
 * beside the http-probe marker: the runner checks ffuf first because an
 * ffuf origin is also a URL target.
 */

function ffufOptionsFromTypedOptions(typedOptions: ActionSnapshot["typedOptions"]): FfufDiscoveryOptions | null {
  if (typeof typedOptions !== "object" || typedOptions === null || Array.isArray(typedOptions)) {
    return null;
  }
  const parsed = FfufDiscoveryOptionsSchema.safeParse(
    (typedOptions as Record<string, unknown>).ffuf,
  );
  return parsed.success ? parsed.data : null;
}

export function isFfufSnapshot(snapshot: ActionSnapshot): boolean {  if (snapshot.canonicalTargets.length !== 1) return false;
  const target = snapshot.canonicalTargets[0];
  if (target === undefined || target.kind !== "url") return false;
  if (!target.url.startsWith("http://") && !target.url.startsWith("https://")) return false;
  return ffufOptionsFromTypedOptions(snapshot.typedOptions) !== null;
}

export function ffufOptionsForSnapshot(snapshot: ActionSnapshot): FfufDiscoveryOptions | null {
  if (!isFfufSnapshot(snapshot)) return null;
  return ffufOptionsFromTypedOptions(snapshot.typedOptions);
}

/**
 * Fail-closed dispatch guard: the snapshot claims to be an ffuf action
 * (typedOptions carry an `ffuf` key) even when the options no longer
 * validate. The runner must reject those instead of probing the origin
 * as plain HTTP.
 */
export function hasFfufMarker(snapshot: ActionSnapshot): boolean {
  const typedOptions = snapshot.typedOptions;
  return (
    typeof typedOptions === "object" &&
    typedOptions !== null &&
    !Array.isArray(typedOptions) &&
    Object.hasOwn(typedOptions, "ffuf")
  );
}
