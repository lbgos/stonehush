import { WorkspaceBundleImportResponseSchema } from "@stonehush/contracts";
import { Button } from "@stonehush/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { ENGAGEMENTS_QUERY_KEY } from "./query.js";
import { reportPortableFilename } from "./report-query.js";

// Portable workspace bundle section (stone-9). This is the working file for
// continuing an engagement on another machine, not a client report: it
// carries leads, excerpts, findings, and evidence bytes, and imports as a
// new engagement with fresh ids. Secrets, flags, and client identifiers stay
// out unless the labeled private-copy box is checked.

const IMPORT_ERROR_COPY: Record<string, string> = {
  invalid_request: "That file is not a workspace bundle. Pick an exported bundle file.",
  engagement_not_found: "The source engagement is no longer available.",
  storage_busy: "Storage is busy. Try again.",
  invalid_persisted_data: "The server could not use its stored data for this bundle.",
  unsupported_bundle_version:
    "That bundle uses a newer format this build cannot read. Update first.",
  bundle_digest_mismatch:
    "That bundle failed its integrity check. It may be edited or corrupt.",
  bundle_too_large: "That bundle is larger than the import limit.",
  request_failed: "The bundle request failed. Try again.",
};

function importErrorMessage(code: string): string {
  return IMPORT_ERROR_COPY[code] ?? IMPORT_ERROR_COPY["request_failed"] ?? "The bundle request failed.";
}

export interface WorkspaceBundleImportSummary {
  readonly engagementId: string;
  readonly counts: {
    readonly leads: number;
    readonly attempts: number;
    readonly excerpts: number;
    readonly attachments: number;
    readonly findings: number;
    readonly evidence: number;
    readonly secrets: number;
    readonly objectives: number;
  };
}

export function WorkspaceBundleSection({
  engagementId,
}: {
  engagementId: string;
}) {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [privateCopy, setPrivateCopy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [result, setResult] = useState<WorkspaceBundleImportSummary | undefined>(
    undefined,
  );

  const busy = exporting || importing;

  const onExport = () => {
    if (busy) return;
    setExporting(true);
    setError(undefined);
    setStatus(undefined);
    const url =
      privateCopy ?
        `/api/v1/engagements/${engagementId}/workspace-bundle?privateCopy=true`
      : `/api/v1/engagements/${engagementId}/workspace-bundle`;
    fetch(url)
      .then((response) => {
        if (response.status !== 200) {
          throw new Error("export_failed");
        }
        return response.blob();
      })
      .then((blob) => {
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = reportPortableFilename(engagementId);
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(objectUrl);
        setStatus(
          privateCopy ?
            "Private workspace bundle exported. It contains secrets, flags metadata, and client identifiers. Handle it as sensitive."
            : "Workspace bundle exported. No secrets, flags, or client identifiers are in this file.",
        );
      })
      .catch(() => {
        setError("The bundle export failed. Try again.");
      })
      .finally(() => {
        setExporting(false);
      });
  };

  const onImportFile = (file: File | undefined) => {
    if (file === undefined || busy) return;
    setImporting(true);
    setError(undefined);
    setStatus(undefined);
    setResult(undefined);
    file
      .text()
      .then((text) => {
        let payload: unknown;
        try {
          payload = JSON.parse(text) as unknown;
        } catch {
          throw new Error("invalid_request");
        }
        return fetch("/api/v1/workspace-bundles/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }).then(async (response) => ({ response, payload: (await response.json().catch(() => null)) as unknown }));
      })
      .then(({ response, payload }) => {
        if (response.status !== 201) {
          const code =
            typeof payload === "object" && payload !== null && "code" in payload ?
              String((payload as { code: unknown }).code)
            : "request_failed";
          throw new Error(code);
        }
        const parsed = WorkspaceBundleImportResponseSchema.safeParse(payload);
        if (!parsed.success) throw new Error("request_failed");
        setResult({
          engagementId: parsed.data.engagementId,
          counts: { ...parsed.data.summary },
        });
        setStatus(
          `Imported as a new engagement with ${parsed.data.summary.leads} leads, ${parsed.data.summary.findings} findings, and ${parsed.data.summary.evidence} evidence files.`,
        );
        void queryClient.invalidateQueries({ queryKey: ENGAGEMENTS_QUERY_KEY });
      })
      .catch((failure: unknown) => {
        setError(
          importErrorMessage(failure instanceof Error ? failure.message : "request_failed"),
        );
      })
      .finally(() => {
        setImporting(false);
        if (fileInput.current !== null) fileInput.current.value = "";
      });
  };

  return (
    <section aria-label="Workspace bundle" className="mt-5 border-t border-border pt-4">
      <header className="mb-3">
        <h2 className="m-0 text-[13px] font-semibold">Workspace bundle</h2>
        <p className="mt-1 mb-0 text-[12px] leading-5 text-muted-foreground">
          Working file for continuing this engagement on another machine. Not a
          client report: importing it creates a new engagement with fresh ids.
          Evidence bytes are included and integrity-checked on import.
        </p>
      </header>
      <div className="grid min-w-0 gap-2">
        <label className="flex min-h-11 cursor-pointer items-start gap-2 text-[12px] leading-5">
          <input
            type="checkbox"
            checked={privateCopy}
            disabled={busy}
            onChange={(event) => setPrivateCopy(event.target.checked)}
            className="mt-1 h-4 w-4 shrink-0 accent-primary"
          />
          <span>
            <span className="font-semibold">Private copy:</span> include secrets,
            flag metadata, and client identifiers. Handle the file as sensitive.
            Leave unchecked for the default bundle without them.
          </span>
        </label>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" disabled={busy} onClick={onExport}>
            {exporting ? "Exporting" : "Export workspace bundle"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            {importing ? "Importing" : "Import bundle file"}
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            aria-label="Choose a workspace bundle file"
            onChange={(event) => onImportFile(event.target.files?.[0])}
          />
        </div>
        {status ? (
          <p className="m-0 text-[12px] text-muted-foreground" role="status">
            {status}
          </p>
        ) : null}
        {error ? (
          <p className="m-0 text-[13px] text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {result ? (
          <div className="min-w-0 overflow-hidden rounded-[10px] border border-border">
            <div className="grid gap-1 px-3 py-2.5 text-[12px]">
              <p className="m-0">
                New engagement{" "}
                <Link
                  to="/engagements/$engagementId"
                  params={{ engagementId: result.engagementId }}
                  search={{ tab: "leads" }}
                  className="font-mono text-[12px] text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {result.engagementId}
                </Link>
              </p>
              <p className="m-0 text-muted-foreground" aria-live="polite">
                {result.counts.leads} leads · {result.counts.attempts} attempts ·{" "}
                {result.counts.excerpts} excerpts · {result.counts.attachments}{" "}
                attachments · {result.counts.findings} findings ·{" "}
                {result.counts.evidence} evidence files
                {result.counts.secrets > 0 || result.counts.objectives > 0 ?
                  ` · ${result.counts.secrets} secrets · ${result.counts.objectives} objectives (private copy)`
                : null}
              </p>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
