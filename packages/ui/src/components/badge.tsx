import type { HTMLAttributes } from "react";
import { cn } from "../cn";

export type BadgeVariant = "default" | "success" | "warning" | "danger" | "outline";

const badgeVariants: Record<BadgeVariant, string> = {
  default: "bg-ink-100 text-ink-800 ring-1 ring-inset ring-ink-950/10",
  success: "bg-emerald-100 text-emerald-800 ring-1 ring-inset ring-emerald-500/25",
  warning: "bg-amber-100 text-amber-800 ring-1 ring-inset ring-amber-500/25",
  danger: "bg-red-100 text-red-800 ring-1 ring-inset ring-red-500/25",
  outline: "border border-ink-200 text-ink-700",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

export function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium",
        badgeVariants[variant],
        className,
      )}
      {...props}
    />
  );
}
