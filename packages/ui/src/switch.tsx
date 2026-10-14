import { cn } from "./cn.js";

export interface SwitchProps {
  checked: boolean;
  onCheckedChange?: (v: boolean) => void;
  disabled?: boolean;
  label: string;
  className?: string;
}

// Keep the 26x16 track inside the button so coarse-pointer hit-area sizing
// can enlarge the control without stretching the track or thumb travel.
export function Switch({ checked, onCheckedChange, disabled = false, label, className }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={cn(
        "inline-flex h-4 w-[26px] shrink-0 cursor-pointer items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed",
        disabled && "opacity-55",
        className,
      )}
      onClick={onCheckedChange ? () => onCheckedChange(!checked) : undefined}
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex h-4 w-[26px] shrink-0 items-center rounded-full p-[2px] transition-colors duration-100",
          checked ? "bg-primary justify-end" : "bg-input justify-start",
        )}
      >
        <span className="block size-3 shrink-0 rounded-full bg-background shadow-sm" />
      </span>
    </button>
  );
}
