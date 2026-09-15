import { useEffect, useMemo, useRef, useState } from "react";

import { engagementReportMarkdown, type ReportBundle } from "@stonehush/contracts";
import {
  Button,
  LoadingRegion,
  RecoverableError,
  Skeleton,
  StaleDataState,
} from "@stonehush/ui";

import { maskReportBundle } from "./report-mask.js";

import {
  copyTextToClipboard,
  downloadTextFile,
  reportJsonFilename,
  reportMarkdownFilename,
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
    </div>
  );
}
