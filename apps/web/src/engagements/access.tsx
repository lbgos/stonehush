import {
  ACCESS_TYPE_LABELS,
  formatAccessRecordLabel,
  type AccessRecord,
  type AccessType,
} from "@stonehush/contracts";
import { SECRET_DISPLAY_MASK, SECRET_STORAGE_COPY } from "@stonehush/domain";
import { Button, LoadingRegion, RecoverableError, Skeleton, StaleDataState } from "@stonehush/ui";
import { useState } from "react";

import {
  AccessMutationClientError,
  useAccessRecordsQuery,
  useCreateAccessMutation,
  useRefreshAccessMutation,
} from "./access-query.js";
import { formatEngagementTimestamp } from "./format.js";
import { useLeadsQuery, useSecretsQuery } from "./leads-query.js";
import { useStoneTargetsQuery } from "./target-context-query.js";

const ACCESS_TYPES: readonly AccessType[] = [
  "ssh",
  "web_session",
  "database",
  "shell",
  "other",
];

function mutationMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

export function EngagementAccessSection({
  archived = false,
  engagementId,
  targetId = null,
}: {
  archived?: boolean;
  engagementId: string;
  targetId?: string | null;
}) {
  const records = useAccessRecordsQuery(engagementId);
  const retry = () => void records.refetch();
  const hasData = records.data !== undefined;

  const body = (
    <AccessBody
      archived={archived}
      engagementId={engagementId}
      records={(records.data ?? []).filter(
        (record) => targetId === null || record.targetId === targetId,
      )}
      scopedTargetId={targetId}
    />
  );

  return (
    <section aria-label="Recorded access" className="mt-5 border-t border-border pt-4">
      <header className="mb-3">
        <h2 className="m-0 text-[13px] font-semibold">Recorded access</h2>
        <p className="mt-1 mb-0 text-[12px] leading-5 text-muted-foreground">
          What access was established, where, and on what evidence. A recorded session is not
          proof of a working shell. {SECRET_STORAGE_COPY}
        </p>
      </header>
      {!hasData && records.isFetching ? (
        <LoadingRegion label="Loading access records" className="space-y-3">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-14 w-full" />
        </LoadingRegion>
      ) : null}
      {!hasData && records.isError ? (
        <RecoverableError
          title="Access records unavailable"
          description="The access records could not be loaded from the local control plane."
          onRetry={retry}
        />
      ) : null}
      {hasData && records.isError ? (
        <StaleDataState
          title="Showing the last successful access records"
          description="The latest refresh failed. Existing records are still available."
          onRetry={retry}
        >
          {body}
        </StaleDataState>
      ) : null}
      {hasData && !records.isError ? body : null}
    </section>
  );
}

function AccessBody({
  archived,
  engagementId,
  records,
  scopedTargetId,
}: {
  archived: boolean;
  engagementId: string;
  records: AccessRecord[];
  scopedTargetId: string | null;
}) {
  const create = useCreateAccessMutation(engagementId);
  const refresh = useRefreshAccessMutation(engagementId);
  const targets = useStoneTargetsQuery(engagementId);
  const leads = useLeadsQuery(engagementId);
  const secrets = useSecretsQuery(engagementId);

  const [targetInput, setTargetInput] = useState(scopedTargetId ?? "");
  const [account, setAccount] = useState("");
  const [accessType, setAccessType] = useState<AccessType>("ssh");
  const [sourceLeadId, setSourceLeadId] = useState("");
  const [secretId, setSecretId] = useState("");
  const [context, setContext] = useState("");
  const [formError, setFormError] = useState<string | undefined>(undefined);

  const targetLabel = (id: string): string =>
    targets.data?.find((target) => target.id === id)?.label ?? `target ${shortId(id)}`;
  const leadTitle = (id: string): string =>
    leads.data?.find((lead) => lead.id === id)?.title ?? `lead ${shortId(id)}`;
  const secretLabel = (id: string): string =>
    secrets.data?.find((secret) => secret.id === id)?.label ?? `secret ${shortId(id)}`;

  const mutationError =
    create.isError || refresh.isError
      ? mutationMessage(create.error ?? refresh.error, "The access request failed.")
      : formError;

  const effectiveTarget = (scopedTargetId ?? targetInput).trim();
  const canSubmit =
    !archived &&
    !create.isPending &&
    effectiveTarget.length > 0 &&
    account.trim().length > 0 &&
    sourceLeadId.length > 0;

  const onSubmit = () => {
    setFormError(undefined);
    if (!canSubmit) {
      setFormError("Choose a target, enter the account, and pick the source lead.");
      return;
    }
    create.mutate(
      {
        targetId: effectiveTarget,
        account: account.trim(),
        accessType,
        sourceLeadId,
        ...(secretId.length === 0 ? {} : { secretId }),
        ...(context.trim().length === 0 ? {} : { context: context.trim() }),
      },
      {
        onSuccess: () => {
          setAccount("");
          setContext("");
          if (scopedTargetId === null) setTargetInput("");
          setSourceLeadId("");
          setSecretId("");
        },
        onError: (error) => {
          if (error instanceof AccessMutationClientError) setFormError(error.message);
        },
      },
    );
  };

  return (
    <div className="grid gap-4">
      <div>
        {records.length === 0 ? (
          <div className="border border-border px-4 py-8 text-center">
            <h3 className="m-0 text-[13px] font-semibold">No access recorded yet</h3>
            <p className="mx-auto mt-2 mb-0 max-w-md text-[13px] leading-5 text-muted-foreground">
              Record the working account and where it worked. Recording never claims a working
              shell.
            </p>
          </div>
        ) : (
          <ul className="m-0 grid list-none gap-2 p-0">
            {records.map((record) => (
              <li
                key={record.id}
                className="border border-border px-3 py-2.5"
                data-testid="access-record"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="m-0 text-[13px] font-semibold">
                      {formatAccessRecordLabel(record.accessType)}{" "}
                      <span className="font-mono font-normal">{record.account}</span>
                    </p>
                    <p className="m-0 mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                      <span>{targetLabel(record.targetId)}</span>
                      <span aria-hidden="true">·</span>
                      <span>from &quot;{leadTitle(record.sourceLeadId)}&quot;</span>
                      {record.secretId !== null ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>
                            Secret {secretLabel(record.secretId)}{" "}
                            <span className="font-mono">{SECRET_DISPLAY_MASK}</span>
                          </span>
                        </>
                      ) : null}
                    </p>
                    <p className="m-0 mt-1 text-[12px] leading-5 text-muted-foreground">
                      Last confirmed {formatEngagementTimestamp(record.lastConfirmedAt)}
                    </p>
                    {record.context !== null ? (
                      <p className="m-0 mt-1 text-[12px] leading-5 text-muted-foreground">
                        {record.context}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={archived || refresh.isPending}
                    onClick={() => void refresh.mutate(record.id)}
                  >
                    {refresh.isPending ? "Confirming" : "Refresh confirmation"}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {mutationError !== undefined ? (
          <p className="mt-2 mb-0 text-[13px] text-destructive" role="alert">
            {mutationError}
          </p>
        ) : null}
      </div>

      {!archived ? (
        <div className="grid gap-2 border-t border-border pt-4">
          <h3 className="m-0 text-[12px] font-semibold">Record access</h3>
          {scopedTargetId === null ? (
            <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="access-target">
              <span>Target</span>
              {targets.data !== undefined && targets.data.length > 0 ? (
                <select
                  id="access-target"
                  value={targetInput}
                  disabled={create.isPending}
                  onChange={(event) => setTargetInput(event.target.value)}
                  className="min-h-11 w-full rounded-md border border-input bg-transparent px-2.5 text-[13px] text-foreground md:min-h-8"
                >
                  <option value="">Choose a target</option>
                  {targets.data.map((target) => (
                    <option key={target.id} value={target.id}>
                      {target.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="access-target"
                  value={targetInput}
                  disabled={create.isPending}
                  placeholder="Target id"
                  onChange={(event) => setTargetInput(event.target.value)}
                  className="min-h-11 w-full rounded-md border border-input bg-transparent px-2.5 font-mono text-[13px] text-foreground md:min-h-8"
                />
              )}
            </label>
          ) : null}
          <div className="grid gap-2 md:grid-cols-2">
            <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="access-account">
              <span>Account</span>
              <input
                id="access-account"
                value={account}
                disabled={create.isPending}
                placeholder="deploy"
                maxLength={120}
                autoComplete="off"
                onChange={(event) => setAccount(event.target.value)}
                className="min-h-11 w-full rounded-md border border-input bg-transparent px-2.5 font-mono text-[13px] text-foreground md:min-h-8"
              />
            </label>
            <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="access-type">
              <span>Access type</span>
              <select
                id="access-type"
                value={accessType}
                disabled={create.isPending}
                onChange={(event) => setAccessType(event.target.value as AccessType)}
                className="min-h-11 w-full rounded-md border border-input bg-transparent px-2.5 text-[13px] text-foreground md:min-h-8"
              >
                {ACCESS_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {ACCESS_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="access-lead">
            <span>Source lead</span>
            <select
              id="access-lead"
              value={sourceLeadId}
              disabled={create.isPending}
              onChange={(event) => setSourceLeadId(event.target.value)}
              className="min-h-11 w-full rounded-md border border-input bg-transparent px-2.5 text-[13px] text-foreground md:min-h-8"
            >
              <option value="">Choose the lead this access came from</option>
              {(leads.data ?? []).map((lead) => (
                <option key={lead.id} value={lead.id}>
                  {lead.title}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="access-secret">
            <span>Secret (reference only, optional)</span>
            <select
              id="access-secret"
              value={secretId}
              disabled={create.isPending}
              onChange={(event) => setSecretId(event.target.value)}
              className="min-h-11 w-full rounded-md border border-input bg-transparent px-2.5 text-[13px] text-foreground md:min-h-8"
            >
              <option value="">No associated secret</option>
              {(secrets.data ?? []).map((secret) => (
                <option key={secret.id} value={secret.id}>
                  {secret.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="access-context">
            <span>Context (optional)</span>
            <input
              id="access-context"
              value={context}
              disabled={create.isPending}
              placeholder="SSH from the runner network"
              maxLength={500}
              onChange={(event) => setContext(event.target.value)}
              className="min-h-11 w-full rounded-md border border-input bg-transparent px-2.5 text-[13px] text-foreground md:min-h-8"
            />
          </label>
          <div>
            <Button type="button" disabled={!canSubmit} onClick={onSubmit}>
              {create.isPending ? "Recording" : "Record access"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
