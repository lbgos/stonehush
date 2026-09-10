import {
  STONE_COPY_ACTION_LABELS,
  formatRecordedSessionLabel,
  type StoneCopyKind,
  type StoneHostnameAssociation,
} from "@blackglass/contracts";
import { Button, cn } from "@blackglass/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { buildCopyText, COPIED_NOT_RAN_NOTE, resolveRecipeCopy } from "./target-context-recipes.js";
import {
  changeStoneAddressRequest,
  decideStoneHostnameRequest,
  fetchStoneBindings,
  proposeStoneHostnameRequest,
  stoneBindingsQueryKey,
  stoneTargetsQueryKey,
  useStoneBindingsQuery,
  useStoneTargetsQuery,
} from "./target-context-query.js";

export interface StoneAccessContext {
  readonly accountRef: string | null;
  readonly connectionRef: string | null;
  readonly lastConfirmedAt: string | null;
}

const COPY_ORDER: StoneCopyKind[] = ["address", "hostname", "url", "command"];

const FOLLOW_UP_RECIPE: {
  commandTemplate: string;
  requiredInputs: ("address" | "hostname" | "origin" | "account" | "connection")[];
} = {
  commandTemplate: "nmap -sV {address}",
  requiredInputs: ["address"],
};

// Reusable target context: address and hostname bindings, origin, and
// read-only access references. STONE-2 mounts this panel through the slot
// below after its workspace extension points merge. Access records stay owned
// by STONE-4; this panel only reads account and connection references.
export function TargetContextPanel({
  engagementId,
  accessContext,
  origin,
}: {
  engagementId: string;
  accessContext: StoneAccessContext;
  origin?: string | null;
}) {
  const queryClient = useQueryClient();
  const targets = useStoneTargetsQuery(engagementId);
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const activeTargetId = selectedTargetId ?? targets.data?.[0]?.id ?? null;
  const bindings = useStoneBindingsQuery(engagementId, activeTargetId);

  const [newAddress, setNewAddress] = useState("");
  const [changeError, setChangeError] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);

  const [connectionAddress, setConnectionAddress] = useState("");
  const [requestedHostname, setRequestedHostname] = useState("");
  const [offer, setOffer] = useState<StoneHostnameAssociation | null>(null);
  const [offerError, setOfferError] = useState<string | null>(null);
  const [offerBusy, setOfferBusy] = useState(false);

  const [copied, setCopied] = useState<string | null>(null);
  const [copyMissing, setCopyMissing] = useState<string | null>(null);

  const current = bindings.data?.current[0] ?? null;
  const baseSnapshot = useMemo(
    () => ({
      address: current?.bindingKind === "ip" ? current.addressText : null,
      hostname: current?.bindingKind === "hostname" ? current.addressText : null,
      origin: origin ?? null,
      accountRef: accessContext.accountRef,
      connectionRef: accessContext.connectionRef,
    }),
    [current, origin, accessContext],
  );

  const recipeResolution = useMemo(
    () =>
      resolveRecipeCopy(FOLLOW_UP_RECIPE, {
        ...baseSnapshot,
        command: null,
      }),
    [baseSnapshot],
  );

  const snapshot = useMemo(
    () => ({
      ...baseSnapshot,
      command: recipeResolution.ok ? recipeResolution.text : null,
    }),
    [baseSnapshot, recipeResolution],
  );

  if (targets.isPending || (activeTargetId !== null && bindings.isPending)) {
    return (
      <section aria-label="Target context" className="mt-5 border-t border-border pt-4">
        <p className="m-0 text-[12px] text-muted-foreground">Loading target context.</p>
      </section>
    );
  }

  if (targets.isError || (activeTargetId !== null && bindings.isError)) {
    return (
      <section aria-label="Target context" className="mt-5 border-t border-border pt-4">
        <p className="m-0 text-[12px] text-muted-foreground">Target context unavailable.</p>
        <Button
          type="button"
          variant="quiet"
          onClick={() => {
            void targets.refetch();
            void bindings.refetch();
          }}
        >
          Retry
        </Button>
      </section>
    );
  }

  const onSelectTarget = (targetId: string) => {
    setSelectedTargetId(targetId);
    setOffer(null);
    setCopied(null);
    setCopyMissing(null);
  };

  const onChangeAddress = async () => {
    if (activeTargetId === null || changing) return;
    setChanging(true);
    setChangeError(null);
    try {
      await changeStoneAddressRequest(engagementId, activeTargetId, {
        newAddress: newAddress.trim(),
      });
      setNewAddress("");
      await queryClient.invalidateQueries({ queryKey: stoneTargetsQueryKey(engagementId) });
      await queryClient.invalidateQueries({
        queryKey: stoneBindingsQueryKey(engagementId, activeTargetId),
      });
    } catch {
      setChangeError("The address change was not accepted. Check the value and try again.");
    } finally {
      setChanging(false);
    }
  };

  const onProposeHostname = async () => {
    if (activeTargetId === null || offerBusy) return;
    setOfferBusy(true);
    setOfferError(null);
    try {
      const association = await proposeStoneHostnameRequest(engagementId, activeTargetId, {
        connectionAddress:
          connectionAddress.trim().length > 0
            ? connectionAddress.trim()
            : (current?.addressText ?? ""),
        requestedHostname: requestedHostname.trim(),
      });
      setOffer(association);
    } catch {
      setOfferError("The hostname offer was not accepted. Check the values and try again.");
    } finally {
      setOfferBusy(false);
    }
  };

  const onDecideHostname = async (decision: "associated" | "declined") => {
    if (offer === null || offerBusy) return;
    setOfferBusy(true);
    setOfferError(null);
    try {
      const decided = await decideStoneHostnameRequest(engagementId, offer.id, decision);
      setOffer(decided);
    } catch {
      setOfferError("The decision was not recorded. Try again.");
    } finally {
      setOfferBusy(false);
    }
  };

  const onCopy = async (kind: StoneCopyKind) => {
    const resolved = buildCopyText(kind, snapshot);
    if (!resolved.ok) {
      setCopyMissing(`Missing: ${resolved.missing.join(", ")}`);
      setCopied(null);
      return;
    }
    setCopyMissing(null);
    try {
      const clipboard = navigator.clipboard;
      if (clipboard !== undefined) await clipboard.writeText(resolved.text);
      setCopied(`${STONE_COPY_ACTION_LABELS[kind]}. ${COPIED_NOT_RAN_NOTE}`);
    } catch {
      setCopied(`${STONE_COPY_ACTION_LABELS[kind]} failed. Value shown above.`);
    }
  };

  return (
    <section aria-label="Target context" className="mt-5 border-t border-border pt-4">
      <header className="mb-3">
        <h2 className="m-0 text-[13px] font-semibold">Target context</h2>
        <p className="mt-1 mb-0 text-[12px] leading-5 text-muted-foreground">
          Reusable address, hostname, origin, and connection values. History keeps the values
          actually used.
        </p>
      </header>

      <p className="m-0 text-[12px] leading-5 text-muted-foreground" data-testid="recorded-session">
        {formatRecordedSessionLabel(accessContext.lastConfirmedAt)}
      </p>
      <p className="mt-1 mb-0 text-[12px] leading-5 text-muted-foreground">
        Access context is read-only here. Access records own it.
      </p>

      <label className="mt-3 grid gap-1 text-[11px] text-muted-foreground" htmlFor="stone-target-select">
        <span>Target</span>
        <select
          id="stone-target-select"
          className="min-h-11 w-full rounded-md border border-input bg-transparent px-2.5 text-[13px] text-foreground md:min-h-8"
          value={activeTargetId ?? ""}
          onChange={(event) => onSelectTarget(event.target.value)}
        >
          {(targets.data ?? []).map((target) => (
            <option key={target.id} value={target.id}>
              {target.label}
            </option>
          ))}
        </select>
      </label>

      {current !== null ? (
        <dl className="mt-3 grid gap-1 text-[12px] leading-5">
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Current binding</dt>
            <dd className="m-0 font-mono">{current.addressText}</dd>
          </div>
          {(bindings.data?.historical ?? []).map((binding) => (
            <div className="flex gap-2" key={binding.id}>
              <dt className="text-muted-foreground">Historical</dt>
              <dd className="m-0 font-mono">
                {binding.addressText} (superseded {binding.supersededAt ?? "unknown"})
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-3 mb-0 text-[12px] text-muted-foreground">No current binding.</p>
      )}

      <div className="mt-3 grid gap-2">
        <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="stone-new-address">
          <span>Target address changed</span>
          <input
            id="stone-new-address"
            className="min-h-11 w-full rounded-md border border-input bg-transparent px-2.5 font-mono text-[13px] text-foreground md:min-h-8"
            value={newAddress}
            placeholder="10.0.0.9"
            onChange={(event) => setNewAddress(event.target.value)}
          />
        </label>
        <p className="m-0 text-[12px] leading-5 text-muted-foreground">
          Future actions use the new binding. Old runs and snapshots stay visible as historical.
        </p>
        {changeError !== null ? (
          <p className="m-0 text-[13px] text-destructive" role="alert">
            {changeError}
          </p>
        ) : null}
        <div>
          <Button type="button" disabled={changing} onClick={() => void onChangeAddress()}>
            {changing ? "Saving" : "Change address"}
          </Button>
        </div>
      </div>

      <div className="mt-4 grid gap-2 border-t border-border pt-4">
        <h3 className="m-0 text-[12px] font-semibold">Redirect hostname</h3>
        <div className="grid gap-2">
          <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="stone-connection-address">
            <span>Connection address</span>
            <input
              id="stone-connection-address"
              className="min-h-11 w-full rounded-md border border-input bg-transparent px-2.5 font-mono text-[13px] text-foreground md:min-h-8"
              value={connectionAddress}
              placeholder={current?.addressText ?? "10.0.0.5"}
              onChange={(event) => setConnectionAddress(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-[11px] text-muted-foreground" htmlFor="stone-requested-hostname">
            <span>Requested hostname</span>
            <input
              id="stone-requested-hostname"
              className="min-h-11 w-full rounded-md border border-input bg-transparent px-2.5 font-mono text-[13px] text-foreground md:min-h-8"
              value={requestedHostname}
              placeholder="app.internal"
              onChange={(event) => setRequestedHostname(event.target.value)}
            />
          </label>
        </div>
        {offerError !== null ? (
          <p className="m-0 text-[13px] text-destructive" role="alert">
            {offerError}
          </p>
        ) : null}
        <div>
          <Button type="button" variant="quiet" disabled={offerBusy} onClick={() => void onProposeHostname()}>
            {offerBusy ? "Working" : "Propose association"}
          </Button>
        </div>
        {offer !== null ? (
          <div className="grid gap-1 text-[12px] leading-5" data-testid="hostname-offer">
            <p className="m-0">
              Connection address <span className="font-mono">{offer.connectionAddress}</span>,
              requested host <span className="font-mono">{offer.requestedHostname}</span>.
            </p>
            <p className="m-0 text-muted-foreground">
              HTTP host and TLS server name use {offer.requestedHostname}.
            </p>
            <p className="m-0 text-muted-foreground">{offer.runnerOnlyNote}</p>
            <p className="m-0 text-muted-foreground">{offer.nextStep}</p>
            <p className="m-0 text-muted-foreground">Status: {offer.status}.</p>
            {offer.status === "proposed" ? (
              <div className="flex flex-wrap gap-2">
                <Button type="button" disabled={offerBusy} onClick={() => void onDecideHostname("associated")}>
                  Associate
                </Button>
                <Button type="button" variant="quiet" disabled={offerBusy} onClick={() => void onDecideHostname("declined")}>
                  Decline
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="mt-4 grid gap-2 border-t border-border pt-4">
        <h3 className="m-0 text-[12px] font-semibold">Copy</h3>
        <div className="flex flex-wrap gap-2">
          {COPY_ORDER.map((kind) => (
            <Button
              key={kind}
              type="button"
              variant="quiet"
              onClick={() => void onCopy(kind)}
            >
              {STONE_COPY_ACTION_LABELS[kind]}
            </Button>
          ))}
        </div>
        {copyMissing !== null ? (
          <p className="m-0 text-[12px] text-muted-foreground" role="status">
            {copyMissing}
          </p>
        ) : null}
        {copied !== null ? (
          <p className="m-0 text-[12px] text-muted-foreground" role="status">
            {copied}
          </p>
        ) : null}
      </div>

      <div className="mt-4 grid gap-2 border-t border-border pt-4">
        <h3 className="m-0 text-[12px] font-semibold">Follow-up recipe</h3>
        {recipeResolution.ok ? (
          <code className={cn("font-mono text-[12px] break-all")}>{recipeResolution.text}</code>
        ) : (
          <p className="m-0 text-[12px] text-muted-foreground">
            Missing: {recipeResolution.missing.join(", ")}
          </p>
        )}
        <p className="m-0 text-[12px] text-muted-foreground">{COPIED_NOT_RAN_NOTE}</p>
      </div>
    </section>
  );
}

export async function prefetchStoneBindingsForTarget(
  engagementId: string,
  targetId: string,
): Promise<void> {
  await fetchStoneBindings(engagementId, targetId);
}

// Extension slot consumed by STONE-2 workspace mounting after it merges.
export const STONE5_TARGET_CONTEXT_SLOT = {
  id: "stone5-target-context",
  Panel: TargetContextPanel,
} as const;
