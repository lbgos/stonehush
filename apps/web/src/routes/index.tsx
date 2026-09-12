import {
  CreateEngagementRequestSchema,
  EngagementKindSchema,
  type Engagement,
  type EngagementKind,
} from "@stonehush/contracts";
import { Button, LoadingRegion, RecoverableError, Skeleton } from "@stonehush/ui";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { createActionRequest } from "../engagements/action-mutations.js";
import { parsePlannedTargets } from "../engagements/action-targets.js";
import {
  EngagementMutationClientError,
  engagementMutationMessage,
  isRevisionConflict,
} from "../engagements/errors.js";
import {
  browserStorage,
  readLastEngagementId,
  selectResumeEngagement,
  splitStartTargets,
  storeLastEngagementId,
  suggestEngagementName,
} from "../engagements/first-action.js";
import { FirstActionReadiness } from "../engagements/first-action-readiness.js";
import { ENGAGEMENT_KIND_LABELS } from "../engagements/format.js";
import { createIdempotencyKey } from "../engagements/idempotency.js";
import { createEngagementRequest, upsertEngagementInCache } from "../engagements/mutations.js";
import { partitionEngagements, useEngagementsQuery } from "../engagements/query.js";
import { runHistoryQueryKey } from "../engagements/run-history-query.js";
import { useEngagementWorkspace } from "../engagements/workspace-context.js";

export const Route = createFileRoute("/")({
  component: OpeningScreen,
});

const KIND_OPTIONS = EngagementKindSchema.options;

function OpeningScreen() {
  const engagements = useEngagementsQuery();
  const { announce, openCreate } = useEngagementWorkspace();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [lastId, setLastId] = useState(() => readLastEngagementId(browserStorage()));
  const [startTargets, setStartTargets] = useState("");
  const [startName, setStartName] = useState("");
  const [startKind, setStartKind] = useState<EngagementKind>("ctf");
  const [startError, setStartError] = useState<string | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  // Creation and the follow-up scan are separate phases. Once the engagement
  // exists, retries reuse it so a failed scan never leaves duplicate
  // engagements behind. Cleared on success; inputs stay editable throughout.
  const [started, setStarted] = useState<Engagement | null>(null);

  const records = engagements.data ?? [];
  const { active } = partitionEngagements(records);
  const resume = selectResumeEngagement(records, lastId);
  const suggestedName = suggestEngagementName(splitStartTargets(startTargets));

  const start = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void runStart();
  };

  const runStart = async () => {
    if (starting) return;
    const parsedTargets = parsePlannedTargets(startTargets);
    if (!parsedTargets.ok) {
      setStartError(parsedTargets.message);
      return;
    }
    const name = startName.trim() === "" ? suggestedName : startName.trim();
    const body = {
      authorizationContext: null,
      autoContinueWarnings: false,
      description: null,
      kind: startKind,
      name,
    };
    const validated = CreateEngagementRequestSchema.safeParse(body);
    if (!validated.success) {
      setStartError("That name was not accepted. Use 1 to 120 characters.");
      return;
    }
    setStartError(undefined);
    setStarting(true);
    try {
      let engagement = started;
      if (engagement === null) {
        engagement = await createEngagementRequest(validated.data, createIdempotencyKey());
        upsertEngagementInCache(queryClient, engagement);
        storeLastEngagementId(browserStorage(), engagement.id);
        setLastId(engagement.id);
        setStarted(engagement);
      }
      const action = await createActionRequest(
        engagement.id,
        {
          expectedEngagementRevision: engagement.revision,
          expectedActiveScopeRevisionId: engagement.activeScopeRevisionId,
          targets: parsedTargets.targets,
          declaredPorts: null,
        },
        createIdempotencyKey(),
      );
      // The readiness summary reads run history, so refresh it now instead
      // of leaving "no runs yet" until a remount.
      void queryClient.invalidateQueries({ queryKey: runHistoryQueryKey(engagement.id) });
      const paused = action.action.state === "paused_for_warning";
      if (paused) {
        announce(`Action ${action.action.actionId} needs one warning before it runs.`);
      } else {
        announce(
          `Engagement ${engagement.name} created. First scan queued for ${parsedTargets.targets[0] ?? ""}.`,
        );
      }
      setStartTargets("");
      setStartName("");
      setStarted(null);
      void navigate({
        to: "/engagements/$engagementId",
        params: { engagementId: engagement.id },
        // A paused scan carries its action id along so the planner can load
        // the warning card. Without it Continue would be unreachable.
        ...(paused ? { search: { action: action.action.actionId } } : {}),
      });
    } catch (error) {
      if (error instanceof EngagementMutationClientError) {
        if (error.code === "engagement_not_found" || error.code === "engagement_archived") {
          // The retained engagement is gone; the next submit starts over.
          setStarted(null);
        } else if (isRevisionConflict(error)) {
          const revision = error.currentRevision;
          setStarted((current) => (current === null ? current : { ...current, revision }));
        }
      }
      setStartError(engagementMutationMessage(error));
    } finally {
      setStarting(false);
    }
  };

  return (
    <main className="min-h-full bg-background px-4 py-5 sm:px-6">
      <div className="mx-auto w-full max-w-2xl">
        <header className="mb-5">
          <h1 className="mt-0 mb-0 text-[26px] leading-none font-semibold tracking-[-0.04em]">
            Start
          </h1>
          <p className="mt-2 mb-0 max-w-xl text-[13px] leading-5 text-muted-foreground">
            Paste a target and go. Notes stay available while the first scan runs.
          </p>
        </header>

        {engagements.data === undefined && engagements.isFetching ? (
          <LoadingRegion label="Loading engagements" className="space-y-3">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-8 w-56 max-w-full" />
          </LoadingRegion>
        ) : null}
        {engagements.data === undefined && engagements.isError ? (
          <RecoverableError
            variant="page"
            title="Engagements unavailable"
            description="The engagement list could not be loaded from the local control plane."
            onRetry={() => void engagements.refetch()}
          />
        ) : null}
        {!(engagements.data === undefined && engagements.isFetching) ? (
          <div className="grid gap-6">
            {engagements.data !== undefined ? (
              <section aria-label="Resume">
                <h2 className="m-0 text-[13px] font-semibold">Resume</h2>
                {resume ? (
                  <div className="mt-2">
                    <Link
                      to="/engagements/$engagementId"
                      params={{ engagementId: resume.id }}
                      className="inline-flex min-h-11 items-center text-[15px] font-semibold text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring md:min-h-8"
                      onClick={() => {
                        storeLastEngagementId(browserStorage(), resume.id);
                        setLastId(resume.id);
                      }}
                    >
                      {resume.name}
                    </Link>
                    <p className="mt-1 mb-0 text-[12px] text-muted-foreground">
                      {ENGAGEMENT_KIND_LABELS[resume.kind]} · rev {resume.revision} ·{" "}
                      {active.some((engagement) => engagement.id === resume.id)
                        ? "active"
                        : "archived"}
                    </p>
                  </div>
                ) : (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <p className="m-0 text-[13px] text-muted-foreground">No engagements yet.</p>
                    <Button type="button" onClick={openCreate}>
                      New engagement
                    </Button>
                  </div>
                )}
              </section>
            ) : null}

            <section aria-label="Start with a target">
              <h2 className="m-0 text-[13px] font-semibold">Start with a target</h2>
              <form className="mt-2 grid gap-3" onSubmit={start}>
                <label
                  className="grid gap-1 text-[11px] text-muted-foreground"
                  htmlFor="opening-targets"
                >
                  <span>Target</span>
                  <textarea
                    id="opening-targets"
                    name="targets"
                    value={startTargets}
                    rows={2}
                    placeholder={"192.0.2.10\n198.51.100.10"}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={starting}
                    className="min-h-20 w-full rounded-md border border-input bg-transparent px-2.5 py-2 font-mono text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onChange={(event) => setStartTargets(event.target.value)}
                  />
                </label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label
                    className="grid gap-1 text-[11px] text-muted-foreground"
                    htmlFor="opening-name"
                  >
                    <span>Name</span>
                    <input
                      id="opening-name"
                      name="name"
                      value={startName}
                      maxLength={120}
                      placeholder={suggestedName}
                      autoComplete="off"
                      disabled={starting}
                      className="min-h-11 w-full rounded-md border border-input bg-transparent px-2.5 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-8"
                      onChange={(event) => setStartName(event.target.value)}
                    />
                  </label>
                  <label
                    className="grid gap-1 text-[11px] text-muted-foreground"
                    htmlFor="opening-kind"
                  >
                    <span>Type</span>
                    <select
                      id="opening-kind"
                      name="kind"
                      value={startKind}
                      disabled={starting}
                      className="min-h-11 w-full rounded-md border border-input bg-transparent px-2.5 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-8"
                      onChange={(event) => setStartKind(event.target.value as EngagementKind)}
                    >
                      {KIND_OPTIONS.map((kind) => (
                        <option key={kind} value={kind}>
                          {ENGAGEMENT_KIND_LABELS[kind]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {startError && (
                  <p className="m-0 text-[13px] text-destructive" role="alert">
                    {startError}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={starting}>
                    {starting ? "Starting" : "Start scan"}
                  </Button>
                  <Button type="button" variant="quiet" disabled={starting} onClick={openCreate}>
                    More options
                  </Button>
                </div>
              </form>
            </section>

            <FirstActionReadiness engagementId={resume?.id} />
          </div>
        ) : null}
      </div>
    </main>
  );
}
