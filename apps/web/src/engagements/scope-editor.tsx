import type { SavedScopeRule, ScopeRevision } from "@stonehush/contracts";
import {
  Button,
  LoadingRegion,
  RecoverableError,
  Skeleton,
  StaleDataState,
  cn,
} from "@stonehush/ui";
import { useId, useState, type FormEvent, type ReactNode } from "react";

import { engagementMutationMessage, isRevisionConflict } from "./errors.js";
import { useAppendScopeRevisionMutation } from "./mutations.js";
import { useEngagementDetailQuery } from "./query.js";
import {
  createDraftScopeRule,
  formatScopePortRanges,
  formatScopeRuleTarget,
  scopeRuleKindLabel,
  type DraftScopeRuleInput,
} from "./scope-rules.js";

const emptyDraft: DraftScopeRuleInput = {
  includeSubdomains: false,
  portRanges: "",
  rawTarget: "",
};

export function SavedScopeEditor({
  archived,
  engagementId,
}: {
  archived: boolean;
  engagementId: string;
}) {
  const detail = useEngagementDetailQuery(engagementId);
  const retry = () => void detail.refetch();
  const hasData = detail.data !== undefined;

  return (
    <section aria-label="Saved scope" className="mt-5 border-t border-border pt-4">
      <header className="mb-3">
        <h2 className="m-0 text-[13px] font-semibold">Saved scope</h2>
        <p className="mt-1 mb-0 text-[12px] leading-5 text-muted-foreground">
          Scope is context, not authorization. Saving a revision does not grant access and does
          not block later Continue.
        </p>
      </header>
      {!hasData && detail.isFetching ? <ScopeLoadingState /> : null}
      {!hasData && detail.isError ? (
        <RecoverableError
          title="Saved scope unavailable"
          description="The active saved-scope revision could not be loaded from the local control plane."
          onRetry={retry}
        />
      ) : null}
      {hasData && detail.isError ? (
        <StaleDataState
          title="Showing the last successful saved scope"
          description="The latest refresh failed. Existing scope is still available."
          onRetry={retry}
        >
          <ScopeEditorBody
            archived={archived}
            engagementId={engagementId}
            expectedRevision={detail.data.engagement.revision}
            revision={detail.data.activeScopeRevision}
          />
        </StaleDataState>
      ) : null}
      {hasData && !detail.isError ? (
        <ScopeEditorBody
          archived={archived}
          engagementId={engagementId}
          expectedRevision={detail.data.engagement.revision}
          revision={detail.data.activeScopeRevision}
        />
      ) : null}
    </section>
  );
}

function ScopeLoadingState() {
  return (
    <LoadingRegion label="Loading saved scope" className="space-y-3">
      <Skeleton className="h-3 w-40" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-11 w-full" />
    </LoadingRegion>
  );
}

function ScopeEditorBody({
  archived,
  engagementId,
  expectedRevision,
  revision,
}: {
  archived: boolean;
  engagementId: string;
  expectedRevision: number;
  revision: ScopeRevision | null;
}) {
  const formId = useId();
  const appendScope = useAppendScopeRevisionMutation();
  const [fields, setFields] = useState<DraftScopeRuleInput>(emptyDraft);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof DraftScopeRuleInput, string>>>(
    {},
  );
  const [draftRules, setDraftRules] = useState<SavedScopeRule[]>([]);

  const activeRules = revision?.rules ?? [];
  const mutationError = appendScope.isError
    ? isRevisionConflict(appendScope.error)
      ? appendScope.error.message
      : engagementMutationMessage(appendScope.error)
    : undefined;
  const hasPendingInput =
    fields.rawTarget.trim().length > 0 || fields.portRanges.trim().length > 0;
  const canSave =
    !archived && !appendScope.isPending && (draftRules.length > 0 || hasPendingInput);

  const applyFieldResult = (result: ReturnType<typeof createDraftScopeRule>) => {
    if (result.ok) {
      setFieldErrors({});
      return result.rule;
    }
    setFieldErrors({ [result.field]: result.message });
    return undefined;
  };

  const addDraftRule = () => {
    const rule = applyFieldResult(createDraftScopeRule(fields));
    if (rule === undefined) return;
    setDraftRules((current) => [...current, rule]);
    setFields(emptyDraft);
    appendScope.reset();
  };

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSave) return;
    const nextRules = [...activeRules, ...draftRules];
    if (hasPendingInput) {
      const rule = applyFieldResult(createDraftScopeRule(fields));
      if (rule === undefined) return;
      nextRules.push(rule);
    }
    appendScope.mutate(
      {
        engagementId,
        expectedRevision,
        rules: nextRules,
      },
      {
        onSuccess: () => {
          setDraftRules([]);
          setFields(emptyDraft);
          setFieldErrors({});
        },
      },
    );
  };

  return (
    <div>
      {revision === null ? (
        <section
          className="rounded-[10px] px-1 py-2"
          data-empty-variant="default"
        >
          <h3 className="m-0 text-[13px] font-semibold text-foreground">No saved scope yet</h3>
          <p className="mt-1 mb-0 text-[12px] leading-5 text-muted-foreground">
            Add IP, CIDR, domain, or URL-origin rules as context. Scope is context, not
            authorization.
          </p>
        </section>
      ) : (
        <ActiveScopeRevision revision={revision} />
      )}

      {draftRules.length > 0 && (
        <ScopeRuleList
          caption="Rules to add"
          rules={draftRules}
          {...(archived
            ? {}
            : {
                onRemove: (ruleId: string) => {
                  setDraftRules((current) => current.filter((rule) => rule.id !== ruleId));
                },
              })}
        />
      )}

      {archived && (
        <p className="mt-3 mb-0 text-[12px] leading-5 text-muted-foreground">
          This engagement is archived. Saved scope can be viewed but not changed.
        </p>
      )}
      <form className="mt-4 grid gap-3" onSubmit={save}>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,0.8fr)]">
          <Field
            {...(fieldErrors.rawTarget ? { error: fieldErrors.rawTarget } : {})}
            htmlFor={`${formId}-target`}
            label="Target"
          >
            <input
              id={`${formId}-target`}
              name="target"
              value={fields.rawTarget}
              placeholder="198.51.100.10"
              autoComplete="off"
              spellCheck={false}
              disabled={archived}
              aria-invalid={fieldErrors.rawTarget !== undefined}
              className={cn(fieldClassName(fieldErrors.rawTarget !== undefined), "font-mono")}
              onChange={(event) =>
                setFields((current) => ({ ...current, rawTarget: event.target.value }))
              }
            />
          </Field>
          <Field
            {...(fieldErrors.portRanges ? { error: fieldErrors.portRanges } : {})}
            htmlFor={`${formId}-ports`}
            label="Ports"
          >
            <input
              id={`${formId}-ports`}
              name="portRanges"
              value={fields.portRanges}
              placeholder="80, 443, 8000-8100"
              autoComplete="off"
              spellCheck={false}
              disabled={archived}
              aria-invalid={fieldErrors.portRanges !== undefined}
              className={cn(fieldClassName(fieldErrors.portRanges !== undefined), "font-mono")}
              onChange={(event) =>
                setFields((current) => ({ ...current, portRanges: event.target.value }))
              }
            />
          </Field>
        </div>
        {mutationError && (
          <p className="m-0 text-[13px] text-destructive" role="alert">
            {mutationError}
          </p>
        )}
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <label className="flex min-h-11 items-center gap-3 text-[13px] text-foreground">
            <input
              type="checkbox"
              name="includeSubdomains"
              checked={fields.includeSubdomains}
              disabled={archived}
              className="size-4 accent-primary"
              onChange={(event) =>
                setFields((current) => ({
                  ...current,
                  includeSubdomains: event.target.checked,
                }))
              }
            />
            <span>Include subdomains for domain rules</span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={archived || appendScope.isPending}
              onClick={addDraftRule}
            >
              Add rule
            </Button>
            <Button type="submit" disabled={!canSave}>
              {appendScope.isPending ? "Saving" : "Save scope"}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

function ActiveScopeRevision({ revision }: { revision: ScopeRevision }) {
  return (
    <div>
      <p className="m-0 text-[12px] text-muted-foreground">
        Version <span className="font-mono text-foreground">{revision.version}</span>
        <span className="mx-2 text-border">·</span>
        <span className="font-mono text-foreground">{revision.id}</span>
      </p>
      {revision.rules.length === 0 ? (
        <p className="mt-3 mb-0 text-[13px] text-muted-foreground">This revision has no rules.</p>
      ) : (
        <ScopeRuleList caption="Active rules" rules={revision.rules} />
      )}
    </div>
  );
}

function ScopeRuleList({
  caption,
  onRemove,
  rules,
}: {
  caption: string;
  onRemove?: (ruleId: string) => void;
  rules: readonly SavedScopeRule[];
}) {
  return (
    <div className="mt-3">
      <h3 className="m-0 text-[11px] font-medium text-muted-foreground">{caption}</h3>
      <ul className="mt-2 mb-0 list-none p-0">
        {rules.map((rule) => {
          const target = formatScopeRuleTarget(rule);
          const ports = formatScopePortRanges(rule.portRanges);
          return (
            <li key={rule.id} className="surface-row flex min-h-11 items-center justify-between gap-3 rounded-[10px] px-3 py-2 md:min-h-8">
              <div className="min-w-0">
                <p className="m-0 truncate font-mono text-[13px] text-foreground">{target}</p>
                <p className="mt-0.5 mb-0 text-[11px] text-muted-foreground">
                  {scopeRuleKindLabel(rule.kind)}
                  {rule.kind === "domain" && rule.includeSubdomains ? " · includes subdomains" : ""}
                  {ports !== undefined ? (
                    <>
                      {" · "}
                      <span className="font-mono">{ports}</span>
                    </>
                  ) : null}
                </p>
              </div>
              {onRemove && (
                <button
                  type="button"
                  className="inline-flex min-h-11 shrink-0 items-center rounded-md px-3 text-[13px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring md:min-h-8"
                  onClick={() => onRemove(rule.id)}
                >
                  Remove
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Field({
  children,
  error,
  htmlFor,
  label,
}: {
  children: ReactNode;
  error?: string;
  htmlFor: string;
  label: string;
}) {
  return (
    <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor={htmlFor}>
      <span>{label}</span>
      {children}
      {error && (
        <span className="text-destructive" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

function fieldClassName(invalid: boolean) {
  return cn(
    "min-h-11 w-full rounded-md border bg-transparent px-2.5 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-8",
    invalid ? "border-destructive" : "border-input",
  );
}
