import { ReportBundleSchema, type ReportBundle } from "@stonehush/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";

import { ReportQueryError } from "./errors.js";

export function reportQueryKey(engagementId: string) {
  return ["engagements", engagementId, "report"] as const;
}

export function reportJsonUrl(engagementId: string): string {
  return `/api/v1/engagements/${engagementId}/report`;
}

export function reportMarkdownUrl(engagementId: string): string {
  return `/api/v1/engagements/${engagementId}/report?format=markdown`;
}

export function reportJsonFilename(engagementId: string): string {
  return `engagement-${engagementId}-report.json`;
}

export function reportMarkdownFilename(engagementId: string): string {
  return `engagement-${engagementId}-report.md`;
}

export async function fetchReportBundle(
  engagementId: string,
  signal?: AbortSignal,
): Promise<ReportBundle> {
  let response: Response;
  try {
    response = await fetch(
      reportJsonUrl(engagementId),
      signal ? { signal } : undefined,
    );
  } catch {
    throw new ReportQueryError();
  }
  if (response.status !== 200) throw new ReportQueryError();
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ReportQueryError();
  }
  const result = ReportBundleSchema.safeParse(payload);
  if (!result.success) throw new ReportQueryError();
  return result.data;
}

export async function fetchReportMarkdown(
  engagementId: string,
  signal?: AbortSignal,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(
      reportMarkdownUrl(engagementId),
      signal ? { signal } : undefined,
    );
  } catch {
    throw new ReportQueryError();
  }
  if (response.status !== 200) throw new ReportQueryError();
  try {
    return await response.text();
  } catch {
    throw new ReportQueryError();
  }
}

export function downloadTextFile(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const anchor = document.createElement("a");
  if (typeof URL.createObjectURL === "function") {
    const url = URL.createObjectURL(blob);
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  } else {
    anchor.href = `data:${type},${encodeURIComponent(content)}`;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }
}

export async function copyTextToClipboard(value: string): Promise<boolean> {
  try {
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard !== undefined &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the legacy path below.
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}

export function reportQueryOptions(engagementId: string) {
  return queryOptions({
    queryKey: reportQueryKey(engagementId),
    queryFn: ({ signal }) => fetchReportBundle(engagementId, signal),
    // Global client disables mount refetch; an invalidated inactive report
    // must still refresh when the operator revisits it.
    refetchOnMount: true,
  });
}

export function useReportQuery(engagementId: string) {
  return useQuery(reportQueryOptions(engagementId));
}
