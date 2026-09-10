import type { Technique } from "@blackglass/contracts";
import {
  extractTechniquePlaceholders,
  fillTechniquePlaceholders,
  isSupportedCheck,
  matchTechniquePrereqs,
} from "@blackglass/domain";
import { Button } from "@blackglass/ui";
import { useMemo, useState } from "react";

import { copyTextToClipboard } from "../engagements/report-query.js";
import {
  useSaveTechniqueMutation,
  useTechniquesQuery,
  type SaveTechniqueInput,
} from "./technique-query.js";

export interface TechniqueDraft extends SaveTechniqueInput {
  readonly key: string;
}

// Saved techniques for this engagement. Save-as-technique stores a useful
// sequence with its prerequisites, question, procedure, and meaning;
// replay fills placeholders with operator values and never runs anything
// itself. Prerequisite matching states its reason from recorded facts.
export function TechniquePanel({
  engagementId,
  archived,
  facts,
  draft,
}: {
  engagementId: string;
  archived: boolean;
  facts: readonly string[];
  draft?: TechniqueDraft | undefined;
}) {
  const techniques = useTechniquesQuery(engagementId);
  return (
    <div className="mt-3 border-t border-border pt-3">
      <h3 className="m-0 text-[12px] font-semibold">Techniques</h3>
      <p className="mt-1 mb-0 text-[12px] text-muted-foreground">
        Saved procedures with replayable placeholders. Matching states its reason.
      </p>
      {techniques.data === undefined && techniques.isFetching ? (
        <p className="m-0 mt-2 text-[12px] text-muted-foreground">Loading techniques…</p>
      ) : null}
      {techniques.data === undefined && techniques.isError ? (
        <p className="m-0 mt-2 text-[12px] text-muted-foreground" role="alert">
          Techniques could not be loaded.
        </p>
      ) : null}
      {techniques.data !== undefined ? (
        <ul className="m-0 mt-2 list-none space-y-2 p-0">
          {techniques.data.map((technique) => (
            <TechniqueCard
              key={technique.id}
              technique={technique}
              facts={facts}
              archived={archived}
            />
          ))}
        </ul>
      ) : null}
      {techniques.data !== undefined && techniques.data.length === 0 ? (
        <p className="m-0 mt-2 text-[12px] text-muted-foreground">
          No saved techniques yet.
        </p>
      ) : null}
      {!archived ? (
        <SaveTechniqueForm
          key={draft?.key ?? "blank"}
          engagementId={engagementId}
          initial={draft}
        />
      ) : null}
    </div>
  );
}

function TechniqueCard({
  technique,
  facts,
  archived,
}: {
  technique: Technique;
  facts: readonly string[];
  archived: boolean;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  const match = useMemo(
    () => matchTechniquePrereqs(technique.prerequisites, facts),
    [technique.prerequisites, facts],
  );
  const placeholders = useMemo(
    () =>
      technique.procedure.flatMap((step) =>
        extractTechniquePlaceholders(
          step.command === undefined ? step.instruction : `${step.instruction} ${step.command}`,
        ),
      ),
    [technique.procedure],
  );
  const uniquePlaceholders = useMemo(
    () => [...new Set(placeholders)],
    [placeholders],
  );

  function setValue(name: string, value: string) {
    setValues((current) => ({ ...current, [name]: value }));
  }

  function replayText(): string {
    return technique.procedure
      .map((step, index) => {
        const instruction = fillTechniquePlaceholders(step.instruction, values).text;
        if (step.command === undefined) return `${index + 1}. ${instruction}`;
        const command = fillTechniquePlaceholders(step.command, values);
        const marker =
          command.missing.length > 0 ? ` (needs: ${command.missing.join(", ")})` : "";
        return `${index + 1}. ${instruction}\n   ${command.text}${marker}`;
      })
      .join("\n");
  }

  function handleCopyReplay() {
    void copyTextToClipboard(replayText()).then((ok) => {
      if (ok) {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      }
    });
  }

  return (
    <li className="rounded-[10px] border border-border px-3 py-2.5">
      <p className="m-0 text-[12px] font-semibold">{technique.name}</p>
      <p className="m-0 mt-1 text-[12px] text-muted-foreground" role="status">
        {match.matched ? "Applies: " : "Does not apply: "}{match.reason}
      </p>
      {technique.whenUseful.length > 0 ? (
        <p className="m-0 mt-1 text-[12px]">Useful when: {technique.whenUseful}</p>
      ) : null}
      <p className="m-0 mt-1 text-[12px]">Question: {technique.question}</p>
      <ol className="m-0 mt-1 space-y-1 pl-4 text-[12px]">
        {technique.procedure.map((step, index) => (
          <li key={index}>
            <span>{step.instruction}</span>
            {step.command !== undefined ? (
              isSupportedCheck(fillTechniquePlaceholders(step.command, values).text) ? (
                <code className="mt-0.5 block rounded bg-accent px-1.5 py-0.5 font-mono text-[11px]">
                  {fillTechniquePlaceholders(step.command, values).text}
                </code>
              ) : (
                <span className="mt-0.5 block text-[11px] text-muted-foreground">
                  {fillTechniquePlaceholders(step.command, values).text} (prose, not runnable)
                </span>
              )
            ) : null}
          </li>
        ))}
      </ol>
      {technique.meaning.length > 0 ? (
        <p className="m-0 mt-1 text-[12px] text-muted-foreground">
          Reading the result: {technique.meaning}
        </p>
      ) : null}
      {!archived && uniquePlaceholders.length > 0 ? (
        <div className="mt-2 grid gap-1.5">
          {uniquePlaceholders.map((name) => (
            <label key={name} className="grid gap-0.5 text-[12px]">
              <span className="font-mono text-[11px] text-muted-foreground">
                {`{{${name}}}`}
              </span>
              <input
                value={values[name] ?? ""}
                onChange={(event) => setValue(name, event.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="h-8 rounded-md border border-input bg-transparent px-2 font-mono text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
          ))}
        </div>
      ) : null}
      {!archived ? (
        <div className="mt-2">
          <Button type="button" variant="quiet" className="h-7 px-2 text-[12px]" onClick={handleCopyReplay}>
            {copied ? "Copied replay" : "Copy replay"}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function SaveTechniqueForm({
  engagementId,
  initial,
}: {
  engagementId: string;
  initial?: SaveTechniqueInput | undefined;
}) {
  const save = useSaveTechniqueMutation(engagementId);
  const [name, setName] = useState(initial?.name ?? "");
  const [whenUseful, setWhenUseful] = useState(initial?.whenUseful ?? "");
  const [prerequisites, setPrerequisites] = useState(
    initial?.prerequisites.join("\n") ?? "",
  );
  const [question, setQuestion] = useState(initial?.question ?? "");
  const [procedure, setProcedure] = useState(
    initial?.procedure
      .map((step) =>
        step.command === undefined
          ? step.instruction
          : `${step.instruction}\n$ ${step.command}`,
      )
      .join("\n\n") ?? "",
  );
  const [meaning, setMeaning] = useState(initial?.meaning ?? "");
  const [error, setError] = useState<string | undefined>(undefined);

  function parseProcedure(): SaveTechniqueInput["procedure"] | undefined {
    const steps: { instruction: string; command?: string }[] = [];
    for (const block of procedure.split(/\n\s*\n/)) {
      const lines = block.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
      if (lines.length === 0) continue;
      const instruction = lines.filter((line) => !line.startsWith("$")).join(" ");
      const commandLine = lines.find((line) => line.startsWith("$"));
      const command = commandLine?.slice(1).trim();
      if (instruction.length === 0) return undefined;
      steps.push(
        command === undefined || command.length === 0
          ? { instruction }
          : { instruction, command },
      );
    }
    return steps;
  }

  function handleSave() {
    setError(undefined);
    const steps = parseProcedure();
    if (name.trim().length === 0 || question.trim().length === 0 || steps === undefined || steps.length === 0) {
      setError("Name, question, and at least one procedure step are required.");
      return;
    }
    save.mutate(
      {
        name: name.trim(),
        whenUseful,
        prerequisites: prerequisites
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
        question: question.trim(),
        procedure: steps,
        meaning,
      },
      { onError: () => setError("The technique could not be saved.") },
    );
  }

  return (
    <div className="mt-3">
      <h4 className="m-0 text-[12px] font-semibold">Save as technique</h4>
      <div className="mt-1.5 grid gap-1.5">
        <label className="grid gap-0.5 text-[12px]">
          <span>Name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="off"
            className="h-8 rounded-md border border-input bg-transparent px-2 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <label className="grid gap-0.5 text-[12px]">
          <span>When useful</span>
          <input
            value={whenUseful}
            onChange={(event) => setWhenUseful(event.target.value)}
            autoComplete="off"
            className="h-8 rounded-md border border-input bg-transparent px-2 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <label className="grid gap-0.5 text-[12px]">
          <span>Prerequisites (one per line)</span>
          <textarea
            value={prerequisites}
            rows={2}
            onChange={(event) => setPrerequisites(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="rounded-md border border-input bg-transparent px-2 py-1.5 font-mono text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <label className="grid gap-0.5 text-[12px]">
          <span>Distinguishing question</span>
          <input
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            autoComplete="off"
            className="h-8 rounded-md border border-input bg-transparent px-2 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <label className="grid gap-0.5 text-[12px]">
          <span>Procedure (blank line between steps, $ prefix for commands with {"{{placeholders}}"})</span>
          <textarea
            value={procedure}
            rows={4}
            onChange={(event) => setProcedure(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="rounded-md border border-input bg-transparent px-2 py-1.5 font-mono text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <label className="grid gap-0.5 text-[12px]">
          <span>How to read the result</span>
          <input
            value={meaning}
            onChange={(event) => setMeaning(event.target.value)}
            autoComplete="off"
            className="h-8 rounded-md border border-input bg-transparent px-2 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <div>
          <Button type="button" disabled={save.isPending} onClick={handleSave}>
            {save.isPending ? "Saving" : "Save technique"}
          </Button>
        </div>
        {error !== undefined ? (
          <p className="m-0 text-[12px] text-destructive" role="alert">{error}</p>
        ) : null}
        {save.isSuccess ? (
          <p className="m-0 text-[12px] text-muted-foreground" role="status">
            Technique saved.
          </p>
        ) : null}
      </div>
    </div>
  );
}
