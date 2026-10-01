import {
  ENGAGEMENT_SEARCH_MAX_PER_GROUP,
  ENGAGEMENT_SEARCH_QUERY_MAX_CHARS,
  type EngagementSearchResult,
} from "@stonehush/contracts";
import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";

import {
  highlightMatch,
  parseSearchInput,
  parseSearchTarget,
  SEARCH_QUERY_MIN_CODE_POINTS,
  type HighlightedText,
  type SearchTarget,
} from "./search-destination.js";
import {
  ENGAGEMENT_SEARCH_DEBOUNCE_MS,
  useDebouncedValue,
  useEngagementSearchQuery,
} from "./search-query.js";

// Search notes and findings: a compact workspace dialog over the engagement
// search endpoint. Only the note and finding groups render; the endpoint's
// other kinds lack exact destinations and stay out of this dialog. Choosing
// a result hands an exact target to the workspace, which opens Notes or
// Findings at that passage or finding.

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const CONTROL =
  "inline-flex min-h-11 items-center rounded-md px-3 text-[13px] font-semibold text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring";

export interface SearchSelection {
  readonly query: string;
  readonly result: EngagementSearchResult;
  readonly target: SearchTarget;
}

export interface EngagementSearchDialogProps {
  readonly engagementId: string;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly onClose: () => void;
  readonly onSelect: (selection: SearchSelection) => void;
}

export function EngagementSearchDialog({
  engagementId,
  query,
  onQueryChange,
  onClose,
  onSelect,
}: EngagementSearchDialogProps) {
  const titleId = useId();
  const statusId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const input = parseSearchInput(query);
  const requested = input.status === "ready" ? input.query : null;
  const settled = useDebouncedValue(requested, ENGAGEMENT_SEARCH_DEBOUNCE_MS);
  const search = useEngagementSearchQuery(engagementId, settled);
  // Results show only for the query in the input, never a superseded one.
  const current = requested !== null && settled === requested;
  const data = current && !search.isFetching && !search.isError && search.data?.query === requested && search.data.engagementId === engagementId ? search.data : undefined;
  const notes = data?.groups.note ?? [];
  const findings = data?.groups.finding ?? [];

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  const resultButtons = () =>
    Array.from(resultsRef.current?.querySelectorAll<HTMLButtonElement>("button[data-search-result]:not([disabled])") ?? []);

  const select = (result: EngagementSearchResult) => {
    const target = parseSearchTarget(result);
    if (target === null || data === undefined) return;
    onSelect({ query: data.query, result, target });
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      const first = resultButtons()[0];
      if (first === undefined) return;
      event.preventDefault();
      first.focus();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const first = [...notes, ...findings].find((result) => parseSearchTarget(result) !== null);
      if (first !== undefined) select(first);
    }
  };

  const onResultKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const buttons = resultButtons();
    const index = buttons.indexOf(event.currentTarget);
    const next = event.key === "ArrowDown" ? buttons[index + 1] : buttons[index - 1];
    (next ?? (event.key === "ArrowUp" ? inputRef.current : undefined))?.focus();
  };

  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const root = dialogRef.current;
    if (!root) return;
    const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  let status: ReactNode;
  if (input.status === "short") {
    status = `Type ${SEARCH_QUERY_MIN_CODE_POINTS} or more characters.`;
  } else if (input.status === "long") {
    status = `Use ${ENGAGEMENT_SEARCH_QUERY_MAX_CHARS} characters or fewer.`;
  } else if (!current || search.isPending || search.isFetching) {
    status = "Searching";
  } else if (search.isError) {
    status = (
      <span className="flex flex-wrap items-center gap-x-3">
        <span className="text-destructive">Search failed.</span>
        <button type="button" className={CONTROL} onClick={() => void search.refetch()}>
          Retry
        </button>
      </span>
    );
  } else if (notes.length === 0 && findings.length === 0) {
    status = "No saved notes or findings match.";
  } else {
    status = null;
  }

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-start justify-center p-4 pt-[10vh]">
      <button
        type="button"
        aria-label="Close search"
        tabIndex={-1}
        className="absolute inset-0 bg-black/62"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative flex max-h-[80vh] w-full max-w-[640px] flex-col rounded-[10px] border border-border bg-background text-foreground"
        data-keybinding-capture=""
        onKeyDown={onDialogKeyDown}
      >
        <div className="flex items-center gap-2 border-b border-border pl-3">
          <h2 id={titleId} className="sr-only">
            Search notes and findings
          </h2>
          <input
            ref={inputRef}
            type="search"
            aria-label="Search notes and findings"
            aria-describedby={statusId}
            autoComplete="off"
            spellCheck={false}
            value={query}
            placeholder="Search notes and findings"
            className="h-12 min-w-0 flex-1 bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted-foreground"
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={onInputKeyDown}
          />
          <button type="button" className={CONTROL} onClick={onClose}>
            Close
          </button>
        </div>
        <p
          id={statusId}
          aria-live="polite"
          className={`m-0 px-3 text-[12px] text-muted-foreground ${status === null ? "sr-only" : "py-2"}`}
        >
          {status === null ? `${notes.length + findings.length} results` : status}
        </p>
        {data !== undefined && !search.isError ? (
          <div ref={resultsRef} className="min-h-0 overflow-y-auto pb-1">
            <ResultGroup label="Notes" query={data.query} results={notes} onSelect={select} onKeyDown={onResultKeyDown} />
            <ResultGroup label="Findings" query={data.query} results={findings} onSelect={select} onKeyDown={onResultKeyDown} />
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

function ResultGroup({
  label,
  query,
  results,
  onSelect,
  onKeyDown,
}: {
  label: string;
  query: string;
  results: readonly EngagementSearchResult[];
  onSelect: (result: EngagementSearchResult) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}) {
  const headingId = useId();
  if (results.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className="border-b border-border last:border-b-0">
      <h3 id={headingId} className="m-0 flex items-baseline gap-2 px-3 pt-2 pb-1 text-[12px] font-semibold text-foreground">
        {label}
        <span className="font-mono text-[11px] font-normal text-muted-foreground">
          {results.length === ENGAGEMENT_SEARCH_MAX_PER_GROUP ? `first ${results.length}` : results.length}
        </span>
      </h3>
      <ul className="m-0 list-none p-0">
        {results.map((result) => {
          const exact = parseSearchTarget(result) !== null;
          const snippet = displaySnippet(result);
          return (
            <li key={`${result.kind}:${result.id}`}>
              <button
                type="button"
                data-search-result=""
                disabled={!exact}
                className="block min-h-11 w-full px-3 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-60"
                onClick={() => onSelect(result)}
                onKeyDown={onKeyDown}
              >
                {result.kind === "finding" || highlightMatch(result.title, query).match !== "" ? (
                  <span className="block truncate text-[13px] font-semibold text-foreground"><Highlighted text={highlightMatch(result.title, query)} /></span>
                ) : null}
                <span className="line-clamp-2 block font-mono text-[12px] leading-5 break-words text-muted-foreground">
                  <Highlighted text={highlightMatch(snippet, query)} />
                </span>
                {exact ? null : <span className="block text-[11px] text-muted-foreground">No exact destination</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// The API snippet window covers `${title}\n${text}`; the title repeats the
// row heading, so it is dropped and line breaks fold to spaces for display.
function displaySnippet(result: EngagementSearchResult): string {
  const prefix = `${result.title}\n`;
  const body = result.snippet.startsWith(prefix) ? result.snippet.slice(prefix.length) : result.snippet;
  return body.replace(/\s+/g, " ").trim();
}

export function Highlighted({ text }: { text: HighlightedText }) {
  return (
    <>
      {text.before}
      {text.match.length > 0 ? <mark className="rounded-[2px] bg-foreground px-px text-background">{text.match}</mark> : null}
      {text.after}
    </>
  );
}

/**
 * Status strip a destination shows above its content: what the search
 * opened, whether it is still exact, and a way back into the same search.
 */
export function SearchDestinationNotice({
  children,
  noticeRef,
  onDismiss,
  onRetry,
  onSearchAgain,
}: {
  children: ReactNode;
  noticeRef?: Ref<HTMLDivElement> | undefined;
  onDismiss: () => void;
  onRetry?: (() => void) | undefined;
  onSearchAgain?: (() => void) | undefined;
}) {
  return (
    <div
      ref={noticeRef}
      role="status"
      aria-label="Search result"
      tabIndex={-1}
      className="mb-3 flex flex-wrap items-start justify-between gap-x-3 gap-y-1 rounded-[10px] border border-border px-3 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="min-w-0 flex-1 py-1.5 text-[12px] leading-5 text-foreground">{children}</div>
      <div className="flex shrink-0 gap-1">
        {onRetry !== undefined ? (
          <button type="button" className={CONTROL} onClick={onRetry}>
            Retry
          </button>
        ) : null}
        {onSearchAgain !== undefined ? (
          <button type="button" className={CONTROL} onClick={onSearchAgain}>
            Search again
          </button>
        ) : null}
        <button type="button" className={CONTROL} onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
