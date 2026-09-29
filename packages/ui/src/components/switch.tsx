import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "../cn";

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "role"> {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

/**
 * An on and off switch: a native button with role=switch and aria-checked,
 * so click, Space and Enter all toggle it (a button fires click for both
 * keys) and screen readers announce it as a switch. The whole control is a
 * 44 px target around a smaller track. Give it a visible label with
 * aria-labelledby or a wrapping label, or an aria-label.
 */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, onCheckedChange, className, disabled, onClick, type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) {
          onCheckedChange?.(!checked);
        }
      }}
      className={cn(
        "group inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-600",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          "relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200",
          checked ? "bg-accent-600" : "bg-ink-200",
        )}
      >
        <span
          className={cn(
            "inline-block size-5 rounded-full bg-(--color-white) shadow transition-transform duration-200",
            checked ? "translate-x-[1.375rem]" : "translate-x-0.5",
          )}
        />
      </span>
    </button>
  );
});
