import { Status } from "@stonehush/ui";
import { Link } from "@tanstack/react-router";

import { useAdvisorStatusQuery } from "./advisor-status-query.js";
import type { AdvisorStatus } from "@stonehush/contracts";

function SettingsLink() {
  return (
    <Link
      to="/settings"
      search={{ section: "advisor" }}
      className="inline-flex min-h-8 items-center rounded-md px-2 text-[13px] font-semibold text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
    >
      Open Advisor settings
    </Link>
  );
}

function statusCopy(status: AdvisorStatus): { detail: string; title: string } {
  switch (status.reason) {
    case "ok":
      // The probe only receives HTTP headers and never performs inference:
      // report the endpoint reachable, never the model verified.
      return {
        title: "Advisor endpoint reachable",
        detail:
          status.latencyMs === null
            ? `${status.modelId} endpoint at ${status.endpointHost} responded. Headers-only probe; model output not verified.`
            : `${status.modelId} endpoint at ${status.endpointHost} responded in ${status.latencyMs} ms. Headers-only probe; model output not verified.`,
      };
    case "unconfigured":
      return {
        title: "Advisor is not configured",
        detail: "Set an endpoint and a model in Settings, then check back here.",
      };
    case "missing_key_env":
      return {
        title: "Advisor key reference is missing",
        detail: "Name the environment variable holding the API key in Settings.",
      };
    case "key_unset":
      return {
        title: "Advisor API key is not set",
        detail:
          status.keyEnvVar === ""
            ? "Set the configured key variable in the control-plane environment."
            : `Set ${status.keyEnvVar} in the control-plane environment, then reload this panel.`,
      };
    case "public_not_opted_in":
      return {
        title: "Public endpoint needs opt-in",
        detail: `${status.endpointHost} looks public. Opt in to public endpoints in Settings to test it.`,
      };
    case "unreachable":
      return {
        title: "Advisor endpoint is unreachable",
        detail: `${status.modelId} at ${status.endpointHost} did not answer. Start the endpoint or fix the base URL in Settings.`,
      };
    case "probe_failed":
      return {
        title: "Advisor connection test failed",
        detail: "The control plane could not test the endpoint. Check the base URL in Settings.",
      };
  }
}

// Console Advisor tab: configuration plus a tested connection, or a
// truthful reason why not. Shows the endpoint host only, never a full URL.
export function AdvisorStatusCard() {
  const status = useAdvisorStatusQuery();

  if (status.isPending) {
    return (
      <Status
        loading
        title="Checking advisor connection"
        detail="Probing the configured endpoint."
      />
    );
  }

  if (status.isError || !status.data) {
    return (
      <Status
        title="Advisor status is unavailable"
        detail="The control plane did not return advisor status."
        action={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void status.refetch()}
              className="inline-flex min-h-8 items-center rounded-md bg-primary px-3 text-[13px] font-semibold text-primary-foreground outline-none hover:brightness-[1.06] focus-visible:ring-2 focus-visible:ring-ring"
            >
              Retry
            </button>
            <SettingsLink />
          </div>
        }
      />
    );
  }

  const copy = statusCopy(status.data);
  const tone =
    status.data.endpointReachable === true
      ? "success"
      : status.data.reason === "unconfigured"
        ? "info"
        : "warning";
  return (
    <Status title={copy.title} detail={copy.detail} tone={tone} action={<SettingsLink />} />
  );
}
