import type { HttpProbeProjected } from "@stonehush/contracts";
import { LoadingRegion, RecoverableError, Skeleton, StaleDataState } from "@stonehush/ui";

import { formatEngagementTimestamp } from "./format.js";
import { isProbeRowSelected, probeSelectionKey, type ExtraRowActions } from "./inspector.js";
import { useEngagementHttpProbesQuery } from "./query.js";

function sortProbes(probes: readonly HttpProbeProjected[]): HttpProbeProjected[] {
  return [...probes].sort((left, right) => {
    const url = left.url.localeCompare(right.url);
    if (url !== 0) return url;
    return left.artifactId.localeCompare(right.artifactId);
  });
}

function formatStatus(probe: HttpProbeProjected): string {
  if (probe.status === null) return probe.error ?? "no status";
  return String(probe.status);
}

export function EngagementHttpProbesSection({
  engagementId,
  extraRowActions,
  onSelectKey,
  selectedKey,
}: {
  engagementId: string;
  extraRowActions?: ExtraRowActions | undefined;
  onSelectKey?: ((key: string) => void) | undefined;
  selectedKey?: string | undefined;
}) {
  const probesQuery = useEngagementHttpProbesQuery(engagementId);
  const hasData = probesQuery.data !== undefined;
  const retry = () => void probesQuery.refetch();

  if (!hasData && probesQuery.isFetching) return <ProbesLoadingState />;
  if (!hasData && probesQuery.isError) {
    return (
      <RecoverableError
        title="Probe results unavailable"
        description="The HTTP probe results could not be loaded from the local control plane."
        onRetry={retry}
      />
    );
  }
  if (!hasData) return <ProbesLoadingState />;

  const probes = sortProbes(probesQuery.data);

  const body =
    probes.length === 0 ? (
      <section aria-label="HTTP probes" className="overflow-hidden rounded-[10px] border border-border bg-card">
        <div className="flex min-h-10 items-center justify-between border-b border-border px-3">
          <h2 className="m-0 text-[13px] font-semibold">HTTP probes</h2>
          <span className="hidden text-[11px] text-muted-foreground sm:inline">Probed URLs with raw evidence</span>
        </div>
        <div className="px-4 py-8 text-center">
          <h3 className="m-0 text-[13px] font-semibold">No probes yet</h3>
          <p className="mx-auto mt-2 mb-0 max-w-md text-[13px] leading-5 text-muted-foreground">
            Queue an action with an http(s) URL target to probe it. Status, title, headers, and
            redirect hops are recorded with byte-identical raw evidence.
          </p>
        </div>
      </section>
    ) : (
      <section aria-label="HTTP probes" className="overflow-hidden rounded-[10px] border border-border bg-card">
        <div className="flex min-h-10 items-center justify-between border-b border-border px-3">
          <h2 className="m-0 text-[13px] font-semibold">HTTP probes</h2>
          <span className="hidden text-[11px] text-muted-foreground sm:inline">
            {probes.length} probed URL{probes.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="divide-y divide-border">
          <div className="hidden grid-cols-[minmax(0,1.6fr)_72px_minmax(0,1fr)_150px] gap-3 bg-muted/40 px-3 py-2 text-[11px] font-medium tracking-[0.04em] text-muted-foreground uppercase md:grid">
            <span>URL</span>
            <span>Status</span>
            <span>Title</span>
            <span>Observed</span>
          </div>
          {probes.map((probe) => (
            <ProbeRow
              key={`${probe.url}:${probe.artifactId}`}
              engagementId={engagementId}
              extraRowActions={extraRowActions}
              onSelectKey={onSelectKey}
              probe={probe}
              selected={isProbeRowSelected(probe, selectedKey, probes)}
            />
          ))}
        </div>
      </section>
    );

  if (probesQuery.isError) {
    return (
      <StaleDataState
        title="Showing the last successful probe results"
        description="The latest refresh failed. Existing probe results are still available."
        onRetry={retry}
      >
        {body}
      </StaleDataState>
    );
  }

  return body;
}

function ProbesLoadingState() {
  return (
    <section aria-label="HTTP probes" className="overflow-hidden rounded-[10px] border border-border bg-card">
      <div className="flex min-h-10 items-center justify-between border-b border-border px-3">
        <h2 className="m-0 text-[13px] font-semibold">HTTP probes</h2>
      </div>
      <LoadingRegion label="Loading probe results" className="space-y-3 p-3">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </LoadingRegion>
    </section>
  );
}

function ProbeRow({
  engagementId,
  extraRowActions,
  onSelectKey,
  probe,
  selected,
}: {
  engagementId: string;
  extraRowActions: ExtraRowActions | undefined;
  onSelectKey: ((key: string) => void) | undefined;
  probe: HttpProbeProjected;
  selected: boolean;
}) {
  const observedLabel = formatEngagementTimestamp(probe.observedAt);
  const downloadHref = `/api/v1/engagements/${engagementId}/artifacts/${probe.artifactId}/content`;
  const key = probeSelectionKey(probe.url, probe.artifactId);

  return (
    <div className="border-b border-border last:border-b-0" data-surface-row={key}>
      <div className="grid gap-2 px-3 py-3 md:grid-cols-[minmax(0,1.6fr)_72px_minmax(0,1fr)_150px] md:items-start md:gap-3">
        <div className="min-w-0">
          {onSelectKey === undefined ? (
            <div className="truncate font-mono text-[13px] font-semibold tracking-[-0.02em]" title={probe.url}>
              {probe.url}
            </div>
          ) : (
            <button
              type="button"
              aria-current={selected ? "true" : undefined}
              onClick={() => onSelectKey(key)}
              className={`block w-full truncate text-left font-mono text-[13px] font-semibold tracking-[-0.02em] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring ${
                selected ? "text-primary underline" : ""
              }`}
              title={probe.url}
            >
              {probe.url}
            </button>
          )}
          <div className="truncate font-mono text-[11px] text-muted-foreground" title={probe.finalUrl}>
            {probe.finalUrl === probe.url ? `${probe.hops.length} hop${probe.hops.length === 1 ? "" : "s"}` : `-> ${probe.finalUrl}`}
          </div>
        </div>
        <div className="font-mono text-[13px] font-medium">{formatStatus(probe)}</div>
        <div className="min-w-0">
          <div className="truncate text-[13px]" title={probe.title ?? undefined}>
            {probe.title ?? "-"}
          </div>
          <div className="truncate font-mono text-[11px] text-muted-foreground" title={probe.selectedHeaders.server ?? undefined}>
            {probe.selectedHeaders.server ?? probe.selectedHeaders.contentType ?? "-"}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="truncate font-mono text-[11px] text-muted-foreground" title={observedLabel}>
            {observedLabel}
          </span>
          <span className="flex flex-wrap items-center gap-x-3">
            <a
              className="inline-flex min-h-11 items-center text-[12px] font-semibold text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring md:min-h-8"
              href={downloadHref}
              download
            >
              Raw evidence
            </a>
            {onSelectKey === undefined ? null : (
              <button
                type="button"
                aria-label={`Inspect ${probe.url}`}
                onClick={() => onSelectKey(key)}
                className="inline-flex min-h-11 items-center text-[12px] font-semibold text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring md:min-h-8"
              >
                Inspect
              </button>
            )}
          </span>
          {extraRowActions === undefined ? null : (
            <span>{extraRowActions({ kind: "probe", key, title: probe.url, target: probe.url })}</span>
          )}
        </div>
      </div>
      <details className="group mx-3 mb-3 rounded-md border border-border">
        <summary className="flex min-h-8 cursor-pointer list-none items-center justify-between px-2.5 text-[11px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span>Redirect chain and provenance</span>
          <span className="text-muted-foreground group-open:hidden">Show</span>
          <span className="hidden text-muted-foreground group-open:inline">Hide</span>
        </summary>
        <div className="border-t border-border px-2.5 py-2">
          {probe.hops.length === 0 ? (
            <p className="m-0 text-[11px] text-muted-foreground">No hops recorded: {probe.error ?? "fetch failed"}.</p>
          ) : (
            <ol className="m-0 grid list-none gap-1 p-0">
              {probe.hops.map((hop, index) => (
                <li key={`${hop.url}:${String(index)}`} className="truncate font-mono text-[11px]" title={hop.location ?? hop.url}>
                  <span className="text-muted-foreground">{index + 1}.</span> {hop.status} {hop.url}
                  {hop.location !== null ? ` -> ${hop.location}` : ""}
                </li>
              ))}
            </ol>
          )}
          <dl className="mt-2 grid gap-2 sm:grid-cols-2">
            <ProvenanceField term="runId" value={probe.runId} mono />
            <ProvenanceField term="artifactId" value={probe.artifactId} mono />
            <ProvenanceField term="artifactDigest" value={probe.artifactDigest} mono breakAll />
            <ProvenanceField term="parserVersion" value={probe.parserVersion} />
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
