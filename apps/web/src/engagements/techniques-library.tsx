import type { Technique } from "@stonehush/contracts";
import { Button, LoadingRegion, RecoverableError, Skeleton, StaleDataState } from "@stonehush/ui";
import { useEffect, useMemo, useState } from "react";

import { TechniqueCard } from "../advisor/technique-panel.js";
import { useTechniquesQuery } from "../advisor/technique-query.js";
import { useFindingsQuery } from "./findings-query.js";

// Engagement-local Techniques library. Reads the existing engagement-scoped
// GET techniques through the shared query and replays with the shared card.
// Filtering is local over name, question, and procedure text. Placeholders
// stay verbatim until the operator fills them for one replay copy. Nothing
// here posts runs, calls a model, or reads raw evidence.
const filterCache = new Map<string, string>();

// Reset the per-engagement filter memory. Tests only: keeps one test's
// search text from leaking into the next render of the same engagement.
export function clearTechniqueFilterCache(): void {
  filterCache.clear();
}

export function filterTechniques(
  techniques: readonly Technique[],
  query: string,
): readonly Technique[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return techniques;
  return techniques.filter((technique) => {
    const procedureText = technique.procedure
      .map((step) => (step.command === undefined ? step.instruction : `${step.instruction} ${step.command}`))
      .join(" ");
    return `${technique.name} ${technique.question} ${procedureText}`.toLowerCase().includes(needle);
  });
}

export function EngagementTechniquesSection({
  engagementId,
  archived,
}: {
  engagementId: string;
  archived: boolean;
}) {
  const techniques = useTechniquesQuery(engagementId);
  const findings = useFindingsQuery(engagementId);
  const [query, setQuery] = useState(() => filterCache.get(engagementId) ?? "");
  useEffect(() => {
    setQuery(filterCache.get(engagementId) ?? "");
  }, [engagementId]);

  function updateQuery(next: string) {
    filterCache.set(engagementId, next);
    setQuery(next);
  }

  // Recorded engagement facts for matching: finding titles only. While
  // findings are loading, failed, or stale after a failed refresh, facts
  // stay unknown so cards state that plainly instead of claiming a verdict
  // from outdated titles.
  const facts = useMemo(() => {
    if (findings.data === undefined || findings.isError) return undefined;
    return findings.data.map((finding) => finding.title);
  }, [findings.data, findings.isError]);

  const filtered = useMemo(
    () => (techniques.data === undefined ? undefined : filterTechniques(techniques.data, query)),
    [techniques.data, query],
  );

  const retry = () => void techniques.refetch();
  const trimmed = query.trim();
  const total = techniques.data?.length ?? 0;

  return (
    <section aria-label="Techniques" className="mt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="m-0 text-[13px] font-semibold">Techniques</h2>
        {techniques.data !== undefined ? (
          <p className="m-0 font-mono text-[11px] text-muted-foreground">
            {total} saved
          </p>
        ) : null}
      </div>
      <p className="mt-1 mb-0 text-[12px] text-muted-foreground">
        Saved procedures for this engagement. Fill placeholders and copy one replay. No runs and no model calls.
      </p>
      {archived ? (
        <p className="mt-1 mb-0 text-[12px] text-muted-foreground" role="status">
          Archived engagements are read-only. Saved procedures stay readable.
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="grid min-w-0 flex-1 gap-1 text-[12px]" htmlFor="techniques-filter">
          <span className="font-semibold">Search techniques</span>
          <input
            id="techniques-filter"
            value={query}
            onChange={(event) => updateQuery(event.target.value)}
            placeholder="Name, question, or procedure text"
            autoComplete="off"
            spellCheck={false}
            className="min-h-11 w-full rounded-md border border-input bg-transparent px-2.5 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        {query.length > 0 ? (
          <Button type="button" variant="secondary" className="min-h-11" onClick={() => updateQuery("")}>
            Clear
          </Button>
        ) : null}
      </div>

      {techniques.data === undefined && techniques.isFetching ? (
        <LoadingRegion label="Loading techniques" className="mt-4 space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </LoadingRegion>
      ) : null}

      {techniques.data === undefined && techniques.isError ? (
        <div className="mt-4">
          <RecoverableError
            title="Techniques unavailable"
            description="The techniques list could not be loaded from the local control plane."
            onRetry={retry}
          />
        </div>
      ) : null}

      {filtered !== undefined && techniques.data !== undefined && techniques.isError ? (
        <div className="mt-4">
          <StaleDataState
            title="Showing saved techniques"
            description="The latest refresh failed. Existing techniques are still available."
            onRetry={retry}
          >
            {filtered.length > 0 ? (
              <TechniqueList techniques={filtered} facts={facts} archived={archived} />
            ) : (
              <EmptyResults total={total} trimmed={trimmed} onClear={() => updateQuery("")} />
            )}
          </StaleDataState>
        </div>
      ) : null}

      {filtered !== undefined && !(techniques.data !== undefined && techniques.isError) ? (
        <div className="mt-3">
          {filtered.length === 0 ? (
            <EmptyResults total={total} trimmed={trimmed} onClear={() => updateQuery("")} />
          ) : null}
          {filtered.length > 0 ? (
            <TechniqueList techniques={filtered} facts={facts} archived={archived} />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

// Empty and filtered-empty copy shared by the normal and stale branches so
// a failed refresh over an empty or fully filtered list still explains the
// results instead of rendering an empty list under the warning.
function EmptyResults({
  total,
  trimmed,
  onClear,
}: {
  total: number;
  trimmed: string;
  onClear: () => void;
}) {
  if (total === 0 && trimmed.length === 0) {
    return (
      <p className="m-0 text-[12px] text-muted-foreground" role="status">
        No saved techniques yet. Save a useful lead sequence; it stays in this engagement after reload.
      </p>
    );
  }
  return <FilteredEmpty total={total} trimmed={trimmed} onClear={onClear} />;
}

function FilteredEmpty({
  total,
  trimmed,
  onClear,
}: {
  total: number;
  trimmed: string;
  onClear: () => void;
}) {
  if (!(total > 0 || trimmed.length > 0)) return null;
  return (
    <div className="grid gap-2">
      <p className="m-0 text-[12px] text-muted-foreground" role="status">
        {trimmed.length > 0
          ? `No techniques match "${trimmed}".`
          : "No techniques match this filter."}
      </p>
      {trimmed.length > 0 ? (
        <div>
          <Button type="button" variant="secondary" className="min-h-11" onClick={onClear}>
            Clear search
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function TechniqueList({
  techniques,
  facts,
  archived,
}: {
  techniques: readonly Technique[];
  facts: readonly string[] | undefined;
  archived: boolean;
}) {
  return (
    <ul className="m-0 list-none space-y-2 p-0">
      {techniques.map((technique) => (
        <TechniqueCard key={technique.id} technique={technique} facts={facts} archived={archived} />
      ))}
    </ul>
  );
}
