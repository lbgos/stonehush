import {
  HAR_MAX_ENTRIES,
  HAR_MAX_FILE_BYTES,
  proposeCaptureTitle,
  type StoneCaptureKind,
} from "@stonehush/contracts";
import { parseHarImport, type HarImportSummary } from "@stonehush/domain";
import { Button } from "@stonehush/ui";
import { useMemo, useState } from "react";

import {
  createStoneCaptureRequest,
  importStoneArtifactRequest,
  StoneCaptureMutationError,
  useStoneCapturesQuery,
  type StoneImportArtifact,
} from "./capture-query.js";

function importErrorMessage(code: string): string {
  switch (code) {
    case "har_too_large":
      return `The HAR file is larger than ${HAR_MAX_FILE_BYTES} bytes. Export only the selected request from the proxy.`;
    case "har_too_many_entries":
      return `The HAR file holds more than ${HAR_MAX_ENTRIES} entries. Export only the selected request from the proxy.`;
    case "har_not_json":
      return "The file is not JSON. Export a HAR file from the proxy and try again.";
    case "har_not_har":
      return "The JSON is not a HAR file. It needs a log.entries array.";
    case "har_no_entries":
      return "The HAR file holds no entries. Select a request in the proxy and export it.";
    case "har_bad_entry":
      return "A HAR entry is missing a request method, an http(s) URL, or a response status.";
    default:
      return "The import was not accepted. Check the content and try again.";
  }
}

function describeHarSummary(summary: HarImportSummary): string {
  const entryWord = summary.entryCount === 1 ? "entry" : "entries";
  return `${summary.entryCount} ${entryWord}: ${summary.first.method} ${summary.first.url}, status ${summary.first.status}`;
}

// External capture: terminal paste, file or screenshot drop, and Nmap XML,
// ffuf JSON, or proxy HAR import into the current target context. STONE-2 mounts
// this view through the slot below after its workspace extension points merge.
export function CaptureView({
  engagementId,
  targetId,
  targetLabel,
}: {
  engagementId: string;
  targetId: string | null;
  targetLabel?: string;
}) {
  const captures = useStoneCapturesQuery(engagementId);
  const [title, setTitle] = useState("");
  const [command, setCommand] = useState("");
  const [observation, setObservation] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [importArtifact, setImportArtifact] = useState<StoneImportArtifact>("nmap-xml");
  const [importContent, setImportContent] = useState("");
  const [importTitle, setImportTitle] = useState("");
  const [importFileName, setImportFileName] = useState<string | null>(null);

  const harPreview = useMemo(() => {
    if (importArtifact !== "har" || importContent.trim().length === 0) return null;
    const parsed = parseHarImport(new TextEncoder().encode(importContent));
    if (!parsed.ok) return { ok: false as const, code: parsed.error.code };
    return { ok: true as const, summary: parsed.value };
  }, [importArtifact, importContent]);

  const [fileName, setFileName] = useState<string | null>(null);

  const onProposeTitle = () => {
    setTitle(
      proposeCaptureTitle({
        kind: "pasted_terminal",
        command: command.trim().length > 0 ? command : undefined,
        targetLabel,
      }),
    );
  };

  const onPasteSubmit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await createStoneCaptureRequest(engagementId, {
        targetId,
        leadId: null,
        kind: "pasted_terminal",
        title: title.trim(),
        command: command.trim().length > 0 ? command.trim() : undefined,
        observation: observation.trim().length > 0 ? observation.trim() : undefined,
        contentText: content,
      });
      setMessage(
        result.deduplicated
          ? `References existing capture ${result.capture.id}. No duplicate facts created.`
          : `Captured as pasted. User-supplied details stay separate from runner-recorded facts.`,
      );
      setTitle("");
      setCommand("");
      setObservation("");
      setContent("");
      await captures.refetch();
    } catch {
      setError("The capture was not accepted. Check the fields and try again.");
    } finally {
      setBusy(false);
    }
  };

  const onFileChange = async (file: File | undefined) => {
    if (file === undefined || busy) return;
    // Reject oversized files before reading them: the server bound is
    // 67,108,864 bytes, so larger files can never be accepted.
    if (file.size > 67_108_864) {
      setError("The file is too large. Files up to 67108864 bytes are accepted.");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const kind: StoneCaptureKind = file.type.startsWith("image/") ? "screenshot" : "dropped_file";
      const buffer = await file.arrayBuffer();
      // Only text files are presented as content so the server hashes the
      // exact bytes. Other files travel by digest, name, and size: decoding
      // binary as text would transform the bytes and dedupe the wrong value.
      // Empty files also use the digest path since empty text is rejected.
      let contentText: string | undefined;
      if (file.type.startsWith("text/") && file.size > 0 && file.size <= 65_536) {
        try {
          contentText = await file.text();
        } catch {
          contentText = undefined;
        }
      }
      let contentDigest: string | undefined;
      if (contentText === undefined) {
        try {
          const digest = await crypto.subtle.digest("SHA-256", buffer);
          const hex = [...new Uint8Array(digest)]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
          contentDigest = `sha256:${hex}`;
        } catch {
          contentDigest = undefined;
        }
      }
      const draft: {
        targetId: string | null;
        leadId: null;
        kind: StoneCaptureKind;
        title: string;
        contentText?: string;
        contentDigest?: string;
        fileName: string;
        byteSize: number;
      } = {
        targetId,
        leadId: null,
        kind,
        title: proposeCaptureTitle({ kind, fileName: file.name, targetLabel }),
        fileName: file.name,
        byteSize: file.size,
      };
      if (contentText !== undefined) draft.contentText = contentText;
      if (contentDigest !== undefined) draft.contentDigest = contentDigest;
      const result = await createStoneCaptureRequest(engagementId, draft);
      setFileName(file.name);
      setMessage(
        result.deduplicated
          ? `References existing capture ${result.capture.id}. No duplicate facts created.`
          : `Captured as ${kind === "screenshot" ? "screenshot" : "file"}. User-supplied details stay separate from runner-recorded facts.`,
      );
      await captures.refetch();
    } catch {
      setError("The file was not accepted. Check the file and try again.");
    } finally {
      setBusy(false);
    }
  };

  const onImportFileChange = async (file: File | undefined) => {
    if (file === undefined || busy) return;
    // Reject oversized HAR files before reading them: the server bound is
    // HAR_MAX_FILE_BYTES, so larger files can never be accepted.
    if (file.size > HAR_MAX_FILE_BYTES) {
      setError(importErrorMessage("har_too_large"));
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      setImportContent(await file.text());
      setImportFileName(file.name);
    } catch {
      setError(importErrorMessage("har_not_json"));
    } finally {
      setBusy(false);
    }
  };

  const onImportSubmit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    // The preview is parsed from the same text being submitted, so the
    // result summary describes exactly what the server validated.
    const preview =
      importArtifact === "har" && importContent.trim().length > 0
        ? parseHarImport(new TextEncoder().encode(importContent))
        : null;
    try {
      const kind: StoneCaptureKind =
        importArtifact === "nmap-xml"
          ? "nmap_xml"
          : importArtifact === "ffuf-json"
            ? "ffuf_json"
            : "har";
      const result = await importStoneArtifactRequest(engagementId, importArtifact, {
        targetId,
        leadId: null,
        title:
          importTitle.trim().length > 0
            ? importTitle.trim()
            : kind === "har" && preview !== null && preview.ok
              ? preview.value.title
              : proposeCaptureTitle({ kind, targetLabel }),
        contentText: importContent,
        ...(importArtifact === "har" && importFileName !== null
          ? { fileName: importFileName }
          : {}),
      });
      const importedDetail =
        preview !== null && preview.ok ? `${describeHarSummary(preview.value)}. ` : "";
      setMessage(
        result.deduplicated
          ? `References existing capture ${result.capture.id}. No duplicate facts created.`
          : `Imported. ${importedDetail}Labeled imported with provenance to this import.`,
      );
      setImportContent("");
      setImportTitle("");
      setImportFileName(null);
      await captures.refetch();
    } catch (error) {
      setError(
        importErrorMessage(
          error instanceof StoneCaptureMutationError ? error.code : "request_failed",
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="External capture" className="mt-5 border-t border-border pt-4">
      <header className="mb-3">
        <h2 className="m-0 text-[13px] font-semibold">External capture</h2>
        <p className="mt-1 mb-0 text-[12px] leading-5 text-muted-foreground">
          Paste terminal output, drop a file or screenshot, or import Nmap XML, ffuf JSON,
          or a proxy HAR selection into the current target context.
        </p>
      </header>
      <p className="m-0 text-[12px] leading-5 text-muted-foreground">
        This form has no time, exit status, target conclusion, or executed command fields.
        Nothing is invented. Imported and pasted items are labeled as such.
      </p>

      <div className="mt-4 grid gap-2">
        <h3 className="m-0 text-[12px] font-semibold">Paste terminal output</h3>
        <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="stone-capture-title">
          <span>Title</span>
          <input
            id="stone-capture-title"
            disabled={busy}
            className="min-h-11 w-full rounded-md border border-input bg-transparent px-2.5 text-[13px] text-foreground md:min-h-8"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <div>
          <Button type="button" variant="quiet" disabled={busy} onClick={onProposeTitle}>
            Propose title
          </Button>
        </div>
        <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="stone-capture-command">
          <span>Command, optional</span>
          <input
            id="stone-capture-command"
            disabled={busy}
            className="min-h-11 w-full rounded-md border border-input bg-transparent px-2.5 font-mono text-[13px] text-foreground md:min-h-8"
            value={command}
            onChange={(event) => setCommand(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="stone-capture-observation">
          <span>Observation, one line, optional</span>
          <input
            id="stone-capture-observation"
            disabled={busy}
            className="min-h-11 w-full rounded-md border border-input bg-transparent px-2.5 text-[13px] text-foreground md:min-h-8"
            value={observation}
            onChange={(event) => setObservation(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="stone-capture-content">
          <span>Terminal output</span>
          <textarea
            id="stone-capture-content"
            disabled={busy}
            className="min-h-24 w-full rounded-md border border-input bg-transparent px-2.5 py-2 font-mono text-[13px] text-foreground"
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />
        </label>
        <div>
          <Button type="button" disabled={busy} onClick={() => void onPasteSubmit()}>
            {busy ? "Saving" : "Capture paste"}
          </Button>
        </div>
      </div>

      <div className="mt-4 grid gap-2 border-t border-border pt-4">
        <h3 className="m-0 text-[12px] font-semibold">File or screenshot</h3>
        <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="stone-capture-file">
          <span>Drop a file into the current target context</span>
          <input
            id="stone-capture-file"
            type="file"
            className="min-h-11 w-full text-[13px] text-foreground md:min-h-8"
            disabled={busy}
            onChange={(event) => void onFileChange(event.target.files?.[0])}
          />
        </label>
        {fileName !== null ? (
          <p className="m-0 text-[12px] text-muted-foreground">Selected {fileName}.</p>
        ) : null}
      </div>

      <div className="mt-4 grid gap-2 border-t border-border pt-4">
        <h3 className="m-0 text-[12px] font-semibold">Import Nmap XML, ffuf JSON, or proxy HAR</h3>
        <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="stone-import-artifact">
          <span>Artifact</span>
          <select
            id="stone-import-artifact"
            disabled={busy}
            className="min-h-11 w-full rounded-md border border-input bg-transparent px-2.5 text-[13px] text-foreground md:min-h-8"
            value={importArtifact}
            onChange={(event) =>
              setImportArtifact(event.target.value as StoneImportArtifact)
            }
          >
            <option value="nmap-xml">Nmap XML</option>
            <option value="ffuf-json">ffuf JSON</option>
            <option value="har">Proxy HAR</option>
          </select>
        </label>
        {importArtifact === "har" ? (
          <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="stone-import-file">
            <span>Drop a HAR file with one request or a small selection</span>
            <input
              id="stone-import-file"
              type="file"
              accept=".har,application/json"
              className="min-h-11 w-full text-[13px] text-foreground md:min-h-8"
              disabled={busy}
              onChange={(event) => void onImportFileChange(event.target.files?.[0])}
            />
          </label>
        ) : null}
        {importArtifact === "har" && importFileName !== null ? (
          <p className="m-0 text-[12px] text-muted-foreground">Selected {importFileName}.</p>
        ) : null}
        <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="stone-import-title">
          <span>Title, optional</span>
          <input
            id="stone-import-title"
            disabled={busy}
            className="min-h-11 w-full rounded-md border border-input bg-transparent px-2.5 text-[13px] text-foreground md:min-h-8"
            value={importTitle}
            onChange={(event) => setImportTitle(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="stone-import-content">
          <span>File content</span>
          <textarea
            id="stone-import-content"
            disabled={busy}
            className="min-h-24 w-full rounded-md border border-input bg-transparent px-2.5 py-2 font-mono text-[13px] text-foreground"
            value={importContent}
            onChange={(event) => {
              // Edited text is no longer the picked file, so its name must not
              // travel with the submission.
              setImportFileName(null);
              setImportContent(event.target.value);
            }}
          />
        </label>
        {importArtifact === "har" && harPreview !== null ? (
          harPreview.ok ? (
            <p className="m-0 text-[12px] text-muted-foreground" role="status">
              {describeHarSummary(harPreview.summary)}
            </p>
          ) : (
            <p className="m-0 text-[12px] text-destructive" role="alert">
              {importErrorMessage(harPreview.code)}
            </p>
          )
        ) : null}
        <div>
          <Button type="button" disabled={busy} onClick={() => void onImportSubmit()}>
            {busy ? "Saving" : "Import"}
          </Button>
        </div>
      </div>

      {message !== null ? (
        <p className="mt-3 mb-0 text-[12px] text-muted-foreground" role="status">
          {message}
        </p>
      ) : null}
      {error !== null ? (
        <p className="m-0 mt-3 text-[13px] text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-4 grid gap-2 border-t border-border pt-4">
        <h3 className="m-0 text-[12px] font-semibold">History</h3>
        {captures.data === undefined && captures.isFetching ? (
          <p className="m-0 text-[12px] text-muted-foreground">Loading captures.</p>
        ) : null}
        {captures.isError ? (
          <p className="m-0 text-[12px] text-muted-foreground">
            Captures unavailable. Retry from the panel above.
          </p>
        ) : null}
        {(captures.data ?? []).map((capture) => (
          <div key={capture.id} className="grid gap-1 text-[12px] leading-5">
            <p className="m-0">
              <span className="font-mono">{capture.title}</span>{" "}
              <span className="text-muted-foreground">
                ({capture.originLabel}
                {capture.provenanceExistingId !== null
                  ? `, references ${capture.provenanceExistingId}`
                  : ""}
                )
              </span>
            </p>
            {capture.command !== null ? (
              <p className="m-0 font-mono">Command: {capture.command}</p>
            ) : null}
            {capture.observation !== null ? (
              <p className="m-0">Observation: {capture.observation}</p>
            ) : null}
            {capture.fileName !== null ? (
              <p className="m-0 font-mono">File: {capture.fileName}</p>
            ) : null}
            {capture.contentText !== null ? (
              <pre className="m-0 font-mono text-[12px] leading-5 whitespace-pre-wrap break-all">
                {capture.contentText}
              </pre>
            ) : null}
          </div>
        ))}
        {captures.data !== undefined && captures.data.length === 0 && !captures.isFetching ? (
          <p className="m-0 text-[12px] text-muted-foreground">No captures yet.</p>
        ) : null}
      </div>
    </section>
  );
}

// Extension slot consumed by STONE-2 workspace mounting after it merges.
export const STONE5_CAPTURE_SLOT = {
  id: "stone5-capture",
  View: CaptureView,
} as const;
