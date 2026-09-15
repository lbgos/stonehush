import { ContextMenu } from "@base-ui/react/context-menu";
import * as React from "react";

import { cn } from "./cn.js";

export interface RowContextMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  destructive?: boolean;
}

export interface RowContextMenuProps {
  label: string;
  items: readonly (RowContextMenuItem | { separator: true })[];
  children: React.ReactNode;
}

// Trigger merges onto a plain DOM child via `render` so the wrapped element
// keeps its layout and left-click behavior. Custom components cannot take the
// trigger ref, so they render inside the trigger's own element instead.
// MenuItem closes the popup on click by default (`closeOnClick`) and handles
// keyboard interaction, so `onClick` preserves both without extra props.
export function RowContextMenu({ label, items, children }: RowContextMenuProps) {
  const trigger =
    React.isValidElement(children) && typeof children.type === "string" ? (
      <ContextMenu.Trigger render={children} />
    ) : (
      <ContextMenu.Trigger>{children}</ContextMenu.Trigger>
    );

  return (
    <ContextMenu.Root>
      {trigger}
      <ContextMenu.Portal>
        <ContextMenu.Positioner align="start" className="z-50" sideOffset={4}>
          <ContextMenu.Popup
            aria-label={label}
            className="z-50 min-w-44 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none"
          >
            {items.map((entry, index) => {
              if ("separator" in entry) {
                return <ContextMenu.Separator key={`separator-${index}`} className="my-1 h-px bg-border" />;
              }
              return (
                <ContextMenu.Item
                  key={`${entry.label}-${index}`}
                  disabled={entry.disabled}
                  onClick={entry.onSelect}
                  className={cn(
                    "flex min-h-8 w-full cursor-pointer items-center rounded-md px-2.5 text-[13px] outline-none select-none data-[highlighted]:bg-accent",
                    entry.destructive ? "text-destructive" : "text-foreground",
                    entry.disabled && "pointer-events-none opacity-50",
                  )}
                >
                  {entry.label}
                </ContextMenu.Item>
              );
            })}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
