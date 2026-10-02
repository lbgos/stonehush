import {
  CreateTechniqueRequestSchema,
  TECHNIQUE_NAME_MAX_CHARS,
  TECHNIQUE_PREREQUISITES_MAX,
  TECHNIQUE_PROCEDURE_STEPS_MAX,
  TECHNIQUE_STEP_COMMAND_MAX_CHARS,
  TECHNIQUE_STEP_INSTRUCTION_MAX_CHARS,
  type CreateTechniqueRequest,
  type Technique,
} from "@stonehush/contracts";
import { extractTechniquePlaceholders, isSupportedCheck } from "@stonehush/domain";
import { Button } from "@stonehush/ui";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";

import { useSaveTechniqueMutation, type SaveTechniqueInput } from "./technique-query.js";
import { TechniqueRequestError, isTechniqueSaveRefused } from "./technique-query.js";

// Shared technique save pieces. Both the Advisor form and the lead attempt
// draft validate with the create-request contract and save through
// useTechniqueSave. The structured step editor keeps each step's
// instruction and command in separate fields, so copied text never passes
// through the Advisor textarea grammar where blank lines split steps and
// `$` lines become commands.

export interface TechniqueStepDraft {
  readonly key: string;
  readonly instruction: string;
  readonly command: string;
  // Context shown above the step while editing. Never saved.
  readonly note?: string | undefined;
}

export interface TechniqueFormDraft {
  readonly name: string;
  readonly whenUseful: string;
  // One prerequisite per line.
  readonly prerequisites: string;
  readonly question: string;
  readonly meaning: string;
  readonly steps: readonly TechniqueStepDraft[];
}

export function techniqueInputFromForm(form: TechniqueFormDraft): SaveTechniqueInput {
  return {
    name: form.name.trim(),
    whenUseful: form.whenUseful,
    prerequisites: form.prerequisites
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    question: form.question.trim(),
    procedure: form.steps.map((step) => {
      const instruction = step.instruction.trim();
      const command = step.command.trim();
      return command.length === 0 ? { instruction } : { instruction, command };
    }),
    meaning: form.meaning,
  };
}

type TechniqueField = "name" | "whenUseful" | "prerequisites" | "question" | "procedure" | "meaning" | "form";

export interface TechniqueStepProblem {
  instruction?: string;
  command?: string;
}

export interface TechniqueProblems {
  readonly fields: Readonly<Partial<Record<TechniqueField, string>>>;
  // By procedure index.
  readonly steps: ReadonlyMap<number, Readonly<TechniqueStepProblem>>;
  readonly messages: readonly string[];
}

export type TechniqueCheck =
  | { readonly ok: true; readonly request: CreateTechniqueRequest }
  | { readonly ok: false; readonly problems: TechniqueProblems };

const FIELD_LABELS: Record<Exclude<TechniqueField, "form">, string> = {
  name: "Name",
  whenUseful: "When useful",
  prerequisites: "Prerequisites",
  question: "Distinguishing question",
  procedure: "Procedure",
  meaning: "How to read the result",
};

function codePoints(value: string): number {
  return Array.from(value).length;
}

function isField(value: unknown): value is Exclude<TechniqueField, "form"> {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(FIELD_LABELS, value);
}

function fieldMessage(
  field: Exclude<TechniqueField, "form">,
  index: unknown,
  input: SaveTechniqueInput,
  schemaMessage: string,
): string {
  if (field === "name") {
    if (input.name.length === 0) return "Name is required.";
    const length = codePoints(input.name);
    if (length > TECHNIQUE_NAME_MAX_CHARS) {
      return `Name has ${length} characters. Shorten it to ${TECHNIQUE_NAME_MAX_CHARS}.`;
    }
  }
  if (field === "question" && input.question.length === 0) return "Distinguishing question is required.";
  if (field === "prerequisites") {
    return typeof index === "number"
      ? `Prerequisite ${index + 1} ${schemaMessage}.`
      : `Use at most ${TECHNIQUE_PREREQUISITES_MAX} prerequisites, one per line.`;
  }
  if (field === "procedure") {
    return input.procedure.length === 0
      ? "Add at least one step."
      : `A technique holds at most ${TECHNIQUE_PROCEDURE_STEPS_MAX} steps. Remove ${input.procedure.length - TECHNIQUE_PROCEDURE_STEPS_MAX}.`;
  }
  return `${FIELD_LABELS[field]} ${schemaMessage}.`;
}

function stepMessage(index: number, part: "instruction" | "command", value: string, schemaMessage: string): string {
  const step = `Step ${index + 1}`;
  if (part === "instruction" && value.length === 0) return `${step} needs an instruction.`;
  if (part === "command" && /[\r\n]/.test(value)) return `${step} command must be one line.`;
  const length = codePoints(value);
  const limit = part === "instruction" ? TECHNIQUE_STEP_INSTRUCTION_MAX_CHARS : TECHNIQUE_STEP_COMMAND_MAX_CHARS;
  if (length > limit) return `${step} ${part} has ${length} characters. Shorten it to ${limit}.`;
  return `${step} ${part} ${schemaMessage}.`;
}

// Validate with the create-request contract before any mutation. The
// contract decides validity; this only words its issues per field.
export function checkTechniqueInput(input: SaveTechniqueInput): TechniqueCheck {
  const result = CreateTechniqueRequestSchema.safeParse({
    name: input.name,
    whenUseful: input.whenUseful,
    prerequisites: [...input.prerequisites],
    question: input.question,
    procedure: input.procedure.map((step) => ({ ...step })),
    meaning: input.meaning,
  });
  if (result.success) return { ok: true, request: result.data };
  const fields: Partial<Record<TechniqueField, string>> = {};
  const steps = new Map<number, TechniqueStepProblem>();
  const messages: string[] = [];
  for (const issue of result.error.issues) {
    const [head, index, part] = issue.path;
    if (head === "procedure" && typeof index === "number" && (part === "instruction" || part === "command")) {
      const current = steps.get(index) ?? {};
      if (current[part] !== undefined) continue;
      const step = input.procedure[index];
      const value = (part === "instruction" ? step?.instruction : step?.command) ?? "";
      const message = stepMessage(index, part, value, issue.message);
      current[part] = message;
      steps.set(index, current);
      messages.push(message);
      continue;
    }
    const field: TechniqueField = isField(head) ? head : "form";
    if (fields[field] !== undefined) continue;
    const message = field === "form" ? "The technique fields are not valid." : fieldMessage(field, index, input, issue.message);
    fields[field] = message;
    messages.push(message);
  }
  if (messages.length === 0) {
    fields.form = "The technique fields are not valid.";
    messages.push(fields.form);
  }
  return { ok: false, problems: { fields, steps, messages } };
}

export type TechniqueSaveFailure = "request" | "unknown" | "owner";

export interface TechniqueSaveHandlers {
  readonly onSaved: (technique: Technique) => void;
  readonly onFailed: (failure: TechniqueSaveFailure, code: string) => void;
}

// One save path for every technique form. A synchronous lock blocks a second
// submit before the pending state renders. A created technique counts only
// when the response names the engagement the request was sent for. A server
// refusal definitely did not create anything and stays retryable; any other
// failure leaves the create outcome unknown, so the operator checks
// Techniques before saving again to avoid a duplicate POST.
export function useTechniqueSave(engagementId: string) {
  const save = useSaveTechniqueMutation(engagementId);
  const inFlight = useRef(false);
  const submit = (request: SaveTechniqueInput, handlers: TechniqueSaveHandlers): boolean => {
    if (inFlight.current) return false;
    inFlight.current = true;
    save.mutate(request, {
      onSuccess: (technique) => {
        if (technique.engagementId === engagementId) handlers.onSaved(technique);
        else handlers.onFailed("owner", "owner_mismatch");
      },
      onError: (error) => {
        const code = error instanceof TechniqueRequestError ? error.code : "request_failed";
        handlers.onFailed(isTechniqueSaveRefused(code) ? "request" : "unknown", code);
      },
      onSettled: () => {
        inFlight.current = false;
      },
    });
    return true;
  };
  return { submit, pending: save.isPending };
}

export function isTechniquePlaceholderName(name: string): boolean {
  const found = extractTechniquePlaceholders(`{{${name}}}`);
  return found.length === 1 && found[0] === name;
}

// Replace every exact occurrence of an operator-typed literal in step
// instructions and commands with one `{{name}}` placeholder.
export function replaceStepLiteral(
  steps: readonly TechniqueStepDraft[],
  literal: string,
  name: string,
): { readonly steps: readonly TechniqueStepDraft[]; readonly count: number } {
  if (literal.trim().length === 0 || !isTechniquePlaceholderName(name)) return { steps, count: 0 };
  const token = `{{${name}}}`;
  let count = 0;
  const swap = (value: string): string => {
    const parts = value.split(literal);
    count += parts.length - 1;
    return parts.join(token);
  };
  const next = steps.map((step) => ({ ...step, instruction: swap(step.instruction), command: swap(step.command) }));
  return { steps: count === 0 ? steps : next, count };
}

export function countStepLiteral(steps: readonly TechniqueStepDraft[], literal: string): number {
  if (literal.trim().length === 0) return 0;
  return steps.reduce(
    (total, step) => total + step.instruction.split(literal).length - 1 + step.command.split(literal).length - 1,
    0,
  );
}

export const TECHNIQUE_FIELD_CLASS =
  "min-h-11 w-full border border-input bg-transparent px-2.5 py-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive";

// Buttons here stay focusable when inert so keyboard focus does not fall to
// the page when a step moves to an end or a save starts.
export function TechniqueEditorButton({
  inert,
  onPress,
  children,
  className,
  variant = "secondary",
  ref,
  ...props
}: {
  inert: boolean;
  onPress: () => void;
  children: ReactNode;
  className?: string;
  variant?: "primary" | "secondary" | "quiet";
  ref?: Ref<HTMLButtonElement>;
  "aria-label"?: string;
  "data-focus"?: string;
}) {
  return (
    <Button
      ref={ref}
      type="button"
      variant={variant}
      aria-disabled={inert || undefined}
      className={`min-h-11 md:min-h-11 aria-disabled:cursor-default aria-disabled:opacity-50 ${className ?? ""}`}
      onClick={() => {
        if (!inert) onPress();
      }}
      {...props}
    >
      {children}
    </Button>
  );
}

type StepFocus = { readonly key: string; readonly target: "instruction" | "up" | "down" } | "add";

// Ordered procedure steps with typed boundaries. Locked keeps every field
// readable and focusable while a save is in flight.
export function TechniqueStepsEditor({
  idPrefix,
  steps,
  problems,
  locked,
  nextKey,
  onChange,
}: {
  idPrefix: string;
  steps: readonly TechniqueStepDraft[];
  // By step key.
  problems?: ReadonlyMap<string, Readonly<TechniqueStepProblem>> | undefined;
  locked: boolean;
  nextKey: () => string;
  onChange: (steps: readonly TechniqueStepDraft[]) => void;
}) {
  const listRef = useRef<HTMLOListElement>(null);
  const addRef = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<StepFocus | undefined>(undefined);

  useEffect(() => {
    const request = focusAfter.current;
    if (request === undefined) return;
    focusAfter.current = undefined;
    if (request === "add") {
      addRef.current?.querySelector<HTMLElement>("button")?.focus();
      return;
    }
    listRef.current
      ?.querySelector<HTMLElement>(`[data-step-key="${request.key}"] [data-focus="${request.target}"]`)
      ?.focus();
  });

  const update = (key: string, patch: Partial<TechniqueStepDraft>) =>
    onChange(steps.map((step) => (step.key === key ? { ...step, ...patch } : step)));

  const move = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    const step = steps[index];
    const other = steps[target];
    if (step === undefined || other === undefined) return;
    const next = [...steps];
    next[target] = step;
    next[index] = other;
    const direction = offset < 0 ? "up" : "down";
    const atEnd = offset < 0 ? target === 0 : target === steps.length - 1;
    focusAfter.current = { key: step.key, target: atEnd ? (direction === "up" ? "down" : "up") : direction };
    onChange(next);
  };

  const remove = (index: number) => {
    const next = steps.filter((_, position) => position !== index);
    const neighbour = next[index] ?? next[index - 1];
    focusAfter.current = neighbour === undefined ? "add" : { key: neighbour.key, target: "instruction" };
    onChange(next);
  };

  const add = () => {
    const key = nextKey();
    focusAfter.current = { key, target: "instruction" };
    onChange([...steps, { key, instruction: "", command: "" }]);
  };

  const full = steps.length >= TECHNIQUE_PROCEDURE_STEPS_MAX;

  return (
    <div className="grid gap-2">
      <ol ref={listRef} aria-label="Procedure steps" className="m-0 grid list-none gap-2 p-0">
        {steps.map((step, index) => {
          const problem = problems?.get(step.key);
          const instructionId = `${idPrefix}-step-${step.key}-instruction`;
          const commandId = `${idPrefix}-step-${step.key}-command`;
          const instructionLength = codePoints(step.instruction.trim());
          const command = step.command.trim();
          const instructionNote =
            problem?.instruction ??
            (instructionLength > TECHNIQUE_STEP_INSTRUCTION_MAX_CHARS
              ? `${instructionLength} of ${TECHNIQUE_STEP_INSTRUCTION_MAX_CHARS} characters. Shorten before saving.`
              : undefined);
          return (
            <li key={step.key} data-step-key={step.key} className="grid gap-1.5 border border-border px-2.5 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[12px] font-semibold">Step {index + 1}</span>
                <div className="flex flex-wrap gap-1">
                  <TechniqueEditorButton
                    inert={locked || index === 0}
                    aria-label={`Move step ${index + 1} up`}
                    data-focus="up"
                    onPress={() => move(index, -1)}
                  >
                    Up
                  </TechniqueEditorButton>
                  <TechniqueEditorButton
                    inert={locked || index === steps.length - 1}
                    aria-label={`Move step ${index + 1} down`}
                    data-focus="down"
                    onPress={() => move(index, 1)}
                  >
                    Down
                  </TechniqueEditorButton>
                  <TechniqueEditorButton inert={locked} aria-label={`Remove step ${index + 1}`} onPress={() => remove(index)}>
                    Remove
                  </TechniqueEditorButton>
                </div>
              </div>
              {step.note !== undefined ? (
                <p className="m-0 text-[11px] leading-5 break-words text-muted-foreground">{step.note}</p>
              ) : null}
              <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={instructionId}>
                <span>Instruction</span>
                <textarea
                  id={instructionId}
                  data-focus="instruction"
                  value={step.instruction}
                  rows={3}
                  readOnly={locked}
                  aria-invalid={instructionNote !== undefined || undefined}
                  aria-describedby={instructionNote !== undefined ? `${instructionId}-problem` : undefined}
                  className={TECHNIQUE_FIELD_CLASS}
                  onChange={(event) => update(step.key, { instruction: event.target.value })}
                />
              </label>
              {instructionNote !== undefined ? (
                <p id={`${instructionId}-problem`} className="m-0 text-[11px] text-destructive">
                  {instructionNote}
                </p>
              ) : null}
              <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={commandId}>
                <span>Command, optional, {"{{placeholders}}"} allowed</span>
                <input
                  id={commandId}
                  value={step.command}
                  readOnly={locked}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={problem?.command !== undefined || undefined}
                  aria-describedby={problem?.command !== undefined || command.length > 0 ? `${commandId}-note` : undefined}
                  className={`${TECHNIQUE_FIELD_CLASS} font-mono`}
                  onChange={(event) => update(step.key, { command: event.target.value })}
                />
              </label>
              {problem?.command !== undefined || command.length > 0 ? (
                <p
                  id={`${commandId}-note`}
                  className={`m-0 text-[11px] ${problem?.command !== undefined ? "text-destructive" : "text-muted-foreground"}`}
                >
                  {problem?.command ??
                    (isSupportedCheck(command)
                      ? "Supported check. Replay copies it and never runs it."
                      : "Prose in replay, not runnable.")}
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
      <div ref={addRef} className="flex flex-wrap items-center gap-2">
        <TechniqueEditorButton inert={locked || full} onPress={add}>
          Add step
        </TechniqueEditorButton>
        {full ? (
          <p className="m-0 text-[11px] text-muted-foreground">
            A technique holds {TECHNIQUE_PROCEDURE_STEPS_MAX} steps.
          </p>
        ) : null}
      </div>
    </div>
  );
}

// Visible `{{name}}` editing. The operator names both the exact text and the
// placeholder; nothing guesses which literal was a target.
export function TechniquePlaceholderEditor({
  idPrefix,
  steps,
  locked,
  onChange,
}: {
  idPrefix: string;
  steps: readonly TechniqueStepDraft[];
  locked: boolean;
  onChange: (steps: readonly TechniqueStepDraft[]) => void;
}) {
  const [literal, setLiteral] = useState("");
  const [name, setName] = useState("");
  const [status, setStatus] = useState<string | undefined>(undefined);
  const used = [
    ...new Set(steps.flatMap((step) => extractTechniquePlaceholders(`${step.instruction} ${step.command}`))),
  ];
  const matches = countStepLiteral(steps, literal);
  const trimmedName = name.trim();
  const nameProblem =
    trimmedName.length > 0 && !isTechniquePlaceholderName(trimmedName)
      ? "Start with a lowercase letter. Use lowercase letters, digits and _ only, up to 32."
      : undefined;
  const ready = matches > 0 && trimmedName.length > 0 && nameProblem === undefined;

  const apply = () => {
    const result = replaceStepLiteral(steps, literal, trimmedName);
    if (result.count === 0) return;
    onChange(result.steps);
    setStatus(`Replaced ${result.count} with {{${trimmedName}}}.`);
    setLiteral("");
  };

  return (
    <div className="grid gap-2 border-t border-border pt-2">
      <p className="m-0 text-[11px] leading-5 text-muted-foreground">
        {used.length > 0 ? (
          <>
            Placeholders{" "}
            <span className="font-mono break-all text-foreground">{used.map((entry) => `{{${entry}}}`).join(" ")}</span>
          </>
        ) : (
          "No placeholders yet. Type {{name}} in a step or replace exact text below."
        )}
      </p>
      <div className="grid items-end gap-2 sm:grid-cols-[1fr_10rem_auto]">
        <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={`${idPrefix}-literal`}>
          <span>Exact text in steps</span>
          <input
            id={`${idPrefix}-literal`}
            value={literal}
            readOnly={locked}
            spellCheck={false}
            autoComplete="off"
            className={`${TECHNIQUE_FIELD_CLASS} font-mono`}
            onChange={(event) => {
              setLiteral(event.target.value);
              setStatus(undefined);
            }}
          />
        </label>
        <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={`${idPrefix}-placeholder`}>
          <span>Placeholder name</span>
          <input
            id={`${idPrefix}-placeholder`}
            value={name}
            readOnly={locked}
            placeholder="target"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={nameProblem !== undefined || undefined}
            className={`${TECHNIQUE_FIELD_CLASS} font-mono`}
            onChange={(event) => {
              setName(event.target.value);
              setStatus(undefined);
            }}
          />
        </label>
        <TechniqueEditorButton inert={locked || !ready} onPress={apply}>
          Replace
        </TechniqueEditorButton>
      </div>
      <p className="m-0 text-[11px] text-muted-foreground" role="status">
        {nameProblem ??
          status ??
          (literal.trim().length > 0 ? `${matches} ${matches === 1 ? "match" : "matches"} in steps.` : "")}
      </p>
    </div>
  );
}
