import type { Engagement, EngagementKind, EngagementStatus } from "@stonehush/contracts";

export const ENGAGEMENT_KIND_LABELS: Record<EngagementKind, string> = {
  assessment: "Assessment",
  ctf: "CTF",
  lab: "Lab",
};

export const ENGAGEMENT_STATUS_LABELS: Record<EngagementStatus, string> = {
  active: "Active",
  archived: "Archived",
};

export function formatEngagementTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return `${new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date)} UTC`;
}

export function formatEngagementAge(value: string, now = Date.now()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const deltaSeconds = Math.max(0, Math.round((now - date.getTime()) / 1000));
  if (deltaSeconds < 60) return `${deltaSeconds}s`;
  const minutes = Math.round(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

export function engagementContext(engagement: Engagement): string {
  return ENGAGEMENT_KIND_LABELS[engagement.kind];
}

export function engagementMetadata(engagement: Engagement, now = Date.now()): string {
  return `rev ${engagement.revision} · ${formatEngagementAge(engagement.updatedAt, now)}`;
}
