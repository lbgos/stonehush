import type { Finding } from "@blackglass/contracts";

/**
 * Report outline selection model (STONE-7).
 * The outline assembles selected findings, leads, and evidence into an
 * ordered, reorderable plan without moving investigation records: every
 * operation returns a new outline and never mutates its inputs. Two
 * intentions share the same selection: the CTF writeup and the assessment
 * report templates differ only in section order and headings. Leads use a
 * narrow structural reference so the STONE-4 lead API can wire in later.
 */

export const OUTLINE_TEMPLATES = ["ctf-writeup", "assessment"] as const;

export type OutlineTemplate = (typeof OUTLINE_TEMPLATES)[number];

export const OUTLINE_ITEM_KINDS = ["finding", "lead", "evidence", "note"] as const;

export type OutlineItemKind = (typeof OUTLINE_ITEM_KINDS)[number];

export interface OutlineItem {
  readonly key: string;
  readonly kind: OutlineItemKind;
  readonly refId: string;
  readonly caption: string;
}

export interface ReportOutline {
  readonly template: OutlineTemplate;
  readonly items: readonly OutlineItem[];
}

export function outlineKey(kind: OutlineItemKind, refId: string): string {
  return `${kind}:${refId}`;
}

export function createOutline(template: OutlineTemplate = "ctf-writeup"): ReportOutline {
  return { template, items: [] };
}

export function setOutlineTemplate(
  outline: ReportOutline,
  template: OutlineTemplate,
): ReportOutline {
  return { template, items: outline.items };
}

export function addOutlineItem(
  outline: ReportOutline,
  item: Omit<OutlineItem, "key">,
): ReportOutline {
  const key = outlineKey(item.kind, item.refId);
  if (outline.items.some((entry) => entry.key === key)) return outline;
  return { template: outline.template, items: [...outline.items, { ...item, key }] };
}

export function removeOutlineItem(outline: ReportOutline, key: string): ReportOutline {
  return {
    template: outline.template,
    items: outline.items.filter((entry) => entry.key !== key),
  };
}

// Reorder by index move only. The underlying findings, leads, and evidence
// records are never touched: only the outline order changes.
export function moveOutlineItem(
  outline: ReportOutline,
  key: string,
  toIndex: number,
): ReportOutline {
  const fromIndex = outline.items.findIndex((entry) => entry.key === key);
  if (fromIndex === -1) return outline;
  const clamped = Math.max(0, Math.min(toIndex, outline.items.length - 1));
  if (clamped === fromIndex) return outline;
  const items = [...outline.items];
  const [moved] = items.splice(fromIndex, 1);
  if (moved === undefined) return outline;
  items.splice(clamped, 0, moved);
  return { template: outline.template, items };
}

export interface OutlineMaterial {
  readonly findings: readonly Finding[];
  readonly evidence: readonly { readonly artifactId: string; readonly digest: string }[];
  readonly notesMarkdown: string;
}

const TEMPLATE_SECTIONS: Record<OutlineTemplate, readonly string[]> = {
  "ctf-writeup": ["Summary", "Findings", "Reproduction", "Evidence", "Notes"],
  assessment: ["Executive summary", "Methodology", "Findings", "Evidence", "Appendix"],
};

export function outlineSections(template: OutlineTemplate): readonly string[] {
  return TEMPLATE_SECTIONS[template];
}

function findingById(
  findings: readonly Finding[],
  refId: string,
): Finding | undefined {
  return findings.find((finding) => finding.id === refId);
}

// Deterministic outline Markdown. Selected evidence links as
// ./assets/<artifactId> when asset links are enabled; with links off the
// entries stay as digest-only text. Raw artifact bytes are never embedded
// in the Markdown either way: links point at the export bundle layout,
// where bytes land only through an explicit separate step.
export function renderOutlineMarkdown(
  material: OutlineMaterial,
  outline: ReportOutline,
  options?: { assetLinks?: boolean },
): string {
  const assetLinks = options?.assetLinks ?? true;
  const lines: string[] = [];
  const findings = outline.items.filter((item) => item.kind === "finding");
  const leads = outline.items.filter((item) => item.kind === "lead");
  const evidence = outline.items.filter((item) => item.kind === "evidence");
  const notes = outline.items.filter((item) => item.kind === "note");
  for (const section of outlineSections(outline.template)) {
    lines.push(`## ${section}`);
    lines.push("");
    if (section === "Summary" || section === "Executive summary") {
      lines.push(
        findings.length === 0 && leads.length === 0
          ? "_No findings or leads selected._"
          : `${findings.length} finding${findings.length === 1 ? "" : "s"}, ${leads.length} lead${leads.length === 1 ? "" : "s"} selected.`,
      );
      lines.push("");
    } else if (section === "Findings") {
      if (findings.length === 0 && leads.length === 0) {
        lines.push("_No findings or leads selected._");
        lines.push("");
      }
      for (const item of findings) {
        const finding = findingById(material.findings, item.refId);
        lines.push(
          finding === undefined
            ? `### ${item.caption} (missing: ${item.refId})`
            : `### [${finding.severity}] ${finding.title}`,
        );
        lines.push("");
        lines.push(
          finding === undefined
            ? "_Selected finding is no longer available._"
            : finding.body.length > 0
              ? finding.body
              : "_No detail._",
        );
        lines.push("");
      }
      for (const item of leads) {
        lines.push(`### Lead: ${item.caption}`);
        lines.push("");
        lines.push(`_Lead reference ${item.refId}; resolve through the lead record._`);
        lines.push("");
      }
    } else if (section === "Reproduction" || section === "Methodology") {
      lines.push(
        findings.length === 0
          ? "_No reproduction steps selected._"
          : "_Reproduce each finding above in order before writing this section._",
      );
      lines.push("");
    } else if (section === "Evidence") {
      if (evidence.length === 0) {
        lines.push("_No evidence selected._");
        lines.push("");
      }
      for (const item of evidence) {
        const digest = material.evidence.find(
          (entry) => entry.artifactId === item.refId,
        )?.digest;
        const suffix = digest === undefined ? "" : ` ${digest}`;
        lines.push(
          assetLinks
            ? `- [${item.caption}](./assets/${item.refId})${suffix}`
            : `- ${item.caption} (digest-only${suffix})`,
        );
      }
      if (evidence.length > 0) lines.push("");
    } else {
      lines.push(
        notes.length === 0
          ? "_No notes selected._"
          : material.notesMarkdown.length > 0
            ? material.notesMarkdown
            : "_No notes._",
      );
      lines.push("");
    }
  }
  return `${lines.join("\n")}`;
}
