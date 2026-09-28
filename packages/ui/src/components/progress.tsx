import type { HTMLAttributes } from "react";
import { cn } from "../cn";

export interface ProgressProps extends HTMLAttributes<HTMLDivElement> {
  value: number;
  max?: number;
}

export function Progress({ value, max = 100, className, ...props }: ProgressProps) {
  const bounded = Math.min(Math.max(value, 0), max);
  const pct = max > 0 ? (bounded / max) * 100 : 0;
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={bounded}
      className={cn("h-2 w-full overflow-hidden rounded-full bg-ink-100", className)}
      {...props}
    >
      <div
        className="h-full rounded-full bg-accent-500 transition-[width] duration-500 ease-out"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
