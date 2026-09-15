import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "./cn.js";

export interface FullScreenSheetProps {
  children: ReactNode;
  description: string;
  onOpenChangeComplete?: (open: boolean) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: string;
  trigger: ReactNode;
  triggerClassName?: string;
  triggerLabel: string;
}

export function FullScreenSheet({
  children,
  description,
  onOpenChangeComplete,
  onOpenChange,
  open,
  title,
  trigger,
  triggerClassName,
  triggerLabel,
}: FullScreenSheetProps) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={onOpenChangeComplete}
    >
      <Dialog.Trigger
        aria-label={triggerLabel}
        className={cn(
          "inline-flex size-11 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring",
          triggerClassName,
        )}
      >
        {trigger}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop
          className="fixed inset-0 z-50 bg-black/45 transition-opacity duration-200 ease-in-out data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none"
        />
        <Dialog.Viewport className="fixed inset-0 z-50">
          <Dialog.Popup className="flex h-dvh w-dvw flex-col overflow-hidden bg-background text-foreground outline-none transition-transform duration-200 ease-in-out data-[ending-style]:translate-x-[-2%] data-[starting-style]:translate-x-[-2%] motion-reduce:transition-none">
            <header className="flex min-h-16 shrink-0 items-center gap-3 border-b border-border px-[max(1rem,env(safe-area-inset-left))] pt-[env(safe-area-inset-top)] pr-[max(0.5rem,env(safe-area-inset-right))]">
              <div className="min-w-0 flex-1">
                <Dialog.Title className="m-0 truncate text-lg font-semibold tracking-[-0.03em]">{title}</Dialog.Title>
                <Dialog.Description className="sr-only">{description}</Dialog.Description>
              </div>
              <Dialog.Close
                aria-label={`Close ${title.toLowerCase()}`}
                className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="size-4" aria-hidden="true" />
              </Dialog.Close>
            </header>
            <div className="min-h-0 flex-1 overflow-auto">{children}</div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
