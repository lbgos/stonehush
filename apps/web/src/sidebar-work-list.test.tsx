// @vitest-environment jsdom

import {
  SidebarCardRow,
  SidebarCompactRow,
  SidebarRowAction,
  SidebarShelf,
} from "@stonehush/ui";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

interface TestItem {
  id: string;
  title: string;
}

const items: readonly TestItem[] = Array.from({ length: 40 }, (_, index) => ({
  id: `item-${index + 1}`,
  title: `History item ${index + 1}`,
}));

function HistoryShelf({ currentId = "item-38", defaultOpen = true }) {
  return (
    <SidebarShelf
      currentId={currentId}
      defaultOpen={defaultOpen}
      getId={(item) => item.id}
      items={items}
      paginated
      renderItem={(item) => (
        <SidebarCompactRow
          context="fixture.lab"
          current={item.id === currentId}
          href={`#${item.id}`}
          itemId={item.id}
          status="Complete"
          title={item.title}
        />
      )}
      title="History"
    />
  );
}

afterEach(() => cleanup());

describe("SidebarShelf", () => {
  it("renders the initial ten items plus one preserved current item in visual focus order", () => {
    const { container } = render(<HistoryShelf />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(11);
    expect(links.map((link) => link.textContent)).toEqual([
      "History item 1Completefixture.lab",
      "History item 2Completefixture.lab",
      "History item 3Completefixture.lab",
      "History item 4Completefixture.lab",
      "History item 5Completefixture.lab",
      "History item 6Completefixture.lab",
      "History item 7Completefixture.lab",
      "History item 8Completefixture.lab",
      "History item 9Completefixture.lab",
      "History item 10Completefixture.lab",
      "History item 38Completefixture.lab",
    ]);
    expect(container.querySelector('[data-collection-item="item-11"]')).toBeNull();
    expect(container.querySelectorAll('[data-collection-item="item-38"]')).toHaveLength(1);
    expect(screen.getByRole("link", { name: /History item 38/ }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(screen.getByRole("button", { name: "Show more (25)" })).toBeTruthy();
    const interactive = Array.from(container.querySelectorAll("button, a"));
    expect(interactive[0]).toBe(screen.getByRole("button", { name: /History/ }));
    expect(interactive.slice(1, 12)).toEqual(links);
    expect(interactive[12]).toBe(screen.getByRole("button", { name: "Show more (25)" }));
  });

  it("keeps only the current item rendered while collapsed", () => {
    const { container } = render(<HistoryShelf />);
    const trigger = screen.getByRole("button", { name: /History/ });
    expect(trigger.tagName).toBe("BUTTON");
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-collection-item="item-1"]')).toBeNull();
    expect(container.querySelectorAll('[data-collection-item="item-38"]')).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Show more/ })).toBeNull();
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("adds history in batches of 25 without duplicating the current item", () => {
    const { container } = render(<HistoryShelf />);
    fireEvent.click(screen.getByRole("button", { name: "Show more (25)" }));

    expect(container.querySelectorAll("[data-collection-item]")).toHaveLength(36);
    expect(container.querySelector('[data-collection-item="item-35"]')).toBeTruthy();
    expect(container.querySelector('[data-collection-item="item-36"]')).toBeNull();
    expect(container.querySelectorAll('[data-collection-item="item-38"]')).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Show more (5)" }));

    expect(container.querySelectorAll("[data-collection-item]")).toHaveLength(40);
    expect(container.querySelectorAll('[data-collection-item="item-38"]')).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Show more/ })).toBeNull();
  });

  it("keeps hidden non-current items out of the DOM and focus order", () => {
    const { container } = render(<HistoryShelf currentId="missing" defaultOpen={false} />);
    const trigger = screen.getByRole("button", { name: /History/ });
    expect(container.querySelector("[data-collection-item]")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.querySelectorAll("a, button")).toHaveLength(1);

    fireEvent.click(trigger);
    expect(screen.getAllByRole("link")).toHaveLength(10);
  });
});

describe("sidebar row surfaces", () => {
  it("keeps route, selection, background, and textual status as separate state", () => {
    const action = vi.fn();
    const { container } = render(
      <div>
        <SidebarCardRow
          action={
            <SidebarRowAction label="Open selected row" onClick={action}>
              Open
            </SidebarRowAction>
          }
          context="fixture.lab"
          href="#selected"
          itemId="selected"
          metadata="4 services"
          selected
          status="Needs input"
          title="Selected row"
        />
        <SidebarCompactRow
          context="fixture.lab"
          current
          href="#current"
          itemId="current"
          status="Reviewed"
          title="Current row"
        />
        <SidebarCompactRow
          background
          context="fixture.lab"
          href="#background"
          itemId="background"
          status="Waiting"
          title="Background row"
        />
      </div>,
    );

    const selected = container.querySelector('[data-item-id="selected"]')!;
    const current = container.querySelector('[data-item-id="current"]')!;
    const background = container.querySelector('[data-item-id="background"]')!;
    expect(selected.getAttribute("data-selected")).toBe("true");
    expect(selected.hasAttribute("data-current")).toBe(false);
    expect(selected.className).toContain("bg-sidebar-selected");
    expect(current.getAttribute("data-current")).toBe("true");
    expect(current.className).toContain("bg-sidebar-active");
    expect(background.getAttribute("data-background")).toBe("true");
    expect(background.className).toContain("hover:bg-sidebar-hover");
    expect(within(selected as HTMLElement).getByLabelText("Status: Needs input")).toBeTruthy();
    expect(within(current as HTMLElement).getByLabelText("Status: Reviewed")).toBeTruthy();
    expect(within(background as HTMLElement).getByLabelText("Status: Waiting")).toBeTruthy();

    const rowAction = screen.getByRole("button", { name: "Open selected row" });
    expect(rowAction.className).toContain("min-h-11");
    rowAction.focus();
    fireEvent.click(rowAction);
    expect(action).toHaveBeenCalledTimes(1);
    expect(selected.querySelector(".sidebar-row-actions")).toBeTruthy();
    expect((selected as HTMLElement).style.contentVisibility).toBe("auto");
    expect(screen.getAllByRole("link").every((link) => link.className.includes("min-h-"))).toBe(
      true,
    );
  });

  it("omits the status affordance when no status is provided", () => {
    const { container } = render(
      <div>
        <SidebarCardRow
          context="fixture.lab"
          href="#plain"
          itemId="plain"
          metadata="4 services"
          title="Plain row"
        />
        <SidebarCompactRow
          context="fixture.lab"
          href="#plain-compact"
          itemId="plain-compact"
          title="Plain compact"
        />
      </div>,
    );
    expect(container.querySelector('[aria-label^="Status:"]')).toBeNull();
  });
});
