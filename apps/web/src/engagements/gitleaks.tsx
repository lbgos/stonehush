import { GITLEAKS_DEFAULT_EXECUTABLE, type GitleaksMatch } from "@stonehush/contracts";
import { Button, LoadingRegion, RecoverableError, Skeleton } from "@stonehush/ui";
import { useState } from "react";

import {
  GitleaksScanClientError,
  gitleaksScanMessage,
} from "./errors.js";
import {
  useEngagementGitleaksMatchesQuery,
  useScanGitleaksMutation,
} from "./gitleaks-query.js";

export function EngagementGitleaksSection({
  archived,
  engagementId,
}: {
  archived: boolean;
  engagementId: string;
}) {
  return (
    <section aria-label="secret scan" className="overflow-hidden rounded-[10px] border border-border bg-card">
      <div className="flex min-h-10 items-center justify-between border-b border-border px-3">
        <h2 className="m-0 text-[13px] font-semibold">secret scan</h2>
        <span className="hidden text-[11px] text-muted-foreground sm:inline">T0 evidence read</span>
      </div>
      <div className="grid gap-4 p-3">
        <GitleaksScanBody archived={archived} engagementId={engagementId} />
        <GitleaksMatchesList engagementId={engagementId} />
      </div>
    </section>
  );
}

function GitleaksScanBody({
  archived,
  engagementId,
}: {
  archived: boolean;
  engagementId: string;
}) {
  const scan = useScanGitleaksMutation();
  const [lastCount, setLastCount] = useState<number | undefined>(undefined);
  const [lastTruncated, setLastTruncated] = useState(false);

  const mutationError = scan.isError ? scan.error : undefined;
  const missingTool =
    mutationError instanceof GitleaksScanClientError && mutationError.code === "gitleaks_missing";
  const canScan = !archived && !scan.isPending;

  const run = () => {
    if (!canScan) return;
    scan.reset();
    scan.mutate(engagementId, {
      onSuccess: (response) => {
        setLastCount(response.matchCount);
        setLastTruncated(response.truncated);
      },
    });
  };

  return (
    <div>
      {archived && (
        <p className="mb-3 text-[12px] leading-5 text-muted-foreground">
          This engagement is archived. Evidence cannot be scanned.
        </p>
      )}
      <p className="mt-0 mb-3 text-[12px] leading-5 text-muted-foreground">
        Scans captured evidence for leaked keys and tokens. Only the rule, file, line, and a
        dedupe fingerprint are kept. Secret values never reach the database or this screen.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button type="button" disabled={!canScan} onClick={run}>
          {scan.isPending ? "Scanning" : lastCount === undefined ? "Scan evidence" : "Rescan"}
        </Button>
      </div>
      {missingTool && (
        <p className="m-0 mt-3 text-[13px] leading-5 text-foreground" role="alert">
          gitleaks is not installed at {GITLEAKS_DEFAULT_EXECUTABLE}, so no scan ran. Install it
          there and rescan.
        </p>
      )}
      {!missingTool && mutationError && (
        <p className="m-0 mt-3 text-[13px] text-destructive" role="alert">
          {gitleaksScanMessage(mutationError)}
        </p>
      )}
      {scan.isSuccess && lastCount !== undefined && (
        <p className="m-0 mt-3 text-[13px] text-foreground" role="status">
          {lastCount === 0
            ? "No secret matches in captured evidence."
            : `${lastCount} secret ${lastCount === 1 ? "match" : "matches"} in captured evidence.`}
          {lastTruncated ? " Output was truncated at the kept limit." : ""}
        </p>
      )}
    </div>
  );
}

function GitleaksMatchesList({ engagementId }: { engagementId: string }) {
  const matchesQuery = useEngagementGitleaksMatchesQuery(engagementId);
  const hasData = matchesQuery.data !== undefined;
  const retry = () => void matchesQuery.refetch();

  if (!hasData && matchesQuery.isError) {
    return (
      <RecoverableError
        title="secret scan results unavailable"
        description="The secret scan results could not be loaded from the local control plane."
        onRetry={retry}
      />
    );
  }
  if (!hasData) {
    return (
      <LoadingRegion label="Loading secret scan results" className="space-y-3">
        <Skeleton className="h-14 w-full" />
      </LoadingRegion>
    );
  }

  const matches = [...matchesQuery.data].sort((left, right) => {
    const file = left.file.localeCompare(right.file);
    if (file !== 0) return file;
    if (left.line !== right.line) return left.line - right.line;
    return left.ruleId.localeCompare(right.ruleId);
  });
  if (matches.length === 0) {
    return (
      <div className="rounded-md border border-border px-4 py-6 text-center">
        <h3 className="m-0 text-[13px] font-semibold">No secret matches</h3>
        <p className="mx-auto mt-2 mb-0 max-w-md text-[13px] leading-5 text-muted-foreground">
          Scan the captured evidence above. Matches list the rule, file, and line only.
        </p>
      </div>
    );
  }

  return (
    <ul className="m-0 grid list-none gap-2 p-0">
      {matches.map((match) => (
        <GitleaksMatchRow key={`${match.ruleId}:${match.file}:${match.line}:${match.fingerprint}`} match={match} />
      ))}
    </ul>
  );
}

function GitleaksMatchRow({ match }: { match: GitleaksMatch }) {
  return (
    <li className="min-w-0 rounded-md border border-border px-3 py-2">
      <div className="truncate font-mono text-[13px] font-semibold tracking-[-0.02em]" title={match.ruleId}>
        {match.ruleId}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
        <span className="truncate" title={match.file}>
          {match.file}
        </span>
        <span>{match.line === 0 ? "line unknown" : `line ${match.line}`}</span>
      </div>
    </li>
  );
}
