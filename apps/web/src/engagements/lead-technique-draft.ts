import {
  TECHNIQUE_PROCEDURE_STEPS_MAX,
  type Lead,
  type LeadAttempt,
} from "@stonehush/contracts";
import { redactAdvisorText, stripAdvisorUrlUserinfo } from "@stonehush/domain";

import type { TechniqueFormDraft, TechniqueStepDraft } from "../advisor/technique-editor.js";

// Local technique drafting from recorded lead attempts. The operator picks
// exact saved attempts; only their summaries are copied, one prose step
// each, after the existing heuristic secret masking. Outcomes and conditions
// stay source context beside the step and are never copied into the draft.
// Question, applicability, prerequisites and meaning start empty for the
// operator to write. Nothing here posts, fetches or runs anything.

export const LEAD_TECHNIQUE_SOURCES_MAX = TECHNIQUE_PROCEDURE_STEPS_MAX;

export type SourceSelection =
  | { readonly ok: true; readonly attempts: readonly LeadAttempt[] }
  | { readonly ok: false; readonly message: string };

// Resolve selected attempt ids against the attempts listed for this exact
// lead. Rejects instead of guessing: no selection, too many, a repeated id,
// an id not listed once, an attempt owned by another engagement or lead, or
// a sequence number that names more than one listed attempt. Any recorded
// outcome is allowed. The result is in ascending saved sequence.
export function resolveSourceAttempts(
  engagementId: string,
  leadId: string,
  listed: readonly LeadAttempt[],
  selectedIds: readonly string[],
): SourceSelection {
  if (selectedIds.length === 0) {
    return { ok: false, message: "Select at least one attempt." };
  }
  if (selectedIds.length > LEAD_TECHNIQUE_SOURCES_MAX) {
    return { ok: false, message: `Select at most ${LEAD_TECHNIQUE_SOURCES_MAX} attempts. A technique holds ${LEAD_TECHNIQUE_SOURCES_MAX} steps.` };
  }
  if (new Set(selectedIds).size !== selectedIds.length) {
    return { ok: false, message: "An attempt is selected twice. Select again." };
  }
  const chosen: LeadAttempt[] = [];
  for (const id of selectedIds) {
    const matches = listed.filter((attempt) => attempt.id === id);
    const attempt = matches[0];
    if (matches.length !== 1 || attempt === undefined) {
      return { ok: false, message: "A selected attempt is no longer listed once for this lead. Select again." };
    }
    if (attempt.engagementId !== engagementId || attempt.leadId !== leadId) {
      return { ok: false, message: "A selected attempt belongs to another lead. Select again." };
    }
    chosen.push(attempt);
  }
  for (const attempt of chosen) {
    if (listed.filter((other) => other.sequence === attempt.sequence).length !== 1) {
      return { ok: false, message: `Attempt ${attempt.sequence} is listed more than once. Refresh the attempts before drafting.` };
    }
  }
  return { ok: true, attempts: [...chosen].sort((left, right) => left.sequence - right.sequence) };
}

// The same heuristic masking report sharing uses: URL userinfo first, then
// known secret shapes. It cannot recognize every secret or client name.
export function maskCopiedText(value: string): string {
  return redactAdvisorText(stripAdvisorUrlUserinfo(value)).text;
}

export interface LeadTechniqueSeed {
  readonly form: TechniqueFormDraft;
  // Copied texts the masking changed, counting the name and each summary.
  readonly maskedCount: number;
}

// Build the editable draft. Each summary becomes one step instruction as
// typed after masking: blank lines, `$` lines, shell syntax and markup stay
// prose inside that one instruction, and no command is ever filled. Nothing
// is clipped; an overlong title or summary stays whole for the operator to
// shorten before Save.
export function seedLeadTechnique(
  lead: Lead,
  attempts: readonly LeadAttempt[],
  outcomeLabel: (outcome: LeadAttempt["outcome"]) => string,
  nextKey: () => string,
): LeadTechniqueSeed {
  let maskedCount = 0;
  const mask = (value: string): string => {
    const masked = maskCopiedText(value);
    if (masked !== value) maskedCount += 1;
    return masked;
  };
  const name = mask(lead.title);
  const steps: TechniqueStepDraft[] = attempts.map((attempt) => {
    const conditions = attempt.conditions === null ? "" : ` (${maskCopiedText(attempt.conditions)})`;
    const note = `From attempt ${attempt.sequence}: ${outcomeLabel(attempt.outcome)}${conditions}`;
    return { key: nextKey(), instruction: mask(attempt.summary), command: "", note };
  });
  return {
    form: { name, whenUseful: "", prerequisites: "", question: "", meaning: "", steps },
    maskedCount,
  };
}
