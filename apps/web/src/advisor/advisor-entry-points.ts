/**
 * Advisor entry points (STONE-7).
 * Three ways into the existing selected-evidence conversation: Explain this
 * (observation/excerpt), Distinguish possibilities (lead), Overlooked angles
 * (investigation). These builders only shape the operator question sent with
 * explicitly selected evidence; transport, storage, citation, redaction, and
 * budget semantics stay exactly as the advisor turn route implements them.
 * Nothing here adds ambient context: the question carries no scratchpad,
 * credentials, or history.
 */

export const ADVISOR_ENTRY_POINTS = ["explain", "distinguish", "overlook"] as const;

export type AdvisorEntryPoint = (typeof ADVISOR_ENTRY_POINTS)[number];

export const ADVISOR_ENTRY_POINT_LABELS: Record<AdvisorEntryPoint, string> = {
  explain: "Explain this",
  distinguish: "Distinguish possibilities",
  overlook: "What am I overlooking",
};

const INTERPOLATION_MAX_CHARS = 500;

function clip(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (Array.from(trimmed).length <= INTERPOLATION_MAX_CHARS) return trimmed;
  return `${Array.from(trimmed).slice(0, INTERPOLATION_MAX_CHARS).join("")}...`;
}

export interface DistinguishInput {
  readonly possibilities: readonly string[];
}

export interface OverlookInput {
  readonly investigation: string;
}

// Explain-this grounds on one observation or excerpt the operator names.
// The answer must cite the selected evidence; the question itself stays a
// single focused ask so depth 0 never becomes a walkthrough.
export function buildExplainQuestion(observation: string): string {
  const focus = clip(observation);
  if (focus.length === 0) {
    return "Explain what the selected evidence shows and what remains uncertain.";
  }
  return `Explain this observation from the selected evidence: ${focus} What does it show and what remains uncertain?`;
}

// Distinguish asks what evidence would separate the given possibilities.
// Few relevant possibilities: more than three are clipped to the first
// three so the model compares instead of enumerating.
export function buildDistinguishQuestion(input: DistinguishInput): string {
  const options = input.possibilities
    .map((possibility) => clip(possibility))
    .filter((possibility) => possibility.length > 0)
    .slice(0, 3);
  if (options.length < 2) {
    return "What evidence would distinguish the possible explanations of the selected evidence?";
  }
  return `What would distinguish between these possibilities in the selected evidence: ${options.join(" vs ")}? Name the discriminating check for each.`;
}

// Overlook asks for missing angles on the current investigation, scoped to
// recorded material. The investigation summary is operator-supplied context
// for this question only, never a dump of ambient state.
export function buildOverlookQuestion(input: OverlookInput): string {
  const focus = clip(input.investigation);
  if (focus.length === 0) {
    return "Given the selected evidence only, what am I overlooking? Name one missing angle.";
  }
  return `Investigating ${focus}. Given the selected evidence only, what am I overlooking? Name one missing angle.`;
}
