import type {
  FfufProjected,
  HttpProbeProjected,
  NmapProjectedService,
  PersistedAction,
  SavedScopeRule,
} from "@stonehush/contracts";
import {
  FFUF_DEFAULT_MATCH_CODES,
  FFUF_MAX_TIME_SECONDS_DEFAULT,
  FFUF_RATE_DEFAULT,
  FFUF_THREADS_DEFAULT,
  FFUF_TIMEOUT_SECONDS_DEFAULT,
} from "@stonehush/contracts";
import { Button, LoadingRegion, Skeleton } from "@stonehush/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { useRunnerSettingsQuery } from "../settings/runner-settings.js";
import { useCancelActionMutation, useContinueLateWarningActionMutation, useCreateActionMutation } from "./action-mutations.js";
import { WarningCard } from "./action-planner.js";
import {
  actionLifecycleStatusCopy,
  isTerminalActionState,
  persistedActionQueryOptions,
} from "./action-query.js";
import {
  formatCanonicalTarget,
  latestActionSnapshot,
  warningReasonCodes,
  warningReasonSummary,
} from "./action-targets.js";
import { EngagementMutationClientError, engagementMutationMessage } from "./errors.js";
import { useLaunchFfufDiscoveryMutation } from "./ffuf-mutations.js";
import { useFindingsQuery } from "./findings-query.js";
import { formatEngagementTimestamp } from "./format.js";
import {
  engagementFfufResultsQueryKey,
  engagementHttpProbesQueryKey,
  engagementServicesQueryKey,
  useEngagementDetailQuery,
} from "./query.js";
import { copyTextToClipboard, reportQueryKey } from "./report-query.js";

// Shared surface selection, inspector, and action launcher for STONE-2.
//
// Selection identity is a plain string key so it survives in the engagement
// route search (?sel=) and browser Back steps through investigation context
// instead of leaving the engagement. Row containers carry
// data-surface-row={key} so closing an overlay can return focus to the exact
// row that opened it.

// ---------------------------------------------------------------------------
// Selection keys
// ---------------------------------------------------------------------------

export type SurfaceSelectionKind = "service" | "probe" | "path";

export interface SurfaceSelection {
  readonly kind: SurfaceSelectionKind;
  readonly key: string;
  readonly address?: string;
  readonly port?: number;
  readonly protocol?: string;
  readonly url?: string;
  readonly artifactId?: string;
}

export function serviceSelectionKey(
  address: string,
  port: number,
  protocol?: string,
  artifactId?: string,
): string {
  const formattedAddress = address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
  if (protocol !== undefined && artifactId !== undefined) {
    return `service:${formattedAddress}:${String(port)}:${protocol}:${artifactId}`;
  }
  return `service:${formattedAddress}:${String(port)}`;
}

export function probeSelectionKey(url: string, artifactId?: string): string {
  if (artifactId !== undefined) {
    return `probe:${artifactId}:${url}`;
  }
  return `probe:${url}`;
}

export function pathSelectionKey(url: string, artifactId?: string): string {
  if (artifactId !== undefined) {
    return `path:${artifactId}:${url}`;
  }
  return `path:${url}`;
}

function isHttpUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

export function decodeSurfaceSelection(raw: string | undefined): SurfaceSelection | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  const separator = raw.indexOf(":");
  if (separator < 0) return undefined;
  const kind = raw.slice(0, separator);
  const rest = raw.slice(separator + 1);
  if (kind === "probe" || kind === "path") {
    if (isHttpUrl(rest)) {
      return { kind, key: raw, url: rest };
    }
    const colon = rest.indexOf(":");
    if (colon <= 0) return undefined;
    const artifactId = rest.slice(0, colon);
    const url = rest.slice(colon + 1);
    if (!/^[a-z0-9][a-z0-9-]{0,126}$/.test(artifactId) || !isHttpUrl(url)) {
      return undefined;
    }
    return { kind, key: raw, artifactId, url };
  }
  if (kind === "service") {
    let address: string;
    let afterAddress: string;
    if (rest.startsWith("[")) {
      const closingBracket = rest.indexOf("]");
      if (closingBracket < 0) return undefined;
      address = rest.slice(1, closingBracket);
      const remainder = rest.slice(closingBracket + 1);
      if (!remainder.startsWith(":")) return undefined;
      afterAddress = remainder.slice(1);
    } else {
      const tokens = rest.split(":");
      if (tokens.length === 2) {
        address = tokens[0]!;
        afterAddress = tokens[1]!;
      } else if (tokens.length > 2) {
        const last = tokens[tokens.length - 1]!;
        const secondLast = tokens[tokens.length - 2]!;
        const thirdLast = tokens[tokens.length - 3]!;
        if (
          /^[a-z0-9][a-z0-9-]{0,126}$/.test(last) &&
          (secondLast === "tcp" || secondLast === "udp") &&
          /^\d+$/.test(thirdLast)
        ) {
          address = tokens.slice(0, tokens.length - 3).join(":");
          afterAddress = `${thirdLast}:${secondLast}:${last}`;
        } else {
          const portCandidate = tokens[tokens.length - 1]!;
          if (!/^\d+$/.test(portCandidate)) return undefined;
          address = tokens.slice(0, -1).join(":");
          afterAddress = portCandidate;
        }
      } else {
        return undefined;
      }
    }
    if (address.length === 0) return undefined;
    const parts = afterAddress.split(":");
    const portRaw = parts[0]!;
    if (!/^\d+$/.test(portRaw)) return undefined;
    const port = Number.parseInt(portRaw, 10);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return undefined;
    if (parts.length === 1) {
      return { kind, key: raw, address, port };
    }
    if (parts.length === 3) {
      const protocol = parts[1]!;
      const artifactId = parts[2]!;
      if (protocol.length === 0 || !/^[a-z0-9][a-z0-9-]{0,126}$/.test(artifactId)) {
        return undefined;
      }
      return { kind, key: raw, address, port, protocol, artifactId };
    }
    return undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Origin helpers (presentation only; STONE-6 owns shared grouping helpers)
// ---------------------------------------------------------------------------

export type OriginScheme = "http" | "https";

export interface OriginParts {
  readonly origin: string;
  readonly host: string;
  readonly port: number;
  readonly scheme: OriginScheme;
}

export function splitOriginUrl(url: string): OriginParts | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  // The URL parser silently drops an explicit empty port (http://host: reads
  // as http://host). An explicit port separator with no port is malformed
  // operator input, not a default-port URL, so reject it here.
  const authority = url.slice(url.indexOf("://") + 3).split(/[/?#]/, 1)[0] ?? "";
  if (authority.endsWith(":")) return undefined;
  const scheme: OriginScheme = parsed.protocol === "https:" ? "https" : "http";
  const defaultPort = scheme === "https" ? 443 : 80;
  const port = parsed.port === "" ? defaultPort : Number.parseInt(parsed.port, 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return undefined;
  const host = parsed.hostname.toLowerCase();
  if (host.length === 0) return undefined;
  const origin = port === defaultPort ? `${scheme}://${host}` : `${scheme}://${host}:${String(port)}`;
  return { origin, host, port, scheme };
}

export function parseOriginScheme(origin: string): OriginScheme {
  return origin.startsWith("https://") ? "https" : "http";
}

export function withOriginScheme(origin: string, scheme: OriginScheme): string {
  const marker = origin.indexOf("://");
  const withoutScheme = marker >= 0 ? origin.slice(marker + 3) : origin;
  let authority: string;
  let pathAndQuery = "";
  const firstSlash = withoutScheme.search(/[/?#]/);
  if (firstSlash >= 0) {
    authority = withoutScheme.slice(0, firstSlash);
    pathAndQuery = withoutScheme.slice(firstSlash);
  } else {
    authority = withoutScheme;
  }
  let host: string;
  let port: number | undefined;
  // An explicit port that is not a plain 1-65535 integer is kept verbatim in
  // the authority so downstream splitOriginUrl validation rejects the target
  // instead of silently probing a different endpoint without the port.
  const parseAuthorityPort = (rawPort: string): number | undefined => {
    if (!/^\d+$/.test(rawPort)) return undefined;
    const parsedPort = Number.parseInt(rawPort, 10);
    if (!Number.isSafeInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      return undefined;
    }
    return parsedPort;
  };
  if (authority.startsWith("[")) {
    const closingBracket = authority.indexOf("]");
    if (closingBracket >= 0) {
      host = authority.slice(0, closingBracket + 1);
      const after = authority.slice(closingBracket + 1);
      if (after.startsWith(":")) {
        const parsedPort = parseAuthorityPort(after.slice(1));
        if (parsedPort === undefined) {
          host = authority;
        } else {
          port = parsedPort;
        }
      } else if (after.length > 0) {
        host = authority;
      }
    } else {
      host = authority;
    }
  } else {
    const colonCount = (authority.match(/:/g) ?? []).length;
    if (colonCount > 1) {
      host = `[${authority}]`;
    } else if (colonCount === 1) {
      const colon = authority.indexOf(":");
      const parsedPort = parseAuthorityPort(authority.slice(colon + 1));
      if (parsedPort === undefined) {
        host = authority;
      } else {
        host = authority.slice(0, colon);
        port = parsedPort;
      }
    } else {
      host = authority;
    }
  }
  const defaultPort = scheme === "https" ? 443 : 80;
  const portString = port !== undefined && port !== defaultPort ? `:${String(port)}` : "";
  return `${scheme}://${host}${portString}${pathAndQuery}`;
}

// Web-origin candidacy is a presentation-only heuristic that decides which
// projected services get an origin block with probe/discover actions. It is
// intentionally local: STONE-6 owns shared grouping helpers later.
const WEB_SERVICE_PORTS: readonly number[] = [80, 443, 3000, 5000, 8000, 8008, 8080, 8443, 8888, 9000];

export function isWebServiceCandidate(service: NmapProjectedService): boolean {
  if (service.serviceName !== null && /https?/i.test(service.serviceName)) return true;
  if (service.product !== null && /https?/i.test(service.product)) return true;
  return WEB_SERVICE_PORTS.includes(service.port);
}

export function defaultSchemeForPort(port: number): OriginScheme {
  return port === 443 || port === 8443 ? "https" : "http";
}

// ---------------------------------------------------------------------------
// Stable extension slots for later slices.
//
// STONE-6 (leads) and STONE-7 (search) wire into these after STONE-2 merges.
// The signatures are frozen: surfaces call extraRowActions for every
// selectable row and belowOrigin beneath every web origin block. Both default
// to rendering nothing. Do not build leads or search UI here.
// ---------------------------------------------------------------------------

export interface SurfaceRowContext {
  readonly kind: SurfaceSelectionKind;
  readonly key: string;
  readonly title: string;
  readonly target: string;
}

export interface SurfaceOriginContext {
  readonly origin: string;
  readonly target: string;
  readonly scheme: OriginScheme;
}

export type ExtraRowActions = (context: SurfaceRowContext) => ReactNode;

export type BelowOrigin = (context: SurfaceOriginContext) => ReactNode;

// ---------------------------------------------------------------------------
// Provenance-aware row selection helpers
// ---------------------------------------------------------------------------

export function isServiceRowSelected(
  service: NmapProjectedService,
  selectedKey: string | undefined,
  allServices?: readonly NmapProjectedService[],
): boolean {
  if (selectedKey === undefined) return false;
  const canonicalKey = serviceSelectionKey(
    service.address,
    service.port,
    service.protocol,
    service.artifactId,
  );
  if (selectedKey === canonicalKey) return true;
  const decoded = decodeSurfaceSelection(selectedKey);
  if (decoded?.kind === "service" && decoded.artifactId === undefined) {
    if (allServices !== undefined) {
      const decodedAddr = decoded.address?.replace(/^\[|\]$/g, "").toLowerCase();
      const matches = allServices.filter(
        (s) =>
          s.address.replace(/^\[|\]$/g, "").toLowerCase() === decodedAddr &&
          s.port === decoded.port,
      );
      if (matches.length === 1 && matches[0]?.artifactId === service.artifactId) {
        return true;
      }
    }
  }
  return false;
}

export function isProbeRowSelected(
  probe: HttpProbeProjected,
  selectedKey: string | undefined,
  allProbes?: readonly HttpProbeProjected[],
): boolean {
  if (selectedKey === undefined) return false;
  const canonicalKey = probeSelectionKey(probe.url, probe.artifactId);
  if (selectedKey === canonicalKey) return true;
  const decoded = decodeSurfaceSelection(selectedKey);
  if (decoded?.kind === "probe" && decoded.artifactId === undefined) {
    if (allProbes !== undefined) {
      const matches = allProbes.filter((p) => p.url === decoded.url);
      if (matches.length === 1 && matches[0]?.artifactId === probe.artifactId) {
        return true;
      }
    }
  }
  return false;
}

export function isPathRowSelected(
  result: FfufProjected,
  selectedKey: string | undefined,
  allResults?: readonly FfufProjected[],
): boolean {
  if (selectedKey === undefined) return false;
  const canonicalKey = pathSelectionKey(result.url, result.artifactId);
  if (selectedKey === canonicalKey) return true;
  const decoded = decodeSurfaceSelection(selectedKey);
  if (decoded?.kind === "path" && decoded.artifactId === undefined) {
    if (allResults !== undefined) {
      const matches = allResults.filter((r) => r.url === decoded.url);
      if (matches.length === 1 && matches[0]?.artifactId === result.artifactId) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Focus and scroll restoration
// ---------------------------------------------------------------------------

export function focusSurfaceRow(key: string): boolean {
  const nodes = document.querySelectorAll("[data-surface-row]");
  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.getAttribute("data-surface-row") !== key) continue;
    const target =
      node instanceof HTMLButtonElement ? node : node.querySelector<HTMLElement>("button");
    (target ?? node).focus({ preventScroll: true });
    return true;
  }
  return false;
}

export function restoreSurfacePosition(scrollY: number, key: string | undefined): void {
  window.scrollTo(0, scrollY);
  if (key !== undefined) focusSurfaceRow(key);
}

// ---------------------------------------------------------------------------
// Inspector records
// ---------------------------------------------------------------------------

export interface InspectorObservation {
  readonly label: string;
  readonly value: string;
}

export interface InspectorRecord {
  readonly kind: SurfaceSelectionKind;
  readonly key: string;
  readonly title: string;
  readonly subtitle: string;
  readonly target: string;
  readonly observedAt: string;
  readonly artifactId: string;
  readonly runId: string;
  readonly artifactDigest: string;
  readonly parserVersion: string;
  readonly observation: readonly InspectorObservation[];
  readonly evidenceDownloadUrl: string;
  readonly evidenceDownloadName: string;
  readonly openUrl?: string | undefined;
  readonly origin?: string | undefined;
  readonly noteReference: string;
}

function artifactUrl(engagementId: string, artifactId: string): string {
  return `/api/v1/engagements/${encodeURIComponent(engagementId)}/artifacts/${encodeURIComponent(artifactId)}/content`;
}

function serviceIdentity(service: NmapProjectedService): string {
  if (service.product !== null) {
    return service.version !== null ? `${service.product} ${service.version}` : service.product;
  }
  if (service.serviceName !== null) return service.serviceName;
  return "unknown";
}

export function serviceInspectorRecord(
  service: NmapProjectedService,
  engagementId: string,
): InspectorRecord {
  const identity = serviceIdentity(service);
  return {
    kind: "service",
    key: serviceSelectionKey(service.address, service.port, service.protocol, service.artifactId),
    title: `${service.address}:${String(service.port)}`,
    subtitle: identity,
    target: service.address,
    observedAt: service.observedAt,
    artifactId: service.artifactId,
    runId: service.runId,
    artifactDigest: service.artifactDigest,
    parserVersion: service.parserVersion,
    observation: [
      { label: "Address", value: service.address },
      { label: "Hostname", value: service.hostname ?? "-" },
      { label: "Port", value: `${String(service.port)}/${service.protocol}` },
      { label: "Service", value: identity },
      ...(service.serviceName !== null && service.serviceName !== identity
        ? [{ label: "Service name", value: service.serviceName }]
        : []),
      { label: "Observed", value: formatEngagementTimestamp(service.observedAt) },
    ],
    evidenceDownloadUrl: artifactUrl(engagementId, service.artifactId),
    evidenceDownloadName: `nmap-${service.artifactId}.xml`,
    noteReference: `- ${service.address}:${String(service.port)} (${identity}) · evidence ${service.artifactId}`,
  };
}

function probeStatus(probe: HttpProbeProjected): string {
  if (probe.status === null) return probe.error ?? "no status";
  return String(probe.status);
}

export function probeInspectorRecord(
  probe: HttpProbeProjected,
  engagementId: string,
): InspectorRecord {
  const parts = splitOriginUrl(probe.url);
  return {
    kind: "probe",
    key: probeSelectionKey(probe.url, probe.artifactId),
    title: probe.url,
    subtitle: `${probeStatus(probe)} · ${probe.title ?? "no title"}`,
    target: probe.url,
    observedAt: probe.observedAt,
    artifactId: probe.artifactId,
    runId: probe.runId,
    artifactDigest: probe.artifactDigest,
    parserVersion: probe.parserVersion,
    observation: [
      { label: "URL", value: probe.url },
      { label: "Final URL", value: probe.finalUrl },
      { label: "Status", value: probeStatus(probe) },
      { label: "Title", value: probe.title ?? "-" },
      { label: "Server", value: probe.selectedHeaders.server ?? "-" },
      { label: "Content type", value: probe.selectedHeaders.contentType ?? "-" },
      { label: "Redirect hops", value: String(probe.hops.length) },
      { label: "Observed", value: formatEngagementTimestamp(probe.observedAt) },
    ],
    evidenceDownloadUrl: artifactUrl(engagementId, probe.artifactId),
    evidenceDownloadName: `http-probe-${probe.artifactId}.json`,
    openUrl: probe.url,
    ...(parts === undefined ? {} : { origin: parts.origin }),
    noteReference: `- ${probe.url} (${probeStatus(probe)}) · evidence ${probe.artifactId}`,
  };
}

export function pathInspectorRecord(
  result: FfufProjected,
  engagementId: string,
): InspectorRecord {
  const parts = splitOriginUrl(result.url);
  return {
    kind: "path",
    key: pathSelectionKey(result.url, result.artifactId),
    title: result.url,
    subtitle: `${String(result.status)} · ${String(result.length)} bytes`,
    target: result.url,
    observedAt: result.observedAt,
    artifactId: result.artifactId,
    runId: result.runId,
    artifactDigest: result.artifactDigest,
    parserVersion: result.parserVersion,
    observation: [
      { label: "URL", value: result.url },
      { label: "Status", value: String(result.status) },
      { label: "Size", value: `${String(result.length)} bytes` },
      { label: "Words", value: String(result.words) },
      { label: "Lines", value: String(result.lines) },
      { label: "Fuzz", value: result.fuzz },
      ...(result.redirectlocation !== null
        ? [{ label: "Redirect", value: result.redirectlocation }]
        : []),
      { label: "Observed", value: formatEngagementTimestamp(result.observedAt) },
    ],
    evidenceDownloadUrl: artifactUrl(engagementId, result.artifactId),
    evidenceDownloadName: `ffuf-${result.artifactId}.json`,
    openUrl: result.url,
    ...(parts === undefined ? {} : { origin: parts.origin }),
    noteReference: `- ${result.url} (${String(result.status)}) · evidence ${result.artifactId}`,
  };
}

// ---------------------------------------------------------------------------
// Shared inspector
// ---------------------------------------------------------------------------

export interface SurfaceInspectorProps {
  readonly engagementId: string;
  readonly loading: boolean;
  readonly error?: string | undefined;
  readonly onRetry?: (() => void) | undefined;
  readonly onAskAbout?: ((target: string) => void) | undefined;
  readonly onClose: () => void;
  readonly onDiscoverOrigin?: ((origin: string, scopeHint: string | undefined) => void) | undefined;
  readonly onOpenNotes?: (() => void) | undefined;
  readonly onProbeOrigin?: ((origin: string) => void) | undefined;
  readonly onStartLead?: ((target: string) => void) | undefined;
  readonly record: InspectorRecord | undefined;
  readonly selectionKey: string;
}

function InspectorSection({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section aria-label={title} className="border-t border-border px-3 py-3 first:border-t-0">
      <h3 className="m-0 text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
        {title}
      </h3>
      <div className="mt-2">{children}</div>
    </section>
  );
}

export function SurfaceInspector({
  engagementId,
  loading,
  error,
  onRetry,
  onAskAbout,
  onClose,
  onDiscoverOrigin,
  onOpenNotes,
  onProbeOrigin,
  onStartLead,
  record,
  selectionKey,
}: SurfaceInspectorProps) {
  const asideRef = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState<string | undefined>(undefined);

  useEffect(() => {
    setCopied(undefined);
    asideRef.current?.focus({ preventScroll: true });
  }, [selectionKey]);

  const onAsideKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  const copyValue = (label: string, value: string) => {
    void copyTextToClipboard(value).then((ok) => {
      if (ok) setCopied(label);
    });
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close inspector"
        className="fixed inset-0 z-40 bg-black/62 lg:hidden"
        onClick={onClose}
      />
      <aside
        ref={asideRef}
        aria-label="Selection inspector"
        tabIndex={-1}
        onKeyDown={onAsideKeyDown}
        className="fixed inset-y-0 right-0 z-50 w-full max-w-md overflow-y-auto border-l border-border bg-background outline-none lg:static lg:z-auto lg:w-80 lg:max-w-none lg:shrink-0 lg:overflow-visible lg:border-l-0"
      >
      <div className="lg:sticky lg:top-4 lg:overflow-hidden lg:rounded-[10px] lg:border lg:border-border lg:bg-card">
        <div className="flex min-h-10 items-center justify-between gap-2 border-b border-border px-3">
          <h2 className="m-0 truncate text-[13px] font-semibold">Inspector</h2>
          <Button type="button" variant="quiet" className="h-7 px-2 text-[12px]" onClick={onClose}>
            Close
          </Button>
        </div>
        {error !== undefined ? (
          <div className="px-3 py-3" role="alert">
            <p className="m-0 text-[13px] font-semibold text-destructive">Selection error</p>
            <p className="mt-1 mb-0 text-[12px] leading-5 text-muted-foreground">{error}</p>
            {onRetry !== undefined ? (
              <div className="mt-3">
                <Button type="button" variant="secondary" onClick={onRetry}>
                  Retry
                </Button>
              </div>
            ) : null}
          </div>
        ) : loading || record === undefined ? (
          <div className="px-3 py-3">
            {loading ? (
              <LoadingRegion label="Loading selection" className="space-y-2">
                <Skeleton className="h-3 w-40" />
                <Skeleton className="h-16 w-full" />
              </LoadingRegion>
            ) : (
              <div>
                <p className="m-0 text-[13px] font-semibold">Selection unavailable</p>
                <p className="mt-1 mb-0 text-[12px] leading-5 text-muted-foreground">
                  That row is no longer in the loaded surface, or the selection link is ambiguous across multiple observations. Refresh the surface or clear the selection.
                </p>
                <div className="mt-3">
                  <Button type="button" variant="secondary" onClick={onClose}>
                    Clear selection
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <InspectorRecordBody
            copied={copied}
            engagementId={engagementId}
            onAskAbout={onAskAbout}
            onCopy={copyValue}
            onDiscoverOrigin={onDiscoverOrigin}
            onOpenNotes={onOpenNotes}
            onProbeOrigin={onProbeOrigin}
            onStartLead={onStartLead}
            record={record}
          />
        )}
      </div>
    </aside>
    </>
  );
}

function InspectorRecordBody({
  copied,
  engagementId,
  onAskAbout,
  onCopy,
  onDiscoverOrigin,
  onOpenNotes,
  onProbeOrigin,
  onStartLead,
  record,
}: {
  copied: string | undefined;
  engagementId: string;
  onAskAbout: ((target: string) => void) | undefined;
  onCopy: (label: string, value: string) => void;
  onDiscoverOrigin: ((origin: string, scopeHint: string | undefined) => void) | undefined;
  onOpenNotes: (() => void) | undefined;
  onProbeOrigin: ((origin: string) => void) | undefined;
  onStartLead: ((target: string) => void) | undefined;
  record: InspectorRecord;
}) {
  const findings = useFindingsQuery(engagementId);
  const linkedFindings =
    findings.data === undefined
      ? undefined
      : findings.data.filter((finding) => finding.evidenceArtifactIds.includes(record.artifactId));
  const copiedNote = copied === "note";

  return (
    <div>
      <div className="px-3 py-3">
        <p className="m-0 truncate font-mono text-[13px] font-semibold" title={record.title}>
          {record.title}
        </p>
        <p className="m-0 mt-0.5 truncate text-[12px] text-muted-foreground" title={record.subtitle}>
          {record.subtitle}
        </p>
      </div>

      <InspectorSection title="Observation">
        <dl className="m-0 grid gap-2">
          {record.observation.map((entry) => (
            <div key={entry.label} className="min-w-0">
              <dt className="text-[11px] tracking-[0.04em] text-muted-foreground uppercase">
                {entry.label}
              </dt>
              <dd
                className="mt-0.5 mb-0 truncate font-mono text-[12px] text-foreground"
                title={entry.value}
              >
                {entry.value}
              </dd>
            </div>
          ))}
        </dl>
      </InspectorSection>

      <InspectorSection title="Follow-up actions">
        <div className="flex flex-col items-stretch gap-2">
          {record.origin !== undefined && onProbeOrigin !== undefined ? (
            <Button type="button" variant="secondary" onClick={() => onProbeOrigin(record.origin ?? "")}>
              Probe web
            </Button>
          ) : null}
          {record.openUrl !== undefined ? (
            <a
              className="inline-flex min-h-8 items-center justify-center rounded-md border border-input px-3 text-[13px] font-semibold text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              href={record.openUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open in browser
            </a>
          ) : null}
          {record.origin !== undefined && onDiscoverOrigin !== undefined ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                onDiscoverOrigin(
                  record.origin ?? "",
                  record.kind === "path" ? record.target : undefined,
                )
              }
            >
              Discover paths
            </Button>
          ) : null}
          {onStartLead !== undefined ? (
            <Button
              type="button"
              variant="quiet"
              onClick={() => onStartLead(record.target)}
            >
              Start a lead
            </Button>
          ) : null}
          {onAskAbout !== undefined ? (
            <Button
              type="button"
              variant="quiet"
              onClick={() => onAskAbout(record.target)}
            >
              Ask about this
            </Button>
          ) : null}
        </div>
      </InspectorSection>

      <InspectorSection title="Linked evidence">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <a
            className="inline-flex min-h-8 items-center text-[12px] font-semibold text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            href={record.evidenceDownloadUrl}
            download={record.evidenceDownloadName}
          >
            Raw evidence
          </a>
          <Button
            type="button"
            variant="quiet"
            className="h-7 px-2 text-[12px]"
            onClick={() => onCopy("title", record.title)}
          >
            {copied === "title" ? "Copied" : "Copy"}
          </Button>
        </div>
        {linkedFindings !== undefined ? (
          <p className="mt-2 mb-0 text-[12px] text-muted-foreground">
            {linkedFindings.length === 0
              ? "No findings reference this evidence yet."
              : `${String(linkedFindings.length)} linked finding${linkedFindings.length === 1 ? "" : "s"}: ${linkedFindings.map((finding) => finding.title).join(", ")}`}
          </p>
        ) : null}
        <details className="group mt-2 rounded-md border border-border">
          <summary className="flex min-h-8 cursor-pointer list-none items-center justify-between px-2.5 text-[11px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span>Evidence details</span>
            <span className="text-muted-foreground group-open:hidden">Show</span>
            <span className="hidden text-muted-foreground group-open:inline">Hide</span>
          </summary>
          <div className="border-t border-border px-2.5 py-2">
            <dl className="m-0 grid gap-2">
              <InspectorProvenanceField term="runId" value={record.runId} />
              <InspectorProvenanceField term="artifactId" value={record.artifactId} />
              <InspectorProvenanceField term="artifactDigest" value={record.artifactDigest} breakAll />
              <InspectorProvenanceField term="parserVersion" value={record.parserVersion} />
            </dl>
          </div>
        </details>
      </InspectorSection>

      <InspectorSection title="Notes">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            className="h-8 px-3 text-[12px]"
            onClick={() => onCopy("note", record.noteReference)}
          >
            {copiedNote ? "Copied" : "Copy note reference"}
          </Button>
          {onOpenNotes !== undefined ? (
            <Button
              type="button"
              variant="quiet"
              className="h-8 px-3 text-[12px]"
              onClick={onOpenNotes}
            >
              Open Notes
            </Button>
          ) : null}
        </div>
        <p className="mt-2 mb-0 text-[12px] leading-5 text-muted-foreground">
          Paste the reference into the engagement notes to link this row.
        </p>
      </InspectorSection>
    </div>
  );
}

function InspectorProvenanceField({
  breakAll = false,
  term,
  value,
}: {
  breakAll?: boolean;
  term: string;
  value: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] tracking-[0.04em] text-muted-foreground uppercase">{term}</dt>
      <dd
        className={`mt-1 text-[11px] ${breakAll ? "break-all font-mono" : "truncate font-mono"}`}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Action launcher: probe or ffuf discovery from an exact selected target.
// ---------------------------------------------------------------------------

export type LauncherWarningKind = "warning-card" | "paused-run" | "none";

// Warning UI follows the current display action, never a stale launch
// result. A pre-run warning renders the full WarningCard with Continue and
// Add to scope. A run that started and then paused for a late warning keeps
// its warning visible, but Continue and Add to scope stay unavailable: the
// action API accepts them only for pre-run warnings, and no late-warning
// continue route exists. Stopping the paused run remains available.
export function launcherWarningKind(
  displayAction: PersistedAction | undefined,
): LauncherWarningKind {
  if (displayAction?.action.state === "paused_for_warning") return "warning-card";
  if (displayAction?.action.state === "active_paused_for_warning") return "paused-run";
  return "none";
}

export function PausedRunWarning({
  action,
  engagementId,
  onContinued,
}: {
  action: PersistedAction;
  engagementId: string;
  onContinued: (action: PersistedAction) => void;
}) {
  const titleId = useId();
  const continueLateWarning = useContinueLateWarningActionMutation();
  const reasonCodes = warningReasonCodes(action);
  const snapshot = latestActionSnapshot(action);
  const pendingEventId = action.action.pendingWarning?.pendingEventId ?? null;
  const staleWarning =
    continueLateWarning.error instanceof EngagementMutationClientError &&
    continueLateWarning.error.code === "invalid_run_transition";
  const mutationError = continueLateWarning.isError
    ? engagementMutationMessage(continueLateWarning.error)
    : undefined;

  const submitContinue = () => {
    if (continueLateWarning.isPending || pendingEventId === null) return;
    continueLateWarning.mutate(
      {
        engagementId,
        actionId: action.action.actionId,
        expectedRevision: action.revision,
        snapshotVersion: snapshot.version,
        snapshotBinding: snapshot.binding,
        pendingEventId,
      },
      { onSuccess: onContinued },
    );
  };

  return (
    <section
      role="alert"
      aria-labelledby={titleId}
      className="mt-4 rounded-[10px] border border-warning/35 bg-warning/10 px-3 py-3"
    >
      <h3 id={titleId} className="m-0 text-[13px] font-semibold text-foreground">
        Action paused for warning
      </h3>
      <p className="mt-1 mb-0 text-[12px] leading-5 text-foreground">
        {warningReasonSummary(reasonCodes)}
      </p>
      <p className="mt-2 mb-0 text-[12px] leading-5 text-muted-foreground">
        One acknowledgment covers the whole action. The run resumes from this warning.
      </p>
      {staleWarning ? (
        <p className="mt-2 mb-0 text-[13px] text-destructive" role="alert">
          This warning is no longer current. The latest warning appears here automatically.
        </p>
      ) : mutationError !== undefined ? (
        <p className="mt-2 mb-0 text-[13px] text-destructive" role="alert">
          {mutationError}
        </p>
      ) : null}
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button
          disabled={continueLateWarning.isPending || pendingEventId === null}
          onClick={submitContinue}
          type="button"
        >
          {continueLateWarning.isPending ? "Continuing" : "Continue"}
        </Button>
      </div>
      <details className="mt-2">
        <summary className="min-h-11 cursor-pointer text-[12px] font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-8">
          Normalized targets
        </summary>
        <ul className="mt-1 mb-0 list-none p-0">
          {snapshot.canonicalTargets.map((target) => (
            <li key={formatCanonicalTarget(target)} className="font-mono text-[12px] text-foreground">
              {formatCanonicalTarget(target)}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

export type LauncherRequest =
  | {
      readonly kind: "probe";
      readonly origin: string;
      readonly sourceLabel: string;
    }
  | {
      readonly kind: "ffuf";
      readonly origin: string;
      readonly scopeHint?: string | undefined;
      readonly sourceLabel: string;
    };

export interface ActionLauncherProps {
  readonly archived: boolean;
  readonly engagementId: string;
  readonly onClose: () => void;
  readonly request: LauncherRequest;
}

interface LauncherDetail {
  readonly expectedActiveScopeRevisionId: string | null;
  readonly expectedEngagementRevision: number;
  readonly scopeRules: readonly SavedScopeRule[];
}

export function ActionLauncher({ archived, engagementId, onClose, request }: ActionLauncherProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const detail = useEngagementDetailQuery(engagementId);
  const hasDetail = detail.data !== undefined;

  useEffect(() => {
    const root = dialogRef.current;
    if (root === null) return;
    const focusable = root.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    (focusable ?? root).focus({ preventScroll: true });
  }, []);

  const attemptClose = () => {
    if (pending) return;
    if (dirty && !confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  };

  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      attemptClose();
      return;
    }
    if (event.key !== "Tab") return;
    const root = dialogRef.current;
    if (!root) return;
    const focusable = Array.from(
      root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((node) => !node.hasAttribute("disabled"));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const title = request.kind === "probe" ? "Probe web" : "Discover paths";

  return createPortal(
    <div className="fixed inset-0 z-[70] grid place-items-center p-6">
      <button
        type="button"
        aria-label="Dismiss launcher"
        className="absolute inset-0 bg-black/62"
        onClick={attemptClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-labelledby={titleId}
        className="relative max-h-full w-full max-w-[520px] overflow-y-auto rounded-[10px] border border-border bg-popover p-5 text-popover-foreground shadow-[0_24px_64px_rgba(0,0,0,0.6)]"
        data-keybinding-capture=""
        onKeyDown={onDialogKeyDown}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 id={titleId} className="m-0 text-[15px] font-semibold tracking-[-0.02em]">
              {title}
            </h2>
            <p className="mt-1 mb-0 truncate font-mono text-[12px] text-muted-foreground" title={request.origin}>
              From {request.sourceLabel}
            </p>
          </div>
          <Button type="button" variant="quiet" className="h-7 px-2 text-[12px]" onClick={attemptClose}>
            Close
          </Button>
        </div>
        {confirmDiscard ? (
          <div className="mt-3 rounded-md border border-border px-3 py-2" role="alert">
            <p className="m-0 text-[12px] text-foreground">Discard unsaved launcher input?</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>
                Discard
              </Button>
              <Button type="button" variant="quiet" onClick={() => setConfirmDiscard(false)}>
                Keep editing
              </Button>
            </div>
          </div>
        ) : null}
        <div className="mt-4">
          {!hasDetail && detail.isFetching ? (
            <LoadingRegion label="Loading launcher" className="space-y-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </LoadingRegion>
          ) : null}
          {!hasDetail && detail.isError ? (
            <p className="m-0 text-[12px] leading-5 text-muted-foreground">
              The launcher is unavailable until engagement detail loads.
            </p>
          ) : null}
          {hasDetail ? (
            request.kind === "probe" ? (
              <ProbeLauncherForm
                archived={archived}
                detail={{
                  expectedActiveScopeRevisionId: detail.data.activeScopeRevision?.id ?? null,
                  expectedEngagementRevision: detail.data.engagement.revision,
                  scopeRules: detail.data.activeScopeRevision?.rules ?? [],
                }}
                engagementId={engagementId}
                origin={request.origin}
                sourceLabel={request.sourceLabel}
                onClose={onClose}
                onDirtyChange={setDirty}
                onPendingChange={setPending}
              />
            ) : (
              <FfufLauncherForm
                archived={archived}
                detail={{
                  expectedActiveScopeRevisionId: detail.data.activeScopeRevision?.id ?? null,
                  expectedEngagementRevision: detail.data.engagement.revision,
                  scopeRules: detail.data.activeScopeRevision?.rules ?? [],
                }}
                engagementId={engagementId}
                origin={request.origin}
                scopeHint={request.scopeHint}
                sourceLabel={request.sourceLabel}
                onClose={onClose}
                onDirtyChange={setDirty}
                onPendingChange={setPending}
              />
            )
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface LaunchedActionState {
  readonly displayAction: PersistedAction | undefined;
  readonly mutationError: string | undefined;
  readonly plannedTargets: readonly string[];
  readonly result: PersistedAction | undefined;
  readonly showPollError: boolean;
  readonly stoppable: boolean;
  readonly stopping: boolean;
  readonly terminal: boolean;
  readonly trackedActionId: string | undefined;
  readonly onRefresh: () => void;
  readonly onStop: () => void;
  readonly trackLaunched: (action: PersistedAction) => void;
}

function useLauncherActionState(
  engagementId: string,
  launchError: string | undefined,
  cancelError: string | undefined,
  cancelAction: ReturnType<typeof useCancelActionMutation>,
): LaunchedActionState & { setPlannedTargets: (targets: string[]) => void; setResultNone: () => void } {
  const queryClient = useQueryClient();
  const [plannedTargets, setPlannedTargets] = useState<string[]>([]);
  const [result, setResult] = useState<PersistedAction | undefined>(undefined);
  const [trackedActionId, setTrackedActionId] = useState<string | undefined>(undefined);
  const hasInvalidatedRef = useRef<string | null>(null);

  const polledActionQuery = useQuery({
    ...persistedActionQueryOptions(engagementId, trackedActionId),
    refetchInterval: (query) => {
      const data = query.state.data as PersistedAction | undefined;
      if (data !== undefined && isTerminalActionState(data.action.state)) return false;
      if (query.state.error) return false;
      return 1500;
    },
    retry: false,
  });

  const displayAction = trackedActionId !== undefined ? (polledActionQuery.data ?? result) : result;

  useEffect(() => {
    hasInvalidatedRef.current = null;
  }, [trackedActionId]);

  useEffect(() => {
    const action = polledActionQuery.data;
    if (action === undefined || trackedActionId === undefined) return;
    if (action.action.actionId !== trackedActionId) return;
    if (!isTerminalActionState(action.action.state)) return;
    if (hasInvalidatedRef.current === trackedActionId) return;
    hasInvalidatedRef.current = trackedActionId;
    void queryClient.invalidateQueries({ queryKey: engagementServicesQueryKey(engagementId) });
    void queryClient.invalidateQueries({ queryKey: engagementHttpProbesQueryKey(engagementId) });
    void queryClient.invalidateQueries({ queryKey: engagementFfufResultsQueryKey(engagementId) });
    void queryClient.invalidateQueries({ queryKey: reportQueryKey(engagementId) });
  }, [engagementId, polledActionQuery.data, queryClient, trackedActionId]);

  const trackLaunched = (action: PersistedAction) => {
    setResult(action);
    setTrackedActionId(
      isTerminalActionState(action.action.state) ? undefined : action.action.actionId,
    );
  };

  const terminal = displayAction !== undefined && isTerminalActionState(displayAction.action.state);
  const stoppable =
    displayAction !== undefined &&
    !terminal &&
    (displayAction.action.state === "queued" || displayAction.action.state === "active_paused_for_warning");

  return {
    displayAction,
    mutationError: launchError ?? cancelError,
    plannedTargets,
    result,
    showPollError:
      trackedActionId !== undefined && polledActionQuery.isError && !polledActionQuery.isFetching,
    stoppable,
    stopping: cancelAction.isPending,
    terminal,
    trackedActionId,
    onRefresh: () => void polledActionQuery.refetch(),
    onStop: () => {
      if (displayAction === undefined || cancelAction.isPending) return;
      cancelAction.mutate(
        {
          engagementId,
          actionId: displayAction.action.actionId,
          expectedRevision: displayAction.revision,
        },
        { onSuccess: trackLaunched },
      );
    },
    trackLaunched,
    setPlannedTargets,
    setResultNone: () => {
      setResult(undefined);
      setTrackedActionId(undefined);
    },
  };
}

function ProbeLauncherForm({
  archived,
  detail,
  engagementId,
  onClose,
  onDirtyChange,
  onPendingChange,
  origin,
  sourceLabel,
}: {
  archived: boolean;
  detail: LauncherDetail;
  engagementId: string;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onPendingChange: (pending: boolean) => void;
  origin: string;
  sourceLabel: string;
}) {
  const initialScheme = parseOriginScheme(origin);
  const [scheme, setScheme] = useState<OriginScheme>(initialScheme);
  const [originText, setOriginText] = useState(origin);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const createAction = useCreateActionMutation();
  const cancelAction = useCancelActionMutation();
  const launcher = useLauncherActionState(
    engagementId,
    createAction.isError ? engagementMutationMessage(createAction.error) : undefined,
    cancelAction.isError ? engagementMutationMessage(cancelAction.error) : undefined,
    cancelAction,
  );

  const dirty = withOriginScheme(originText.trim(), scheme) !== origin;
  useEffect(() => {
    onDirtyChange(dirty && launcher.result === undefined);
  }, [dirty, launcher.result, onDirtyChange]);
  useEffect(() => {
    onPendingChange(createAction.isPending);
  }, [createAction.isPending, onPendingChange]);

  const canLaunch = !archived && !createAction.isPending;
  const changeScheme = (next: OriginScheme) => {
    setScheme(next);
    setOriginText((current) =>
      current.trim() === "" ? current : withOriginScheme(current, next),
    );
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canLaunch) return;
    createAction.reset();
    cancelAction.reset();
    launcher.setResultNone();
    const nextOrigin = withOriginScheme(originText.trim(), scheme);
    if (!isHttpUrl(nextOrigin) || splitOriginUrl(nextOrigin) === undefined) {
      setFieldError("Origin must be an http or https URL.");
      return;
    }
    setFieldError(undefined);
    launcher.setPlannedTargets([nextOrigin]);
    createAction.mutate(
      {
        engagementId,
        expectedEngagementRevision: detail.expectedEngagementRevision,
        expectedActiveScopeRevisionId: detail.expectedActiveScopeRevisionId,
        targets: [nextOrigin],
        declaredPorts: null,
      },
      { onSuccess: launcher.trackLaunched },
    );
  };

  return (
    <div>
      {archived ? (
        <p className="mb-3 text-[12px] leading-5 text-muted-foreground">
          This engagement is archived. Probes cannot be launched.
        </p>
      ) : null}
      <form className="grid gap-3" onSubmit={submit}>
        <div className="grid gap-3 sm:grid-cols-[120px_minmax(0,1fr)]">
          <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="launcher-scheme">
            <span>Scheme</span>
            <select
              id="launcher-scheme"
              value={scheme}
              autoFocus
              disabled={archived || createAction.isPending}
              className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 font-mono text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => changeScheme(event.target.value === "https" ? "https" : "http")}
            >
              <option value="http">http</option>
              <option value="https">https</option>
            </select>
          </label>
          <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="launcher-origin">
            <span>Origin</span>
            <input
              id="launcher-origin"
              value={originText}
              autoComplete="off"
              spellCheck={false}
              disabled={archived || createAction.isPending}
              className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 font-mono text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => setOriginText(event.target.value)}
            />
          </label>
        </div>
        {fieldError !== undefined ? (
          <p className="m-0 text-[13px] text-destructive" role="alert">
            {fieldError}
          </p>
        ) : null}
        {launcher.mutationError !== undefined ? (
          <p className="m-0 text-[13px] text-destructive" role="alert">
            {launcher.mutationError}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!canLaunch}>
            {createAction.isPending ? "Probing" : "Probe web"}
          </Button>
          {launcher.stoppable ? (
            <Button
              type="button"
              variant="quiet"
              disabled={launcher.stopping}
              onClick={launcher.onStop}
            >
              {launcher.stopping ? "Stopping" : "Stop"}
            </Button>
          ) : null}
        </div>
      </form>
      <LauncherResult
        engagementId={engagementId}
        expectedEngagementRevision={detail.expectedEngagementRevision}
        launcher={launcher}
        onClose={onClose}
        scopeRules={detail.scopeRules}
        sourceLabel={sourceLabel}
      />
    </div>
  );
}

function parseLauncherPositiveInt(
  raw: string,
  field: string,
): { ok: true; value: number } | { ok: false; message: string } {
  const value = Number.parseInt(raw.trim(), 10);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value) || value < 1) {
    return { ok: false, message: `${field} must be a positive integer.` };
  }
  return { ok: true, value };
}

function parseLauncherMatchCodes(raw: string): { ok: true; value: number[] } | { ok: false; message: string } {
  const values: number[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const code = Number.parseInt(trimmed, 10);
    if (!/^\d+$/.test(trimmed) || code < 100 || code > 599) {
      return { ok: false, message: `Match code "${trimmed}" must be an integer in 100-599.` };
    }
    values.push(code);
  }
  if (values.length === 0) return { ok: false, message: "Match codes need at least one status code." };
  return { ok: true, value: values };
}

function FfufLauncherForm({
  archived,
  detail,
  engagementId,
  onClose,
  onDirtyChange,
  onPendingChange,
  origin,
  scopeHint,
  sourceLabel,
}: {
  archived: boolean;
  detail: LauncherDetail;
  engagementId: string;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onPendingChange: (pending: boolean) => void;
  origin: string;
  scopeHint: string | undefined;
  sourceLabel: string;
}) {
  const formId = useId();
  const storedDefaults = useRunnerSettingsQuery().data;
  const [originText, setOriginText] = useState(origin);
  const [wordlistPath, setWordlistPath] = useState("");
  const [rate, setRate] = useState(String(FFUF_RATE_DEFAULT));
  const [threads, setThreads] = useState(String(FFUF_THREADS_DEFAULT));
  const [timeoutSeconds, setTimeoutSeconds] = useState(String(FFUF_TIMEOUT_SECONDS_DEFAULT));
  const [maxTimeSeconds, setMaxTimeSeconds] = useState(String(FFUF_MAX_TIME_SECONDS_DEFAULT));
  const [matchCodes, setMatchCodes] = useState(FFUF_DEFAULT_MATCH_CODES.join(", "));
  const editedFields = useRef(new Set<string>());
  const launch = useLaunchFfufDiscoveryMutation();
  const cancelAction = useCancelActionMutation();
  const launcher = useLauncherActionState(
    engagementId,
    launch.isError ? engagementMutationMessage(launch.error) : undefined,
    cancelAction.isError ? engagementMutationMessage(cancelAction.error) : undefined,
    cancelAction,
  );

  useEffect(() => {
    if (storedDefaults === undefined) return;
    if (!editedFields.current.has("wordlistPath")) setWordlistPath(storedDefaults.ffufWordlistPath);
    if (!editedFields.current.has("rate")) setRate(String(storedDefaults.ffufRate));
    if (!editedFields.current.has("threads")) setThreads(String(storedDefaults.ffufThreads));
    if (!editedFields.current.has("timeoutSeconds"))
      setTimeoutSeconds(String(storedDefaults.ffufTimeoutSeconds));
    if (!editedFields.current.has("maxTimeSeconds"))
      setMaxTimeSeconds(String(storedDefaults.ffufMaxTimeSeconds));
  }, [storedDefaults]);

  const initialWordlist = storedDefaults?.ffufWordlistPath ?? "";
  const initialRate = String(storedDefaults?.ffufRate ?? FFUF_RATE_DEFAULT);
  const initialThreads = String(storedDefaults?.ffufThreads ?? FFUF_THREADS_DEFAULT);
  const initialTimeout = String(storedDefaults?.ffufTimeoutSeconds ?? FFUF_TIMEOUT_SECONDS_DEFAULT);
  const initialMaxTime = String(storedDefaults?.ffufMaxTimeSeconds ?? FFUF_MAX_TIME_SECONDS_DEFAULT);
  const initialCodes = FFUF_DEFAULT_MATCH_CODES.join(", ");

  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const dirty =
    originText !== origin ||
    wordlistPath !== initialWordlist ||
    rate !== initialRate ||
    threads !== initialThreads ||
    timeoutSeconds !== initialTimeout ||
    maxTimeSeconds !== initialMaxTime ||
    matchCodes !== initialCodes;
  useEffect(() => {
    onDirtyChange(dirty && launcher.result === undefined);
  }, [dirty, launcher.result, onDirtyChange]);
  useEffect(() => {
    onPendingChange(launch.isPending);
  }, [launch.isPending, onPendingChange]);

  const markEdited = (field: string, nextValue: string, initialValue: string) => {
    if (nextValue !== initialValue) {
      editedFields.current.add(field);
    } else {
      editedFields.current.delete(field);
    }
  };
  const canLaunch = !archived && !launch.isPending;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canLaunch) return;
    launch.reset();
    cancelAction.reset();
    launcher.setResultNone();
    if (!isHttpUrl(originText.trim()) || splitOriginUrl(originText.trim()) === undefined) {
      setFieldError("Origin must be an http or https URL.");
      return;
    }
    if (wordlistPath.trim().length === 0) {
      setFieldError("Wordlist path must be an absolute managed path.");
      return;
    }
    const parsed = {
      rate: parseLauncherPositiveInt(rate, "Rate"),
      threads: parseLauncherPositiveInt(threads, "Threads"),
      timeout: parseLauncherPositiveInt(timeoutSeconds, "Timeout"),
      maxTime: parseLauncherPositiveInt(maxTimeSeconds, "Duration"),
      codes: parseLauncherMatchCodes(matchCodes),
    };
    const failure = [parsed.rate, parsed.threads, parsed.timeout, parsed.maxTime, parsed.codes].find(
      (entry) => !entry.ok,
    );
    if (failure !== undefined && !failure.ok) {
      setFieldError(failure.message);
      return;
    }
    if (!parsed.rate.ok || !parsed.threads.ok || !parsed.timeout.ok || !parsed.maxTime.ok || !parsed.codes.ok) {
      return;
    }
    setFieldError(undefined);
    const target = originText.trim();
    launcher.setPlannedTargets([target]);
    launch.mutate(
      {
        engagementId,
        expectedEngagementRevision: detail.expectedEngagementRevision,
        expectedActiveScopeRevisionId: detail.expectedActiveScopeRevisionId,
        origin: target,
        wordlistPath: wordlistPath.trim(),
        rate: parsed.rate.value,
        threads: parsed.threads.value,
        timeoutSeconds: parsed.timeout.value,
        maxTimeSeconds: parsed.maxTime.value,
        matchStatusCodes: parsed.codes.value,
      },
      { onSuccess: launcher.trackLaunched },
    );
  };

  const numericFields = [
    { id: `${formId}-rate`, label: "Rate", value: rate, onChange: setRate, field: "rate" },
    { id: `${formId}-threads`, label: "Threads", value: threads, onChange: setThreads, field: "threads" },
    { id: `${formId}-timeout`, label: "Timeout s", value: timeoutSeconds, onChange: setTimeoutSeconds, field: "timeoutSeconds" },
    { id: `${formId}-maxtime`, label: "Duration s", value: maxTimeSeconds, onChange: setMaxTimeSeconds, field: "maxTimeSeconds" },
  ];

  return (
    <div>
      {archived ? (
        <p className="mb-3 text-[12px] leading-5 text-muted-foreground">
          This engagement is archived. Discoveries cannot be launched.
        </p>
      ) : null}
      {scopeHint !== undefined ? (
        <p className="mt-0 mb-3 truncate font-mono text-[11px] text-muted-foreground" title={scopeHint}>
          Scoped from {scopeHint}
        </p>
      ) : null}
      <form className="grid gap-3" onSubmit={submit}>
        <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={`${formId}-origin`}>
          <span>Origin</span>
          <input
            id={`${formId}-origin`}
            value={originText}
            autoComplete="off"
            autoFocus
            spellCheck={false}
            disabled={archived || launch.isPending}
            className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 font-mono text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) => setOriginText(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={`${formId}-wordlist`}>
          <span>Wordlist path</span>
          <input
            id={`${formId}-wordlist`}
            value={wordlistPath}
            autoComplete="off"
            spellCheck={false}
            placeholder="/wordlists/smoke.txt"
            disabled={archived || launch.isPending}
            className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 font-mono text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) => {
              markEdited("wordlistPath", event.target.value, initialWordlist);
              setWordlistPath(event.target.value);
            }}
          />
        </label>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {numericFields.map((field) => (
            <label key={field.id} className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={field.id}>
              <span>{field.label}</span>
              <input
                id={field.id}
                value={field.value}
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                disabled={archived || launch.isPending}
                className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 font-mono text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) => {
                  let initialVal = "";
                  switch (field.field) {
                    case "rate": initialVal = initialRate; break;
                    case "threads": initialVal = initialThreads; break;
                    case "timeoutSeconds": initialVal = initialTimeout; break;
                    case "maxTimeSeconds": initialVal = initialMaxTime; break;
                  }
                  markEdited(field.field, event.target.value, initialVal);
                  field.onChange(event.target.value);
                }}
              />
            </label>
          ))}
        </div>
        <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={`${formId}-codes`}>
          <span>Match status codes</span>
          <input
            id={`${formId}-codes`}
            value={matchCodes}
            autoComplete="off"
            spellCheck={false}
            disabled={archived || launch.isPending}
            className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 font-mono text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) => {
              markEdited("matchCodes", event.target.value, initialCodes);
              setMatchCodes(event.target.value);
            }}
          />
        </label>
        {fieldError !== undefined ? (
          <p className="m-0 text-[13px] text-destructive" role="alert">
            {fieldError}
          </p>
        ) : null}
        {launcher.mutationError !== undefined ? (
          <p className="m-0 text-[13px] text-destructive" role="alert">
            {launcher.mutationError}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!canLaunch}>
            {launch.isPending ? "Launching" : "Launch discovery"}
          </Button>
          {launcher.stoppable ? (
            <Button
              type="button"
              variant="quiet"
              disabled={launcher.stopping}
              onClick={launcher.onStop}
            >
              {launcher.stopping ? "Stopping" : "Stop"}
            </Button>
          ) : null}
        </div>
      </form>
      <LauncherResult
        engagementId={engagementId}
        expectedEngagementRevision={detail.expectedEngagementRevision}
        launcher={launcher}
        onClose={onClose}
        scopeRules={detail.scopeRules}
        sourceLabel={sourceLabel}
      />
    </div>
  );
}

function LauncherResult({
  engagementId,
  expectedEngagementRevision,
  launcher,
  onClose,
  scopeRules,
  sourceLabel,
}: {
  engagementId: string;
  expectedEngagementRevision: number;
  launcher: LaunchedActionState;
  onClose: () => void;
  scopeRules: readonly SavedScopeRule[];
  sourceLabel: string;
}) {
  const warningKind = launcherWarningKind(launcher.displayAction);
  if (warningKind === "warning-card" && launcher.displayAction !== undefined) {
    return (
      <WarningCard
        action={launcher.displayAction}
        engagementId={engagementId}
        expectedEngagementRevision={expectedEngagementRevision}
        plannedTargets={launcher.plannedTargets}
        scopeRules={scopeRules}
        onAddScopeAndRun={launcher.trackLaunched}
        onCancel={launcher.trackLaunched}
        onContinue={launcher.trackLaunched}
      />
    );
  }
  if (warningKind === "paused-run" && launcher.displayAction !== undefined) {
    return (
      <PausedRunWarning
        action={launcher.displayAction}
        engagementId={engagementId}
        onContinued={launcher.trackLaunched}
      />
    );
  }
  if (launcher.displayAction === undefined) return null;
  return (
    <div className="mt-4">
      <p className="mb-0 text-[13px] text-foreground" role="status">
        {actionLifecycleStatusCopy(launcher.displayAction.action)}{" "}
        <span className="font-mono text-[12px] text-muted-foreground">
          {launcher.displayAction.action.actionId}
        </span>
      </p>
      {launcher.showPollError ? (
        <p className="mt-2 mb-0 flex items-center gap-2 text-[12px] text-muted-foreground" role="status">
          <span>Status update failed.</span>
          <Button
            type="button"
            variant="quiet"
            className="h-7 px-2 text-[12px]"
            onClick={launcher.onRefresh}
          >
            Refresh
          </Button>
        </p>
      ) : null}
      <div className="mt-3">
        <Button type="button" variant="secondary" onClick={onClose}>
          Back to {sourceLabel}
        </Button>
      </div>
    </div>
  );
}
