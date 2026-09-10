import { TECHNIQUE_PLACEHOLDER_PATTERN } from "@blackglass/contracts";

/**
 * Pure technique rules (Stonehush STONE-7).
 * Placeholder replay, prerequisite matching with a stated reason, and the
 * supported-check classifier that keeps unsupported commands visually
 * separate from runnable actions. No storage, no transport, no secrets.
 */

export function extractTechniquePlaceholders(text: string): string[] {
  TECHNIQUE_PLACEHOLDER_PATTERN.lastIndex = 0;
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(TECHNIQUE_PLACEHOLDER_PATTERN)) {
    const name = match[1];
    if (name !== undefined && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  TECHNIQUE_PLACEHOLDER_PATTERN.lastIndex = 0;
  return names;
}

export interface FilledTemplate {
  readonly text: string;
  readonly missing: readonly string[];
}

// Replay a template with operator-supplied values. Provided placeholders
// are substituted everywhere; unprovided ones stay verbatim so the replay
// shows exactly what still needs a value. Missing names are reported so
// the UI can prompt for them instead of running a half-filled command.
export function fillTechniquePlaceholders(
  template: string,
  values: Readonly<Record<string, string>>,
): FilledTemplate {
  const missing: string[] = [];
  for (const name of extractTechniquePlaceholders(template)) {
    if (values[name] === undefined || values[name] === "") {
      missing.push(name);
    }
  }
  const text = template.replace(
    TECHNIQUE_PLACEHOLDER_PATTERN,
    (match: string, name: string) => {
      const value = values[name];
      return value === undefined || value === "" ? match : value;
    },
  );
  return { text, missing };
}

export interface TechniquePrereqMatch {
  readonly matched: boolean;
  readonly satisfied: readonly string[];
  readonly missing: readonly string[];
  readonly reason: string;
}

function normalizeFact(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

// Match technique prerequisites against recorded engagement facts (observed
// services, confirmed access, completed checks). A prerequisite is satisfied
// when a fact contains it verbatim after normalization; matching is
// deliberately literal so a technique never claims its context fits on a
// fuzzy guess. The reason names both sides so the operator sees why the
// technique does or does not apply.
export function matchTechniquePrereqs(
  prerequisites: readonly string[],
  facts: readonly string[],
): TechniquePrereqMatch {
  const normalizedFacts = facts.map(normalizeFact).filter((fact) => fact.length > 0);
  const satisfied: string[] = [];
  const missing: string[] = [];
  for (const prerequisite of prerequisites) {
    const needle = normalizeFact(prerequisite);
    const hit =
      needle.length > 0 &&
      normalizedFacts.some((fact) => fact.includes(needle));
    if (hit) satisfied.push(prerequisite);
    else missing.push(prerequisite);
  }
  const matched = missing.length === 0;
  const reason =
    prerequisites.length === 0
      ? "No prerequisites: this technique applies whenever its question matters."
      : matched
        ? `All ${satisfied.length} prerequisite${satisfied.length === 1 ? "" : "s"} observed: ${satisfied.join("; ")}.`
        : `Missing ${missing.length} prerequisite${missing.length === 1 ? "" : "s"}: ${missing.join("; ")}${satisfied.length > 0 ? ` (satisfied: ${satisfied.join("; ")})` : ""}.`;
  return { matched, satisfied, missing, reason };
}

const SHELL_METACHAR_PATTERN = /[;&|`$><\r\n]/;
const COMMAND_SUBSTITUTION_PATTERN = /\$\(/;

// A supported check is one runnable argv-style line: single line, bounded,
// no shell metacharacters or substitution, lowercase command head, and no
// trailing sentence punctuation. Anything else (prose, multi-step
// walkthroughs, pipelines, destructive chains) is unsupported and must
// render as plain text, never as a button that looks runnable. The
// classifier is deliberately conservative: an unsupported verdict only
// withholds the runnable affordance, while risk policy stays with the
// action system. Prefilled actions copy text only and never execute.
export function isSupportedCheck(command: string): boolean {
  const line = command.trim();
  if (line.length === 0 || line.length > 500) return false;
  if (SHELL_METACHAR_PATTERN.test(line)) return false;
  if (COMMAND_SUBSTITUTION_PATTERN.test(line)) return false;
  const [head, ...rest] = line.split(/\s+/);
  if (head === undefined || head.length === 0) return false;
  // Lowercase command head: prose sentences start capitalized ("Run this",
  // "First scan"), real tool words do not.
  if (!/^[a-z0-9][A-Za-z0-9_./-]*$/.test(head)) return false;
  // Trailing sentence punctuation on a multi-word line means prose, not a
  // command ("try the login form."). Single tokens keep their punctuation.
  if (rest.length > 0 && /[.:;!?]$/.test(line)) return false;
  // Reject prose sentences: a second sentence terminator after whitespace
  // means this is an explanation, not a command.
  if (rest.length > 0 && /\.\s+[A-Z]/.test(line)) return false;
  return true;
}
