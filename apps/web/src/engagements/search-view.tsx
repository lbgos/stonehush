import type { EngagementSearchResponse } from "@stonehush/contracts";
import { LoadingRegion, RecoverableError, Skeleton } from "@stonehush/ui";
import { useState } from "react";

import { useEngagementSearchQuery } from "./search-query.js";

/**
 * STONE-6 standalone search view. Ships as a new file and mounts via the
 * STONE-2 `engagement.search` extension slot after STONE-2 merges.
 * Grouped by type with a snippet that opens the exact context via the
 * result anchor. Unindexed kinds are labeled, secrets never appear.
 */

const KIND_ORDER = ["target", "hostname", "note", "lead", "finding", "artifact", "excerpt"] as const;

export function SearchResultGroups({
  response,
  onOpen,
}: {
  response: EngagementSearchResponse;
  onOpen: (anchor: string) => void;
}) {
  return (
    <div className="grid gap-3">
      {KIND_ORDER.map((kind) => {
        const results = response.groups[kind] ?? [];
        if (results.length === 0) return null;
        return (
          <div key={kind} className="grid gap-1">
            <h3 className="m-0 text-[12px] font-semibold capitalize text-foreground">{kind}</h3>
            <ul className="m-0 list-none space-y-1 p-0">
              {results.map((result) => (
                <li key={`${result.kind}:${result.id}:${result.anchor}`}>
                  <button
                    type="button"
                    onClick={() => onOpen(result.anchor)}
                    className="block w-full cursor-pointer rounded-[10px] border border-border bg-background px-2 py-1.5 text-left"
                  >
                    <span className="block truncate text-[12px] font-medium text-foreground">{result.title}</span>
                    <span className="block truncate font-mono text-[11px] text-muted-foreground">{result.snippet}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {response.unindexedKinds.length > 0 ? (
        <p className="m-0 text-[11px] leading-5 text-muted-foreground">
          Not indexed in this view: {response.unindexedKinds.join(", ")}. Names above still search; full text does not.
        </p>
      ) : null}
    </div>
  );
}

export function EngagementSearchView({
  engagementId,
  onOpenAnchor,
}: {
  engagementId: string;
  onOpenAnchor: (anchor: string) => void;
}) {
  const [query, setQuery] = useState("");
  const search = useEngagementSearchQuery(engagementId, query);
  const active = query.trim().length >= 2;

  return (
    <section aria-label="Engagement search" className="overflow-hidden rounded-[10px] border border-border bg-card">
      <div className="flex min-h-10 items-center justify-between border-b border-border px-3">
        <h2 className="m-0 text-[13px] font-semibold">Search</h2>
        <span className="hidden text-[11px] text-muted-foreground sm:inline">Targets, notes, findings, evidence</span>
      </div>
      <div className="grid gap-3 p-3">
        <input
          type="search"
          aria-label="Search this engagement"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search targets, notes, findings, evidence"
          className="h-9 w-full rounded-[10px] border border-border bg-background px-2 text-[12px] text-foreground"
        />
        {active && search.isFetching && search.data === undefined ? (
          <LoadingRegion label="Searching" className="space-y-2">
            <Skeleton className="h-8 w-full" />
          </LoadingRegion>
        ) : null}
        {active && search.isError ? (
          <RecoverableError title="Search is unavailable." description="The search request failed." onRetry={() => void search.refetch()} />
        ) : null}
        {active && search.data !== undefined ? (
          <SearchResultGroups response={search.data} onOpen={onOpenAnchor} />
        ) : null}
        {active === false ? (
          <p className="m-0 text-[12px] leading-5 text-muted-foreground">Type at least 2 characters to search.</p>
        ) : null}
      </div>
    </section>
  );
}
