import { ADVISOR_EXCERPT_IDS_MAX } from "@stonehush/contracts";
import { Button } from "@stonehush/ui";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";

import { fetchAttemptEvidenceCatalog } from "../engagements/attempt-evidence.js";
import { maskCopiedText } from "../engagements/lead-technique-draft.js";
import { fetchLead, fetchLeadAttempts, fetchLeads } from "../engagements/leads-query.js";
import { copyTextToClipboard } from "../engagements/report-query.js";
import { attemptEvidenceCandidates, draftAttemptContext, selectedAttemptContext, validateAttemptContext } from "./lead-attempt-context.js";

const ACTION = "min-h-11 px-2 text-[12px] md:pointer-fine:min-h-8";
const FRESH_READ = { gcTime: 0, staleTime: 0, refetchOnMount: "always", retry: false } as const;

interface PickerProps {
  readonly engagementId: string;
  readonly archived: boolean;
  readonly excerpts: readonly string[];
  readonly onExcerptsChange: (ids: string[]) => void;
  readonly onInclude: (text: string) => void;
}

// Opening is an explicit metadata read. Nothing here fetches raw evidence,
// mutates a lead or sends an advisor request.
export function LeadAttemptContextPicker(props: PickerProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="grid min-w-0 gap-2">
      <Button type="button" variant="quiet" className={`${ACTION} justify-self-start`} aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Hide saved attempts" : "Use saved attempts"}
      </Button>
      {open ? <LeadPicker key={props.engagementId} {...props} /> : null}
    </div>
  );
}

function LeadPicker(props: PickerProps) {
  const readId = useId();
  const [leadId, setLeadId] = useState("");
  const query = useQuery({
    queryKey: ["advisor-context-leads", props.engagementId, readId],
    ...FRESH_READ,
    queryFn: async ({ signal }) => {
      const leads = await fetchLeads(props.engagementId, signal);
      if (leads.some((lead) => lead.engagementId !== props.engagementId) || new Set(leads.map((lead) => lead.id)).size !== leads.length) {
        throw new Error("Saved leads could not be read unambiguously.");
      }
      return leads;
    },
  });
  const fresh = !query.isFetching && !query.isError && query.isFetchedAfterMount;
  return (
    <section aria-label="Saved attempt context" className="grid min-w-0 gap-2 border-t border-border pt-2 text-[12px]">
      <label className="grid min-w-0 gap-1">
        <span>Saved lead</span>
        <select className="min-h-11 w-full min-w-0 border border-input bg-background px-2 text-foreground" value={leadId} disabled={!fresh} onChange={(event) => setLeadId(event.target.value)}>
          <option value="">Choose a lead</option>
          {(query.data ?? []).map((lead) => <option key={lead.id} value={lead.id}>{maskCopiedText(lead.title)} · {lead.disposition}</option>)}
        </select>
      </label>
      {query.isFetching ? <p className="m-0" role="status">Reading saved leads.</p> : null}
      {query.isError ? <div role="alert">Saved leads could not be refreshed. <Button type="button" variant="quiet" className={ACTION} onClick={() => void query.refetch()}>Retry leads</Button></div> : null}
      {fresh && query.data?.length === 0 ? <p className="m-0">No saved leads.</p> : null}
      <Button type="button" variant="quiet" className={`${ACTION} justify-self-start`} disabled={query.isFetching} onClick={() => void query.refetch()}>Refresh leads</Button>
      {leadId !== "" && fresh ? <AttemptPicker key={leadId} {...props} leadId={leadId} /> : null}
    </section>
  );
}

function AttemptPicker({ engagementId, leadId, archived, excerpts, onExcerptsChange, onInclude }: PickerProps & { readonly leadId: string }) {
  const readId = useId();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [copied, setCopied] = useState<string>();
  const query = useQuery({
    queryKey: ["advisor-context-attempts", engagementId, leadId, readId],
    ...FRESH_READ,
    queryFn: async ({ signal }) => {
      const [lead, attempts] = await Promise.all([fetchLead(engagementId, leadId, signal), fetchLeadAttempts(engagementId, leadId, signal)]);
      validateAttemptContext(engagementId, leadId, lead, attempts);
      return { lead, attempts };
    },
  });
  const fresh = !query.isFetching && !query.isError && query.isFetchedAfterMount;
  const source = query.data;
  const selected = fresh && source !== undefined ? selectedAttemptContext(source.lead, source.attempts, selectedIds) : undefined;
  const context = selected === undefined || source === undefined ? undefined : draftAttemptContext(source.lead, selected);
  const catalog = useQuery({
    queryKey: ["advisor-context-evidence", engagementId, leadId, readId],
    ...FRESH_READ,
    enabled: selected !== undefined,
    queryFn: ({ signal }) => fetchAttemptEvidenceCatalog(engagementId, signal),
  });
  const evidenceFresh = !catalog.isFetching && !catalog.isError && catalog.isFetchedAfterMount;
  const candidates = selected === undefined || !evidenceFresh || catalog.data === undefined ? [] : attemptEvidenceCandidates(selected, catalog.data.rows);
  return (
    <div className="grid min-w-0 gap-2">
      {query.isFetching ? <p className="m-0" role="status">Reading this lead and its attempts.</p> : null}
      {query.isError ? <p className="m-0" role="alert">This lead or its attempts could not be refreshed. The question stays unchanged.</p> : null}
      <Button type="button" variant="quiet" className={`${ACTION} justify-self-start`} disabled={query.isFetching} onClick={() => void query.refetch()}>Refresh attempts</Button>
      {source !== undefined ? <>
        <p className="m-0 break-words">Saved question: {maskCopiedText(source.lead.title)}</p>
        <p className="m-0">Disposition: {source.lead.disposition}</p>
        {source.lead.parkReason !== null ? <p className="m-0 break-words">Parked reason: {maskCopiedText(source.lead.parkReason)}</p> : null}
        {source.lead.testedConditions !== null ? <p className="m-0 break-words">Lead tested conditions: {maskCopiedText(source.lead.testedConditions)}</p> : null}
        {source.lead.nextStep !== null ? <p className="m-0 break-words">Saved next step: {maskCopiedText(source.lead.nextStep)}</p> : null}
        {source.lead.closedNote !== null ? <p className="m-0 break-words">Closed note: {maskCopiedText(source.lead.closedNote)}</p> : null}
        {!fresh ? <p className="m-0" role="status">Showing the last read. Refresh before including context.</p> : null}
        <div role="group" aria-label="Recorded attempts" className="grid min-w-0 gap-1">
          {[...source.attempts].sort((a, b) => a.sequence - b.sequence).map((attempt) => (
            <label key={attempt.id} className="flex min-h-11 min-w-0 items-start gap-2 border-t border-border py-2">
              <input type="checkbox" className="mt-1 shrink-0" disabled={!fresh} checked={selectedIds.includes(attempt.id)} onChange={() => { setCopied(undefined); setSelectedIds((ids) => ids.includes(attempt.id) ? ids.filter((id) => id !== attempt.id) : [...ids, attempt.id]); }} />
              <span className="min-w-0 break-words"><span className="block font-semibold">Attempt {attempt.sequence}: {attempt.outcome.replaceAll("_", " ")}</span>{maskCopiedText(attempt.summary)}<span className="block">Recorded conditions: {attempt.conditions === null ? "unknown" : maskCopiedText(attempt.conditions)}</span></span>
            </label>
          ))}
        </div>
        {fresh && source.attempts.length === 0 ? <p className="m-0">No saved attempts.</p> : null}
        {fresh && selectedIds.length > 0 && selected === undefined ? <p className="m-0" role="alert">A selected attempt is unavailable. Choose the remaining attempts again.</p> : null}
      </> : null}
      {context !== undefined ? <>
        <pre aria-label="Selected attempt context" className="m-0 min-w-0 whitespace-pre-wrap break-words font-mono text-[11px] leading-5">{context}</pre>
        <p className="m-0 text-[11px]">Known secret shapes and URL credentials are masked. Review the text; masking cannot detect every secret.</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" className={ACTION} disabled={archived} onClick={() => onInclude(context)}>Include selected attempts</Button>
          <Button type="button" variant="quiet" className={ACTION} onClick={async () => setCopied(await copyTextToClipboard(context) ? "Selected context copied." : "Copy failed. Select the preview text to copy manually.")}>Copy selected context</Button>
        </div>
        {copied !== undefined ? <p className="m-0" role="status">{copied}</p> : null}
        <div role="group" aria-label="Attempt evidence" className="grid gap-1">
          <p className="m-0 font-semibold">Choose evidence separately</p>
          {catalog.isFetching ? <p className="m-0" role="status">Checking published evidence.</p> : null}
          {catalog.isError ? <p className="m-0" role="alert">Published evidence could not be refreshed. No candidates available.</p> : null}
          <Button type="button" variant="quiet" className={`${ACTION} justify-self-start`} disabled={catalog.isFetching} onClick={() => void catalog.refetch()}>Refresh evidence</Button>
          {evidenceFresh && catalog.data?.truncated ? <p className="m-0">The catalog is capped. References not listed are unavailable here.</p> : null}
          {evidenceFresh && candidates.length === 0 ? <p className="m-0">Selected attempts have no saved artifact references.</p> : null}
          {candidates.map(({ id, artifact, sequences }) => artifact === undefined ? <p key={id} className="m-0 break-all">Attempt {sequences.join(", ")} · {id}: unavailable in this catalog.</p> : (
            <label key={id} className="flex min-h-11 min-w-0 items-center gap-2">
              <input type="checkbox" checked={excerpts.includes(id)} disabled={archived || (!excerpts.includes(id) && new Set(excerpts).size >= ADVISOR_EXCERPT_IDS_MAX)} onChange={() => onExcerptsChange(excerpts.includes(id) ? excerpts.filter((entry) => entry !== id) : [...new Set([...excerpts, id])])} />
              <span className="min-w-0 break-all">Attempt {sequences.join(", ")} · {artifact.kind} · run {artifact.runId} · {id}</span>
            </label>
          ))}
        </div>
      </> : null}
    </div>
  );
}
