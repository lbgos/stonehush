import { TECHNIQUE_NAME_MAX_CHARS, type Lead, type LeadAttempt, type Technique } from "@stonehush/contracts";
import { Button } from "@stonehush/ui";
import { useEffect, useId, useRef, useState } from "react";

import {
  TECHNIQUE_FIELD_CLASS,
  TechniqueEditorButton,
  TechniquePlaceholderEditor,
  TechniqueStepsEditor,
  checkTechniqueInput,
  techniqueInputFromForm,
  useTechniqueSave,
  type TechniqueFormDraft,
  type TechniqueProblems,
  type TechniqueStepProblem,
} from "../advisor/technique-editor.js";
import { TechniqueCard } from "../advisor/technique-panel.js";
import { LEAD_TECHNIQUE_SOURCES_MAX, resolveSourceAttempts, seedLeadTechnique } from "./lead-technique-draft.js";

// Save as technique from one lead's recorded attempts. Selecting and
// drafting are local. Only an explicit Save posts, once, through the shared
// technique save path into this engagement's Techniques, which the Techniques
// tab and Advisor list and replay. All state belongs to one engagement and lead: another
// owner starts idle, and late answers for an earlier owner or draft are
// dropped. Attempt refreshes change what can be selected, never an open
// draft.

type Phase = "idle" | "select" | "draft" | "saved";

type FocusTarget = "start" | "first" | "review" | "heading" | "saved" | "cancel";

interface Authoring {
  readonly owner: string;
  readonly phase: Phase;
  // Attempt ids in the order they were picked; drafts sort by sequence.
  readonly selected: readonly string[];
  readonly selectionProblem: string | undefined;
  readonly serial: number;
  readonly seed: TechniqueFormDraft | undefined;
  readonly form: TechniqueFormDraft | undefined;
  readonly sources: readonly number[];
  readonly maskedCount: number;
  // After the first Save attempt, problems follow every edit.
  readonly checked: boolean;
  readonly failure: string | undefined;
  readonly confirmDiscard: boolean;
  // The created technique, kept for retrieval and replay without a run or
  // provider setup. Cleared with Done.
  readonly savedTechnique: Technique | undefined;
}

function idle(owner: string, serial = 0): Authoring {
  return {
    owner,
    phase: "idle",
    selected: [],
    selectionProblem: undefined,
    serial,
    seed: undefined,
    form: undefined,
    sources: [],
    maskedCount: 0,
    checked: false,
    failure: undefined,
    confirmDiscard: false,
    savedTechnique: undefined,
  };
}

function sameForm(left: TechniqueFormDraft | undefined, right: TechniqueFormDraft | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function useLeadTechnique({
  engagementId,
  lead,
  records,
  archived,
  readOnly,
  outcomeLabel,
}: {
  engagementId: string;
  lead: Lead;
  records: readonly LeadAttempt[];
  archived: boolean;
  readOnly: boolean;
  outcomeLabel: (outcome: LeadAttempt["outcome"]) => string;
}) {
  const owner = `${engagementId}/${lead.id}`;
  const save = useTechniqueSave(engagementId);
  const [raw, setRaw] = useState<Authoring>(() => idle(owner));
  const state = raw.owner === owner ? raw : idle(owner, raw.serial);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const stateRef = useRef(state);
  stateRef.current = state;
  const keys = useRef(0);
  const nextKey = () => {
    keys.current += 1;
    return `s${keys.current}`;
  };

  const startRef = useRef<HTMLButtonElement>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  const reviewRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const savedRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<FocusTarget | undefined>(undefined);
  useEffect(() => {
    const target = focusNext.current;
    if (target === undefined) return;
    focusNext.current = undefined;
    const refs = { start: startRef, first: firstRef, review: reviewRef, heading: headingRef, saved: savedRef, cancel: cancelRef };
    refs[target].current?.focus();
  });

  const update = (patch: Partial<Authoring>, focus?: FocusTarget) => {
    if (focus !== undefined) focusNext.current = focus;
    setRaw((current) => ({ ...(current.owner === owner ? current : idle(owner, current.serial)), ...patch }));
  };

  const listedIds = new Set(records.map((attempt) => attempt.id));
  const listedSelected = state.selected.filter((id) => listedIds.has(id));
  const selecting = state.phase === "select" && !archived;
  const drafting = state.phase === "draft" && state.form !== undefined;
  const pending = drafting && save.pending;

  const start = () => update({ phase: "select", selected: [], selectionProblem: undefined }, "first");

  const toggle = (attemptId: string) => {
    if (state.selected.includes(attemptId)) {
      update({ selected: state.selected.filter((id) => id !== attemptId), selectionProblem: undefined });
    } else if (listedSelected.length < LEAD_TECHNIQUE_SOURCES_MAX) {
      update({ selected: [...listedSelected, attemptId], selectionProblem: undefined });
    }
  };

  const cancelSelect = () => update({ phase: "idle", selected: [], selectionProblem: undefined }, "start");

  const review = () => {
    if (readOnly || archived) return;
    if (listedSelected.length !== state.selected.length) {
      update({
        selected: listedSelected,
        selectionProblem: "A selected attempt is no longer listed and was dropped. Check the selection and review again.",
      });
      return;
    }
    const resolved = resolveSourceAttempts(engagementId, lead.id, records, state.selected);
    if (!resolved.ok) {
      update({ selectionProblem: resolved.message });
      return;
    }
    const seed = seedLeadTechnique(lead, resolved.attempts, outcomeLabel, nextKey);
    update(
      {
        phase: "draft",
        selectionProblem: undefined,
        serial: state.serial + 1,
        seed: seed.form,
        form: seed.form,
        sources: resolved.attempts.map((attempt) => attempt.sequence),
        maskedCount: seed.maskedCount,
        checked: false,
        failure: undefined,
        confirmDiscard: false,
      },
      "heading",
    );
  };

  const edit = (patch: Partial<TechniqueFormDraft>) => {
    if (state.form === undefined || pending) return;
    update({ form: { ...state.form, ...patch }, confirmDiscard: false });
  };

  // Back to the kept selection. Edits ask first.
  const discardDraft = () => {
    if (pending) return;
    update({ phase: "select", seed: undefined, form: undefined, checked: false, failure: undefined, confirmDiscard: false }, "review");
  };

  const cancelDraft = () => {
    if (pending || state.confirmDiscard) return;
    if (sameForm(state.form, state.seed)) discardDraft();
    else update({ confirmDiscard: true });
  };

  const keepEditing = () => update({ confirmDiscard: false }, "cancel");

  const submit = () => {
    if (!drafting || state.form === undefined || pending || archived || readOnly) return;
    const input = techniqueInputFromForm(state.form);
    const check = checkTechniqueInput(input);
    if (!check.ok) {
      update({ checked: true, failure: undefined, confirmDiscard: false });
      return;
    }
    const submittedOwner = owner;
    const serial = state.serial;
    // Only the draft this Save came from may take its answer.
    const current = (value: Authoring) =>
      ownerRef.current === submittedOwner && value.owner === submittedOwner && value.serial === serial && value.phase === "draft";
    const started = save.submit(input, {
      onSaved: (technique) => {
        if (!current(stateRef.current)) return;
        focusNext.current = "saved";
        setRaw((value) =>
          current(value)
            ? { ...value, phase: "saved", savedTechnique: technique, failure: undefined, checked: false, confirmDiscard: false }
            : value,
        );
      },
      onFailed: (failure, code) => {
        const message =
          failure === "owner"
            ? "The response named another engagement, so this save is not confirmed. The draft is kept. Check Advisor Techniques before saving again."
            : failure === "unknown"
              ? "The save outcome is unknown. The draft is kept. Check Advisor Techniques before saving again to avoid a duplicate."
              : code === "engagement_archived"
                ? "This engagement is archived. The draft is kept but cannot be saved."
                : code === "storage_busy"
                  ? "Storage is busy. The draft is kept. Retry when ready."
                  : "The technique was not saved. The draft is kept. Retry when ready.";
        setRaw((value) => (current(value) ? { ...value, failure: message } : value));
      },
    });
    if (started) update({ checked: true, failure: undefined, confirmDiscard: false });
  };

  // A new draft needs a new selection after a save.
  const done = () => update({ ...idle(owner, state.serial) }, "start");

  const problems = drafting && state.checked && state.form !== undefined ? checkTechniqueInput(techniqueInputFromForm(state.form)) : undefined;
  const stepProblems = new Map<string, Readonly<TechniqueStepProblem>>();
  if (problems !== undefined && !problems.ok && state.form !== undefined) {
    for (const [index, problem] of problems.problems.steps) {
      const step = state.form.steps[index];
      if (step !== undefined) stepProblems.set(step.key, problem);
    }
  }

  return {
    state,
    archived,
    readOnly,
    records,
    listedSelected,
    selecting,
    drafting,
    pending,
    problems: problems !== undefined && !problems.ok ? problems.problems : undefined,
    stepProblems,
    refs: { startRef, firstRef, reviewRef, headingRef, savedRef, cancelRef },
    nextKey,
    // Unsaved draft text, the save in flight, and a failed save.
    draft: {
      dirty: drafting,
      pending,
      failed: drafting && state.failure !== undefined,
    },
    // Rows keep their mark while the draft is open.
    marked: (attemptId: string) => (selecting || drafting) && state.selected.includes(attemptId),
    canStart: !archived && state.phase === "idle" && records.length > 0,
    start,
    toggle,
    cancelSelect,
    review,
    edit,
    cancelDraft,
    discardDraft,
    keepEditing,
    submit,
    done,
  };
}

export type LeadTechnique = ReturnType<typeof useLeadTechnique>;

export function LeadTechniqueStart({ technique }: { technique: LeadTechnique }) {
  if (!technique.canStart) return null;
  return (
    <Button
      ref={technique.refs.startRef}
      type="button"
      variant="secondary"
      className="min-h-11 md:min-h-11"
      onClick={technique.start}
    >
      Save as technique
    </Button>
  );
}

// One attempt row's selection box, only while selecting.
export function LeadTechniqueToggle({
  technique,
  attempt,
  first,
}: {
  technique: LeadTechnique;
  attempt: LeadAttempt;
  first: boolean;
}) {
  if (!technique.selecting) return null;
  const checked = technique.state.selected.includes(attempt.id);
  const full = technique.listedSelected.length >= LEAD_TECHNIQUE_SOURCES_MAX;
  return (
    <label className="flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center">
      <input
        ref={first ? technique.refs.firstRef : undefined}
        type="checkbox"
        checked={checked}
        disabled={!checked && full}
        className="size-4 accent-primary"
        onChange={() => technique.toggle(attempt.id)}
      />
      <span className="sr-only">Use attempt {attempt.sequence}</span>
    </label>
  );
}

// The selection bar, the draft, or the saved result under the history.
export function LeadTechniquePanel({ technique }: { technique: LeadTechnique }) {
  const { state } = technique;
  if (technique.selecting) return <SelectionBar technique={technique} />;
  if (technique.drafting && state.form !== undefined) return <DraftEditor technique={technique} form={state.form} />;
  if (state.phase === "saved" && state.savedTechnique !== undefined) {
    const saved = state.savedTechnique;
    return (
      <div ref={technique.refs.savedRef} tabIndex={-1} role="status" className="grid gap-2 border-t border-border pt-3 outline-none">
        <p className="m-0 text-[12px] leading-5 break-words">
          Saved &quot;{saved.name}&quot; to this engagement&apos;s techniques.
        </p>
        <ul className="m-0 grid list-none gap-2 p-0">
          <TechniqueCard technique={saved} facts={undefined} archived={technique.archived} />
        </ul>
        <div className="flex justify-end">
          <Button type="button" variant="secondary" className="min-h-11 md:min-h-11" onClick={technique.done}>
            Done
          </Button>
        </div>
      </div>
    );
  }
  return null;
}

function SelectionBar({ technique }: { technique: LeadTechnique }) {
  const { state } = technique;
  const count = technique.listedSelected.length;
  const sequences = technique.records
    .filter((attempt) => technique.listedSelected.includes(attempt.id))
    .map((attempt) => attempt.sequence)
    .sort((left, right) => left - right);
  return (
    <div role="group" aria-label="Technique sources" className="grid gap-2 border-t border-border pt-2">
      <p className="m-0 text-[12px] leading-5 text-muted-foreground" aria-live="polite">
        {count === 0
          ? "Select attempts to copy as steps, dead ends included. Only summaries are copied."
          : `${count} of ${LEAD_TECHNIQUE_SOURCES_MAX} selected: attempts ${sequences.join(", ")}.`}
      </p>
      {state.selectionProblem !== undefined ? (
        <p className="m-0 text-[12px] text-destructive" role="alert">
          {state.selectionProblem}
        </p>
      ) : null}
      {technique.readOnly ? (
        <p className="m-0 text-[12px] text-muted-foreground">Review waits until this lead reads again.</p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="secondary" className="min-h-11 md:min-h-11" onClick={technique.cancelSelect}>
          Cancel
        </Button>
        <TechniqueEditorButton
          ref={technique.refs.reviewRef}
          variant="primary"
          inert={count === 0 || technique.readOnly}
          onPress={technique.review}
        >
          {count === 0 ? "Review steps" : `Review ${count} ${count === 1 ? "step" : "steps"}`}
        </TechniqueEditorButton>
      </div>
    </div>
  );
}

function FieldProblem({ id, message }: { id: string; message: string | undefined }) {
  if (message === undefined) return null;
  return (
    <p id={id} className="m-0 text-[11px] text-destructive">
      {message}
    </p>
  );
}

function DraftEditor({ technique, form }: { technique: LeadTechnique; form: TechniqueFormDraft }) {
  const id = useId();
  const { state, problems, pending } = technique;
  const fields: TechniqueProblems["fields"] = problems?.fields ?? {};
  const locked = pending;
  const nameLength = Array.from(form.name.trim()).length;
  const nameProblem =
    fields.name ??
    (nameLength > TECHNIQUE_NAME_MAX_CHARS
      ? `${nameLength} of ${TECHNIQUE_NAME_MAX_CHARS} characters. Shorten before saving.`
      : undefined);
  const saveBlocked = technique.archived || technique.readOnly;
  const field = (name: keyof TechniqueFormDraft) => `${id}-${name}`;
  const described = (name: keyof TechniqueFormDraft, message: string | undefined) =>
    message === undefined ? {} : { "aria-invalid": true as const, "aria-describedby": `${field(name)}-problem` };

  return (
    <section aria-labelledby={`${id}-heading`} className="grid gap-3 border-t border-border pt-3">
      <h4 ref={technique.refs.headingRef} id={`${id}-heading`} tabIndex={-1} className="m-0 text-[12px] font-semibold outline-none">
        Technique draft
      </h4>
      <p className="m-0 text-[11px] leading-5 text-muted-foreground">
        Copied only the summaries of attempts {state.sources.join(", ")}.
        {state.maskedCount > 0
          ? ` ${state.maskedCount} copied ${state.maskedCount === 1 ? "text has" : "texts have"} masked values.`
          : ""}{" "}
        Known secret patterns and URL credentials show as [redacted]. Other secrets and client names are not
        detected, so review every step before saving.
      </p>

      <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={field("name")}>
        <span>Name</span>
        <input
          id={field("name")}
          value={form.name}
          readOnly={locked}
          autoComplete="off"
          className={TECHNIQUE_FIELD_CLASS}
          {...described("name", nameProblem)}
          onChange={(event) => technique.edit({ name: event.target.value })}
        />
      </label>
      <FieldProblem id={`${field("name")}-problem`} message={nameProblem} />

      <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={field("whenUseful")}>
        <span>When useful</span>
        <input
          id={field("whenUseful")}
          value={form.whenUseful}
          readOnly={locked}
          autoComplete="off"
          className={TECHNIQUE_FIELD_CLASS}
          {...described("whenUseful", fields.whenUseful)}
          onChange={(event) => technique.edit({ whenUseful: event.target.value })}
        />
      </label>
      <FieldProblem id={`${field("whenUseful")}-problem`} message={fields.whenUseful} />

      <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={field("prerequisites")}>
        <span>Prerequisites, one per line</span>
        <textarea
          id={field("prerequisites")}
          value={form.prerequisites}
          rows={2}
          readOnly={locked}
          spellCheck={false}
          className={`${TECHNIQUE_FIELD_CLASS} font-mono`}
          {...described("prerequisites", fields.prerequisites)}
          onChange={(event) => technique.edit({ prerequisites: event.target.value })}
        />
      </label>
      <FieldProblem id={`${field("prerequisites")}-problem`} message={fields.prerequisites} />

      <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={field("question")}>
        <span>Distinguishing question</span>
        <input
          id={field("question")}
          value={form.question}
          readOnly={locked}
          autoComplete="off"
          className={TECHNIQUE_FIELD_CLASS}
          {...described("question", fields.question)}
          onChange={(event) => technique.edit({ question: event.target.value })}
        />
      </label>
      <FieldProblem id={`${field("question")}-problem`} message={fields.question} />

      <div className="grid gap-2">
        <p className="m-0 text-[11px] text-muted-foreground">Procedure</p>
        <TechniqueStepsEditor
          idPrefix={id}
          steps={form.steps}
          problems={technique.stepProblems}
          locked={locked}
          nextKey={technique.nextKey}
          onChange={(steps) => technique.edit({ steps })}
        />
        <FieldProblem id={`${field("steps")}-problem`} message={fields.procedure} />
        <TechniquePlaceholderEditor
          idPrefix={id}
          steps={form.steps}
          locked={locked}
          onChange={(steps) => technique.edit({ steps })}
        />
      </div>

      <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={field("meaning")}>
        <span>How to read the result</span>
        <input
          id={field("meaning")}
          value={form.meaning}
          readOnly={locked}
          autoComplete="off"
          className={TECHNIQUE_FIELD_CLASS}
          {...described("meaning", fields.meaning)}
          onChange={(event) => technique.edit({ meaning: event.target.value })}
        />
      </label>
      <FieldProblem id={`${field("meaning")}-problem`} message={fields.meaning} />

      {problems !== undefined ? (
        <p className="m-0 text-[12px] text-destructive" role="alert">
          {fields.form ?? `Fix ${problems.messages.length} ${problems.messages.length === 1 ? "problem" : "problems"} before saving.`}
        </p>
      ) : null}
      {state.failure !== undefined ? (
        <p className="m-0 text-[12px] text-destructive" role="alert">
          {state.failure}
        </p>
      ) : null}
      {technique.archived ? (
        <p className="m-0 text-[12px] text-muted-foreground" role="status">
          This engagement is archived. The draft stays here but cannot be saved.
        </p>
      ) : technique.readOnly ? (
        <p className="m-0 text-[12px] text-muted-foreground">Save waits until this lead reads again.</p>
      ) : null}

      {state.confirmDiscard ? (
        <div className="grid gap-2 border border-border px-2.5 py-2" role="alert">
          <p className="m-0 text-[12px] text-foreground">Discard the technique edits? The selection stays.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" className="min-h-11 md:min-h-11" autoFocus onClick={technique.keepEditing}>
              Keep editing
            </Button>
            <Button type="button" variant="quiet" className="min-h-11 md:min-h-11" onClick={technique.discardDraft}>
              Discard
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        <TechniqueEditorButton ref={technique.refs.cancelRef} inert={pending} onPress={technique.cancelDraft}>
          Cancel
        </TechniqueEditorButton>
        <TechniqueEditorButton variant="primary" inert={pending || saveBlocked} onPress={technique.submit}>
          {pending ? "Saving" : state.failure !== undefined ? "Retry save" : "Save technique"}
        </TechniqueEditorButton>
      </div>
    </section>
  );
}
