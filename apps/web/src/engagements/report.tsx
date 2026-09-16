import { useEffect, useMemo, useRef, useState } from "react";

import { engagementReportMarkdown, type Finding, type ReportBundle } from "@stonehush/contracts";
import {
  Button,
  LoadingRegion,
  RecoverableError,
  Skeleton,
  StaleDataState,
} from "@stonehush/ui";

import {
  addOutlineItem,
  createOutline,
  moveOutlineItem,
  outlineSections,
  removeOutlineItem,
  setOutlineTemplate,
  type OutlineTemplate,
  type ReportOutline,
} from "./report-outline.js";
import { buildPrintHtml } from "./report-print.js";
import { reviewOutline } from "./report-review.js";
import {
  buildPortableBundleManifest,
  buildSharingPreview,
  exportSharingMarkdown,
} from "./report-sharing.js";
import {
  captureExportSnapshot,
  describeSnapshotStaleness,
  type ExportSnapshot,
} from "./report-snapshot.js";

import { maskReportBundle } from "./report-mask.js";

import {
  copyTextToClipboard,
  downloadTextFile,
  reportJsonFilename,
  reportMarkdownFilename,
  reportOutlineFilename,
  reportPortableFilename,
  reportPrintFilename,
  useReportQuery,
} from "./report-query.js";

export function EngagementReportSection({
  engagementId,
}: {
  engagementId: string;
}) {
  const report = useReportQuery(engagementId);
  const retry = () => void report.refetch();
  const hasData = report.data !== undefined;
  const body =
    report.data !== undefined ? (
      <ReportBody
        key={engagementId}
        engagementId={engagementId}
        bundle={report.data}
        refreshing={report.isFetching}
      />
    ) : null;

  return (
    <section aria-label="Report" className="mt-5 border-t border-border pt-4">
      <header className="mb-3">
        <h2 className="m-0 text-[13px] font-semibold">Report</h2>
        <p className="mt-1 mb-0 text-[12px] leading-5 text-muted-foreground">
          Read-only bundle from live engagement data. Copy the Markdown or download JSON and
          Markdown.
        </p>
      </header>
      {!hasData && report.isFetching ? (
        <LoadingRegion label="Loading report" className="space-y-3">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-48 w-full" />
        </LoadingRegion>
      ) : null}
      {!hasData && report.isError ? (
        <RecoverableError
          title="Report unavailable"
          description="The report could not be loaded from the local control plane."
          onRetry={retry}
        />
      ) : null}
      {hasData && report.isError ? (
        <StaleDataState
          title="Showing the last successful report"
          description="The latest refresh failed. The existing report is still available."
          onRetry={retry}
        >
          {body}
        </StaleDataState>
      ) : null}
      {hasData && !report.isError ? body : null}
    </section>
  );
}

function isReportEmpty(bundle: ReportBundle): boolean {
  return (
    bundle.findings.length === 0 &&
    bundle.notesMarkdown.length === 0 &&
    bundle.services.total === 0 &&
    bundle.probes.total === 0 &&
    bundle.ffufResults.total === 0 &&
    bundle.evidenceArtifacts.total === 0
  );
}

function ReportBody({
  bundle,
  engagementId,
  refreshing,
}: {
  bundle: ReportBundle;
  engagementId: string;
  refreshing: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  // Session-only sharing default: masked until the operator opts out. It
  // resets when the engagement changes and never persists or deletes data.
  const [masked, setMasked] = useState(true);
  const copyTimer = useRef<number | undefined>(undefined);
  // One derived copy feeds the preview, copy, and both downloads, so every
  // surface shows the same text. The stored bundle stays original.
  const shared = useMemo(() => maskReportBundle(bundle), [bundle]);
  const view = masked ? shared.bundle : bundle;
  const markdown = engagementReportMarkdown(view);

  useEffect(() => {
    return () => {
      if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current);
    };
  }, []);
  useEffect(() => {
    setCopied(false);
    setActionError(undefined);
  }, [engagementId, bundle.generatedAt]);

  const empty = isReportEmpty(bundle);
  const summary = `${bundle.findings.length} findings · ${bundle.services.total} services · ${bundle.probes.total} probes · ${bundle.ffufResults.total} ffuf results · ${bundle.evidenceArtifacts.total} artifacts`;

  // STONE-7 outline state: selected findings/leads/evidence in outline
  // order. Records stay where they are; only this order changes. The
  // parent keys ReportBody by engagement, so this resets per engagement.
  const [outline, setOutline] = useState<ReportOutline>(() => createOutline("ctf-writeup"));
  const [includeAssetLinks, setIncludeAssetLinks] = useState(false);
  const [snapshot, setSnapshot] = useState<ExportSnapshot | null>(null);

  // One sharing derivation feeds its preview and every outline-based
  // download, so the preview always matches the artifact exactly.
  const sharing = useMemo(
    () =>
      buildSharingPreview({
        bundle: view,
        outline,
        options: { includeAssetLinks, maskSecrets: masked },
      }),
    [view, outline, includeAssetLinks, masked],
  );
  const sharingMarkdown = exportSharingMarkdown(sharing);
  const flags = useMemo(
    () =>
      reviewOutline({
        outline,
        findings: bundle.findings,
        evidenceArtifactIds: bundle.evidenceArtifacts.rows.map(
          (artifact) => artifact.artifactId,
        ),
        notesMarkdown: bundle.notesMarkdown,
      }),
    [outline, bundle.findings, bundle.evidenceArtifacts.rows, bundle.notesMarkdown],
  );
  const staleness = describeSnapshotStaleness(snapshot, {
    bundleGeneratedAt: bundle.generatedAt,
    template: outline.template,
    itemKeys: outline.items.map((item) => item.key),
    assetLinks: includeAssetLinks,
    maskSecrets: masked,
  });

  const onCopy = () => {
    setActionError(undefined);
    void copyTextToClipboard(markdown).then((ok) => {
      if (ok) {
        setCopied(true);
        if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current);
        copyTimer.current = window.setTimeout(() => setCopied(false), 2000);
      } else {
        setActionError("Copy failed. Select the preview text manually.");
      }
    });
  };

  const onDownloadJson = () => {
    setActionError(undefined);
    try {
      downloadTextFile(
        reportJsonFilename(engagementId),
        `${JSON.stringify(view, null, 2)}\n`,
        "application/json",
      );
    } catch {
      setActionError("Download failed. Try again.");
    }
  };

  const onDownloadMarkdown = () => {
    setActionError(undefined);
    try {
      downloadTextFile(reportMarkdownFilename(engagementId), markdown, "text/markdown");
    } catch {
      setActionError("Download failed. Try again.");
    }
  };

  const onToggleMask = () => {
    if (copyTimer.current !== undefined) {
      window.clearTimeout(copyTimer.current);
      copyTimer.current = undefined;
    }
    setCopied(false);
    setMasked((value) => !value);
  };

  function recordSnapshot(markdown: string) {
    setSnapshot(
      captureExportSnapshot({
        bundleGeneratedAt: bundle.generatedAt,
        template: outline.template,
        itemKeys: outline.items.map((item) => item.key),
        assetLinks: includeAssetLinks,
        maskSecrets: masked,
        markdown,
      }),
    );
  }

  const onDownloadOutlineMarkdown = () => {
    setActionError(undefined);
    try {
      downloadTextFile(
        reportOutlineFilename(engagementId, outline.template),
        sharingMarkdown,
        "text/markdown",
      );
      recordSnapshot(sharingMarkdown);
    } catch {
      setActionError("Download failed. Try again.");
    }
  };

  const onDownloadPrintHtml = () => {
    setActionError(undefined);
    try {
      const html = buildPrintHtml(
        `Engagement report (${outline.template}): ${bundle.engagement.name}`,
        sharingMarkdown,
      );
      downloadTextFile(reportPrintFilename(engagementId, outline.template), html, "text/html");
      recordSnapshot(sharingMarkdown);
    } catch {
      setActionError("Download failed. Try again.");
    }
  };

  const onDownloadPortableBundle = () => {
    setActionError(undefined);
    try {
      const manifest = buildPortableBundleManifest({
        bundle,
        outline,
        options: { includeAssetLinks },
      });
      downloadTextFile(
        reportPortableFilename(engagementId),
        `${JSON.stringify(manifest, null, 2)}\n`,
        "application/json",
      );
      // No snapshot: the manifest carries no Markdown and ignores masking,
      // so recording the Markdown snapshot here would mark an unchanged
      // manifest stale on the next toggle.
    } catch {
      setActionError("Download failed. Try again.");
    }
  };

  return (
    <div className="grid min-w-0 gap-3">
      <p className="m-0 text-[12px] text-muted-foreground" aria-live="polite">
        {summary}
      </p>
      <p className="m-0 text-[12px] text-muted-foreground">
        {masked
          ? `Sharing view masks notes, findings, and engagement text only (Fields masked: ${shared.maskedFields}). Other report data is unchanged. Heuristic mask; secrets may remain.`
          : "Showing the original stored report, including any secrets it contains. The stored report is unchanged."}
      </p>
      {refreshing ? (
        <p className="m-0 text-[12px] text-muted-foreground" role="status">
          Refreshing report…
        </p>
      ) : null}
      {empty ? (
        <div className="rounded-[10px] border border-border px-4 py-8 text-center">
          <h3 className="m-0 text-[13px] font-semibold">Nothing to report yet</h3>
          <p className="mx-auto mt-2 mb-0 max-w-md text-[13px] leading-5 text-muted-foreground">
            Record a finding, write notes, or complete a discovery run. The preview below
            updates from live engagement data.
          </p>
        </div>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button type="button" onClick={onCopy} disabled={refreshing}>
          {copied ? "Copied" : "Copy Markdown"}
        </Button>
        <Button type="button" variant="secondary" onClick={onDownloadJson} disabled={refreshing}>
          Download JSON
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={refreshing}
          onClick={onDownloadMarkdown}
        >
          Download Markdown
        </Button>
        <Button
          type="button"
          variant="secondary"
          aria-pressed={masked}
          className={masked ? "bg-accent" : ""}
          onClick={onToggleMask}
        >
          {masked ? "Show original" : "Mask secrets"}
        </Button>
      </div>
      {actionError ? (
        <p className="m-0 text-[13px] text-destructive" role="alert">
          {actionError}
        </p>
      ) : null}
      <div className="min-w-0 overflow-hidden rounded-[10px] border border-border">
        <div className="border-b border-border px-3 py-2">
          <h3 className="m-0 text-[13px] font-semibold">Markdown preview</h3>
        </div>
        <pre className="m-0 max-h-96 min-w-0 overflow-auto px-3 py-2.5 font-mono text-[12px] leading-5 whitespace-pre-wrap break-words">
          {markdown}
        </pre>
      </div>
      <OutlineSection
        findings={bundle.findings}
        evidenceArtifactIds={bundle.evidenceArtifacts.rows.map(
          (artifact) => artifact.artifactId,
        )}
        notesAvailable={bundle.notesMarkdown.length > 0}
        outline={outline}
        onOutlineChange={setOutline}
      />
      <ReviewSection flags={flags} />
      <SharingSection
        sharing={sharing}
        sharingMarkdown={sharingMarkdown}
        includeAssetLinks={includeAssetLinks}
        onToggleAssetLinks={() => setIncludeAssetLinks((value) => !value)}
        staleness={staleness}
        refreshing={refreshing}
        onDownloadOutlineMarkdown={onDownloadOutlineMarkdown}
        onDownloadPrintHtml={onDownloadPrintHtml}
        onDownloadPortableBundle={onDownloadPortableBundle}
      />
    </div>
  );
}

function OutlineSection({
  findings,
  evidenceArtifactIds,
  notesAvailable,
  outline,
  onOutlineChange,
}: {
  findings: readonly Finding[];
  evidenceArtifactIds: readonly string[];
  notesAvailable: boolean;
  outline: ReportOutline;
  onOutlineChange: (outline: ReportOutline) => void;
}) {
  function setTemplate(template: OutlineTemplate) {
    onOutlineChange(setOutlineTemplate(outline, template));
  }
  const selectedKeys = new Set(outline.items.map((item) => item.key));
  return (
    <div className="min-w-0 overflow-hidden rounded-[10px] border border-border">
      <div className="border-b border-border px-3 py-2">
        <h3 className="m-0 text-[13px] font-semibold">Report outline</h3>
      </div>
      <div className="grid gap-2 px-3 py-2.5">
        <p className="m-0 text-[12px] text-muted-foreground">
          Select findings, evidence, and notes into an ordered outline. Reordering
          never moves investigation records. Sections: {outlineSections(outline.template).join(" · ")}
        </p>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Outline template">
          <Button
            type="button"
            variant={outline.template === "ctf-writeup" ? "secondary" : "quiet"}
            className="h-7 px-2 text-[12px]"
            aria-pressed={outline.template === "ctf-writeup"}
            onClick={() => setTemplate("ctf-writeup")}
          >
            CTF writeup
          </Button>
          <Button
            type="button"
            variant={outline.template === "assessment" ? "secondary" : "quiet"}
            className="h-7 px-2 text-[12px]"
            aria-pressed={outline.template === "assessment"}
            onClick={() => setTemplate("assessment")}
          >
            Assessment report
          </Button>
        </div>
        {outline.items.length === 0 ? (
          <p className="m-0 text-[12px] text-muted-foreground">
            Outline is empty. Add findings or evidence below.
          </p>
        ) : (
          <ol className="m-0 space-y-1 p-0 pl-4 text-[12px]">
            {outline.items.map((item, index) => (
              <li key={item.key} className="flex min-h-8 flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1">
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {item.kind}
                  </span>{" "}
                  {item.caption}
                </span>
                <Button
                  type="button"
                  variant="quiet"
                  className="h-7 px-2 text-[12px]"
                  disabled={index === 0}
                  onClick={() => onOutlineChange(moveOutlineItem(outline, item.key, index - 1))}
                  aria-label={`Move ${item.caption} up`}
                >
                  Up
                </Button>
                <Button
                  type="button"
                  variant="quiet"
                  className="h-7 px-2 text-[12px]"
                  disabled={index === outline.items.length - 1}
                  onClick={() => onOutlineChange(moveOutlineItem(outline, item.key, index + 1))}
                  aria-label={`Move ${item.caption} down`}
                >
                  Down
                </Button>
                <Button
                  type="button"
                  variant="quiet"
                  className="h-7 px-2 text-[12px]"
                  onClick={() => onOutlineChange(removeOutlineItem(outline, item.key))}
                  aria-label={`Remove ${item.caption}`}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ol>
        )}
        <div>
          <p className="m-0 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Findings
          </p>
          {findings.length === 0 ? (
            <p className="m-0 mt-1 text-[12px] text-muted-foreground">No findings yet.</p>
          ) : (
            <ul className="m-0 mt-1 list-none space-y-1 p-0">
              {findings.map((finding) => {
                const selected = selectedKeys.has(`finding:${finding.id}`);
                return (
                  <li key={finding.id} className="flex min-h-8 items-center gap-2 text-[12px]">
                    <span className="min-w-0 flex-1 truncate" title={finding.title}>
                      {finding.title}
                    </span>
                    <Button
                      type="button"
                      variant="quiet"
                      className="h-7 shrink-0 px-2 text-[12px]"
                      disabled={selected}
                      onClick={() =>
                        onOutlineChange(
                          addOutlineItem(outline, {
                            kind: "finding",
                            refId: finding.id,
                            caption: finding.title,
                          }),
                        )
                      }
                    >
                      {selected ? "Added" : "Add"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div>
          <p className="m-0 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Evidence
          </p>
          {evidenceArtifactIds.length === 0 ? (
            <p className="m-0 mt-1 text-[12px] text-muted-foreground">No evidence artifacts.</p>
          ) : (
            <ul className="m-0 mt-1 list-none space-y-1 p-0">
              {evidenceArtifactIds.map((artifactId) => {
                const selected = selectedKeys.has(`evidence:${artifactId}`);
                return (
                  <li key={artifactId} className="flex min-h-8 items-center gap-2 text-[12px]">
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={artifactId}>
                      {artifactId}
                    </span>
                    <Button
                      type="button"
                      variant="quiet"
                      className="h-7 shrink-0 px-2 text-[12px]"
                      disabled={selected}
                      onClick={() =>
                        onOutlineChange(
                          addOutlineItem(outline, {
                            kind: "evidence",
                            refId: artifactId,
                            caption: artifactId,
                          }),
                        )
                      }
                    >
                      {selected ? "Added" : "Add"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="quiet"
            className="h-7 px-2 text-[12px]"
            disabled={!notesAvailable || selectedKeys.has("note:notes")}
            onClick={() =>
              onOutlineChange(
                addOutlineItem(outline, {
                  kind: "note",
                  refId: "notes",
                  caption: "Engagement notes",
                }),
              )
            }
          >
            {selectedKeys.has("note:notes") ? "Notes added" : "Add notes"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ReviewSection({
  flags,
}: {
  flags: readonly { code: string; itemKey: string | null; detail: string }[];
}) {
  return (
    <div className="min-w-0 overflow-hidden rounded-[10px] border border-border">
      <div className="border-b border-border px-3 py-2">
        <h3 className="m-0 text-[13px] font-semibold">Review</h3>
      </div>
      <div className="grid gap-1 px-3 py-2.5">
        <p className="m-0 text-[12px] text-muted-foreground">
          Finishing aid, not a compliance form. Fix flags before exporting.
        </p>
        {flags.length === 0 ? (
          <p className="m-0 text-[12px] text-muted-foreground" role="status">
            No issues flagged.
          </p>
        ) : (
          <ul className="m-0 list-none space-y-1 p-0">
            {flags.map((flag, index) => (
              <li key={`${flag.code}-${index}`} className="text-[12px]">
                <span className="font-mono text-[11px] text-muted-foreground">
                  {flag.code}
                </span>{" "}
                {flag.detail}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function SharingSection({
  sharing,
  sharingMarkdown,
  includeAssetLinks,
  onToggleAssetLinks,
  staleness,
  refreshing,
  onDownloadOutlineMarkdown,
  onDownloadPrintHtml,
  onDownloadPortableBundle,
}: {
  sharing: { included: readonly { caption: string; filename?: string }[]; excluded: readonly string[]; maskedFields: number };
  sharingMarkdown: string;
  includeAssetLinks: boolean;
  onToggleAssetLinks: () => void;
  staleness: { stale: boolean; reason: string };
  refreshing: boolean;
  onDownloadOutlineMarkdown: () => void;
  onDownloadPrintHtml: () => void;
  onDownloadPortableBundle: () => void;
}) {
  return (
    <div className="min-w-0 overflow-hidden rounded-[10px] border border-border">
      <div className="border-b border-border px-3 py-2">
        <h3 className="m-0 text-[13px] font-semibold">Sharing and export</h3>
      </div>
      <div className="grid gap-2 px-3 py-2.5">
        <p className="m-0 text-[12px] text-muted-foreground" aria-live="polite">
          {staleness.stale ? staleness.reason : `Exports current. ${staleness.reason}`}
        </p>
        <div>
          <p className="m-0 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Included ({sharing.included.length})
          </p>
          {sharing.included.length === 0 ? (
            <p className="m-0 mt-1 text-[12px] text-muted-foreground">
              Nothing selected. Add outline items above.
            </p>
          ) : (
            <ul className="m-0 mt-1 list-none space-y-1 p-0">
              {sharing.included.map((entry, index) => (
                <li key={index} className="text-[12px]">
                  {entry.caption}
                  {entry.filename !== undefined ? (
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {" "}({entry.filename})
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="m-0 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Excluded
          </p>
          <ul className="m-0 mt-1 list-none space-y-1 p-0">
            {sharing.excluded.map((entry, index) => (
              <li key={index} className="text-[12px] text-muted-foreground">
                {entry}
              </li>
            ))}
          </ul>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" disabled={refreshing} onClick={onDownloadOutlineMarkdown}>
            Download outline Markdown
          </Button>
          <Button type="button" variant="secondary" disabled={refreshing} onClick={onDownloadPrintHtml}>
            Download print HTML
          </Button>
          <Button type="button" variant="secondary" disabled={refreshing} onClick={onDownloadPortableBundle}>
            Download portable bundle
          </Button>
          <Button
            type="button"
            variant="quiet"
            className="h-7 px-2 text-[12px]"
            aria-pressed={includeAssetLinks}
            onClick={onToggleAssetLinks}
          >
            {includeAssetLinks ? "Exclude evidence links" : "Include evidence links"}
          </Button>
        </div>
        <div className="min-w-0 overflow-hidden rounded-[10px] border border-border">
          <div className="border-b border-border px-3 py-2">
            <h4 className="m-0 text-[12px] font-semibold">Sharing preview (outline Markdown export text)</h4>
          </div>
          <pre className="m-0 max-h-96 min-w-0 overflow-auto px-3 py-2.5 font-mono text-[12px] leading-5 whitespace-pre-wrap break-words">
            {sharingMarkdown}
          </pre>
        </div>
      </div>
    </div>
  );
}
