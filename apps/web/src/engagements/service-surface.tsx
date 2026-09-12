import type {
  FfufProjected,
  HttpProbeProjected,
  NmapProjectedService,
} from "@stonehush/contracts";
import { Button, LoadingRegion, RecoverableError, Skeleton, StaleDataState } from "@stonehush/ui";
import { useRef, useState } from "react";

import { formatEngagementTimestamp } from "./format.js";
import {
  ActionLauncher,
  SurfaceInspector,
  decodeSurfaceSelection,
  defaultSchemeForPort,
  focusSurfaceRow,
  isPathRowSelected,
  isProbeRowSelected,
  isServiceRowSelected,
  isWebServiceCandidate,
  pathInspectorRecord,
  pathSelectionKey,
  probeInspectorRecord,
  probeSelectionKey,
  restoreSurfacePosition,
  serviceInspectorRecord,
  serviceSelectionKey,
  splitOriginUrl,
  withOriginScheme,
  type BelowOrigin,
  type ExtraRowActions,
  type InspectorRecord,
  type LauncherRequest,
  type OriginScheme,
} from "./inspector.js";
import {
  useEngagementFfufResultsQuery,
  useEngagementHttpProbesQuery,
  useEngagementServicesQuery,
} from "./query.js";
import { copyTextToClipboard } from "./report-query.js";

function deriveServiceStats(services: readonly NmapProjectedService[]) {
  const hostCount = new Set(services.map((service) => service.address)).size;
  const artifactCount = new Set(services.map((service) => service.artifactId)).size;
  let latestObservedAt: string | undefined;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const service of services) {
    const time = Date.parse(service.observedAt);
    const parsed = Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
    if (
      latestObservedAt === undefined ||
      parsed > latestTime ||
      (parsed === latestTime && service.observedAt > latestObservedAt)
    ) {
      latestTime = parsed;
      latestObservedAt = service.observedAt;
    }
  }
  return { serviceCount: services.length, hostCount, artifactCount, latestObservedAt };
}

function formatPrimaryIdentity(service: NmapProjectedService): string {
  if (service.product !== null) {
    return service.version !== null ? `${service.product} ${service.version}` : service.product;
  }
  if (service.serviceName !== null) return service.serviceName;
  return "unknown";
}

function artifactContentUrl(engagementId: string, artifactId: string): string {
  return `/api/v1/engagements/${encodeURIComponent(engagementId)}/artifacts/${encodeURIComponent(artifactId)}/content`;
}

function sortServices(services: readonly NmapProjectedService[]): NmapProjectedService[] {
  return [...services].sort((left, right) => {
    const address = left.address.localeCompare(right.address, "en", { numeric: true });
    if (address !== 0) return address;
    return left.port - right.port;
  });
}

export interface EngagementServicesSectionProps {
  readonly archived?: boolean | undefined;
  readonly belowOrigin?: BelowOrigin | undefined;
  readonly engagementId: string;
  readonly extraRowActions?: ExtraRowActions | undefined;
  readonly onAskAbout?: ((target: string) => void) | undefined;
  readonly onOpenNotes?: (() => void) | undefined;
  readonly onSelectKey?: ((key: string | undefined) => void) | undefined;
  readonly onSelectTarget?: ((target: string) => void) | undefined;
  readonly onStartLead?: ((target: string) => void) | undefined;
  readonly selectedKey?: string | undefined;
  readonly selectedTarget?: string | undefined;
}

export function EngagementServicesSection({
  archived = false,
  belowOrigin,
  engagementId,
  extraRowActions,
  onAskAbout,
  onOpenNotes,
  onSelectKey,
  onSelectTarget,
  onStartLead,
  selectedKey,
  selectedTarget,
}: EngagementServicesSectionProps) {
  const servicesQuery = useEngagementServicesQuery(engagementId);
  const probesQuery = useEngagementHttpProbesQuery(engagementId);
  const ffufQuery = useEngagementFfufResultsQuery(engagementId);
  const [internalTarget, setInternalTarget] = useState<string | undefined>(undefined);
  const [internalKey, setInternalKey] = useState<string | undefined>(undefined);
  const [schemes, setSchemes] = useState<Readonly<Record<string, OriginScheme>>>({});
  const [launcher, setLauncher] = useState<LauncherRequest | null>(null);
  const scrollRestoreRef = useRef(0);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const returnKeyRef = useRef<string | undefined>(undefined);

  const effectiveTarget = selectedTarget ?? internalTarget;
  const effectiveKey = selectedKey ?? internalKey;
  const selectTarget = onSelectTarget ?? setInternalTarget;
  const selectKey = onSelectKey ?? setInternalKey;

  const hasData = servicesQuery.data !== undefined;
  const retry = () => void servicesQuery.refetch();

  if (!hasData && servicesQuery.isFetching) return <ServicesLoadingState />;
  if (!hasData && servicesQuery.isError) {
    return (
      <RecoverableError
        title="Attack surface unavailable"
        description="The attack surface could not be loaded from the local control plane."
        onRetry={retry}
      />
    );
  }
  if (!hasData) return <ServicesLoadingState />;

  const services = servicesQuery.data;
  const probes = probesQuery.data;
  const ffufResults = ffufQuery.data;
  const stats = deriveServiceStats(services);
  const sorted = sortServices(services);
  const latestLabel =
    stats.latestObservedAt !== undefined ? formatEngagementTimestamp(stats.latestObservedAt) : "-";

  const targets = collectTargets(sorted, probes, ffufResults);
  const activeTarget =
    effectiveTarget !== undefined && targets.some((entry) => entry.target === effectiveTarget)
      ? effectiveTarget
      : targets[0]?.target;

  const openSelection = (key: string) => {
    scrollRestoreRef.current = window.scrollY;
    returnKeyRef.current = key;
    selectKey(key);
  };
  const closeInspector = () => {
    const key = returnKeyRef.current;
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    selectKey(undefined);
    const savedY = scrollRestoreRef.current;
    returnKeyRef.current = undefined;
    requestAnimationFrame(() => {
      restoreSurfacePosition(savedY, undefined);
      if (active !== null && active !== document.body && document.contains(active)) {
        active.focus({ preventScroll: true });
      } else if (key !== undefined) {
        focusSurfaceRow(key);
      }
    });
  };
  const openLauncher = (request: LauncherRequest, sourceKey: string | undefined) => {
    scrollRestoreRef.current = window.scrollY;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    returnKeyRef.current = sourceKey;
    setLauncher(request);
  };
  const closeLauncher = () => {
    const key = returnKeyRef.current;
    const returnElement = returnFocusRef.current;
    setLauncher(null);
    returnFocusRef.current = null;
    const savedY = scrollRestoreRef.current;
    requestAnimationFrame(() => {
      restoreSurfacePosition(savedY, undefined);
      if (returnElement !== null && document.contains(returnElement)) {
        returnElement.focus({ preventScroll: true });
      } else if (key !== undefined) {
        focusSurfaceRow(key);
      }
    });
  };

  const selection = decodeSurfaceSelection(effectiveKey);
  const inspector =
    selection === undefined ? null : (
      <SurfaceInspectorLoader
        engagementId={engagementId}
        ffufQuery={{
          data: ffufResults,
          isFetching: ffufQuery.isFetching,
          isError: ffufQuery.isError,
          refetch: () => void ffufQuery.refetch(),
        }}
        probesQuery={{
          data: probes,
          isFetching: probesQuery.isFetching,
          isError: probesQuery.isError,
          refetch: () => void probesQuery.refetch(),
        }}
        selectionKey={selection.key}
        services={sorted}
        onAskAbout={onAskAbout}
        onClose={closeInspector}
        onDiscoverOrigin={(origin, scopeHint) =>
          openLauncher(
            {
              kind: "ffuf",
              origin,
              ...(scopeHint === undefined ? {} : { scopeHint }),
              sourceLabel: selection.key,
            },
            selection.key,
          )
        }
        onOpenNotes={onOpenNotes}
        onProbeOrigin={(origin) =>
          openLauncher({ kind: "probe", origin, sourceLabel: selection.key }, selection.key)
        }
        onStartLead={onStartLead}
      />
    );

  const statBar = (
    <section aria-label="Engagement totals" className="overflow-hidden rounded-[10px] border border-border bg-card">
      <div className="grid grid-cols-2 divide-x divide-y divide-border sm:grid-cols-4 sm:divide-y-0">
        <div className="px-3 py-3 sm:px-4">
          <div className="text-[22px] font-semibold tracking-[-0.04em]">{stats.serviceCount}</div>
          <div className="mt-1 text-[11px] tracking-[0.08em] text-muted-foreground uppercase">Services</div>
        </div>
        <div className="px-3 py-3 sm:px-4">
          <div className="text-[22px] font-semibold tracking-[-0.04em]">{stats.hostCount}</div>
          <div className="mt-1 text-[11px] tracking-[0.08em] text-muted-foreground uppercase">Hosts</div>
        </div>
        <div className="px-3 py-3 sm:px-4">
          <div className="text-[22px] font-semibold tracking-[-0.04em]">{stats.artifactCount}</div>
          <div className="mt-1 text-[11px] tracking-[0.08em] text-muted-foreground uppercase">Evidence artifacts</div>
        </div>
        <div className="px-3 py-3 sm:px-4">
          <div className="truncate text-[12px] font-medium tracking-[-0.02em]" title={latestLabel}>
            {latestLabel}
          </div>
          <div className="mt-1 text-[11px] tracking-[0.08em] text-muted-foreground uppercase">Latest observation</div>
        </div>
      </div>
    </section>
  );

  const attackSurface =
    sorted.length === 0 ? (
      <section aria-label="Attack surface" className="overflow-hidden rounded-[10px] border border-border bg-card">
        <div className="flex min-h-10 items-center justify-between border-b border-border px-3">
          <h2 className="m-0 text-[13px] font-semibold">Attack surface</h2>
          <span className="hidden text-[11px] text-muted-foreground sm:inline">Projected Nmap services</span>
        </div>
        <div className="px-4 py-8 text-center">
          <h3 className="m-0 text-[13px] font-semibold">No services yet</h3>
          <p className="mx-auto mt-2 mb-0 max-w-md text-[13px] leading-5 text-muted-foreground">
            No services have been observed for this engagement. Complete an Nmap run to populate the attack
            surface.
          </p>
        </div>
        <ObservedOriginsWithoutServices
          belowOrigin={belowOrigin}
          engagementId={engagementId}
          extraRowActions={extraRowActions}
          ffufResults={ffufResults}
          onAskAbout={onAskAbout}
          onOpenLauncher={openLauncher}
          onSelectKey={openSelection}
          onStartLead={onStartLead}
          probes={probes}
          selectedKey={effectiveKey}
        />
      </section>
    ) : (
      <section aria-label="Attack surface" className="overflow-hidden rounded-[10px] border border-border bg-card">
        <div className="flex min-h-10 items-center justify-between border-b border-border px-3">
          <h2 className="m-0 text-[13px] font-semibold">Attack surface</h2>
          <span className="hidden text-[11px] text-muted-foreground sm:inline">Targets with services and origins</span>
        </div>
        <TargetSelector
          activeTarget={activeTarget}
          onSelectTarget={(target) => selectTarget(target)}
          targets={targets}
        />
        {activeTarget === undefined ? null : (
          <TargetGroup
            belowOrigin={belowOrigin}
            engagementId={engagementId}
            extraRowActions={extraRowActions}
            ffufResults={ffufResults}
            onAskAbout={onAskAbout}
            onOpenLauncher={openLauncher}
            onSelectKey={openSelection}
            onStartLead={onStartLead}
            probes={probes}
            schemes={schemes}
            selectedKey={effectiveKey}
            services={sorted.filter((service) => service.address === activeTarget)}
            setSchemes={setSchemes}
            target={activeTarget}
          />
        )}
      </section>
    );

  const isWebError = probesQuery.isError || ffufQuery.isError;
  const retryWeb = () => {
    if (probesQuery.isError) void probesQuery.refetch();
    if (ffufQuery.isError) void ffufQuery.refetch();
  };
  const webStatusBanner = isWebError ? (
    <div className="rounded-[10px] border border-warning/35 bg-warning/10 p-3" role="status">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 text-[12px] text-warning">
          {probesQuery.isError && ffufQuery.isError
            ? "Web probes and path discovery results could not be loaded. Showing services only."
            : probesQuery.isError
              ? "Web probes could not be loaded. Showing services only."
              : "Path discovery results could not be loaded. Showing services only."}
        </p>
        <Button type="button" variant="secondary" className="h-7 px-2 text-[12px]" onClick={retryWeb}>
          Retry web observations
        </Button>
      </div>
    </div>
  ) : null;

  const body = (
    <div className={inspector === null ? "grid gap-4" : "grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start"}>
      <div className="grid min-w-0 gap-4">
        {statBar}
        {webStatusBanner}
        {attackSurface}
      </div>
      {inspector}
    </div>
  );

  const retryAll = () => {
    if (servicesQuery.isError) void servicesQuery.refetch();
    if (probesQuery.isError) void probesQuery.refetch();
    if (ffufQuery.isError) void ffufQuery.refetch();
  };
  const hasFailedQuery = servicesQuery.isError || probesQuery.isError || ffufQuery.isError;
  const staleDescription = servicesQuery.isError
    ? "The latest refresh failed. Existing services are still available."
    : "The latest web refresh failed. Existing web observations are marked where they failed to load.";
  const content = hasFailedQuery ? (
    <StaleDataState
      title="Showing the last successful attack surface"
      description={staleDescription}
      onRetry={retryAll}
    >
      {body}
    </StaleDataState>
  ) : (
    body
  );

  return (
    <div>
      {content}
      {launcher === null ? null : (
        <ActionLauncher
          archived={archived}
          engagementId={engagementId}
          onClose={closeLauncher}
          request={launcher}
        />
      )}
    </div>
  );
}

interface TargetSummary {
  readonly hostname: string | null;
  readonly pathCount: number;
  readonly originCount: number;
  readonly serviceCount: number;
  readonly target: string;
}

function canonicalTargetForHost(
  host: string,
  services: readonly NmapProjectedService[],
): string {
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
  const addressMatch = services.find(
    (s) => s.address.replace(/^\[|\]$/g, "").toLowerCase() === normalized,
  );
  if (addressMatch !== undefined) {
    return addressMatch.address;
  }
  const matchingAddresses = new Set<string>();
  for (const s of services) {
    if (s.hostname !== null && s.hostname.replace(/^\[|\]$/g, "").toLowerCase() === normalized) {
      matchingAddresses.add(s.address);
    }
  }
  if (matchingAddresses.size === 1) {
    return Array.from(matchingAddresses)[0]!;
  }
  return host;
}

function collectTargets(
  services: readonly NmapProjectedService[],
  probes: readonly HttpProbeProjected[] | undefined,
  ffufResults: readonly FfufProjected[] | undefined,
): TargetSummary[] {
  const byTarget = new Map<string, { hostname: string | null; services: number; origins: Set<string>; paths: number }>();
  const ensure = (target: string) => {
    const existing = byTarget.get(target);
    if (existing !== undefined) return existing;
    const created = { hostname: null as string | null, services: 0, origins: new Set<string>(), paths: 0 };
    byTarget.set(target, created);
    return created;
  };
  for (const service of services) {
    const entry = ensure(service.address);
    entry.services += 1;
    if (entry.hostname === null && service.hostname !== null) entry.hostname = service.hostname;
    if (isWebServiceCandidate(service)) {
      entry.origins.add(`${service.address}:${String(service.port)}`);
    }
  }
  if (probes !== undefined) {
    for (const probe of probes) {
      const parts = splitOriginUrl(probe.url);
      if (parts === undefined) continue;
      const canonicalTarget = canonicalTargetForHost(parts.host, services);
      const entry = ensure(canonicalTarget);
      entry.origins.add(`${parts.host}:${String(parts.port)}`);
    }
  }
  if (ffufResults !== undefined) {
    for (const result of ffufResults) {
      const parts = splitOriginUrl(result.url);
      if (parts === undefined) continue;
      const canonicalTarget = canonicalTargetForHost(parts.host, services);
      const entry = ensure(canonicalTarget);
      entry.origins.add(`${parts.host}:${String(parts.port)}`);
      entry.paths += 1;
    }
  }
  return [...byTarget.entries()]
    .map(([target, entry]) => ({
      target,
      hostname: entry.hostname,
      serviceCount: entry.services,
      originCount: entry.origins.size,
      pathCount: entry.paths,
    }))
    .sort((left, right) => left.target.localeCompare(right.target, "en", { numeric: true }));
}

function TargetSelector({
  activeTarget,
  onSelectTarget,
  targets,
}: {
  activeTarget: string | undefined;
  onSelectTarget: (target: string) => void;
  targets: readonly TargetSummary[];
}) {
  if (targets.length === 0) return null;
  return (
    <div className="border-b border-border px-3 py-2" role="group" aria-label="Targets">
      <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
        {targets.map((entry) => {
          const active = entry.target === activeTarget;
          return (
            <li key={entry.target}>
              <button
                type="button"
                aria-current={active ? "true" : undefined}
                onClick={() => onSelectTarget(entry.target)}
                className={`inline-flex min-h-8 items-center gap-2 rounded-md border px-2.5 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  active
                    ? "border-foreground/40 bg-accent font-semibold text-foreground"
                    : "border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                }`}
              >
                <span className="font-mono" title={entry.hostname ?? entry.target}>
                  {entry.target}
                </span>
                <span className="text-[11px]">
                  {entry.serviceCount} svc · {entry.originCount} web · {entry.pathCount} paths
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function TargetGroup({
  belowOrigin,
  engagementId,
  extraRowActions,
  ffufResults,
  onAskAbout,
  onOpenLauncher,
  onSelectKey,
  onStartLead,
  probes,
  schemes,
  selectedKey,
  services,
  setSchemes,
  target,
}: {
  belowOrigin: BelowOrigin | undefined;
  engagementId: string;
  extraRowActions: ExtraRowActions | undefined;
  ffufResults: readonly FfufProjected[] | undefined;
  onAskAbout: ((target: string) => void) | undefined;
  onOpenLauncher: (request: LauncherRequest, sourceKey: string | undefined) => void;
  onSelectKey: ((key: string) => void) | undefined;
  onStartLead: ((target: string) => void) | undefined;
  probes: readonly HttpProbeProjected[] | undefined;
  schemes: Readonly<Record<string, OriginScheme>>;
  selectedKey: string | undefined;
  services: readonly NmapProjectedService[];
  setSchemes: (next: Readonly<Record<string, OriginScheme>>) => void;
  target: string;
}) {
  const hostname = services.find((service) => service.hostname !== null)?.hostname ?? null;
  return (
    <div>
      <div className="flex min-h-10 flex-wrap items-baseline justify-between gap-x-3 px-3 pt-2">
        <h3 className="m-0 truncate font-mono text-[13px] font-semibold" title={hostname ?? target}>
          {target}
        </h3>
        <span className="text-[11px] text-muted-foreground">
          {hostname ?? "no hostname"} · {services.length} service{services.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="hidden grid-cols-[minmax(0,1.4fr)_96px_minmax(0,1.2fr)_130px] gap-3 bg-muted/40 px-3 py-2 text-[11px] font-medium tracking-[0.04em] text-muted-foreground uppercase md:grid">
        <span>Address</span>
        <span>Port</span>
        <span>Service</span>
        <span>Observed</span>
      </div>
      <div className="divide-y divide-border">
        {services.map((service) => (
          <div key={`${service.address}:${String(service.port)}:${service.protocol}:${service.artifactId}`}>
            <ServiceRow
              engagementId={engagementId}
              extraRowActions={extraRowActions}
              onSelect={onSelectKey}
              selected={isServiceRowSelected(service, selectedKey, services)}
              service={service}
            />
            {isWebServiceCandidate(service) ? (
              <OriginBlock
                belowOrigin={belowOrigin}
                engagementId={engagementId}
                extraRowActions={extraRowActions}
                host={service.address}
                onAskAbout={onAskAbout}
                onOpenLauncher={onOpenLauncher}
                onSelectKey={onSelectKey}
                onStartLead={onStartLead}
                paths={(ffufResults ?? []).filter((result) => {
                  const parts = splitOriginUrl(result.url);
                  return (
                    parts !== undefined &&
                    parts.port === service.port &&
                    hostMatchesService(parts.host, service)
                  );
                })}
                port={service.port}
                probes={(probes ?? []).filter((probe) => probeMatchesService(probe, service))}
                scheme={
                  schemes[`${service.address}:${String(service.port)}`] ??
                  defaultSchemeForService(service, probes, ffufResults)
                }
                selectedKey={selectedKey}
                setScheme={(scheme) =>
                  setSchemes({
                    ...schemes,
                    [`${service.address}:${String(service.port)}`]: scheme,
                  })
                }
                target={target}
              />
            ) : null}
          </div>
        ))}
      </div>
      <UnmatchedOrigins
        belowOrigin={belowOrigin}
        engagementId={engagementId}
        extraRowActions={extraRowActions}
        ffufResults={ffufResults}
        onAskAbout={onAskAbout}
        onOpenLauncher={onOpenLauncher}
        onSelectKey={onSelectKey}
        onStartLead={onStartLead}
        probes={probes}
        schemes={schemes}
        selectedKey={selectedKey}
        services={services}
        setSchemes={setSchemes}
        target={target}
      />
    </div>
  );
}

function hostMatchesService(host: string, service: NmapProjectedService): boolean {
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
  const serviceAddr = service.address.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === serviceAddr) return true;
  return service.hostname !== null && normalized === service.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function probeMatchesService(probe: HttpProbeProjected, service: NmapProjectedService): boolean {
  const parts = splitOriginUrl(probe.url);
  if (parts === undefined || parts.port !== service.port) return false;
  return hostMatchesService(parts.host, service);
}

function defaultSchemeForService(
  service: NmapProjectedService,
  probes: readonly HttpProbeProjected[] | undefined,
  ffufResults: readonly FfufProjected[] | undefined,
): OriginScheme {
  const matched = (probes ?? []).filter((probe) => probeMatchesService(probe, service));
  if (matched.length === 1) {
    const scheme = splitOriginUrl(matched[0]?.url ?? "")?.scheme;
    if (scheme !== undefined) return scheme;
  }
  const matchedPaths = (ffufResults ?? []).filter((result) => {
    const parts = splitOriginUrl(result.url);
    return (
      parts !== undefined &&
      parts.port === service.port &&
      hostMatchesService(parts.host, service)
    );
  });
  const pathScheme = unanimousObservedScheme(matchedPaths.map((result) => result.url));
  if (pathScheme !== undefined) return pathScheme;
  return defaultSchemeForPort(service.port);
}

// Observed scheme shared by probes and path discoveries. Returns a scheme
// only when at least one URL parses and every parsed URL agrees; mixed
// observations fall back to the port heuristic instead of silently picking
// one endpoint as the target.
function unanimousObservedScheme(urls: readonly string[]): OriginScheme | undefined {
  let seen: OriginScheme | undefined;
  let parsed = 0;
  for (const url of urls) {
    const scheme = splitOriginUrl(url)?.scheme;
    if (scheme === undefined) continue;
    parsed += 1;
    if (seen === undefined) {
      seen = scheme;
    } else if (seen !== scheme) {
      return undefined;
    }
  }
  return parsed === 0 ? undefined : seen;
}

// Default scheme for an unmatched observed origin. An explicit operator
// override wins, then any observed probe scheme, then the unanimous observed
// path scheme, then the port heuristic. Probe priority is unchanged so mixed
// probe/path observations keep their existing target.
function defaultSchemeForUnmatchedEntry(
  entry: { host: string; port: number; probes: readonly HttpProbeProjected[]; paths: readonly FfufProjected[] },
  schemes: Readonly<Record<string, OriginScheme>>,
): OriginScheme {
  const key = `${entry.host}:${String(entry.port)}`;
  return (
    schemes[key] ??
    entry.probes.map((probe) => splitOriginUrl(probe.url)?.scheme).find((scheme) => scheme !== undefined) ??
    unanimousObservedScheme(entry.paths.map((result) => result.url)) ??
    defaultSchemeForPort(entry.port)
  );
}

function UnmatchedOrigins({
  belowOrigin,
  engagementId,
  extraRowActions,
  ffufResults,
  onAskAbout,
  onOpenLauncher,
  onSelectKey,
  onStartLead,
  probes,
  schemes,
  selectedKey,
  services,
  setSchemes,
  target,
}: {
  belowOrigin: BelowOrigin | undefined;
  engagementId: string;
  extraRowActions: ExtraRowActions | undefined;
  ffufResults: readonly FfufProjected[] | undefined;
  onAskAbout: ((target: string) => void) | undefined;
  onOpenLauncher: (request: LauncherRequest, sourceKey: string | undefined) => void;
  onSelectKey: ((key: string) => void) | undefined;
  onStartLead: ((target: string) => void) | undefined;
  probes: readonly HttpProbeProjected[] | undefined;
  schemes: Readonly<Record<string, OriginScheme>>;
  selectedKey: string | undefined;
  services: readonly NmapProjectedService[];
  setSchemes: (next: Readonly<Record<string, OriginScheme>>) => void;
  target: string;
}) {
  const groups = new Map<string, { host: string; port: number; probes: HttpProbeProjected[]; paths: FfufProjected[] }>();
  for (const probe of probes ?? []) {
    const parts = splitOriginUrl(probe.url);
    if (parts === undefined) continue;
    const probeTarget = canonicalTargetForHost(parts.host, services);
    if (probeTarget !== target && probeTarget.toLowerCase() !== target.toLowerCase()) continue;
    if (
      services.some((service) => isWebServiceCandidate(service) && probeMatchesService(probe, service))
    )
      continue;
    const key = `${parts.host}:${String(parts.port)}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { host: parts.host, port: parts.port, probes: [probe], paths: [] });
    } else {
      existing.probes.push(probe);
    }
  }
  for (const result of ffufResults ?? []) {
    const parts = splitOriginUrl(result.url);
    if (parts === undefined) continue;
    const pathTarget = canonicalTargetForHost(parts.host, services);
    if (pathTarget !== target && pathTarget.toLowerCase() !== target.toLowerCase()) continue;
    if (
      services.some(
        (service) =>
          isWebServiceCandidate(service) &&
          parts.port === service.port &&
          hostMatchesService(parts.host, service),
      )
    )
      continue;
    const key = `${parts.host}:${String(parts.port)}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { host: parts.host, port: parts.port, probes: [], paths: [result] });
    } else {
      existing.paths.push(result);
    }
  }
  const entries = [...groups.values()].sort((left, right) => left.port - right.port);
  if (entries.length === 0) return null;
  return (
    <div className="border-t border-border px-3 py-2">
      <p className="m-0 mb-2 text-[11px] text-muted-foreground">
        Observed web origins without a projected service
      </p>
      <div className="grid gap-2">
        {entries.map((entry) => {
          const key = `${entry.host}:${String(entry.port)}`;
          const scheme = defaultSchemeForUnmatchedEntry(entry, schemes);
          return (
            <OriginBlock
              key={key}
              belowOrigin={belowOrigin}
              engagementId={engagementId}
              extraRowActions={extraRowActions}
              host={entry.host}
              onAskAbout={onAskAbout}
              onOpenLauncher={onOpenLauncher}
              onSelectKey={onSelectKey}
              onStartLead={onStartLead}
              paths={entry.paths}
              port={entry.port}
              probes={entry.probes}
              scheme={scheme}
              selectedKey={selectedKey}
              setScheme={(next) => setSchemes({ ...schemes, [key]: next })}
              target={target}
            />
          );
        })}
      </div>
    </div>
  );
}

function ObservedOriginsWithoutServices({
  belowOrigin,
  engagementId,
  extraRowActions,
  ffufResults,
  onAskAbout,
  onOpenLauncher,
  onSelectKey,
  onStartLead,
  probes,
  selectedKey,
}: {
  belowOrigin: BelowOrigin | undefined;
  engagementId: string;
  extraRowActions: ExtraRowActions | undefined;
  ffufResults: readonly FfufProjected[] | undefined;
  onAskAbout: ((target: string) => void) | undefined;
  onOpenLauncher: (request: LauncherRequest, sourceKey: string | undefined) => void;
  onSelectKey: ((key: string) => void) | undefined;
  onStartLead: ((target: string) => void) | undefined;
  probes: readonly HttpProbeProjected[] | undefined;
  selectedKey: string | undefined;
}) {
  const [schemes, setSchemes] = useState<Readonly<Record<string, OriginScheme>>>({});
  const groups = new Map<string, { host: string; port: number; probes: HttpProbeProjected[]; paths: FfufProjected[] }>();
  for (const probe of probes ?? []) {
    const parts = splitOriginUrl(probe.url);
    if (parts === undefined) continue;
    const key = `${parts.host}:${String(parts.port)}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { host: parts.host, port: parts.port, probes: [probe], paths: [] });
    } else {
      existing.probes.push(probe);
    }
  }
  for (const result of ffufResults ?? []) {
    const parts = splitOriginUrl(result.url);
    if (parts === undefined) continue;
    const key = `${parts.host}:${String(parts.port)}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { host: parts.host, port: parts.port, probes: [], paths: [result] });
    } else {
      existing.paths.push(result);
    }
  }
  const entries = [...groups.values()].sort((left, right) => {
    const host = left.host.localeCompare(right.host);
    return host !== 0 ? host : left.port - right.port;
  });
  if (entries.length === 0) return null;
  return (
    <div className="border-t border-border px-3 py-3">
      <h3 className="m-0 text-[13px] font-semibold">Observed origins</h3>
      <p className="mt-1 mb-2 text-[12px] leading-5 text-muted-foreground">
        Probes and discoveries without a projected service yet.
      </p>
      <div className="grid gap-2">
        {entries.map((entry) => {
          const key = `${entry.host}:${String(entry.port)}`;
          const scheme = defaultSchemeForUnmatchedEntry(entry, schemes);
          return (
            <OriginBlock
              key={key}
              belowOrigin={belowOrigin}
              engagementId={engagementId}
              extraRowActions={extraRowActions}
              host={entry.host}
              onAskAbout={onAskAbout}
              onOpenLauncher={onOpenLauncher}
              onSelectKey={onSelectKey}
              onStartLead={onStartLead}
              paths={entry.paths}
              port={entry.port}
              probes={entry.probes}
              scheme={scheme}
              selectedKey={selectedKey}
              setScheme={(next) => setSchemes({ ...schemes, [key]: next })}
              target={entry.host}
            />
          );
        })}
      </div>
    </div>
  );
}

function OriginBlock({
  belowOrigin,
  engagementId,
  extraRowActions,
  host,
  onAskAbout,
  onOpenLauncher,
  onSelectKey,
  onStartLead,
  paths,
  port,
  probes,
  scheme,
  selectedKey,
  setScheme,
  target,
}: {
  belowOrigin: BelowOrigin | undefined;
  engagementId: string;
  extraRowActions: ExtraRowActions | undefined;
  host: string;
  onAskAbout: ((target: string) => void) | undefined;
  onOpenLauncher: (request: LauncherRequest, sourceKey: string | undefined) => void;
  onSelectKey: ((key: string) => void) | undefined;
  onStartLead: ((target: string) => void) | undefined;
  paths: readonly FfufProjected[];
  port: number;
  probes: readonly HttpProbeProjected[];
  scheme: OriginScheme;
  selectedKey: string | undefined;
  setScheme: (scheme: OriginScheme) => void;
  target: string;
}) {
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const origin = withOriginScheme(`${formattedHost}:${String(port)}`, scheme);
  const sortedPaths = [...paths].sort((left, right) => left.url.localeCompare(right.url));
  // Origin-level row identifier so launcher actions carry a defined sourceKey
  // for focus restoration. The container is not a selectable inspector row,
  // so the key uses an origin namespace that never collides with selection keys.
  const rowKey = `origin:${host}:${String(port)}`;
  return (
    <div
      className="mx-3 mb-3 rounded-md border border-border"
      data-surface-origin={origin}
      data-surface-row={rowKey}
    >
      <div className="flex flex-wrap items-center gap-2 px-2.5 py-2">
        <label className="sr-only" htmlFor={`scheme-${host}-${String(port)}`}>
          Scheme for {host}:{String(port)}
        </label>
        <select
          id={`scheme-${host}-${String(port)}`}
          value={scheme}
          onChange={(event) => setScheme(event.target.value === "https" ? "https" : "http")}
          className="h-8 rounded-md border border-input bg-transparent px-1.5 font-mono text-[12px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="http">http</option>
          <option value="https">https</option>
        </select>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-semibold" title={origin}>
          {origin}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-1 gap-y-1 border-t border-border px-2.5 py-1.5">
        <OriginActionButton
          label="Probe web"
          sourceKey={rowKey}
          onClick={(sourceKey) =>
            onOpenLauncher({ kind: "probe", origin, sourceLabel: origin }, sourceKey)
          }
        />
        <a
          className="inline-flex min-h-8 items-center rounded-md px-2 text-[12px] font-semibold text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          href={origin}
          target="_blank"
          rel="noreferrer"
        >
          Open in browser
        </a>
        <OriginActionButton
          label="Discover paths"
          sourceKey={rowKey}
          onClick={(sourceKey) =>
            onOpenLauncher({ kind: "ffuf", origin, sourceLabel: origin }, sourceKey)
          }
        />
        {onStartLead !== undefined ? (
          <button
            type="button"
            onClick={() => onStartLead(origin)}
            className="inline-flex min-h-8 items-center rounded-md px-2 text-[12px] font-medium text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            Start a lead
          </button>
        ) : null}
        {onAskAbout !== undefined ? (
          <button
            type="button"
            onClick={() => onAskAbout(origin)}
            className="inline-flex min-h-8 items-center rounded-md px-2 text-[12px] font-medium text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            Ask about this
          </button>
        ) : null}
      </div>
      {probes.length > 0 ? (
        <ul className="m-0 grid list-none gap-1 border-t border-border p-2.5">
          {probes.map((probe) => (
            <ProbeEnrichmentRow
              key={`${probe.url}:${probe.artifactId}`}
              extraRowActions={extraRowActions}
              onSelectKey={onSelectKey}
              probe={probe}
              selected={isProbeRowSelected(probe, selectedKey, probes)}
            />
          ))}
        </ul>
      ) : (
        <p className="m-0 border-t border-border px-2.5 py-1.5 text-[11px] text-muted-foreground">
          Not probed yet. Probe web records status, title, and headers here.
        </p>
      )}
      {sortedPaths.length > 0 ? (
        <ul className="m-0 grid list-none gap-1 border-t border-border p-2.5">
          {sortedPaths.map((result) => (
            <PathRow
              key={`${result.url}:${result.artifactId}`}
              engagementId={engagementId}
              extraRowActions={extraRowActions}
              onDiscover={(sourceKey) =>
                onOpenLauncher(
                  { kind: "ffuf", origin, scopeHint: result.url, sourceLabel: result.url },
                  sourceKey,
                )
              }
              onSelectKey={onSelectKey}
              result={result}
              selected={isPathRowSelected(result, selectedKey, sortedPaths)}
            />
          ))}
        </ul>
      ) : null}
      {belowOrigin === undefined ? null : (
        <div className="border-t border-border px-2.5 py-1.5">
          {belowOrigin({ origin, target, scheme })}
        </div>
      )}
    </div>
  );
}

function OriginActionButton({
  label,
  onClick,
  sourceKey,
}: {
  label: string;
  onClick: (sourceKey: string | undefined) => void;
  sourceKey?: string | undefined;
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        if (sourceKey !== undefined) {
          onClick(sourceKey);
          return;
        }
        const row = event.currentTarget.closest("[data-surface-row]");
        onClick(
          row instanceof HTMLElement ? (row.getAttribute("data-surface-row") ?? undefined) : undefined,
        );
      }}
      className="inline-flex min-h-8 items-center rounded-md px-2 text-[12px] font-semibold text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
    >
      {label}
    </button>
  );
}

function ProbeEnrichmentRow({
  extraRowActions,
  onSelectKey,
  probe,
  selected,
}: {
  extraRowActions: ExtraRowActions | undefined;
  onSelectKey: ((key: string) => void) | undefined;
  probe: HttpProbeProjected;
  selected: boolean;
}) {
  const key = probeSelectionKey(probe.url, probe.artifactId);
  const status = probe.status === null ? (probe.error ?? "no status") : String(probe.status);
  const label = `${status} · ${probe.title ?? "no title"}`;
  return (
    <li data-surface-row={key} className="min-w-0 rounded-md border border-border px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        {onSelectKey === undefined ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={label}>
            {label}
          </span>
        ) : (
          <button
            type="button"
            aria-current={selected ? "true" : undefined}
            onClick={() => onSelectKey(key)}
            className={`min-w-0 flex-1 truncate text-left font-mono text-[12px] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring ${
              selected ? "font-semibold text-foreground" : "text-foreground"
            }`}
            title={label}
          >
            {label}
          </button>
        )}
        <span className="font-mono text-[11px] text-muted-foreground" title={probe.observedAt}>
          {formatEngagementTimestamp(probe.observedAt)}
        </span>
        {onSelectKey === undefined ? null : (
          <button
            type="button"
            onClick={() => onSelectKey(key)}
            className="inline-flex min-h-8 items-center text-[11px] font-semibold text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            Inspect
          </button>
        )}
      </div>
      {extraRowActions === undefined ? null : (
        <div>{extraRowActions({ kind: "probe", key, title: probe.url, target: probe.url })}</div>
      )}
    </li>
  );
}

function PathRow({
  engagementId,
  extraRowActions,
  onDiscover,
  onSelectKey,
  result,
  selected,
}: {
  engagementId: string;
  extraRowActions: ExtraRowActions | undefined;
  onDiscover: (sourceKey: string | undefined) => void;
  onSelectKey: ((key: string) => void) | undefined;
  result: FfufProjected;
  selected: boolean;
}) {
  const [copied, setCopied] = useState<string | undefined>(undefined);
  const key = pathSelectionKey(result.url, result.artifactId);
  const meta = `${String(result.status)} · ${String(result.length)} bytes`;
  const copyValue = (label: string, value: string) => {
    void copyTextToClipboard(value).then((ok) => {
      if (ok) setCopied(label);
    });
  };
  return (
    <li data-surface-row={key} className="min-w-0 rounded-md border border-border px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        {onSelectKey === undefined ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-semibold" title={result.url}>
            {result.url}
          </span>
        ) : (
          <button
            type="button"
            aria-current={selected ? "true" : undefined}
            onClick={() => onSelectKey(key)}
            className={`min-w-0 flex-1 truncate text-left font-mono text-[12px] font-semibold outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring ${
              selected ? "text-foreground" : "text-foreground"
            }`}
            title={result.url}
          >
            {result.url}
          </button>
        )}
        <span className="font-mono text-[11px] text-muted-foreground" title={meta}>
          {meta}
        </span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
        {onSelectKey === undefined ? null : (
          <button
            type="button"
            onClick={() => onSelectKey(key)}
            className="inline-flex min-h-8 items-center text-[11px] font-semibold text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            Inspect
          </button>
        )}
        <button
          type="button"
          onClick={() => copyValue("copy", result.url)}
          className="inline-flex min-h-8 items-center text-[11px] font-medium text-muted-foreground outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {copied === "copy" ? "Copied" : "Copy"}
        </button>
        <button
          type="button"
          onClick={() => copyValue("note", pathInspectorRecord(result, engagementId).noteReference)}
          className="inline-flex min-h-8 items-center text-[11px] font-medium text-muted-foreground outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {copied === "note" ? "Copied" : "Copy note reference"}
        </button>
        <button
          type="button"
          onClick={(event) => {
            const row = event.currentTarget.closest("[data-surface-row]");
            onDiscover(
              row instanceof HTMLElement
                ? (row.getAttribute("data-surface-row") ?? undefined)
                : undefined,
            );
          }}
          className="inline-flex min-h-8 items-center text-[11px] font-medium text-muted-foreground outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          Discover paths
        </button>
        <a
          className="inline-flex min-h-8 items-center text-[11px] font-medium text-muted-foreground outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          href={artifactContentUrl(engagementId, result.artifactId)}
          download
        >
          Raw evidence
        </a>
      </div>
      {extraRowActions === undefined ? null : (
        <div>{extraRowActions({ kind: "path", key, title: result.url, target: result.url })}</div>
      )}
    </li>
  );
}

function SurfaceInspectorLoader({
  engagementId,
  ffufQuery,
  onAskAbout,
  onClose,
  onDiscoverOrigin,
  onOpenNotes,
  onProbeOrigin,
  onStartLead,
  probesQuery,
  selectionKey,
  services,
}: {
  engagementId: string;
  ffufQuery: { data: readonly FfufProjected[] | undefined; isFetching: boolean; isError?: boolean; refetch?: () => void };
  onAskAbout: ((target: string) => void) | undefined;
  onClose: () => void;
  onDiscoverOrigin: (origin: string, scopeHint: string | undefined) => void;
  onOpenNotes: (() => void) | undefined;
  onProbeOrigin: (origin: string) => void;
  onStartLead: ((target: string) => void) | undefined;
  probesQuery: { data: readonly HttpProbeProjected[] | undefined; isFetching: boolean; isError?: boolean; refetch?: () => void };
  selectionKey: string;
  services: readonly NmapProjectedService[];
}) {
  const selection = decodeSurfaceSelection(selectionKey);
  let record: InspectorRecord | undefined;
  let loading = false;
  let error: string | undefined;
  let onRetry: (() => void) | undefined;
  if (selection?.kind === "service") {
    let service: NmapProjectedService | undefined;
    if (selection.artifactId !== undefined) {
      service = services.find(
        (entry) =>
          serviceSelectionKey(entry.address, entry.port, entry.protocol, entry.artifactId) ===
          selection.key,
      );
    } else {
      const decodedAddr = selection.address?.replace(/^\[|\]$/g, "").toLowerCase();
      const matches = services.filter(
        (entry) =>
          entry.address.replace(/^\[|\]$/g, "").toLowerCase() === decodedAddr &&
          entry.port === selection.port,
      );
      if (matches.length === 1) {
        service = matches[0];
      }
    }
    record = service === undefined ? undefined : serviceInspectorRecord(service, engagementId);
  } else if (selection?.kind === "probe") {
    if (probesQuery.data === undefined) {
      if (probesQuery.isError) {
        error = "Web probes could not be loaded.";
        onRetry = probesQuery.refetch;
      } else {
        loading = probesQuery.isFetching;
      }
    } else {
      let probe: HttpProbeProjected | undefined;
      if (selection.artifactId !== undefined) {
        probe = probesQuery.data.find(
          (entry) => entry.url === selection.url && entry.artifactId === selection.artifactId,
        );
      } else {
        const matches = probesQuery.data.filter((entry) => entry.url === selection.url);
        if (matches.length === 1) {
          probe = matches[0];
        }
      }
      record = probe === undefined ? undefined : probeInspectorRecord(probe, engagementId);
    }
  } else if (selection?.kind === "path") {
    if (ffufQuery.data === undefined) {
      if (ffufQuery.isError) {
        error = "Path discovery results could not be loaded.";
        onRetry = ffufQuery.refetch;
      } else {
        loading = ffufQuery.isFetching;
      }
    } else {
      let result: FfufProjected | undefined;
      if (selection.artifactId !== undefined) {
        result = ffufQuery.data.find(
          (entry) => entry.url === selection.url && entry.artifactId === selection.artifactId,
        );
      } else {
        const matches = ffufQuery.data.filter((entry) => entry.url === selection.url);
        if (matches.length === 1) {
          result = matches[0];
        }
      }
      record = result === undefined ? undefined : pathInspectorRecord(result, engagementId);
    }
  }
  return (
    <SurfaceInspector
      engagementId={engagementId}
      error={error}
      loading={loading}
      onAskAbout={onAskAbout}
      onClose={onClose}
      onDiscoverOrigin={onDiscoverOrigin}
      onOpenNotes={onOpenNotes}
      onProbeOrigin={onProbeOrigin}
      onRetry={onRetry}
      onStartLead={onStartLead}
      record={record}
      selectionKey={selectionKey}
    />
  );
}

function ServicesLoadingState() {
  return (
    <section aria-label="Attack surface" className="overflow-hidden rounded-[10px] border border-border bg-card">
      <div className="flex min-h-10 items-center justify-between border-b border-border px-3">
        <h2 className="m-0 text-[13px] font-semibold">Attack surface</h2>
      </div>
      <LoadingRegion label="Loading attack surface" className="space-y-3 p-3">
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-4">
          <Skeleton className="h-16 rounded-none bg-card" />
          <Skeleton className="h-16 rounded-none bg-card" />
          <Skeleton className="h-16 rounded-none bg-card" />
          <Skeleton className="h-16 rounded-none bg-card" />
        </div>
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </LoadingRegion>
    </section>
  );
}

function ServiceRow({
  engagementId,
  extraRowActions,
  onSelect,
  selected,
  service,
}: {
  engagementId: string;
  extraRowActions: ExtraRowActions | undefined;
  onSelect: ((key: string) => void) | undefined;
  selected: boolean;
  service: NmapProjectedService;
}) {
  const observedLabel = formatEngagementTimestamp(service.observedAt);
  const primary = formatPrimaryIdentity(service);
  const secondary =
    service.serviceName !== null && service.serviceName !== primary ? service.serviceName : null;
  const evidenceUrl = artifactContentUrl(engagementId, service.artifactId);
  const key = serviceSelectionKey(service.address, service.port, service.protocol, service.artifactId);

  const identity =
    onSelect === undefined ? (
      <div className="min-w-0">
        <div className="truncate font-mono text-[13px] font-semibold tracking-[-0.02em]" title={service.address}>
          {service.address}
        </div>
        <div className="truncate font-mono text-[11px] text-muted-foreground" title={service.hostname ?? undefined}>
          {service.hostname ?? "-"}
        </div>
      </div>
    ) : (
      <div className="min-w-0">
        <button
          type="button"
          aria-current={selected ? "true" : undefined}
          onClick={() => onSelect(key)}
          className={`block w-full truncate text-left font-mono text-[13px] font-semibold tracking-[-0.02em] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring ${
            selected ? "text-foreground" : "text-foreground"
          }`}
          title={service.address}
        >
          {service.address}
        </button>
        <div className="truncate font-mono text-[11px] text-muted-foreground" title={service.hostname ?? undefined}>
          {service.hostname ?? "-"}
        </div>
      </div>
    );

  return (
    <div className="border-b border-border last:border-b-0" data-surface-row={key}>
      <div className="grid gap-2 px-3 py-3 md:grid-cols-[minmax(0,1.4fr)_96px_minmax(0,1.2fr)_130px] md:items-start md:gap-3">
        {identity}
        <div className="font-mono text-[13px] font-medium">{`${service.port}/${service.protocol}`}</div>
        <div className="min-w-0">
          <div className="truncate text-[13px]" title={primary}>
            {primary}
          </div>
          {secondary ? (
            <div className="truncate text-[11px] text-muted-foreground" title={secondary}>
              {secondary}
            </div>
          ) : null}
        </div>
        <div className="min-w-0">
          <div className="truncate font-mono text-[11px] text-muted-foreground" title={observedLabel}>
            {observedLabel}
          </div>
          <a
            className="mt-1 inline-block max-w-full truncate text-[11px] font-medium underline underline-offset-2"
            href={evidenceUrl}
            download={`nmap-${service.artifactId}.xml`}
          >
            XML
          </a>
          {onSelect === undefined ? null : (
            <span>
              {" "}
              <button
                type="button"
                onClick={() => onSelect(key)}
                className="mt-1 inline-block max-w-full truncate text-[11px] font-semibold text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                Inspect
              </button>
            </span>
          )}
          {extraRowActions === undefined ? null : (
            <span className="mt-1 block">
              {extraRowActions({
                kind: "service",
                key,
                title: `${service.address}:${String(service.port)}`,
                target: service.address,
              })}
            </span>
          )}
        </div>
      </div>
      <details className="group mx-3 mb-3 rounded-md border border-border">
        <summary className="flex min-h-8 cursor-pointer list-none items-center justify-between px-2.5 text-[11px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span>Provenance</span>
          <span className="text-muted-foreground group-open:hidden">Show</span>
          <span className="hidden text-muted-foreground group-open:inline">Hide</span>
        </summary>
        <div className="border-t border-border px-2.5 py-2">
          <dl className="grid gap-2 sm:grid-cols-2">
            <ProvenanceField term="runId" value={service.runId} mono />
            <ProvenanceField term="artifactId" value={service.artifactId} mono />
            <ProvenanceField term="artifactDigest" value={service.artifactDigest} mono breakAll />
            <ProvenanceField term="parserVersion" value={service.parserVersion} />
          </dl>
        </div>
      </details>
    </div>
  );
}

function ProvenanceField({
  breakAll = false,
  mono = false,
  term,
  value,
}: {
  breakAll?: boolean;
  mono?: boolean;
  term: string;
  value: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] tracking-[0.04em] text-muted-foreground uppercase">{term}</dt>
      <dd
        className={mono ? `mt-1 text-[11px] ${breakAll ? "break-all font-mono" : "truncate font-mono"}` : "mt-1 truncate text-[11px]"}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}
