import { proposeCaptureTitle, type StoneCaptureKind } from "@blackglass/contracts";
import { Button } from "@blackglass/ui";
import { useState } from "react";

import {
  createStoneCaptureRequest,
  importStoneArtifactRequest,
  useStoneCapturesQuery,
} from "./capture-query.js";

// External capture: terminal paste, file or screenshot drop, and Nmap XML or
// ffuf JSON import into the current target context. STONE-2 mounts this view
// through the slot below after its workspace extension points merge.
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

  const [importArtifact, setImportArtifact] = useState<"nmap-xml" | "ffuf-json">("nmap-xml");
  const [importContent, setImportContent] = useState("");
  const [importTitle, setImportTitle] = useState("");

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
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const kind: StoneCaptureKind = file.type.startsWith("image/") ? "screenshot" : "dropped_file";
      const buffer = await file.arrayBuffer();
      let contentDigest: string | undefined;
      try {
        const digest = await crypto.subtle.digest("SHA-256", buffer);
        const hex = [...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        contentDigest = `sha256:${hex}`;
      } catch {
        contentDigest = undefined;
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
      if (contentDigest !== undefined) draft.contentDigest = contentDigest;
      if (file.type.startsWith("text/") || file.size <= 65_536) {
        try {
          draft.contentText = await file.text();
        } catch {
          // Binary content travels by digest, name, and size only.
        }
      }
      const result = await createStoneCaptureRequest(engagementId, draft);
      setFileName(file.name);
      setMessage(
        result.deduplicated
          ? `References existing capture ${result.capture.id}. No duplicate facts created.`
          : `Captured as pasted. User-supplied details stay separate from runner-recorded facts.`,
      );
      await captures.refetch();
    } catch {
      setError("The file was not accepted. Check the file and try again.");
    } finally {
      setBusy(false);
    }
  };

  const onImportSubmit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await importStoneArtifactRequest(engagementId, importArtifact, {
        targetId,
        leadId: null,
        title:
          importTitle.trim().length > 0
            ? importTitle.trim()
            : proposeCaptureTitle({
                kind: importArtifact === "nmap-xml" ? "nmap_xml" : "ffuf_json",
                targetLabel,
              }),
        command: command.trim().length > 0 ? command.trim() : undefined,
        observation: observation.trim().length > 0 ? observation.trim() : undefined,
        contentText: importContent,
      });
      setMessage(
        result.deduplicated
          ? `References existing capture ${result.capture.id}. No duplicate facts created.`
          : `Imported. Labeled imported with provenance to this import.`,
      );
      setImportContent("");
      setImportTitle("");
      await captures.refetch();
    } catch {
      setError("The import was not accepted. Check the content and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="External capture" className="mt-5 border-t border-border pt-4">
      <header className="mb-3">
        <h2 className="m-0 text-[13px] font-semibold">External capture</h2>
        <p className="mt-1 mb-0 text-[12px] leading-5 text-muted-foreground">
          Paste terminal output, drop a file or screenshot, or import Nmap XML or ffuf JSON
          into the current target context.
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
            className="min-h-11 w-full rounded-md border border-input bg-transparent px-2.5 text-[13px] text-foreground md:min-h-8"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <div>
          <Button type="button" variant="quiet" onClick={onProposeTitle}>
            Propose title
          </Button>
        </div>
        <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="stone-capture-command">
          <span>Command, optional</span>
          <input
            id="stone-capture-command"
            className="min-h-11 w-full rounded-md border border-input bg-transparent px-2.5 font-mono text-[13px] text-foreground md:min-h-8"
            value={command}
            onChange={(event) => setCommand(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="stone-capture-observation">
          <span>Observation, one line, optional</span>
          <input
            id="stone-capture-observation"
            className="min-h-11 w-full rounded-md border border-input bg-transparent px-2.5 text-[13px] text-foreground md:min-h-8"
            value={observation}
            onChange={(event) => setObservation(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="stone-capture-content">
          <span>Terminal output</span>
          <textarea
            id="stone-capture-content"
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
            onChange={(event) => void onFileChange(event.target.files?.[0])}
          />
        </label>
        {fileName !== null ? (
          <p className="m-0 text-[12px] text-muted-foreground">Selected {fileName}.</p>
        ) : null}
      </div>

      <div className="mt-4 grid gap-2 border-t border-border pt-4">
        <h3 className="m-0 text-[12px] font-semibold">Import Nmap XML or ffuf JSON</h3>
        <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="stone-import-artifact">
          <span>Artifact</span>
          <select
            id="stone-import-artifact"
            className="min-h-11 w-full rounded-md border border-input bg-transparent px-2.5 text-[13px] text-foreground md:min-h-8"
            value={importArtifact}
            onChange={(event) =>
              setImportArtifact(event.target.value as "nmap-xml" | "ffuf-json")
            }
          >
            <option value="nmap-xml">Nmap XML</option>
            <option value="ffuf-json">ffuf JSON</option>
          </select>
        </label>
        <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="stone-import-title">
          <span>Title, optional</span>
          <input
            id="stone-import-title"
            className="min-h-11 w-full rounded-md border border-input bg-transparent px-2.5 text-[13px] text-foreground md:min-h-8"
            value={importTitle}
            onChange={(event) => setImportTitle(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="stone-import-content">
          <span>File content</span>
          <textarea
            id="stone-import-content"
            className="min-h-24 w-full rounded-md border border-input bg-transparent px-2.5 py-2 font-mono text-[13px] text-foreground"
            value={importContent}
            onChange={(event) => setImportContent(event.target.value)}
          />
        </label>
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
