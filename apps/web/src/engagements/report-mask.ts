import {
  EngagementNotesMarkdownSchema,
  FindingSchema,
  ReportEngagementMetaSchema,
  type ReportBundle,
} from "@stonehush/contracts";
import {
  ADVISOR_REDACTION_TOKEN,
  redactAdvisorText,
  stripAdvisorUrlUserinfo,
} from "@stonehush/domain";

// Derived sharing copy of a stored report bundle. Only operator-authored free
// text is transformed (engagement name/description/authorization context,
// finding title/body, notes); every id, digest, timestamp, count, and
// structured discovery row passes through untouched so the masked copy keeps
// its provenance. The stored bundle and query cache are never mutated:
// callers render, copy, and download from the returned copy. Masking is the
// existing heuristic advisor redactor, so it cannot guarantee every secret is
// removed. maskedFields counts changed text fields, not redactor hits, so a
// URL userinfo strip with zero secret hits still counts. Bounds come from the
// exported contract field schemas, never duplicated here: when a replacement
// would grow a field past its schema limit, the whole field becomes the
// redaction token instead of shipping an invalid export. The stored original
// stays one toggle away.
export interface MaskedReport {
  readonly bundle: ReportBundle;
  readonly maskedFields: number;
}

// Structural schema type so the web layer reuses contract bounds without
// taking a zod dependency.
interface FieldSchema {
  safeParse(value: unknown): { success: boolean };
}

const EngagementNameSchema: FieldSchema = ReportEngagementMetaSchema.shape.name;
const EngagementDescriptionSchema: FieldSchema =
  ReportEngagementMetaSchema.shape.description;
const EngagementAuthorizationSchema: FieldSchema =
  ReportEngagementMetaSchema.shape.authorizationContext;
const FindingTitleSchema: FieldSchema = FindingSchema.shape.title;
const FindingBodySchema: FieldSchema = FindingSchema.shape.body;
const NotesMarkdownSchema: FieldSchema = EngagementNotesMarkdownSchema;

function maskOperatorText(
  value: string,
  fieldSchema: FieldSchema,
  seen: { maskedFields: number },
): string {
  const masked = redactAdvisorText(stripAdvisorUrlUserinfo(value)).text;
  if (masked === value) return value;
  seen.maskedFields += 1;
  if (!fieldSchema.safeParse(masked).success) return ADVISOR_REDACTION_TOKEN;
  return masked;
}

export function maskReportBundle(bundle: ReportBundle): MaskedReport {
  const seen = { maskedFields: 0 };
  return {
    bundle: {
      ...bundle,
      engagement: {
        ...bundle.engagement,
        name: maskOperatorText(bundle.engagement.name, EngagementNameSchema, seen),
        description:
          bundle.engagement.description === null
            ? null
            : maskOperatorText(
                bundle.engagement.description,
                EngagementDescriptionSchema,
                seen,
              ),
        authorizationContext:
          bundle.engagement.authorizationContext === null
            ? null
            : maskOperatorText(
                bundle.engagement.authorizationContext,
                EngagementAuthorizationSchema,
                seen,
              ),
      },
      findings: bundle.findings.map((finding) => ({
        ...finding,
        title: maskOperatorText(finding.title, FindingTitleSchema, seen),
        body: maskOperatorText(finding.body, FindingBodySchema, seen),
      })),
      notesMarkdown: maskOperatorText(bundle.notesMarkdown, NotesMarkdownSchema, seen),
    },
    maskedFields: seen.maskedFields,
  };
}
