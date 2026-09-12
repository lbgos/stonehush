import type { RunHistorySummary } from "@stonehush/contracts";
import { Button } from "@stonehush/ui";

import { useAdvisorStatusQuery } from "../advisor-status-query.js";
import { useSystemStatusQuery } from "../system-status-query.js";
import { useRunHistoryQuery } from "./run-history-query.js";

// Small readiness summary shown next to the first action. It keeps three
// failure modes visually distinct: the control plane unreachable, the runner
// disconnected, and the target not answering. An unconfigured advisor is one
// quiet line and never blocks manual work.

const NON_TERMINAL_RUN_STATES = new Set(["queued", "leased", "running", "cancel_requested"]);

function systemLine(status: ReturnType<typeof useSystemStatusQuery>): string {
  if (status.data !== undefined) {
    return status.data.overall === "ready"
      ? "Control plane: ready."
      : "Control plane: storage not ready. Queued work waits.";
  }
  if (status.isError) return "Control plane: unreachable. Start the app and check again.";
  return "Control plane: checking.";
}

function advisorLine(status: ReturnType<typeof useAdvisorStatusQuery>): string {
  if (status.data !== undefined) {
    switch (status.data.reason) {
      case "ok":
        return "Advisor: ready.";
      case "unreachable":
      case "probe_failed":
        return "Advisor: endpoint not answering. Manual work is unaffected.";
      default:
        return "Advisor: not set up. Manual work is unaffected.";
    }
  }
  if (status.isError) return "Advisor: status unavailable. Manual work is unaffected.";
  return "Advisor: checking.";
}

function runLine(run: RunHistorySummary | undefined): string {
  if (run === undefined) return "Runner: no runs yet. The first scan appears here.";
  if (NON_TERMINAL_RUN_STATES.has(run.state)) {
    return `Runner: run ${run.id.slice(0, 8)} is ${run.state}.`;
  }
  if (run.state === "cancelled") return "Runner: last run cancelled. Partial evidence may remain.";
  if (run.state === "succeeded") {
    return "Runner: last run finished. No new services means the target did not answer.";
  }
  switch (run.terminalReason) {
    case "runner_lost":
      return "Runner disconnected during the last run. The target may never have been reached. Start the runner and retry.";
    case "nmap_unavailable":
      return "Nmap is not available to the runner. Install nmap or fix the runner executable, then retry.";
    case "ffuf_missing":
      return "The ffuf binary is missing on the runner host. Install it, then retry.";
    case null:
    case undefined:
      return "Runner: last run failed.";
    default:
      return `Runner: last run failed (${run.terminalReason}).`;
  }
}

export function FirstActionReadiness({
  engagementId,
}: {
  engagementId?: string | undefined;
}) {
  const system = useSystemStatusQuery();
  const advisor = useAdvisorStatusQuery();
  const history = useRunHistoryQuery(engagementId, 1);
  const latest = history.data?.pages[0]?.runs[0];

  const lines: string[] = [systemLine(system)];
  if (engagementId !== undefined) {
    if (history.data !== undefined) {
      lines.push(runLine(latest));
    } else if (history.isError) {
      lines.push("Runner: recent runs unavailable, state unknown.");
    } else {
      lines.push("Runner: checking recent runs.");
    }
  }
  // Nmap outages surface through the run-history line above; the planning
  // aggregate carries no Nmap-specific code, so no separate Nmap line here.
  lines.push(advisorLine(advisor));

  // Manual retry only, shown only while something failed, so an unreachable
  // control plane never strands the summary without recourse.
  const failed =
    system.isError ||
    system.data?.overall === "not_ready" ||
    advisor.isError ||
    (engagementId !== undefined && history.isError);
  const retryStatus = () => {
    void system.refetch();
    void advisor.refetch();
    if (engagementId !== undefined) void history.refetch();
  };

  return (
    <section aria-label="First action readiness">
      <ul className="m-0 list-none space-y-1 p-0">
        {lines.map((line) => (
          <li key={line} className="text-[12px] leading-5 text-muted-foreground">
            {line}
          </li>
        ))}
      </ul>
      {failed ? (
        <Button
          type="button"
          variant="quiet"
          className="mt-1 h-7 px-2 text-[12px]"
          onClick={retryStatus}
        >
          Retry status
        </Button>
      ) : null}
    </section>
  );
}
