import { Button } from "@blackglass/ui";
import { useState } from "react";

import { copyTextToClipboard } from "../engagements/report-query.js";
import {
  useCreateFindingMutation,
  type CreateFindingInput,
} from "../engagements/findings-query.js";
import { leadToFindingPrefill, type LeadRef } from "./lead-prefill.js";
import {
  pinParagraphToLead,
  pinParagraphToNote,
  toPrefilledAction,
  type LeadDraft,
  type NoteDraft,
} from "./pin-citation.js";
import type { SaveTechniqueInput } from "./technique-query.js";
import type { AdvisorPartitionedCitation } from "@blackglass/contracts";

// Per-paragraph advisor actions (STONE-7). A useful paragraph pins into a
// note draft or a lead draft with citations, a supported check becomes a
// prefilled argv action with Copy, and a lead draft prefills a correctable
// finding form. Unsupported commands never get an action button: they stay
// paragraph prose. Nothing here edits notes, leads, or findings without an
// explicit operator click.
export function ParagraphActions({
  engagementId,
  archived,
  paragraph,
  citations,
  question,
  onSaveTechnique,
}: {
  engagementId: string;
  archived: boolean;
  paragraph: string;
  citations: readonly AdvisorPartitionedCitation[];
  question: string;
  onSaveTechnique: (draft: SaveTechniqueInput) => void;
}) {
  const [mode, setMode] = useState<"note" | "lead" | "finding" | null>(null);
  const [copied, setCopied] = useState(false);
  if (archived) return null;

  const pinned = { text: paragraph, citations };
  const supportedLines = paragraph
    .split("\n")
    .map((line) => line.trim().replace(/^\$\s*/, ""))
    .filter((line) => toPrefilledAction(line).ok);

  function copyText(value: string) {
    setCopied(false);
    void copyTextToClipboard(value).then((ok) => {
      if (ok) {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      }
    });
  }

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <Button
        type="button"
        variant="quiet"
        className="h-6 px-1.5 text-[11px]"
        onClick={() => setMode(mode === "note" ? null : "note")}
      >
        Pin to note
      </Button>
      <Button
        type="button"
        variant="quiet"
        className="h-6 px-1.5 text-[11px]"
        onClick={() => setMode(mode === "lead" ? null : "lead")}
      >
        Pin to lead
      </Button>
      <Button
        type="button"
        variant="quiet"
        className="h-6 px-1.5 text-[11px]"
        onClick={() =>
          onSaveTechnique({
            name: firstLine(paragraph),
            whenUseful: "",
            prerequisites: [],
            question,
            procedure: [{ instruction: paragraph }],
            meaning: "",
          })
        }
      >
        Save as technique
      </Button>
      {supportedLines.map((line, index) => {
        const action = toPrefilledAction(line);
        if (!action.ok) return null;
        return (
          <Button
            key={index}
            type="button"
            variant="quiet"
            className="h-6 px-1.5 font-mono text-[11px]"
            title={`Prefilled action: ${action.label}`}
            onClick={() => copyText(action.label)}
          >
            Use: {truncateAction(action.label)}
          </Button>
        );
      })}
      {copied ? (
        <span className="text-[11px] text-muted-foreground" role="status">Copied</span>
      ) : null}
      {mode === "note" ? (
        <NoteDraftCard
          draft={pinParagraphToNote(pinned, question)}
          onCopy={copyText}
        />
      ) : null}
      {mode === "lead" ? (
        <LeadDraftCard
          draft={pinParagraphToLead(pinned, question)}
          onCopy={copyText}
          onPrefillFinding={() => setMode("finding")}
        />
      ) : null}
      {mode === "finding" ? (
        <FindingPrefillCard
          engagementId={engagementId}
          draft={pinParagraphToLead(pinned, question)}
        />
      ) : null}
    </div>
  );
}

function firstLine(paragraph: string): string {
  const line = (paragraph.split("\n")[0] ?? paragraph).trim();
  return Array.from(line).length > 80
    ? `${Array.from(line).slice(0, 77).join("")}...`
    : line;
}

function truncateAction(label: string): string {
  return Array.from(label).length > 40
    ? `${Array.from(label).slice(0, 37).join("")}...`
    : label;
}

function NoteDraftCard({
  draft,
  onCopy,
}: {
  draft: NoteDraft;
  onCopy: (value: string) => void;
}) {
  return (
    <div className="mt-1 w-full rounded-md border border-border px-2 py-1.5">
      <p className="m-0 text-[11px] font-semibold">Note draft (copy into notes)</p>
      <pre className="m-0 mt-1 max-h-32 overflow-auto font-mono text-[11px] whitespace-pre-wrap break-words">
        {draft.body}
      </pre>
      <Button
        type="button"
        variant="quiet"
        className="mt-1 h-6 px-1.5 text-[11px]"
        onClick={() => onCopy(draft.body)}
      >
        Copy note draft
      </Button>
    </div>
  );
}

function LeadDraftCard({
  draft,
  onCopy,
  onPrefillFinding,
}: {
  draft: LeadDraft;
  onCopy: (value: string) => void;
  onPrefillFinding: () => void;
}) {
  const text = [
    `Title: ${draft.title}`,
    "",
    draft.narrative,
    "",
    `Evidence artifacts: ${draft.artifactIds.join(", ") || "none"}`,
    `Evidence findings: ${draft.findingIds.join(", ") || "none"}`,
  ].join("\n");
  return (
    <div className="mt-1 w-full rounded-md border border-border px-2 py-1.5">
      <p className="m-0 text-[11px] font-semibold">Lead draft (title and narrative correctable)</p>
      <pre className="m-0 mt-1 max-h-32 overflow-auto font-mono text-[11px] whitespace-pre-wrap break-words">
        {text}
      </pre>
      <div className="mt-1 flex flex-wrap gap-1.5">
        <Button
          type="button"
          variant="quiet"
          className="h-6 px-1.5 text-[11px]"
          onClick={() => onCopy(text)}
        >
          Copy lead draft
        </Button>
        <Button
          type="button"
          variant="quiet"
          className="h-6 px-1.5 text-[11px]"
          onClick={onPrefillFinding}
        >
          Prefill finding
        </Button>
      </div>
    </div>
  );
}

const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;

function FindingPrefillCard({
  engagementId,
  draft,
}: {
  engagementId: string;
  draft: LeadDraft;
}) {
  const create = useCreateFindingMutation(engagementId);
  const [title, setTitle] = useState(draft.title);
  const [narrative, setNarrative] = useState(draft.narrative);
  const [severity, setSeverity] =
    useState<(typeof SEVERITIES)[number]>("medium");
  const [scannerObservation, setScannerObservation] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  function buildInput(): CreateFindingInput {
    const lead: LeadRef = {
      id: "advisor-pin",
      title,
      narrative,
      confidence: null,
      source: scannerObservation ? "scanner" : "operator",
      evidenceArtifactIds: draft.artifactIds,
    };
    const prefill = leadToFindingPrefill(lead);
    return {
      title: prefill.title,
      severity: scannerObservation ? prefill.severity : severity,
      body: prefill.body,
      evidenceArtifactIds: prefill.evidenceArtifactIds,
    };
  }

  function handleCreate() {
    setError(undefined);
    if (title.trim().length === 0) {
      setError("Title is required.");
      return;
    }
    create.mutate(buildInput(), {
      onError: () => setError("The finding could not be created."),
    });
  }

  return (
    <div className="mt-1 grid w-full gap-1.5 rounded-md border border-border px-2 py-1.5">
      <p className="m-0 text-[11px] font-semibold">
        Finding prefill (confidence is separate from severity)
      </p>
      <label className="grid gap-0.5 text-[11px]">
        <span>Title (correctable)</span>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          autoComplete="off"
          className="h-7 rounded-md border border-input bg-transparent px-1.5 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>
      <label className="grid gap-0.5 text-[11px]">
        <span>Narrative (correctable)</span>
        <textarea
          value={narrative}
          rows={3}
          onChange={(event) => setNarrative(event.target.value)}
          spellCheck={false}
          className="rounded-md border border-input bg-transparent px-1.5 py-1 font-mono text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-[11px]">
          <span>Severity</span>
          <select
            value={severity}
            disabled={scannerObservation}
            onChange={(event) =>
              setSeverity(event.target.value as (typeof SEVERITIES)[number])
            }
            className="h-7 rounded-md border border-input bg-transparent px-1 text-[12px]"
          >
            {SEVERITIES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-[11px]">
          <input
            type="checkbox"
            checked={scannerObservation}
            onChange={(event) => setScannerObservation(event.target.checked)}
            className="accent-primary"
          />
          Uninterpreted scanner observation
        </label>
        <Button
          type="button"
          disabled={create.isPending}
          className="h-7 px-2 text-[12px]"
          onClick={handleCreate}
        >
          {create.isPending ? "Creating" : "Create finding"}
        </Button>
      </div>
      {scannerObservation ? (
        <p className="m-0 text-[11px] text-muted-foreground">
          Scanner results stay observations until interpreted: severity info, interpretation required.
        </p>
      ) : null}
      {error !== undefined ? (
        <p className="m-0 text-[11px] text-destructive" role="alert">{error}</p>
      ) : null}
      {create.isSuccess ? (
        <p className="m-0 text-[11px] text-muted-foreground" role="status">
          Finding created.
        </p>
      ) : null}
    </div>
  );
}
