import type { AdvisorTurn } from "@blackglass/contracts";
import { Button } from "@blackglass/ui";
import { useMemo, useState } from "react";

import type { HintDepthStorage } from "./hint-depth.js";
import {
  filterRuledOutSuggestions,
  type SuggestionVerdict,
} from "./ruled-out.js";
import {
  clearTriedCheck,
  extractSuggestedChecks,
  loadAccessContext,
  loadTriedChecks,
  recordTriedCheck,
  saveAccessContext,
  saveTriedChecks,
  withLiveConditions,
} from "./tried-checks.js";

// Tried checks (STONE-7): the live path for ruled-out handling. Candidate
// checks come from succeeded advisor answers; the operator records what
// each check showed under the current access context. Already-ruled-out
// checks under the same conditions drop with their reason unless a new
// reason arrives, in which case the retry is annotated. Per-engagement
// localStorage; read-only on archived engagements.
export function TriedChecksSection({
  engagementId,
  archived,
  turns,
  storage,
}: {
  engagementId: string;
  archived: boolean;
  turns: readonly AdvisorTurn[];
  storage: HintDepthStorage | undefined;
}) {
  const [attempts, setAttempts] = useState(() => loadTriedChecks(storage, engagementId));
  const [accessContext, setAccessContext] = useState(() =>
    loadAccessContext(storage, engagementId),
  );
  const [reasons, setReasons] = useState<Readonly<Record<string, string>>>({});

  const candidates = useMemo(() => extractSuggestedChecks(turns), [turns]);
  const conditions = accessContext.trim();
  const verdicts = useMemo(
    () =>
      filterRuledOutSuggestions(
        withLiveConditions(candidates, conditions).map((check) => {
          const reason = reasons[check.id];
          return reason === undefined ? check : { ...check, newReason: reason };
        }),
        attempts,
      ),
    [candidates, conditions, reasons, attempts],
  );
  const verdictById = useMemo(() => {
    const map = new Map<string, SuggestionVerdict>();
    for (const verdict of verdicts) map.set(verdict.id, verdict);
    return map;
  }, [verdicts]);

  function persist(next: ReturnType<typeof recordTriedCheck>) {
    setAttempts([...next]);
    saveTriedChecks(storage, engagementId, next);
  }

  function handleRecord(summary: string, outcome: "ruled-out" | "supported") {
    persist(recordTriedCheck(attempts, summary, conditions, outcome));
    setReasons((current) => {
      if (!(checkId(summary) in current)) return current;
      const next = { ...current };
      delete next[checkId(summary)];
      return next;
    });
  }

  function handleForget(summary: string) {
    persist(clearTriedCheck(attempts, summary, conditions));
  }

  function handleAccessContext(value: string) {
    setAccessContext(value);
    saveAccessContext(storage, engagementId, value);
  }

  return (
    <div>
      <p className="m-0 text-[12px] text-muted-foreground">
        Checks suggested by past answers. Mark what each showed; ruled-out
        checks stay out unless a new reason arrives.
      </p>
      {!archived ? (
        <label className="mt-1.5 grid gap-0.5 text-[12px]">
          <span>Access context (conditions for every verdict)</span>
          <input
            value={accessContext}
            onChange={(event) => handleAccessContext(event.target.value)}
            placeholder="e.g. unauthenticated network"
            autoComplete="off"
            className="h-8 rounded-md border border-input bg-transparent px-2 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
      ) : null}
      {candidates.length === 0 ? (
        <p className="m-0 mt-1.5 text-[12px] text-muted-foreground" role="status">
          No runnable checks in past answers yet.
        </p>
      ) : (
        <ul className="m-0 mt-1.5 list-none space-y-1.5 p-0">
          {candidates.map((check) => (
            <TriedCheckRow
              key={check.id}
              summary={check.summary}
              verdict={verdictById.get(check.id)}
              archived={archived}
              onRecord={handleRecord}
              onForget={handleForget}
              onRetry={(reason) =>
                setReasons((current) => ({ ...current, [check.id]: reason }))
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function checkId(summary: string): string {
  return summary.trim().toLowerCase().replace(/\s+/g, " ");
}

function TriedCheckRow({
  summary,
  verdict,
  archived,
  onRecord,
  onForget,
  onRetry,
}: {
  summary: string;
  verdict: SuggestionVerdict | undefined;
  archived: boolean;
  onRecord: (summary: string, outcome: "ruled-out" | "supported") => void;
  onForget: (summary: string) => void;
  onRetry: (reason: string) => void;
}) {
  const [retrying, setRetrying] = useState(false);
  const [reason, setReason] = useState("");

  return (
    <li className="rounded-md border border-border px-2 py-1.5">
      <code className="block font-mono text-[11px] break-words">{summary}</code>
      {verdict?.verdict === "drop" ? (
        <p className="m-0 mt-1 text-[11px] text-muted-foreground" role="status">
          {verdict.reason}
        </p>
      ) : null}
      {verdict?.verdict === "annotate" ? (
        <p className="m-0 mt-1 text-[11px] text-muted-foreground" role="status">
          {verdict.note}
        </p>
      ) : null}
      {verdict?.verdict === "keep" ? (
        <p className="m-0 mt-1 text-[11px] text-muted-foreground" role="status">
          Not yet tried under these conditions.
        </p>
      ) : null}
      {archived ? null : (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            variant="quiet"
            className="h-6 px-1.5 text-[11px]"
            onClick={() => onRecord(summary, "ruled-out")}
          >
            Mark ruled out
          </Button>
          <Button
            type="button"
            variant="quiet"
            className="h-6 px-1.5 text-[11px]"
            onClick={() => onRecord(summary, "supported")}
          >
            Mark supported
          </Button>
          <Button
            type="button"
            variant="quiet"
            className="h-6 px-1.5 text-[11px]"
            onClick={() => onForget(summary)}
          >
            Forget
          </Button>
          {verdict?.verdict === "drop" && !retrying ? (
            <Button
              type="button"
              variant="quiet"
              className="h-6 px-1.5 text-[11px]"
              onClick={() => setRetrying(true)}
            >
              Retry with new reason
            </Button>
          ) : null}
        </div>
      )}
      {!archived && retrying && verdict?.verdict === "drop" ? (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="New reason to retry"
            aria-label={`New reason to retry ${summary}`}
            autoComplete="off"
            className="h-7 min-w-40 flex-1 rounded-md border border-input bg-transparent px-1.5 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button
            type="button"
            variant="quiet"
            className="h-6 px-1.5 text-[11px]"
            disabled={reason.trim().length === 0}
            onClick={() => {
              onRetry(reason.trim());
              setRetrying(false);
              setReason("");
            }}
          >
            Retry
          </Button>
        </div>
      ) : null}
    </li>
  );
}
