import { RefreshCw, TriangleAlert } from "lucide-react";
import { Component, useId, type ErrorInfo, type ReactNode } from "react";

import { Button } from "./button.js";
import { cn } from "./cn.js";

export interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return <span className={cn("ui-skeleton block rounded-md bg-muted", className)} aria-hidden="true" />;
}

export interface LoadingRegionProps {
  children: ReactNode;
  className?: string;
  label: string;
}

export function LoadingRegion({ children, className, label }: LoadingRegionProps) {
  const labelId = useId();
  return (
    <section
      aria-busy="true"
      aria-labelledby={labelId}
      aria-live="polite"
      className={className}
      role="status"
    >
      <span id={labelId} className="sr-only">
        {label}
      </span>
      <div aria-hidden="true">{children}</div>
    </section>
  );
}

export interface StaleDataStateProps {
  children: ReactNode;
  description: string;
  onRetry?: () => void;
  retryLabel?: string;
  title: string;
}

export function StaleDataState({
  children,
  description,
  onRetry,
  retryLabel = "Refresh",
  title,
}: StaleDataStateProps) {
  return (
    <section aria-label="Stale data">
      <div
        className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-warning/35 bg-warning/10 p-4"
        role="status"
      >
        <RefreshCw className="size-4 shrink-0 text-warning" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="m-0 text-[13px] font-semibold text-foreground">{title}</p>
          <p className="mt-1 mb-0 text-[13px] text-muted-foreground">{description}</p>
        </div>
        {onRetry && (
          <Button variant="secondary" onClick={onRetry}>
            {retryLabel}
          </Button>
        )}
      </div>
      {children}
    </section>
  );
}

export interface RecoverableErrorProps {
  description: string;
  onRetry: () => void;
  retryLabel?: string;
  title: string;
  variant?: "inline" | "page";
}

export function RecoverableError({
  description,
  onRetry,
  retryLabel = "Retry",
  title,
  variant = "inline",
}: RecoverableErrorProps) {
  return (
    <section
      className={cn(
        "rounded-xl border border-warning/35 bg-warning/10",
        variant === "page" ? "px-6 py-10 text-center" : "p-4",
      )}
      role="alert"
    >
      <TriangleAlert
        className={cn("size-5 text-warning", variant === "page" && "mx-auto")}
        aria-hidden="true"
      />
      <h2 className={cn("mb-0 font-semibold text-foreground", variant === "page" ? "mt-3 text-lg" : "mt-2 text-[13px]")}>
        {title}
      </h2>
      <p className="mt-2 mb-0 text-[13px] leading-6 text-muted-foreground">{description}</p>
      <Button className="mt-4" variant="secondary" onClick={onRetry}>
        {retryLabel}
      </Button>
    </section>
  );
}

export interface FatalErrorViewProps {
  description: string;
  onReload: () => void;
  onRetry: () => void;
  technicalDetails: string;
  title: string;
}

export function FatalErrorView({
  description,
  onReload,
  onRetry,
  technicalDetails,
  title,
}: FatalErrorViewProps) {
  return (
    <section className="rounded-xl border border-destructive/40 bg-destructive/10 px-6 py-10" role="alert">
      <TriangleAlert className="size-5 text-destructive" aria-hidden="true" />
      <h1 className="mt-3 mb-0 text-[26px] leading-none font-semibold tracking-[-0.04em] text-foreground">{title}</h1>
      <p className="mt-2 mb-0 max-w-xl text-[13px] leading-6 text-muted-foreground">{description}</p>
      <div className="mt-5 flex flex-wrap gap-2">
        <Button onClick={onRetry}>Retry</Button>
        <Button variant="secondary" onClick={onReload}>
          Reload app
        </Button>
      </div>
      <details className="mt-5 rounded-lg border border-border bg-card p-4 text-[13px]">
        <summary className="cursor-pointer text-[13px] font-semibold text-foreground">Technical details</summary>
        <pre className="mt-3 mb-0 overflow-auto whitespace-pre-wrap font-mono text-xs text-muted-foreground">
          {technicalDetails}
        </pre>
      </details>
    </section>
  );
}

export interface FatalErrorBoundaryProps {
  children: ReactNode;
  description?: string;
  onError?: (error: Error, info: ErrorInfo) => void;
  onReload?: () => void;
  onRetry?: () => void;
  title?: string;
}

interface FatalErrorBoundaryState {
  error: Error | null;
}

export class FatalErrorBoundary extends Component<
  FatalErrorBoundaryProps,
  FatalErrorBoundaryState
> {
  override state: FatalErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): FatalErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  private retry = () => {
    this.props.onRetry?.();
    this.setState({ error: null });
  };

  private reload = () => {
    if (this.props.onReload) {
      this.props.onReload();
      return;
    }
    window.location.reload();
  };

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <FatalErrorView
        description={this.props.description ?? "The interface stopped rendering this view."}
        onReload={this.reload}
        onRetry={this.retry}
        technicalDetails={error.stack ?? error.message}
        title={this.props.title ?? "Stonehush hit a fatal error"}
      />
    );
  }
}
