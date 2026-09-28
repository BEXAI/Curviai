import type { HTMLAttributes } from "react";
import { cn } from "../cn";

/** Loading placeholder block using the shared shimmer sweep. */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "animate-shimmer rounded-lg bg-gradient-to-r from-ink-100 via-ink-50 to-ink-100 bg-[length:200%_100%]",
        className,
      )}
      {...props}
    />
  );
}
