import {
  UpdateEngagementDeadlineRequestSchema,
  type Engagement,
} from "@stonehush/contracts";
import {
  Button,
  LoadingRegion,
  RecoverableError,
  Skeleton,
  StaleDataState,
  cn,
} from "@stonehush/ui";
import { useEffect, useState } from "react";

import { engagementMutationMessage } from "./errors.js";
import { useUpdateDeadlineMutation } from "./mutations.js";
import { formatEngagementTimestamp } from "./format.js";
import { useEngagementDetailQuery } from "./query.js";

export type DeadlineTone = "neutral" | "warning" | "overdue";

export interface DeadlineCountdown {
  tone: DeadlineTone;
  label: string;
}

const WARNING_MS = 24 * 60 * 60 * 1000;
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;

function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.round(totalMinutes / 60);
  if (totalHours < 48) return `${totalHours}h`;
  return `${Math.round(totalHours / 24)}d`;
}

// Read-only countdown derived from the stored deadline. Returns undefined
// for unparseable values so callers render nothing instead of guessing.
export function describeDeadline(
  deadlineAt: string,
  now: number = Date.now(),
): DeadlineCountdown | undefined {
  const time = Date.parse(deadlineAt);
  if (Number.isNaN(time)) return undefined;
  const diff = time - now;
  if (diff <= 0) return { tone: "overdue", label: `Overdue by ${formatDuration(-diff)}` };
  if (diff < WARNING_MS) return { tone: "warning", label: `${formatDuration(diff)} left` };
  return { tone: "neutral", label: `${formatDuration(diff)} left` };
}

const PILL_TONE_CLASS: Record<DeadlineTone, string> = {
  neutral: "border-border text-muted-foreground",
  warning: "border-warning/60 text-warning",
  overdue: "border-destructive/60 text-destructive",
};

export function DeadlinePill({
  deadlineAt,
  now,
}: {
  deadlineAt: string | null;
  now?: number;
}) {
  if (deadlineAt === null) return null;
  const countdown = describeDeadline(deadlineAt, now);
  if (countdown === undefined) return null;
  return (
    <span
      data-testid="deadline-pill"
      data-tone={countdown.tone}
      role="status"
      aria-label={`Deadline ${countdown.label}`}
      className={cn(
        "inline-flex h-8 shrink-0 items-center rounded-md border px-2 font-mono text-[11px] whitespace-nowrap",
        PILL_TONE_CLASS[countdown.tone],
      )}
    >
      {countdown.label}
    </span>
  );
}

// datetime-local value (local "YYYY-MM-DDTHH:MM") for the stored UTC deadline.
export function toDateTimeLocalValue(deadlineAt: string | null): string {
  if (deadlineAt === null) return "";
  const date = new Date(deadlineAt);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// datetime-local input back to a UTC ISO string. Undefined when unparseable.
export function fromDateTimeLocalValue(value: string): string | undefined {
  if (value.trim() === "") return undefined;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return undefined;
  return new Date(time).toISOString();
}

function validateDraft(
  draft: string,
  expectedRevision: number,
): { iso: string } | { message: string } {
  const iso = fromDateTimeLocalValue(draft);
  if (iso === undefined) {
    return {
      message:
        draft.trim() === ""
          ? "Enter a date and time, or clear the deadline."
          : "That date and time was not understood. Use the picker.",
    };
  }
  const parsed = UpdateEngagementDeadlineRequestSchema.safeParse({
    expectedRevision,
    deadlineAt: iso,
  });
  if (!parsed.success) {
    return Date.parse(iso) - Date.now() > TEN_YEARS_MS
      ? { message: "The deadline must be within 10 years." }
      : { message: "That deadline was not accepted. Check the value and try again." };
  }
  return { iso };
}

export function EngagementDeadlineSection({
  archived,
  engagementId,
}: {
  archived: boolean;
  engagementId: string;
}) {
  const detail = useEngagementDetailQuery(engagementId);
  const engagement: Engagement | undefined = detail.data?.engagement;
  const retry = () => void detail.refetch();
  const hasData = engagement !== undefined;

  return (
    <section aria-label="Engagement deadline" className="mt-5 border-t border-border pt-4">
      <header className="mb-3">
        <h2 className="m-0 text-[13px] font-semibold">Deadline</h2>
        <p className="mt-1 mb-0 text-[12px] leading-5 text-muted-foreground">
          Optional time pressure for this engagement. The header counts down to it.
        </p>
      </header>
      {!hasData && detail.isFetching ? (
        <LoadingRegion label="Loading deadline" className="space-y-3">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-8 w-full" />
        </LoadingRegion>
      ) : null}
      {!hasData && detail.isError ? (
        <RecoverableError
          title="Deadline unavailable"
          description="The engagement deadline could not be loaded from the local control plane."
          onRetry={retry}
        />
      ) : null}
      {hasData && detail.isError ? (
        <StaleDataState
          title="Showing the last successful deadline"
          description="The latest refresh failed. The saved deadline is still available."
          onRetry={retry}
        >
          <DeadlineControl archived={archived} engagement={engagement} />
        </StaleDataState>
      ) : null}
      {hasData && !detail.isError ? (
        <DeadlineControl archived={archived} engagement={engagement} />
      ) : null}
    </section>
  );
}

function DeadlineControl({
  archived,
  engagement,
}: {
  archived: boolean;
  engagement: Engagement;
}) {
  const update = useUpdateDeadlineMutation();
  const [draft, setDraft] = useState(() => toDateTimeLocalValue(engagement.deadlineAt));
  const [validationMessage, setValidationMessage] = useState<string | undefined>(undefined);

  useEffect(() => {
    setDraft(toDateTimeLocalValue(engagement.deadlineAt));
    setValidationMessage(undefined);
    update.reset();
    // Sync the draft when a different engagement (or a fresh revision) arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engagement.id, engagement.deadlineAt]);

  const pending = update.isPending;
  const mutationError = update.isError ? engagementMutationMessage(update.error) : undefined;

  const onDraftChange = (next: string) => {
    setDraft(next);
    setValidationMessage(undefined);
    if (update.isError) update.reset();
  };

  const onSave = () => {
    if (pending || archived) return;
    const validated = validateDraft(draft, engagement.revision);
    if ("message" in validated) {
      setValidationMessage(validated.message);
      return;
    }
    setValidationMessage(undefined);
    update.mutate({
      engagementId: engagement.id,
      expectedRevision: engagement.revision,
      deadlineAt: validated.iso,
    });
  };

  const onClear = () => {
    if (pending || archived) return;
    setValidationMessage(undefined);
    setDraft("");
    update.mutate({
      engagementId: engagement.id,
      expectedRevision: engagement.revision,
      deadlineAt: null,
    });
  };

  return (
    <div>
      {engagement.deadlineAt === null ? (
        <p className="m-0 text-[12px] leading-5 text-muted-foreground">
          No deadline set. Pick a date and time to start the countdown.
        </p>
      ) : (
        <p className="m-0 flex flex-wrap items-center gap-x-2 text-[12px] leading-5 text-muted-foreground">
          <span>Due {formatEngagementTimestamp(engagement.deadlineAt)}</span>
        </p>
      )}
      <label className="mt-3 grid gap-1 text-[11px] text-muted-foreground" htmlFor="engagement-deadline-input">
        <span>Date and time</span>
        <input
          id="engagement-deadline-input"
          type="datetime-local"
          value={draft}
          disabled={archived || pending}
          className="min-h-11 w-full rounded-md border border-input bg-transparent px-2.5 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-8"
          onChange={(event) => onDraftChange(event.target.value)}
        />
      </label>
      {validationMessage ? (
        <p className="mt-2 mb-0 text-[13px] text-destructive" role="alert">
          {validationMessage}
        </p>
      ) : null}
      {mutationError ? (
        <p className="mt-2 mb-0 text-[13px] text-destructive" role="alert">
          {mutationError}
        </p>
      ) : null}
      {archived ? (
        <p className="mt-3 mb-0 text-[12px] leading-5 text-muted-foreground">
          This engagement is archived. The deadline can be viewed but not changed.
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" disabled={archived || pending} onClick={onSave}>
          {pending ? "Saving" : "Save deadline"}
        </Button>
        <Button
          type="button"
          variant="quiet"
          disabled={archived || pending || engagement.deadlineAt === null}
          onClick={onClear}
        >
          {pending ? "Working" : "Clear deadline"}
        </Button>
      </div>
    </div>
  );
}
