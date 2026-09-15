import { cn } from "./cn.js";

export interface SwitchProps {
  checked: boolean;
  onCheckedChange?: (v: boolean) => void;
  disabled?: boolean;
  label: string;
  className?: string;
}

// Track is 26x16 with p-[2px], so the inner run is 22px wide. The 12px
// thumb leaves 10px of travel, handled by justify-start/justify-end.
export function Switch({ checked, onCheckedChange, disabled = false, label, className }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={cn(
        "inline-flex h-4 w-[26px] shrink-0 cursor-pointer items-center rounded-full p-[2px] transition-colors duration-100 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed",
        checked ? "bg-primary justify-end" : "bg-input justify-start",
        disabled && "opacity-55",
        className,
      )}
      onClick={onCheckedChange ? () => onCheckedChange(!checked) : undefined}
    >
      <span className="block size-3 shrink-0 rounded-full bg-background shadow-sm" />
    </button>
  );
}
