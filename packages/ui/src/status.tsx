import { CircleCheck, LoaderCircle, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "./cn.js";

type StatusTone = "info" | "success" | "warning";

const toneClasses: Record<StatusTone, string> = {
  info: "border-info/30 bg-info/10 text-info",
  success: "border-success/30 bg-success/10 text-success",
  warning: "border-warning/30 bg-warning/10 text-warning",
};

export interface StatusProps {
  action?: ReactNode;
  detail: string;
  loading?: boolean;
  title: string;
  tone?: StatusTone;
}

export function Status({ action, detail, loading = false, title, tone = "info" }: StatusProps) {
  const Icon = loading ? LoaderCircle : tone === "success" ? CircleCheck : TriangleAlert;

  return (
    <section
      className={cn("flex items-start gap-3 rounded-lg border p-4", toneClasses[tone])}
      role="status"
      aria-live="polite"
      aria-busy={loading || undefined}
      aria-label={loading ? title : undefined}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 text-foreground">
        <p className="m-0 text-[13px] font-semibold">{title}</p>
        <p className="mt-1 mb-0 text-[13px] text-muted-foreground">{detail}</p>
        {action && <div className="mt-3">{action}</div>}
      </div>
    </section>
  );
}
