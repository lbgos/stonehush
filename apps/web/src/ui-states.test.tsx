// @vitest-environment jsdom

import {
  Button,
  EmptyState,
  FatalErrorBoundary,
  LoadingRegion,
  RecoverableError,
  Skeleton,
  StaleDataState,
} from "@stonehush/ui";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("loading and empty states", () => {
  it("announces one stable loading label while skeleton pieces stay hidden", () => {
    const { container } = render(
      <LoadingRegion label="Loading surface" className="space-y-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-20 w-full" />
      </LoadingRegion>,
    );

    const status = screen.getByRole("status", { name: "Loading surface" });
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(status.querySelector(".sr-only")?.textContent).toBe("Loading surface");
    const skeletons = container.querySelectorAll(".ui-skeleton");
    expect(skeletons).toHaveLength(2);
    expect(Array.from(skeletons).every((piece) => piece.getAttribute("aria-hidden") === "true")).toBe(
      true,
    );
  });

  it("keeps primary and filtered empty states semantically and textually distinct", () => {
    const { container } = render(
      <div>
        <EmptyState
          variant="primary"
          title="Nothing here yet"
          description="Create the first local item."
          action={<Button>Create item</Button>}
        />
        <EmptyState
          variant="filtered"
          title="Nothing matches"
          description="Clear filters to see existing items."
          action={<Button variant="secondary">Clear filters</Button>}
        />
      </div>,
    );

    expect(screen.getByRole("heading", { name: "Nothing here yet" })).toBeTruthy();
    expect(screen.getByText("Create the first local item.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Nothing matches" })).toBeTruthy();
    expect(screen.getByText("Clear filters to see existing items.")).toBeTruthy();
    expect(container.querySelector('[data-empty-variant="primary"]')).toBeTruthy();
    expect(container.querySelector('[data-empty-variant="filtered"]')).toBeTruthy();
  });
});

describe("stale and recoverable states", () => {
  it("preserves stale content while exposing a working refresh callback", () => {
    const retry = vi.fn();
    render(
      <StaleDataState
        title="Showing saved data"
        description="The latest refresh failed."
        onRetry={retry}
      >
        <article>Still-valid observation</article>
      </StaleDataState>,
    );

    const stale = screen.getByRole("region", { name: "Stale data" });
    expect(within(stale).getByText("Still-valid observation")).toBeTruthy();
    expect(within(stale).getByText("The latest refresh failed.")).toBeTruthy();
    fireEvent.click(within(stale).getByRole("button", { name: "Refresh" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(within(stale).getByText("Still-valid observation")).toBeTruthy();
  });

  it("supports real retry callbacks for inline and page failures", () => {
    const retry = vi.fn();
    render(
      <div>
        <RecoverableError
          title="Panel unavailable"
          description="Other content is still usable."
          onRetry={retry}
        />
        <RecoverableError
          variant="page"
          title="Page unavailable"
          description="Try this page again."
          onRetry={retry}
        />
      </div>,
    );

    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(2);
    for (const button of screen.getAllByRole("button", { name: "Retry" })) {
      fireEvent.click(button);
    }
    expect(retry).toHaveBeenCalledTimes(2);
  });
});

describe("FatalErrorBoundary", () => {
  it("catches a render failure, keeps hostile details closed as text, and recovers", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let shouldThrow = true;
    const retry = vi.fn(() => {
      shouldThrow = false;
    });
    const reload = vi.fn();

    function HostileChild() {
      if (shouldThrow) throw new Error('<img src=x onerror="steal()">');
      return <p>Recovered content</p>;
    }

    const { container } = render(
      <FatalErrorBoundary onRetry={retry} onReload={reload}>
        <HostileChild />
      </FatalErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toBeTruthy();
    const details = screen.getByText("Technical details").closest("details")!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('<img src=x onerror="steal()">');
    expect(container.querySelector("img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reload app" }));
    expect(reload).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Recovered content")).toBeTruthy();
  });
});
